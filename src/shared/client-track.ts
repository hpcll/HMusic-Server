import type { HMusicTrack } from "./contracts.js";

const playbackUrlKeys = new Set(["url", "playUrl", "play_url", "src"]);

export function trackFromClientSong(
  song: Record<string, unknown>,
): HMusicTrack {
  const combinedName = pickString(song, [
    "name",
    "musicName",
    "musicname",
    "cur_music",
  ]);
  const parsedName = parseName(combinedName);
  const title =
    pickString(song, ["title", "songName", "SONGNAME", "songname"]) ??
    parsedName.title;
  const artist = pickArtist(song) ?? parsedName.artist;
  const source = normalizeSource(
    pickString(song, ["source", "platform", "type", "provider"]) ?? "tx",
  );
  const sourceTrackId =
    normalizeSourceTrackId(
      source,
      pickString(song, [
        "sourceTrackId",
        "songId",
        "songid",
        "song_id",
        "id",
        "songmid",
        "mid",
        "strMediaMid",
        "hash",
        "rid",
        "musicrid",
        "MUSICRID",
        "audio_id",
        "videoId",
        "vid",
      ]),
    ) ?? `${title}-${artist}`;

  return {
    id: `${source}:${sourceTrackId}`,
    source,
    sourceTrackId,
    title,
    artist,
    album: pickAlbum(song),
    durationMs: normalizeDurationMs(
      song.durationMs ??
        song.duration ??
        song.DURATION ??
        song.interval ??
        song.time,
    ),
    coverUrl: pickHttpUrl(song, [
      "coverUrl",
      "cover",
      "pic",
      "picture",
      "img",
      "thumbnail",
    ]),
    qualities: ["source", "128k", "320k", "flac"],
    raw: createStableRaw(song, {
      source,
      sourceTrackId,
      title,
      artist,
    }),
  };
}

function normalizeSource(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (normalized === "qq" || normalized === "tencent") return "tx";
  if (normalized === "netease" || normalized === "wyy") return "wy";
  if (normalized === "kuwo") return "kw";
  if (normalized === "kugou") return "kg";
  if (normalized === "migu") return "mg";
  if (normalized === "yt") return "youtube";
  return normalized;
}

function createStableRaw(
  song: Record<string, unknown>,
  input: {
    source: string;
    sourceTrackId: string;
    title: string;
    artist: string;
  },
): Record<string, unknown> {
  const raw = sanitizePlaybackUrls(song) as Record<string, unknown>;
  return {
    ...raw,
    platform: input.source,
    source: input.source,
    sourceTrackId: input.sourceTrackId,
    songId: input.sourceTrackId,
    songid: input.sourceTrackId,
    id: input.sourceTrackId,
    songmid: input.sourceTrackId,
    mid: input.sourceTrackId,
    strMediaMid: input.sourceTrackId,
    hash: input.sourceTrackId,
    rid: input.sourceTrackId,
    musicrid: input.sourceTrackId,
    title: input.title,
    name: input.title,
    artist: input.artist,
    singer: input.artist,
  };
}

function sanitizePlaybackUrls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlaybackUrls(item));
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (playbackUrlKeys.has(key)) continue;
    result[key] = sanitizePlaybackUrls(item);
  }
  return result;
}

function normalizeSourceTrackId(
  source: string,
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  if (source === "kw" && value.startsWith("MUSIC_")) {
    return value.slice("MUSIC_".length);
  }
  return value;
}

function pickString(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function pickArtist(row: Record<string, unknown>): string | undefined {
  const direct = pickString(row, ["artist", "author", "singerName", "ARTIST"]);
  if (direct) return direct;

  const singer = row.singer;
  if (Array.isArray(singer)) {
    const names = singer
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        return pickString(item as Record<string, unknown>, ["name", "title"]);
      })
      .filter(Boolean);
    if (names.length > 0) return names.join("/");
  }

  return undefined;
}

function pickAlbum(row: Record<string, unknown>): string | undefined {
  const direct = pickString(row, ["album", "albumName", "ALBUM"]);
  if (direct) return direct;

  const album = row.album;
  if (album && typeof album === "object") {
    return pickString(album as Record<string, unknown>, ["name", "title"]);
  }
  return undefined;
}

function pickHttpUrl(
  row: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const value = pickString(row, keys);
  if (!value) return undefined;
  return isHttpUrl(value) ? value : undefined;
}

function normalizeDurationMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value > 10000 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes(":")) {
    const numberValue = Number(trimmed);
    return Number.isFinite(numberValue) && numberValue >= 0
      ? normalizeDurationMs(numberValue)
      : undefined;
  }

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) {
    return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  }
  return undefined;
}

function parseName(name: string | undefined): {
  title: string;
  artist: string;
} {
  if (!name) return { title: "未知歌曲", artist: "未知艺术家" };
  const [title, ...artistParts] = name.split(" - ");
  return {
    title: title.trim() || "未知歌曲",
    artist: artistParts.join(" - ").trim() || "未知艺术家",
  };
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}
