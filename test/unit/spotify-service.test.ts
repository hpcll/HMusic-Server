import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// env 是模块级单例（导入即读 process.env），必须先设好临时数据目录再动态
// 导入被测模块——与 update-service 等单测同一手法。
let dataDir: string;
let svc: typeof import("../../src/modules/spotify/spotify.service.js");
let database: typeof import("../../src/db/index.js");
let schema: typeof import("../../src/db/schema.js");

const CIPHER = [11, 22, 33, 44, 55, 66, 77, 88, 99, 12];

// 期望值由独立 Python 实现按同一算法预计算（XOR 变换 → ASCII hex 字节为
// HMAC-SHA1 密钥 → counter=unix/30 → dynamic truncation 6 位），跨语言对拍。
const TOTP_VECTOR = "307992";
const TOTP_TIME_MS = 1735689600 * 1000; // 2025-01-01T00:00:00Z

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-spotify-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "spotify-unit-test-secret";
  svc = await import("../../src/modules/spotify/spotify.service.js");
  database = await import("../../src/db/index.js");
  schema = await import("../../src/db/schema.js");
  database.ensureSchema();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // clearSession 同时清 token/secrets 模块级缓存——密钥库缓存若跨测试残留，
  // 下一个测试的 fetch 应答序号会错位（401 测试拉过密钥库后尤其如此）。
  await svc.clearSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 按调用顺序应答：第 1 发密钥库、第 2 发 token、其后 Spotify API。
function stubFetchSequence(
  responses: Array<
    (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Response | Promise<Response>
  >,
) {
  let call = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const respond = responses[call++];
    if (!respond) throw new Error("意外的上游请求：测试响应已耗尽");
    return Promise.resolve(respond(input, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function tokenResponse(accessToken = "test-token", expiresInMs = 3600_000) {
  return jsonResponse({
    accessToken,
    accessTokenExpirationTimestampMs: Date.now() + expiresInMs,
    isAnonymous: false,
  });
}

function savedSession() {
  return database.db
    .select()
    .from(schema.appConfig)
    .where(eq(schema.appConfig.key, "spotifySession"))
    .get();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("generateTotp", () => {
  it("与独立 Python 实现对拍（固定 cipher + 固定时间）", () => {
    expect(svc.generateTotp(CIPHER, TOTP_TIME_MS)).toBe(TOTP_VECTOR);
  });

  it("同一 30s 窗口内稳定，跨窗口变化", () => {
    const a = svc.generateTotp(CIPHER, TOTP_TIME_MS + 1000);
    const b = svc.generateTotp(CIPHER, TOTP_TIME_MS + 29_000);
    const c = svc.generateTotp(CIPHER, TOTP_TIME_MS + 31_000);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe("会话管理", () => {
  it("未登录时 sessionStatus 为 false，推荐接口报 SPOTIFY_NOT_LINKED", async () => {
    expect(await svc.sessionStatus()).toEqual({
      loggedIn: false,
      tokenExpiresAtMs: null,
    });
    await expect(svc.topTracks("short_term", 10)).rejects.toMatchObject({
      code: "SPOTIFY_NOT_LINKED",
    });
  });

  it("linkSession：密钥库 + token 两步成功后落库并缓存 token", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () =>
        jsonResponse({
          accessToken: "tok123",
          accessTokenExpirationTimestampMs: Date.now() + 3600_000,
          isAnonymous: false,
        }),
    ]);
    await svc.linkSession("sp_dc=测试值");
    const status = await svc.sessionStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.tokenExpiresAtMs).toBeGreaterThan(Date.now());
    await svc.clearSession();
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: false });
  });

  it("linkSession：token 服务 401 时报 SPOTIFY_SESSION_INVALID 且不落库", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => jsonResponse({ error: "invalid" }, 401),
    ]);
    await expect(svc.linkSession("bad-cookie")).rejects.toMatchObject({
      code: "SPOTIFY_SESSION_INVALID",
    });
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: false });
  });
});

describe("topTracks 归一化", () => {
  it("Spotify track → 统一条目（歌名/歌手/封面/时长）", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () =>
        jsonResponse({
          accessToken: "tok123",
          accessTokenExpirationTimestampMs: Date.now() + 3600_000,
          isAnonymous: false,
        }),
      () =>
        jsonResponse({
          items: [
            {
              id: "abc",
              name: "晴天",
              uri: "spotify:track:abc",
              duration_ms: 269000,
              artists: [{ name: "周杰伦" }],
              album: {
                name: "叶惠美",
                images: [{ url: "https://img/cover.jpg" }],
              },
            },
            { id: null, name: "无 id 脏数据" },
            null,
          ],
        }),
    ]);
    await svc.linkSession("sp_dc=测试值");
    const { items: tracks } = await svc.topTracks("short_term", 10);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: "abc",
      title: "晴天",
      artist: "周杰伦",
      album: "叶惠美",
      durationMs: 269000,
      coverUrl: "https://img/cover.jpg",
      uri: "spotify:track:abc",
    });
  });
});

