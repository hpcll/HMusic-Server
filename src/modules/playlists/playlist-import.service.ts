import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { moduleLogger } from "../../shared/logger.js";

// 歌单导入：粘贴 QQ音乐 / 酷我 / 网易云 的分享链接，直连各家公开歌单接口抓取
// 曲目，产出 HMusicTrack[]。移植自 Flutter 客户端 playlist_import_service.dart。
//
// 关键约束：产出的 track.raw 结构必须与 native-search.service.ts 完全一致
// （tx: {source,songmid,mid,albummid,interval}；kw: {source,songmid,hash,rid}；
//  wy: {source,songmid,id}），否则下游 resolveSourceTrack 的 LX 插件无法解析
// 出播放地址，导入的歌曲将无法播放。

const log = moduleLogger("playlist-import");

const FETCH_TIMEOUT_MS = 20000;
const MAX_IMPORT_SONGS = 500;

export type ImportPlatform = "tx" | "kw" | "wy";

export type ImportedPlaylist = {
  name: string;
  platform: ImportPlatform;
  playlistId: string;
  sourceUrl: string;
  tracks: HMusicTrack[];
  totalCount: number;
  skipped: {
    emptyTitle: number;
    duplicate: number;
    truncated: number;
  };
};

const PLATFORM_DISPLAY: Record<ImportPlatform, string> = {
  tx: "QQ音乐",
  kw: "酷我",
  wy: "网易云",
};

export function platformDisplayName(platform: string): string {
  return PLATFORM_DISPLAY[platform as ImportPlatform] ?? platform;
}

// 导入主流程：识别链接 → 提取歌单 ID → 抓取详情 → 清洗去重截断。
export async function importPlaylistFromUrl(
  text: string,
): Promise<ImportedPlaylist> {
  const url = extractBestUrl(text);
  if (!url) {
    throw new AppError(
      "IMPORT_INVALID_URL",
      "链接格式无法识别，请粘贴 QQ音乐/酷我/网易云 的歌单链接",
      400,
    );
  }

  const platform = identifyPlatform(url);
  if (!platform) {
    throw new AppError("IMPORT_UNSUPPORTED_PLATFORM", "暂不支持该平台", 400, {
      url,
    });
  }

  const playlistId = await extractPlaylistId(url, platform);
  if (!playlistId) {
    throw new AppError(
      "IMPORT_INVALID_URL",
      "链接中未能解析出歌单 ID，请确认是歌单分享链接",
      400,
      { url, platform },
    );
  }

  const fetched = await fetchPlaylistDetail(platform, playlistId);
  const cleaned = cleanImportedTracks(fetched.tracks);
  if (cleaned.tracks.length === 0) {
    throw new AppError(
      "IMPORT_PLAYLIST_EMPTY",
      "歌单内没有可导入的有效歌曲",
      422,
      { platform, playlistId },
    );
  }

  return {
    name: fetched.name,
    platform,
    playlistId,
    sourceUrl: url,
    tracks: cleaned.tracks,
    totalCount: fetched.totalCount,
    skipped: cleaned.skipped,
  };
}

// ===== URL 提取 / 平台识别 / 歌单 ID 提取 =====

// 从可能夹带文案的分享文本里挑出最合适的音乐链接（优先能识别平台的那条）。
function extractBestUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s<>"']+/g);
  if (!matches || matches.length === 0) return null;
  const urls = matches.map(sanitizeUrl);
  const musicUrl = urls.find((u) => identifyPlatform(u) !== null);
  return musicUrl ?? urls[0] ?? null;
}

// 剥掉链接尾部粘连的中英文标点，并修复被文案吞掉的括号配对。
function sanitizeUrl(url: string): string {
  let result = url.replace(/[)）\]】》>,，。、；;！!？?"'“”’`]+$/u, "");
  result = fixBracketPairing(result, "(", ")");
  result = fixBracketPairing(result, "（", "）");
  return result;
}

