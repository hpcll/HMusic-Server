import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      username: string;
    };
    user: {
      sub: string;
      username: string;
    };
  }
}
