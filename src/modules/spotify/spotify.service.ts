import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appConfig } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { decryptSecret, encryptSecret } from "../../shared/secrets.js";
import { moduleLogger } from "../../shared/logger.js";
import {
  addQueueTrack,
  getQueueRevision,
  replaceQueue,
} from "../queue/queue.service.js";
import { playTrack } from "../playback/playback.service.js";
import { isSameSong, searchTracks } from "../search/search.service.js";

// Spotify 个人会话（路线 B：个人自用非官方通道，2026-09-04 立项）。
//   登录 = 独立官方登录窗口自动获取（或手动导入）`sp_dc`，服务端换取 web player
//   access token，之后模拟 Web Player Pathfinder 查询读取个人数据（Top 曲目/歌单）。
//   token 请求自 2024 中起要求 TOTP 参数；算法与密钥来自社区维护的
//   spot-secrets-go（密钥随官方前端滚动更新，上游仓库过期则本模块整体失效，
//   更新密钥源即可修复——这是本路线的既定维护成本）。商店版禁用（ADR-0003）。

const SESSION_KEY = "spotifySession";
const SECRETS_URL =
  "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json";
const TOKEN_URL = "https://open.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const SPOTIFY_APP_VERSION = "1.3.1.46.g7d04e78c-development";
const WEB_PLAYER_CLIENT_ID = "d8a5ed958d274c2e8ee717e6a4b0971d";
const PATHFINDER_HASHES = {
  userTopContent:
    "49ee15704de4a7fdeac65a02db20604aa11e46f02e809c55d9a89f6db9754356",
  fetchPlaylist:
    "86dde7b9d9356e2369414647cf6950cfed96e778e129cfdfc99aea6c1613b3b0",
  libraryV3: "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455",
} as const;
const SECRETS_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Vitest keeps the legacy transport fixtures deterministic. Production and manual
// starts use the same Pathfinder operations as Spotify Web Player by default;
// `SPOTIFY_DATA_API=api` remains an explicit emergency fallback.
const USE_PATHFINDER =
  process.env.SPOTIFY_DATA_API === "pathfinder" ||
  (process.env.NODE_ENV !== "test" && process.env.SPOTIFY_DATA_API !== "api");
const log = moduleLogger("spotify");
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

export interface SpotifySession {
  spDc: string;
  savedAt: number;
}

// 归一化的曲目条目：足够「歌名+歌手搜索匹配 → LX 解析」播放，也够 App 列表展示。
export interface SpotifyTrackEntry {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  coverUrl: string | null;
  uri: string;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  tracksTotal: number;
  coverUrl: string | null;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface CachedClientToken {
  token: string;
  expiresAtMs: number;
}

let secretsCache: { dict: Record<string, number[]>; fetchedAt: number } | null =
  null;
let tokenCache: CachedToken | null = null;
let clientTokenCache: CachedClientToken | null = null;
let sessionRevision = 0;
let tokenRequest: { revision: number; promise: Promise<string> } | null = null;
let clientTokenRequest: Promise<string> | null = null;

export async function loadSession(): Promise<SpotifySession | null> {
  const row = db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, SESSION_KEY))
    .get();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.valueJson) as {
      spDc?: string;
      spDcEnc?: string;
      savedAt: number;
    };
    const spDc = parsed.spDcEnc ? decryptSecret(parsed.spDcEnc) : parsed.spDc;
    if (typeof spDc !== "string" || !spDc || !Number.isFinite(parsed.savedAt)) {
      return null;
    }
    const session = { spDc, savedAt: parsed.savedAt };
    // 旧版本的明文会话首次读取时迁移，复用项目已有的 AES-GCM 密钥管理。
    if (!parsed.spDcEnc) saveSession(session);
    return session;
  } catch {
    return null;
  }
}

function saveSession(session: SpotifySession): void {
  const valueJson = JSON.stringify({
    spDcEnc: encryptSecret(session.spDc),
    savedAt: session.savedAt,
  });
  db.insert(appConfig)
    .values({
      key: SESSION_KEY,
      valueJson,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { valueJson, updatedAt: Date.now() },
    })
    .run();
}

