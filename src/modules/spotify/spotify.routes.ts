import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { AppError } from "../../shared/errors.js";
import {
  clearSession,
  linkSession,
  playSpotifyEntries,
  playlistTracks,
  sessionStatus,
  topTracks,
  userPlaylists,
} from "./spotify.service.js";

const linkSchema = z
  .object({
    // 网页端 Cookie sp_dc：App 内引导用户从 Spotify 网页版复制。
    spDc: z.string().min(10),
  })
  .strict();

const recommendationsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    timeRange: z
      .enum(["short_term", "medium_term", "long_term"])
      .default("short_term"),
  })
  .strict();

const playlistsSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(50).default(30) })
  .strict();

const playlistTracksSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(100) })
  .strict();

const playSchema = z
  .object({
    startIndex: z.number().int().nonnegative().optional(),
    deviceId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).default(30),
    timeRange: z.enum(["short_term", "medium_term", "long_term"]).default("short_term"),
  })
  .strict();

export async function spotifyRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  // 绑定会话：sp_dc 当场验证（真换一次 token），无效直接报错不落库。
  app.post("/session", async (request) => {
    const body = linkSchema.parse(request.body);
    await linkSession(body.spDc.trim());
    return { loggedIn: true };
  });

  app.get("/session", async () => {
    return sessionStatus();
  });

  app.delete("/session", async () => {
    await clearSession();
    return { loggedIn: false };
  });

  // 「日常喜欢听啥」：最近常听 Top 曲目（官方 /me/top/tracks，short_term
  // 近 4 周）。列表供 App 展示 + 整单匹配播放。
  app.get("/recommendations", async (request) => {
    const query = recommendationsSchema.parse(request.query);
    return { tracks: await topTracks(query.timeRange, query.limit) };
  });

  app.get("/playlists", async (request) => {
    const query = playlistsSchema.parse(request.query);
    return { playlists: await userPlaylists(query.limit) };
  });

  app.get("/playlists/:id/tracks", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = playlistTracksSchema.parse(request.query);
    return { tracks: await playlistTracks(params.id, query.limit) };
  });

  // 整单匹配播放：与榜单同纪律——第一条命中即替换队列开播，其余后台逐条
  // 匹配追加；单条失配静默跳过（匹配是尽力而为，App 显示条数即可感知）。
  app.post("/recommendations/play", async (request) => {
    const body = playSchema.parse(request.body ?? {});
    const entries = await topTracks(body.timeRange, body.limit);
    if (entries.length === 0) {
      throw new AppError(
        "SPOTIFY_MATCH_EMPTY",
        "Spotify 没有返回可播放的曲目",
        409,
      );
    }
    return playSpotifyEntries(entries, body);
  });

  app.post("/playlists/:id/play", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = playSchema.parse(request.body ?? {});
    const entries = await playlistTracks(params.id, 100);
    if (entries.length === 0) {
      throw new AppError(
        "SPOTIFY_MATCH_EMPTY",
        "该歌单没有可播放的曲目",
        409,
      );
    }
    return playSpotifyEntries(entries, body);
  });
}
