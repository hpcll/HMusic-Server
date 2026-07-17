import type { HMusicLyric, HMusicTrack } from "../../shared/contracts.js";
import { getPlaybackState } from "../playback/playback.service.js";
import { getQueue } from "../queue/queue.service.js";
import type { LxLyricResult } from "../sources/lx-plugin.runtime.js";
import { getSourceTrackLyric } from "../sources/sources.service.js";
import { fetchFallbackLyric } from "./lyric-providers.js";

// 「纯音乐，请欣赏」占位词不算真歌词：音源曲库匹配错位时，有词歌曲也会收到
// 这句（wy 系接口的固定占位文案），必须当作取词失败再走兜底源。
const PLACEHOLDER_LINE = /纯音乐[，,]?\s*请(您)?欣赏/;

// 有可用歌词 = 去掉全部 [标签] 后仍有正文，且正文不全是占位词。
export function hasRealLyric(
  result: LxLyricResult | undefined,
): result is LxLyricResult {
  if (!result) return false;
  const lines = result.lrc
    .split(/\r?\n/)
    .map((line) => line.replace(/\[[^\]]*\]/g, "").trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return !lines.every((line) => PLACEHOLDER_LINE.test(line));
}

export async function getEmptyLyric(trackId: string): Promise<HMusicLyric> {
  return {
    trackId,
    source: "none",
    lrc: "",
    lines: [],
    translatedLines: [],
    updatedAt: Date.now(),
  };
}

export async function getLyricByTrack(
  track: HMusicTrack,
): Promise<HMusicLyric> {
  // 先问音源插件；取不到词或只拿到「纯音乐」占位词时走 QQ 兜底源。
  let result = await getSourceTrackLyric(track);
  let source = track.source;
  if (!hasRealLyric(result)) {
    const fallback = await fetchFallbackLyric(track);
    if (hasRealLyric(fallback)) {
      result = fallback;
      source = "qq-fallback";
    }
  }
  if (!hasRealLyric(result)) return getEmptyLyric(track.id);

  return {
    trackId: track.id,
    source,
    lrc: result.lrc,
    lines: parseLrc(result.lrc),
    translatedLines: parseLrc(result.translatedLrc || ""),
    updatedAt: Date.now(),
  };
}

export async function getLyricByTrackId(trackId: string): Promise<HMusicLyric> {
  const track = await findKnownTrack(trackId);
  if (!track) return getEmptyLyric(trackId);
  return getLyricByTrack(track);
}

async function findKnownTrack(
  trackId: string,
): Promise<HMusicTrack | undefined> {
  const playback = await getPlaybackState();
  if (matchesTrackId(playback.track, trackId)) return playback.track;

  const queue = await getQueue();
  return queue.items.find((item) => matchesTrackId(item.track, trackId))?.track;
}

function matchesTrackId(
  track: HMusicTrack | undefined,
  trackId: string,
): track is HMusicTrack {
  return (
    !!track &&
    (track.id === trackId ||
      track.sourceTrackId === trackId ||
      `${track.source}:${track.sourceTrackId}` === trackId)
  );
}

// 行级时间标签同时接受 [mm:ss.xx] 与老式 [mm:ss:xx]（冒号分隔百分秒，
// wy 系接口常用）；解析不出任何行时客户端才降级整段展示。
export function parseLrc(lrc: string): HMusicLyric["lines"] {
  const lines: HMusicLyric["lines"] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const text = rawLine
      .replace(/(?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+/g, "")
      .trim();
    const matches = rawLine.matchAll(
      /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g,
    );
    for (const match of matches) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] || "0";
      const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
      if (Number.isNaN(minutes) || Number.isNaN(seconds)) continue;
      lines.push({
        timeMs: (minutes * 60 + seconds) * 1000 + milliseconds,
        text,
      });
    }
  }

  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
