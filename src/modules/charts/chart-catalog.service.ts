import { AppError } from "../../shared/errors.js";
import {
  chartPlaylistTracks,
  sessionStatus,
  topTracks,
  type SpotifyTimeRange,
  type SpotifyTrackEntry,
} from "../spotify/spotify.service.js";
import {
  getChart,
  listCharts,
  type Chart,
  type ChartSummary,
} from "./charts.service.js";

type SpotifyChart = ChartSummary &
  ({ timeRange: SpotifyTimeRange } | { playlistId: string });

const SPOTIFY_CHARTS: SpotifyChart[] = [
  {
    id: "spotify-top-short",
    name: "最近常听",
    description: "Spotify 最近 4 周常听曲目",
    kind: "spotify-personal",
    timeRange: "short_term",
  },
  {
    id: "spotify-top-medium",
    name: "半年常听",
    description: "Spotify 最近 6 个月常听曲目",
    kind: "spotify-personal",
    timeRange: "medium_term",
  },
  {
    id: "spotify-top-long",
    name: "长期常听",
    description: "Spotify 较长时间的常听曲目",
    kind: "spotify-personal",
    timeRange: "long_term",
  },
  {
    id: "spotify-global-top",
    name: "Global Top 50",
    description: "Spotify 全球热门歌曲榜",
    kind: "spotify-public",
    playlistId: "37i9dQZEVXbMDoHDwVN2tF",
  },
  {
    id: "spotify-global-viral",
    name: "Viral 50 · Global",
    description: "Spotify 全球飙升歌曲榜",
    kind: "spotify-public",
    playlistId: "5Th61R37SXj0VMRoUJm28c",
  },
  {
    id: "spotify-hk-top",
    name: "Top 50 · 香港",
    description: "Spotify 香港热门歌曲榜",
    kind: "spotify-public",
    playlistId: "37i9dQZEVXbLwpL8TjsxOG",
  },
];

export function spotifyChart(id: string): SpotifyChart | undefined {
  return SPOTIFY_CHARTS.find((chart) => chart.id === id);
}

// 在目录层组合 Spotify，避免播放记账依赖的 charts.service 反向依赖播放器。
export async function listAvailableCharts(
  includeSpotify = true,
): Promise<ChartSummary[]> {
  const charts = listCharts();
  if (!includeSpotify || !(await sessionStatus()).loggedIn) return charts;
  return [
    ...SPOTIFY_CHARTS.map(({ id, name, description, kind }) => ({
      id,
      name,
      description,
      kind,
    })),
    ...charts,
  ];
}

export async function spotifyChartTracks(
  definition: SpotifyChart,
): Promise<SpotifyTrackEntry[]> {
  try {
    const page =
      "timeRange" in definition
        ? await topTracks(definition.timeRange, 50, 0)
        : await chartPlaylistTracks(definition.playlistId);
    return page.items;
  } catch (error) {
    // /charts 的 401 只表达 HMusic 登录失效，上游账号问题保留在当前卡片。
    if (error instanceof AppError && error.code === "SPOTIFY_SESSION_INVALID") {
      throw new AppError(
        error.code,
        "Spotify 登录已失效，请在设置中重新连接",
        409,
      );
    }
    throw error;
  }
}

export async function getAvailableChart(id: string): Promise<Chart> {
  const definition = spotifyChart(id);
  if (!definition) return getChart(id);
  const tracks = await spotifyChartTracks(definition);
  return {
    id,
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    updatedAt: Date.now(),
    entries: tracks.map((track, index) => ({
      rank: index + 1,
      title: track.title,
      artist: track.artist || "未知歌手",
      album: track.album || undefined,
      coverUrl: track.coverUrl || undefined,
    })),
  };
}
