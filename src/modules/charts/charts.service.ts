import { desc, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { playHistory } from "../../db/schema.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import {
  fetchJson,
  fetchNetease,
  parseQQSong,
} from "../playlists/playlist-import.service.js";

// 榜单条目：只含元数据，点播时走 search/resolve 现有管线。
// 家庭榜/网易云榜/QQ榜的条目带 track（真实曲目结构），可跳过搜索直接播放；
// Apple 榜只有歌名歌手，点播时前端先搜索匹配。
export type ChartEntry = {
  rank: number;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  playCount?: number;
  track?: HMusicTrack;
};

export type ChartSummary = {
  id: string;
  name: string;
  description: string;
  kind: "family" | "netease" | "qq" | "apple";
};

export type Chart = ChartSummary & {
  updatedAt: number;
  entries: ChartEntry[];
};

const CHART_SIZE = 50;

// ===== 榜单目录（family → 网易云 → QQ → Apple，即前端卡片墙分组顺序） =====

const FAMILY_CHART: ChartSummary = {
  id: "family",
  name: "家庭热播",
  description: "最近 30 天全家最常听",
  kind: "family",
};

// 网易云官方榜就是固定 ID 的官方歌单，复用歌单导入的抓取管线。
const NETEASE_CHARTS: Array<ChartSummary & { playlistId: string }> = [
  {
    id: "wy-hot",
    name: "热歌榜",
    description: "网易云音乐官方热歌榜",
    kind: "netease",
    playlistId: "3778678",
  },
  {
    id: "wy-new",
    name: "新歌榜",
    description: "网易云音乐官方新歌榜",
    kind: "netease",
    playlistId: "3779629",
  },
  {
    id: "wy-soar",
    name: "飙升榜",
    description: "网易云音乐官方飙升榜",
    kind: "netease",
    playlistId: "19723756",
  },
  {
    id: "wy-origin",
    name: "原创榜",
    description: "网易云音乐官方原创榜",
    kind: "netease",
    playlistId: "2884035",
  },
];

const QQ_CHARTS: Array<ChartSummary & { topId: number }> = [
  {
    id: "qq-hot",
    name: "热歌榜",
    description: "QQ音乐巅峰热歌榜",
    kind: "qq",
    topId: 26,
  },
  {
    id: "qq-new",
    name: "新歌榜",
    description: "QQ音乐巅峰新歌榜",
    kind: "qq",
    topId: 27,
  },
  {
    id: "qq-soar",
    name: "飙升榜",
    description: "QQ音乐巅峰飙升榜",
    kind: "qq",
    topId: 62,
  },
];

// Apple RSS 是官方公开接口（无需鉴权），换地区码即得一个地区榜。
const APPLE_REGIONS = [
  { id: "apple-cn", region: "cn", label: "中国" },
  { id: "apple-us", region: "us", label: "美国" },
  { id: "apple-jp", region: "jp", label: "日本" },
  { id: "apple-kr", region: "kr", label: "韩国" },
  { id: "apple-tw", region: "tw", label: "台湾" },
  { id: "apple-hk", region: "hk", label: "香港" },
];

const APPLE_CHARTS: Array<ChartSummary & { feedUrl: string }> =
  APPLE_REGIONS.map(({ id, region, label }) => ({
    id,
    name: `热门歌曲 · ${label}`,
    description: `Apple Music ${label}区最热歌曲`,
    kind: "apple" as const,
    feedUrl: `https://rss.marketingtools.apple.com/api/v2/${region}/music/most-played/50/songs.json`,
  }));

// ===== 通用缓存：日更榜单 6 小时缓存足够，拉取失败回退过期缓存 =====

const CHART_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const chartCache = new Map<string, { fetchedAt: number; chart: Chart }>();

async function cachedChart(
  def: ChartSummary,
  fetcher: () => Promise<ChartEntry[]>,
): Promise<Chart> {
  const cached = chartCache.get(def.id);
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_TTL_MS) {
    return cached.chart;
  }

  let entries: ChartEntry[];
  try {
    entries = await fetcher();
  } catch (error) {
    // 拉取失败时退回过期缓存（若有），避免榜单页整页报错。
    if (cached) return cached.chart;
    throw new AppError(
      "CHART_FETCH_FAILED",
      `榜单拉取失败：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const chart: Chart = { ...toSummary(def), updatedAt: Date.now(), entries };
  chartCache.set(def.id, { fetchedAt: Date.now(), chart });
  return chart;
}

// ===== Apple Music RSS 榜单（官方公开接口，无需鉴权） =====

type AppleFeedSong = {
  name?: string;
  artistName?: string;
  artworkUrl100?: string;
};

async function fetchAppleEntries(feedUrl: string): Promise<ChartEntry[]> {
  const response = await fetch(feedUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Apple RSS ${response.status}`);
  }
  const payload = (await response.json()) as {
    feed?: { results?: AppleFeedSong[] };
  };
  return (payload.feed?.results || [])
    .filter((song) => song.name && song.artistName)
    .map((song, index) => ({
      rank: index + 1,
      title: song.name!,
      artist: song.artistName!,
      // RSS 给的是 100x100 缩略图地址，换成 300x300 更配大列表。
      coverUrl: song.artworkUrl100?.replace("100x100", "300x300"),
    }));
}

// ===== 网易云官方榜：榜单歌单 → 带 track 的条目（可直接点播） =====

async function fetchNeteaseEntries(playlistId: string): Promise<ChartEntry[]> {
  const { tracks } = await fetchNetease(playlistId, CHART_SIZE);
  return tracks.slice(0, CHART_SIZE).map((track, index) => ({
    rank: index + 1,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    track,
  }));
}

// ===== QQ 巅峰榜：musicu toplist 接口 → 复用歌单导入的 QQ 曲目解析 =====

