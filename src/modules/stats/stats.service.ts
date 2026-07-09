import { db } from "../../db/index.js";
import { playHistory } from "../../db/schema.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { platformDisplayName } from "../playlists/playlist-import.service.js";

// 听歌统计：把 play_history 聚合成「总览 + 近 30 天 + 多维分布」。
// 仿 charts.service.ts 的 buildFamilyChart —— 一次拉全量、在 JS 内存里聚合，
// 数据量小（家用场景），零 SQL 聚合依赖，零风险。

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_DAYS = 30;
const TOP_ARTISTS = 10;
const TOP_TRACKS = 10;
const TOP_ALBUMS = 8;

// 测试音等内部曲目不该进历史，但历史里若有残留也在此兜底剔除。
const TEST_TONE_KEY = "manual:hmusic-test-tone";

export type StatWindow = {
  totalPlays: number;
  uniqueTracks: number;
  uniqueArtists: number;
  activeDays: number;
};

export type ArtistStat = { name: string; playCount: number };
export type AlbumStat = { album: string; playCount: number };
export type TrackStat = {
  title: string;
  artist: string;
  coverUrl?: string;
  playCount: number;
  track?: HMusicTrack;
};
export type SourceStat = {
  source: string;
  label: string;
  count: number;
  percent: number;
};
export type DailyPoint = { date: string; count: number };
export type HourPoint = { hour: number; count: number };

export type ListeningStats = {
  overview: StatWindow & {
    firstPlayedAt?: number;
    lastPlayedAt?: number;
  };
  last30d: StatWindow;
  topArtists: ArtistStat[];
  topTracks: TrackStat[];
  topAlbums: AlbumStat[];
  sourceDist: SourceStat[];
  dailyTrend: DailyPoint[];
  hourDist: HourPoint[];
};

type HistoryRow = typeof playHistory.$inferSelect;

// artist 字段是 "周杰伦/费玉清" 这类拼接串，拆成独立艺术家做分布。
// 常见分隔符：/、、,、&、feat.。空白与噪声一并清掉。
function splitArtists(artist: string): string[] {
  return artist
    .split(/[/、,&]|\bfeat\.?\b|\bft\.?\b/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "未知艺术家");
}

function safeParseTrack(json: string): HMusicTrack | undefined {
  try {
    return JSON.parse(json) as HMusicTrack;
  } catch {
    return undefined;
  }
}

// 时间戳 → 本地日期键，用于「按天/按小时」切片（服务进程可用 Date）。
function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}-${day}`;
}

function computeWindow(rows: HistoryRow[]): StatWindow {
  const trackKeys = new Set<string>();
  const artists = new Set<string>();
  const days = new Set<string>();
  for (const row of rows) {
    trackKeys.add(row.trackKey);
    for (const a of splitArtists(row.artist)) artists.add(a);
    days.add(dayKey(row.playedAt));
  }
  return {
    totalPlays: rows.length,
    uniqueTracks: trackKeys.size,
    uniqueArtists: artists.size,
    activeDays: days.size,
  };
}

function topArtists(rows: HistoryRow[]): ArtistStat[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of splitArtists(row.artist)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([name, playCount]) => ({ name, playCount }))
    .sort((a, b) => b.playCount - a.playCount || a.name.localeCompare(b.name))
    .slice(0, TOP_ARTISTS);
}

function topAlbums(rows: HistoryRow[]): AlbumStat[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const album = (row.album ?? "").trim() || "未知专辑";
    counts.set(album, (counts.get(album) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([album, playCount]) => ({ album, playCount }))
    .sort((a, b) => b.playCount - a.playCount || a.album.localeCompare(b.album))
    .slice(0, TOP_ALBUMS);
}

function topTracks(rows: HistoryRow[]): TrackStat[] {
  const grouped = new Map<string, { count: number; row: HistoryRow }>();
  for (const row of rows) {
    const entry = grouped.get(row.trackKey);
    if (entry) entry.count += 1;
    else grouped.set(row.trackKey, { count: 1, row });
  }
  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || b.row.playedAt - a.row.playedAt)
    .slice(0, TOP_TRACKS)
    .map(({ count, row }) => ({
      title: row.title,
      artist: row.artist,
      coverUrl: row.coverUrl ?? undefined,
      playCount: count,
      track: safeParseTrack(row.trackJson),
    }));
}

// 平台码 → 展示名。tx/kw/wy 复用导入模块的映射，manual 等本地来源单独兜底。
function sourceLabel(source: string): string {
  if (source === "manual") return "本地/其他";
  const name = platformDisplayName(source);
  return name === source && source ? source.toUpperCase() : name;
}

function sourceDist(rows: HistoryRow[]): SourceStat[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.source, (counts.get(row.source) ?? 0) + 1);
  }
  const total = rows.length || 1;
  return [...counts.entries()]
    .map(([source, count]) => ({
      source,
      label: sourceLabel(source),
      count,
      percent: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count);
}

// 近 30 天逐日播放次数，缺失日期补 0（给 SVG 折线画连续曲线）。
function dailyTrend(rows: HistoryRow[], now: number): DailyPoint[] {
  const startDay = new Date(now);
  startDay.setHours(0, 0, 0, 0);
  const start = startDay.getTime() - (RECENT_WINDOW_DAYS - 1) * DAY_MS;

  const buckets: DailyPoint[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < RECENT_WINDOW_DAYS; i++) {
    const ts = start + i * DAY_MS;
    const key = dayKey(ts);
    index.set(key, i);
    buckets.push({ date: key, count: 0 });
  }
  for (const row of rows) {
    if (row.playedAt < start) continue;
    const i = index.get(dayKey(row.playedAt));
    if (i !== undefined) buckets[i].count += 1;
  }
  return buckets;
}

// 24 小时段分布（听歌习惯），全量历史统计。
function hourDist(rows: HistoryRow[]): HourPoint[] {
  const buckets: HourPoint[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0,
  }));
  for (const row of rows) {
    const h = new Date(row.playedAt).getHours();
    buckets[h].count += 1;
  }
  return buckets;
}

export function getListeningStats(): ListeningStats {
  const all = db
    .select()
    .from(playHistory)
    .all()
    .filter((row) => row.trackKey !== TEST_TONE_KEY);

  const now = Date.now();
  const recentSince = now - RECENT_WINDOW_DAYS * DAY_MS;
  const recent = all.filter((row) => row.playedAt >= recentSince);

  let firstPlayedAt: number | undefined;
  let lastPlayedAt: number | undefined;
  for (const row of all) {
    if (firstPlayedAt === undefined || row.playedAt < firstPlayedAt) {
      firstPlayedAt = row.playedAt;
    }
    if (lastPlayedAt === undefined || row.playedAt > lastPlayedAt) {
      lastPlayedAt = row.playedAt;
    }
  }

  return {
    overview: { ...computeWindow(all), firstPlayedAt, lastPlayedAt },
    last30d: computeWindow(recent),
    topArtists: topArtists(all),
    topTracks: topTracks(all),
    topAlbums: topAlbums(all),
    sourceDist: sourceDist(all),
    dailyTrend: dailyTrend(all, now),
    hourDist: hourDist(all),
  };
}
