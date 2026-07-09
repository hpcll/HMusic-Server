import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../shared/auth.js";
import { getListeningStats } from "./stats.service.js";

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => {
    return { stats: getListeningStats() };
  });
}
