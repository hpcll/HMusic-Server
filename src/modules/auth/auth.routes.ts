import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasAdminUser, setupAdmin, verifyLogin } from "./auth.service.js";

const credentialsSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(256),
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
}