function fixBracketPairing(url: string, open: string, close: string): string {
  const openCount = url.split(open).length - 1;
  const closeCount = url.split(close).length - 1;
  let result = url;
  for (let i = 0; i < closeCount - openCount; i++) {
    if (result.endsWith(close)) {
      result = result.slice(0, -close.length);
    }
  }
  return result;
}

function identifyPlatform(url: string): ImportPlatform | null {
  const lower = url.toLowerCase();
  if (
    lower.includes("y.qq.com") ||
    lower.includes("i.y.qq.com") ||
    lower.includes("c.y.qq.com")
  ) {
    return "tx";
  }
  if (lower.includes("kuwo.cn")) return "kw";
  if (
    lower.includes("163cn.tv") ||
    lower.includes("163.com") ||
    lower.includes("netease")
  ) {
    return "wy";
  }
  return null;
}

async function extractPlaylistId(
  url: string,
  platform: ImportPlatform,
): Promise<string | null> {
  switch (platform) {
    case "tx": {
      const parsed = new URL(url);
      const queryId = parsed.searchParams.get("id");
      if (queryId) return queryId;
      const pathMatch = parsed.pathname.match(
        /\/(?:playlist|playsquare|details)\/(\d+)/,
      );
      if (pathMatch) return pathMatch[1];
      const numericSeg = parsed.pathname
        .split("/")
        .filter((s) => /^\d{6,}$/.test(s));
      return numericSeg.length > 0 ? numericSeg[numericSeg.length - 1] : null;
    }
    case "kw": {
      const match = url.match(/playlist_detail\/(\d+)/);
      if (match) return match[1];
      return new URL(url).searchParams.get("pid");
    }
    case "wy": {
      let realUrl = url;
      if (url.includes("163cn.tv")) {
        realUrl = await followRedirect(url);
      }
      // 网易云分享链接常带 #/，标准 URL 解析会把 hash 之后当片段丢弃。
      const parsed = new URL(realUrl.replace("#/", ""));
      return parsed.searchParams.get("id");
    }
    default:
      return null;
  }
}

// ===== 详情抓取（各家主备接口 fallback） =====

async function fetchPlaylistDetail(
  platform: ImportPlatform,
  playlistId: string,
): Promise<{ name: string; totalCount: number; tracks: HMusicTrack[] }> {
  switch (platform) {
    case "tx":
      return fetchQQ(playlistId);
    case "kw":
      return fetchKuwo(playlistId);
    case "wy":
      return fetchNetease(playlistId);
    default:
      throw new AppError("IMPORT_UNSUPPORTED_PLATFORM", "暂不支持该平台", 400);
  }
}

// ---- QQ 音乐（tx）----
async function fetchQQ(id: string) {
  return withFallback(
    "tx",
    () => fetchQQEndpoint(`https://c.y.qq.com`, id),
    () =>
      withFallback(
        "tx",
        () => fetchQQEndpoint(`https://i.y.qq.com`, id),
        () => fetchQQMusicu(id),
      ),
  );
}

async function fetchQQEndpoint(host: string, id: string) {
  const qs = new URLSearchParams({
    type: "1",
    json: "1",
    utf8: "1",
    onlysong: "0",
    disstid: id,
    format: "json",
  });
  const data = await fetchJson(
    `${host}/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${qs.toString()}`,
    { headers: { Referer: "https://y.qq.com/" } },
  );

  const cdList = pickArray((data as any)?.cdlist);
  const container =
    cdList.length > 0 ? (cdList[0] as any) : (data as any) ?? {};
  const rawSongs = pickArray(container.songlist ?? (data as any)?.songlist);
  if (rawSongs.length === 0) {
    throw new Error("QQ 歌单接口返回空 songlist");
  }
  const name = String(
    container.dissname ??
      container.title ??
      (data as any)?.dissname ??
      (data as any)?.dirname ??
      "QQ歌单",
  );
  const tracks = rawSongs.map(parseQQSong).filter(isTrack);
  return { name, totalCount: tracks.length, tracks };
}

