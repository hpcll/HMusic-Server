import { ref, computed, watch, onMounted, onUnmounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { EmptyState, ErrorState, LoadingState } from "/app/components/feedback.js";
import { router, go, refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import { openDownloadPicker, refreshDownloadedKeys, downloadedBadge } from "/app/download.js";
import { createChartsState } from "./charts-state.js";
import { renderChartsWall } from "./charts-wall.js";

export const ChartsView = {
  setup() {
    const model = createChartsState(api);
    const state = model.state;
    const actingRank = ref(0);
    const active = computed(() => state.charts.find((item) => item.id === router.params.id) || state.detail);

    // 有曲目快照直接播放；Spotify/Apple 元数据继续走既有搜索匹配链路。
    async function resolveEntry(entry) {
      if (entry.track) return entry.track;
      const result = await api(`/search?q=${encodeURIComponent(`${entry.title} ${entry.artist}`)}`);
      const track = (result.tracks || [])[0];
      if (!track) throw new Error(`没找到可播放的「${entry.title}」`);
      return track;
    }

    async function play(entry) {
      if (actingRank.value) return;
      actingRank.value = entry.rank;
      primeLocalAudio();
      try {
        const track = await resolveEntry(entry);
        await api("/playback/play", { method: "POST", body: { track } });
        await refreshPlayback();
        toast(`正在播放：${entry.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    async function enqueue(entry) {
      if (actingRank.value) return;
      actingRank.value = entry.rank;
      try {
        const track = await resolveEntry(entry);
        await api("/queue/items", { method: "POST", body: { track } });
        toast(`已加入队列：${entry.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    async function downloadEntry(entry) {
      if (actingRank.value) return;
      actingRank.value = entry.rank;
      try {
        openDownloadPicker(await resolveEntry(entry));
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    async function playAll() {
      const current = active.value;
      if (!current || actingRank.value) return;
      actingRank.value = -1;
      primeLocalAudio();
      try {
        await api(`/charts/${encodeURIComponent(current.id)}/play`, { method: "POST", body: {} });
        await refreshPlayback();
        toast(`整榜播放：${current.name}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    onMounted(() => {
      void model.load();
      if (router.params.id) void model.open(router.params.id);
      void refreshDownloadedKeys();
    });
    onUnmounted(model.dispose);
    watch(() => [router.name, router.params.id], ([name, id]) => {
      if (name !== "charts") return;
      if (id) void model.open(id);
      else model.back();
    });

    function renderWall() {
      return h("main", { class: "view charts-view" }, [
        h("div", { class: "charts-page-head" }, [
          h("div", null, [
            h("h2", { class: "view-title" }, "榜单"),
            h("p", { class: "charts-page-subtitle" }, "常听回顾，热门发现"),
          ]),
          h("button", {
            class: "icon-btn", title: "刷新榜单", "aria-label": "刷新榜单",
            disabled: state.loading, onClick: () => void model.load(),
          }, Icons.refresh()),
        ]),
        state.loadError ? ErrorState({ message: state.loadError, onRetry: model.load }) : null,
        state.loading && !state.charts.length ? LoadingState()
          : !state.charts.length && !state.loadError ? EmptyState({ icon: Icons.charts, title: "暂无榜单" })
          : renderChartsWall(model, {
              onOpen: (id) => go("charts", { id }),
              onPlay: play,
              busy: actingRank.value !== 0,
            }),
      ]);
    }

    function renderDetail() {
      const current = active.value;
      return h("main", { class: "view charts-view" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "secondary-btn", onClick: () => go("charts") }, "‹ 返回"),
          state.detail?.entries.length ? h("button", {
            class: "secondary-btn", disabled: actingRank.value !== 0, onClick: playAll,
          }, "播放全部") : null,
        ]),
        h("h2", { class: "view-title" }, current?.name || "榜单详情"),
        current?.description ? h("p", { class: "muted chart-desc" }, current.description) : null,
        state.detailError ? ErrorState({ message: state.detailError, onRetry: () => model.open(router.params.id) })
          : state.detailLoading ? LoadingState({ label: "榜单加载中…" })
          : !state.detail?.entries.length ? EmptyState({
              icon: Icons.charts,
              title: router.params.id === "family" ? "还没有播放记录，放几首歌就有家庭热播榜了" : "榜单是空的",
            })
          : h("ol", { class: "track-list chart-list track-cols" }, state.detail.entries.map(renderEntry)),
      ]);
    }

    function renderEntry(entry) {
      return h("li", { key: entry.rank, class: "track-row" }, [
        h("div", { class: ["chart-rank", { top: entry.rank <= 3 }] }, String(entry.rank)),
        h("div", {
          class: "track-cover",
          style: entry.coverUrl ? { backgroundImage: `url(${entry.coverUrl})` } : {},
        }, entry.coverUrl ? [] : "♪"),
        h("div", { class: "track-info" }, [
          h("div", { class: "track-title" }, [entry.title, entry.track ? downloadedBadge(entry.track) : null]),
          h("div", { class: "track-artist" }, [
            entry.artist,
            entry.playCount ? h("span", { class: "chart-count" }, ` · ${entry.playCount} 次`) : null,
          ]),
        ]),
        h("div", { class: "track-actions" }, [
          h("button", { class: "icon-btn", disabled: actingRank.value !== 0, title: "播放", onClick: () => play(entry) }, Icons.play()),
          h("button", { class: "icon-btn", disabled: actingRank.value !== 0, title: "加入队列", onClick: () => enqueue(entry) }, Icons.plus()),
          h("button", { class: "icon-btn", disabled: actingRank.value !== 0, title: "下载到服务器", onClick: () => downloadEntry(entry) }, Icons.download()),
        ]),
      ]);
    }

    return () => router.params.id ? renderDetail() : renderWall();
  },
};
