import { describe, expect, it, vi } from "vitest";
import { createChartsState } from "../../web/views/charts-state.js";

const charts = [
  { id: "spotify-top-short", name: "最近常听", kind: "spotify-personal" },
  { id: "spotify-top-medium", name: "半年常听", kind: "spotify-personal" },
  { id: "spotify-top-long", name: "长期常听", kind: "spotify-personal" },
  { id: "family", name: "家庭热播", kind: "family" },
  { id: "wy-hot", name: "热歌榜", kind: "netease" },
  { id: "wy-new", name: "新歌榜", kind: "netease" },
];

function detail(id: string) {
  return {
    ...charts.find((chart) => chart.id === id),
    entries: [{ rank: 1, title: `${id} 的第一首`, artist: "歌手" }],
  };
}

describe("榜单首次加载与请求复用", () => {
  it("不打开详情也会填满三个 Spotify 常听卡片，其他来源只预取当前精选", async () => {
    const request = vi.fn(async (path: string) =>
      path === "/charts" ? { charts } : detail(path.slice("/charts/".length)),
    );
    const model = createChartsState(request);
    await model.load();
    for (const chart of charts.slice(0, 3)) {
      expect(model.state.previews[chart.id]?.[0].title).toBe(
        `${chart.id} 的第一首`,
      );
    }
    expect(model.state.activeId).toBe("");
    expect(request).not.toHaveBeenCalledWith("/charts/wy-new");
    await model.selectSource("netease");
    expect(model.state.previews["wy-new"]).toHaveLength(1);
    await model.open("spotify-top-short");
    expect(model.state.detail?.entries).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([path]) => path === "/charts/spotify-top-short",
      ),
    ).toHaveLength(1);
  });

  it("一张卡片失败不阻断其他卡，重试只加载失败的卡片", async () => {
    let failed = true;
    const request = vi.fn(async (path: string) => {
      if (path === "/charts") return { charts };
      if (path === "/charts/spotify-top-medium" && failed)
        throw new Error("Spotify 暂时限流");
      return detail(path.slice("/charts/".length));
    });
    const model = createChartsState(request);
    await model.load();
    expect(model.state.previewErrors["spotify-top-medium"]).toBe(
      "Spotify 暂时限流",
    );
    expect(model.state.previews["spotify-top-long"]).toHaveLength(1);
    failed = false;
    await model.retryPreview("spotify-top-medium");
    expect(model.state.previewErrors["spotify-top-medium"]).toBeUndefined();
    expect(model.state.previews["spotify-top-medium"]).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([path]) => path === "/charts/spotify-top-long",
      ),
    ).toHaveLength(1);
  });

  it("预取未结束时打开详情共享请求，返回后旧详情响应不能重新打开页面", async () => {
    let release!: (value: ReturnType<typeof detail>) => void;
    const pending = new Promise<ReturnType<typeof detail>>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (path: string) =>
      path === "/charts" ? { charts: charts.slice(0, 1) } : pending,
    );
    const model = createChartsState(request);
    const loading = model.load();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("/charts/spotify-top-short"),
    );
    const opening = model.open("spotify-top-short");
    model.back();
    release(detail("spotify-top-short"));
    await Promise.all([loading, opening]);
    expect(model.state.activeId).toBe("");
    expect(model.state.detail).toBeNull();
    expect(model.state.previews["spotify-top-short"]).toHaveLength(1);
    expect(
      request.mock.calls.filter(
        ([path]) => path === "/charts/spotify-top-short",
      ),
    ).toHaveLength(1);
  });

  it("新一轮目录刷新后，旧账号的迟到预览不能回填", async () => {
    let release!: (value: ReturnType<typeof detail>) => void;
    const pending = new Promise<ReturnType<typeof detail>>((resolve) => {
      release = resolve;
    });
    let linked = true;
    const request = vi.fn(async (path: string) => {
      if (path === "/charts")
        return { charts: linked ? charts.slice(0, 1) : [] };
      return pending;
    });
    const model = createChartsState(request);
    const loading = model.load();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const opening = model.open("spotify-top-short");
    linked = false;
    await model.load();
    release(detail("spotify-top-short"));
    await Promise.all([loading, opening]);
    expect(model.state.charts).toEqual([]);
    expect(model.state.previews).toEqual({});
    expect(model.state.activeId).toBe("");
    expect(model.state.detail).toBeNull();
  });

  it("预取期间连续切平台和打开详情仍共用两个请求名额", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const request = vi.fn(async (path: string) => {
      if (path === "/charts") return { charts };
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) =>
        releases.push(() => {
          active -= 1;
          resolve(detail(path.slice("/charts/".length)));
        }),
      );
    });
    const model = createChartsState(request);
    const loading = model.load();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const selecting = model.selectSource("netease");
    const opening = model.open("wy-new");
    while (releases.length) {
      for (const release of releases.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([loading, selecting, opening]);
    expect(peak).toBe(2);
    expect(model.state.detail?.id).toBe("wy-new");
    expect(model.state.previews["spotify-top-long"]).toHaveLength(1);
    expect(
      request.mock.calls.filter(([path]) => path === "/charts/wy-new"),
    ).toHaveLength(1);
  });

  it("刷新取消尚未发出的旧详情，避免旧账号请求继续排队", async () => {
    let release!: (value: ReturnType<typeof detail>) => void;
    const pending = new Promise<ReturnType<typeof detail>>((resolve) => {
      release = resolve;
    });
    let linked = true;
    const request = vi.fn(async (path: string) =>
      path === "/charts" ? { charts: linked ? charts : [] } : pending,
    );
    const model = createChartsState(request);
    const loading = model.load();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    const opening = model.open("wy-new");
    linked = false;
    await model.load();
    await opening;
    release(detail("spotify-top-short"));
    await loading;
    expect(request).not.toHaveBeenCalledWith("/charts/wy-new");
    expect(model.state.previews).toEqual({});
    expect(model.state.detailError).toBe("");
    expect(model.state.detailLoading).toBe(false);
  });
});
