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
import { getLibraryFile } from "../library/library.service.js";

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
    // 上游握手必须限时：node fetch 无默认超时，坏直链黑洞会让 <audio>/AVPlayer
    // 无错误地永远卡在加载（客户端表现为 0:00 死住）。不能用 AbortSignal.timeout
    // ——它在正文流式转发阶段仍会触发，整首歌会在限时点被掐断；拿到响应头
    // 就清掉定时器，正文转发不限时。
    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetch(targetUrl, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            request.headers["user-agent"] ||
            "Mozilla/5.0 HMusic-Server-Audio-Proxy",
          ...(request.headers.range ? { Range: request.headers.range } : {}),
        },
      });
    } catch (error) {
      throw new AppError("AUDIO_PROXY_UPSTREAM_FAILED", "上游音频拉取失败", 502, {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(headerTimer);
    }

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

  // 本地音频/封面：直接流本地文件，支持 Range（<audio> 拖进度、音箱断点续拉都靠它）。
  // token 兼容三种身份：曲库 trackKey / 曲库条目 id / 下载记录 id（历史链接）。
  app.get("/local/:token", async (request, reply) => {
    const { token } = tokenParamsSchema.parse(request.params);
    const id = verifyLocalAudioToken(token);
    const file = getLibraryFile(id) ?? getDownloadFile(id);
    // 签名有效但条目已删（歌单快照指向手删后的本地文件等）：404 而非空引用 500。
    if (!file) {
      throw new AppError("LOCAL_FILE_NOT_FOUND", "本地文件不存在或已删除", 404, { id });
    }
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