export function resetSpotifyStateForAccountDeletion(): void {
  sessionRevision += 1;
  spotifyBackfillSeq += 1;
  tokenCache = null;
  tokenRequest = null;
  clientTokenCache = null;
  clientTokenRequest = null;
  secretsCache = null;
}

export async function clearSession(): Promise<void> {
  resetSpotifyStateForAccountDeletion();
  db.delete(appConfig).where(eq(appConfig.key, SESSION_KEY)).run();
}

function requireCurrentSession(revision: number): void {
  if (revision !== sessionRevision) {
    throw new AppError(
      "SPOTIFY_SESSION_CHANGED",
      "Spotify 会话已变更，请重试",
      409,
    );
  }
}

// TOTP：Spotify 私有变体（与 spot-secrets-go / mirrorfm 消费实现对齐）——
// cipher 逐位 XOR((index%33)+9) 后按十进制拼接，该 ASCII 串的 hex 编码字节
// 就是 HMAC-SHA1 密钥（原实现的 base32 编解码是恒等往返，此处直接取字节）；
// counter = unix/30，标准 dynamic truncation，6 位前导零。
export function generateTotp(cipher: number[], nowMs: number): string {
  const joined = cipher.map((v, i) => v ^ ((i % 33) + 9)).join("");
  const key = Buffer.from(Buffer.from(joined, "ascii").toString("hex"), "hex");
  const counter = Math.floor(nowMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, "0");
}

async function fetchSecrets(): Promise<Record<string, number[]>> {
  if (secretsCache && Date.now() - secretsCache.fetchedAt < SECRETS_TTL_MS) {
    return secretsCache.dict;
  }
  let resp: Response;
  try {
    resp = await fetch(SECRETS_URL, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new AppError(
      "SPOTIFY_SECRETS_UNAVAILABLE",
      "Spotify TOTP 密钥库拉取失败（网络不通或上游仓库过期）",
      502,
      { detail: String(error) },
    );
  }
  if (!resp.ok) {
    throw new AppError(
      "SPOTIFY_SECRETS_UNAVAILABLE",
      "Spotify TOTP 密钥库拉取失败（上游仓库可能已过期，需更新密钥源）",
      502,
    );
  }
  const dict = (await resp.json()) as Record<string, number[]>;
  if (!dict || Object.keys(dict).length === 0) {
    throw new AppError(
      "SPOTIFY_SECRETS_EMPTY",
      "Spotify TOTP 密钥库为空（上游仓库结构可能已变更）",
      502,
    );
  }
  secretsCache = { dict, fetchedAt: Date.now() };
  return dict;
}

async function requestToken(spDc: string): Promise<CachedToken> {
  const dict = await fetchSecrets();
  const versions = Object.keys(dict)
    .map((k) => Number.parseInt(k, 10))
    .filter((n) => Number.isFinite(n));
  if (versions.length === 0) {
    throw new AppError(
      "SPOTIFY_SECRETS_EMPTY",
      "Spotify TOTP 密钥库无有效版本",
      502,
    );
  }
  const version = Math.max(...versions);
  const cipher = dict[String(version)];
  if (!cipher || cipher.length === 0) {
    throw new AppError("SPOTIFY_SECRETS_EMPTY", "Spotify TOTP 密钥无效", 502);
  }
  const code = generateTotp(cipher, Date.now());
  const url = `${TOKEN_URL}?reason=transport&productType=web-player&totp=${code}&totpServer=${code}&totpVer=${version}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        Referer: "https://open.spotify.com/",
        "App-Platform": "WebPlayer",
        Cookie: `sp_dc=${spDc}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AppError(
      "SPOTIFY_TOKEN_UNREACHABLE",
      "Spotify token 服务不可达（服务器需要能访问 open.spotify.com）",
      502,
      { detail: String(error) },
    );
  }
  if (!resp.ok) {
    if (resp.status !== 401 && resp.status !== 403) {
      throw new AppError(
        "SPOTIFY_TOKEN_ERROR",
        `Spotify token 服务返回 ${resp.status}`,
        502,
      );
    }
    throw new AppError(
      "SPOTIFY_SESSION_INVALID",
      "sp_dc 无效或已过期（重新登录 Spotify 网页版拿新 Cookie）",
      401,
    );
  }
  const body = (await resp.json()) as {
    accessToken?: string;
    accessTokenExpirationTimestampMs?: number;
    isAnonymous?: boolean;
  };
  if (!body.accessToken || body.isAnonymous) {
    throw new AppError(
      "SPOTIFY_SESSION_INVALID",
      "sp_dc 无效或已过期（重新登录 Spotify 网页版拿新 Cookie）",
      401,
    );
  }
  return {
    accessToken: body.accessToken,
    expiresAtMs:
      body.accessTokenExpirationTimestampMs ?? Date.now() + 55 * 60 * 1000,
  };
}

