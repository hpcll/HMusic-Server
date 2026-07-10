import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import {
  decodeAudioProxyToken,
  verifyLocalAudioToken,
} from "./audio-proxy.service.js";
import { getDownloadFile } from "../downloads/downloads.service.js";

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

  // 本地已下载音频：直接流本地文件，支持 Range（<audio> 拖进度、音箱断点续拉都靠它）。
  app.get("/local/:token", async (request, reply) => {
    const { token } = tokenParamsSchema.parse(request.params);
    const id = verifyLocalAudioToken(token);
    const file = getDownloadFile(id);
    const stat = await fs.stat(file.absPath);

    reply.header("accept-ranges", "bytes");
    reply.header("content-type", file.mime);
    reply.header("cache-control", "no-cache");

    const range = request.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      let start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      let end = match?.[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1;
      if (start >= stat.size || start > end) {
        reply.code(416).header("content-range", `bytes */${stat.size}`);
        return reply.send();
      }
      reply.code(206);
      reply.header("content-range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("content-length", end - start + 1);
      return reply.send(createReadStream(file.absPath, { start, end }));
    }

    reply.header("content-length", stat.size);
    return reply.send(createReadStream(file.absPath));
  });
}
