import { describe, expect, it } from "vitest";
import { canCalibrateAutoNext } from "../../src/modules/playback/playback.service.js";

// 连播时长定时器的前半段校准窗口（参考实现 canCalibrateAutoNextTimer 规则）。
// 以 210s 曲为基准。
describe("canCalibrateAutoNext", () => {
  const dur = 210000;

  it("播放早期（已播 20s、设备位置一致）→ 允许校准", () => {
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: dur,
        elapsedSec: 20,
        devicePositionSec: 22,
      }),
    ).toBe(true);
  });

  it("非播放态不校准", () => {
    expect(
      canCalibrateAutoNext({
        state: "paused",
        durationMs: dur,
        elapsedSec: 20,
        devicePositionSec: 22,
      }),
    ).toBe(false);
  });

  it("已过半（elapsed ≥ duration/2）不校准", () => {
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: dur,
        elapsedSec: 120,
        devicePositionSec: 120,
      }),
    ).toBe(false);
  });

  it("曲末 15s 内不校准（防自循环无限推迟）", () => {
    // 短曲 40s：已播 30s，剩 10s ≤15 → 不校准。
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: 40000,
        elapsedSec: 30,
        devicePositionSec: 30,
      }),
    ).toBe(false);
  });

  it("已播一段后设备回到开头（自循环重拉）不校准", () => {
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: dur,
        elapsedSec: 40,
        devicePositionSec: 1,
      }),
    ).toBe(false);
  });

  it("时长无效不校准", () => {
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: 0,
        elapsedSec: 20,
        devicePositionSec: 20,
      }),
    ).toBe(false);
  });

  it("短曲上限 45s：60s 曲已播 30s（>45*0.5 但 <45）仍允许", () => {
    // durationSec=60, 阈值 max(45, 30)=45，elapsed=30 <45 且剩 30>15 → 允许。
    expect(
      canCalibrateAutoNext({
        state: "playing",
        durationMs: 60000,
        elapsedSec: 30,
        devicePositionSec: 31,
      }),
    ).toBe(true);
  });
});