describe("会话持久化与失效", () => {
  it("仅加密保存 Cookie，读取时恢复原值", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
    ]);
    await svc.linkSession("private-test-cookie");
    const stored = savedSession()!.valueJson;
    expect(stored).not.toContain("private-test-cookie");
    expect(JSON.parse(stored)).toMatchObject({ spDcEnc: expect.any(String) });
    expect(JSON.parse(stored)).not.toHaveProperty("spDc");
    expect(await svc.loadSession()).toMatchObject({
      spDc: "private-test-cookie",
    });
  });

  it("旧明文 Cookie 自动迁移且保留绑定时间", async () => {
    database.db
      .insert(schema.appConfig)
      .values({
        key: "spotifySession",
        valueJson: JSON.stringify({ spDc: "legacy-cookie", savedAt: 123 }),
        updatedAt: 123,
      })
      .run();
    expect(await svc.loadSession()).toEqual({
      spDc: "legacy-cookie",
      savedAt: 123,
    });
    expect(savedSession()!.valueJson).not.toContain("legacy-cookie");
    expect(await svc.loadSession()).toEqual({
      spDc: "legacy-cookie",
      savedAt: 123,
    });
  });

  it("数据库会话被删除后不能仅凭缓存访问上游", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
    ]);
    await svc.linkSession("private-test-cookie");
    database.db
      .delete(schema.appConfig)
      .where(eq(schema.appConfig.key, "spotifySession"))
      .run();
    await expect(svc.userPlaylists(10)).rejects.toMatchObject({
      code: "SPOTIFY_NOT_LINKED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("解绑后，尚未完成的绑定不能重新落库", async () => {
    const pending = deferred<Response>();
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => pending.promise,
    ]);
    const linking = svc.linkSession("private-test-cookie");
    const rejected = expect(linking).rejects.toMatchObject({
      code: "SPOTIFY_SESSION_CHANGED",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await svc.clearSession();
    pending.resolve(tokenResponse());
    await rejected;
    expect(savedSession()).toBeUndefined();
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: false });
  });

  it("API 401 后刷新一次 token 并重试成功", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("old-token"),
      () => jsonResponse({}, 401),
      () => tokenResponse("new-token"),
      () => jsonResponse({ items: [] }),
    ]);
    await svc.linkSession("private-test-cookie");
    expect((await svc.userPlaylists(10)).items).toEqual([]);
    expect(fetchMock.mock.calls[2][1]?.headers).toEqual({
      Authorization: "Bearer old-token",
    });
    expect(fetchMock.mock.calls[4][1]?.headers).toEqual({
      Authorization: "Bearer new-token",
    });
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: true });
  });

  it.each(["refresh", "retry"])(
    "%s 确认授权失效后清除会话，状态不再误报已登录",
    async (failure) => {
      stubFetchSequence([
        () => jsonResponse({ "42": CIPHER }),
        () => tokenResponse(),
        () => jsonResponse({}, 401),
        () => (failure === "refresh" ? jsonResponse({}, 401) : tokenResponse()),
        () => jsonResponse({}, 401),
      ]);
      await svc.linkSession("private-test-cookie");
      await expect(svc.userPlaylists(10)).rejects.toMatchObject({
        code: "SPOTIFY_SESSION_INVALID",
      });
      expect(savedSession()).toBeUndefined();
      expect(await svc.sessionStatus()).toEqual({
        loggedIn: false,
        tokenExpiresAtMs: null,
      });
    },
  );

  it("资源权限不足不当作登录失效", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () => jsonResponse({}, 403),
    ]);
    await svc.linkSession("private-test-cookie");
    await expect(svc.userPlaylists(10)).rejects.toMatchObject({
      code: "SPOTIFY_FORBIDDEN",
      statusCode: 403,
    });
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: true });
  });

  it("token 服务暂时故障不删除有效 Cookie", async () => {
    stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("short-lived", 1000),
      () => jsonResponse({}, 503),
    ]);
    await svc.linkSession("private-test-cookie");
    await expect(svc.userPlaylists(10)).rejects.toMatchObject({
      code: "SPOTIFY_TOKEN_ERROR",
      statusCode: 502,
    });
    expect(await svc.loadSession()).toMatchObject({
      spDc: "private-test-cookie",
    });
  });

  it("并行请求共享一次 token 刷新", async () => {
    const pending = deferred<Response>();
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("old-token", 1000),
      () => pending.promise,
      () => jsonResponse({ items: [] }),
      () => jsonResponse({ items: [] }),
    ]);
    await svc.linkSession("private-test-cookie");
    const requests = Promise.all([
      svc.userPlaylists(10),
      svc.topTracks("short_term", 10),
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    pending.resolve(tokenResponse());
    await requests;
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("旧请求延迟返回 401 不会清除新绑定", async () => {
    const pending = deferred<Response>();
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("old-token"),
      () => pending.promise,
      () => tokenResponse("new-token"),
      () => jsonResponse({ items: [] }),
    ]);
    await svc.linkSession("old-cookie");
    const oldRequest = svc.userPlaylists(10);
    const rejected = expect(oldRequest).rejects.toMatchObject({
      code: "SPOTIFY_SESSION_CHANGED",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await svc.linkSession("new-cookie");
    pending.resolve(jsonResponse({}, 401));
    await rejected;
    await svc.userPlaylists(10);
    expect(fetchMock.mock.calls[4][1]?.headers).toEqual({
      Authorization: "Bearer new-token",
    });
    expect(await svc.loadSession()).toMatchObject({ spDc: "new-cookie" });
  });

  it("重新绑定期间的后台查询不能刷新旧 Cookie 并取消新绑定", async () => {
    const pending = deferred<Response>();
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("old-token"),
      () => pending.promise,
      (input) =>
        new URL(String(input)).hostname === "open.spotify.com"
          ? jsonResponse({}, 401)
          : jsonResponse({ items: [] }),
    ]);
    await svc.linkSession("old-cookie");
    const linking = svc
      .linkSession("new-cookie")
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const listing = svc.userPlaylists(10).catch((error: unknown) => error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.resolve(tokenResponse("new-token"));

    expect(await linking).toBeUndefined();
    expect(await listing).toMatchObject({ code: "SPOTIFY_SESSION_CHANGED" });
    expect(await svc.loadSession()).toMatchObject({ spDc: "new-cookie" });
    expect((await svc.userPlaylists(10)).items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1]?.headers).toEqual({
      Authorization: "Bearer new-token",
    });
  });

  it("旧 token 的 401 迟到时复用已刷新的 token", async () => {
    const pending = deferred<Response>();
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse("old-token"),
      () => pending.promise,
      () => jsonResponse({}, 401),
      () => tokenResponse("new-token"),
      () => jsonResponse({ items: [] }),
      (input) =>
        new URL(String(input)).hostname === "open.spotify.com"
          ? tokenResponse("redundant-token")
          : jsonResponse({ items: [] }),
      () => jsonResponse({ items: [] }),
    ]);
    await svc.linkSession("test-cookie");
    const listing = svc.userPlaylists(10).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await svc.topTracks("short_term", 10);
    pending.resolve(jsonResponse({}, 401));

    expect(await listing).toMatchObject({ items: [] });
    expect(await svc.sessionStatus()).toMatchObject({ loggedIn: true });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[6][1]?.headers).toEqual({
      Authorization: "Bearer new-token",
    });
  });
});

