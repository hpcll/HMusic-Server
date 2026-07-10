import { h } from "vue";

// 共享线性 SVG 图标：stroke 用 currentColor，尺寸交给 CSS 控制。
// 统一 1.7 描边宽度，替代 emoji（各平台字形不一致且带颜色，破坏墨色视觉）。
function icon(children, viewBox = "0 0 24 24") {
  return h("svg", {
    viewBox,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.7,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  }, children);
}

function filled(children) {
  return h("svg", {
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
  }, children);
}

export const Icons = {
  // ── 导航 ──
  player: () => icon([
    h("circle", { cx: 12, cy: 12, r: 9 }),
    h("path", { d: "M10 9.2v5.6l4.6-2.8z", fill: "currentColor", stroke: "none" }),
  ]),
  search: () => icon([
    h("circle", { cx: 11, cy: 11, r: 6.5 }),
    h("path", { d: "M15.8 15.8 20 20" }),
  ]),
  queue: () => icon([
    h("path", { d: "M4 6h12M4 12h12M4 18h8" }),
    h("path", { d: "M19.5 12.5v5.2" }),
    h("circle", { cx: 18, cy: 18.4, r: 1.6 }),
  ]),
  playlists: () => icon([
    h("path", { d: "M9 17.5V6.2l10-1.7v11.3" }),
    h("circle", { cx: 6.8, cy: 17.5, r: 2.3 }),
    h("circle", { cx: 16.8, cy: 15.8, r: 2.3 }),
  ]),
  settings: () => icon([
    h("path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }),
    h("circle", { cx: 15, cy: 7, r: 2 }),
    h("circle", { cx: 9, cy: 17, r: 2 }),
  ]),
  charts: () => icon([
    h("path", { d: "M5 19.5v-6M12 19.5v-11M19 19.5v-15" }),
  ]),
  stats: () => icon([
    h("path", { d: "M4 4v16h16" }),
    h("path", { d: "M8 15l3.2-4 3 2.2L20 7" }),
  ]),
  heart: () => icon([
    h("path", { d: "M12 19.8C7.2 16.6 4.5 13.6 4.5 10.4 4.5 8 6.3 6.2 8.6 6.2c1.4 0 2.7.7 3.4 1.9.7-1.2 2-1.9 3.4-1.9 2.3 0 4.1 1.8 4.1 4.2 0 3.2-2.7 6.2-7.5 9.4z" }),
  ]),
  heartFilled: () => filled([
    h("path", { d: "M12 19.8C7.2 16.6 4.5 13.6 4.5 10.4 4.5 8 6.3 6.2 8.6 6.2c1.4 0 2.7.7 3.4 1.9.7-1.2 2-1.9 3.4-1.9 2.3 0 4.1 1.8 4.1 4.2 0 3.2-2.7 6.2-7.5 9.4z" }),
  ]),

  // ── 操作 ──
  play: () => filled([h("path", { d: "M8.5 5.8v12.4l10-6.2z" })]),
  plus: () => icon([h("path", { d: "M12 5v14M5 12h14" })]),
  close: () => icon([h("path", { d: "M6 6l12 12M18 6L6 18" })]),
  chevronRight: () => icon([h("path", { d: "M9.5 6 15.5 12l-6 6" })]),
  chevronLeft: () => icon([h("path", { d: "M14.5 6 8.5 12l6 6" })]),
  chevronDown: () => icon([h("path", { d: "M6 9.5 12 15.5l6-6" })]),
  refresh: () => icon([
    h("path", { d: "M20 12a8 8 0 1 1-2.34-5.66" }),
    h("path", { d: "M20 4v4h-4" }),
  ]),
  logout: () => icon([
    h("path", { d: "M9 4H5.5v16H9" }),
    h("path", { d: "M14 8l4 4-4 4M18 12H9.5" }),
  ]),
  download: () => icon([
    h("path", { d: "M12 4.5v10" }),
    h("path", { d: "M7.5 10.5 12 15l4.5-4.5" }),
    h("path", { d: "M5 19.5h14" }),
  ]),
  note: () => icon([
    h("path", { d: "M10 17.2V5.8l8-1.4v11.4" }),
    h("circle", { cx: 7.8, cy: 17.2, r: 2.2 }),
    h("circle", { cx: 15.8, cy: 15.8, r: 2.2 }),
  ]),

  // ── 设置分组 ──
  account: () => icon([
    h("circle", { cx: 12, cy: 8.4, r: 3.6 }),
    h("path", { d: "M5 19.4c1.4-3 4-4.6 7-4.6s5.6 1.6 7 4.6" }),
  ]),
  speaker: () => icon([
    h("rect", { x: 6.5, y: 4, width: 11, height: 16, rx: 2 }),
    h("circle", { cx: 12, cy: 14, r: 3 }),
    h("circle", { cx: 12, cy: 8, r: 1, fill: "currentColor", stroke: "none" }),
  ]),
  plugin: () => icon([
    h("path", { d: "M9 4.5v3h6v-3M6.5 7.5h11v6a5.5 5.5 0 0 1-11 0z" }),
    h("path", { d: "M12 19v2.5" }),
  ]),
  file: () => icon([
    h("path", { d: "M7 3.5h7l4 4v13H7z" }),
    h("path", { d: "M13.6 3.8V8h4" }),
  ]),
  sliders: () => icon([
    h("path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }),
    h("circle", { cx: 15, cy: 7, r: 2 }),
    h("circle", { cx: 9, cy: 17, r: 2 }),
  ]),
  pulse: () => icon([
    h("path", { d: "M3.5 12h4l2.2-5.5 4 11L16 12h4.5" }),
  ]),
  lock: () => icon([
    h("rect", { x: 6, y: 10.5, width: 12, height: 9, rx: 1.5 }),
    h("path", { d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }),
  ]),
};
