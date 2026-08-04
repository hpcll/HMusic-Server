import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startLibraryScan } from "./modules/library/library.service.js";
import {
  startPlaybackWatchdog,
  stopPlaybackWatchdog,
} from "./modules/playback/playback.service.js";
import {
  startMdnsAdvertiser,
  stopMdnsAdvertiser,
} from "./shared/mdns-advertiser.js";

const app = await buildApp();

// 进程级兜底：LX 插件是第三方脚本，其后台请求（如订阅源 checkUpdate）超时产生的
// 未处理 rejection 会按 Node 默认行为击穿整个进程——家庭音乐服务器的存活优先，
// 这类错误记日志继续跑，不允许一次网络抖动杀死全部服务。
process.on("unhandledRejection", (reason) => {
  app.log.error(
    { err: reason },
    "未处理的 Promise rejection（已拦截，进程继续运行）",
  );
});
process.on("uncaughtException", (error) => {
  app.log.error({ err: error }, "未捕获异常（已拦截，进程继续运行）");
});

try {
  await app.listen({
    host: env.host,
    port: env.port,
  });
  startMdnsAdvertiser(app.log);
  // C-12：远端播放期间服务端自查设备状态，客户端退后台后自然播完仍能连播。
  startPlaybackWatchdog();
  // 启动即增量扫一轮曲库：收编 music 目录孤儿与存量目录新文件（后台执行）。
  startLibraryScan();
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// 退出前 best-effort 撤播（tsx watch 重启发的 SIGTERM 也走这里），
// 避免客户端在服务已停后仍收到残留的 mDNS 记录。
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopPlaybackWatchdog();
    void stopMdnsAdvertiser().finally(() => process.exit(0));
  });
}
