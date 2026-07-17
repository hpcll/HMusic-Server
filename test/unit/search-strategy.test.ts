import { describe, expect, it } from "vitest";
import {
  isSameSong,
  resolveAttemptOrder,
  searchPlatformOrder,
} from "../../src/modules/search/search.service.js";
import type { HMusicTrack } from "../../src/shared/contracts.js";

function track(input: Partial<HMusicTrack>): HMusicTrack {
  return {
    id: "wy:1",
    source: "wy",
    sourceTrackId: "1",
    title: "晴天",
    artist: "周杰伦",
    ...input,
  };
}

describe("searchPlatformOrder", () => {
  it("按策略排平台领先顺序", () => {
    expect(searchPlatformOrder("qqFirst")).toEqual(["tx", "kw", "wy"]);
    expect(searchPlatformOrder("kuwoFirst")).toEqual(["kw", "tx", "wy"]);
    expect(searchPlatformOrder("neteaseFirst")).toEqual(["wy", "tx", "kw"]);
  });
});

describe("resolveAttemptOrder", () => {
  it("originalFirst 只解析原始音源", () => {
    expect(resolveAttemptOrder("originalFirst", "wy")).toEqual(["original"]);
  });

  it("偏好平台优先，失败回落原源", () => {
    expect(resolveAttemptOrder("qqFirst", "wy")).toEqual(["tx", "original"]);
    expect(resolveAttemptOrder("neteaseFirst", "kg")).toEqual([
      "wy",
      "original",
    ]);
  });

  it("偏好平台就是原源时不重复尝试", () => {
    expect(resolveAttemptOrder("qqFirst", "tx")).toEqual(["original"]);
  });
});

describe("isSameSong", () => {
  const target = track({});

  it("同名同歌手命中，容忍括号后缀与分隔差异", () => {
    expect(
      isSameSong(track({ source: "tx", title: "晴天", artist: "周杰伦" }), target),
    ).toBe(true);
    expect(
      isSameSong(
        track({ source: "tx", title: "晴天 (Live)", artist: "周杰伦/五月天" }),
        target,
      ),
    ).toBe(true);
  });

  it("不同歌名或歌手完全对不上时拒绝", () => {
    expect(
      isSameSong(track({ source: "tx", title: "夜曲", artist: "周杰伦" }), target),
    ).toBe(false);
    expect(
      isSameSong(track({ source: "tx", title: "晴天", artist: "王力宏" }), target),
    ).toBe(false);
  });

  it("候选缺歌手信息时按标题放行", () => {
    expect(
      isSameSong(track({ source: "tx", title: "晴天", artist: "" }), target),
    ).toBe(true);
  });
});
