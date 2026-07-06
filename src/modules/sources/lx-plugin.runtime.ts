import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";

export type LxPluginConfig = {
  id: string;
  name: string;
  path: string;
};

type RuntimeResult = {
  search(query: string, page: number): Promise<HMusicTrack[]>;
  resolve(track: HMusicTrack, quality?: string): Promise<string | undefined>;
  lyric(track: HMusicTrack): Promise<LxLyricResult | undefined>;
};

type LxRequest = {
  source: string;
  action: "musicUrl" | "lyric";
  info: {
    type?: string;
    musicInfo: Record<string, unknown>;
  };
};

type LxRequestHandler = (request: LxRequest) => unknown | Promise<unknown>;

export type LxLyricResult = {
  lrc: string;
  translatedLrc?: string;
};

export async function createLxPluginRuntime(
  plugin: LxPluginConfig,
): Promise<RuntimeResult> {
  const code = await fs.readFile(path.resolve(plugin.path), "utf8");
  const lxRequestHandlers: LxRequestHandler[] = [];
  const lxApi = createLxApi(lxRequestHandlers);
  const context = vm.createContext({
    console,
    fetch,
    setTimeout,
    clearTimeout,
    URL,
    lx: lxApi,
    module: { exports: {} },
    exports: {},
    globalThis: {},
  });
  context.globalThis = context;
  context.window = context;
  context.self = context;
  context.global = context;
  vm.runInContext(code, context, {
    filename: plugin.path,
    timeout: 5000,
  });

  return {
    search: async (query, page) => {
      const raw = await callPluginFunction(context, [
        `module.exports.search && module.exports.search({ keyword: ${JSON.stringify(query)}, page: ${page}, type: "music" })`,
        `module.exports.searchMusic && module.exports.searchMusic(${JSON.stringify(query)}, ${page})`,
        `module.exports.search && module.exports.search(${JSON.stringify(query)}, ${page})`,
        `searchMusic && searchMusic(${JSON.stringify(query)}, ${page})`,
        `search && search(${JSON.stringify(query)}, ${page})`,
        `search && search("all", ${JSON.stringify(query)}, ${page})`,
      ]);

      return normalizeSearchTracks(plugin, raw);
    },
    resolve: async (track, quality) => {
      const musicInfo = createMusicInfo(track, quality);
      const payload = JSON.stringify(musicInfo);
      const result = await callPluginFunction(context, [
        `module.exports.getUrl && module.exports.getUrl(${payload}, ${JSON.stringify(quality || "")})`,
        `module.exports.getMusicUrl && module.exports.getMusicUrl(${payload}, ${JSON.stringify(quality || "")})`,
        `module.exports.getPlayUrl && module.exports.getPlayUrl(${payload}, ${JSON.stringify(quality || "")})`,
        `getUrl && getUrl(${payload}, ${JSON.stringify(quality || "")})`,
        `getMusicUrl && getMusicUrl(${payload}, ${JSON.stringify(quality || "")})`,
        `getPlayUrl && getPlayUrl(${payload}, ${JSON.stringify(quality || "")})`,
      ]);

      const directUrl = extractUrl(result);
      if (directUrl) return directUrl;

      const eventResult = await callLxRequestHandlers(
        lxRequestHandlers,
        lxApi,
        {
          source: track.source,
          action: "musicUrl",
          info: {
            type: quality || "source",
            musicInfo,
          },
        },
      );
      return extractUrl(eventResult);
    },
    lyric: async (track) => {
      const payload = createTrackPayload(track);
      const result = await callPluginFunction(context, [
        `module.exports.getLyric && module.exports.getLyric(${payload})`,
        `module.exports.getLyrics && module.exports.getLyrics(${payload})`,
        `module.exports.getMusicLyric && module.exports.getMusicLyric(${payload})`,
        `module.exports.lyric && module.exports.lyric(${payload})`,
        `getLyric && getLyric(${payload})`,
        `getLyrics && getLyrics(${payload})`,
        `getMusicLyric && getMusicLyric(${payload})`,
        `lyric && lyric(${payload})`,
      ]);

      const directLyric = normalizeLyricResult(result);
      if (directLyric) return directLyric;

      const eventResult = await callLxRequestHandlers(
        lxRequestHandlers,
        lxApi,
        {
          source: track.source,
          action: "lyric",
          info: {
            musicInfo: createMusicInfo(track),
          },
        },
      );
      return normalizeLyricResult(eventResult);
    },
  };
}

