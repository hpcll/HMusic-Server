import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// env 是模块级单例（导入即读 process.env），先设临时数据目录再动态导入 app。
let dataDir: string;
let buildApp: typeof import("../../src/app.js").buildApp;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-guard-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "guard-test-secret";
  ({ buildApp } = await import("../../src/app.js"));
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.HMUSIC_MIN_APP_VERSION;
});

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = await buildApp();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const oldApp = { "x-hmusic-app-version": "0.1.0" };

describe("app version guard", () => {
  it("不强制（默认 0.0.0）时老版本照常通行", async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
        headers: oldApp,
      });
      // 未登录仍是 401，说明没被版本门拦掉（403）。
      expect(response.statusCode).toBe(401);
    });
  });

  it("抬高门槛后老 App 自报版本一律 403，且 401 之前就拦住", async () => {
    process.env.HMUSIC_MIN_APP_VERSION = "9.0.0";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
        headers: oldApp,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("APP_VERSION_TOO_OLD");
      expect(response.json().error.details.minAppVersion).toBe("9.0.0");
    });
  });

  it("达标版本放行（继续走原有鉴权）", async () => {
    process.env.HMUSIC_MIN_APP_VERSION = "9.0.0";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
        headers: { "x-hmusic-app-version": "9.0.1" },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it("强升页要用的公开接口豁免，否则老 App 拿不到升级信息会死锁", async () => {
    process.env.HMUSIC_MIN_APP_VERSION = "9.0.0";
    await withApp(async (app) => {
      const info = await app.inject({
        method: "GET",
        url: "/api/v1/system/info",
        headers: oldApp,
      });
      expect(info.statusCode).toBe(200);
      expect(info.json().minAppVersion).toBe("9.0.0");

      const testTone = await app.inject({
        method: "GET",
        url: "/api/v1/system/test-tone.wav",
        headers: oldApp,
      });
      expect(testTone.statusCode).toBe(200);
    });
  });

  it("不带版本头的客户端放行：web 端/音箱拉流/兼容层不受影响", async () => {
    process.env.HMUSIC_MIN_APP_VERSION = "9.0.0";
    await withApp(async (app) => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
      });
      expect(response.statusCode).toBe(401);

      const compat = await app.inject({ method: "GET", url: "/getversion" });
      expect(compat.statusCode).toBe(401); // 兼容层自己的 Basic 鉴权，不是 403
    });
  });
});
