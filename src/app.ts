import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import Fastify from "fastify";
import { env } from "./config/env.js";
import { ensureSchema } from "./db/index.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { chartsRoutes } from "./modules/charts/charts.routes.js";
import { compatRoutes } from "./modules/compat/compat.routes.js";
import { configRoutes } from "./modules/config/config.routes.js";
import { devicesRoutes } from "./modules/devices/devices.routes.js";
import { downloadsRoutes } from "./modules/downloads/downloads.routes.js";
import { libraryRoutes } from "./modules/library/library.routes.js";
import { lyricsRoutes } from "./modules/lyrics/lyrics.routes.js";
import { miPublicRoutes } from "./modules/mi/mi-public.routes.js";
import { miRoutes } from "./modules/mi/mi.routes.js";
import { playbackRoutes } from "./modules/playback/playback.routes.js";
import { playlistsRoutes } from "./modules/playlists/playlists.routes.js";
import { proxyRoutes } from "./modules/proxy/proxy.routes.js";
import { queueRoutes } from "./modules/queue/queue.routes.js";
import { searchRoutes } from "./modules/search/search.routes.js";
import { sourcesRoutes } from "./modules/sources/sources.routes.js";
import { statsRoutes } from "./modules/stats/stats.routes.js";
import { systemRoutes } from "./modules/system/system.routes.js";
import { webRoutes } from "./modules/web/web.routes.js";
import { enforceMinAppVersion } from "./shared/app-version-guard.js";
import { registerErrorHandler } from "./shared/errors.js";

export async function buildApp() {
  ensureSchema();

  const app = Fastify({
    logger: {
      level: env.logLevel,
    },
    // 音频代理链接把整条上游 URL base64 塞进路径参数——QQ 的带 vkey 直链
    // base64 后能到 300+ 字符，远超 Fastify 默认 100 上限。不放宽会 414
    // FST_ERR_MAX_PARAM_LENGTH，浏览器 <audio> 直接拿不到流（点了播放没声音）。
    routerOptions: {
      maxParamLength: 4000,
    },
  });

  await app.register(cors, {
    origin: true,
  });

  await app.register(jwt, {
    secret: env.jwtSecret,
  });

  registerErrorHandler(app);

  // 老 App 请求层门禁（在所有路由之前）：自报版本低于 minSupportedAppVersion
  // 的官方 App 一律 403，强升页要用的公开接口豁免。
  enforceMinAppVersion(app);

  await app.register(miPublicRoutes);
  await app.register(webRoutes);
  await app.register(compatRoutes);
  await app.register(systemRoutes, { prefix: "/api/v1/system" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(configRoutes, { prefix: "/api/v1/config" });
  await app.register(devicesRoutes, { prefix: "/api/v1/devices" });
  await app.register(miRoutes, { prefix: "/api/v1/mi" });
  await app.register(sourcesRoutes, { prefix: "/api/v1/sources" });
  await app.register(searchRoutes, { prefix: "/api/v1/search" });
  await app.register(playbackRoutes, { prefix: "/api/v1/playback" });
  await app.register(proxyRoutes, { prefix: "/api/v1/proxy" });
  await app.register(queueRoutes, { prefix: "/api/v1/queue" });
  await app.register(playlistsRoutes, { prefix: "/api/v1/playlists" });
  await app.register(lyricsRoutes, { prefix: "/api/v1/tracks" });
  await app.register(chartsRoutes, { prefix: "/api/v1/charts" });
  await app.register(statsRoutes, { prefix: "/api/v1/stats" });
  await app.register(downloadsRoutes, { prefix: "/api/v1/downloads" });
  await app.register(libraryRoutes, { prefix: "/api/v1/library" });

  return app;
}
