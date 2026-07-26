import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-mi-expiry-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "integration-test-secret";
  process.env.HMUSIC_PUBLIC_BASE_URL = "http://127.0.0.1:8090";
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// 小米会话过期链路：401 确证 → isLoggedIn 翻转 + sessionExpired 上报；
// 非 401 不动状态；过期后取会话给可行动错误；退出登录清过期标记。
describe("mi session expiry", () => {
  it("flips status on confirmed 401 and clears on logout", async () => {
    const { ensureSchema, db } = await import("../../src/db/index.js");
    ensureSchema();
    const { miAccounts } = await import("../../src/db/schema.js");
    const { AppError } = await import("../../src/shared/errors.js");
    const mi = await import("../../src/modules/mi/mi.service.js");

    await db.insert(miAccounts).values({
      id: "default",
      accountMasked: "138****00",
      serviceTokenEnc: "enc-token",
      userIdEnc: "enc-user",
      deviceId: "AABBCC",
      isLoggedIn: 1,
      updatedAt: Date.now(),
    });

    // 非 401（设备离线等）不得翻登录位。
    await mi.markMiSessionExpiredIfUnauthorized(
      new AppError("MI_UBUS_REQUEST_FAILED", "offline", 502, {
        statusCode: 502,
      }),
    );
    let status = await mi.getMiStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.sessionExpired).toBe(false);

    // 无关错误类型同样不动状态。
    await mi.markMiSessionExpiredIfUnauthorized(new Error("network"));
    expect((await mi.getMiStatus()).loggedIn).toBe(true);

    // ubus 401 → 过期：loggedIn=false + sessionExpired=true，掩码保留给 UI。
    await mi.markMiSessionExpiredIfUnauthorized(
      new AppError("MI_UBUS_REQUEST_FAILED", "unauthorized", 502, {
        statusCode: 401,
      }),
    );
    status = await mi.getMiStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.sessionExpired).toBe(true);
    expect(status.accountMasked).toBe("138****00");

    // 过期后取会话必须给「已过期」而不是「尚未登录」。
    await expect(mi.getStoredMiSession()).rejects.toMatchObject({
      code: "MI_SESSION_EXPIRED",
    });

    // 设备列表 401 同样计入确证来源。
    await db
      .update(miAccounts)
      .set({ isLoggedIn: 1, sessionExpiredAt: null, updatedAt: Date.now() });
    await mi.markMiSessionExpiredIfUnauthorized(
      new AppError("MI_DEVICE_LIST_FAILED", "unauthorized", 502, {
        statusCode: 401,
      }),
    );
    expect((await mi.getMiStatus()).sessionExpired).toBe(true);

    // 主动退出不是过期：标记清空，状态回「未登录」。
    await mi.logoutMiAccount();
    status = await mi.getMiStatus();
    expect(status.loggedIn).toBe(false);
    expect(status.sessionExpired).toBe(false);
  });
});
