import { describe, expect, it } from "vitest";
import { pickPublicBaseUrl } from "../../src/shared/public-base-url.js";

describe("pickPublicBaseUrl", () => {
  it("keeps domain names untouched", () => {
    expect(
      pickPublicBaseUrl("https://music.example.com", ["192.168.1.155"]),
    ).toBe("https://music.example.com");
  });

  it("keeps an IPv4 that is still bound to a local interface", () => {
    expect(
      pickPublicBaseUrl("http://192.168.1.155:8090", [
        "192.168.1.155",
        "10.0.0.3",
      ]),
    ).toBe("http://192.168.1.155:8090");
  });

  it("replaces loopback with the current LAN address", () => {
    expect(pickPublicBaseUrl("http://127.0.0.1:8090", ["192.168.1.155"])).toBe(
      "http://192.168.1.155:8090",
    );
    expect(pickPublicBaseUrl("http://localhost:8090", ["192.168.1.155"])).toBe(
      "http://192.168.1.155:8090",
    );
  });

  it("replaces a stale IPv4 after a network switch", () => {
    expect(
      pickPublicBaseUrl("http://192.168.2.52:8090", ["192.168.1.155"]),
    ).toBe("http://192.168.1.155:8090");
  });

  it("keeps protocol and port when replacing the host", () => {
    expect(pickPublicBaseUrl("http://127.0.0.1:9000", ["192.168.1.155"])).toBe(
      "http://192.168.1.155:9000",
    );
  });

  it("prefers private ranges and skips link-local addresses", () => {
    expect(
      pickPublicBaseUrl("http://127.0.0.1:8090", [
        "169.254.10.2",
        "100.64.0.7",
        "192.168.1.155",
      ]),
    ).toBe("http://192.168.1.155:8090");
    expect(
      pickPublicBaseUrl("http://127.0.0.1:8090", ["172.20.0.9"]),
    ).toBe("http://172.20.0.9:8090");
  });

  it("falls back to the configured value when no LAN address exists", () => {
    expect(pickPublicBaseUrl("http://192.168.2.52:8090/", [])).toBe(
      "http://192.168.2.52:8090",
    );
    expect(
      pickPublicBaseUrl("http://127.0.0.1:8090", ["169.254.10.2"]),
    ).toBe("http://127.0.0.1:8090");
  });

  it("never returns a trailing slash", () => {
    expect(pickPublicBaseUrl("http://127.0.0.1:8090/", ["192.168.1.155"])).toBe(
      "http://192.168.1.155:8090",
    );
    expect(
      pickPublicBaseUrl("https://music.example.com/", ["192.168.1.155"]),
    ).toBe("https://music.example.com");
  });
});
