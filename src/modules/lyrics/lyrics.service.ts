import type { HMusicLyric, HMusicTrack } from "../../shared/contracts.js";
import { getPlaybackState } from "../playback/playback.service.js";
import { getQueue } from "../queue/queue.service.js";
import { getSourceTrackLyric } from "../sources/sources.service.js";

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
  const result = await getSourceTrackLyric(track);
  if (!result) return getEmptyLyric(track.id);

  return {
    trackId: track.id,
    source: track.source,
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

function parseLrc(lrc: string): HMusicLyric["lines"] {
  const lines: HMusicLyric["lines"] = [];
  for (const rawLine of lrc.split(/\r?\n/)) {
    const text = rawLine
      .replace(/(?:\[\d{1,2}:\d{2}(?:\.\d{1,3})?\])+/g, "")
      .trim();
    const matches = rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g);
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
