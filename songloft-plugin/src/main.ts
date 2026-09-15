/// <reference types="@songloft/plugin-sdk" />
// HMusic Bridge — Songloft 音源桥接插件
//
// 桥接对象:HMusic-Server(本仓库)聚合搜索 + 解析,为 Songloft(2026 新架构音源插件)提供:
//   POST /api/search     → HMusic GET  /api/v1/search?q=&page=&limit=
//   POST /api/music/url  → HMusic POST /api/v1/tracks/resolve { track }
//   POST /api/import     → songloft.songs.create(自动关联本插件)
// 配置(HMusic baseUrl + JWT)存 songloft.storage,仅服务端使用,不进 source_data。
//
// source_data 结构(opaque,宿主原样存 song 表并回传):
//   { schema_version: 1, provider: 'hmusic', track: <HMusicTrack 全量> }

import {
  jsonResponse,
  createRouter,
  parseQuery,
  type SearchResultItem,
  type MusicUrlFallbackHint,
  type Song,
  type HTTPRequest,
  type HTTPResponse,
} from '@songloft/plugin-sdk';

const CONFIG_KEY = 'hmusic.config';
const SOURCE_SCHEMA_VERSION = 1;
const SOURCE_DEDUP_PREFIX = 'hmusic';
const MAX_PAGE_SIZE = 50;

type HMusicConfig = { baseUrl: string; token: string };

interface HMusicTrack {
  id: string;
  source: string;
  sourceTrackId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  url?: string;
  qualities?: string[];
  raw?: unknown;
}

const DEFAULT_CONFIG: HMusicConfig = { baseUrl: 'http://127.0.0.1:6650', token: '' };

function isSameOrigin(a: string, b: string): boolean {
  const oa = canonicalOrigin(a);
  const ob = canonicalOrigin(b);
  return oa !== null && oa === ob;
}

// 宿主 URL polyfill 用 split(':') 拆 hostname/port，会截断 IPv6。
// 独立解析受支持的地址形式；不接受用户信息、zone ID、查询、片段及有歧义的字符。
// 不能可靠解析时拒绝保存/出站，绝不凭部分主机名沿用凭据。
function canonicalOrigin(raw: string): string | null {
  if (/[\s\\\u0000-\u001f\u007f]/.test(raw)) return null;
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::([0-9]+))?(\/[^?#]*)?$/i.exec(raw);
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  let hostname = match[2].toLowerCase();
  if (hostname.startsWith('[')) {
    const address = canonicalIPv6(hostname.slice(1, -1));
    if (address === null) return null;
    hostname = `[${address}]`;
  } else {
    const labels = hostname.replace(/\.$/, '').split('.');
    if (hostname.length > 254 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      return null;
    }
  }
  const defaultPort = protocol === 'https' ? 443 : 80;
  const port = match[3] === undefined ? defaultPort : Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `${protocol}://${hostname}${port === defaultPort ? '' : ':' + port}`;
}

// 展开为八组后比较，兼容 :: 压缩、大小写、前导零及内嵌 IPv4。
function canonicalIPv6(raw: string): string | null {
  let address = raw;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const octets = address.slice(lastColon + 1).split('.');
    if (lastColon < 0 || octets.length !== 4 || octets.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
      return null;
    }
    const bytes = octets.map(Number);
    address = address.slice(0, lastColon + 1)
      + (bytes[0] * 256 + bytes[1]).toString(16) + ':'
      + (bytes[2] * 256 + bytes[3]).toString(16);
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const groups = [...head, ...tail];
  if (groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if (halves.length === 1 ? groups.length !== 8 : groups.length >= 8) return null;
  return [...head, ...Array<string>(8 - groups.length).fill('0'), ...tail]
    .map((part) => parseInt(part, 16).toString(16)).join(':');
}

// 请求体必须是 JSON 对象：JSON.parse('null') 得 null、'[]' 得数组，
// 直接读属性会抛 TypeError 进宿主错误处理，必须统一拦下返 400。
function parseJsonObject(
  raw: string | Uint8Array | null | undefined,
): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === '') return {};
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function loadConfig(): Promise<HMusicConfig> {
  const stored = (await songloft.storage.get(CONFIG_KEY)) as Partial<HMusicConfig> | null;
  return { ...DEFAULT_CONFIG, ...(stored ?? {}) };
}

async function saveConfig(config: HMusicConfig): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, config);
}

