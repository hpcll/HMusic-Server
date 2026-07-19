import { describe, expect, it } from "vitest";
import { detectRemoteTrackEnded } from "../../src/modules/playback/playback.service.js";

// 远端音箱自然播完检测（连播三道防线）。以 210s 曲为基准。
describe("detectRemoteTrackEnded", () => {
  const dur = 210000;

  it("A 近末主动：仍在播放但已进曲末 6s 窗口 → 判定播完", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "playing",
        durationMs: dur,
        prevPositionMs: 200000,
        curPositionMs: 205000,
      }),
    ).toBe(true);
  });

  it("A 不误触发：距曲末还有 10s 不判完", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "playing",
        durationMs: dur,
        prevPositionMs: 195000,
        curPositionMs: 200000,
      }),
    ).toBe(false);
  });

  it("B 转 idle：上次贴近曲末、这次 idle → 判定播完", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "idle",
        durationMs: dur,
        prevPositionMs: 208000,
        curPositionMs: 0,
      }),
    ).toBe(true);
  });

  it("B 不误触发：手动 stop（idle 但上次位置远离曲末）", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "idle",
        durationMs: dur,
        prevPositionMs: 60000,
        curPositionMs: 0,
      }),
    ).toBe(false);
  });

  it("C 位置跳跃：上次曲末、这次跳回曲头且仍在播放 → 判定播完", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "playing",
        durationMs: dur,
        prevPositionMs: 208000,
        curPositionMs: 2000,
      }),
    ).toBe(true);
  });

  it("非播放态起点（wasPlaying=false）一律不判完", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: false,
        deviceState: "playing",
        durationMs: dur,
        prevPositionMs: 209000,
        curPositionMs: 209500,
      }),
    ).toBe(false);
  });

  it("短曲（≤30s）不参与近末/跳跃主动检测，避免误切", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "playing",
        durationMs: 20000,
        prevPositionMs: 18000,
        curPositionMs: 19000,
      }),
    ).toBe(false);
  });

  it("无当前位置读数时近末/跳跃不触发（缺 position 的机型交给 idle 分支）", () => {
    expect(
      detectRemoteTrackEnded({
        wasPlaying: true,
        deviceState: "playing",
        durationMs: dur,
        prevPositionMs: 208000,
        curPositionMs: undefined,
      }),
    ).toBe(false);
  });
});
