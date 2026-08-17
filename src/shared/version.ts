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

// 本服务端要求的最低 App 版本：随 /system/info 下发（老 App 自行进全屏
// 「必须升级」页），并由 app-version-guard 在请求层强制（改掉客户端自觉判定
// 也拿不到业务数据）。发布不兼容旧 App 的大改动时抬高这里（如 API v2）；
// 平时保持 0.0.0 即「不强制」。也可用 HMUSIC_MIN_APP_VERSION 环境变量临时覆盖
//（不改代码就能救急，例如某个 App 版本被发现会写坏数据）。
const minSupportedAppVersionDefault = "0.0.0";

export function minAppVersion(): string {
  const override = (process.env.HMUSIC_MIN_APP_VERSION ?? "").trim();
  return override || minSupportedAppVersionDefault;
}

// 数字段逐段比较（v 前缀无视），段数不齐补 0；非数字段按 0 处理
//（本项目版本号是纯 x.y.z，预发布后缀不参与排序）。App 端同一口径。
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string) =>
    value
      .replace(/^v/i, "")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
