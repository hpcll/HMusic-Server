import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 账户删除（App Store 合规）：物理清除全部数据，服务端回未初始化态。
// 独立临时 DB，避免破坏 api-contract 主测试。
let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-delacct-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "delacct-test-secret";
  process.env.HMUSIC_PUBLIC_BASE_URL = "http://127.0.0.1:8090";
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("account deletion", () => {
  it("校验密码后物理清除全部数据，服务端回未初始化态", async () => {
    const { buildApp } = await import("../../src/app.js");
    const app = await buildApp();

    try {
      // 初始化管理员并建一条数据（歌单），确认删除会连带清除。
      const setup = await app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        payload: { username: "admin", password: "supersecret" },
      });
      expect(setup.statusCode).toBe(200);
      const token = setup.json().accessToken as string;
      const headers = { authorization: `Bearer ${token}` };

      await app.inject({
        method: "POST",
        url: "/api/v1/playlists",
        headers,
        payload: { name: "我的歌单" },
      });

      // 密码错误：拒绝删除，数据不动。
      const wrong = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers,
        payload: { password: "wrongpass" },
      });
      expect(wrong.statusCode).toBe(401);

      const stillInit = await app.inject({
        method: "GET",
        url: "/api/v1/auth/status",
      });
      expect(stillInit.json().initialized).toBe(true);

      // 正确密码：删除成功。
      const del = await app.inject({
        method: "DELETE",
        url: "/api/v1/auth/account",
        headers,
        payload: { password: "supersecret" },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toBe(true);

      // 回未初始化态：/auth/status initialized=false，可重新 setup。
      const afterStatus = await app.inject({
        method: "GET",
        url: "/api/v1/auth/status",
      });
      expect(afterStatus.json().initialized).toBe(false);
      expect(afterStatus.json().authenticated).toBe(false);

      // 旧 token 已无对应用户：受保护接口读不到旧歌单（数据已清）。
      const resetup = await app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        payload: { username: "admin2", password: "anothersecret" },
      });
      expect(resetup.statusCode).toBe(200);
      const newHeaders = {
        authorization: `Bearer ${resetup.json().accessToken as string}`,
      };
      const playlists = await app.inject({
        method: "GET",
        url: "/api/v1/playlists",
        headers: newHeaders,
      });
      expect(playlists.statusCode).toBe(200);
      expect(playlists.json().playlists).toEqual([]);
    } finally {
      await app.close();
    }
  });
});