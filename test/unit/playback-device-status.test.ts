import { describe, expect, it } from "vitest";
import type { HMusicTrack } from "../../src/shared/contracts.js";
import {
  parseDevicePlaybackStatus,
  shouldReResolveTrackOnResume,
} from "../../src/modules/playback/playback.service.js";
import { createMiAudioId } from "../../src/modules/mi/mi.hardware.js";

function statusFor(audioId: string, detail: Record<string, unknown> = {}) {
  return {
    data: {
      info: {
        status: 1,
        play_song_detail: {
          audio_id: audioId,
          position: 42_000,
          ...detail,
        },
      },
    },
  };
}

describe("parseDevicePlaybackStatus", () => {
  it.each(["external-audio-1", "external-audio-2"])(
    "uses the new external audio ID %s instead of the previous device track",
    (audioId) => {
      const previous: HMusicTrack = {
        id: "device:previous-audio",
        source: "device",
        sourceTrackId: "previous-audio",
        title: "旧歌曲",
        artist: "旧歌手",
        album: "旧专辑",
        durationMs: 200_000,
        url: "https://example.com/old-song.mp3",
      };

      const result = parseDevicePlaybackStatus(statusFor(audioId), previous);

      expect(result?.track).toMatchObject({
        id: `device:${audioId}`,
        source: "device",
        sourceTrackId: audioId,
        title: "未知歌曲",
        artist: "未知艺术家",
      });
      expect(result?.track?.album).toBeUndefined();
      expect(result?.track?.durationMs).toBeUndefined();
      expect(result?.track?.url).toBeUndefined();
      expect(result?.positionMs).toBe(42_000);
    },
  );

  it("retains HMusic metadata and identity for an internally generated audio ID", () => {
    const title = "HMusic 内部播放";
    const audioId = createMiAudioId({ url: "", title });
    const previous: HMusicTrack = {
      id: "kw:track-11",
      source: "kw",
      sourceTrackId: "track-11",
      title,
      artist: "原始歌手",
      album: "原始专辑",
      durationMs: 240_000,
      coverUrl: "https://example.com/cover.jpg",
      url: "https://example.com/stream.mp3",
      qualities: ["128k"],
      raw: { source: "kw", marker: "preserve" },
    };

    const result = parseDevicePlaybackStatus(
      statusFor(audioId, {
        title: "设备上报标题",
        artist: "设备上报歌手",
        album: "设备上报专辑",
      }),
      previous,
    );

    expect(result?.track).toEqual(previous);
  });

  it("uses the original URL when matching an internally played QQ audio ID", () => {
    const url = "https://isure.stream.qqmusic.qq.com/C400MUSICID.m4a";
    const audioId = createMiAudioId({ url, title: "HMusic QQ 曲目" });
    const previous: HMusicTrack = {
      id: "qq:track-12",
      source: "qq",
      sourceTrackId: "track-12",
      title: "HMusic QQ 曲目",
      artist: "原始歌手",
      url,
    };

    const result = parseDevicePlaybackStatus(
      statusFor(audioId, { title: "设备上报标题" }),
      previous,
    );

    expect(result?.track).toEqual(previous);
  });
});

describe("shouldReResolveTrackOnResume", () => {
  it("does not resolve a Xiaomi-native device track after the URL TTL", () => {
    expect(
      shouldReResolveTrackOnResume(
        { id: "device:1", source: "device", sourceTrackId: "1", title: "歌" },
        0,
        20 * 60 * 1000 + 1,
      ),
    ).toBe(false);
  });

  it("re-resolves an HMusic track after the URL TTL", () => {
    expect(
      shouldReResolveTrackOnResume(
        { id: "tx:1", source: "tx", sourceTrackId: "1", title: "歌" },
        0,
        20 * 60 * 1000 + 1,
      ),
    ).toBe(true);
  });
});
