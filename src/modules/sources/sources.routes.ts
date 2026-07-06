import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import {
  deleteLxPlugin,
  getLxPluginCode,
  listLxPlugins,
  listSources,
  saveLxPlugin,
  testSource,
} from "./sources.service.js";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const saveLxPluginSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(128),
    code: z.string().min(1),
    enabled: z.boolean().optional(),
    defaultQuality: z.enum(["128k", "320k", "flac", "hires"]).optional(),
  })
  .strict();

export async function sourcesRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => ({
    sources: await listSources(),
  }));

  app.get("/lx-plugins", async () => listLxPlugins());

  app.post("/lx-plugins", async (request) => {
    const body = saveLxPluginSchema.parse(request.body);
    return saveLxPlugin(body);
  });

  app.get("/lx-plugins/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return getLxPluginCode(params.id);
  });

  app.delete("/lx-plugins/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return deleteLxPlugin(params.id);
  });

  app.post("/:id/test", async (request) => {
    const params = paramsSchema.parse(request.params);
    return testSource(params.id);
  });
}
