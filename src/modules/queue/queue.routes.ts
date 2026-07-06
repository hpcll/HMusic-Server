import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { trackFromClientSong } from "../../shared/client-track.js";
import { AppError } from "../../shared/errors.js";
import {
  clientTrackSchema,
  playModeSchema,
  trackSchema,
} from "../../shared/schemas.js";
import {
  addQueueTrack,
  clearQueue,
  getQueue,
  replaceQueue,
  setCurrentQueueIndex,
  setQueuePlayMode,
} from "./queue.service.js";

const replaceQueueSchema = z
  .object({
    tracks: z.array(trackSchema).optional(),
    clientTracks: z.array(clientTrackSchema).optional(),
    currentIndex: z.number().int().nonnegative().optional(),
    playMode: playModeSchema.optional(),
  })
  .strict();

const addQueueItemSchema = z
  .object({
    track: trackSchema.optional(),
    clientTrack: clientTrackSchema.optional(),
  })
  .strict();

const currentIndexSchema = z
  .object({
    index: z.number().int().nonnegative(),
  })
  .strict();

const modeSchema = z
  .object({
    playMode: playModeSchema,
  })
  .strict();

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => getQueue());
  app.put("/", async (request) => {
    const body = replaceQueueSchema.parse(request.body);
    return replaceQueue({
      tracks: getInputTracks(body),
      currentIndex: body.currentIndex,
      playMode: body.playMode,
    });
  });
  app.post("/items", async (request) => {
    const body = addQueueItemSchema.parse(request.body);
    return addQueueTrack(getInputTrack(body));
  });
  app.post("/current", async (request) => {
    const body = currentIndexSchema.parse(request.body);
    return setCurrentQueueIndex(body.index);
  });
  app.post("/mode", async (request) => {
    const body = modeSchema.parse(request.body);
    return setQueuePlayMode(body.playMode);
  });
  app.post("/clear", async () => clearQueue());
}

function getInputTracks(body: z.infer<typeof replaceQueueSchema>) {
  if (body.tracks) return body.tracks;
  if (body.clientTracks) return body.clientTracks.map(trackFromClientSong);
  throw new AppError(
    "QUEUE_TRACKS_MISSING",
    "请求必须包含 tracks 或 clientTracks",
    400,
  );
}

function getInputTrack(body: z.infer<typeof addQueueItemSchema>) {
  if (body.track) return body.track;
  if (body.clientTrack) return trackFromClientSong(body.clientTrack);
  throw new AppError(
    "QUEUE_TRACK_MISSING",
    "请求必须包含 track 或 clientTrack",
    400,
  );
}
