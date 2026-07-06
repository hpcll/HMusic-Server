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
          code: statusCode === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
          message: statusCode === 500 ? "服务器内部错误" : error.message,
          details: {},
        },
      });
    },
  );
}
