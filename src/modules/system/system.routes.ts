import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../shared/auth.js";
import { resolvePublicBaseUrl } from "../../shared/public-base-url.js";
import { createTestToneWav, testTonePath } from "../../shared/test-tone.js";
import { serverVersion, minSupportedAppVersion } from "../../shared/version.js";
import {
  checkForUpdate,
  clearUpdateLockOnBoot,
  readUpdateLog,
  relayAppConfig,
  triggerSelfUpdate,
} from "./update.service.js";

const testToneWav = createTestToneWav();

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  clearUpdateLockOnBoot();

  app.get("/info", async () => ({
    name: "HMusic Server",
    version: serverVersion,
    apiVersion: "v1",
    // 老 App 准入门槛（0.0.0 = 不强制）；App 端低于此版本进全屏升级页。
    minAppVersion: minSupportedAppVersion,
    mode: "development",
    // 返回实时生效值（回环/失效 IPv4 已替换），设置页看到的即音箱实际拿到的。
    publicBaseUrl: resolvePublicBaseUrl(),
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

  // App 远程配置中转（公开：强升门在登录前就要判）。NAS 网络通常比手机
  // 直连 GitHub 稳，App 优先走这里，拿不到再退自身直连镜像。
  app.get("/app-config", async () => relayAppConfig());

  // 升级三件套走独立鉴权子域：/info 与测试音保持公开（发现/探测要用），
  // 升级检查与触发只许登录用户。
  await app.register(async (scoped) => {
    requireAuth(scoped);
    scoped.get("/update", async () => checkForUpdate());
    scoped.post("/update", async () => triggerSelfUpdate());
    scoped.get("/update/log", async () => readUpdateLog());
  });

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
