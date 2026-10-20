import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractBigIntField,
  fetchXiaoaiAudioInfo,
} from "../../src/modules/mi/xiaomi.client.js";

afterEach(() => vi.unstubAllGlobals());

describe("extractBigIntField", () => {
  it("preserves large integer nonce that JSON.parse would round off", () => {
    // 小米返回的 nonce 超过 2^53，JSON.parse 会丢精度。
    const raw =
      '&&&START&&&{"code":0,"nonce":1610098522385872896,"ssecurity":"abc"}';

    // 证明 JSON.parse 确实会丢精度（作为对照）。
    const parsed = JSON.parse(raw.replace("&&&START&&&", ""));
    expect(String(parsed.nonce)).not.toBe("1610098522385872896");

    // extractBigIntField 从原始文本按字符提取，精度不丢。
    expect(extractBigIntField(raw, "nonce")).toBe("1610098522385872896");
  });

  it("strips the &&&START&&& prefix before matching", () => {
    expect(extractBigIntField('&&&START&&&{"nonce":123}', "nonce")).toBe("123");
  });

  it("returns undefined when the field is absent or non-numeric", () => {
    expect(extractBigIntField('{"foo":"bar"}', "nonce")).toBeUndefined();
    expect(extractBigIntField('{"nonce":"abc"}', "nonce")).toBeUndefined();
  });
});

describe("fetchXiaoaiAudioInfo", () => {
  it("uses the AIVS3 endpoint and returns matching metadata for protocol 3 devices", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              deviceID: "audio-info-v3-device",
              capabilities: { ai_protocol_3_0: 1 },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: [
            {
              audio_id: "external-audio-1",
              title: "稻香",
              artist: "周杰伦",
              album: "魔杰座",
              duration: 223,
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchXiaoaiAudioInfo({
      session: { serviceToken: "secret", userId: "user", deviceId: "login" },
      deviceId: "audio-info-v3-device",
      audioId: "external-audio-1",
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api2.mina.mi.com/aivs3/audio/info",
    );
    expect(
      new URLSearchParams(
        fetchMock.mock.calls[1][1]?.body as URLSearchParams,
      ).get("audioIdList"),
    ).toBe('["external-audio-1"]');
    expect(result).toEqual({
      title: "稻香",
      artist: "周杰伦",
      album: "魔杰座",
      durationMs: 223000,
    });
  });

  it("uses music/song_info when protocol 3 is disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              deviceID: "audio-info-v2-device",
              capabilities: { ai_protocol_3_0: 0 },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: [{ id: "legacy-audio", title: "歌曲", artistName: "歌手" }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchXiaoaiAudioInfo({
      session: { serviceToken: "secret", userId: "user", deviceId: "login" },
      deviceId: "audio-info-v2-device",
      audioId: "legacy-audio",
    });

    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://api2.mina.mi.com/music/song_info",
    );
    expect(
      new URLSearchParams(
        fetchMock.mock.calls[1][1]?.body as URLSearchParams,
      ).get("songIdList"),
    ).toBe('["legacy-audio"]');
    expect(result).toMatchObject({ title: "歌曲", artist: "歌手" });
  });

  it("returns no details when Xiaomi has no result for an audio ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              deviceID: "audio-info-empty-device",
              capabilities: { ai_protocol_3_0: 1 },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchXiaoaiAudioInfo({
      session: { serviceToken: "secret", userId: "user", deviceId: "login" },
      deviceId: "audio-info-empty-device",
      audioId: "no-result-audio-id",
    });

    expect(result).toBeUndefined();
  });

  it("uses a single AIVS3 result when Xiaomi resolves an alias audio ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              deviceID: "audio-info-mismatch-device",
              capabilities: { ai_protocol_3_0: 1 },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: [
            {
              audioId: "canonical-audio-id",
              title: "沦陷",
              artistName: "王靖雯",
              albumName: "沦陷",
              duration: 230,
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchXiaoaiAudioInfo({
      session: { serviceToken: "secret", userId: "user", deviceId: "login" },
      deviceId: "audio-info-mismatch-device",
      audioId: "requested-audio-id",
    });

    expect(result).toEqual({
      title: "沦陷",
      artist: "王靖雯",
      album: "沦陷",
      durationMs: 230_000,
    });
  });
});
