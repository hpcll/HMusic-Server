import { describe, expect, it } from "vitest";
import {
  hasRealLyric,
  parseLrc,
} from "../../src/modules/lyrics/lyrics.service.js";

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
