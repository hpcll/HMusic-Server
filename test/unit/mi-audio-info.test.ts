import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStoredMiSession: vi.fn(),
  markMiSessionExpiredIfUnauthorized: vi.fn(),
  fetchXiaoaiAudioInfo: vi.fn(),
}));

vi.mock("../../src/modules/mi/mi.service.js", () => ({
  getStoredMiSession: mocks.getStoredMiSession,
  markMiSessionExpiredIfUnauthorized: mocks.markMiSessionExpiredIfUnauthorized,
}));
vi.mock("../../src/modules/mi/xiaomi.client.js", () => ({
  fetchXiaoaiAudioInfo: mocks.fetchXiaoaiAudioInfo,
}));

import { getDeviceAudioInfo } from "../../src/modules/mi/audio-info.service.js";

describe("getDeviceAudioInfo", () => {
  beforeEach(() => {
    mocks.getStoredMiSession.mockReset().mockResolvedValue({
      serviceToken: "test-token",
      userId: "test-user",
      deviceId: "test-login-device",
    });
    mocks.markMiSessionExpiredIfUnauthorized
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.fetchXiaoaiAudioInfo.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches a successful audio ID lookup across playback progress reads", async () => {
    const detail = { title: "歌曲", artist: "歌手", durationMs: 180_000 };
    mocks.fetchXiaoaiAudioInfo.mockResolvedValue(detail);

    await expect(
      getDeviceAudioInfo("device-cache-positive", "cache-positive-audio"),
    ).resolves.toEqual(detail);
    await expect(
      getDeviceAudioInfo("device-cache-positive", "cache-positive-audio"),
    ).resolves.toEqual(detail);

    expect(mocks.fetchXiaoaiAudioInfo).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a missing result instead of querying on every refresh", async () => {
    mocks.fetchXiaoaiAudioInfo.mockResolvedValue(undefined);

    await expect(
      getDeviceAudioInfo("device-cache-empty", "cache-empty-audio"),
    ).resolves.toBeUndefined();
    await expect(
      getDeviceAudioInfo("device-cache-empty", "cache-empty-audio"),
    ).resolves.toBeUndefined();

    expect(mocks.fetchXiaoaiAudioInfo).toHaveBeenCalledTimes(1);
  });

  it("retries a missing audio ID after a short negative-cache window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10_000);
    const detail = { title: "后来识别出的歌曲", artist: "歌手" };
    mocks.fetchXiaoaiAudioInfo
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(detail);

    await expect(
      getDeviceAudioInfo("device-cache-retry", "cache-retry-audio"),
    ).resolves.toBeUndefined();
    await expect(
      getDeviceAudioInfo("device-cache-retry", "cache-retry-audio"),
    ).resolves.toBeUndefined();
    expect(mocks.fetchXiaoaiAudioInfo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 15_001);
    await expect(
      getDeviceAudioInfo("device-cache-retry", "cache-retry-audio"),
    ).resolves.toEqual(detail);
    expect(mocks.fetchXiaoaiAudioInfo).toHaveBeenCalledTimes(2);
  });
});
