import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { trackFromClientSong } from "../../shared/client-track.js";
import {
  clientTrackSchema,
  playModeSchema,
  trackSchema,
} from "../../shared/schemas.js";
import { createTestToneTrack } from "../../shared/test-tone.js";
import {
  getPlaybackState,
  nextPlayback,
  pausePlayback,
  playTrack,
  previousPlayback,
  reportLocalPlayback,
  resumePlayback,
  seekPlayback,
  setPlaybackVolume,
  speakOnDevice,
  stopPlayback,
  updatePlaybackMode,
} from "./playback.service.js";

const modeSchema = z.object({
  playMode: playModeSchema,
});

const playSchema = z
  .object({
    url: z.string().url().optional(),
    track: trackSchema.optional(),
    clientTrack: clientTrackSchema.optional(),
    deviceId: z.string().min(1).optional(),
    quality: z.string().min(1).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    positionMs: z.number().int().nonnegative().optional(),
  })
  .strict();

const seekSchema = z
  .object({
    positionMs: z.number().int().nonnegative(),
  })
  .strict();

const volumeSchema = z
  .object({
    volume: z.number().min(0).max(100),
  })
  .strict();

const localReportSchema = z
  .object({
    state: z.enum(["playing", "paused", "stopped"]).optional(),
    positionMs: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    ended: z.boolean().optional(),
  })
  .strict();

const speakSchema = z
  .object({
    text: z.string().min(1).max(200),
    deviceId: z.string().min(1).optional(),
  })
  .strict();

export async function playbackRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/state", async () => getPlaybackState());

  app.get("/events", async (_request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(
      `event: playback.state\ndata: ${JSON.stringify(await getPlaybackState())}\n\n`,
    );
    reply.raw.end();
  });

  app.post("/play", async (request) => {
    const body = playSchema.parse(request.body);
    const { clientTrack, ...input } = body;
    return playTrack({
      ...input,
      track:
        body.track ??
        (clientTrack ? trackFromClientSong(clientTrack) : undefined),
    });
  });
  app.post("/test-tone", async (request) => {
    const body = z
      .object({ deviceId: z.string().min(1).optional() })
      .parse(request.body ?? {});
    const track = createTestToneTrack();
    return playTrack({
      url: track.url,
      track,
      deviceId: body.deviceId,
      durationMs: track.durationMs,
    });
  });
  app.post("/pause", async () => pausePlayback());
  app.post("/resume", async () => resumePlayback());
  app.post("/stop", async () => stopPlayback());
  app.post("/next", async () => nextPlayback());
  app.post("/previous", async () => previousPlayback());
  app.post("/seek", async (request) => {
    const body = seekSchema.parse(request.body);
    return seekPlayback(body.positionMs);
  });
  app.post("/volume", async (request) => {
    const body = volumeSchema.parse(request.body);
    return setPlaybackVolume(body.volume);
  });
  // 本机播放（浏览器 <audio>）回写实际进度/状态；ended 时服务端推进队列。
  app.post("/local-report", async (request) => {
    const body = localReportSchema.parse(request.body ?? {});
    return reportLocalPlayback(body);
  });

  app.post("/speak", async (request) => {
    const body = speakSchema.parse(request.body);
    return speakOnDevice(body.text, body.deviceId);
  });

  app.post("/mode", async (request) => {
    const body = modeSchema.parse(request.body);
    return updatePlaybackMode(body.playMode);
  });
}