async function fetchQQMusicu(id: string) {
  const body = {
    comm: { ct: 24, cv: 0 },
    playlist: {
      module: "music.srfDissInfo.aiDissInfo",
      method: "fcg_musiclist_getinfo_cp",
      param: {
        disstid: Number.parseInt(id, 10) || id,
        song_begin: 0,
        song_num: 1000,
      },
    },
  };
  const data = await fetchJson("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: { Referer: "https://y.qq.com/", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const inner = (data as any)?.playlist?.data ?? {};
  const rawSongs = pickArray(inner.songlist);
  if (rawSongs.length === 0) {
    throw new Error("QQ musicu 详情为空");
  }
  const name = String(inner.dissname ?? inner.title ?? "QQ歌单");
  const tracks = rawSongs.map(parseQQSong).filter(isTrack);
  return { name, totalCount: tracks.length, tracks };
}

export function parseQQSong(song: any): HMusicTrack | undefined {
  const id = String(song.songmid ?? song.mid ?? song.id ?? "").trim();
  const title = String(song.songname ?? song.title ?? "").trim();
  if (!id || !title) return undefined;
  const singers = pickArray(song.singer);
  const artist = singers
    .map((s: any) => (s && s.name ? String(s.name) : ""))
    .filter(Boolean)
    .join("/");
  const albumMid = String(song.albummid ?? song.albumMid ?? "");
  const coverUrl = albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
    : undefined;
  return buildTrack({
    source: "tx",
    sourceTrackId: id,
    title,
    artist,
    coverUrl,
    durationMs: toDurationMs(song.interval),
    raw: {
      source: "tx",
      songmid: id,
      mid: id,
      albummid: albumMid || undefined,
      interval: song.interval,
    },
  });
}

// ---- 酷我（kw）----
async function fetchKuwo(id: string) {
  return withFallback(
    "kw",
    () => fetchKuwoNew(id),
    () => fetchKuwoLegacy(id),
  );
}

async function fetchKuwoNew(id: string) {
  const options = await buildKuwoInit();
  const qs = new URLSearchParams({ pid: id, pn: "1", rn: "1000" });
  const data = await fetchJson(
    `https://www.kuwo.cn/api/www/playlist/playListInfo?${qs.toString()}`,
    options,
  );
  const dataObj = (data as any)?.data ?? {};
  const musicList = pickArray(dataObj.musicList);
  if (musicList.length === 0) {
    throw new Error("酷我歌单返回空 musicList（可能触发风控）");
  }
  const name = String(dataObj.name ?? dataObj.title ?? "酷我歌单");
  const tracks = musicList.map(parseKuwoSong).filter(isTrack);
  return { name, totalCount: tracks.length, tracks };
}

async function fetchKuwoLegacy(id: string) {
  const qs = new URLSearchParams({
    op: "getlistinfo",
    pid: id,
    pn: "0",
    rn: "1000",
    encode: "utf8",
    keyset: "pl2012",
    vipver: "MUSIC_9.0.5.0_W1",
    newver: "1",
  });
  const data = await fetchJson(
    `https://nplserver.kuwo.cn/pl.svc?${qs.toString()}`,
    {},
  );
  const rawList = pickArray((data as any)?.musiclist ?? (data as any)?.musicList);
  if (rawList.length === 0) {
    throw new Error("酷我老接口未返回歌曲列表");
  }
  const name = String((data as any)?.name ?? (data as any)?.title ?? "酷我歌单");
  const tracks = rawList.map(parseKuwoSong).filter(isTrack);
  return { name, totalCount: tracks.length, tracks };
}

function parseKuwoSong(song: any): HMusicTrack | undefined {
  const rawId = String(song.rid ?? song.musicrid ?? song.id ?? "");
  const id = rawId.startsWith("MUSIC_") ? rawId.slice(6) : rawId;
  const title = String(song.name ?? song.songName ?? "").trim();
  if (!id || !title) return undefined;
  const artist = String(song.artist ?? song.artistName ?? "");
  const durationMs = toDurationMs(song.duration ?? song.DURATION);
  const coverUrl = String(song.pic ?? song.pic100 ?? song.albumpic ?? "") || undefined;
  return buildTrack({
    source: "kw",
    sourceTrackId: id,
    title,
    artist,
    coverUrl,
    durationMs,
    raw: { source: "kw", songmid: id, hash: id, rid: id },
  });
}

// 酷我接口要求携带 kw_token（Cookie + csrf 同值），先抓首页拿 token。
async function buildKuwoInit(): Promise<RequestInit> {
  const token = (await fetchKuwoToken()) ?? qsTimestamp().toString();
  return {
    headers: {
      Referer: "https://www.kuwo.cn/",
      Origin: "https://www.kuwo.cn",
      Cookie: `kw_token=${token}`,
      csrf: token,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36",
    },
  };
}

async function fetchKuwoToken(): Promise<string | null> {
  try {
    const resp = await fetch("https://www.kuwo.cn/", {
      headers: {
        Referer: "https://www.kuwo.cn/",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const setCookie = resp.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/kw_token=([^;]+)/);
    if (match && match[1]) return match[1];
  } catch {
    // 忽略，回退到生成的伪 token
  }
  return null;
}

// ---- 网易云（wy）----
// maxSongs：调用方可收紧拉取上限（榜单只要前 50 首，避免白拉几百首批量详情）。
export async function fetchNetease(id: string, maxSongs = MAX_IMPORT_SONGS) {
  return withFallback(
    "wy",
    () =>
      fetchNeteaseEndpoint(
        "https://music.163.com/api/playlist/detail",
        id,
        maxSongs,
      ),
    () =>
      fetchNeteaseEndpoint(
        "https://music.163.com/api/v6/playlist/detail",
        id,
        maxSongs,
      ),
  );
}

async function fetchNeteaseEndpoint(
  endpoint: string,
  id: string,
  maxSongs: number,
) {
  const init: RequestInit = { headers: { Referer: "https://music.163.com/" } };
  const data = await fetchJson(
    `${endpoint}?${new URLSearchParams({ id }).toString()}`,
    init,
  );
  const playlist = (data as any)?.playlist ?? (data as any)?.result ?? {};
  if (!playlist || Object.keys(playlist).length === 0) {
    throw new Error("网易云歌单不存在或已删除");
  }
  const name = String(playlist.name ?? "网易云歌单");
  const inlineTracks = pickArray(playlist.tracks);
  const trackIds = pickArray(playlist.trackIds);

  // tracks 字段只返回前 10 首，需通过 trackIds 批量拉全量详情。
  if (trackIds.length > inlineTracks.length) {
    const allIds = trackIds
      .map((e: any) => (e && typeof e === "object" ? String(e.id ?? "") : String(e ?? "")))
      .filter((s: string) => s.length > 0)
      .slice(0, maxSongs);
    const tracks = await fetchNeteaseSongDetails(allIds, init);
    if (tracks.length > 0) {
      return { name, totalCount: trackIds.length, tracks };
    }
  }

  if (inlineTracks.length === 0) {
    throw new Error("网易云歌单未返回曲目");
  }
  const tracks = inlineTracks.map(parseNeteaseSong).filter(isTrack);
  return { name, totalCount: tracks.length, tracks };
}

async function fetchNeteaseSongDetails(
  ids: string[],
  init: RequestInit,
): Promise<HMusicTrack[]> {
  // 网易云老的 POST /api/song/detail 已失效（返回「参数错误」且响应为两段拼接
  // 的 JSON）。改用 GET /api/song/detail?ids=[...]，稳定返回 songs 数组。
  const batchSize = 500;
  const result: HMusicTrack[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const url = `https://music.163.com/api/song/detail?ids=[${batch.join(",")}]`;
    try {
      const data = await fetchJson(url, {
        headers: init.headers as Record<string, string>,
      });
      const songs = pickArray((data as any)?.songs);
      result.push(...songs.map(parseNeteaseSong).filter(isTrack));
    } catch (err) {
      log.warn({ err: String(err), batch: i }, "网易云批量歌曲详情失败");
    }
  }
  return result;
}

function parseNeteaseSong(song: any): HMusicTrack | undefined {
  const id = String(song.id ?? "").trim();
  const title = String(song.name ?? "").trim();
  if (!id || !title) return undefined;
  const artists = pickArray(song.ar ?? song.artists);
  const artist = artists
    .map((a: any) => (a && a.name ? String(a.name) : ""))
    .filter(Boolean)
    .join("/");
  const album = song.al ?? song.album;
  const coverUrl =
    album && typeof album === "object" && album.picUrl
      ? String(album.picUrl)
      : undefined;
  const durationMs = toDurationMs(song.dt ?? song.duration, true);
  return buildTrack({
    source: "wy",
    sourceTrackId: id,
    title,
    artist,
    coverUrl,
    durationMs,
    raw: { source: "wy", songmid: id, id },
  });
}

// ===== 清洗：空标题剔除、跨平台去重、截断到上限 =====

function cleanImportedTracks(raw: HMusicTrack[]): {
  tracks: HMusicTrack[];
  skipped: ImportedPlaylist["skipped"];
} {
  const seen = new Set<string>();
  const cleaned: HMusicTrack[] = [];
  const skipped = { emptyTitle: 0, duplicate: 0, truncated: 0 };

  for (const track of raw) {
    if (!track.title.trim() || !track.sourceTrackId) {
      skipped.emptyTitle += 1;
      continue;
    }
    const key = `${track.source}:${track.sourceTrackId}`;
    if (seen.has(key)) {
      skipped.duplicate += 1;
      continue;
    }
    seen.add(key);
    cleaned.push(track);
  }

  if (cleaned.length > MAX_IMPORT_SONGS) {
    skipped.truncated = cleaned.length - MAX_IMPORT_SONGS;
    cleaned.length = MAX_IMPORT_SONGS;
  }

  return { tracks: cleaned, skipped };
}

// ===== 通用工具 =====

// 跟随 302 短链跳转（网易云 163cn.tv），最多 5 跳。
async function followRedirect(shortUrl: string): Promise<string> {
  let current = shortUrl;
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = resp.headers.get("location");
    if (!location) break;
    current = new URL(location, current).toString();
  }
  return current;
}

async function withFallback<T>(
  platform: ImportPlatform,
  primary: () => Promise<T>,
  fallback: () => Promise<T>,
): Promise<T> {
  try {
    return await primary();
  } catch (primaryErr) {
    log.warn(
      { err: String(primaryErr), platform },
      `${PLATFORM_DISPLAY[platform]}歌单主接口失败，尝试备用接口`,
    );
    try {
      return await fallback();
    } catch (fallbackErr) {
      throw new AppError(
        "IMPORT_FETCH_FAILED",
        `${PLATFORM_DISPLAY[platform]}歌单获取失败，请稍后重试`,
        502,
        { platform, detail: String(fallbackErr) },
      );
    }
  }
}

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const resp = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await resp.text();
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 部分接口返回 JSONP（callback(...)），剥壳再解析。
    const jsonp = trimmed.match(/^[^(]*\((.*)\)\s*;?$/s);
    if (jsonp) {
      try {
        return JSON.parse(jsonp[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function buildTrack(input: {
  source: ImportPlatform;
  sourceTrackId: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  durationMs?: number;
  raw: unknown;
}): HMusicTrack {
  return {
    id: `${input.source}:${input.sourceTrackId}`,
    source: input.source,
    sourceTrackId: input.sourceTrackId,
    title: input.title,
    artist: input.artist || "未知艺术家",
    album: input.album || undefined,
    durationMs: input.durationMs,
    coverUrl: input.coverUrl,
    qualities: ["128k", "320k", "flac"],
    raw: input.raw,
  };
}

function pickArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isTrack(t: HMusicTrack | undefined): t is HMusicTrack {
  return t !== undefined;
}

// 秒 → 毫秒；网易云的 dt 本身已是毫秒，用 alreadyMs 区分。
function toDurationMs(value: unknown, alreadyMs = false): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return alreadyMs ? n : n * 1000;
}

// Date.now 在部分沙箱受限；用允许的方式取时间戳（仅用于伪 token）。
function qsTimestamp(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}
