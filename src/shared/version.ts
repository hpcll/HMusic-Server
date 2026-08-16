import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 从模块位置向上找 package.json 读版本号：dev（src/ 下 tsx 直跑）与
// dist/ 构建产物的目录深度不同，逐级向上探测比写死相对路径可靠。
function resolveVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "hmusic-server" && parsed.version) {
          return parsed.version;
        }
      } catch {
        // 读坏了继续向上找。
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

export const serverVersion = resolveVersion();

// 本服务端要求的最低 App 版本：随 /system/info 下发，老 App 连上后自行进
// 全屏「必须升级」页。仅在发布不兼容旧 App 的大改动时抬高（如 API v2）；
// 平时保持 0.0.0 即「不强制」。
export const minSupportedAppVersion = "0.0.0";
