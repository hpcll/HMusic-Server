import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import { decodeAudioProxyToken } from "./audio-proxy.service.js";

const tokenParamsSchema = z.object({
  token: z.string().min(1),
});

const forwardedHeaders = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

export async function proxyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/audio/:token", async (request, reply) => {
    const { token } = tokenParamsSchema.parse(request.params);
    const targetUrl = decodeAudioProxyToken(token);
    const response = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          request.headers["user-agent"] ||
          "Mozilla/5.0 HMusic-Server-Audio-Proxy",
        ...(request.headers.range ? { Range: request.headers.range } : {}),
      },
    });

    if (!response.body) {
      throw new AppError(
        "AUDIO_PROXY_EMPTY_RESPONSE",
        "上游音频响应为空",
        502,
        { statusCode: response.status },
      );
    }

    reply.code(response.status);
    for (const header of forwardedHeaders) {
      const value = response.headers.get(header);
      if (value) reply.header(header, value);
    }

    return reply.send(Readable.fromWeb(response.body));
  });
}
