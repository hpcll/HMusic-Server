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
import { nativeSearch } from "./native-search.service.js";

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

  // 原生在线搜索（QQ/酷我/网易云直连，不依赖 LX 插件）+ 已启用音源搜索并行。
  // 指定了具体 source 时只搜该音源；否则原生搜索兜底，保证“没装插件也能搜出歌”。
  const nativeSources: NativeSourceFilter =
    input.source === "tx" || input.source === "kw" || input.source === "wy"
      ? input.source
      : input.source
        ? undefined // 指定了非原生音源 → 交给该音源，不跑原生
        : "all";

  const sources = (await listSources()).filter(
    (source) => source.enabled && (!input.source || source.id === input.source),
  );
  // 指定的音源既不是启用中的插件音源，也不是原生平台码 → 才算“音源不存在”。
  if (input.source && sources.length === 0 && !nativeSources) {
    throw new AppError("SOURCE_NOT_FOUND", "音源不存在或未启用", 404, {
      source: input.source,
    });
  }

  const [nativeTracks, pluginTracksNested] = await Promise.all([
    nativeSources
      ? nativeSearch(normalizedQuery, input.page).then((tracks) =>
          nativeSources === "all"
            ? tracks
            : tracks.filter((t) => t.source === nativeSources),
        )
      : Promise.resolve([]),
    Promise.all(
      sources.map((source) => searchSourceTracks(source.id, normalizedQuery)),
    ),
  ]);

  const tracks = dedupeTracks([...nativeTracks, ...pluginTracksNested.flat()]);
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

type NativeSourceFilter = "all" | "tx" | "kw" | "wy" | undefined;

// 同一首歌可能被原生与插件同时命中；按 source+sourceTrackId 去重（保留先到的）。
function dedupeTracks(tracks: HMusicTrack[]): HMusicTrack[] {
  const seen = new Set<string>();
  const result: HMusicTrack[] = [];
  for (const track of tracks) {
    const key = `${track.source}:${track.sourceTrackId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(track);
  }
  return result;
}

// LX 音源标准音质档。resolveTrack 按此顺序逐档回退，并实测每档直链是否真能播：
// 有的歌 128k/320k 因版权被 QQ CDN 403，但 flac 档 206 可播（VIP 分级），
// 只认"插件返回了 URL"会拿到死链 403。320k 打头兼顾音质与命中率（对齐参考实现默认档）。
// 绝不能含 "source"——上游 /url?quality=source 会 500（非法档位），这是最初点播放没反应的根因。
const QUALITY_FALLBACK = ["320k", "128k", "flac", "flac24bit"];

// 单测里插件返回的是 example.com 假链，实测探测既慢又不确定——用 VITEST 跳过。
const VERIFY_STREAM = !process.env.VITEST;

// 实测直链可播性：Range 取 1 字节，CDN 回 200/206 即可播（403/404 是版权拒绝）。
// QQ 的 vkey 直链可重复请求，探测后照常播放不受影响。探测本身异常时从宽放行。
async function isPlayableUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { Range: "bytes=0-1" },
      signal: AbortSignal.timeout(6000),
    });
    if (response.status >= 400) return false;
    response.body?.cancel().catch(() => {});
    return true;
  } catch {
    return true; // 探测失败不代表链接坏，交给播放器兜底
  }
}

export async function resolveTrack(input: {
  track: HMusicTrack;
  quality?: string;
}): Promise<HMusicResolvedTrack> {
  // 直链曲目（手动添加 / 测试音）自带 url，不走插件档位系统，
  // "source" 是它们的合法标签，原样保留即可。
  if (input.track.url) {
    const quality = input.quality || input.track.qualities?.[0] || "source";
    return { track: input.track, url: input.track.url, quality };
  }

  // 插件曲目：按标准档位逐一尝试，绝不发送 "source"（上游会 500）。
  const preferred = input.quality || input.track.qualities?.[0];
  const tiers = [
    ...(preferred && preferred !== "source" ? [preferred] : []),
    ...QUALITY_FALLBACK,
  ].filter((q, i, arr) => arr.indexOf(q) === i); // 去重，保序

  let firstUrl: string | undefined; // 全档皆不可播时的兜底
  let firstQuality = tiers[0];
  let url: string | undefined;
  let usedQuality = tiers[0];
  for (const quality of tiers) {
    const candidate = await resolveSourceTrack(input.track, quality);
    if (!candidate) continue;
    if (!firstUrl) {
      firstUrl = candidate;
      firstQuality = quality;
    }
    if (!VERIFY_STREAM || (await isPlayableUrl(candidate))) {
      url = candidate;
      usedQuality = quality;
      break;
    }
  }
  if (!url && firstUrl) {
    url = firstUrl;
    usedQuality = firstQuality;
  }

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
    quality: usedQuality,
  };
}
