import { describe, expect, it } from "vitest";
import { extractBigIntField } from "../../src/modules/mi/xiaomi.client.js";

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
