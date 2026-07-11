import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-server-test-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "hmusic.db");
  process.env.HMUSIC_JWT_SECRET = "integration-test-secret";
  process.env.HMUSIC_PUBLIC_BASE_URL = "http://127.0.0.1:8090";
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("api contract", () => {
  it("protects runtime APIs and exposes initial server contracts", async () => {
    const fixturePluginCode = `
        module.exports.search = function(query) {
          return [{
            id: "fixture-song",
            title: "LX Fixture Song",
            artist: "LX Artist",
            duration: "03:30"
          }];
        };
        module.exports.getUrl = function(track) {
          if (track.platform === "tx" && track.songmid === "client-songmid") {
            return { url: "https://example.com/client-origin.mp3" };
          }
          return { url: "https://example.com/lx-fixture.mp3" };
        };
        module.exports.getLyric = function(track) {
          return {
            lrc: "[00:01.00]LX line one\\n[00:02.50]LX line two",
            tlyric: "[00:01.00]译文一"
          };
        };
      `;
    const lxEventPluginCode = `
        lx.on(lx.EVENT_NAMES.request, async function(request) {
          if (request.action === "musicUrl" && request.info.musicInfo.songmid === "event-song") {
            return {
              data: {
                url: "https://example.com/lx-event.mp3"
              }
            };
          }
          if (request.action === "lyric" && request.info.musicInfo.songmid === "event-song") {
            return {
              lyric: "[00:03.00]LX event line",
              tlyric: "[00:03.00]LX event translated"
            };
          }
        });
      `;

    const { buildApp } = await import("../../src/app.js");
    const app = await buildApp();

    try {
      const info = await app.inject({
        method: "GET",
        url: "/api/v1/system/info",
      });
      expect(info.statusCode).toBe(200);
      expect(info.json().capabilities.playback).toBe(true);

      const testTone = await app.inject({
        method: "GET",
        url: "/api/v1/system/test-tone.wav",
      });
      expect(testTone.statusCode).toBe(200);
      expect(testTone.headers["content-type"]).toContain("audio/wav");
      expect(testTone.body.slice(0, 4)).toBe("RIFF");

      const testToneRange = await app.inject({
        method: "GET",
        url: "/api/v1/system/test-tone.wav",
        headers: {
          range: "bytes=0-3",
        },
      });
      expect(testToneRange.statusCode).toBe(206);
      expect(testToneRange.headers["content-range"]).toMatch(/^bytes 0-3\//);
      expect(testToneRange.body).toBe("RIFF");

      const adminPage = await app.inject({
        method: "GET",
        url: "/admin",
      });
      expect(adminPage.statusCode).toBe(200);
      expect(adminPage.headers["content-type"]).toContain("text/html");
      expect(adminPage.body).toContain("HMusic Server 管理");
      expect(adminPage.body).toContain("运行配置");
      expect(adminPage.body).toContain("LX 插件");
      expect(adminPage.body).toContain("搜索与播放测试");
      expect(adminPage.body).toContain("导入已有小米会话");
      expect(adminPage.body).toContain("链路诊断");
      expect(adminPage.body).toContain("播放测试音频");
      expect(adminPage.body).toContain("网页登录验证");
      expect(adminPage.body).toContain("自动接收登录结果");
      expect(adminPage.body).not.toContain("验证完成地址");
      const scriptStart =
        adminPage.body.indexOf("<script>") + "<script>".length;
      const scriptEnd = adminPage.body.lastIndexOf("</script>");
      expect(scriptStart).toBeGreaterThanOrEqual("<script>".length);
      expect(scriptEnd).toBeGreaterThan(scriptStart);
      expect(
        () => new Script(adminPage.body.slice(scriptStart, scriptEnd)),
      ).not.toThrow();

      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
      });
      expect(unauthorized.statusCode).toBe(401);

      const setup = await app.inject({
        method: "POST",
        url: "/api/v1/auth/setup",
        payload: {
          username: "admin",
          password: "integration-password",
        },
      });
      expect(setup.statusCode).toBe(200);
      const token = setup.json().accessToken as string;
      const headers = { authorization: `Bearer ${token}` };
      const basicHeaders = {
        authorization: `Basic ${Buffer.from("admin:integration-password").toString("base64")}`,
      };

      const compatUnauthorized = await app.inject({
        method: "GET",
        url: "/getversion",
      });
      expect(compatUnauthorized.statusCode).toBe(401);

      const compatVersion = await app.inject({
        method: "GET",
        url: "/getversion",
        headers: basicHeaders,
      });
      expect(compatVersion.statusCode).toBe(200);
      expect(compatVersion.json()).toEqual(
        expect.objectContaining({
          server: "hmusic",
          name: "HMusic Server",
        }),
      );

      const devices = await app.inject({
        method: "GET",
        url: "/api/v1/devices",
        headers,
      });
      expect(devices.statusCode).toBe(200);
      // 未登录小米也恒有「本机播放」虚拟设备，且空库时它就是默认设备。
      const deviceList = devices.json().devices;
      expect(deviceList).toHaveLength(1);
      expect(deviceList[0]).toMatchObject({
        id: "local-browser",
        isDefault: true,
        isOnline: true,
      });

      const miStatus = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(miStatus.statusCode).toBe(200);
      expect(miStatus.json().loggedIn).toBe(false);

      const configPatch = await app.inject({
        method: "PATCH",
        url: "/api/v1/config",
        headers,
        payload: {
          manualTracks: [
            {
              id: "manual-track",
              title: "Manual Song",
              artist: "HMusic",
              durationMs: 120000,
              url: "https://example.com/manual.mp3",
            },
          ],
        },
      });
      expect(configPatch.statusCode).toBe(200);
      expect(configPatch.json().manualTracks).toHaveLength(1);

      const savedPlugin = await app.inject({
        method: "POST",
        url: "/api/v1/sources/lx-plugins",
        headers,
        payload: {
          id: "fixture-lx",
          name: "Fixture LX",
          code: fixturePluginCode,
          enabled: true,
          defaultQuality: "320k",
        },
      });
      expect(savedPlugin.statusCode).toBe(200);
      expect(savedPlugin.json()).toEqual(
        expect.objectContaining({
          id: "fixture-lx",
          name: "Fixture LX",
          enabled: true,
        }),
      );

      const savedEventPlugin = await app.inject({
        method: "POST",
        url: "/api/v1/sources/lx-plugins",
        headers,
        payload: {
          id: "lx-event",
          name: "LX Event",
          code: lxEventPluginCode,
          enabled: true,
          defaultQuality: "320k",
        },
      });
      expect(savedEventPlugin.statusCode).toBe(200);
      expect(savedEventPlugin.json()).toEqual(
        expect.objectContaining({
          id: "lx-event",
          name: "LX Event",
          enabled: true,
        }),
      );

      const pluginList = await app.inject({
        method: "GET",
        url: "/api/v1/sources/lx-plugins",
        headers,
      });
      expect(pluginList.statusCode).toBe(200);
      expect(pluginList.json().plugins).toHaveLength(2);

      const pluginCode = await app.inject({
        method: "GET",
        url: "/api/v1/sources/lx-plugins/fixture-lx",
        headers,
      });
      expect(pluginCode.statusCode).toBe(200);
      expect(pluginCode.json().code).toContain("LX Fixture Song");

      const sources = await app.inject({
        method: "GET",
        url: "/api/v1/sources",
        headers,
      });
      expect(sources.statusCode).toBe(200);
      expect(sources.json().sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fixture-lx",
            type: "lx_js",
            enabled: true,
          }),
        ]),
      );

      const compatPlugins = await app.inject({
        method: "GET",
        url: "/api/js-plugins",
        headers: basicHeaders,
      });
      expect(compatPlugins.statusCode).toBe(200);
      expect(compatPlugins.json().success).toBe(true);
      expect(compatPlugins.json().data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "fixture-lx",
            enabled: true,
          }),
          expect.objectContaining({
            id: "lx-event",
            enabled: true,
          }),
        ]),
      );

      const search = await app.inject({
        method: "GET",
        url: "/api/v1/search?q=Manual&source=manual",
        headers,
      });
      expect(search.statusCode).toBe(200);
      expect(search.json()).toEqual(
        expect.objectContaining({
          query: "Manual",
          total: 1,
        }),
      );
      expect(search.json().tracks[0]).toEqual(
        expect.objectContaining({
          id: "manual:manual-track",
          source: "manual",
          title: "Manual Song",
          url: "https://example.com/manual.mp3",
        }),
      );

      const resolved = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/resolve",
        headers,
        payload: {
          track: search.json().tracks[0],
        },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toEqual(
        expect.objectContaining({
          url: "https://example.com/manual.mp3",
          quality: "source",
        }),
      );

      const testToneSearch = await app.inject({
        method: "GET",
        url: "/api/v1/search?q=hmusic-test-tone&source=manual",
        headers,
      });
      expect(testToneSearch.statusCode).toBe(200);
      expect(testToneSearch.json().tracks[0]).toEqual(
        expect.objectContaining({
          id: "manual:hmusic-test-tone",
          source: "manual",
          sourceTrackId: "hmusic-test-tone",
          title: "HMusic Test Tone",
          durationMs: 3000,
          url: "http://127.0.0.1:8090/api/v1/system/test-tone.wav",
        }),
      );

      const lxSearch = await app.inject({
        method: "GET",
        url: "/api/v1/search?q=Fixture&source=fixture-lx",
        headers,
      });
      expect(lxSearch.statusCode).toBe(200);
      expect(lxSearch.json().tracks[0]).toEqual(
        expect.objectContaining({
          id: "fixture-lx:fixture-song",
          source: "fixture-lx",
          title: "LX Fixture Song",
          durationMs: 210000,
        }),
      );

      const lxResolved = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/resolve",
        headers,
        payload: {
          track: lxSearch.json().tracks[0],
        },
      });
      expect(lxResolved.statusCode).toBe(200);
      expect(lxResolved.json().url).toBe("https://example.com/lx-fixture.mp3");

      const clientOriginTrack = {
        id: "tx:client-songmid",
        source: "tx",
        sourceTrackId: "client-songmid",
        title: "Client Search Song",
        artist: "Client Artist",
        album: "Client Album",
        durationMs: 180000,
        coverUrl: "https://example.com/client-cover.jpg",
        raw: {
          platform: "tx",
          source: "tx",
          sourceTrackId: "client-songmid",
          songmid: "client-songmid",
          url: "https://temporary.example.com/client-origin.mp3",
          playUrl: "https://temporary.example.com/client-origin-play-url.mp3",
        },
      };

      const clientOriginResolved = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/resolve",
        headers,
        payload: {
          track: clientOriginTrack,
        },
      });
      expect(clientOriginResolved.statusCode).toBe(200);
      expect(clientOriginResolved.json()).toEqual(
        expect.objectContaining({
          url: "https://example.com/client-origin.mp3",
          quality: "320k",
        }),
      );

      const flutterClientTrack = {
        name: "Client Search Song - Client Artist",
        id: "client-songmid",
        source: "qq",
        title: "Client Search Song",
        artist: "Client Artist",
        albumName: "Client Album",
        duration: 180,
        picture: "https://example.com/client-cover.jpg",
        url: "https://temporary.example.com/client-origin.mp3",
        playUrl: "https://temporary.example.com/client-origin-play-url.mp3",
      };

      const flutterClientResolved = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/resolve",
        headers,
        payload: {
          clientTrack: flutterClientTrack,
        },
      });
      expect(flutterClientResolved.statusCode).toBe(200);
      expect(flutterClientResolved.json()).toEqual(
        expect.objectContaining({
          url: "https://example.com/client-origin.mp3",
          quality: "320k",
        }),
      );
      expect(flutterClientResolved.json().track).toEqual(
        expect.objectContaining({
          id: "tx:client-songmid",
          source: "tx",
          sourceTrackId: "client-songmid",
          title: "Client Search Song",
          artist: "Client Artist",
          album: "Client Album",
          durationMs: 180000,
          coverUrl: "https://example.com/client-cover.jpg",
        }),
      );
      expect(flutterClientResolved.json().track.raw.url).toBeUndefined();
      expect(flutterClientResolved.json().track.raw.playUrl).toBeUndefined();

      const lxEventResolved = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/resolve",
        headers,
        payload: {
          clientTrack: {
            id: "event-song",
            source: "lx-event",
            title: "LX Event Song",
            artist: "LX Event Artist",
          },
        },
      });
      expect(lxEventResolved.statusCode).toBe(200);
      expect(lxEventResolved.json()).toEqual(
        expect.objectContaining({
          url: "https://example.com/lx-event.mp3",
          quality: "320k",
        }),
      );

      const lxEventLyric = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/lyrics",
        headers,
        payload: {
          clientTrack: {
            id: "event-song",
            source: "lx-event",
            title: "LX Event Song",
            artist: "LX Event Artist",
          },
        },
      });
      expect(lxEventLyric.statusCode).toBe(200);
      expect(lxEventLyric.json().lines).toEqual([
        { timeMs: 3000, text: "LX event line" },
      ]);
      expect(lxEventLyric.json().translatedLines).toEqual([
        { timeMs: 3000, text: "LX event translated" },
      ]);

      const initialPlaylists = await app.inject({
        method: "GET",
        url: "/api/v1/playlists",
        headers,
      });
      expect(initialPlaylists.statusCode).toBe(200);
      expect(initialPlaylists.json()).toEqual({ playlists: [] });

      const createdPlaylist = await app.inject({
        method: "POST",
        url: "/api/v1/playlists",
        headers,
        payload: {
          name: "我的歌单",
          description: "客户端搜索收藏",
        },
      });
      expect(createdPlaylist.statusCode).toBe(200);
      expect(createdPlaylist.json().playlist).toEqual(
        expect.objectContaining({
          name: "我的歌单",
          description: "客户端搜索收藏",
          trackCount: 0,
          items: [],
        }),
      );
      const playlistId = createdPlaylist.json().playlist.id as string;

      const addPlaylistTrack = await app.inject({
        method: "POST",
        url: `/api/v1/playlists/${playlistId}/tracks`,
        headers,
        payload: {
          track: clientOriginTrack,
        },
      });
      expect(addPlaylistTrack.statusCode).toBe(200);
      expect(addPlaylistTrack.json().playlist).toEqual(
        expect.objectContaining({
          id: playlistId,
          trackCount: 1,
        }),
      );
      expect(addPlaylistTrack.json().playlist.items).toEqual([
        expect.objectContaining({
          playlistId,
          position: 0,
          track: expect.objectContaining({
            id: "tx:client-songmid",
            source: "tx",
            sourceTrackId: "client-songmid",
            title: "Client Search Song",
            artist: "Client Artist",
            album: "Client Album",
            coverUrl: "https://example.com/client-cover.jpg",
          }),
        }),
      ]);
      expect(
        addPlaylistTrack.json().playlist.items[0].track.url,
      ).toBeUndefined();
      expect(
        addPlaylistTrack.json().playlist.items[0].track.raw.url,
      ).toBeUndefined();
      expect(
        addPlaylistTrack.json().playlist.items[0].track.raw.playUrl,
      ).toBeUndefined();

      const addClientPlaylistTrack = await app.inject({
        method: "POST",
        url: `/api/v1/playlists/${playlistId}/tracks`,
        headers,
        payload: {
          clientTrack: {
            name: "Kuwo Client Song - Kuwo Artist",
            source: "kuwo",
            MUSICRID: "MUSIC_kw-client-rid",
            ALBUM: "Kuwo Album",
            DURATION: "215",
          },
        },
      });
      expect(addClientPlaylistTrack.statusCode).toBe(200);
      expect(addClientPlaylistTrack.json().playlist.trackCount).toBe(2);
      expect(addClientPlaylistTrack.json().playlist.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            track: expect.objectContaining({
              id: "kw:kw-client-rid",
              source: "kw",
              sourceTrackId: "kw-client-rid",
              title: "Kuwo Client Song",
              artist: "Kuwo Artist",
              album: "Kuwo Album",
              durationMs: 215000,
            }),
          }),
        ]),
      );

      const duplicatePlaylistTrack = await app.inject({
        method: "POST",
        url: `/api/v1/playlists/${playlistId}/tracks`,
        headers,
        payload: {
          track: {
            ...clientOriginTrack,
            title: "Client Search Song Updated",
          },
        },
      });
      expect(duplicatePlaylistTrack.statusCode).toBe(200);
      expect(duplicatePlaylistTrack.json().playlist.trackCount).toBe(2);
      expect(
        duplicatePlaylistTrack
          .json()
          .playlist.items.find(
            (item: { track: { id: string } }) =>
              item.track.id === "tx:client-songmid",
          ).track.title,
      ).toBe("Client Search Song Updated");

      const listedPlaylists = await app.inject({
        method: "GET",
        url: "/api/v1/playlists",
        headers,
      });
      expect(listedPlaylists.statusCode).toBe(200);
      expect(listedPlaylists.json().playlists).toEqual([
        expect.objectContaining({
          id: playlistId,
          name: "我的歌单",
          trackCount: 2,
        }),
      ]);

      const playlistDetail = await app.inject({
        method: "GET",
        url: `/api/v1/playlists/${playlistId}`,
        headers,
      });
      expect(playlistDetail.statusCode).toBe(200);
      expect(playlistDetail.json().playlist.items).toHaveLength(2);

      const playlistItemId = playlistDetail.json().playlist.items[0]
        .id as string;
      const removePlaylistTrack = await app.inject({
        method: "DELETE",
        url: `/api/v1/playlists/${playlistId}/tracks/${playlistItemId}`,
        headers,
      });
      expect(removePlaylistTrack.statusCode).toBe(200);
      expect(removePlaylistTrack.json().playlist.trackCount).toBe(1);
      expect(removePlaylistTrack.json().playlist.items).toHaveLength(1);

      const deletedPlaylist = await app.inject({
        method: "DELETE",
        url: `/api/v1/playlists/${playlistId}`,
        headers,
      });
      expect(deletedPlaylist.statusCode).toBe(200);
      expect(deletedPlaylist.json().deletedPlaylistId).toBe(playlistId);

      const lxLyric = await app.inject({
        method: "POST",
        url: "/api/v1/tracks/lyrics",
        headers,
        payload: {
          track: lxSearch.json().tracks[0],
        },
      });
      expect(lxLyric.statusCode).toBe(200);
      expect(lxLyric.json()).toEqual(
        expect.objectContaining({
          trackId: "fixture-lx:fixture-song",
          source: "fixture-lx",
          lrc: expect.stringContaining("LX line one"),
        }),
      );
      expect(lxLyric.json().lines).toEqual([
        { timeMs: 1000, text: "LX line one" },
        { timeMs: 2500, text: "LX line two" },
      ]);
      expect(lxLyric.json().translatedLines).toEqual([
        { timeMs: 1000, text: "译文一" },
      ]);

      const ubusCalls: Array<{ method: string | null; message: unknown }> = [];
      let smsSendStatus: "ok" | "limited" = "ok";
      let webVerified = false;
      let forceDeviceListUnauthorized = false;
      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          const target = url.toString();
          const bodyText =
            init?.body instanceof URLSearchParams
              ? init.body.toString()
              : typeof init?.body === "string"
                ? init.body
                : "";
          if (target.includes("/pass/serviceLogin?sid=micoapi")) {
            return new Response(
              JSON.stringify({
                code: 0,
                sid: "micoapi",
                qs: "qs-fixture",
                callback: "callback-fixture",
                _sign: "sign-fixture",
              }),
            );
          }
          if (target.includes("/pass/serviceLoginAuth2/end")) {
            return new Response("redirect", {
              status: 302,
              headers: {
                location:
                  "https://api2.mina.mi.com/sts?ticket=identity-fixture",
              },
            });
          }
          if (target.includes("/pass/serviceLoginAuth2")) {
            const form = new URLSearchParams(bodyText);
            if (form.get("user") === "verify@example.com" && !webVerified) {
              return new Response(
                JSON.stringify({
                  code: 70016,
                  notificationUrl:
                    "/fe/service/identity/authStart?sid=micoapi&context=fixture",
                }),
              );
            }

            return new Response(
              JSON.stringify({
                code: 0,
                location:
                  "https://account.xiaomi.com/pass/tokenLogin?sid=micoapi",
                nonce: "nonce-fixture",
                ssecurity: "ssecurity-fixture",
                userId: "user-id-fixture",
                passToken: "pass-token-fixture",
              }),
            );
          }
          if (target.includes("/fe/service/identity/authStart")) {
            return new Response("<html>identity</html>", {
              headers: {
                "set-cookie": "identity_session=identity-session-fixture",
              },
            });
          }
          if (target.includes("/identity/list")) {
            return new Response("&&&START&&&" + JSON.stringify({ code: 0 }));
          }
          if (
            target.includes("/identity/auth/verifyPhone") &&
            (init?.method ?? "GET") !== "POST"
          ) {
            return new Response(
              "&&&START&&&" +
                JSON.stringify({
                  code: 0,
                  description: "成功",
                  maskedPhone: "+86 176******93",
                }),
            );
          }
          if (target.includes("/identity/pass/sms/userQuota")) {
            return new Response("&&&START&&&" + JSON.stringify({ code: 0 }));
          }
          if (target.includes("/identity/auth/sendPhoneTicket")) {
            return new Response(
              "&&&START&&&" +
                JSON.stringify(
                  smsSendStatus === "limited"
                    ? {
                        code: 70022,
                        tips: "验证码发送过多，请明天再试",
                      }
                    : { code: 0 },
                ),
            );
          }
          if (
            target.includes("/identity/auth/verifyPhone") &&
            init?.method === "POST"
          ) {
            const ticket = new URLSearchParams(bodyText).get("ticket");
            return new Response(
              "&&&START&&&" +
                JSON.stringify(
                  ticket === "123456"
                    ? {
                        code: 0,
                        location:
                          "https://account.xiaomi.com/pass/serviceLoginAuth2/end?ticket=identity-fixture",
                      }
                    : {
                        code: 70014,
                        tips: "验证码错误",
                      },
                ),
            );
          }
          if (target.includes("api2.mina.mi.com/sts")) {
            return new Response("ok", {
              headers: {
                "set-cookie":
                  "serviceToken=identity-service-token; Path=/; HttpOnly, userId=identity-user-id; Path=/; HttpOnly",
              },
            });
          }
          if (target.includes("/pass/tokenLogin")) {
            return new Response("", {
              headers: {
                "set-cookie":
                  "serviceToken=service-token-fixture; Path=/; HttpOnly",
              },
            });
          }
          if (target.includes("/admin/v2/device_list")) {
            const cookie = new Headers(init?.headers).get("cookie") || "";
            if (
              forceDeviceListUnauthorized ||
              cookie.includes("expired-service-token")
            ) {
              return new Response("unauthorized", { status: 401 });
            }
            return Response.json({
              data: [
                {
                  deviceID: "xiaomi-speaker",
                  miotDID: "miot-speaker",
                  alias: "客厅音箱",
                  hardware: "L06A",
                  localip: "192.168.1.20",
                },
              ],
            });
          }
          if (target.includes("/remote/ubus")) {
            const body = new URLSearchParams(bodyText);
            const method = body.get("method");
            const rawMessage = body.get("message");
            ubusCalls.push({
              method,
              message: rawMessage ? JSON.parse(rawMessage) : undefined,
            });
            if (method === "player_get_play_status") {
              return Response.json({
                code: 0,
                data: {
                  code: 0,
                  info: JSON.stringify({
                    status: 1,
                    volume: 55,
                    loop_type: 3,
                    play_song_detail: {
                      audio_id: "fixture-song",
                      title: "LX Fixture Song",
                      artist: "LX Artist",
                      album: "LX Album",
                      cover: "https://example.com/lx-cover.jpg",
                      duration: 210000,
                      position: 45000,
                    },
                  }),
                },
              });
            }
            return Response.json({
              code: 0,
              data: {},
            });
          }

          return new Response("not found", { status: 404 });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const miLogin = await app.inject({
        method: "POST",
        url: "/api/v1/mi/login",
        headers,
        payload: {
          account: "user@example.com",
          password: "integration-password",
        },
      });
      expect(miLogin.statusCode).toBe(200);
      expect(miLogin.json().loggedIn).toBe(true);
      expect(miLogin.json().deviceCount).toBe(1);

      const miStatusAfterLoginAttempt = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(miStatusAfterLoginAttempt.statusCode).toBe(200);
      expect(miStatusAfterLoginAttempt.json().loggedIn).toBe(true);
      expect(miStatusAfterLoginAttempt.json().accountMasked).toBe(
        "us***@example.com",
      );

      const devicesAfterMiLogin = await app.inject({
        method: "GET",
        url: "/api/v1/devices",
        headers,
      });
      expect(devicesAfterMiLogin.statusCode).toBe(200);
      // 小米设备之外恒有「本机播放」虚拟设备；登录同步会把首台音箱设为默认。
      const devicesWithMi = devicesAfterMiLogin.json().devices;
      expect(devicesWithMi).toHaveLength(2);
      expect(devicesWithMi).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "xiaomi-speaker",
            name: "客厅音箱",
            type: "L06A",
            ip: "192.168.1.20",
            isOnline: true,
            isDefault: true,
          }),
          expect.objectContaining({
            id: "local-browser",
            isDefault: false,
          }),
        ]),
      );

      const refreshDevices = await app.inject({
        method: "POST",
        url: "/api/v1/devices/refresh",
        headers,
      });
      expect(refreshDevices.statusCode).toBe(200);
      expect(refreshDevices.json().deviceCount).toBe(1);

      const testTonePlayback = await app.inject({
        method: "POST",
        url: "/api/v1/playback/test-tone",
        headers,
      });
      expect(testTonePlayback.statusCode).toBe(200);
      expect(testTonePlayback.json()).toEqual(
        expect.objectContaining({
          deviceId: "xiaomi-speaker",
          state: "playing",
          durationMs: 3000,
        }),
      );
      expect(testTonePlayback.json().track).toEqual(
        expect.objectContaining({
          id: "manual:hmusic-test-tone",
          source: "manual",
          sourceTrackId: "hmusic-test-tone",
          title: "HMusic Test Tone",
        }),
      );
      expect(ubusCalls.slice(-3).map((item) => item.method)).toEqual([
        "player_play_operation",
        "player_play_operation",
        "player_play_music",
      ]);
      expect(ubusCalls.at(-1)?.message).toEqual(
        expect.objectContaining({
          media: "app_ios",
          music: expect.stringMatching(
            /http:\/\/127\.0\.0\.1:8090\/api\/v1\/proxy\/audio\//,
          ),
        }),
      );

      const compatSettings = await app.inject({
        method: "GET",
        url: "/getsetting?need_device_list=true",
        headers: basicHeaders,
      });
      expect(compatSettings.statusCode).toBe(200);
      expect(compatSettings.json().device_list).toEqual([
        expect.objectContaining({
          miotDID: "xiaomi-speaker",
          name: "客厅音箱",
          presence: "online",
          current: true,
        }),
      ]);

      const compatPushList = await app.inject({
        method: "POST",
        url: "/api/device/pushList",
        headers: basicHeaders,
        payload: {
          did: "xiaomi-speaker",
          playlistName: "在线播放",
          songList: [
            {
              name: "Client Search Song - Client Artist",
              id: "client-songmid",
              source: "tx",
              title: "Client Search Song",
              artist: "Client Artist",
              album: "Client Album",
              duration: 180,
              pic: "https://example.com/client-cover.jpg",
            },
          ],
        },
      });
      expect(compatPushList.statusCode).toBe(200);
      expect(compatPushList.json()).toEqual(
        expect.objectContaining({
          success: true,
          queueLength: 1,
        }),
      );
      expect(compatPushList.json().playback.track).toEqual(
        expect.objectContaining({
          source: "tx",
          sourceTrackId: "client-songmid",
          title: "Client Search Song",
        }),
      );
      expect(ubusCalls.at(-1)?.method).toBe("player_play_music");

      const clearQueueAfterCompat = await app.inject({
        method: "POST",
        url: "/api/v1/queue/clear",
        headers,
      });
      expect(clearQueueAfterCompat.statusCode).toBe(200);

      const playLxTrack = await app.inject({
        method: "POST",
        url: "/api/v1/playback/play",
        headers,
        payload: {
          track: lxSearch.json().tracks[0],
          quality: "source",
        },
      });
      expect(playLxTrack.statusCode).toBe(200);
      expect(playLxTrack.json()).toEqual(
        expect.objectContaining({
          deviceId: "xiaomi-speaker",
          state: "playing",
          durationMs: 210000,
        }),
      );
      expect(playLxTrack.json().track).toEqual(
        expect.objectContaining({
          title: "LX Fixture Song",
        }),
      );
      expect(ubusCalls.slice(-3).map((item) => item.method)).toEqual([
        "player_play_operation",
        "player_play_operation",
        "player_play_music",
      ]);
      expect(ubusCalls.at(-1)?.message).toEqual(
        expect.objectContaining({
          media: "app_ios",
          music: expect.stringMatching(
            /http:\/\/127\.0\.0\.1:8090\/api\/v1\/proxy\/audio\//,
          ),
        }),
      );

      const currentLyric = await app.inject({
        method: "GET",
        url: "/api/v1/tracks/fixture-lx%3Afixture-song/lyrics",
        headers,
      });
      expect(currentLyric.statusCode).toBe(200);
      expect(currentLyric.json().lines).toEqual([
        { timeMs: 1000, text: "LX line one" },
        { timeMs: 2500, text: "LX line two" },
      ]);

      const queueAfterPlay = await app.inject({
        method: "GET",
        url: "/api/v1/queue",
        headers,
      });
      expect(queueAfterPlay.statusCode).toBe(200);
      expect(queueAfterPlay.json()).toEqual(
        expect.objectContaining({
          currentIndex: 0,
          playMode: "list_loop",
        }),
      );
      expect(queueAfterPlay.json().items).toEqual([
        expect.objectContaining({
          track: expect.objectContaining({
            id: "fixture-lx:fixture-song",
            title: "LX Fixture Song",
          }),
        }),
      ]);

      const playbackAfterDeviceStatus = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
        headers,
      });
      expect(playbackAfterDeviceStatus.statusCode).toBe(200);
      expect(playbackAfterDeviceStatus.json()).toEqual(
        expect.objectContaining({
          state: "playing",
          positionMs: 45000,
          durationMs: 210000,
          volume: 55,
          playMode: "shuffle",
        }),
      );
      expect(playbackAfterDeviceStatus.json().track).toEqual(
        expect.objectContaining({
          title: "LX Fixture Song",
          artist: "LX Artist",
          coverUrl: "https://example.com/lx-cover.jpg",
        }),
      );

      const queueMode = await app.inject({
        method: "POST",
        url: "/api/v1/queue/mode",
        headers,
        payload: {
          playMode: "single_loop",
        },
      });
      expect(queueMode.statusCode).toBe(200);
      expect(queueMode.json().playMode).toBe("single_loop");

      const play = await app.inject({
        method: "POST",
        url: "/api/v1/playback/play",
        headers,
        payload: {
          url: "https://example.com/test.mp3",
          track: {
            id: "test-track",
            source: "manual",
            sourceTrackId: "test-track",
            title: "测试歌曲",
            artist: "HMusic",
            durationMs: 180000,
          },
        },
      });
      expect(play.statusCode).toBe(200);
      expect(play.json()).toEqual(
        expect.objectContaining({
          deviceId: "xiaomi-speaker",
          deviceName: "客厅音箱",
          state: "playing",
          durationMs: 180000,
          queueIndex: 1,
          queueLength: 2,
        }),
      );

      const replaceQueue = await app.inject({
        method: "PUT",
        url: "/api/v1/queue",
        headers,
        payload: {
          tracks: [lxSearch.json().tracks[0], search.json().tracks[0]],
          currentIndex: 1,
          playMode: "shuffle",
        },
      });
      expect(replaceQueue.statusCode).toBe(200);
      expect(replaceQueue.json()).toEqual(
        expect.objectContaining({
          currentIndex: 1,
          playMode: "shuffle",
        }),
      );
      expect(replaceQueue.json().items).toHaveLength(2);

      const queueListLoop = await app.inject({
        method: "POST",
        url: "/api/v1/queue/mode",
        headers,
        payload: {
          playMode: "list_loop",
        },
      });
      expect(queueListLoop.statusCode).toBe(200);

      const nextFromQueue = await app.inject({
        method: "POST",
        url: "/api/v1/playback/next",
        headers,
      });
      expect(nextFromQueue.statusCode).toBe(200);
      expect(nextFromQueue.json()).toEqual(
        expect.objectContaining({
          state: "playing",
          queueIndex: 0,
          queueLength: 2,
        }),
      );
      expect(nextFromQueue.json().track).toEqual(
        expect.objectContaining({
          title: "LX Fixture Song",
        }),
      );

      const previousFromQueue = await app.inject({
        method: "POST",
        url: "/api/v1/playback/previous",
        headers,
      });
      expect(previousFromQueue.statusCode).toBe(200);
      expect(previousFromQueue.json()).toEqual(
        expect.objectContaining({
          state: "playing",
          queueIndex: 1,
          queueLength: 2,
        }),
      );
      expect(previousFromQueue.json().track).toEqual(
        expect.objectContaining({
          title: "Manual Song",
        }),
      );

      const duplicateQueue = await app.inject({
        method: "PUT",
        url: "/api/v1/queue",
        headers,
        payload: {
          tracks: [lxSearch.json().tracks[0], lxSearch.json().tracks[0]],
          currentIndex: 1,
          playMode: "list_loop",
        },
      });
      expect(duplicateQueue.statusCode).toBe(200);

      const playDuplicateTrack = await app.inject({
        method: "POST",
        url: "/api/v1/playback/play",
        headers,
        payload: {
          track: lxSearch.json().tracks[0],
          quality: "source",
          queueIndex: 1,
        },
      });
      expect(playDuplicateTrack.statusCode).toBe(200);
      expect(playDuplicateTrack.json()).toEqual(
        expect.objectContaining({
          queueIndex: 1,
          queueLength: 2,
        }),
      );

      // 队列含重复歌曲时，queueIndex 精确定位第几项（回归 playSchema 曾漏声明
      // queueIndex + strict 拒收，导致队列点重复歌 400 的 bug）。传 index 0
      // 应落在第 0 项而不是被同名的第 1 项抢占。
      const playDuplicateFirst = await app.inject({
        method: "POST",
        url: "/api/v1/playback/play",
        headers,
        payload: {
          track: lxSearch.json().tracks[0],
          quality: "source",
          queueIndex: 0,
        },
      });
      expect(playDuplicateFirst.statusCode).toBe(200);
      expect(playDuplicateFirst.json()).toEqual(
        expect.objectContaining({
          queueIndex: 0,
          queueLength: 2,
        }),
      );

      const volume = await app.inject({
        method: "POST",
        url: "/api/v1/playback/volume",
        headers,
        payload: {
          volume: 42,
        },
      });
      expect(volume.statusCode).toBe(200);
      expect(volume.json().volume).toBe(42);

      const paused = await app.inject({
        method: "POST",
        url: "/api/v1/playback/pause",
        headers,
      });
      expect(paused.statusCode).toBe(200);
      expect(paused.json().state).toBe("paused");

      const resumed = await app.inject({
        method: "POST",
        url: "/api/v1/playback/resume",
        headers,
      });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json().state).toBe("playing");

      const activeVerificationStart = await app.inject({
        method: "POST",
        url: "/api/v1/mi/verification/start",
        headers,
        payload: {
          account: "verify@example.com",
          password: "integration-password",
        },
      });
      expect(activeVerificationStart.statusCode).toBe(200);
      expect(activeVerificationStart.json().loggedIn).toBe(false);

      const statusAfterActiveVerificationStart = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(statusAfterActiveVerificationStart.statusCode).toBe(200);
      expect(statusAfterActiveVerificationStart.json()).toEqual(
        expect.objectContaining({
          loggedIn: false,
          accountMasked: "ve***@example.com",
        }),
      );

      const miLogout = await app.inject({
        method: "POST",
        url: "/api/v1/mi/logout",
        headers,
      });
      expect(miLogout.statusCode).toBe(200);
      expect(miLogout.json().loggedIn).toBe(false);

      const webVerificationStart = await app.inject({
        method: "POST",
        url: "/api/v1/mi/web-verification/start",
        headers,
        payload: {
          account: "verify@example.com",
          password: "integration-password",
        },
      });
      expect(webVerificationStart.statusCode).toBe(200);
      expect(webVerificationStart.json()).toEqual(
        expect.objectContaining({
          loggedIn: false,
          accountMasked: "ve***@example.com",
          verificationUrl: expect.stringContaining(
            "/fe/service/identity/authStart",
          ),
        }),
      );
      const webVerificationId = webVerificationStart.json()
        .verificationId as string;
      const webVerificationPage = await app.inject({
        method: "GET",
        url: `/mi-web-verification/${webVerificationId}`,
      });
      expect(webVerificationPage.statusCode).toBe(200);
      expect(webVerificationPage.headers["content-type"]).toContain(
        "text/html",
      );
      expect(webVerificationPage.headers["set-cookie"]).toContain(
        "hmusic_mi_verification_id=",
      );
      expect(webVerificationPage.body).toContain("<iframe");
      expect(webVerificationPage.body).toContain(
        `/mi-web-verification/${webVerificationId}/proxy?url=`,
      );

      const webVerificationProxy = await app.inject({
        method: "GET",
        url:
          `/mi-web-verification/${webVerificationId}/proxy?url=` +
          encodeURIComponent(webVerificationStart.json().verificationUrl),
      });
      expect(webVerificationProxy.statusCode).toBe(200);
      expect(webVerificationProxy.body).toContain("identity");

      const webVerificationProxyComplete = await app.inject({
        method: "GET",
        url:
          `/mi-web-verification/${webVerificationId}/proxy?url=` +
          encodeURIComponent(
            "https://account.xiaomi.com/pass/serviceLoginAuth2/end?ticket=identity-fixture",
          ),
      });
      expect(webVerificationProxyComplete.statusCode).toBe(200);
      expect(webVerificationProxyComplete.body).toContain("小米账号已登录");

      const webVerificationCompleteStatus = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(webVerificationCompleteStatus.statusCode).toBe(200);
      expect(webVerificationCompleteStatus.json()).toEqual(
        expect.objectContaining({
          loggedIn: true,
          accountMasked: "ve***@example.com",
        }),
      );

      const logoutAfterWebVerification = await app.inject({
        method: "POST",
        url: "/api/v1/mi/logout",
        headers,
      });
      expect(logoutAfterWebVerification.statusCode).toBe(200);
      expect(logoutAfterWebVerification.json().loggedIn).toBe(false);
      webVerified = false;

      const verificationStart = await app.inject({
        method: "POST",
        url: "/api/v1/mi/verification/start",
        headers,
        payload: {
          account: "verify@example.com",
          password: "integration-password",
        },
      });
      expect(verificationStart.statusCode).toBe(200);
      expect(verificationStart.json()).toEqual(
        expect.objectContaining({
          loggedIn: false,
          accountMasked: "ve***@example.com",
          maskedPhone: "+86 176******93",
        }),
      );

      const verificationId = verificationStart.json().verificationId as string;
      const resendVerification = await app.inject({
        method: "POST",
        url: `/api/v1/mi/verification/${verificationId}/resend`,
        headers,
      });
      expect(resendVerification.statusCode).toBe(200);
      expect(resendVerification.json().verificationId).toBe(verificationId);

      const badVerificationCode = await app.inject({
        method: "POST",
        url: `/api/v1/mi/verification/${verificationId}/confirm`,
        headers,
        payload: {
          code: "000000",
        },
      });
      expect(badVerificationCode.statusCode).toBe(400);
      expect(badVerificationCode.json().error.code).toBe(
        "MI_IDENTITY_CODE_INVALID",
      );

      const confirmedVerification = await app.inject({
        method: "POST",
        url: `/api/v1/mi/verification/${verificationId}/confirm`,
        headers,
        payload: {
          code: "123456",
        },
      });
      expect(confirmedVerification.statusCode).toBe(200);
      expect(confirmedVerification.json()).toEqual(
        expect.objectContaining({
          loggedIn: true,
          accountMasked: "ve***@example.com",
          deviceCount: 1,
        }),
      );

      forceDeviceListUnauthorized = true;
      const expiredRefresh = await app.inject({
        method: "POST",
        url: "/api/v1/devices/refresh",
        headers,
      });
      expect(expiredRefresh.statusCode).toBe(502);
      expect(expiredRefresh.json().error.code).toBe("MI_DEVICE_LIST_FAILED");

      const statusAfterExpiredRefresh = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(statusAfterExpiredRefresh.statusCode).toBe(200);
      expect(statusAfterExpiredRefresh.json().loggedIn).toBe(false);
      forceDeviceListUnauthorized = false;

      const logoutAfterVerification = await app.inject({
        method: "POST",
        url: "/api/v1/mi/logout",
        headers,
      });
      expect(logoutAfterVerification.statusCode).toBe(200);
      expect(logoutAfterVerification.json().loggedIn).toBe(false);

      smsSendStatus = "limited";
      const limitedVerificationStart = await app.inject({
        method: "POST",
        url: "/api/v1/mi/verification/start",
        headers,
        payload: {
          account: "verify@example.com",
          password: "integration-password",
        },
      });
      expect(limitedVerificationStart.statusCode).toBe(200);
      expect(limitedVerificationStart.json()).toEqual(
        expect.objectContaining({
          loggedIn: false,
          smsStatus: "limited",
          accountMasked: "ve***@example.com",
        }),
      );

      const limitedVerificationId = limitedVerificationStart.json()
        .verificationId as string;
      const confirmedLimitedVerification = await app.inject({
        method: "POST",
        url: `/api/v1/mi/verification/${limitedVerificationId}/confirm`,
        headers,
        payload: {
          code: "123456",
        },
      });
      expect(confirmedLimitedVerification.statusCode).toBe(200);
      expect(confirmedLimitedVerification.json().loggedIn).toBe(true);

      const logoutAfterLimitedVerification = await app.inject({
        method: "POST",
        url: "/api/v1/mi/logout",
        headers,
      });
      expect(logoutAfterLimitedVerification.statusCode).toBe(200);
      expect(logoutAfterLimitedVerification.json().loggedIn).toBe(false);
      smsSendStatus = "ok";

      const importedMiSession = await app.inject({
        method: "POST",
        url: "/api/v1/mi/session/import",
        headers,
        payload: {
          account: "imported@example.com",
          webCredentials: {
            serviceToken: "imported-service-token",
            userId: "imported-user-id",
            ssecurity: "imported-ssecurity",
          },
        },
      });
      expect(importedMiSession.statusCode).toBe(200);
      expect(importedMiSession.json()).toEqual(
        expect.objectContaining({
          loggedIn: true,
          accountMasked: "im***@example.com",
          deviceCount: 1,
        }),
      );

      const logoutAfterImportedSession = await app.inject({
        method: "POST",
        url: "/api/v1/mi/logout",
        headers,
      });
      expect(logoutAfterImportedSession.statusCode).toBe(200);
      expect(logoutAfterImportedSession.json().loggedIn).toBe(false);

      const expiredImportedMiSession = await app.inject({
        method: "POST",
        url: "/api/v1/mi/session/import",
        headers,
        payload: {
          account: "expired@example.com",
          webCredentials: {
            serviceToken: "expired-service-token",
            userId: "expired-user-id",
          },
        },
      });
      expect(expiredImportedMiSession.statusCode).toBe(502);
      expect(expiredImportedMiSession.json().error.code).toBe(
        "MI_DEVICE_LIST_FAILED",
      );

      const statusAfterExpiredImport = await app.inject({
        method: "GET",
        url: "/api/v1/mi/status",
        headers,
      });
      expect(statusAfterExpiredImport.statusCode).toBe(200);
      expect(statusAfterExpiredImport.json().loggedIn).toBe(false);

      const mockDevice = await app.inject({
        method: "POST",
        url: "/api/v1/devices/mock",
        headers,
        payload: {
          id: "mock-speaker",
          name: "Mock Speaker",
          type: "LX06",
          isOnline: true,
          isDefault: true,
          capabilities: {
            supportsSeek: true,
            supportsRichStatus: true,
          },
        },
      });
      expect(mockDevice.statusCode).toBe(200);
      expect(mockDevice.json().id).toBe("mock-speaker");
      expect(mockDevice.json().capabilities.supportsSeek).toBe(true);

      const devicesAfterMock = await app.inject({
        method: "GET",
        url: "/api/v1/devices",
        headers,
      });
      expect(devicesAfterMock.statusCode).toBe(200);
      // xiaomi-speaker + mock-speaker + 常驻的「本机播放」虚拟设备
      expect(devicesAfterMock.json().devices).toHaveLength(3);
      expect(devicesAfterMock.json().devices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "mock-speaker",
            isDefault: true,
          }),
        ]),
      );

      const selectedDevice = await app.inject({
        method: "POST",
        url: "/api/v1/devices/mock-speaker/select",
        headers,
      });
      expect(selectedDevice.statusCode).toBe(200);
      expect(selectedDevice.json().selectedDeviceId).toBe("mock-speaker");
      // 选默认设备即切换播放目标：有曲目时转为新设备上的暂停态（待重解析续播）。
      expect(selectedDevice.json().playback).toEqual(
        expect.objectContaining({
          deviceId: "mock-speaker",
          state: "paused",
        }),
      );

      const probedDevice = await app.inject({
        method: "POST",
        url: "/api/v1/devices/mock-speaker/probe",
        headers,
      });
      expect(probedDevice.statusCode).toBe(200);
      expect(probedDevice.json().supportsSeek).toBe(true);

      const playback = await app.inject({
        method: "GET",
        url: "/api/v1/playback/state",
        headers,
      });
      expect(playback.statusCode).toBe(200);
      // 切设备后为暂停态；设备状态回读（mock ubus 返回 status:1）可能刷成 playing，
      // 两者都算正常，这里只断言不是初始 idle。
      expect(["playing", "paused"]).toContain(playback.json().state);

      const queue = await app.inject({
        method: "GET",
        url: "/api/v1/queue",
        headers,
      });
      expect(queue.statusCode).toBe(200);
      expect(queue.json().items).toHaveLength(2);

      const lyric = await app.inject({
        method: "GET",
        url: "/api/v1/tracks/tx%3Atest/lyrics",
        headers,
      });
      expect(lyric.statusCode).toBe(200);
      expect(lyric.json().trackId).toBe("tx:test");
    } finally {
      await app.close();
    }
  }, 15000);
});