async function fetchQQEntries(topId: number): Promise<ChartEntry[]> {
  // 不带 period 通常即返回最新一期；为空则查榜单目录拿 period 重试一次。
  let songs = await fetchQQToplistSongs(topId, undefined);
  if (songs.length === 0) {
    const period = await fetchQQToplistPeriod(topId);
    if (period) songs = await fetchQQToplistSongs(topId, period);
  }
  if (songs.length === 0) {
    throw new Error("QQ 榜单返回空 songInfoList");
  }

  return songs
    .slice(0, CHART_SIZE)
    .map((song, index) => {
      // songInfoList 的专辑是嵌套对象 album:{mid,name}，摊平成 parseQQSong 认的字段。
      const track = parseQQSong({ ...song, albummid: song?.album?.mid });
      if (!track) return undefined;
      const albumName = song?.album?.name ? String(song.album.name) : undefined;
      return {
        rank: index + 1,
        title: track.title,
        artist: track.artist,
        album: albumName,
        coverUrl: track.coverUrl,
        track,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

async function fetchQQToplistSongs(
  topId: number,
  period: string | undefined,
): Promise<any[]> {
  const body = {
    comm: { ct: 24, cv: 0 },
    toplist: {
      module: "musicToplist.ToplistInfoServer",
      method: "GetDetail",
      param: {
        topId,
        offset: 0,
        num: CHART_SIZE,
        ...(period ? { period } : {}),
      },
    },
  };
  const data = await fetchJson("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: { Referer: "https://y.qq.com/", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return asArray((data as any)?.toplist?.data?.songInfoList);
}

async function fetchQQToplistPeriod(topId: number): Promise<string | undefined> {
  const body = {
    comm: { ct: 24, cv: 0 },
    toplists: {
      module: "musicToplist.ToplistInfoServer",
      method: "GetAll",
      param: {},
    },
  };
  const data = await fetchJson("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: { Referer: "https://y.qq.com/", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const groups = asArray((data as any)?.toplists?.data?.group);
  for (const group of groups) {
    for (const item of asArray(group?.toplist)) {
      if (Number(item?.topId) === topId && item?.period) {
        return String(item.period);
      }
    }
  }
  return undefined;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

// ===== 播放历史 → 家庭热播榜 =====

const FAMILY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_DEDUP_MS = 60 * 1000; // 同曲 1 分钟内重复触发只记一次（队列重试等）

export function recordPlay(track: HMusicTrack): void {
  // 测试音、TTS 等内部曲目不入历史。
  if (track.source === "manual" && track.sourceTrackId === "hmusic-test-tone") {
    return;
  }
  const trackKey = `${track.source}:${track.sourceTrackId}`;
  const now = Date.now();

  const recent = db
    .select({ playedAt: playHistory.playedAt })
    .from(playHistory)
    .where(sql`${playHistory.trackKey} = ${trackKey}`)
    .orderBy(desc(playHistory.playedAt))
    .limit(1)
    .all();
  if (recent.length && now - recent[0].playedAt < HISTORY_DEDUP_MS) return;

  db.insert(playHistory)
    .values({
      id: nanoid(),
      trackKey,
      source: track.source,
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.coverUrl,
      trackJson: JSON.stringify(track),
      playedAt: now,
    })
    .run();
}

function buildFamilyChart(): Chart {
  const since = Date.now() - FAMILY_WINDOW_MS;
  const rows = db
    .select()
    .from(playHistory)
    .where(gte(playHistory.playedAt, since))
    .orderBy(desc(playHistory.playedAt))
    .all();

  // 按曲目聚合次数，快照取最近一次播放的。
  const grouped = new Map<string, { count: number; row: (typeof rows)[number] }>();
  for (const row of rows) {
    const entry = grouped.get(row.trackKey);
    if (entry) entry.count += 1;
    else grouped.set(row.trackKey, { count: 1, row });
  }

  const entries = [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.row.playedAt - a.row.playedAt)
    .slice(0, CHART_SIZE)
    .map(({ count, row }, index) => ({
      rank: index + 1,
      title: row.title,
      artist: row.artist,
      album: row.album ?? undefined,
      coverUrl: row.coverUrl ?? undefined,
      playCount: count,
      track: safeParseTrack(row.trackJson),
    }));

  return { ...FAMILY_CHART, updatedAt: Date.now(), entries };
}

function safeParseTrack(json: string): HMusicTrack | undefined {
  try {
    return JSON.parse(json) as HMusicTrack;
  } catch {
    return undefined;
  }
}

// ===== 对外接口 =====

function toSummary({ id, name, description, kind }: ChartSummary): ChartSummary {
  return { id, name, description, kind };
}

export function listCharts(): ChartSummary[] {
  return [
    FAMILY_CHART,
    ...NETEASE_CHARTS.map(toSummary),
    ...QQ_CHARTS.map(toSummary),
    ...APPLE_CHARTS.map(toSummary),
  ];
}

export async function getChart(id: string): Promise<Chart> {
  if (id === FAMILY_CHART.id) return buildFamilyChart();

  const neteaseDef = NETEASE_CHARTS.find((def) => def.id === id);
  if (neteaseDef) {
    return cachedChart(neteaseDef, () => fetchNeteaseEntries(neteaseDef.playlistId));
  }
  const qqDef = QQ_CHARTS.find((def) => def.id === id);
  if (qqDef) {
    return cachedChart(qqDef, () => fetchQQEntries(qqDef.topId));
  }
  const appleDef = APPLE_CHARTS.find((def) => def.id === id);
  if (appleDef) {
    return cachedChart(appleDef, () => fetchAppleEntries(appleDef.feedUrl));
  }
  throw new AppError("CHART_NOT_FOUND", `未知榜单：${id}`, 404);
}
