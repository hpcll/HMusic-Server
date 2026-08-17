import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "./errors.js";
import { isNewerVersion, minAppVersion } from "./version.js";

// 老 App 请求层门禁：官方 App 每个请求自报 X-HMusic-App-Version，低于本服务端
// 的 minSupportedAppVersion 一律 403，业务数据一点拿不到。
//
// 与 /system/info 里下发 minAppVersion 的区别：那条靠 App 自觉进强升页（改客户端
// 即可绕过），这条由服务端拒绝服务，改客户端 UI 没用。
//
// 缺头一律放行：web 端、小爱音箱拉流、xiaomusic 兼容层客户端、curl 诊断都不带
// 这个头。因此本门禁拦的是「装了官方老版本 App」的用户——正是需要拦的人；
// 自行编译删掉版本头的人属于另一类对抗，客户端侧检查同样拦不住，不在射程内。
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
