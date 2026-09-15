import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { AppError } from "../../src/shared/errors.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let dataDir: string;
let app: FastifyInstance;
let headers: { authorization: string };
let spotify: typeof import("../../src/modules/spotify/spotify.service.js");
let search: typeof import("../../src/modules/search/search.service.js");
let queue: typeof import("../../src/modules/queue/queue.service.js");
let playback: typeof import("../../src/modules/playback/playback.service.js");

const rawTrack = {
  id: "song",
  name: "Song",
  uri: "spotify:track:song",
  duration_ms: 180000,
  artists: [{ name: "Artist" }],
  album: { name: "Album", images: [] },
};
let apiResponse: (url: URL) => Response;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchResult(title: string) {
  return {
    query: title,
    page: 1,
    limit: 5,
    total: 1,
    tracks: [
      {
        id: `manual:${title}`,
        source: "manual",
        sourceTrackId: title,
        title,
        artist: "Artist",
        durationMs: 180000,
        url: `https://example.invalid/${encodeURIComponent(title)}.mp3`,
      },
    ],
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-spotify-api-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "spotify-api-test-secret";
  process.env.HMUSIC_LOG_LEVEL = "silent";
  const { buildApp } = await import("../../src/app.js");
  app = await buildApp();
  spotify = await import("../../src/modules/spotify/spotify.service.js");
  search = await import("../../src/modules/search/search.service.js");
  queue = await import("../../src/modules/queue/queue.service.js");
  playback = await import("../../src/modules/playback/playback.service.js");
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { username: "spotify-review", password: "spotify-test-password" },
  });
  expect(setup.statusCode).toBe(200);
  headers = { authorization: `Bearer ${setup.json().accessToken}` };
});

beforeEach(async () => {
  await spotify.clearSession();
  await queue.clearQueue();
  apiResponse = () => json({ items: [rawTrack], total: 1, next: null });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "raw.githubusercontent.com")
        return json({ "42": [11, 22, 33, 44] });
      if (url.hostname === "open.spotify.com")
        return json({
          accessToken: "spotify-api-test-token",
          accessTokenExpirationTimestampMs: Date.now() + 3600_000,
          isAnonymous: false,
        });
      if (url.hostname === "api.spotify.com") return apiResponse(url);
      throw new Error("意外的外部网络请求");
    }),
  );
  vi.spyOn(search, "searchTracks").mockImplementation(async (input) =>
    searchResult(input.query.replace(/ Artist$/, "")),
  );
});

afterEach(async () => {
  await spotify.clearSession();
  playback.resetPlaybackStateForAccountDeletion();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function bind() {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/spotify/session",
    headers,
    payload: { spDc: "  spotify-api-test-cookie  " },
  });
  expect(response.statusCode).toBe(200);
}

