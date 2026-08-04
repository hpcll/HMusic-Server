import { describe, expect, it } from "vitest";
import {
  libraryItemToTrack,
  type LibraryItem,
} from "../../src/modules/library/library.service.js";

// 曲库条目 → 可播 track 的身份契约：trackKey 决定 source/sourceTrackId，
// url 是 trackKey 签名的本地代理地址（重扫后 id 重生成也不断链）。
describe("libraryItemToTrack", () => {
  const base: Omit<LibraryItem, "trackKey" | "source"> = {
    id: "lib-1",
    origin: "scan",
    title: "晴天",
    artist: "周杰伦",
    album: "叶惠美",
    durationMs: 269000,
    coverUrl: undefined,
    fileExt: "flac",
    byteSize: 1024,
    createdAt: 1,
    updatedAt: 1,
  };

  it("扫描来源：local 身份 + trackKey 直达本地代理 url", () => {
    const track = libraryItemToTrack({
      ...base,
      trackKey: "local:abc123",
      source: "local",
    });
    expect(track.source).toBe("local");
    expect(track.sourceTrackId).toBe("abc123");
    expect(track.url).toContain("/api/v1/proxy/local/local:abc123.");
    expect(track.qualities).toEqual(["source"]);
  });

  it("下载来源：保留原平台身份（歌词/榜单标识按此匹配）", () => {
    const track = libraryItemToTrack({
      ...base,
      origin: "download",
      trackKey: "tx:001N8e5Q4Gjxda",
      source: "tx",
    });
    expect(track.source).toBe("tx");
    expect(track.sourceTrackId).toBe("001N8e5Q4Gjxda");
    expect(track.url).toContain("/api/v1/proxy/local/");
  });

  it("sourceTrackId 含冒号不丢段", () => {
    const track = libraryItemToTrack({
      ...base,
      trackKey: "local:a:b",
      source: "local",
    });
    expect(track.sourceTrackId).toBe("a:b");
  });
});
