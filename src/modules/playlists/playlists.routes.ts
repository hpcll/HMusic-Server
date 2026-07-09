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
  addPlaylistTrack,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  importPlaylist,
  listPlaylists,
  playPlaylist,
  removePlaylistTrack,
  updatePlaylist,
} from "./playlists.service.js";

const playlistParamsSchema = z.object({
  id: z.string().min(1),
});

const playlistTrackParamsSchema = playlistParamsSchema.extend({
  itemId: z.string().min(1),
});

const createPlaylistSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
  })
  .strict();

const updatePlaylistSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
  })
  .strict();

const addPlaylistTrackSchema = z
  .object({
    track: trackSchema.optional(),
    clientTrack: clientTrackSchema.optional(),
  })
  .strict();

const playPlaylistSchema = z
  .object({
    startIndex: z.number().int().nonnegative().optional(),
    playMode: playModeSchema.optional(),
    deviceId: z.string().min(1).optional(),
  })
  .strict();

const importPlaylistSchema = z
  .object({
    url: z.string().min(1).max(2000),
    name: z.string().min(1).max(80).optional(),
  })
  .strict();

export async function playlistsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => ({ playlists: await listPlaylists() }));

  app.post("/", async (request) => {
    const body = createPlaylistSchema.parse(request.body);
    return { playlist: await createPlaylist(body) };
  });

  app.post("/import", async (request) => {
    const body = importPlaylistSchema.parse(request.body);
    return importPlaylist(body);
  });

  app.get("/:id", async (request) => {
    const params = playlistParamsSchema.parse(request.params);
    return { playlist: await getPlaylist(params.id) };
  });

  app.patch("/:id", async (request) => {
    const params = playlistParamsSchema.parse(request.params);
    const body = updatePlaylistSchema.parse(request.body);
    return { playlist: await updatePlaylist(params.id, body) };
  });

  app.delete("/:id", async (request) => {
    const params = playlistParamsSchema.parse(request.params);
    return deletePlaylist(params.id);
  });

  app.post("/:id/tracks", async (request) => {
    const params = playlistParamsSchema.parse(request.params);
    const body = addPlaylistTrackSchema.parse(request.body);
    return { playlist: await addPlaylistTrack(params.id, getInputTrack(body)) };
  });

  app.delete("/:id/tracks/:itemId", async (request) => {
    const params = playlistTrackParamsSchema.parse(request.params);
    return {
      playlist: await removePlaylistTrack(params.id, params.itemId),
    };
  });

  app.post("/:id/play", async (request) => {
    const params = playlistParamsSchema.parse(request.params);
    const body = playPlaylistSchema.parse(request.body ?? {});
    return playPlaylist({
      playlistId: params.id,
      ...body,
    });
  });
}

function getInputTrack(body: z.infer<typeof addPlaylistTrackSchema>) {
  if (body.track) return body.track;
  if (body.clientTrack) return trackFromClientSong(body.clientTrack);
  throw new AppError(
    "PLAYLIST_TRACK_MISSING",
    "请求必须包含 track 或 clientTrack",
    400,
  );
}