describe("Spotify API", () => {
  it("统一榜单目录按连接状态展示 Spotify，并支持商店版排除", async () => {
    const list = (suffix = "") =>
      app.inject({ method: "GET", url: `/api/v1/charts${suffix}`, headers });
    const unlinked = await list();
    expect(
      unlinked
        .json()
        .charts.some((chart: { kind: string }) =>
          chart.kind.startsWith("spotify"),
        ),
    ).toBe(false);
    await bind();
    const linked = await list();
    expect(
      linked
        .json()
        .charts.filter(
          (chart: { kind: string }) => chart.kind === "spotify-personal",
        ),
    ).toHaveLength(3);
    const store = await list("?includeSpotify=false");
    expect(store.json()).toEqual(unlinked.json());
    await spotify.clearSession();
    expect((await list()).json()).toEqual(unlinked.json());
  });

  it("三个常听榜可直接读取预览，详情与播放复用同一份 Top 50", async () => {
    await bind();
    const calls: string[] = [];
    apiResponse = (url) => {
      calls.push(
        `${url.searchParams.get("time_range")}:${url.searchParams.get("limit")}`,
      );
      return json({ items: [rawTrack], total: 1, next: null });
    };
    for (const period of ["short", "medium", "long"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/charts/spotify-top-${period}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        kind: "spotify-personal",
        entries: [{ rank: 1, title: "Song", artist: "Artist" }],
      });
    }
    const second = await app.inject({
      method: "GET",
      url: "/api/v1/charts/spotify-top-short",
      headers,
    });
    expect(second.statusCode).toBe(200);
    const played = await app.inject({
      method: "POST",
      url: "/api/v1/charts/spotify-top-short/play",
      headers,
      payload: { deviceId: "local-browser" },
    });
    expect(played.statusCode).toBe(200);
    expect(played.json()).toMatchObject({
      matched: 1,
      playback: { state: "playing", track: { title: "Song" } },
    });
    expect(calls).toEqual(["short_term:50", "medium_term:50", "long_term:50"]);
  });

  it("Spotify 失效不会让统一榜单返回代表 HMusic 登出的 401", async () => {
    vi.spyOn(spotify, "topTracks").mockRejectedValue(
      new AppError("SPOTIFY_SESSION_INVALID", "expired", 401),
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/charts/spotify-top-short",
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SPOTIFY_SESSION_INVALID");
    const status = await app.inject({
      method: "GET",
      url: "/api/v1/auth/status",
      headers,
    });
    expect(status.json().authenticated).toBe(true);
  });

  it.each([
    ["GET", "/session"],
    ["POST", "/session"],
    ["DELETE", "/session"],
    ["GET", "/recommendations"],
    ["POST", "/recommendations/play"],
    ["GET", "/playlists"],
    ["GET", "/playlists/test/tracks"],
    ["POST", "/playlists/test/play"],
  ] as const)("%s %s 需要 HMusic 登录", async (method, url) => {
    const response = await app.inject({ method, url: `/api/v1/spotify${url}` });
    expect(response.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("真实 Top Tracks 结构可以列出并播放，保留 tracks 响应字段", async () => {
    await bind();
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/spotify/recommendations",
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      tracks: [{ id: "song", title: "Song", artist: "Artist" }],
      offset: 0,
      total: 1,
      nextOffset: null,
    });
    const played = await app.inject({
      method: "POST",
      url: "/api/v1/spotify/recommendations/play",
      headers,
      payload: { deviceId: "local-browser" },
    });
    expect(played.statusCode).toBe(200);
    expect(played.json()).toMatchObject({
      matched: 1,
      playback: { state: "playing", track: { title: "Song" } },
    });
  });

  it("空白 Cookie 和非法分页参数直接返回 400", async () => {
    const linked = await app.inject({
      method: "POST",
      url: "/api/v1/spotify/session",
      headers,
      payload: { spDc: "             " },
    });
    expect(linked.statusCode).toBe(400);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/spotify/playlists?offset=-1",
      headers,
    });
    expect(listed.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("歌单分页可见，整单播放的起始索引可以超过 100", async () => {
    await bind();
    const offsets: number[] = [];
    apiResponse = (url) => {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(offset);
      return json({
        items: Array.from({ length: offset === 0 ? 100 : 1 }, (_, i) => ({
          track: {
            ...rawTrack,
            id: String(offset + i),
            name: `Song ${offset + i}`,
          },
        })),
        total: 101,
        next:
          offset === 0
            ? "https://api.spotify.com/v1/playlists/test/tracks?offset=100"
            : null,
      });
    };
    const page = await app.inject({
      method: "GET",
      url: "/api/v1/spotify/playlists/test/tracks?offset=100",
      headers,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      tracks: [{ title: "Song 100" }],
      offset: 100,
      total: 101,
      nextOffset: null,
    });
    offsets.length = 0;
    const played = await app.inject({
      method: "POST",
      url: "/api/v1/spotify/playlists/test/play",
      headers,
      payload: { startIndex: 100, deviceId: "local-browser" },
    });
    expect(played.statusCode).toBe(200);
    expect(played.json()).toMatchObject({
      matched: 1,
      playback: { track: { title: "Song 100" } },
    });
    expect(offsets).toEqual([0, 100]);
  });

  it("切到 Spotify 后，旧 Apple 榜单不能继续追加曲目", async () => {
    await bind();
    const charts = await import("../../src/modules/charts/charts.service.js");
    vi.spyOn(charts, "getChart").mockResolvedValue({
      id: "apple-test",
      name: "Test",
      description: "",
      kind: "apple",
      updatedAt: 0,
      entries: [
        { rank: 1, title: "Chart First", artist: "Artist" },
        { rank: 2, title: "Chart Second", artist: "Artist" },
      ],
    });
    let release!: (value: ReturnType<typeof searchResult>) => void;
    let started!: () => void;
    const pending = new Promise<ReturnType<typeof searchResult>>((resolve) => {
      release = resolve;
    });
    const searching = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(search.searchTracks).mockImplementation(async (input) => {
      if (input.query === "Chart Second Artist") {
        started();
        return pending;
      }
      return searchResult(input.query.replace(/ Artist$/, ""));
    });
    const chart = await app.inject({
      method: "POST",
      url: "/api/v1/charts/apple-test/play",
      headers,
      payload: { deviceId: "local-browser" },
    });
    expect(chart.statusCode).toBe(200);
    await searching;
    const played = await app.inject({
      method: "POST",
      url: "/api/v1/spotify/recommendations/play",
      headers,
      payload: { deviceId: "local-browser" },
    });
    expect(played.statusCode).toBe(200);
    release(searchResult("Chart Second"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      (await queue.getQueue()).items.map((item) => item.track.title),
    ).toEqual(["Song"]);
  });
});
