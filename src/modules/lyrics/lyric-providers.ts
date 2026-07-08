import type { HMusicTrack } from "../../shared/contracts.js";
import type { LxLyricResult } from "../sources/lx-plugin.runtime.js";

// 独立歌词兜底源：
// 用户装的音源插件（如 windyday-lx）通常只声明 actions: ["musicUrl"]，
// 根本不返回歌词。播放页因此永远「暂无歌词」。这里用 QQ 音乐的公开歌词接口补齐：
//   1) 曲目本身就是 QQ 源（songmid 已知）→ 直接按 mid 取词；
//   2) 其它源 → 用「歌名 歌手」搜 QQ 拿到 songmid，再取词。
// 这样非 QQ 音源也能有歌词，尽力而为，失败静默（无歌词不算错误）。

const QQ_REFERER = "https://y.qq.com/portal/player.html";
const QQ_HEADERS = {
  Referer: QQ_REFERER,
  Origin: "https://y.qq.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};
const FETCH_TIMEOUT_MS = 8_000;

// QQ 源在各插件里的常见标识；用于判断能否直接用 mid 取词。
const QQ_SOURCE_IDS = new Set(["tx", "qq", "qqmusic"]);

export async function fetchFallbackLyric(
  track: HMusicTrack,
): Promise<LxLyricResult | undefined> {
  const directMid = qqMidFromTrack(track);
  if (directMid) {
    const byMid = await fetchQqLyricByMid(directMid);
    if (byMid) return byMid;
  }

  const mid = await searchQqSongMid(track);
  if (!mid) return undefined;
  return fetchQqLyricByMid(mid);
}

// 从曲目里挖 QQ songmid：仅当它本身就是 QQ 源时才可信
// （别的源的 sourceTrackId 不是 QQ 的 mid，拿去取词只会取到错词）。
function qqMidFromTrack(track: HMusicTrack): string | undefined {
  const rawSource =
    typeof (track.raw as Record<string, unknown>)?.source === "string"
      ? String((track.raw as Record<string, unknown>).source).toLowerCase()
      : "";
  const isQq =
    QQ_SOURCE_IDS.has(track.source.toLowerCase()) || QQ_SOURCE_IDS.has(rawSource);
  if (!isQq) return undefined;

  const raw = (track.raw as Record<string, unknown>) || {};
  const candidate =
    asString(raw.songmid) ||
    asString(raw.mid) ||
    asString(raw.strMediaMid) ||
    asString(track.sourceTrackId);
  // QQ 的 mid 是 14 位字母数字，纯数字的多半是别的源的自增 id。
  if (candidate && /^[A-Za-z0-9]{10,}$/.test(candidate) && /[A-Za-z]/.test(candidate)) {
    return candidate;
  }
  return undefined;
}

async function searchQqSongMid(
  track: HMusicTrack,
): Promise<string | undefined> {
  const keyword = [track.title, track.artist]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!keyword) return undefined;

  const url =
    "https://c.y.qq.com/soso/fcgi-bin/client_search_cp?" +
    new URLSearchParams({
      format: "json",
      p: "1",
      n: "5",
      w: keyword,
      cr: "1",
      new_json: "1",
    }).toString();

  const payload = await fetchJson(url);
  if (!payload) return undefined;

  // new_json=1 时结构为 data.song.list[].mid；老结构 data.song.list[].songmid。
  const list =
    (payload as any)?.data?.song?.list ??
    (payload as any)?.data?.song ??
    [];
  if (!Array.isArray(list)) return undefined;

  for (const item of list) {
    const mid = asString(item?.mid) || asString(item?.songmid);
    if (mid) return mid;
  }
  return undefined;
}

async function fetchQqLyricByMid(
  songmid: string,
): Promise<LxLyricResult | undefined> {
  const url =
    "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?" +
    new URLSearchParams({
      songmid,
      format: "json",
      nobase64: "0",
      g_tk: "5381",
      loginUin: "0",
      hostUin: "0",
      inCharset: "utf8",
      outCharset: "utf-8",
      notice: "0",
      platform: "yqq.json",
      needNewCode: "0",
    }).toString();

  const payload = await fetchJson(url);
  if (!payload) return undefined;

  const lrc = decodeQqLyric(asString((payload as any).lyric));
  if (!lrc) return undefined;
  const translatedLrc = decodeQqLyric(asString((payload as any).trans));

  return { lrc, translatedLrc };
}

// QQ 歌词字段是 base64（nobase64=0 时）。解码失败就当作已是明文。
function decodeQqLyric(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    // 解码结果含 LRC 时间标签或中文才算成功；否则回退原文。
    if (/\[\d{1,2}:\d{2}/.test(decoded) || /[一-龥]/.test(decoded)) {
      return decoded;
    }
    return value.includes("[") ? value : decoded || undefined;
  } catch {
    return value;
  }
}

async function fetchJson(url: string): Promise<unknown | undefined> {
  try {
    const response = await fetch(url, {
      headers: QQ_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    // QQ 接口常用 jsonp 包裹：MusicJsonCallback({...}) / callback({...})。
    const jsonText = stripJsonp(text);
    return JSON.parse(jsonText);
  } catch {
    return undefined;
  }
}

function stripJsonp(text: string): string {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start >= 0 && end > start && !text.trimStart().startsWith("{")) {
    return text.slice(start + 1, end);
  }
  return text;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}
