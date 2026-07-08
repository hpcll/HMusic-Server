import type { HMusicTrack } from "../../shared/contracts.js";
import { moduleLogger } from "../../shared/logger.js";

// 原生在线搜索：直连 QQ / 酷我 / 网易云公开搜索接口，产出 HMusicTrack。
// 与 LX 插件解耦——即使没装任何 LX 插件也能搜出结果；播放 URL 仍由
// 下游 resolveSourceTrack 用 LX 插件按 source(tx/kw/wy)+raw 解析。
// 移植自 Flutter 客户端 native_music_search_service.dart。

const log = moduleLogger("native-search");

const SEARCH_TIMEOUT_MS = 12000;
const PER_PLATFORM_LIMIT = 30;

export type NativeSearchPlatform = "tx" | "kw" | "wy";

// 每家平台限时抓取，任一失败/超时都不影响其它家（Promise.allSettled）。
export async function nativeSearch(
  query: string,
  page = 1,
): Promise<HMusicTrack[]> {
  const results = await Promise.allSettled([
    searchQQ(query, page),
    searchKuwo(query, page),
    searchNetease(query, page),
  ]);

  const tracks: HMusicTrack[] = [];
  const perPlatform: HMusicTrack[][] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      perPlatform.push(r.value);
    } else {
      perPlatform.push([]);
      log.warn({ err: String(r.reason) }, "某平台搜索失败，已跳过");
    }
  }
  // 三家交错排列（QQ/酷我/网易云轮流各取一首），避免结果被单一平台霸屏。
  const maxLen = Math.max(0, ...perPlatform.map((list) => list.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of perPlatform) {
      if (i < list.length) tracks.push(list[i]);
    }
  }
  return tracks;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ===== QQ 音乐（tx）：POST musicu.fcg，QQMusicLite 搜索 =====
