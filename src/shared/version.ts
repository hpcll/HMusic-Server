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