function trackTokenRequest(
  revision: number,
  request: Promise<string>,
): Promise<string> {
  const promise = request.finally(() => {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  });
  tokenRequest = { revision, promise };
  return promise;
}

async function getAccessToken(): Promise<string> {
  const revision = sessionRevision;
  const session = await loadSession();
  requireCurrentSession(revision);
  if (!session) {
    tokenCache = null;
    throw new AppError("SPOTIFY_NOT_LINKED", "还没有登录 Spotify 账号", 409);
  }
  if (
    tokenCache &&
    Date.now() < tokenCache.expiresAtMs - TOKEN_REFRESH_MARGIN_MS
  ) {
    return tokenCache.accessToken;
  }
  if (tokenRequest?.revision === revision) return tokenRequest.promise;

  const promise = requestToken(session.spDc)
    .then((token) => {
      requireCurrentSession(revision);
      tokenCache = token;
      return token.accessToken;
    })
    .catch(async (error: unknown) => {
      if (
        revision === sessionRevision &&
        error instanceof AppError &&
        error.code === "SPOTIFY_SESSION_INVALID"
      ) {
        await clearSession();
      }
      throw error;
    });
  return trackTokenRequest(revision, promise);
}

// 首次绑定：先真换一次 token，sp_dc 无效当场报错，不落库坏会话。
export async function linkSession(
  spDc: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const revision = ++sessionRevision;
  tokenCache = null;
  clientTokenCache = null;
  // 后台查询共享正在验证的新会话，避免再次刷新已过期的旧 Cookie。
  await trackTokenRequest(
    revision,
    requestToken(spDc).then((token) => {
      signal?.throwIfAborted();
      requireCurrentSession(revision);
      // 验证与落库之间不让出执行权，等待旧会话的请求也不能跨账号继续。
      sessionRevision += 1;
      saveSession({ spDc, savedAt: Date.now() });
      tokenCache = token;
      return token.accessToken;
    }),
  );
}

