import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let mediaServer: Server;
let dataDir: string;
let origin: string;
let token: string;
const mediaRequests: Array<{ url: string; referer?: string; range?: string }> = [];

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hmusic-strict-resolve-"));
  process.env.HMUSIC_DATA_DIR = dataDir;
  process.env.HMUSIC_DATABASE_URL = path.join(dataDir, "test.db");
  process.env.HMUSIC_JWT_SECRET = "strict-resolve-test-secret";
  process.env.HMUSIC_LOG_LEVEL = "silent";
  mediaServer = createServer((req, res) => {
    mediaRequests.push({ url: req.url!, referer: req.headers.referer, range: req.headers.range });
    if (req.url === "/slow") return;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/audio" });
      res.end();
      return;
    }
    if (req.url === "/audio" && req.headers.referer === "https://media.example.test/") {
      res.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Range": "bytes 0-1/100" });
      res.end(Buffer.from([0xff, 0xfb]));
      return;
    }
    res.writeHead(403);
    res.end();
  });
  await new Promise<void>((resolve) => mediaServer.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(mediaServer.address() as { port: number }).port}`;
  const { buildApp } = await import("../../src/app.js");
  app = await buildApp();
  const auth = await app.inject({ method: "POST", url: "/api/v1/auth/setup",
    payload: { username: "review", password: "fixture-password" } });
  token = auth.json().accessToken;
  await app.inject({ method: "PATCH", url: "/api/v1/config", headers: { authorization: `Bearer ${token}` },
    payload: { resolveStrategy: "originalFirst" } });
  const installed = await app.inject({ method: "POST", url: "/api/v1/sources/lx-plugins",
    headers: { authorization: `Bearer ${token}` }, payload: {
      id: "strict-fixture", name: "Strict fixture", enabled: true,
      code: `module.exports.getUrl = (track) => ({data: {
        url: ${JSON.stringify(origin)} + (track.id === 'dead' ? '/dead' : track.id === 'slow' ? '/slow' : '/redirect'),
        headers: {Referer: 'https://media.example.test/', Host: 'must-be-removed', Range: 'bytes=99-'}
      }});`,
    } });
  expect(installed.statusCode).toBe(200);
});

afterAll(async () => {
  await app?.close();
  mediaServer?.closeAllConnections();
  await new Promise<void>((resolve) => mediaServer?.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

function resolve(id: string, options: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/tracks/resolve",
    headers: { authorization: `Bearer ${token}` }, payload: {
      track: { id: `strict-fixture:${id}`, source: "strict-fixture", sourceTrackId: id,
        title: "Test", artist: "Fixture", url: origin + "/expired", raw: { url: origin + "/expired" } },
      ...options,
    } });
}

describe("严格解析与旧客户端兼容", () => {
  it("刷新旧 URL，通过带 Referer 的 302/Range 探测并传回媒体 headers", async () => {
    mediaRequests.length = 0;
    const response = await resolve("fresh", { refresh: true, strict: true, timeoutMs: 3000 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ url: origin + "/redirect", verified: true,
      headers: { Referer: "https://media.example.test/" } });
    expect(response.json().headers).not.toHaveProperty("Host");
    expect(response.json().headers).not.toHaveProperty("Range");
    expect(mediaRequests).toEqual([
      { url: "/redirect", referer: "https://media.example.test/", range: "bytes=0-1" },
      { url: "/audio", referer: "https://media.example.test/", range: "bytes=0-1" },
    ]);
  });

  it("所有档位都是 403 时严格模式失败，不返回首条死链", async () => {
    const response = await resolve("dead", { refresh: true, strict: true, timeoutMs: 3000 });
    expect(response.statusCode).toBe(501);
    expect(response.json()).not.toHaveProperty("url");
  });

  it("手工直链也必须通过严格探测", async () => {
    const response = await app.inject({ method: "POST", url: "/api/v1/tracks/resolve",
      headers: { authorization: `Bearer ${token}` }, payload: {
        track: { id: "manual:dead", source: "manual", sourceTrackId: "dead", title: "Dead", artist: "Fixture", url: origin + "/dead" },
        refresh: true, strict: true,
      } });
    expect(response.statusCode).toBe(502);
  });

  it("无响应媒体受总预算约束", async () => {
    const started = Date.now();
    const response = await resolve("slow", { refresh: true, strict: true, timeoutMs: 150 });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("旧客户端未请求刷新时保留原行为", async () => {
    mediaRequests.length = 0;
    const response = await resolve("fresh");
    expect(response.statusCode).toBe(200);
    expect(response.json().url).toBe(origin + "/expired");
    expect(response.json()).not.toHaveProperty("verified");
    expect(mediaRequests).toHaveLength(0);
  });
});
