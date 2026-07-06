import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  HMusicPlaybackState,
  HMusicTrack,
} from "../../shared/contracts.js";
import { trackFromClientSong } from "../../shared/client-track.js";
import { AppError } from "../../shared/errors.js";
import { verifyLogin } from "../auth/auth.service.js";
import { listDevices } from "../devices/devices.service.js";
import {
  getPlaybackState,
  pausePlayback,
  playTrack,
  resumePlayback,
  setPlaybackVolume,
  stopPlayback,
} from "../playback/playback.service.js";
import { getPlaylist, listPlaylists } from "../playlists/playlists.service.js";
import { getQueue, replaceQueue } from "../queue/queue.service.js";
import { searchTracks } from "../search/search.service.js";
import { listSources } from "../sources/sources.service.js";

const pushListSchema = z
  .object({
    did: z.string().min(1).optional(),
    songList: z.array(z.record(z.unknown())).min(1),
    playlistName: z.string().optional(),
  })
  .passthrough();

const pushUrlSchema = z
  .object({
    did: z.string().min(1).optional(),
    url: z.string().url(),
  })
  .passthrough();

const playMusicListSchema = z
  .object({
    did: z.string().min(1).optional(),
    listname: z.string().optional(),
    musicname: z.string().optional(),
  })
  .passthrough();

export async function compatRoutes(app: FastifyInstance): Promise<void> {
  app.get("/getversion", { preHandler: requireCompatAuth }, async () => ({
    name: "HMusic Server",
    version: "0.1.0",
    server: "hmusic",
  }));

  app.get("/openapi.json", { preHandler: requireCompatAuth }, async () => ({
    openapi: "3.0.0",
    paths: {
      "/getplayerstatus": {},
      "/api/device/pushList": {},
      "/api/device/pushUrl": {},
    },
    components: {
      schemas: {
        DownloadOneMusic: {
          properties: {},
        },
      },
    },
  }));

  app.get("/api/js-plugins", { preHandler: requireCompatAuth }, async () => {
    const sources = (await listSources()).filter(
      (source) => source.type === "lx_js" && source.enabled,
    );
    return {
      success: true,
      data: sources.map((source) => ({
        id: source.id,
        name: source.name,
        enabled: source.enabled,
        type: source.type,
      })),
    };
  });

  app.get("/getsetting", { preHandler: requireCompatAuth }, async () => {
    const devices = await listDevices();
    const selected = devices.find((device) => device.isDefault);

    return {
      mi_did: selected?.id ?? "",
      devices: Object.fromEntries(
        devices.map((device) => [
          device.id,
          {
            did: device.id,
            name: device.name,
            hardware: device.type ?? "",
          },
        ]),
      ),
      device_list: devices.map((device) => ({
        deviceID: device.id,
        miotDID: device.id,
        name: device.name,
        alias: device.name,
        hardware: device.type ?? "",
        address: device.ip ?? "",
        localip: device.ip ?? "",
        presence: device.isOnline ? "online" : "offline",
        current: device.isDefault,
      })),
    };
  });

  app.get("/playlistnames", { preHandler: requireCompatAuth }, async () => ({
    playlists: (await listPlaylists()).map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      count: playlist.trackCount,
    })),
  }));

  app.get("/musiclist", { preHandler: requireCompatAuth }, async () => {
    const playlists = await listPlaylists();
    const entries = await Promise.all(
      playlists.map(async (playlist) => {
        const detail = await getPlaylist(playlist.id);
        return [
          playlist.name,
          detail.items.map((item) => formatCompatSongName(item.track)),
        ] as const;
      }),
    );
    return {
      全部: entries.flatMap((entry) => entry[1]),
      ...Object.fromEntries(entries),
    };
  });

  app.get(
    "/playlistmusics",
    { preHandler: requireCompatAuth },
    async (request) => {
      const name = asString(
        (request.query as Record<string, unknown> | undefined)?.name,
      );
      const playlists = await listPlaylists();
      const playlist = playlists.find((item) => item.name === name);
      if (!playlist) return { musics: [] };

      const detail = await getPlaylist(playlist.id);
      return {
        musics: detail.items.map((item) => formatCompatSongName(item.track)),
      };
    },
  );

  app.get(
    "/searchmusic",
    { preHandler: requireCompatAuth },
    async (request) => {
      const name = asString(
        (request.query as Record<string, unknown> | undefined)?.name,
      );
      if (!name) return [];

      const result = await searchTracks({ query: name, page: 1, limit: 20 });
      return result.tracks.map((track) => ({
        name: formatCompatSongName(track),
        title: track.title,
        artist: track.artist,
        source: track.source,
        id: track.sourceTrackId,
        album: track.album ?? "",
        duration: Math.round((track.durationMs ?? 0) / 1000),
        pic: track.coverUrl ?? "",
      }));
    },
  );

  app.post(
    "/api/device/pushList",
    { preHandler: requireCompatAuth },
    async (request) => {
      const body = pushListSchema.parse(request.body);
      const tracks = body.songList.map(trackFromClientSong);
      const queue = await replaceQueue({ tracks, currentIndex: 0 });
      const playback = await playTrack({
        track: tracks[0],
        deviceId: body.did,
        queueIndex: 0,
      });

      return {
        success: true,
        ret: "OK",
        playlistName: body.playlistName ?? "在线播放",
        queueLength: queue.items.length,
        playback,
      };
    },
  );

  app.post(
    "/api/device/pushUrl",
    { preHandler: requireCompatAuth },
    async (request) => {
      const body = pushUrlSchema.parse(request.body);
      return playCompatUrl(body.url, body.did);
    },
  );

  app.get("/playurl", { preHandler: requireCompatAuth }, async (request) => {
    const query = request.query as Record<string, unknown> | undefined;
    const url = asString(query?.url);
    if (!url) {
      throw new AppError("COMPAT_URL_MISSING", "缺少播放 URL", 400);
    }
    return playCompatUrl(url, asString(query?.did));
  });

  app.post(
    "/playmusiclist",
    { preHandler: requireCompatAuth },
    async (request) => {
      const body = playMusicListSchema.parse(request.body);
      const playback = await playNamedTrack(
        body.musicname,
        body.listname,
        body.did,
      );
      return { ret: "OK", playback };
    },
  );

  app.get("/playingmusic", { preHandler: requireCompatAuth }, async () =>
    playbackStateToCompat(await getPlaybackState()),
  );

  app.get("/getplayerstatus", { preHandler: requireCompatAuth }, async () =>
    playbackStateToPlayerStatus(await getPlaybackState()),
  );

  app.get("/getvolume", { preHandler: requireCompatAuth }, async () => ({
    volume: (await getPlaybackState()).volume,
  }));

  app.post("/setvolume", { preHandler: requireCompatAuth }, async (request) => {
    const body = z
      .object({ volume: z.number().min(0).max(100) })
      .passthrough()
      .parse(request.body);
    return setPlaybackVolume(body.volume);
  });

  app.post("/device/stop", { preHandler: requireCompatAuth }, async () =>
    stopPlayback(),
  );

  app.post("/cmd", { preHandler: requireCompatAuth }, async (request) => {
    const command = asString(
      (request.body as Record<string, unknown> | undefined)?.cmd,
    );
    if (command?.includes("暂停")) return pausePlayback();
    if (command?.includes("播放")) return resumePlayback();
    if (command?.includes("停止")) return stopPlayback();
    return { ret: "IGNORED", command };
  });
}

