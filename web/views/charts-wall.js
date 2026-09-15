import { h } from "vue";
import { Icons } from "/app/icons.js";
import { CHART_SOURCES, discoveryCharts } from "./charts-state.js";

export function renderChartsWall(model, { onOpen, onPlay, busy }) {
  const { state } = model;
  const personal = state.charts.filter((chart) => chart.kind === "spotify-personal");
  const discovery = discoveryCharts(state.charts, state.source);
  const sources = CHART_SOURCES.filter((source) => source.kind === "featured"
    || state.charts.some((chart) => chart.kind === source.kind));

  function renderCard(chart) {
    const entries = state.previews[chart.id];
    const error = state.previewErrors[chart.id];
    const loading = entries === undefined;
    const cover = entries?.[0]?.coverUrl;
    const personal = chart.kind === "spotify-personal";
    const label = personal ? chart.description?.replace(/^Spotify\s*/, "")
      : CHART_SOURCES.find((source) => source.kind === chart.kind)?.label || chart.kind;
    return h("article", {
      key: chart.id, class: ["card chart-card", { "chart-card-personal": personal }],
      "data-chart-id": chart.id, onClick: () => onOpen(chart.id),
    }, [
      h("div", { class: "chart-card-head" }, [
        h("div", { class: "chart-card-cover", "aria-hidden": "true" }, cover
          ? h("img", { src: cover, alt: "", loading: "lazy" })
          : chart.kind.startsWith("spotify") ? Icons.spotify() : Icons.charts()),
        h("button", {
          class: "chart-card-open", type: "button", "aria-label": `打开${chart.name}`,
          onClick: (event) => { event.stopPropagation(); onOpen(chart.id); },
        }, [
          h("span", { class: "chart-card-caption" }, label),
          h("span", { class: "chart-card-name" }, chart.name),
        ]),
      ]),
      h("div", { class: "chart-card-preview", "aria-busy": loading }, loading
        ? h("div", { class: "chart-card-skeleton", role: "status", "aria-label": `正在加载${chart.name}` },
            [1, 2, 3].map((rank) => h("span", { key: rank, class: "chart-skeleton-line" })))
        : error ? h("div", { class: "chart-card-feedback", role: "status" }, [
            h("p", { title: error }, error),
            h("button", { class: "ghost-btn", onClick: (event) => { event.stopPropagation(); void model.retryPreview(chart.id); } }, "重试"),
          ])
        : !entries?.length ? h("p", { class: "chart-card-empty" }, chart.kind === "family"
          ? "在 HMusic 听几首歌，这里就会有你的常听记录。"
          : personal ? "Spotify 暂无这个时段的收听记录。" : "暂无榜单曲目")
        : h("ol", { class: "chart-card-songs" }, entries.map((entry) => h("li", { key: entry.rank }, [
            h("button", {
              class: "chart-card-song", type: "button", disabled: busy,
              "aria-label": `播放${entry.title}，${entry.artist}`,
              onClick: (event) => { event.stopPropagation(); onPlay(entry); },
            }, [
              h("span", { class: "cc-rank" }, String(entry.rank).padStart(2, "0")),
              h("span", { class: "cc-info" }, [h("span", { class: "cc-title" }, entry.title), h("span", { class: "cc-artist" }, entry.artist)]),
              h("span", { class: "cc-play", "aria-hidden": "true" }, Icons.play()),
            ]),
          ]))),
      ),
    ]);
  }

  return [
    personal.length ? h("section", { class: "charts-personal", "aria-label": "我的 Spotify 榜单" }, [
      h("div", { class: "charts-section-head" }, [
        h("div", null, [h("h3", null, "我的 Spotify 榜单"), h("p", null, "来自 Spotify 的收听记录")]),
        h("span", { class: "charts-section-mark", "aria-hidden": "true" }, Icons.spotify()),
      ]),
      h("div", { class: "chart-wall chart-wall-personal" }, personal.map(renderCard)),
    ]) : null,
    h("section", { class: "charts-discovery", "aria-label": "发现榜单" }, [
      h("div", { class: "charts-section-head" }, [
        h("div", null, [h("h3", null, "发现榜单"), h("p", null, "从家庭常听到全网热门")]),
      ]),
      h("div", { class: "charts-filters", role: "group", "aria-label": "筛选榜单来源" }, sources.map(({ kind, label }) => h("button", {
        key: kind, class: ["charts-filter", { active: state.source === kind }],
        "aria-pressed": state.source === kind, onClick: () => void model.selectSource(kind),
      }, label))),
      h("div", { class: "chart-wall", "aria-live": "polite" }, discovery.map(renderCard)),
    ]),
  ];
}
