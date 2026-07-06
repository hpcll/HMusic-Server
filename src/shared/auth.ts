import type { FastifyInstance, FastifyRequest } from "fastify";

export function requireAuth(app: FastifyInstance): void {
  app.addHook("preHandler", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });
}