async function requireCompatAuth(request: FastifyRequest): Promise<void> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Basic ")) {
    throw new AppError("AUTH_REQUIRED", "需要管理员账号密码", 401);
  }

  const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString(
    "utf8",
  );
  const separator = decoded.indexOf(":");
  const username = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";
  await verifyLogin(username, password);
}

async function playCompatUrl(url: string, deviceId?: string) {
  const track: HMusicTrack = {
    id: `manual:url:${Buffer.from(url).toString("base64url")}`,
    source: "manual",
    sourceTrackId: url,
    title: fileNameFromUrl(url),
    artist: "URL 音频",
    url,
    qualities: ["source"],
    raw: { url },
  };
  const playback = await playTrack({ track, deviceId, url });
  return { ret: "OK", playback };
}

async function playNamedTrack(
  musicName: string | undefined,
  playlistName: string | undefined,
  deviceId: string | undefined,
): Promise<HMusicPlaybackState> {
  const queue = await getQueue();
  const fromQueue = queue.items.find((item) =>
    isCompatSongNameMatch(item.track, musicName),
  );
  if (fromQueue) {
    return playTrack({ track: fromQueue.track, deviceId });
  }

  const playlists = await listPlaylists();
  const playlist =
    playlists.find((item) => item.name === playlistName) ?? playlists[0];
  if (playlist) {
    const detail = await getPlaylist(playlist.id);
    const item =
      detail.items.find((candidate) =>
        isCompatSongNameMatch(candidate.track, musicName),
      ) ?? detail.items[0];
    if (item) return playTrack({ track: item.track, deviceId });
  }

  throw new AppError("COMPAT_TRACK_NOT_FOUND", "未找到要播放的歌曲", 404, {
    musicName,
    playlistName,
  });
}

function playbackStateToCompat(state: HMusicPlaybackState) {
  return {
    ret: "ok",
    is_playing: state.state === "playing",
    cur_music: state.track ? formatCompatSongName(state.track) : "",
    cur_playlist: "HMusic",
    offset: Math.round(state.positionMs / 1000),
    duration: Math.round(state.durationMs / 1000),
  };
}

function playbackStateToPlayerStatus(state: HMusicPlaybackState) {
  return {
    ret: "ok",
    status: state.state === "playing" ? 1 : state.state === "paused" ? 2 : 0,
    volume: state.volume,
    duration: Math.round(state.durationMs / 1000),
    offset: Math.round(state.positionMs / 1000),
    cur_music: state.track ? formatCompatSongName(state.track) : "",
    cur_playlist: "HMusic",
    play_song_detail: state.track
      ? {
          audio_id: state.track.sourceTrackId,
          title: state.track.title,
          artist: state.track.artist,
          album: state.track.album ?? "",
          cover: state.track.coverUrl ?? "",
          duration: state.durationMs,
          position: state.positionMs,
        }
      : undefined,
  };
}

function formatCompatSongName(track: HMusicTrack): string {
  return `${track.title} - ${track.artist}`;
}

function isCompatSongNameMatch(
  track: HMusicTrack,
  musicName: string | undefined,
): boolean {
  if (!musicName) return false;
  const normalized = normalizeName(musicName);
  return (
    normalized === normalizeName(track.title) ||
    normalized === normalizeName(formatCompatSongName(track))
  );
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return (
      decodeURIComponent(
        parsed.pathname.split("/").filter(Boolean).pop() ?? "",
      ) || "URL 音频"
    );
  } catch {
    return "URL 音频";
  }
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
