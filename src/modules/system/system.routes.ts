import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { createTestToneWav, testTonePath } from "../../shared/test-tone.js";

const testToneWav = createTestToneWav();

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/info", async () => ({
    name: "HMusic Server",
    version: "0.1.0",
    apiVersion: "v1",
    mode: "development",
    publicBaseUrl: env.publicBaseUrl,
    capabilities: {
      auth: true,
      config: true,
      miAccount: true,
      devices: true,
      sources: true,
      search: true,
      playback: true,
      queue: true,
      lyrics: true,
      proxy: true,
    },
  }));

  app.get(
    testTonePath.replace("/api/v1/system", ""),
    async (request, reply) => {
      const range = parseRangeHeader(request.headers.range, testToneWav.length);
      if (range === "invalid") {
        return reply
          .code(416)
          .header("content-range", `bytes */${testToneWav.length}`)
          .send();
      }

      const baseReply = reply
        .header("content-type", "audio/wav")
        .header("accept-ranges", "bytes")
        .header("cache-control", "public, max-age=3600");

      if (range) {
        const chunk = testToneWav.subarray(range.start, range.end + 1);
        return baseReply
          .code(206)
          .header(
            "content-range",
            `bytes ${range.start}-${range.end}/${testToneWav.length}`,
          )
          .header("content-length", String(chunk.length))
          .send(chunk);
      }

      return baseReply
        .header("content-length", String(testToneWav.length))
        .send(testToneWav);
    },
  );
}

function parseRangeHeader(
  range: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | undefined {
  if (!range) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return "invalid";

  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return "invalid";

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid";
  }

  return {
    start,
    end: Math.min(end, size - 1),
  };
}
