import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { isNewerVersion, minAppVersion } from "./version.js";

// 客户端版本门禁：App 每个请求自报 X-HMusic-App-Version，低于本服务端要求的
// minAppVersion() 时 403，业务数据一概不发。
//
// 定位——这是给「部署者」的运维开关，不是平台对用户的管控：HMusic 是自部署架构，
// 服务端归用户自己，门槛值（源码默认值 / HMUSIC_MIN_APP_VERSION）随时能被他改回去。
// 真实用途：① 某个 App 版本有会写坏数据的 bug，一键挡住；② 一台服务端接多个客户端
// （家人手机 / 音箱）时统一最低版本；③ 服务端做了不兼容 API 改动，老客户端连上只会
// 报错，不如挡掉并给明确提示。对第三方客户端是硬约束，对掌握服务端的人是配置项，
// 这是自部署的正确特性，不必也无法「防住」部署者本人。
//
// 与 /system/info 下发 minAppVersion 的分工：那条由 App 自觉进强升页（能覆盖尚未
// 发请求的冷启动场景），这条在请求层兜底（App 侧判定被跳过时仍会被拒），互补而非替代。
//
// 缺头一律放行：web 端、小爱音箱拉流、xiaomusic 兼容层客户端、curl 诊断都不带这个头，
// 拦它们只会误伤。因此门禁的作用对象是「自报了版本的官方 App」。
const versionHeader = "x-hmusic-app-version";

// 豁免路径：强升页自己要用的公开接口。不豁免会死锁——App 被 403 后连
// 「要求哪个版本」「去哪下载」都拉不到，只能看到一片报错。
const exemptPaths = new Set<string>([
  "/api/v1/system/info",
  "/api/v1/system/app-config",
]);

function isExempt(url: string): boolean {
  const path = url.split("?")[0];
  if (exemptPaths.has(path)) return true;
  // 测试音是诊断入口，保持任何版本可达。
  return path.startsWith("/api/v1/system/test-tone");
}

export function enforceMinAppVersion(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    // 不强制时零成本短路（绝大多数发布形态都停在这一行）。
    const required = minAppVersion();
    if (required === "0.0.0") return;

    const raw = request.headers[versionHeader];
    const reported = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!reported) return;
    if (isExempt(request.url)) return;
    if (!isNewerVersion(required, reported)) return;

    throw new AppError(
      "APP_VERSION_TOO_OLD",
      `当前 App 版本 v${reported} 已不被这台服务端支持，请升级到 v${required} 或更新版本`,
      403,
      { minAppVersion: required, reported },
    );
  });
}
