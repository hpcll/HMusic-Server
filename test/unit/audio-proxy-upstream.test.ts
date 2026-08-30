import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 音频代理转给上游的请求头契约。回归的是「网页端能播、App 点了就失败」：
// 客户端 UA 一旦透传，播放器的 ExoPlayer/AVPlayer UA 会被第三方音源 CDN 拒掉。
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-proxy-ua-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "proxy-ua-test-secret";
  process.env.HMUSIC_PUBLIC_BASE_URL = "http://127.0.0.1:8090";
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("audio proxy upstream request", () => {
  it("sends a browser user agent instead of the player's", async () => {
    const { buildApp } = await import("../../src/app.js");
    const { createAudioProxyUrl } = await import(
      "../../src/modules/proxy/audio-proxy.service.js"
    );
    const app = await buildApp();

    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        seen.push({ ...((init?.headers ?? {}) as Record<string, string>) });
        return new Response("audio-bytes", {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }) as unknown as typeof fetch,
    );

    const proxyUrl = new URL(
      createAudioProxyUrl("https://cdn.example.com/song.mp3"),
    );
    const response = await app.inject({
      method: "GET",
      url: proxyUrl.pathname,
      headers: {
        // just_audio 在 Android 上就是这类 UA。
        "user-agent": "ExoPlayer/2.19.1 (Linux; Android 14) HMusic",
        range: "bytes=0-",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["User-Agent"]).toContain("Mozilla/5.0");
    expect(seen[0]?.["User-Agent"]).not.toContain("ExoPlayer");
    // Range 仍要原样带过去：拖进度和断点续拉靠它。
    expect(seen[0]?.Range).toBe("bytes=0-");

    await app.close();
  });
});
