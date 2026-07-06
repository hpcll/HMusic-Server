import type {
  HMusicResolvedTrack,
  HMusicSearchResult,
  HMusicTrack,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import {
  listSources,
  resolveSourceTrack,
  searchSourceTracks,
} from "../sources/sources.service.js";

export type SearchTracksInput = {
  query: string;
  source?: string;
  page: number;
  limit: number;
};

export async function searchTracks(
  input: SearchTracksInput,
): Promise<HMusicSearchResult> {
  const normalizedQuery = input.query.trim();
  if (!normalizedQuery) {
    throw new AppError("SEARCH_QUERY_EMPTY", "搜索关键词不能为空", 400);
  }

  const sources = (await listSources()).filter(
    (source) => source.enabled && (!input.source || source.id === input.source),
  );
  if (input.source && sources.length === 0) {
    throw new AppError("SOURCE_NOT_FOUND", "音源不存在或未启用", 404, {
      source: input.source,
    });
  }

  const tracks = (
    await Promise.all(
      sources.map((source) => searchSourceTracks(source.id, normalizedQuery)),
    )
  ).flat();
  const offset = (input.page - 1) * input.limit;

  return {
    query: normalizedQuery,
    source: input.source,
    page: input.page,
    limit: input.limit,
    total: tracks.length,
    tracks: tracks.slice(offset, offset + input.limit),
  };
}

export async function resolveTrack(input: {
  track: HMusicTrack;
  quality?: string;
}): Promise<HMusicResolvedTrack> {
  const quality = input.quality || input.track.qualities?.[0] || "source";
  const url = await resolveSourceTrack(input.track, quality);
  if (!url) {
    throw new AppError(
      "TRACK_RESOLVE_NOT_READY",
      "当前音源或 LX 插件未返回可播放 URL",
      501,
      {
        trackId: input.track.id,
        source: input.track.source,
      },
    );
  }

  return {
    track: {
      ...input.track,
      url,
    },
    url,
    quality,
  };
}
