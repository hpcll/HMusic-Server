import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getToken, setToken } from "../../web/api.js";

let unauthorized: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  const events = new EventTarget();
  unauthorized = vi.fn();
  events.addEventListener("hmusic:unauthorized", unauthorized);
  vi.stubGlobal("window", events);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respondUnauthorized(code?: string, message = "凭据无效") {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(code ? JSON.stringify({ error: { code, message } }) : "", {
      status: 401,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Web API 登录状态隔离", () => {
  it.each([
    ["/spotify/session", "POST"],
    ["/spotify/recommendations?limit=50&offset=0", "GET"],
    ["/spotify/playlists/example/play", "POST"],
  ])("Spotify Cookie 失效保留 HMusic 登录：%s", async (path, method) => {
    setToken("hmusic-test-token");
    const fetchMock = respondUnauthorized(
      "SPOTIFY_SESSION_INVALID",
      "Spotify 登录已失效，请重新绑定",
    );

    await expect(api(path, { method })).rejects.toMatchObject({
      code: "SPOTIFY_SESSION_INVALID",
      statusCode: 401,
      message: "Spotify 登录已失效，请重新绑定",
    });
    expect(getToken()).toBe("hmusic-test-token");
    expect(unauthorized).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1${path}`,
      expect.objectContaining({
        method,
        headers: { Authorization: "Bearer hmusic-test-token" },
      }),
    );
  });

  it.each([
    ["/spotify/session", "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED"],
    ["/spotify/recommendations", "UNAUTHORIZED"],
    ["/spotify/playlists", undefined],
    ["/config", "SPOTIFY_SESSION_INVALID"],
    ["/spotify-other/session", "SPOTIFY_SESSION_INVALID"],
  ])("HMusic 或网关认证失败仍退出登录：%s (%s)", async (path, code) => {
    setToken("expired-test-token");
    respondUnauthorized(code);

    await expect(api(path)).rejects.toMatchObject({ statusCode: 401 });
    expect(getToken()).toBe("");
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("未登录时保留登录接口的凭据错误说明", async () => {
    respondUnauthorized("INVALID_CREDENTIALS", "用户名或密码错误");

    await expect(api("/auth/login", { method: "POST" })).rejects.toMatchObject({
      message: "用户名或密码错误",
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