describe("分页与歌单格式", () => {
  const rawTrack = {
    id: "abc",
    name: "晴天",
    uri: "spotify:track:abc",
    duration_ms: 269000,
    artists: [{ name: "周杰伦" }],
  };

  it("歌单兼容 track/item 格式，过滤空条目与播客后按原始条目数翻页", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () =>
        jsonResponse({
          items: [
            { track: rawTrack },
            { item: rawTrack },
            { track: null },
            null,
            { item: { ...rawTrack, type: "episode" } },
          ],
          total: 20,
          next: "https://api.spotify.com/v1/playlists/list/tracks?offset=10",
        }),
    ]);
    await svc.linkSession("test-cookie");
    const page = await svc.playlistTracks("list", 5, 5);
    expect(page.items).toHaveLength(2);
    expect(page).toMatchObject({
      offset: 5,
      limit: 5,
      total: 20,
      nextOffset: 10,
    });
    expect(String(fetchMock.mock.calls[2][0])).toContain("limit=5&offset=5");
  });

  it("列表支持 offset，歌单总数兼容新旧字段", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () =>
        jsonResponse({
          items: [
            { id: "a", name: "新格式", items: { total: 8 } },
            { id: "b", name: "旧格式", tracks: { total: 9 } },
          ],
          total: 4,
          next: null,
        }),
    ]);
    await svc.linkSession("test-cookie");
    const page = await svc.userPlaylists(2, 2);
    expect(page.items.map((item) => item.tracksTotal)).toEqual([8, 9]);
    expect(page).toMatchObject({ offset: 2, total: 4, nextOffset: null });
    expect(String(fetchMock.mock.calls[2][0])).toContain("limit=2&offset=2");
  });

  it("完整歌单可跨过第 100 首，迭代到下一页时才发起请求", async () => {
    const fetchMock = stubFetchSequence([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () =>
        jsonResponse({
          items: Array.from({ length: 100 }, (_, i) => ({
            track: { ...rawTrack, id: String(i) },
          })),
          total: 101,
          next: "https://api.spotify.com/v1/playlists/list/tracks?offset=100",
        }),
      () =>
        jsonResponse({
          items: [{ item: { ...rawTrack, id: "100" } }],
          total: 101,
          next: null,
        }),
    ]);
    await svc.linkSession("test-cookie");
    const entries = svc.playlistEntries("list");
    for (let i = 0; i < 100; i++)
      expect((await entries.next()).value?.id).toBe(String(i));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await entries.next()).value?.id).toBe("100");
    expect((await entries.next()).done).toBe(true);
    expect(String(fetchMock.mock.calls[3][0])).toContain("offset=100");
  });
});
