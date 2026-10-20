import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("../../web/api.js", () => ({ api: mocks.api }));

import { ensureLyric, lyric, lyricLoading } from "../../web/lyric-state.js";

afterEach(() => {
  mocks.api.mockReset();
  lyric.value = null;
  lyricLoading.value = false;
});

describe("ensureLyric", () => {
  it("retries lyrics when device metadata arrives for the same audio ID", async () => {
    const unknownTrack = {
      source: "device",
      sourceTrackId: "same-audio-id",
      title: "未知歌曲",
      artist: "未知艺术家",
    };
    const identifiedTrack = {
      ...unknownTrack,
      title: "夜曲",
      artist: "周杰伦",
    };
    const noLyric = { trackId: "device:same-audio-id", lines: [] };
    const foundLyric = {
      trackId: "device:same-audio-id",
      lines: [{ timeMs: 0, text: "歌词" }],
    };
    mocks.api.mockResolvedValueOnce(noLyric).mockResolvedValueOnce(foundLyric);

    await ensureLyric(unknownTrack);
    expect(lyric.value).toEqual(noLyric);

    await ensureLyric(identifiedTrack);

    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(mocks.api.mock.calls[1][1].body.track).toEqual(identifiedTrack);
    expect(lyric.value).toEqual(foundLyric);
  });

  it("clears lyrics on track change and ignores a late response for the old track", async () => {
    const oldTrack = {
      source: "device",
      sourceTrackId: "old-audio-id",
    };
    const nextTrack = {
      source: "device",
      sourceTrackId: "next-audio-id",
    };
    const newestTrack = {
      source: "device",
      sourceTrackId: "newest-audio-id",
    };
    const oldLyric = { trackId: "device:old-audio-id", lines: [] };
    const staleLyric = { trackId: "device:next-audio-id", lines: [] };
    const newestLyric = { trackId: "device:newest-audio-id", lines: [] };
    let resolveStale!: (value: typeof staleLyric) => void;
    mocks.api.mockImplementation((_path, { body }) => {
      const id = body.track.sourceTrackId;
      if (id === oldTrack.sourceTrackId) return Promise.resolve(oldLyric);
      if (id === nextTrack.sourceTrackId) {
        return new Promise((resolve) => {
          resolveStale = resolve;
        });
      }
      return Promise.resolve(newestLyric);
    });

    await ensureLyric(oldTrack);
    expect(lyric.value).toEqual(oldLyric);

    const staleRequest = ensureLyric(nextTrack);
    expect(lyric.value).toBeNull();
    expect(lyricLoading.value).toBe(true);

    await ensureLyric(newestTrack);
    expect(lyric.value).toEqual(newestLyric);
    expect(lyricLoading.value).toBe(false);

    resolveStale(staleLyric);
    await staleRequest;
    expect(lyric.value).toEqual(newestLyric);
  });
});
