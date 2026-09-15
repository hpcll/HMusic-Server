import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let dataDir: string;
let svc: typeof import("../../src/modules/spotify/spotify.service.js");

const CIPHER = [11, 22, 33, 44, 55, 66, 77, 88, 99, 12];

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-spotify-pathfinder-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "spotify-pathfinder-test-secret";
  process.env.SPOTIFY_DATA_API = "pathfinder";
  svc = await import("../../src/modules/spotify/spotify.service.js");
  const database = await import("../../src/db/index.js");
  database.ensureSchema();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

afterEach(async () => {
  await svc.clearSession();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(
  responses: Array<
    (input: string | URL | Request, init?: RequestInit) => Response
  >,
) {
  let index = 0;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const response = responses[index++];
    if (!response) throw new Error("unexpected upstream request");
    return Promise.resolve(response(input, init));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function tokenResponse() {
  return jsonResponse({
    accessToken: "web-access-token",
    accessTokenExpirationTimestampMs: Date.now() + 3600_000,
    isAnonymous: false,
  });
}

function clientTokenResponse() {
  return jsonResponse({
    response_type: "token",
    granted_token: {
      token: "client-token",
      expires_after_seconds: 3600,
      refresh_after_seconds: 1800,
      domains: ["api-partner.spotify.com"],
    },
  });
}

describe("Spotify Pathfinder", () => {
  it("读取常听曲目并发送 Web Player persisted query", async () => {
    const fetchMock = stubFetch([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () => clientTokenResponse(),
      () =>
        jsonResponse({
          data: {
            me: {
              profile: {
                topTracks: {
                  totalCount: 2,
                  items: [
                    {
                      data: {
                        __typename: "Track",
                        uri: "spotify:track:abc123",
                        name: "示例曲目",
                        artists: { items: [{ profile: { name: "示例歌手" } }] },
                        albumOfTrack: {
                          name: "示例专辑",
                          coverArt: { sources: [{ url: "https://img/cover" }] },
                        },
                        duration: { totalMilliseconds: 123000 },
                      },
                    },
                    {
                      data: {
                        __typename: "Episode",
                        uri: "spotify:episode:nope",
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
    ]);

    await svc.linkSession("pathfinder-cookie");
    const page = await svc.topTracks("short_term", 25, 0);
    expect(page.items).toEqual([
      {
        id: "abc123",
        title: "示例曲目",
        artist: "示例歌手",
        album: "示例专辑",
        durationMs: 123000,
        coverUrl: "https://img/cover",
        uri: "spotify:track:abc123",
      },
    ]);
    const request = fetchMock.mock.calls[3];
    expect(String(request[0])).toBe(
      "https://api-partner.spotify.com/pathfinder/v2/query",
    );
    const body = JSON.parse(String(request[1]?.body));
    expect(body.operationName).toBe("userTopContent");
    expect(body.variables.topTracksInput).toMatchObject({
      offset: 0,
      limit: 25,
      sortBy: "AFFINITY",
      timeRange: "SHORT_TERM",
    });
    expect(request[1]?.headers).toMatchObject({
      Authorization: "Bearer web-access-token",
      "Client-Token": "client-token",
      "Spotify-App-Version": "1.3.0.272.g0535e37-development",
      "App-Platform": "WebPlayer",
    });
  });

  it("半年常听使用 Spotify 当前的 MID_TERM 周期值", async () => {
    const fetchMock = stubFetch([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () => clientTokenResponse(),
      () =>
        jsonResponse({
          data: {
            me: {
              profile: {
                topTracks: { totalCount: 0, items: [] },
              },
            },
          },
        }),
    ]);

    await svc.linkSession("pathfinder-cookie");
    await svc.topTracks("medium_term", 25, 0);

    const body = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(body.variables.topArtistsInput.timeRange).toBe("MID_TERM");
    expect(body.variables.topTracksInput.timeRange).toBe("MID_TERM");
  });

  it("解析个人歌单与歌单曲目", async () => {
    stubFetch([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () => clientTokenResponse(),
      () =>
        jsonResponse({
          data: {
            me: {
              libraryV3: {
                totalCount: 1,
                items: [
                  {
                    item: {
                      data: {
                        __typename: "Playlist",
                        uri: "spotify:playlist:list123",
                        name: "我的歌单",
                        images: {
                          items: [{ sources: [{ url: "https://img/list" }] }],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      () =>
        jsonResponse({
          data: {
            playlistV2: {
              content: {
                totalCount: 1,
                items: [
                  {
                    itemV2: {
                      data: {
                        __typename: "Track",
                        uri: "spotify:track:track123",
                        name: "歌单曲目",
                        artists: { items: [{ profile: { name: "歌手" } }] },
                        albumOfTrack: { name: "专辑" },
                        trackDuration: { totalMilliseconds: 2000 },
                        playability: { playable: true },
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
    ]);
    await svc.linkSession("pathfinder-cookie");
    await expect(svc.userPlaylists(50)).resolves.toMatchObject({
      total: 1,
      items: [
        { id: "list123", name: "我的歌单", coverUrl: "https://img/list" },
      ],
    });
    await expect(svc.playlistTracks("list123", 100)).resolves.toMatchObject({
      total: 1,
      items: [{ id: "track123", title: "歌单曲目", durationMs: 2000 }],
    });
  });

  it("把 Pathfinder 429 映射为统一限流错误", async () => {
    stubFetch([
      () => jsonResponse({ "42": CIPHER }),
      () => tokenResponse(),
      () => clientTokenResponse(),
      () =>
        jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "60" }),
    ]);
    await svc.linkSession("pathfinder-cookie");
    await expect(svc.userPlaylists(50)).rejects.toMatchObject({
      code: "SPOTIFY_RATE_LIMITED",
      statusCode: 429,
      details: { retryAfterMs: 60_000 },
    });
  });
});
