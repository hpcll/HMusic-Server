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
