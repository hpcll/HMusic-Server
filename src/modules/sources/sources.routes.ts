import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import {
  deleteLxPlugin,
  fetchRemoteLxScript,
  getLxPluginCode,
  listLxPlugins,
  listSources,
  saveLxPlugin,
  testSource,
  updateLxPluginFromSource,
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
    sourceUrl: z.string().url().max(2048).optional(),
  })
  .strict();

const fetchLxScriptSchema = z
  .object({
    url: z.string().min(1).max(2048),
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

  // 订阅链接：服务端代拉远程脚本（绕开浏览器跨域），返回代码 + 头注释元信息。
  app.post("/lx-plugins/fetch", async (request) => {
    const body = fetchLxScriptSchema.parse(request.body);
    return fetchRemoteLxScript(body.url);
  });

  // 按插件保存时记住的订阅链接一键更新。
  app.post("/lx-plugins/:id/update", async (request) => {
    const params = paramsSchema.parse(request.params);
    return updateLxPluginFromSource(params.id);
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
