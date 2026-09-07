import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import {
  cancelSpotifyLogin,
  currentSpotifyLogin,
  spotifyLoginStatus,
  startSpotifyLogin,
  stopSpotifyLogin,
} from "./spotify-login.service.js";
import {
  clearSession,
  linkSession,
  playSpotifyEntries,
  playlistEntries,
  playlistTracks,
  sessionStatus,
  topTracks,
  userPlaylists,
} from "./spotify.service.js";

const linkSchema = z
  .object({
    // 手动导入保留为兼容入口，网页默认使用独立官方登录窗口。
    spDc: z
      .string()
      .trim()
      .min(10)
      .max(4096)
      .regex(/^[^\s;]+$/),
  })
  .strict();

const recommendationsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    timeRange: z
      .enum(["short_term", "medium_term", "long_term"])
      .default("short_term"),
  })
  .strict();

const playlistsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const playlistTracksSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(100),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const playSchema = z
  .object({
    startIndex: z.number().int().nonnegative().optional(),
    deviceId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(50).default(30),
    offset: z.number().int().min(0).max(100_000).default(0),
    timeRange: z
      .enum(["short_term", "medium_term", "long_term"])
      .default("short_term"),
  })
  .strict();

export async function spotifyRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);
  app.addHook("onClose", stopSpotifyLogin);

  app.get("/login", async (request) => ({
    login: currentSpotifyLogin((request.user as { sub: string }).sub),
  }));

  app.post("/login", async (request) => {
    z.object({}).strict().parse(request.body ?? {});
    return startSpotifyLogin((request.user as { sub: string }).sub);
  });

  app.get("/login/:id", async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    return spotifyLoginStatus((request.user as { sub: string }).sub, id);
  });

  app.delete("/login/:id", async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(request.params);
    return cancelSpotifyLogin((request.user as { sub: string }).sub, id);
  });

  // 绑定会话：sp_dc 当场验证（真换一次 token），无效直接报错不落库。
  app.post("/session", async (request) => {
    const body = linkSchema.parse(request.body);
    await stopSpotifyLogin();
    await linkSession(body.spDc.trim());
    return { loggedIn: true };
  });

  app.get("/session", async () => {
    return sessionStatus();
  });

  app.delete("/session", async () => {
    await stopSpotifyLogin();
    await clearSession();
    return { loggedIn: false };
  });

  // 「日常喜欢听啥」：最近常听 Top 曲目（官方 /me/top/tracks，short_term
  // 近 4 周）。列表供 App 展示 + 整单匹配播放。
  app.get("/recommendations", async (request) => {
    const query = recommendationsSchema.parse(request.query);
    const { items, ...pagination } = await topTracks(
      query.timeRange,
      query.limit,
      query.offset,
    );
    return { tracks: items, ...pagination };
  });

  app.get("/playlists", async (request) => {
    const query = playlistsSchema.parse(request.query);
    const { items, ...pagination } = await userPlaylists(
      query.limit,
      query.offset,
    );
    return { playlists: items, ...pagination };
  });

  app.get("/playlists/:id/tracks", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = playlistTracksSchema.parse(request.query);
    const { items, ...pagination } = await playlistTracks(
      params.id,
      query.limit,
      query.offset,
    );
    return { tracks: items, ...pagination };
  });

  // 整单匹配播放：与榜单同纪律——第一条命中即替换队列开播，其余后台逐条
  // 匹配追加；单条失配静默跳过（匹配是尽力而为，App 显示条数即可感知）。
  app.post("/recommendations/play", async (request) => {
    const body = playSchema.parse(request.body ?? {});
    const entries = (async function* () {
      yield* (await topTracks(body.timeRange, body.limit, body.offset)).items;
    })();
    return playSpotifyEntries(entries, body);
  });

  app.post("/playlists/:id/play", async (request) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = playSchema.parse(request.body ?? {});
    return playSpotifyEntries(playlistEntries(params.id), body);
  });
}
