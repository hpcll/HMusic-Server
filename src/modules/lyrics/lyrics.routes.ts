import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { trackFromClientSong } from "../../shared/client-track.js";
import { AppError } from "../../shared/errors.js";
import { clientTrackSchema, trackSchema } from "../../shared/schemas.js";
import { getLyricByTrack, getLyricByTrackId } from "./lyrics.service.js";
import { resolveTrack } from "../search/search.service.js";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const resolveSchema = z
  .object({
    track: trackSchema.optional(),
    clientTrack: clientTrackSchema.optional(),
    quality: z.string().min(1).optional(),
  })
  .strict();

export async function lyricsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.post("/resolve", async (request) => {
    const body = resolveSchema.parse(request.body);
    return resolveTrack({
      track: getInputTrack(body),
      quality: body.quality,
    });
  });

  app.post("/lyrics", async (request) => {
    const body = resolveSchema.parse(request.body);
    return getLyricByTrack(getInputTrack(body));
  });

  app.get("/:id/lyrics", async (request) => {
    const params = paramsSchema.parse(request.params);
    return getLyricByTrackId(params.id);
  });
}

function getInputTrack(body: z.infer<typeof resolveSchema>) {
  if (body.track) return body.track;
  if (body.clientTrack) return trackFromClientSong(body.clientTrack);
  throw new AppError(
    "TRACK_INPUT_MISSING",
    "请求必须包含 track 或 clientTrack",
    400,
  );
}
