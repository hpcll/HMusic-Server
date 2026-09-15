import { reactive } from "vue";

export const CHART_SOURCES = [
  { kind: "featured", label: "精选" },
  { kind: "spotify-public", label: "Spotify" },
  { kind: "netease", label: "网易云音乐" },
  { kind: "qq", label: "QQ音乐" },
  { kind: "apple", label: "Apple Music" },
  { kind: "family", label: "HMusic" },
];

export function discoveryCharts(charts, source) {
  const publicCharts = charts.filter((chart) => chart.kind !== "spotify-personal");
  if (source !== "featured") return publicCharts.filter((chart) => chart.kind === source);
  const kinds = new Set();
  return publicCharts.filter((chart) => {
    if (kinds.has(chart.kind)) return false;
    kinds.add(chart.kind);
    return true;
  });
}

// 目录、预览与详情共享请求。每次刷新有独立代数，迟到响应不能覆盖新账号内容。
export function createChartsState(request) {
  const state = reactive({
    charts: [], previews: {}, previewErrors: {}, source: "featured",
    loading: true, loadError: "", activeId: "", detail: null,
    detailLoading: false, detailError: "",
  });
  const details = new Map();
  const pending = new Map();
  const reads = [];
  let activeReads = 0;
  let generation = 0;
  let detailRevision = 0;
  let disposed = false;

  function drainReads() {
    while (activeReads < 2 && reads.length) {
      const job = reads.shift();
      activeReads += 1;
      Promise.resolve().then(() => request(`/charts/${encodeURIComponent(job.id)}`))
        .then(job.resolve, job.reject).finally(() => {
          activeReads -= 1;
          drainReads();
        });
    }
  }

  function clearReads() {
    for (const job of reads.splice(0)) job.reject(new Error("榜单已刷新"));
    details.clear();
    pending.clear();
  }

  function readChart(id) {
    if (details.has(id)) return Promise.resolve(details.get(id));
    if (pending.has(id)) return pending.get(id);
    const revision = generation;
    const promise = new Promise((resolve, reject) => {
      reads.push({ id, resolve, reject });
      drainReads();
    }).then((chart) => {
      if (!disposed && revision === generation) details.set(id, chart);
      return chart;
    }).finally(() => {
      if (pending.get(id) === promise) pending.delete(id);
    });
    pending.set(id, promise);
    return promise;
  }

  async function preview(id, revision = generation) {
    try {
      const chart = await readChart(id);
      if (disposed || revision !== generation) return;
      state.previews[id] = (chart.entries || []).slice(0, 3);
      delete state.previewErrors[id];
    } catch (error) {
      if (disposed || revision !== generation) return;
      state.previews[id] = null;
      state.previewErrors[id] = error.message || "暂时无法加载，稍后重试";
    }
  }

  async function preloadVisible(revision = generation) {
    const visible = [
      ...state.charts.filter((chart) => chart.kind === "spotify-personal"),
      ...discoveryCharts(state.charts, state.source),
    ].filter((chart) => !(chart.id in state.previews));
    let cursor = 0;
    async function worker() {
      while (!disposed && revision === generation && cursor < visible.length) {
        await preview(visible[cursor++].id, revision);
      }
    }
    await Promise.all([worker(), worker()]);
  }

  async function load() {
    const revision = ++generation;
    back();
    clearReads();
    state.loading = true;
    state.loadError = "";
    try {
      const result = await request("/charts");
      if (disposed || revision !== generation) return;
      state.charts = result.charts || [];
      state.previews = {};
      state.previewErrors = {};
      if (!state.charts.some((chart) => chart.kind === state.source)) state.source = "featured";
    } catch (error) {
      if (!disposed && revision === generation) state.loadError = error.message || "榜单加载失败";
      return;
    } finally {
      if (!disposed && revision === generation) state.loading = false;
    }
    await preloadVisible(revision);
  }

  async function selectSource(source) {
    state.source = source;
    await preloadVisible();
  }

  async function retryPreview(id) {
    details.delete(id);
    delete state.previews[id];
    delete state.previewErrors[id];
    await preview(id);
  }

  async function open(id) {
    const revision = ++detailRevision;
    const currentGeneration = generation;
    state.activeId = id;
    state.detail = null;
    state.detailLoading = true;
    state.detailError = "";
    try {
      const chart = await readChart(id);
      if (disposed || revision !== detailRevision || currentGeneration !== generation) return;
      state.detail = chart;
      state.previews[id] = (chart.entries || []).slice(0, 3);
      delete state.previewErrors[id];
    } catch (error) {
      if (!disposed && revision === detailRevision && currentGeneration === generation) state.detailError = error.message || "榜单加载失败";
    } finally {
      if (!disposed && revision === detailRevision && currentGeneration === generation) state.detailLoading = false;
    }
  }

  function back() {
    detailRevision += 1;
    state.activeId = "";
    state.detail = null;
    state.detailLoading = false;
    state.detailError = "";
  }

  function dispose() {
    disposed = true;
    generation += 1;
    detailRevision += 1;
    clearReads();
  }

  return { state, load, open, back, selectSource, retryPreview, dispose };
}
