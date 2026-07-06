import { pino } from "pino";
import { env } from "../config/env.js";

// 供 service 层（拿不到 Fastify 实例的地方）直接使用的共享日志器，
// 复用与 Fastify logger 相同的日志级别，保持输出一致。
export const logger = pino({
  level: env.logLevel,
});

export function moduleLogger(module: string) {
  return logger.child({ module });
}
