import { afterEach, describe, expect, it, vi } from "vitest";
import type { HMusicTrack } from "../../src/shared/contracts.js";

const { sourceLyricMock } = vi.hoisted(() => ({
  sourceLyricMock: vi.fn(),
}));

vi.mock("../../src/modules/sources/sources.service.js", () => ({
  getSourceTrackLyric: sourceLyricMock,
}));

import {
  hasRealLyric,
  parseLrc,
  getLyricByTrack,
} from "../../src/modules/lyrics/lyrics.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hasRealLyric", () => {
  it("空结果或空 LRC 不算有词", () => {
    expect(hasRealLyric(undefined)).toBe(false);
    expect(hasRealLyric({ lrc: "" })).toBe(false);
    expect(hasRealLyric({ lrc: "[ti:标题]\n[00:01.00]\n" })).toBe(false);
  });

  it("「纯音乐请欣赏」占位词视作无词（wy 对有词歌曲也会错发）", () => {
    expect(
      hasRealLyric({ lrc: "[00:00:00]此歌曲为没有填词的纯音乐，请您欣赏" }),
    ).toBe(false);
    expect(hasRealLyric({ lrc: "纯音乐，请欣赏" })).toBe(false);
  });

  it("有正文歌词才算有词，占位句混在真词里不误伤", () => {
    expect(hasRealLyric({ lrc: "[00:01.00]第一句歌词" })).toBe(true);
    expect(
      hasRealLyric({
        lrc: "[00:00.00]纯音乐，请欣赏\n[00:05.00]其实这里有词",
      }),
    ).toBe(true);
  });
});

describe("parseLrc", () => {
  it("点号与冒号分隔的百分秒都解析", () => {
    expect(parseLrc("[01:23.45]一句")).toEqual([
      { timeMs: 83450, text: "一句" },
    ]);
    expect(parseLrc("[01:23:45]一句")).toEqual([
      { timeMs: 83450, text: "一句" },
    ]);
    expect(parseLrc("[00:00:00]开头")).toEqual([{ timeMs: 0, text: "开头" }]);
  });

  it("同行多标签展开为多行并按时间排序", () => {
    expect(parseLrc("[00:10.00][00:02.00]副歌")).toEqual([
      { timeMs: 2000, text: "副歌" },
      { timeMs: 10000, text: "副歌" },
    ]);
  });
});

describe("getLyricByTrack", () => {
  it("looks up device lyrics by title and artist without requiring an LX plugin", async () => {
    const lyricText = "[00:00.00]第一句\n[00:05.00]第二句";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("client_search_cp")) {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              data: { song: { list: [{ mid: "ABC123456789012" }] } },
            }),
        };
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            lyric: Buffer.from(lyricText, "utf8").toString("base64"),
            trans: "",
          }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    sourceLyricMock.mockResolvedValue(undefined);

    const track: HMusicTrack = {
      id: "device:external-audio-1",
      source: "device",
      sourceTrackId: "external-audio-1",
      title: "稻香",
      artist: "周杰伦",
    };
    const result = await getLyricByTrack(track);

    const searchUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(searchUrl.searchParams.get("w")).toBe("稻香 周杰伦");
    expect(sourceLyricMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      trackId: track.id,
      source: "qq-fallback",
      lrc: lyricText,
      lines: [
        { timeMs: 0, text: "第一句" },
        { timeMs: 5_000, text: "第二句" },
      ],
    });
  });
});
