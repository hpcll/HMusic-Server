import { ref, onMounted, h } from "vue";
import { api } from "/app/api.js";
import { Icons } from "/app/icons.js";
import { refreshPlayback, toast, primeLocalAudio } from "/app/main.js";

// 听歌统计页：把 play_history 的聚合结果可视化。
// 图表全部手写内联 SVG（项目无图表库，坚持本地自持），配色走 CSS 变量。
export const StatsView = {
  setup() {
    const stats = ref(null);
    const loading = ref(false);
    const actingKey = ref("");

    async function load() {
      loading.value = true;
      try {
        const result = await api("/stats");
        stats.value = result.stats;
      } catch (error) {
        toast(error.message, "error");
      } finally {
        loading.value = false;
      }
    }

    // Top 歌曲行点播：带历史快照直接播，走现有播放管线。
    async function play(item) {
      if (!item.track) {
        toast("这首缺少可播放信息", "error");
        return;
      }
      actingKey.value = item.title + item.artist;
      primeLocalAudio();
      try {
        await api("/playback/play", { method: "POST", body: { track: item.track } });
        await refreshPlayback();
        toast(`正在播放：${item.title}`, "success");
      } catch (error) {
        toast(error.message, "error");
      } finally {
        actingKey.value = "";
      }
    }

    onMounted(load);

    return () => {
      if (loading.value && !stats.value) {
        return view([h("div", { class: "muted center" }, "统计加载中…")]);
      }
      const s = stats.value;
      if (!s || s.overview.totalPlays === 0) {
        return view([
          h("div", { class: "muted center" },
            "还没有听歌记录，放几首歌这里就热闹了"),
        ]);
      }
      return view([
        renderOverview(s),
        renderTrend(s.dailyTrend),
        renderHours(s.hourDist),
        renderSources(s.sourceDist),
        renderTopArtists(s.topArtists),
        renderTopTracks(s.topTracks, actingKey, play),
        renderTopAlbums(s.topAlbums),
      ]);
    };
  },
};

function view(children) {
  return h("main", { class: "view stats-view" }, [
    h("div", { class: "view-head" }, [h("h2", { class: "view-title" }, "听歌统计")]),
    ...children,
  ]);
}

// ── 数字卡片区：四个大数字 + 近30天增量 ──
function renderOverview(s) {
  const cards = [
    { label: "累计播放", value: s.overview.totalPlays, delta: s.last30d.totalPlays },
    { label: "曲目数", value: s.overview.uniqueTracks, delta: s.last30d.uniqueTracks },
    { label: "艺术家", value: s.overview.uniqueArtists, delta: s.last30d.uniqueArtists },
    { label: "活跃天数", value: s.overview.activeDays, delta: s.last30d.activeDays },
  ];
  return h("div", { class: "stat-grid" },
    cards.map((c) =>
      h("div", { key: c.label, class: "card stat-bignum" }, [
        h("div", { class: "stat-num" }, String(c.value)),
        h("div", { class: "row-label" }, c.label),
        h("div", { class: "muted stat-delta" }, `近30天 +${c.delta}`),
      ]),
    ),
  );
}

// ── 听歌趋势：近30天逐日折线（内联 SVG）──
function renderTrend(daily) {
  const W = 640;
  const H = 160;
  const padX = 8;
  const padY = 16;
  const n = daily.length;
  const max = Math.max(1, ...daily.map((d) => d.count));
  const stepX = n > 1 ? (W - padX * 2) / (n - 1) : 0;
  const x = (i) => padX + i * stepX;
  const y = (v) => H - padY - (v / max) * (H - padY * 2);

  const points = daily.map((d, i) => `${x(i)},${y(d.count)}`).join(" ");
  // 折线下方填充区域，收口到基线。
  const areaD =
    `M ${x(0)},${H - padY} L ` +
    daily.map((d, i) => `${x(i)},${y(d.count)}`).join(" L ") +
    ` L ${x(n - 1)},${H - padY} Z`;

  const svg = h("svg", {
    class: "stat-svg",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
  }, [
    h("path", { d: areaD, class: "trend-area" }),
    h("polyline", { points, class: "trend-line" }),
  ]);

  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "听歌趋势 · 近 30 天"),
    h("div", { class: "stat-chart" }, [svg]),
    h("div", { class: "stat-axis" }, [
      h("span", {}, daily[0]?.date ?? ""),
      h("span", {}, daily[Math.floor(n / 2)]?.date ?? ""),
      h("span", {}, daily[n - 1]?.date ?? ""),
    ]),
  ]);
}

// ── 听歌时段：24 小时柱状（内联 SVG）──
function renderHours(hours) {
  const W = 640;
  const H = 140;
  const padY = 12;
  const max = Math.max(1, ...hours.map((pt) => pt.count));
  const gap = 3;
  const barW = (W - gap * 23) / 24;

  const bars = hours.map((hh, i) => {
    const bh = (hh.count / max) * (H - padY);
    const x = i * (barW + gap);
    return h("rect", {
      key: i,
      x,
      y: H - bh,
      width: barW,
      height: bh,
      rx: 1.5,
      class: ["hour-bar", { peak: hh.count === max }],
    });
  });

  const svg = h("svg", {
    class: "stat-svg",
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: "none",
  }, bars);

  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "听歌时段 · 全天分布"),
    h("div", { class: "stat-chart" }, [svg]),
    h("div", { class: "stat-axis" }, [
      h("span", {}, "0 点"),
      h("span", {}, "6 点"),
      h("span", {}, "12 点"),
      h("span", {}, "18 点"),
      h("span", {}, "23 点"),
    ]),
  ]);
}

