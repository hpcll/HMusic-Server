import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { resetPlaybackStateForAccountDeletion } from "../playback/playback.service.js";
import { resetQueueForAccountDeletion } from "../queue/queue.service.js";
import {
  changePassword,
  deleteAccount,
  hasAdminUser,
  setupAdmin,
  verifyLogin,
} from "./auth.service.js";

const credentialsSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(8).max(256),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(256),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/status", async (request) => {
    const initialized = await hasAdminUser();

    try {
      await request.jwtVerify();
      const payload = request.user as { sub?: string; username?: string };
      return {
        initialized,
        authenticated: true,
        user: {
          id: payload.sub,
          username: payload.username,
        },
      };
    } catch (error) {
      // authError 是反代排查的抓手：带了凭据却验不过时如实回报原因
      //（FST_JWT_NO_AUTHORIZATION_IN_HEADER = 代理把 Authorization 头弄丢了，
      // FST_JWT_BAD_REQUEST = 头被改成了非 Bearer 格式）。只回 authenticated:false
      // 的话，用户看到的是「登录成功后又被弹回登录页」，无从判断问题在哪。
      return {
        initialized,
        authenticated: false,
        authError:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "UNAUTHORIZED",
      };
    }
  });

  app.post("/setup", async (request) => {
    const body = credentialsSchema.parse(request.body);
    const user = await setupAdmin(body.username, body.password);
    const accessToken = app.jwt.sign({ sub: user.id, username: user.username });
    return { user, accessToken };
  });

  app.post("/login", async (request) => {
    const body = credentialsSchema.parse(request.body);
    const user = await verifyLogin(body.username, body.password);
    const accessToken = app.jwt.sign({ sub: user.id, username: user.username });
    return { user, accessToken };
  });

  app.post("/password", async (request) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string };
    const body = changePasswordSchema.parse(request.body);
    const user = await changePassword(
      payload.sub,
      body.currentPassword,
      body.newPassword,
    );
    // 改完签发新 token，前端无需重新登录。
    const accessToken = app.jwt.sign({ sub: user.id, username: user.username });
    return { user, accessToken };
  });

  // 账户删除（App Store 合规）：校验密码后物理清除全部数据，服务端回到未初始化态。
  // 先清库/文件，再重置内存播放/队列态（顺序无关：删完库后内存态也无处落盘）。
  app.delete("/account", async (request) => {
    await request.jwtVerify();
    const payload = request.user as { sub: string };
    const body = deleteAccountSchema.parse(request.body ?? {});
    await deleteAccount(payload.sub, body.password);
    resetPlaybackStateForAccountDeletion();
    resetQueueForAccountDeletion();
    return { deleted: true };
  });
}
