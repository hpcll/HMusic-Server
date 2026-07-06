import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changePassword,
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
    } catch {
      return {
        initialized,
        authenticated: false,
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
}
