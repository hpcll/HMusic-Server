import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";

// 榜单页：家庭热播（播放历史聚合）+ Apple Music RSS 榜。
// Apple 榜只有元数据，点播时先走 /search 找到可播曲目再 play；
// 家庭榜条目带历史 track 快照，直接回放。
export const ChartsView = {
  setup() {
    const charts = ref([]); // 榜单目录
    const activeId = ref("");
    const chart = ref(null); // 当前榜单详情
    const loading = ref(false);
    const actingRank = ref(0);

    async function loadCharts() {
      try {
        const result = await api("/charts");
        charts.value = result.charts || [];
        if (charts.value.length && !activeId.value) {
          openChart(charts.value[0].id);
        }
      } catch (error) {
        toast(error.message, "error");
      }
    }

    async function openChart(id) {
      activeId.value = id;
      loading.value = true;
      chart.value = null;
      try {
        chart.value = await api(`/charts/${id}`);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        loading.value = false;
      }
    }

    // 榜单条目 → 可播曲目：带快照直接用，否则搜「歌名 歌手」取第一条。
    async function resolveEntry(entry) {
      if (entry.track) return entry.track;
      const q = `${entry.title} ${entry.artist}`;
      const result = await api(`/search?q=${encodeURIComponent(q)}`);
      const found = (result.tracks || [])[0];
      if (!found) throw new Error(`没找到可播放的「${entry.title}」`);
      return found;
    }

    async function play(entry) {
      actingRank.value = entry.rank;
      primeLocalAudio(); // 本机播放：手势内解锁 <audio>
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

    onMounted(loadCharts);

    return () =>
      h("main", { class: "view charts-view" }, [
        h("h2", { class: "view-title" }, "榜单"),

        h("div", { class: "mode-tabs" },
          charts.value.map((c) =>
            h("button", {
              key: c.id,
              class: ["mode-tab", { active: activeId.value === c.id }],
              onClick: () => openChart(c.id),
            }, c.name),
          ),
        ),

        chart.value?.description
          ? h("p", { class: "muted chart-desc" }, chart.value.description)
          : null,

        loading.value
          ? h("div", { class: "muted center" }, "榜单加载中…")
          : !chart.value || chart.value.entries.length === 0
            ? h("div", { class: "muted center" },
                activeId.value === "family"
                  ? "还没有播放记录，放几首歌就有家庭热播榜了"
                  : "榜单是空的")
            : h("ol", { class: "track-list chart-list" },
                chart.value.entries.map((entry) =>
                  h("li", { key: entry.rank, class: "track-row" }, [
                    h("div", { class: ["chart-rank", { top: entry.rank <= 3 }] },
                      String(entry.rank)),
                    h("div", {
                      class: "track-cover",
                      style: entry.coverUrl
                        ? { backgroundImage: `url(${entry.coverUrl})` }
                        : {},
                    }, entry.coverUrl ? [] : "♪"),
                    h("div", { class: "track-info" }, [
                      h("div", { class: "track-title" }, entry.title),
                      h("div", { class: "track-artist" }, [
                        entry.artist,
                        entry.playCount
                          ? h("span", { class: "chart-count" }, ` · ${entry.playCount} 次`)
                          : null,
                      ]),
                    ]),
                    h("div", { class: "track-actions" }, [
                      h("button", {
                        class: "icon-btn",
                        disabled: actingRank.value === entry.rank,
                        title: "播放",
                        onClick: () => play(entry),
                      }, Icons.play()),
                      h("button", {
                        class: "icon-btn",
                        disabled: actingRank.value === entry.rank,
                        title: "加入队列",
                        onClick: () => enqueue(entry),
                      }, Icons.plus()),
                    ]),
                  ]),
                ),
              ),
      ]);
  },
};
