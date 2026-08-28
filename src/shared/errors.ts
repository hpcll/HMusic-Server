import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 500,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    async (
      error: FastifyError | AppError | ZodError,
      _request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          error: {
            code: error.code,
            message: error.message,
            details: error.details ?? {},
          },
        });
      }

      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "请求参数错误",
            details: error.flatten(),
          },
        });
      }

      const statusCode =
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
      return reply.status(statusCode).send({
        error: {
          code:
            authFailureCode(error, statusCode) ??
            (statusCode === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR"),
          message: statusCode === 500 ? "服务器内部错误" : error.message,
          details: {},
        },
      });
    },
  );
}

// 凭据类失败保留 @fastify/jwt 的原始 code（FST_JWT_NO_AUTHORIZATION_IN_HEADER、
// FST_JWT_BAD_REQUEST、FST_JWT_AUTHORIZATION_TOKEN_EXPIRED…）。
// 反向代理到公网时全靠它区分「代理把 Authorization 头删了/改写了」和「凭据本身过期」：
// 一律压成 UNAUTHORIZED 的话，前端只能报「登录已失效」，用户和我们都无从下手。
function authFailureCode(
  error: object,
  statusCode: number,
): string | undefined {
  if (!("code" in error) || typeof error.code !== "string" || !error.code) {
    return undefined;
  }
  if (statusCode === 401 || error.code.startsWith("FST_JWT_"))
    return error.code;
  return undefined;
}
