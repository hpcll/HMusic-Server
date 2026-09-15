// 独立浏览器回归：真实 Vue 组件与 CSS，隔离 API 和播放输出，避免操作用户数据。
// 运行：node test/ui/charts-browser.mjs [截图目录]；可用 CHROME_PATH 指定浏览器。
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(process.argv[2] || "/tmp/hmusic-charts-review");
await mkdir(output, { recursive: true });
const charts = [
  ["spotify-top-short", "最近常听", "spotify-personal", "Spotify 最近 4 周常听曲目"],
  ["spotify-top-medium", "半年常听", "spotify-personal", "Spotify 最近 6 个月常听曲目"],
  ["spotify-top-long", "长期常听", "spotify-personal", "Spotify 较长时间的常听曲目"],
  ["spotify-global-top", "Global Top 50", "spotify-public", "全球热门歌曲"],
  ["spotify-hk-top", "Top 50 · 香港", "spotify-public", "香港热门歌曲"],
  ["family", "家庭热播", "family", "最近 30 天全家最常听"],
  ["wy-hot", "热歌榜", "netease", "网易云音乐官方热歌榜"],
  ["wy-new", "新歌榜", "netease", "网易云音乐官方新歌榜"],
  ["qq-hot", "巅峰热歌榜", "qq", "QQ音乐巅峰热歌榜"],
  ["apple-cn", "热门歌曲 · 中国", "apple", "Apple Music 中国区热门歌曲"],
].map(([id, name, kind, description]) => ({ id, name, kind, description }));
const titles = ["晴天", "稻香", "七里香", "夜曲", "一路向北", "等你下课"];
const requests = new Map();
let linked = true;
let failedChart = null;
let plays = 0;

function detail(chart) {
  const index = charts.indexOf(chart);
  const colors = ["#6e887c", "#a39279", "#617c8f", "#8a778c", "#777e6a"];
  const cover = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="${colors[index % colors.length]}"/><circle cx="64" cy="64" r="46" fill="#1a1a1a" opacity=".75"/><circle cx="64" cy="64" r="17" fill="#e4ddd0"/><circle cx="64" cy="64" r="4" fill="#555"/></svg>`)}`;
  return { ...chart, updatedAt: Date.now(), entries: Array.from({ length: 12 }, (_, rank) => ({
    rank: rank + 1, title: titles[(index + rank) % titles.length], artist: "周杰伦", coverUrl: cover,
  })) };
}

const shell = `import { reactive } from "vue";
export const router = reactive({ name: "charts", params: {} });
export function go(name, params = {}) { router.name = name; router.params = params; }
export async function refreshPlayback() {}
export function toast() {}
export function primeLocalAudio() {}`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app/styles.css"><script type="importmap">{"imports":{"vue":"/app/vendor/vue.esm-browser.prod.js"}}</script><style>body{padding:32px;overflow:auto} @media(max-width:680px){body{padding:22px 16px}}</style></head><body><div id="app"></div><script type="module">import {createApp} from "vue";import {ChartsView} from "/app/views/charts.js";createApp(ChartsView).mount("#app");</script></body></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const send = (body, status = 200, type = "application/json") => {
    response.writeHead(status, { "content-type": type });
    response.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (url.pathname === "/") return send(html, 200, "text/html");
    if (url.pathname === "/app/main.js") return send(shell, 200, "text/javascript");
    if (url.pathname === "/api/v1/charts") return send({ charts: charts.filter((chart) => linked || !chart.kind.startsWith("spotify")) });
    if (url.pathname.startsWith("/api/v1/charts/")) {
      const id = url.pathname.split("/").at(-1);
      requests.set(id, (requests.get(id) || 0) + 1);
      if (id === failedChart) return send({ error: { code: "SPOTIFY_RATE_LIMITED", message: "Spotify 暂时限流，请稍后重试" } }, 429);
      const chart = charts.find((item) => item.id === id);
      return chart ? send(detail(chart)) : send({}, 404);
    }
    if (url.pathname === "/api/v1/search") return send({ tracks: [{ id: "manual:test", source: "manual", sourceTrackId: "test", title: "晴天", artist: "周杰伦" }] });
    if (url.pathname === "/api/v1/playback/play") { plays += 1; return send({}); }
    if (url.pathname === "/api/v1/downloads") return send({ downloads: [] });
    const file = path.resolve(root, "web", url.pathname.replace(/^\/app\//, ""));
    if (!file.startsWith(path.join(root, "web") + path.sep)) return send({}, 404);
    const type = file.endsWith(".css") ? "text/css" : "text/javascript";
    return send(await readFile(file), 200, type);
  } catch { send({}, 404); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, colorScheme: "light" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('[data-chart-id="spotify-top-long"] .chart-card-song').first().waitFor();
  for (const id of ["spotify-top-short", "spotify-top-medium", "spotify-top-long"]) {
    assert.equal(await page.locator(`[data-chart-id="${id}"] .chart-card-song`).count(), 3);
    assert.equal(requests.get(id), 1);
  }
  assert.equal(await page.getByText("Spotify 设置", { exact: true }).count(), 0);
  assert.equal(await page.getByText("查看全部", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "打开最近常听", exact: true }).click();
  await page.locator(".chart-list .track-row").first().waitFor();
  assert.equal(requests.get("spotify-top-short"), 1);
  await page.getByRole("button", { name: "‹ 返回", exact: true }).click();
  await page.locator('[data-chart-id="spotify-top-short"] .chart-card-song').first().click();
  await page.waitForFunction(() => !globalThis.document.querySelector(".chart-card-song[disabled]"));
  assert.equal(plays, 1);

  for (const [name, width, dark] of [
    ["desktop-light", 1440, false], ["desktop-dark", 1440, true],
    ["tablet", 820, false], ["mobile", 390, false],
  ]) {
    await page.setViewportSize({ width, height: name === "mobile" ? 844 : 1050 });
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
    await page.screenshot({ path: path.join(output, `web-${name}.png`), fullPage: true });
  }
  await page.getByRole("group", { name: "筛选榜单来源" }).getByRole("button", { name: "网易云音乐", exact: true }).click();
  await page.locator('[data-chart-id="wy-new"] .chart-card-song').first().waitFor();
  assert.equal(await page.locator(".charts-discovery .chart-card").count(), 2);
  assert.equal(requests.get("spotify-top-short"), 1);
  failedChart = "spotify-top-medium";
  await page.getByRole("button", { name: "刷新榜单", exact: true }).click();
  await page.getByRole("button", { name: "重试", exact: true }).waitFor();
  assert.equal(await page.locator('[data-chart-id="spotify-top-long"] .chart-card-song').count(), 3);
  failedChart = null;
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.locator('[data-chart-id="spotify-top-medium"] .chart-card-song').first().waitFor();
  linked = false;
  await page.getByRole("button", { name: "刷新榜单", exact: true }).click();
  await page.locator(".charts-personal").waitFor({ state: "detached" });
  assert.equal(await page.locator(".charts-discovery .chart-card").count(), 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "passed", checks: ["首次加载三卡", "预览详情复用", "预览点播", "来源筛选", "限流重试", "解绑刷新", "四种布局无横向溢出"], screenshots: output }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