async function searchQQ(query: string, page: number): Promise<HMusicTrack[]> {
  const payload = {
    comm: {
      ct: 11,
      cv: "1003006",
      v: "1003006",
      os_ver: "12",
      phonetype: "0",
      devicelevel: "31",
      tmeAppID: "qqmusiclight",
      nettype: "NETWORK_WIFI",
    },
    req: {
      module: "music.search.SearchCgiService",
      method: "DoSearchForQQMusicLite",
      param: {
        query,
        search_type: 0,
        num_per_page: PER_PLATFORM_LIMIT,
        page_num: page,
        nqc_flag: 0,
        grp: 1,
      },
    },
  };

  const data = await fetchJson("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; MSIE 9.0; Windows NT 6.1; WOW64; Trident/5.0)",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const songs = pickArray(
    (data as any)?.req?.data?.body?.item_song,
  );
  return songs
    .map((song) => {
      const id = pickQqSongId(song);
      if (!id) return undefined;
      const title = String(song.title ?? song.name ?? "").trim();
      if (!title) return undefined;

      const artist = Array.isArray(song.singer)
        ? song.singer
            .map((s: any) => (s && s.name ? String(s.name) : String(s)))
            .filter(Boolean)
            .join("/")
        : "";

      let album = "";
      let coverUrl: string | undefined;
      if (song.album && typeof song.album === "object") {
        album = String(song.album.name ?? "");
        const pmid = String(song.album.pmid ?? song.album.mid ?? "");
        if (pmid) {
          coverUrl = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${pmid}.jpg`;
        }
      }

      const durationMs = toDurationMs(song.interval);
      return buildTrack({
        source: "tx",
        sourceTrackId: id,
        title,
        artist,
        album,
        coverUrl,
        durationMs,
        raw: {
          source: "tx",
          songmid: id,
          mid: id,
          albummid: song.album?.mid,
          interval: song.interval,
        },
      });
    })
    .filter(isTrack);
}

// QQ 解析必须优先用 songmid/mid（纯数字 id 往往无法解析播放地址）。
function pickQqSongId(song: any): string {
  const candidates = [
    song.songmid,
    song.mid,
    song.strMediaMid,
    song.file?.media_mid,
    song.file?.mediaMid,
    song.id,
  ]
    .map((v) => (v == null ? "" : String(v).trim()))
    .filter(Boolean);
  if (candidates.length === 0) return "";
  const nonNumeric = candidates.find((id) => !/^\d+$/.test(id));
  return nonNumeric ?? candidates[0];
}

// ===== 酷我（kw）：GET search.kuwo.cn/r.s =====
async function searchKuwo(query: string, page: number): Promise<HMusicTrack[]> {
  const qs = new URLSearchParams({
    client: "kt",
    all: query,
    pn: String(page - 1),
    rn: String(PER_PLATFORM_LIMIT),
    uid: "794762570",
    ver: "kwplayer_ar_9.2.2.1",
    vipver: "1",
    show_copyright_off: "1",
    newver: "1",
    ft: "music",
    cluster: "0",
    strategy: "2012",
    encoding: "utf8",
    rformat: "json",
    vermerge: "1",
    mobi: "1",
    issubtitle: "1",
    _: String(qsTimestamp()),
  });

  const data = await fetchJson(`http://search.kuwo.cn/r.s?${qs.toString()}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36",
      Connection: "Keep-Alive",
      Accept: "application/json",
    },
  });

  const songs = pickArray((data as any)?.abslist);
  return songs
    .map((song) => {
      const rawId = String(song.MUSICRID ?? song.rid ?? "");
      const id = rawId.startsWith("MUSIC_")
        ? rawId.replace("MUSIC_", "")
        : rawId;
      if (!id) return undefined;
      const title = stripHtmlTags(String(song.SONGNAME ?? song.name ?? ""));
      if (!title) return undefined;
      const artist = stripHtmlTags(String(song.ARTIST ?? song.artist ?? ""));
      const album = stripHtmlTags(String(song.ALBUM ?? song.album ?? ""));
      const durationMs = toDurationMs(song.DURATION ?? song.duration);

      return buildTrack({
        source: "kw",
        sourceTrackId: id,
        title,
        artist,
        album,
        durationMs,
        raw: { source: "kw", songmid: id, hash: id, rid: id },
      });
    })
    .filter(isTrack);
}

// ===== 网易云（wy）：多端点回退 GET =====
async function searchNetease(
  query: string,
  page: number,
): Promise<HMusicTrack[]> {
  const offset = (page - 1) * PER_PLATFORM_LIMIT;
  const data = await fetchJson(
    `https://music.163.com/api/search/get?${new URLSearchParams({
      s: query,
      type: "1",
      limit: String(PER_PLATFORM_LIMIT),
      offset: String(offset),
    }).toString()}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://music.163.com/",
      },
    },
  );

  const songs = pickArray(
    (data as any)?.result?.songs ?? (data as any)?.songs,
  );
  return songs
    .map((song) => {
      const id = String(song.id ?? "");
      if (!id) return undefined;
      const title = String(song.name ?? "").trim();
      if (!title) return undefined;

      const arr = song.ar ?? song.artists;
      const artist = Array.isArray(arr)
        ? arr
            .map((a: any) => (a && a.name ? String(a.name) : String(a)))
            .filter(Boolean)
            .join("/")
        : "";

      const al = song.al ?? song.album;
      const album = al && typeof al === "object" ? String(al.name ?? "") : "";
      const coverUrl =
        al && typeof al === "object" && al.picUrl
          ? String(al.picUrl)
          : undefined;
      const durationMs = toDurationMs(
        song.dt ?? song.duration,
        /* alreadyMs */ true,
      );

      return buildTrack({
        source: "wy",
        sourceTrackId: id,
        title,
        artist,
        album,
        coverUrl,
        durationMs,
        raw: { source: "wy", songmid: id, id },
      });
    })
    .filter(isTrack);
}

// ===== 工具 =====

function buildTrack(input: {
  source: NativeSearchPlatform;
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

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}

// Date.now 在部分沙箱受限；用允许的方式取时间戳（仅用于缓存击穿参数）。
function qsTimestamp(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}
