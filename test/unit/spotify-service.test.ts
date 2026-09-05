import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// env 是模块级单例（导入即读 process.env），必须先设好临时数据目录再动态
// 导入被测模块——与 update-service 等单测同一手法。
let dataDir: string;
let svc: typeof import("../../src/modules/spotify/spotify.service.js");

const CIPHER = [11, 22, 33, 44, 55, 66, 77, 88, 99, 12];

// 期望值由独立 Python 实现按同一算法预计算（XOR 变换 → ASCII hex 字节为
// HMAC-SHA1 密钥 → counter=unix/30 → dynamic truncation 6 位），跨语言对拍。
const TOTP_VECTOR = "307992";
const TOTP_TIME_MS = 1735689600 * 1000; // 2025-01-01T00:00:00Z

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-spotify-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  svc = await import("../../src/modules/spotify/spotify.service.js");
  await import("../../src/db/index.js").then((m) => m.ensureSchema());
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(async () => {
  // clearSession 同时清 token/secrets 模块级缓存——密钥库缓存若跨测试残留，
  // 下一个测试的 fetch 应答序号会错位（401 测试拉过密钥库后尤其如此）。
  await svc.clearSession();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 按调用顺序应答：第 1 发密钥库、第 2 发 token、其后 Spotify API。
function stubFetchSequence(responses: Array<() => Response>): void {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const respond = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve(respond());
    }) as unknown as typeof fetch,
  );
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
              track: {
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
            },
            { track: { id: null, name: "无 id 脏数据" } },
          ],
        }),
    ]);
    await svc.linkSession("sp_dc=测试值");
    const tracks = await svc.topTracks("short_term", 10);
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
