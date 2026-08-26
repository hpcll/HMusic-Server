import os from "node:os";
import Bonjour from "bonjour-service";
import { env } from "../config/env.js";
import { serverVersion } from "./version.js";

// 局域网自广播：注册 _hmusic._tcp，客户端订阅即可秒级发现本服务（端口随
// SRV 记录下发，不再依赖客户端按默认端口扫段）。发布名带主机名，多台
// Server 并存时可区分。mDNS 故障只记日志不 crash——家庭服务器存活优先，
// 广播挂了客户端还有 HTTP 扫段兜底。
type MdnsLogger = {
  error: (obj: unknown, msg?: string) => void;
};

let bonjour: Bonjour | undefined;

export function startMdnsAdvertiser(log: MdnsLogger): void {
  try {
    bonjour = new Bonjour(undefined, (error: unknown) => {
      log.error({ err: error }, "mDNS 广播出错（已忽略，服务继续运行）");
    });
    bonjour.publish({
      name: `HMusic Server (${os.hostname()})`,
      type: "hmusic",
      port: env.port,
      // 与 GET /system/info 一致的身份元数据；客户端仍以 /system/info 为准。
      txt: { api: "v1", version: serverVersion },
    });
  } catch (error) {
    log.error(
      { err: error },
      "mDNS 广播启动失败（已忽略，可靠客户端扫段发现）",
    );
  }
}

// best-effort 撤播：发 goodbye 包避免服务记录按 TTL 残留；限时 1s 防卡退出。
export async function stopMdnsAdvertiser(): Promise<void> {
  const instance = bonjour;
  bonjour = undefined;
  if (!instance) return;
  await Promise.race([
    new Promise<void>((resolve) => instance.unpublishAll(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1000)),
  ]);
  instance.destroy();
}
