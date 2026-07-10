import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { trackFromClientSong } from "../../shared/client-track.js";
import { AppError } from "../../shared/errors.js";
import { clientTrackSchema, trackSchema } from "../../shared/schemas.js";
import {
  deleteDownload,
  listDownloads,
  startDownload,
} from "./downloads.service.js";

const startDownloadSchema = z
  .object({
    track: trackSchema.optional(),
    clientTrack: clientTrackSchema.optional(),
    quality: z.string().min(1).optional(),
  })
  .strict();

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function downloadsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => ({ downloads: listDownloads() }));

  app.post("/", async (request) => {
    const body = startDownloadSchema.parse(request.body);
    const track =
      body.track ??
      (body.clientTrack ? trackFromClientSong(body.clientTrack) : undefined);
    if (!track) {
      throw new AppError(
        "DOWNLOAD_TRACK_MISSING",
        "请求必须包含 track 或 clientTrack",
        400,
      );
    }
    return { download: await startDownload(track, body.quality) };
  });

  app.delete("/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return deleteDownload(params.id);
  });
}