// ===== HMusic-Server HTTP 访问 =====
//
// 已核对 Songloft 2.12.0：fetch 最长 30s、响应上限 64MiB。
// X-Fetch-Control 并非该版本内部控制头，不发送未经宿主支持的 bypass。

async function hmusicFetch(
  config: HMusicConfig,
  path: string,
  init: {
    method?: string;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  if (canonicalOrigin(config.baseUrl) === null) {
    throw new Error('HMusic baseUrl is invalid; save a valid http(s) service address');
  }
  const headers: Record<string, string> = {
    // 宿主硬上限：jsruntime 将单请求超时钟制在 100–30000ms（runtime.go），
    // >30000 的值会被钳到 30000，不要写超出。
    'X-Fetch-Timeout-Ms': String(Math.max(100, Math.min(init.timeoutMs ?? 15000, 30000))),
  };
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const base = config.baseUrl.replace(/\/+$/, '');
  return await fetch(base + path, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
  });
}

// ===== 搜索:HMusic tracks → SearchResultItem =====

function toSearchItem(track: HMusicTrack): SearchResultItem {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album ?? '',
    duration: Math.max(0, Math.round((track.durationMs ?? 0) / 1000)),
    cover_url: track.coverUrl ?? '',
    source_data: {
      schema_version: SOURCE_SCHEMA_VERSION,
      provider: 'hmusic',
      track,
    },
  };
}

// ===== 搜索底层:拉取 HMusic 原始 tracks =====

