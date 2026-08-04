import { describe, expect, it } from "vitest";
import { pickMatch } from "../../src/modules/library/library.scraper.js";

// 刮削匹配判定：错配的封面/歌词比空白更糟，所以宁缺毋滥。
describe("pickMatch", () => {
  const candidates = [
    { title: "海屿你", artist: "马也_Crabbit" },
    { title: "Always Online", artist: "林俊杰" },
  ];

  it("标题歌手都对上：命中", () => {
    expect(pickMatch(candidates, "Always Online", "林俊杰")?.title).toBe(
      "Always Online",
    );
  });

  it("大小写与空白差异不影响匹配", () => {
    expect(pickMatch(candidates, "always  online", "林俊杰")?.title).toBe(
      "Always Online",
    );
  });

  it("括注版本差异（Live/Remix）归一化后仍能对上", () => {
    const withSuffix = [{ title: "海屿你 (Live版)", artist: "马也_Crabbit" }];
    expect(pickMatch(withSuffix, "海屿你", "马也_Crabbit")).toBeDefined();
  });

  it("标题相同但歌手不符：拒绝，不做错配", () => {
    expect(pickMatch(candidates, "Always Online", "周杰伦")).toBeUndefined();
  });

  it("本地无歌手信息：只认标题", () => {
    expect(pickMatch(candidates, "海屿你", "")?.artist).toBe("马也_Crabbit");
  });

  it("标题对不上：一律不命中", () => {
    expect(pickMatch(candidates, "不存在的歌", "某人")).toBeUndefined();
  });

  it("空标题：拒绝（避免用空串匹配到任意一条）", () => {
    expect(pickMatch(candidates, "", "林俊杰")).toBeUndefined();
  });
});
