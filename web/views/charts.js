import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";
import {
  openDownloadPicker,
  renderDownloadPicker,
  refreshDownloadedKeys,
  downloadedBadge,
} from "/app/download.js";

// 榜单页：卡片墙（按来源分组，卡片直接亮前 3 首）→ 点卡片进详情列表。
// 网易云/QQ/家庭榜的条目带 track，点了直接回放；
// Apple 榜只有元数据，点播时先走 /search 找到可播曲目再 play。
const GROUPS = [
  { kind: "family", label: "本站" },
  { kind: "netease", label: "网易云音乐" },
  { kind: "qq", label: "QQ音乐" },
  { kind: "apple", label: "Apple Music" },
];

export const ChartsView = {
  setup() {
    const charts = ref([]); // 榜单目录（摘要）
    const previews = ref({}); // 榜单 id → 前 3 首（null=拉取失败，回退显示描述）
    const active = ref(null); // 当前打开的榜单摘要；null = 卡片墙
    const chart = ref(null); // 当前榜单详情
    const loading = ref(false);
    const actingRank = ref(0);

    async function loadCharts() {
      try {
        const result = await api("/charts");
        charts.value = result.charts || [];
      } catch (error) {
        toast(error.message, "error");
        return;
      }
      refreshDownloadedKeys();
      // 并发预取各榜前 3 首做卡片预览，顺带焐热后端 6h 缓存（进详情秒开）。
      for (const c of charts.value) {
        api(`/charts/${c.id}`)
          .then((detail) => {
            previews.value = {
              ...previews.value,
              [c.id]: (detail.entries || []).slice(0, 3),
            };
          })
          .catch(() => {
            previews.value = { ...previews.value, [c.id]: null };
          });
      }
    }

    async function openChart(summary) {
      active.value = summary;
      chart.value = null;
      loading.value = true;
      try {
        chart.value = await api(`/charts/${summary.id}`);
      } catch (error) {
        toast(error.message, "error");
        active.value = null; // 拉取失败回卡片墙
      } finally {
        loading.value = false;
      }
    }

    function backToWall() {
      active.value = null;
      chart.value = null;
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
      if (actingRank.value) return; // 全局一次一首，防连点
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

    // 下载榜单条目：带 track 直接进音质弹窗；Apple 榜先搜索匹配出真实曲目再下。
    async function downloadEntry(entry) {
      if (actingRank.value) return;
      actingRank.value = entry.rank;
      try {
        const track = await resolveEntry(entry);
        openDownloadPicker(track);
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    // 整榜播放：50 首一把灌进队列开播（仅条目带 track 的榜显示按钮）。
    async function playAll() {
      if (actingRank.value) return;
      actingRank.value = -1; // 占位防连点（不与任何 rank 相等）
      primeLocalAudio();
      try {
        await api(`/charts/${active.value.id}/play`, { method: "POST", body: {} });
        await refreshPlayback();
        toast(`整榜播放：${active.value.name}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingRank.value = 0;
      }
    }

    onMounted(loadCharts);

    return () =>
      h("div", null, [
        active.value ? renderDetail() : renderWall(),
        renderDownloadPicker(),
      ]);

    // ── 卡片墙：按来源分组的榜单入口，卡片直接亮前 3 首 ──
    function renderWall() {
      return h("main", { class: "view charts-view" }, [
        h("h2", { class: "view-title" }, "榜单"),
        ...GROUPS.map((group) => {
          const items = charts.value.filter((c) => c.kind === group.kind);
          if (!items.length) return null;
          return h("section", { key: group.kind, class: "chart-group" }, [
            h("div", { class: "chart-group-label" }, group.label),
            h("div", { class: "chart-wall" },
              items.map((c) =>
                h("div", {
                  key: c.id,
                  class: "card chart-card",
                  onClick: () => openChart(c),
                }, [
                  h("div", { class: "chart-card-head" }, [
                    renderCardCover(c),
                    h("div", { class: "chart-card-name" }, c.name),
                  ]),
                  renderCardPreview(c),
                  h("div", { class: "chart-card-more" }, "查看全部 ›"),
                ]),
              ),
            ),
          ]);
        }),
      ]);
    }

    // 卡头封面：取第 1 名的封面当卡片视觉指纹，缺图/加载中回退 ♪。
    function renderCardCover(c) {
      const first = (previews.value[c.id] || [])[0];
      const cover = first?.coverUrl;
      return h("div", {
        class: "chart-card-cover",
        style: cover ? { backgroundImage: `url(${cover})` } : {},
      }, cover ? [] : "♪");
    }

    // 卡片内预览：前 3 首可直接点播；未加载/失败时回退到榜单描述。
    function renderCardPreview(c) {
      const top = previews.value[c.id];
      if (top === undefined) {
        return h("div", { class: "chart-card-desc" }, "加载中…");
      }
      if (!top || top.length === 0) {
        return h("div", { class: "chart-card-desc" }, c.description);
      }
      return h("div", { class: "chart-card-songs" },
        top.map((entry) =>
          h("div", {
            key: entry.rank,
            class: "chart-card-song",
            title: `播放：${entry.title}`,
            onClick: (event) => {
              event.stopPropagation();
              play(entry);
            },
          }, [
            h("span", { class: "cc-rank" }, String(entry.rank)),
            h("span", { class: "cc-title" }, entry.title),
            h("span", { class: "cc-artist" }, entry.artist),
          ]),
        ),
      );
    }

    // ── 详情：返回 + 榜单曲目列表（沿用榜单行样式） ──
    function renderDetail() {
      return h("main", { class: "view charts-view" }, [
        h("div", { class: "detail-head" }, [
          h("button", { class: "secondary-btn", onClick: backToWall }, "‹ 返回"),
          chart.value && chart.value.entries.some((e) => e.track)
            ? h("button", {
                class: "secondary-btn",
                disabled: actingRank.value !== 0,
                onClick: playAll,
              }, "播放全部")
            : null,
        ]),
        h("h2", { class: "view-title" }, active.value.name),
        active.value.description
          ? h("p", { class: "muted chart-desc" }, active.value.description)
          : null,
        loading.value
          ? h("div", { class: "muted center" }, "榜单加载中…")
          : !chart.value || chart.value.entries.length === 0
            ? h("div", { class: "muted center" },
                active.value.id === "family"
                  ? "还没有播放记录，放几首歌就有家庭热播榜了"
                  : "榜单是空的")
            : h("ol", { class: "track-list chart-list track-cols" },
                chart.value.entries.map(renderEntry)),
      ]);
    }

    function renderEntry(entry) {
      return h("li", { key: entry.rank, class: "track-row" }, [
        h("div", { class: ["chart-rank", { top: entry.rank <= 3 }] },
          String(entry.rank)),
        h("div", {
          class: "track-cover",
          style: entry.coverUrl
            ? { backgroundImage: `url(${entry.coverUrl})` }
            : {},
        }, entry.coverUrl ? [] : "♪"),
        h("div", { class: "track-info" }, [
          h("div", { class: "track-title" }, [
            entry.title,
            entry.track ? downloadedBadge(entry.track) : null,
          ]),
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
          h("button", {
            class: "icon-btn",
            disabled: actingRank.value === entry.rank,
            title: "下载到服务器",
            onClick: () => downloadEntry(entry),
          }, Icons.download()),
        ]),
      ]);
    }
  },
};
