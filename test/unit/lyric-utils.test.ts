import { describe, expect, it } from "vitest";
import {
  activeLyricIndex,
  lyricLookupKey,
  lyricTrackKey,
} from "../../web/lyric-utils.js";

describe("activeLyricIndex", () => {
  const lines = [
    { timeMs: 0, text: "开头" },
    { timeMs: 5_000, text: "第二句" },
    { timeMs: 12_500, text: "第三句" },
  ];

  it("selects the line at or before the current positionMs", () => {
    expect(activeLyricIndex(lines, 4_999)).toBe(0);
    expect(activeLyricIndex(lines, 5_000)).toBe(1);
    expect(activeLyricIndex(lines, 12_700)).toBe(2);
  });

  it("starts before the first timestamp when the song position resets", () => {
    expect(activeLyricIndex(lines.slice(1), 0)).toBe(-1);
  });
});

describe("lyricTrackKey", () => {
  it("changes when an external device reports a different audio ID", () => {
    expect(
      lyricTrackKey({ source: "device", sourceTrackId: "external-audio-1" }),
    ).not.toBe(
      lyricTrackKey({ source: "device", sourceTrackId: "external-audio-2" }),
    );
    expect(lyricTrackKey(undefined)).toBe("");
  });
});

describe("lyricLookupKey", () => {
  it("changes when metadata is hydrated while the device audio ID stays the same", () => {
    const unknownTrack = {
      source: "device",
      sourceTrackId: "same-audio-id",
      title: "未知歌曲",
      artist: "未知艺术家",
    };
    expect(lyricLookupKey(unknownTrack)).not.toBe(
      lyricLookupKey({ ...unknownTrack, title: "夜曲", artist: "周杰伦" }),
    );
    expect(lyricLookupKey({ source: "kw", sourceTrackId: "song-1" })).toBe(
      lyricTrackKey({ source: "kw", sourceTrackId: "song-1" }),
    );
  });
});