async function hmusicSearchRaw(
  keyword: string,
  page = 1,
  limit = 20,
  timeoutMs = 20000,
  source = '',
): Promise<HMusicTrack[]> {
  const config = await loadConfig();
  const resp = await hmusicFetch(
    config,
    `/api/v1/search?q=${encodeURIComponent(keyword)}&page=${page}&limit=${Math.min(limit, MAX_PAGE_SIZE)}${source ? '&source=' + encodeURIComponent(source) : ''}`,
    { timeoutMs },
  );
  if (!resp.ok) {
    throw new Error(`HMusic search failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { tracks?: HMusicTrack[] };
  return data.tracks ?? [];
}

async function hmusicSearch(
  keyword: string,
  page?: number,
  pageSize?: number,
  source = '',
): Promise<SearchResultItem[]> {
  const limit = Math.min(Math.max(1, pageSize ?? 20), MAX_PAGE_SIZE);
  const pageNum = Math.max(1, page ?? 1);
  return (await hmusicSearchRaw(keyword, pageNum, limit, 20000, source)).map(toSearchItem);
}

// ===== 解析:source_data → 真实播放 URL =====

function extractTrack(sourceData: Record<string, unknown>): HMusicTrack | null {
  if (
    sourceData.provider !== 'hmusic' ||
    sourceData.schema_version !== SOURCE_SCHEMA_VERSION
  ) {
    return null;
  }
  const track = sourceData.track as HMusicTrack | undefined;
  if (!track || ['id', 'source', 'sourceTrackId', 'title', 'artist'].some(
    (key) => typeof (track as unknown as Record<string, unknown>)[key] !== 'string'
      || !(track as unknown as Record<string, string>)[key].trim(),
  )) return null;
  return track;
}

type ResolvedMedia = { url: string; headers?: Record<string, string> };

async function resolveHMusicTrack(track: HMusicTrack, timeoutMs = 20000): Promise<ResolvedMedia> {
  const config = await loadConfig();
  // HMusic 实测解析 ≈2s；超时预算由调用方（music/url 总预算）分配传入。
  const resp = await hmusicFetch(config, '/api/v1/tracks/resolve', {
    method: 'POST',
    body: JSON.stringify({ track, refresh: true, strict: true, timeoutMs: Math.max(100, timeoutMs - 500) }),
    timeoutMs,
  });
  if (!resp.ok) {
    throw new Error(`HMusic resolve failed: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as ResolvedMedia & { verified?: boolean };
  const url = data.url ?? '';
  if (!url) throw new Error('HMusic resolve returned no url');
  if (data.verified !== true) throw new Error('HMusic Server must support strict media verification; update the server');
  return { url, ...(data.headers ? { headers: data.headers } : {}) };
}

// ===== fallback:自搜候选列表(同曲筛选 + 时长择优排序 + 按 dedupKey 去重) =====

function normalizeSongText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

function artistTokens(artist: string): string[] {
  return artist.split(/[、,/&]+/).map((t) => t.trim()).filter(Boolean);
}

function isSameSong(
  a: { title: string; artist: string },
  b: { title: string; artist: string },
): boolean {
  if (!normalizeSongText(a.title).includes(normalizeSongText(b.title))) {
    return false;
  }
  const aTokens = artistTokens(a.artist);
  const bTokens = artistTokens(b.artist);
  return bTokens.length === 0 || aTokens.some((a1) => bTokens.some((b1) => normalizeSongText(a1) === normalizeSongText(b1)));
}

// 候选顺序：时长 ±5s 内的按差值升序排最前，其余保持搜索序。
// 去重按 dedupKey；是否排除已证死的目标曲由调用方(music/url handler)负责。
async function searchCandidates(
  hint: MusicUrlFallbackHint,
  timeoutMs = 20000,
): Promise<HMusicTrack[]> {
  const keyword = `${hint.title} ${hint.artist}`.trim();
  const tracks = await hmusicSearchRaw(keyword, 1, 20, timeoutMs);
  const seen = new Set<string>();
  const matched: Array<{ track: HMusicTrack; diff: number }> = [];
  for (const track of tracks) {
    if (!isSameSong({ title: track.title, artist: track.artist }, { title: hint.title, artist: hint.artist })) {
      continue;
    }
    const key = dedupKeyFor(track);
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push({
      track,
      diff: hint.duration && hint.duration > 0
        ? Math.abs((track.durationMs ?? 0) / 1000 - hint.duration)
        : Number.POSITIVE_INFINITY,
    });
  }
  const near = matched
    .filter((m) => m.diff <= 5)
    .sort((a, b) => a.diff - b.diff);
  const rest = matched.filter((m) => m.diff > 5);
  return [...near, ...rest].map((m) => m.track);
}

// ===== 入库:songloft.songs.create(自动关联本插件) =====

function dedupKeyFor(track: HMusicTrack): string {
  return `${SOURCE_DEDUP_PREFIX}:${track.source}:${track.sourceTrackId}`;
}

interface ImportItem {
  source_data?: Record<string, unknown>;
}

async function importItems(items: ImportItem[]): Promise<Song[]> {
  // CreateSongInput 未从 SDK 导出，用参数类型反推。
  const inputs: Parameters<typeof songloft.songs.create>[0] = [];
  for (const item of items) {
    const track = item?.source_data ? extractTrack(item.source_data) : null;
    if (!track) continue;
    inputs.push({
      title: track.title,
      artist: track.artist,
      album: track.album ?? '',
      coverUrl: track.coverUrl ?? '',
      duration: Math.max(0, Math.round((track.durationMs ?? 0) / 1000)),
      sourceData: JSON.stringify(item.source_data),
      dedupKey: dedupKeyFor(track),
    });
  }
  if (inputs.length === 0) throw new Error('no valid HMusic items to import');
  return await songloft.songs.create(inputs);
}

// ===== 配置/状态路由 =====

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

const router = createRouter();

async function registerMiot(wakeTarget = false): Promise<boolean> {
  try {
    // comm.call 不会唤醒休眠插件；手动注册时先通过宿主 HTTP 路由加载 MIoT。
    // onInit 不走此路径，避免加载插件期间递归等待宿主的加载锁。
    if (wakeTarget) {
      const hostUrl = await songloft.plugin.getHostUrl();
      const token = await songloft.plugin.getToken();
      if (!hostUrl || !token) return false;
      const response = await fetch(`${hostUrl.replace(/\/$/, '')}/api/v1/jsplugin/miot/search-providers`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Fetch-Timeout-Ms': '3000' },
      });
      if (!response.ok) return false;
    }
    const result = await songloft.comm.call('miot', 'register-search-provider', {
      name: 'HMusic', searchPath: '/api/search/topone',
    }, 1500) as { success?: boolean; data?: { ok?: boolean } } | null;
    // 2.12.0 的 comm 会将处理器结果包装为 { success, data }。
    return result?.success === true && result.data?.ok === true;
  } catch {
    return false;
  }
}

router.post('/api/miot/register', async () => {
  const registered = await registerMiot(true);
  return jsonResponse({ registered, message: registered
    ? '已注册，请在 MIoT 设置中启用 HMusic 搜索源。'
    : '未能注册，请安装并启用 MIoT 插件后重试。' });
});

router.get('/', () => {
  return {
    statusCode: 302,
    headers: { Location: 'static/index.html' },
    body: '',
  };
});

router.get('/api/config', async () => {
  const config = await loadConfig();
  return jsonResponse({
    baseUrl: config.baseUrl,
    hasToken: Boolean(config.token),
    tokenMasked: maskToken(config.token),
  });
});

router.post('/api/config', async (req) => {
  const body = parseJsonObject(req.body);
  if (!body) {
    return jsonResponse({ error: 'request body must be a JSON object' }, 400);
  }
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (canonicalOrigin(baseUrl) === null) {
    return jsonResponse({ error: 'baseUrl must be an http(s) URL with a valid host and port, without credentials, query or fragment' }, 400);
  }
  // 请求未携带 token 字段 = 沿用已存凭证；显式传 '' = 清空。
  // 但仅限同 origin：换服务器地址时不把旧服务器的 JWT 发给新服务器，要求重新填写。
  const current = await loadConfig();
  let token: string;
  if (typeof body.token === 'string') {
    token = body.token.trim();
  } else if (isSameOrigin(current.baseUrl, baseUrl)) {
    token = current.token;
  } else {
    token = '';
  }
  await saveConfig({ baseUrl, token });
  songloft.log.info('HMusic Bridge config updated');
  return jsonResponse({ ok: true, baseUrl, hasToken: Boolean(token) });
});

router.get('/api/status', async () => {
  const config = await loadConfig();
  try {
    const resp = await hmusicFetch(config, '/api/v1/auth/status', { timeoutMs: 10000 });
    if (!resp.ok) {
      return jsonResponse({ reachable: true, authenticated: false, error: `HTTP ${resp.status}` });
    }
    const data = (await resp.json()) as { authenticated?: boolean };
    return jsonResponse({
      reachable: true,
      authenticated: Boolean(data.authenticated),
    });
  } catch (err) {
    return jsonResponse({
      reachable: false,
      authenticated: false,
      error: String((err as Error)?.message ?? err),
    });
  }
});

router.post('/api/import', async (req) => {
  const parsed = parseJsonObject(req.body);
  if (!parsed) {
    return jsonResponse({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsed as { items?: ImportItem[] };
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return jsonResponse({ error: 'items is required' }, 400);
  try {
    const songs = await importItems(items);
    return jsonResponse({
      songs: songs.map((s) => ({ id: s.id, title: s.title, artist: s.artist })),
    });
  } catch (err) {
    return jsonResponse({ error: String((err as Error)?.message ?? err) }, 500);
  }
});

// ===== 音源约定路由(主程序 2026 新架构) =====

router.post(
  '/api/search',
  // 不用 SDK createSearchHandler：其对 JSON.parse('null') 不设防（null.keyword
  // 抛 TypeError 进宿主错误处理）。这里与其他路由共用 parseJsonObject 校验。
  async (req) => {
    const body = parseJsonObject(req.body);
    if (!body) {
      return jsonResponse({ error: 'request body must be a JSON object' }, 400);
    }
    const keyword = String(body.keyword ?? '').trim();
    if (!keyword) {
      return jsonResponse({ error: 'keyword is required' }, 400);
    }
    const page = typeof body.page === 'number' ? body.page : undefined;
    const pageSize = typeof body.page_size === 'number' ? body.page_size : undefined;
    const source = typeof body.source === 'string' ? body.source : '';
    if (!['', 'tx', 'kw', 'wy', 'manual'].includes(source)
      || [page, pageSize].some((n) => n !== undefined && (!Number.isInteger(n) || n < 1))) {
      return jsonResponse({ error: 'invalid source or pagination' }, 400);
    }
    try {
      return jsonResponse({ results: await hmusicSearch(keyword, page, pageSize, source) });
    } catch (err) {
      return jsonResponse({ error: String((err as Error)?.message ?? err) }, 500);
    }
  },
);

// 不用 SDK createMusicUrlHandler 的单次 fallbackSearch——它只回一个候选，
// 首候选恰巧不可用时直接 404。自实现候选遍历：
//   1. resolveUrl(原始 source_data)
//   2. 失败 + hint.enabled → 自搜一次，排除已证死的目标曲，按序重试其余候选
//   3. 全部失败 → 404 source_not_available
//
// 超时预算：宿主对插件 HTTP 调用约 30s 上限，且单请求 X-Fetch-Timeout-Ms 被钳制在 ≤30s。
// 原曲解析 + 自搜 + 候选串行解析必须共享同一总预算，否则慢源场景
// 未完成换源就被宿主整体超时。预算耗尽即止损，交由宿主下次重试。
router.post('/api/music/url', async (req) => {
  const parsed = parseJsonObject(req.body);
  if (!parsed) {
    return jsonResponse({ error: 'request body must be a JSON object' }, 400);
  }
  const body = parsed as Record<string, unknown>;
  const sourceData = body.source_data as Record<string, unknown> | undefined;
  if (!sourceData || typeof sourceData !== 'object') {
    return jsonResponse({ error: 'source_data is required' }, 400);
  }

  const startedAt = Date.now();
  const TOTAL_BUDGET_MS = 26000; // 宿主 30s 上限留 4s 余量
  const MIN_ATTEMPT_MS = 4000;   // 剩余预算低于此值不再发起新尝试
  const remainingMs = () => TOTAL_BUDGET_MS - (Date.now() - startedAt);
  const attemptTimeout = () => Math.max(100, Math.min(20000, remainingMs()));

  // 已证死的目标曲：换源候选里必须排除，避免反复解析同一死链。
  const failedTrack = extractTrack(sourceData);
  const failedKey = failedTrack ? dedupKeyFor(failedTrack) : null;

  if (failedTrack) {
    try {
      const media = await resolveHMusicTrack(failedTrack, attemptTimeout());
      return jsonResponse(media);
    } catch {
      // 落入换源候选遍历
    }
  }

  const hint = body.fallback as MusicUrlFallbackHint | undefined;
  if (hint?.enabled && remainingMs() >= MIN_ATTEMPT_MS) {
    let candidates: HMusicTrack[] = [];
    try {
      candidates = await searchCandidates(hint, attemptTimeout());
    } catch {
      candidates = [];
    }
    for (const candidate of candidates) {
      if (failedKey && dedupKeyFor(candidate) === failedKey) continue;
      if (remainingMs() < MIN_ATTEMPT_MS) break; // 预算耗尽，停止尝试
      try {
        const media = await resolveHMusicTrack(candidate, attemptTimeout());
        return jsonResponse({
          ...media,
          source_data: {
            schema_version: SOURCE_SCHEMA_VERSION,
            provider: 'hmusic',
            track: candidate,
          },
          used_fallback: true,
        });
      } catch {
        continue; // 该候选不可播，尝试下一个
      }
    }
  }

  return jsonResponse({ error: 'source_not_available' }, 404);
});

// MIoT 的外部搜索协议使用 code/msg/data；只返回候选，入库和设备控制归 MIoT。
router.post('/api/search/topone', async (req) => {
  const body = parseJsonObject(req.body);
  if (!body || typeof body.keyword !== 'string' || !body.keyword.trim()) {
    return jsonResponse({ code: 400, msg: 'keyword is required', data: null }, 400);
  }
  const hint = body.hint as Partial<MusicUrlFallbackHint> | undefined;
  try {
    const candidates = hint && typeof hint.title === 'string' && hint.title.trim()
      ? await searchCandidates({ enabled: true, title: hint.title,
        artist: typeof hint.artist === 'string' ? hint.artist : '',
        duration: typeof hint.duration === 'number' ? hint.duration : undefined }, 4500)
      : await hmusicSearchRaw(body.keyword.trim(), 1, 20, 4500);
    const track = candidates[0];
    return jsonResponse({ code: 0, msg: track ? 'ok' : 'not found', data: track ? {
      ...toSearchItem(track), plugin_entry_path: 'hmusic-bridge', dedup_key: dedupKeyFor(track),
    } : null });
  } catch {
    return jsonResponse({ code: 502, msg: 'HMusic search unavailable', data: null }, 502);
  }
});

async function trackLyrics(track: HMusicTrack, timeoutMs: number) {
  const response = await hmusicFetch(await loadConfig(), '/api/v1/tracks/lyrics', {
    method: 'POST', body: JSON.stringify({ track }), timeoutMs,
  });
  if (!response.ok) throw new Error(`HMusic lyrics failed: HTTP ${response.status}`);
  const data = await response.json() as {
    lrc?: string; translatedLines?: Array<{ timeMs: number; text: string }>;
  };
  const translated = (data.translatedLines ?? []).map((line) => {
    const ms = Math.max(0, Math.round(line.timeMs));
    return `[${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}]${line.text}`;
  }).join('\n');
  return { lyric: data.lrc ?? '', ...(translated ? { tlyric: translated } : {}) };
}

router.post('/api/lyrics', async (req) => {
  const body = parseJsonObject(req.body);
  const track = body?.source_data && typeof body.source_data === 'object'
    ? extractTrack(body.source_data as Record<string, unknown>) : null;
  if (!track) return jsonResponse({ error: 'valid source_data is required' }, 400);
  try {
    const lyrics = await trackLyrics(track, 12000);
    return jsonResponse(lyrics, lyrics.lyric ? 200 : 404);
  } catch { return jsonResponse({ error: 'lyrics unavailable' }, 502); }
});

router.get('/lyric-search', async (req) => {
  const query = parseQuery(req.query);
  if (!query.title?.trim()) return jsonResponse({ error: 'title is required' }, 400);
  const deadline = Date.now() + 13000; // 宿主歌词调用上限 15s。
  try {
    const candidates = await searchCandidates({ enabled: true, title: query.title,
      artist: query.artist ?? '', duration: Number(query.duration) || undefined }, 5000);
    for (const track of candidates.slice(0, 3)) {
      const remaining = deadline - Date.now();
      if (remaining < 1000) break;
      try {
        const lyrics = await trackLyrics(track, Math.min(6000, remaining));
        if (lyrics.lyric) return jsonResponse(lyrics);
      } catch { /* 当前来源无歌词，继续同曲候选。 */ }
    }
  } catch { /* 搜索失败按无歌词处理，宿主可继续其他 provider。 */ }
  return jsonResponse({ lyric: '' }, 404);
});

// ===== 生命周期(QuickJS 需显式暴露全局) =====

async function onInit(): Promise<void> {
  songloft.lyrics.registerProvider();
  const config = await loadConfig();
  await registerMiot();
  songloft.log.info(`HMusic Bridge initialized (baseUrl=${config.baseUrl}, hasToken=${Boolean(config.token)})`);
}

async function onDeinit(): Promise<void> {
  // onDeinit 也用于空闲休眠，保留歌词与搜索源身份才能让请求重新唤醒插件。
  // 真正禁用/卸载时，宿主歌词管理器与 MIoT 的 installed/active 校验负责过滤。
  songloft.log.info('HMusic Bridge deinitialized');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req);
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
