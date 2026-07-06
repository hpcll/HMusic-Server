import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// 前端 SPA 目录：源码在仓库根 web/，编译产物 dist/ 不含它，
// 因此按「相对本文件」与「相对 cwd」两种方式定位，兼顾 dev(tsx) 与 prod(node dist)。
const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.resolve(here, "../../../web"), // dist/modules/web -> 仓库根/web
  path.resolve(here, "../../web"), // src/modules/web -> 仓库根/web
  path.resolve(process.cwd(), "web"),
];

export async function webRoutes(app: FastifyInstance): Promise<void> {
  const root =
    candidates.find((dir) => existsSync(path.join(dir, "index.html"))) ??
    candidates[candidates.length - 1];

  // 前端用哈希路由，浏览器只请求 /app/ 与其下真实静态文件，无需 SPA 回退。
  await app.register(fastifyStatic, {
    root,
    prefix: "/app/",
    index: ["index.html"],
    decorateReply: false,
  });

  app.get("/app", async (_request, reply) => reply.redirect("/app/"));
}