async function getClientToken(): Promise<string> {
  if (clientTokenCache && Date.now() < clientTokenCache.expiresAtMs - 60_000) {
    return clientTokenCache.token;
  }
  if (clientTokenRequest) return clientTokenRequest;

  const promise = (async () => {
    let resp: Response;
    try {
      resp = await fetch(CLIENT_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Referer: "https://open.spotify.com/",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          client_data: {
            client_version: SPOTIFY_APP_VERSION,
            client_id: WEB_PLAYER_CLIENT_ID,
            js_sdk_data: {
              device_brand: "Apple",
              device_model: "unknown",
              os: "macos",
              os_version: "10.15.7",
              device_id: randomUUID(),
              device_type: "computer",
            },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AppError(
        "SPOTIFY_CLIENT_TOKEN_UNREACHABLE",
        "Spotify Web Player client-token 服务不可达",
        502,
        { detail: String(error) },
      );
    }
    if (resp.status === 429) {
      const retryAfter = Number.parseInt(
        resp.headers.get("retry-after") ?? "",
        10,
      );
      const retryAfterMs = Number.isFinite(retryAfter)
        ? Math.max(1000, Math.min(retryAfter * 1000, 10 * 60 * 1000))
        : null;
      throw new AppError(
        "SPOTIFY_RATE_LIMITED",
        retryAfterMs
          ? `Spotify 请求过于频繁，请约 ${Math.ceil(retryAfterMs / 60000)} 分钟后重试`
          : "Spotify 请求过于频繁，请稍后重试",
        429,
        { retryAfterMs },
      );
    }
    if (!resp.ok) {
      throw new AppError(
        "SPOTIFY_CLIENT_TOKEN_ERROR",
        `Spotify client-token 服务返回 ${resp.status}`,
        502,
      );
    }
    const body = (await resp.json()) as {
      granted_token?: { token?: string; expires_after_seconds?: number };
    };
    const token = body.granted_token?.token;
    if (!token) {
      throw new AppError(
        "SPOTIFY_RESPONSE_INVALID",
        "Spotify 返回了无效的 client-token",
        502,
      );
    }
    const expiresAfter = body.granted_token?.expires_after_seconds ?? 3600;
    clientTokenCache = {
      token,
      expiresAtMs: Date.now() + Math.max(60, expiresAfter) * 1000,
    };
    return token;
  })();
  const tracked = promise.finally(() => {
    if (clientTokenRequest === tracked) clientTokenRequest = null;
  });
  clientTokenRequest = tracked;
  return tracked;
}

export async function sessionStatus(): Promise<{
  loggedIn: boolean;
  tokenExpiresAtMs: number | null;
}> {
  const session = await loadSession();
  if (!session) return { loggedIn: false, tokenExpiresAtMs: null };
  if (tokenCache && Date.now() < tokenCache.expiresAtMs) {
    return { loggedIn: true, tokenExpiresAtMs: tokenCache.expiresAtMs };
  }
  // 不主动换 token（避免每次状态查询打上游）；有会话即视为已登录。
  return { loggedIn: true, tokenExpiresAtMs: null };
}

async function spotifyGet<T>(path: string): Promise<T> {
  const revision = sessionRevision;
  let token = await getAccessToken();
  let resp: Response;
  // access token 提前失效时只刷新重试一次；确实失效才移除会话。
  for (let attempt = 0; ; attempt += 1) {
    requireCurrentSession(revision);
    try {
      resp = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new AppError("SPOTIFY_API_UNREACHABLE", "Spotify API 不可达", 502, {
        detail: String(error),
      });
    }
    requireCurrentSession(revision);
    if (resp.status !== 401) break;
    if (attempt > 0) {
      await clearSession();
      throw new AppError(
        "SPOTIFY_SESSION_INVALID",
        "Spotify 授权已失效，请重新登录",
        401,
      );
    }
    // 迟到的 401 只作废它使用的旧 token，保留其他请求刚刷新的结果。
    if (tokenCache?.accessToken === token) tokenCache = null;
    token = await getAccessToken();
  }
  if (resp.status === 403) {
    throw new AppError("SPOTIFY_FORBIDDEN", "Spotify 未授权访问该资源", 403);
  }
  if (resp.status === 429) {
    const retryAfter = Number.parseInt(
      resp.headers.get("retry-after") ?? "",
      10,
    );
    const retryAfterMs = Number.isFinite(retryAfter)
      ? Math.max(1000, Math.min(retryAfter * 1000, 10 * 60 * 1000))
      : null;
    throw new AppError(
      "SPOTIFY_RATE_LIMITED",
      retryAfterMs
        ? `Spotify 请求过于频繁，请约 ${Math.ceil(retryAfterMs / 60000)} 分钟后重试`
        : "Spotify 请求过于频繁，请稍后重试",
      429,
      { retryAfterMs },
    );
  }
  if (!resp.ok) {
    throw new AppError(
      "SPOTIFY_API_ERROR",
      `Spotify API 返回 ${resp.status}`,
      502,
    );
  }
  const body = (await resp.json()) as T;
  requireCurrentSession(revision);
  return body;
}

interface PathfinderEnvelope<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

async function pathfinderQuery<T>(
  operationName: string,
  variables: Record<string, unknown>,
  sha256Hash: string,
): Promise<T> {
  const revision = sessionRevision;
  let accessToken = await getAccessToken();
  const clientToken = await getClientToken();
  for (let attempt = 0; ; attempt += 1) {
    requireCurrentSession(revision);
    let resp: Response;
    try {
      resp = await fetch(PATHFINDER_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Client-Token": clientToken,
          "Content-Type": "application/json;charset=UTF-8",
          "Spotify-App-Version": SPOTIFY_APP_VERSION,
          "App-Platform": "WebPlayer",
          Referer: "https://open.spotify.com/",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          operationName,
          variables,
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new AppError(
        "SPOTIFY_API_UNREACHABLE",
        "Spotify Web Player API 不可达",
        502,
        {
          detail: String(error),
        },
      );
    }
    requireCurrentSession(revision);
    if (resp.status === 401) {
      if (attempt > 0) {
        await clearSession();
        throw new AppError(
          "SPOTIFY_SESSION_INVALID",
          "Spotify 授权已失效，请重新登录",
          401,
        );
      }
      if (tokenCache?.accessToken === accessToken) tokenCache = null;
      accessToken = await getAccessToken();
      continue;
    }
    if (resp.status === 403) {
      throw new AppError("SPOTIFY_FORBIDDEN", "Spotify 未授权访问该资源", 403);
    }
    if (resp.status === 429) {
      const retryAfter = Number.parseInt(
        resp.headers.get("retry-after") ?? "",
        10,
      );
      const retryAfterMs = Number.isFinite(retryAfter)
        ? Math.max(1000, Math.min(retryAfter * 1000, 10 * 60 * 1000))
        : null;
      throw new AppError(
        "SPOTIFY_RATE_LIMITED",
        retryAfterMs
          ? `Spotify 请求过于频繁，请约 ${Math.ceil(retryAfterMs / 60000)} 分钟后重试`
          : "Spotify 请求过于频繁，请稍后重试",
        429,
        { retryAfterMs },
      );
    }
    if (!resp.ok) {
      throw new AppError(
        "SPOTIFY_PATHFINDER_ERROR",
        `Spotify Web Player API 返回 ${resp.status}`,
        502,
      );
    }
    const body = (await resp.json()) as PathfinderEnvelope<T>;
    if (body.errors?.length) {
      throw new AppError(
        "SPOTIFY_PATHFINDER_ERROR",
        body.errors[0]?.message || "Spotify Web Player 查询失败",
        502,
      );
    }
    if (!body.data) {
      throw new AppError(
        "SPOTIFY_RESPONSE_INVALID",
        "Spotify Web Player 返回了无效数据",
        502,
      );
    }
    return body.data;
  }
}

interface RawTrack {
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: Array<{ url: string }> };
  type?: string;
  is_local?: boolean;
}

function normalizeTrack(
  raw: RawTrack | null | undefined,
): SpotifyTrackEntry | null {
  if (
    !raw?.id ||
    !raw.name ||
    raw.is_local ||
    (raw.type && raw.type !== "track")
  )
    return null;
  return {
    id: raw.id,
    title: raw.name,
    artist: (raw.artists ?? []).map((a) => a.name).join(", "),
    album: raw.album?.name ?? "",
    durationMs: raw.duration_ms ?? 0,
    coverUrl: raw.album?.images?.[0]?.url ?? null,
    uri: raw.uri,
  };
}

export type SpotifyTimeRange = "short_term" | "medium_term" | "long_term";

export interface SpotifyPage<T> {
  items: T[];
  limit: number;
  offset: number;
  total: number;
  nextOffset: number | null;
}

interface RawPage<T> {
  items: T[];
  total?: number;
  next?: string | null;
}

function normalizePage<T, U>(
  body: RawPage<T>,
  limit: number,
  offset: number,
  normalize: (item: T) => U | null,
): SpotifyPage<U> {
  if (!Array.isArray(body.items)) {
    throw new AppError(
      "SPOTIFY_RESPONSE_INVALID",
      "Spotify 返回了无效的列表数据",
      502,
    );
  }
  const nextOffset = offset + body.items.length;
  const total = body.total ?? nextOffset;
  return {
    items: body.items.map(normalize).filter((item): item is U => item !== null),
    limit,
    offset,
    total,
    // 按上游原始条目数翻页，过滤掉下架歌曲也不会重复取同一页。
    nextOffset:
      body.items.length > 0 &&
      (body.next || (body.next === undefined && nextOffset < total))
        ? nextOffset
        : null,
  };
}

async function topTracksViaApi(
  timeRange: SpotifyTimeRange,
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  const body = await spotifyGet<RawPage<RawTrack | null>>(
    `/me/top/tracks?limit=${limit}&offset=${offset}&time_range=${timeRange}`,
  );
  return normalizePage(body, limit, offset, normalizeTrack);
}

async function userPlaylistsViaApi(
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyPlaylistSummary>> {
  const body = await spotifyGet<
    RawPage<{
      id: string;
      name: string;
      tracks?: { total?: number };
      items?: { total?: number };
      images?: Array<{ url: string }>;
    } | null>
  >(`/me/playlists?limit=${limit}&offset=${offset}`);
  return normalizePage(body, limit, offset, (item) =>
    item
      ? {
          id: item.id,
          name: item.name,
          tracksTotal: item.items?.total ?? item.tracks?.total ?? 0,
          coverUrl: item.images?.[0]?.url ?? null,
        }
      : null,
  );
}

async function playlistTracksViaApi(
  playlistId: string,
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  const body = await spotifyGet<
    RawPage<{
      track?: RawTrack | null;
      item?: RawTrack | null;
      is_local?: boolean;
    } | null>
  >(
    `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}`,
  );
  return normalizePage(body, limit, offset, (entry) => {
    if (!entry || entry.is_local) return null;
    return normalizeTrack("item" in entry ? entry.item : entry.track);
  });
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : null;
}

function uriId(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  const match =
    /^spotify:track:([A-Za-z0-9]+)$/.exec(uri) ??
    /^spotify:playlist:([A-Za-z0-9]+)$/.exec(uri);
  return match?.[1] ?? null;
}

function firstSource(value: unknown): string | null {
  const record = asRecord(value);
  const sources = record?.sources;
  if (!Array.isArray(sources)) return null;
  const source = asRecord(sources[0]);
  return typeof source?.url === "string" ? source.url : null;
}

function normalizePathfinderTrack(value: unknown): SpotifyTrackEntry | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = uriId(raw.uri);
  const uri = typeof raw.uri === "string" ? raw.uri : "";
  if (
    !id ||
    raw.__typename !== "Track" ||
    raw.playability?.playable === false
  ) {
    return null;
  }
  const artists = asRecord(raw.artists)?.items;
  const artist = Array.isArray(artists)
    ? artists
        .map((item) => asRecord(asRecord(item)?.profile)?.name)
        .filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        )
        .join(", ")
    : "";
  const album = asRecord(raw.albumOfTrack);
  const duration = asRecord(raw.trackDuration) ?? asRecord(raw.duration);
  return {
    id,
    title: typeof raw.name === "string" ? raw.name : "",
    artist,
    album: typeof album?.name === "string" ? album.name : "",
    durationMs:
      typeof duration?.totalMilliseconds === "number"
        ? duration.totalMilliseconds
        : 0,
    coverUrl: firstSource(asRecord(album?.coverArt)),
    uri,
  };
}

function normalizePathfinderPage<T>(
  items: unknown,
  limit: number,
  offset: number,
  total: number,
  normalize: (item: unknown) => T | null,
): SpotifyPage<T> {
  if (!Array.isArray(items)) {
    throw new AppError(
      "SPOTIFY_RESPONSE_INVALID",
      "Spotify 返回了无效的列表数据",
      502,
    );
  }
  return {
    items: items.map(normalize).filter((item): item is T => item !== null),
    limit,
    offset,
    total,
    nextOffset:
      items.length > 0 && offset + items.length < total
        ? offset + items.length
        : null,
  };
}

async function topTracksViaPathfinder(
  timeRange: SpotifyTimeRange,
  limit: number,
  offset: number,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  const data = await pathfinderQuery<Record<string, any>>(
    "userTopContent",
    {
      includeTopArtists: false,
      topArtistsInput: {
        offset: 0,
        limit: 10,
        sortBy: "AFFINITY",
        timeRange: timeRange.toUpperCase(),
      },
      includeTopTracks: true,
      topTracksInput: {
        offset,
        limit,
        sortBy: "AFFINITY",
        timeRange: timeRange.toUpperCase(),
      },
    },
    PATHFINDER_HASHES.userTopContent,
  );
  const topTracks = asRecord(asRecord(data.me)?.profile)?.topTracks;
  return normalizePathfinderPage(
    topTracks?.items,
    limit,
    offset,
    typeof topTracks?.totalCount === "number" ? topTracks.totalCount : offset,
    (item) => normalizePathfinderTrack(asRecord(item)?.data),
  );
}

async function userPlaylistsViaPathfinder(
  limit: number,
  offset: number,
): Promise<SpotifyPage<SpotifyPlaylistSummary>> {
  const data = await pathfinderQuery<Record<string, any>>(
    "libraryV3",
    {
      order: null,
      textFilter: "",
      features: [
        "LIKED_SONGS",
        "YOUR_EPISODES_V2",
        "PRERELEASES",
        "PRERELEASES_V2",
        "CLIPS",
        "EVENTS",
      ],
      limit,
      offset,
      flatten: false,
      expandedFolders: [],
      folderUri: null,
      includeFoldersWhenFlattening: true,
    },
    PATHFINDER_HASHES.libraryV3,
  );
  const library = asRecord(asRecord(data.me)?.libraryV3);
  return normalizePathfinderPage(
    library?.items,
    limit,
    offset,
    typeof library?.totalCount === "number" ? library.totalCount : offset,
    (item) => {
      const data = asRecord(asRecord(item)?.item)?.data;
      const id = uriId(data?.uri);
      if (!id || data?.__typename !== "Playlist") return null;
      const images = asRecord(data.images)?.items;
      const image = Array.isArray(images) ? asRecord(images[0]) : null;
      const count =
        asRecord(data.content)?.totalCount ??
        asRecord(data.tracks)?.total ??
        asRecord(data.items)?.total;
      return {
        id,
        name: typeof data.name === "string" ? data.name : "",
        tracksTotal: typeof count === "number" ? count : 0,
        coverUrl: firstSource({ sources: image?.sources }),
      };
    },
  );
}

async function playlistTracksViaPathfinder(
  playlistId: string,
  limit: number,
  offset: number,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  const data = await pathfinderQuery<Record<string, any>>(
    "fetchPlaylist",
    {
      uri: `spotify:playlist:${playlistId}`,
      offset,
      limit,
      enableWatchFeedEntrypoint: true,
      includeEpisodeContentRatingsV2: true,
    },
    PATHFINDER_HASHES.fetchPlaylist,
  );
  const content = asRecord(asRecord(data.playlistV2)?.content);
  return normalizePathfinderPage(
    content?.items,
    limit,
    offset,
    typeof content?.totalCount === "number" ? content.totalCount : offset,
    (item) => normalizePathfinderTrack(asRecord(asRecord(item)?.itemV2)?.data),
  );
}

export async function topTracks(
  timeRange: SpotifyTimeRange,
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  return USE_PATHFINDER
    ? topTracksViaPathfinder(timeRange, limit, offset)
    : topTracksViaApi(timeRange, limit, offset);
}

export async function userPlaylists(
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyPlaylistSummary>> {
  return USE_PATHFINDER
    ? userPlaylistsViaPathfinder(limit, offset)
    : userPlaylistsViaApi(limit, offset);
}

export async function playlistTracks(
  playlistId: string,
  limit: number,
  offset = 0,
): Promise<SpotifyPage<SpotifyTrackEntry>> {
  return USE_PATHFINDER
    ? playlistTracksViaPathfinder(playlistId, limit, offset)
    : playlistTracksViaApi(playlistId, limit, offset);
}

// 后续页面按需读取，第一首匹配后即可开播，大歌单也不会被截成前 100 首。
export async function* playlistEntries(
  playlistId: string,
): AsyncGenerator<SpotifyTrackEntry> {
  let offset: number | null = 0;
  while (offset !== null) {
    const page: SpotifyPage<SpotifyTrackEntry> = await playlistTracks(
      playlistId,
      100,
      offset,
    );
    yield* page.items;
    offset = page.nextOffset;
  }
}

// 后台补队列任务序号：新一轮播放作废旧任务（同 charts 的纪律）。
let spotifyBackfillSeq = 0;

// 搜索候选复用现有同曲校验，避免首条结果是同名异人歌曲就直接播放。
async function matchSpotifyEntry(entry: {
  title: string;
  artist: string;
}): Promise<HMusicTrack | undefined> {
  try {
    const result = await searchTracks({
      query: `${entry.title} ${entry.artist}`.trim(),
      page: 1,
      limit: 5,
    });
    return result.tracks.find((track) =>
      isSameSong(track, { ...track, title: entry.title, artist: entry.artist }),
    );
  } catch {
    return undefined; // 单条匹配失败尽力而为，不阻断整单
  }
}

export async function playSpotifyEntries(
  entries: SpotifyTrackEntry[] | AsyncIterable<SpotifyTrackEntry>,
  body: { startIndex?: number; deviceId?: string },
): Promise<{ queue: unknown; playback: unknown; matched: number }> {
  const startIndex = body.startIndex ?? 0;
  if (
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    (Array.isArray(entries) &&
      entries.length > 0 &&
      startIndex >= entries.length)
  ) {
    throw new AppError("SPOTIFY_INDEX_INVALID", "播放索引超出范围", 400, {
      startIndex,
    });
  }

  const seq = ++spotifyBackfillSeq;
  const revision = sessionRevision;
  let queueRevision = getQueueRevision();
  const isCurrent = () =>
    seq === spotifyBackfillSeq &&
    revision === sessionRevision &&
    queueRevision === getQueueRevision();
  const requireCurrent = () => {
    if (!isCurrent()) {
      throw new AppError(
        "SPOTIFY_PLAY_CANCELLED",
        "Spotify 播放请求已被新的队列操作取消",
        409,
      );
    }
  };

  const iterator = (async function* () {
    yield* entries;
  })();
  try {
    let firstTrack: HMusicTrack | undefined;
    let inspected = 0;
    while (!firstTrack) {
      requireCurrent();
      const next = await iterator.next();
      requireCurrent();
      if (next.done) break;
      if (inspected++ < startIndex) continue;
      firstTrack = await matchSpotifyEntry(next.value);
      requireCurrent();
    }
    if (!firstTrack) {
      if (inspected > 0 && startIndex >= inspected) {
        throw new AppError("SPOTIFY_INDEX_INVALID", "播放索引超出范围", 400, {
          startIndex,
          length: inspected,
        });
      }
      throw new AppError(
        "SPOTIFY_MATCH_EMPTY",
        "Spotify 条目没有匹配到可播放的曲目",
        409,
      );
    }

    const replacingQueue = replaceQueue({
      tracks: [firstTrack],
      currentIndex: 0,
    });
    queueRevision = getQueueRevision();
    const queue = await replacingQueue;
    requireCurrent();
    const playback = await playTrack({
      track: firstTrack,
      deviceId: body.deviceId,
      queueIndex: 0,
      isCurrent,
    });

    requireCurrent();
    void (async () => {
      try {
        while (isCurrent()) {
          const next = await iterator.next();
          if (next.done || !isCurrent()) return;
          const track = await matchSpotifyEntry(next.value);
          if (!isCurrent()) return;
          if (track) await addQueueTrack(track);
        }
      } finally {
        await iterator.return();
      }
    })().catch((error: unknown) => {
      log.warn(
        {
          code:
            error instanceof AppError ? error.code : "SPOTIFY_BACKFILL_FAILED",
        },
        "Spotify 后台补队列已停止",
      );
    });

    // 响应时只确认第一首曲目已入队；后台累计结果由队列接口读取。
    return { queue, playback, matched: 1 };
  } catch (error) {
    await iterator.return();
    throw error;
  }
}
