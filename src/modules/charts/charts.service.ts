import { desc, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { playHistory } from "../../db/schema.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";

// 榜单条目：只含元数据，点播时走 search/resolve 现有管线。
// 家庭榜的条目带 track（历史快照），可跳过搜索直接播放。
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
  kind: "apple" | "family";
};

export type Chart = ChartSummary & {
  updatedAt: number;
  entries: ChartEntry[];
};

// ===== Apple Music RSS 榜单（官方公开接口，无需鉴权） =====

const APPLE_CHARTS: Array<ChartSummary & { feedUrl: string }> = [
  {
    id: "apple-cn",
    name: "热门歌曲 · 中国",
    description: "Apple Music 中国区最热歌曲",
    kind: "apple",
    feedUrl:
      "https://rss.marketingtools.apple.com/api/v2/cn/music/most-played/50/songs.json",
  },
  {
    id: "apple-global",
    name: "热门歌曲 · 全球",
    description: "Apple Music 美区最热歌曲",
    kind: "apple",
    feedUrl:
      "https://rss.marketingtools.apple.com/api/v2/us/music/most-played/50/songs.json",
  },
];

const FAMILY_CHART: ChartSummary = {
  id: "family",
  name: "家庭热播",
  description: "最近 30 天全家最常听",
  kind: "family",
};

const APPLE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 榜单日更即可，6 小时缓存足够
const appleCache = new Map<string, { fetchedAt: number; chart: Chart }>();

type AppleFeedSong = {
  name?: string;
  artistName?: string;
  artworkUrl100?: string;
};

async function fetchAppleChart(
  def: (typeof APPLE_CHARTS)[number],
): Promise<Chart> {
  const cached = appleCache.get(def.id);
  if (cached && Date.now() - cached.fetchedAt < APPLE_CACHE_TTL_MS) {
    return cached.chart;
  }

  let payload: { feed?: { updated?: string; results?: AppleFeedSong[] } };
  try {
    const response = await fetch(def.feedUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Apple RSS ${response.status}`);
    }
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    // 拉取失败时退回过期缓存（若有），避免榜单页整页报错。
    if (cached) return cached.chart;
    throw new AppError(
      "CHART_FETCH_FAILED",
      `榜单拉取失败：${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const results = payload.feed?.results || [];
  const chart: Chart = {
    ...def,
    updatedAt: Date.now(),
    entries: results
      .filter((song) => song.name && song.artistName)
      .map((song, index) => ({
        rank: index + 1,
        title: song.name!,
        artist: song.artistName!,
        // RSS 给的是 100x100 缩略图地址，换成 300x300 更配大列表。
        coverUrl: song.artworkUrl100?.replace("100x100", "300x300"),
      })),
  };
  appleCache.set(def.id, { fetchedAt: Date.now(), chart });
  return chart;
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
    .slice(0, 50)
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

export function listCharts(): ChartSummary[] {
  // Apple 榜在前（点开就有内容），家庭榜垫底——冷启动时它常是空的。
  return [...APPLE_CHARTS.map(({ feedUrl: _feedUrl, ...def }) => def), FAMILY_CHART];
}

export async function getChart(id: string): Promise<Chart> {
  if (id === FAMILY_CHART.id) return buildFamilyChart();
  const appleDef = APPLE_CHARTS.find((def) => def.id === id);
  if (appleDef) return fetchAppleChart(appleDef);
  throw new AppError("CHART_NOT_FOUND", `未知榜单：${id}`, 404);
}
