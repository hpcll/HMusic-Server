import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type { HMusicTrack } from "../../src/shared/contracts.js";

let dataDir: string;
let spotify: typeof import("../../src/modules/spotify/spotify.service.js");
let queue: typeof import("../../src/modules/queue/queue.service.js");
let search: typeof import("../../src/modules/search/search.service.js");
let playback: typeof import("../../src/modules/playback/playback.service.js");

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-spotify-playback-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "spotify-playback-test-secret";
  process.env.HMUSIC_LOG_LEVEL = "silent";
  const database = await import("../../src/db/index.js");
  database.ensureSchema();
  spotify = await import("../../src/modules/spotify/spotify.service.js");
  queue = await import("../../src/modules/queue/queue.service.js");
  search = await import("../../src/modules/search/search.service.js");
  playback = await import("../../src/modules/playback/playback.service.js");
});

beforeEach(async () => {
  await queue.clearQueue();
  vi.spyOn(search, "searchTracks").mockResolvedValue(results());
  // 搜索使用受控候选，播放走真实本机流程；测试不向外发送请求。
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("播放测试不应访问网络");
    }),
  );
});

afterEach(async () => {
  await spotify.clearSession();
  playback.resetPlaybackStateForAccountDeletion();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function entry(title: string) {
  return {
    id: title,
    title,
    artist: "Artist",
    album: "",
    durationMs: 180000,
    coverUrl: null,
    uri: `spotify:track:${title}`,
  };
}

function track(title: string, artist = "Artist"): HMusicTrack {
  return {
    id: `manual:${title}`,
    source: "manual",
    sourceTrackId: title,
    title,
    artist,
    durationMs: 180000,
    url: `https://example.invalid/${encodeURIComponent(title)}.mp3`,
  };
}

function results(...tracks: HMusicTrack[]) {
  return { query: "test", page: 1, limit: 5, total: tracks.length, tracks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleBackground() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("Spotify 匹配播放", () => {
  it("跳过两首未匹配歌曲后，只报告实际入队的一首", async () => {
    vi.mocked(search.searchTracks)
      .mockResolvedValueOnce(results())
      .mockResolvedValueOnce(results())
      .mockResolvedValueOnce(results(track("third")));
    const result = await spotify.playSpotifyEntries(
      [entry("first"), entry("second"), entry("third")],
      { deviceId: "local-browser" },
    );
    expect(result.matched).toBe(1);
    expect(
      (await queue.getQueue()).items.map((item) => item.track.title),
    ).toEqual(["third"]);
  });

  it("首条候选歌手不匹配时选择后续同曲候选", async () => {
    vi.mocked(search.searchTracks).mockResolvedValueOnce(
      results(track("song", "Unrelated Singer"), track("song")),
    );
    await spotify.playSpotifyEntries([entry("song")], {
      deviceId: "local-browser",
    });
    expect((await queue.getQueue()).items[0].track.artist).toBe("Artist");
  });

  it("全部失配时保留原队列", async () => {
    await queue.replaceQueue({ tracks: [track("existing")] });
    vi.mocked(search.searchTracks).mockResolvedValueOnce(
      results(track("different-song")),
    );
    await expect(
      spotify.playSpotifyEntries([entry("requested")], {}),
    ).rejects.toMatchObject({ code: "SPOTIFY_MATCH_EMPTY" });
    expect((await queue.getQueue()).items[0].track.title).toBe("existing");
  });

  it.each([-1, 0.5, 2])("非法起始索引 %s 不发起搜索", async (startIndex) => {
    await expect(
      spotify.playSpotifyEntries([entry("song")], { startIndex }),
    ).rejects.toMatchObject({ code: "SPOTIFY_INDEX_INVALID" });
    expect(search.searchTracks).not.toHaveBeenCalled();
  });

  it.each(["clear", "replace", "delete-account", "unlink"])(
    "%s 后停止已经在途的后台追加",
    async (action) => {
      const pending = deferred<ReturnType<typeof results>>();
      const started = deferred<void>();
      vi.mocked(search.searchTracks)
        .mockResolvedValueOnce(results(track("first")))
        .mockImplementationOnce(() => {
          started.resolve();
          return pending.promise;
        });
      await spotify.playSpotifyEntries([entry("first"), entry("second")], {
        deviceId: "local-browser",
      });
      await started.promise;
      if (action === "clear") await queue.clearQueue();
      if (action === "replace")
        await queue.replaceQueue({ tracks: [track("replacement")] });
      if (action === "delete-account") queue.resetQueueForAccountDeletion();
      if (action === "unlink") await spotify.clearSession();
      pending.resolve(results(track("second")));
      await settleBackground();
      const titles = (await queue.getQueue()).items.map(
        (item) => item.track.title,
      );
      expect(titles).toEqual(
        action === "replace"
          ? ["replacement"]
          : action === "unlink"
            ? ["first"]
            : [],
      );
    },
  );

  it("普通追加不取消同一队列的后台补齐", async () => {
    const pending = deferred<ReturnType<typeof results>>();
    const started = deferred<void>();
    vi.mocked(search.searchTracks)
      .mockResolvedValueOnce(results(track("first")))
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
    await spotify.playSpotifyEntries([entry("first"), entry("second")], {
      deviceId: "local-browser",
    });
    await started.promise;
    await queue.addQueueTrack(track("manual-extra"));
    pending.resolve(results(track("second")));
    await settleBackground();
    expect(
      (await queue.getQueue()).items.map((item) => item.track.title),
    ).toEqual(["first", "manual-extra", "second"]);
  });

  it("旧请求的首曲搜索迟到，不能覆盖后发请求的队列", async () => {
    const pending = deferred<ReturnType<typeof results>>();
    const started = deferred<void>();
    vi.mocked(search.searchTracks)
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValueOnce(results(track("new")));
    const oldRequest = spotify.playSpotifyEntries([entry("old")], {
      deviceId: "local-browser",
    });
    const rejected = expect(oldRequest).rejects.toMatchObject({
      code: "SPOTIFY_PLAY_CANCELLED",
    });
    await started.promise;
    await spotify.playSpotifyEntries([entry("new")], {
      deviceId: "local-browser",
    });
    pending.resolve(results(track("old")));
    await rejected;
    expect(
      (await queue.getQueue()).items.map((item) => item.track.title),
    ).toEqual(["new"]);
  });

  it.each(["clear", "unlink", "supersede"])(
    "%s 发生在首曲解析期间时，不接受迟到的播放结果",
    async (action) => {
      const pending =
        deferred<Awaited<ReturnType<typeof search.resolveTrack>>>();
      const started = deferred<void>();
      vi.mocked(search.searchTracks).mockResolvedValueOnce(
        results(track("first")),
      );
      vi.spyOn(search, "resolveTrack").mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const request = spotify.playSpotifyEntries([entry("first")], {
        deviceId: "local-browser",
      });
      const result = request.catch((error: unknown) => error);
      await started.promise;
      if (action === "clear") await queue.clearQueue();
      if (action === "unlink") await spotify.clearSession();
      if (action === "supersede") {
        await expect(
          spotify.playSpotifyEntries([entry("second")], {
            deviceId: "local-browser",
          }),
        ).rejects.toMatchObject({ code: "SPOTIFY_MATCH_EMPTY" });
      }
      pending.resolve({
        track: track("first"),
        url: track("first").url!,
        quality: "source",
      });
      const error = await result;
      expect(await playback.getPlaybackState()).toMatchObject({
        state: "idle",
      });
      expect(error).toMatchObject({ code: "PLAYBACK_CANCELLED" });
      if (action === "clear")
        expect((await queue.getQueue()).items).toEqual([]);
    },
  );

  it("等待后续歌单页时，首曲已经返回播放结果", async () => {
    const nextPage = deferred<void>();
    const pageStarted = deferred<void>();
    async function* entries() {
      yield entry("first");
      pageStarted.resolve();
      await nextPage.promise;
      yield entry("second");
    }
    vi.mocked(search.searchTracks)
      .mockResolvedValueOnce(results(track("first")))
      .mockResolvedValueOnce(results(track("second")));
    const result = await spotify.playSpotifyEntries(entries(), {
      deviceId: "local-browser",
    });
    expect(result.matched).toBe(1);
    await pageStarted.promise;
    expect((await queue.getQueue()).items).toHaveLength(1);
    nextPage.resolve();
    await settleBackground();
    expect(
      (await queue.getQueue()).items.map((item) => item.track.title),
    ).toEqual(["first", "second"]);
  });
});
