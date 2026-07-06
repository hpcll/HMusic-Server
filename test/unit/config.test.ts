import { describe, expect, it } from "vitest";
import { defaultRuntimeConfig } from "../../src/modules/config/config.service.js";

describe("defaultRuntimeConfig", () => {
  it("uses conservative defaults", () => {
    expect(defaultRuntimeConfig.defaultQuality).toBe("320k");
    expect(defaultRuntimeConfig.searchStrategy).toBe("qqFirst");
    expect(defaultRuntimeConfig.resolveStrategy).toBe("originalFirst");
  });
});