// ── 来源平台分布：环形图（SVG stroke-dasharray 拼环）+ 图例 ──
function renderSources(sources) {
  const R = 52;
  const CX = 70;
  const CY = 70;
  const circ = 2 * Math.PI * R;
  // 纯墨色版：占比最大那块（已按 count 降序，index 0）用最深墨色，
  // 其余走中性灰阶——透明度下限 0.45，保证最浅扇区和底环拉得开。
  const grayAlpha = [1, 0.9, 0.65, 0.45];
  const strokeOf = (i) => (i === 0 ? "var(--text-strong)" : "var(--muted-2)");
  const alphaOf = (i) => (i === 0 ? 1 : grayAlpha[Math.min(i, grayAlpha.length - 1)]);

  let offset = 0;
  const rings = sources.map((src, i) => {
    const len = (src.percent / 100) * circ;
    const seg = h("circle", {
      key: src.source,
      cx: CX,
      cy: CY,
      r: R,
      fill: "none",
      stroke: strokeOf(i),
      "stroke-opacity": alphaOf(i),
      "stroke-width": 16,
      "stroke-dasharray": `${len} ${circ - len}`,
      "stroke-dashoffset": -offset,
      transform: `rotate(-90 ${CX} ${CY})`,
    });
    offset += len;
    return seg;
  });

  const donut = h("svg", {
    class: "stat-donut",
    viewBox: "0 0 140 140",
  }, [
    h("circle", { cx: CX, cy: CY, r: R, fill: "none", stroke: "var(--line-soft)", "stroke-width": 16 }),
    ...rings,
  ]);

  const legend = h("div", { class: "stat-legend" },
    sources.map((src, i) =>
      h("div", { key: src.source, class: "legend-item" }, [
        h("span", {
          class: "legend-dot",
          style: { background: strokeOf(i), opacity: alphaOf(i) },
        }),
        h("span", { class: "legend-label" }, src.label),
        h("span", { class: "muted legend-val" }, `${src.count} · ${src.percent}%`),
      ]),
    ),
  );

  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "来源平台分布"),
    h("div", { class: "stat-source" }, [donut, legend]),
  ]);
}

// ── Top 艺术家：横向占比条 ──
function renderTopArtists(artists) {
  if (!artists.length) return null;
  const max = Math.max(1, ...artists.map((a) => a.playCount));
  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "常听艺术家 Top 10"),
    h("div", { class: "stat-bars" },
      artists.map((a, i) =>
        h("div", { key: a.name, class: "bar-row" }, [
          h("div", { class: "bar-name" }, a.name),
          h("div", { class: "bar-track" }, [
            h("div", {
              class: ["bar-fill", { lead: i === 0 }],
              style: { width: `${(a.playCount / max) * 100}%` },
            }),
          ]),
          h("div", { class: "bar-val" }, `${a.playCount}`),
        ]),
      ),
    ),
  ]);
}

// ── Top 歌曲：复用榜单列表样式，可点播 ──
function renderTopTracks(tracks, actingKey, play) {
  if (!tracks.length) return null;
  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "最常播放 Top 10"),
    h("ol", { class: "track-list" },
      tracks.map((t, i) =>
        h("li", { key: i, class: "track-row" }, [
          h("div", { class: ["chart-rank", { top: i < 3 }] }, String(i + 1)),
          h("div", {
            class: "track-cover",
            style: t.coverUrl ? { backgroundImage: `url(${t.coverUrl})` } : {},
          }, t.coverUrl ? [] : "♪"),
          h("div", { class: "track-info" }, [
            h("div", { class: "track-title" }, t.title),
            h("div", { class: "track-artist" }, [
              t.artist,
              h("span", { class: "chart-count" }, ` · ${t.playCount} 次`),
            ]),
          ]),
          h("div", { class: "track-actions" }, [
            h("button", {
              class: "icon-btn",
              disabled: !t.track || actingKey.value === t.title + t.artist,
              title: t.track ? "播放" : "无法播放",
              onClick: () => play(t),
            }, Icons.play()),
          ]),
        ]),
      ),
    ),
  ]);
}

// ── Top 专辑：横向占比条 ──
function renderTopAlbums(albums) {
  if (!albums.length) return null;
  const max = Math.max(1, ...albums.map((a) => a.playCount));
  return h("div", { class: "card" }, [
    h("div", { class: "card-title" }, "常听专辑 Top 8"),
    h("div", { class: "stat-bars" },
      albums.map((a, i) =>
        h("div", { key: a.album, class: "bar-row" }, [
          h("div", { class: "bar-name" }, a.album),
          h("div", { class: "bar-track" }, [
            h("div", {
              class: ["bar-fill", { lead: i === 0 }],
              style: { width: `${(a.playCount / max) * 100}%` },
            }),
          ]),
          h("div", { class: "bar-val" }, `${a.playCount}`),
        ]),
      ),
    ),
  ]);
}
