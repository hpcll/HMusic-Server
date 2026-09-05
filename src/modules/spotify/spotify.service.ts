import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appConfig } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { addQueueTrack, replaceQueue } from "../queue/queue.service.js";
import { playTrack } from "../playback/playback.service.js";
import { searchTracks } from "../search/search.service.js";

// Spotify 个人会话（路线 B：个人自用非官方通道，2026-09-04 立项）。
//   登录 = 用户在 App 内粘贴网页端 Cookie `sp_dc`，服务端换取 web player
//   access token，之后走 Spotify 官方 /v1 接口读个人数据（Top 曲目/歌单）。
//   token 请求自 2024 中起要求 TOTP 参数；算法与密钥来自社区维护的
//   spot-secrets-go（密钥随官方前端滚动更新，上游仓库过期则本模块整体失效，
//   更新密钥源即可修复——这是本路线的既定维护成本）。商店版禁用（ADR-0003）。

const SESSION_KEY = "spotifySession";
const SECRETS_URL =
  "https://raw.githubusercontent.com/xyloflake/spot-secrets-go/main/secrets/secretDict.json";
const TOKEN_URL = "https://open.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const SECRETS_TTL_MS = 6 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
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

let secretsCache: { dict: Record<string, number[]>; fetchedAt: number } | null =
  null;
let tokenCache: CachedToken | null = null;

export async function loadSession(): Promise<SpotifySession | null> {
  const rows = await db
    .select()
    .from(appConfig)
    .where(eq(appConfig.key, SESSION_KEY))
    .limit(1);
  if (!rows[0]) return null;
  try {
    const parsed = JSON.parse(rows[0].valueJson) as SpotifySession;
    return parsed.spDc ? parsed : null;
  } catch {
    return null;
  }
}

async function saveSession(session: SpotifySession): Promise<void> {
  await db
    .insert(appConfig)
    .values({
      key: SESSION_KEY,
      valueJson: JSON.stringify(session),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: appConfig.key,
      set: { valueJson: JSON.stringify(session), updatedAt: Date.now() },
    });
}

export async function clearSession(): Promise<void> {
  await db.delete(appConfig).where(eq(appConfig.key, SESSION_KEY));
  tokenCache = null;
  secretsCache = null;
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
    throw new AppError("SPOTIFY_SECRETS_EMPTY", "Spotify TOTP 密钥库无有效版本", 502);
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
    throw new AppError(
      "SPOTIFY_SESSION_INVALID",
      "sp_dc 无效或已过期（重新登录 Spotify 网页版拿新 Cookie）",
      resp.status === 401 || resp.status === 403 ? 401 : 502,
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

async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
    return tokenCache.accessToken;
  }
  const session = await loadSession();
  if (!session) {
    throw new AppError(
      "SPOTIFY_NOT_LINKED",
      "还没有登录 Spotify 账号",
      409,
    );
  }
  tokenCache = await requestToken(session.spDc);
  return tokenCache.accessToken;
}

// 首次绑定：先真换一次 token，sp_dc 无效当场报错，不落库坏会话。
export async function linkSession(spDc: string): Promise<void> {
  tokenCache = null;
  tokenCache = await requestToken(spDc);
  await saveSession({ spDc, savedAt: Date.now() });
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
  const token = await getAccessToken();
  let resp: Response;
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
  if (resp.status === 401 || resp.status === 403) {
    tokenCache = null;
    throw new AppError(
      "SPOTIFY_SESSION_INVALID",
      "Spotify 授权已失效，请重新登录",
      401,
    );
  }
  if (!resp.ok) {
    throw new AppError(
      "SPOTIFY_API_ERROR",
      `Spotify API 返回 ${resp.status}`,
      502,
    );
  }
  return (await resp.json()) as T;
}

interface RawTrack {
  id: string | null;
  name: string;
  uri: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: Array<{ url: string }> };
}

function normalizeTrack(raw: RawTrack): SpotifyTrackEntry | null {
  if (!raw.id || !raw.name) return null;
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

export async function topTracks(
  timeRange: SpotifyTimeRange,
  limit: number,
): Promise<SpotifyTrackEntry[]> {
  const body = await spotifyGet<{ items: Array<{ track: RawTrack }> }>(
    `/me/top/tracks?limit=${limit}&time_range=${timeRange}`,
  );
  return body.items
    .map((item) => normalizeTrack(item.track))
    .filter((t): t is SpotifyTrackEntry => t !== null);
}

export async function userPlaylists(
  limit: number,
): Promise<SpotifyPlaylistSummary[]> {
  const body = await spotifyGet<{
    items: Array<{
      id: string;
      name: string;
      tracks?: { total?: number };
      images?: Array<{ url: string }>;
    }>;
  }>(`/me/playlists?limit=${limit}`);
  return body.items.map((item) => ({
    id: item.id,
    name: item.name,
    tracksTotal: item.tracks?.total ?? 0,
    coverUrl: item.images?.[0]?.url ?? null,
  }));
}

export async function playlistTracks(
  playlistId: string,
  limit: number,
): Promise<SpotifyTrackEntry[]> {
  const body = await spotifyGet<{
    items: Array<{ track: RawTrack | null }>;
  }>(
    `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}`,
  );
  return body.items
    .map((item) => (item.track ? normalizeTrack(item.track) : null))
    .filter((t): t is SpotifyTrackEntry => t !== null);
}

// 后台补队列任务序号：新一轮播放作废旧任务（同 charts 的纪律）。
let spotifyBackfillSeq = 0;

// Spotify 条目 → 搜索匹配曲目：搜「歌名 歌手」取第一条（同榜单口径），
// 搜不到返回 undefined；匹配率由调用方如实上报。
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
    return result.tracks[0];
  } catch {
    return undefined; // 单条匹配失败尽力而为，不阻断整单
  }
}

export async function playSpotifyEntries(
  entries: SpotifyTrackEntry[],
  body: { startIndex?: number; deviceId?: string },
): Promise<{ queue: unknown; playback: unknown; matched: number }> {
  const startIndex = body.startIndex ?? 0;
  if (startIndex >= entries.length) {
    throw new AppError("SPOTIFY_INDEX_INVALID", "播放索引超出范围", 400, {
      startIndex,
      length: entries.length,
    });
  }

  let firstTrack: HMusicTrack | undefined;
  let firstAt = -1;
  for (let i = startIndex; i < entries.length; i++) {
    firstTrack = await matchSpotifyEntry(entries[i]!);
    if (firstTrack) {
      firstAt = i;
      break;
    }
  }
  if (!firstTrack) {
    throw new AppError(
      "SPOTIFY_MATCH_EMPTY",
      "Spotify 条目没有匹配到可播放的曲目",
      409,
    );
  }

  const queue = await replaceQueue({ tracks: [firstTrack], currentIndex: 0 });
  const playback = await playTrack({
    track: firstTrack,
    deviceId: body.deviceId,
    queueIndex: 0,
  });

  const seq = ++spotifyBackfillSeq;
  void (async () => {
    let matched = 1;
    for (let i = firstAt + 1; i < entries.length; i++) {
      if (seq !== spotifyBackfillSeq) return;
      const track = await matchSpotifyEntry(entries[i]!);
      if (seq !== spotifyBackfillSeq) return;
      if (!track) continue;
      matched += 1;
      try {
        await addQueueTrack(track);
      } catch {
        return; // 队列写入失败（如已被清空重建）就收手
      }
    }
  })();

  return { queue, playback, matched: firstAt - startIndex + 1 };
}
