import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { getRuntimeConfig, saveRuntimeConfig } from "./config.service.js";

const configPatchSchema = z
  .object({
    serverName: z.string().min(1).max(64).optional(),
    defaultQuality: z.enum(["128k", "320k", "flac", "hires"]).optional(),
    searchStrategy: z.enum(["qqFirst", "kuwoFirst", "neteaseFirst"]).optional(),
    resolveStrategy: z
      .enum(["originalFirst", "qqFirst", "kuwoFirst", "neteaseFirst"])
      .optional(),
    manualTracks: z
      .array(
        z
          .object({
            id: z.string().optional(),
            title: z.string().min(1),
            artist: z.string().optional(),
            album: z.string().optional(),
            durationMs: z.number().int().nonnegative().optional(),
            coverUrl: z.string().url().optional(),
            url: z.string().url(),
          })
          .strict(),
      )
      .optional(),
    lxPlugins: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            path: z.string().min(1),
            enabled: z.boolean().optional(),
            defaultQuality: z
              .enum(["128k", "320k", "flac", "hires"])
              .optional(),
            // RuntimeConfig.lxPlugins 携带订阅链接（GET /config 会返回），
            // strict 模式下漏声明会导致"读出来的配置原样 PATCH 回去"被 400 拒收
            // ——与 playSchema 漏 queueIndex 同型的契约断裂。
            sourceUrl: z.string().url().max(2048).optional(),
          })
          .strict(),
      )
      .optional(),
    extraPlayMusicModels: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(16)
          .regex(/^[A-Za-z0-9]+$/, "型号只能包含字母和数字")
          .transform((value) => value.toUpperCase()),
      )
      .optional(),
    announceTracks: z.boolean().optional(),
    // 存量音乐目录：必须是绝对路径（扫描器按绝对路径遍历），拒相对路径与
    // 空段，避免把整个文件系统根目录当曲库扫。
    libraryDirs: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .refine((value) => path.isAbsolute(value), "音乐目录必须是绝对路径"),
      )
      .max(16)
      .optional(),
    libraryScanIntervalMinutes: z.number().int().min(0).max(10080).optional(),
  })
  .strict();

export async function configRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => getRuntimeConfig());

  app.patch("/", async (request) => {
    const body = configPatchSchema.parse(request.body);
    return saveRuntimeConfig(body);
  });
}