export async function assertLxPluginLoadable(plugin: LxPluginConfig) {
  try {
    await createLxPluginRuntime(plugin);
  } catch (error) {
    throw new AppError("LX_PLUGIN_LOAD_FAILED", "LX 插件加载失败", 502, {
      pluginId: plugin.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function callPluginFunction(
  context: vm.Context,
  expressions: string[],
): Promise<unknown> {
  for (const expression of expressions) {
    try {
      const script = `(async () => {
        try {
          const value = (${expression});
          return await value;
        } catch (_) {
          return undefined;
        }
      })()`;
      const result = await vm.runInContext(script, context, { timeout: 5000 });
      if (result !== undefined && result !== null) return result;
    } catch {
      // Try the next common plugin signature.
    }
  }
  return undefined;
}

function createLxApi(requestHandlers: LxRequestHandler[]) {
  const eventNames = {
    request: "request",
    inited: "inited",
    updateAlert: "updateAlert",
  };

  return {
    EVENT_NAMES: eventNames,
    APP_EVENT_NAMES: eventNames,
    CURRENT_PLATFORM: "desktop",
    APP_SETTING: {},
    version: "2.4.0",
    isDev: false,
    on(eventName: string, handler: LxRequestHandler) {
      if (eventName === eventNames.request && typeof handler === "function") {
        requestHandlers.push(handler);
      }
    },
    off() {
      // Not needed for one-shot plugin runtimes.
    },
    emit() {
      // LX scripts may emit local events during setup; the server ignores them.
    },
    send() {
      // Native bridge responses are not needed in the server runtime.
    },
    request: fetch,
  };
}

async function callLxRequestHandlers(
  handlers: LxRequestHandler[],
  lxApi: ReturnType<typeof createLxApi>,
  request: LxRequest,
): Promise<unknown> {
  for (const handler of handlers) {
    try {
      const result = await handler.call(lxApi, request);
      if (result !== undefined && result !== null) return result;
    } catch {
      // Try the next registered handler.
    }
  }
  return undefined;
}

function normalizeSearchTracks(
  plugin: LxPluginConfig,
  raw: unknown,
): HMusicTrack[] {
  const list = extractList(raw);
  return list.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const sourceTrackId =
      asString(row.id) ||
      asString(row.songmid) ||
      asString(row.mid) ||
      asString(row.hash) ||
      `${index}`;
    const title = asString(row.title) || asString(row.name);
    if (!title) return [];

    return [
      {
        id: `${plugin.id}:${sourceTrackId}`,
        source: plugin.id,
        sourceTrackId,
        title,
        artist:
          asString(row.artist) ||
          asString(row.singer) ||
          asString(row.author) ||
          "未知艺术家",
        album: asString(row.album) || asString(row.albumName),
        durationMs: normalizeDuration(row.duration ?? row.interval),
        coverUrl:
          asString(row.coverUrl) ||
          asString(row.cover) ||
          asString(row.pic) ||
          asString(row.img),
        url: extractUrl(row),
        qualities: ["source", "128k", "320k", "flac"],
        raw: row,
      },
    ];
  });
}

function extractList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const row = raw as Record<string, unknown>;
  for (const key of ["data", "list", "songs", "tracks", "items", "result"]) {
    const value = row[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractList(value);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function extractUrl(raw: unknown): string | undefined {
  if (typeof raw === "string" && isHttpUrl(raw)) return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  for (const key of ["url", "playUrl", "play_url", "src"]) {
    const value = asString(row[key]);
    if (value && isHttpUrl(value)) return value;
  }
  if (row.data) return extractUrl(row.data);
  return undefined;
}

function createTrackPayload(track: HMusicTrack): string {
  return JSON.stringify(createMusicInfo(track));
}

function createMusicInfo(
  track: HMusicTrack,
  quality?: string,
): Record<string, unknown> {
  const raw = track.raw as Record<string, unknown> | undefined;
  return {
    ...raw,
    platform: raw?.platform || track.source,
    source: raw?.source || track.source,
    id: track.sourceTrackId,
    songmid: track.sourceTrackId,
    mid: track.sourceTrackId,
    hash: track.sourceTrackId,
    strMediaMid: track.sourceTrackId,
    title: track.title,
    name: track.title,
    artist: track.artist,
    singer: track.artist,
    album: track.album,
    duration: track.durationMs
      ? Math.round(track.durationMs / 1000)
      : undefined,
    interval: track.durationMs
      ? Math.round(track.durationMs / 1000)
      : undefined,
    quality,
  };
}

function normalizeLyricResult(raw: unknown): LxLyricResult | undefined {
  if (typeof raw === "string" && raw.trim()) {
    return { lrc: raw };
  }
  if (!raw || typeof raw !== "object") return undefined;

  const row = raw as Record<string, unknown>;
  const nested =
    row.data && typeof row.data === "object"
      ? (row.data as Record<string, unknown>)
      : row;
  const lrc =
    asString(nested.lrc) ||
    asString(nested.lyric) ||
    asString(nested.lyrics) ||
    asString(nested.text);
  if (!lrc) return undefined;

  return {
    lrc,
    translatedLrc:
      asString(nested.tlyric) ||
      asString(nested.translatedLrc) ||
      asString(nested.translatedLyric),
  };
}

function normalizeDuration(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1000 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value !== "string") return undefined;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return undefined;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3)
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
