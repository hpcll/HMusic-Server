import { describe, expect, it } from "vitest";
import {
  createMiAudioId,
  hasUnreliablePlayStatus,
  needsPlayMusicApi,
  playbackMediaContext,
  supportsSeek,
} from "../../src/modules/mi/mi.hardware.js";

describe("mi hardware helpers", () => {
  it("matches the direct-mode Xiaomi speaker playback rules", () => {
    expect(needsPlayMusicApi("L05B")).toBe(true);
    expect(needsPlayMusicApi("L06A")).toBe(true);
    expect(needsPlayMusicApi("LX06")).toBe(true);
    expect(needsPlayMusicApi("L15A")).toBe(true);
    expect(needsPlayMusicApi("L17A")).toBe(true);
    expect(needsPlayMusicApi("S12A")).toBe(false);
    expect(supportsSeek("OH2P")).toBe(false);
    expect(hasUnreliablePlayStatus("S12A")).toBe(true);
    expect(playbackMediaContext("S12A")).toBe("app_android");
    expect(playbackMediaContext("L06A")).toBe("app_ios");
  });

  it("supports user-supplied extra play_music models", () => {
    expect(needsPlayMusicApi("L20A")).toBe(false);
    expect(needsPlayMusicApi("L20A", ["L20A"])).toBe(true);
    // 大小写不敏感：自定义型号会被规范化为大写再比对
    expect(needsPlayMusicApi("l20a", ["l20a"])).toBe(true);
    expect(needsPlayMusicApi("S12A", ["L20A"])).toBe(false);
  });

  it("creates stable audio ids for player_play_music", () => {
    expect(
      createMiAudioId({
        url: "https://dl.stream.qqmusic.qq.com/C400003AY4bI2e5Y0Q.m4a",
      }),
    ).toBe("0003AY4bI2e5Y0Q");
    expect(
      createMiAudioId({ url: "https://example.com/a.mp3", title: "A" }),
    ).toBe(createMiAudioId({ url: "https://example.com/b.mp3", title: "A" }));
  });
});
