import type {
  HMusicResolvedTrack,
  HMusicSearchResult,
  HMusicTrack,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import {
  getRuntimeConfig,
  type RuntimeConfig,
} from "../config/config.service.js";
import {
  listSources,
  resolveSourceTrack,
  searchSourceTracks,
} from "../sources/sources.service.js";
import {
  nativeSearch,
  type NativeSearchPlatform,
} from "./native-search.service.js";

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
      ? getRuntimeConfig().then((config) =>
          nativeSearch(
            normalizedQuery,
            input.page,
            searchPlatformOrder(config.searchStrategy),
          ).then((tracks) =>
            nativeSources === "all"
              ? tracks
              : tracks.filter((t) => t.source === nativeSources),
          ),
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

  const config = await getRuntimeConfig();
  // 首选档 = 请求显式指定 > 运行配置"默认音质"。不再取 track.qualities[0]——
  // 原生搜索的曲目该数组以 128k 打头，曾导致设置了默认音质点播仍放 128k。
  const preferred =
    input.quality && input.quality !== "source"
      ? input.quality
      : config.defaultQuality;
  const tiers = [preferred, ...QUALITY_FALLBACK].filter(
    (q, i, arr) => arr.indexOf(q) === i,
  ); // 去重，保序

  // 解析策略：qq/kuwo/netease 优先时，先在偏好平台找同一首歌解析（跨源换源），
  // 失败回落原始音源；originalFirst 维持只解析原始音源。
  for (const attempt of resolveAttemptOrder(
    config.resolveStrategy,
    input.track.source,
  )) {
    const candidateTrack =
      attempt === "original"
        ? input.track
        : await findTrackOnPlatform(attempt, input.track);
    if (!candidateTrack) continue;

    const resolved = await resolveTiers(candidateTrack, tiers);
    if (resolved) {
      // 保留原曲身份（队列同步/播放历史都按原曲记账），只换播放直链。
      return {
        track: { ...input.track, url: resolved.url },
        url: resolved.url,
        quality: resolved.quality,
      };
    }
  }

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

// 按档位逐一尝试解析并实测可播性；全档皆不可播时兜底返回第一个拿到的直链。
// 单档解析抛错（插件超时/不认识该档位）只跳过该档，不断整条回退链。
async function resolveTiers(
  track: HMusicTrack,
  tiers: string[],
): Promise<{ url: string; quality: string } | undefined> {
  let firstUrl: string | undefined;
  let firstQuality = tiers[0];
  for (const quality of tiers) {
    let candidate: string | undefined;
    try {
      candidate = await resolveSourceTrack(track, quality);
    } catch {
      continue;
    }
    if (!candidate) continue;
    if (!firstUrl) {
      firstUrl = candidate;
      firstQuality = quality;
    }
    if (!VERIFY_STREAM || (await isPlayableUrl(candidate))) {
      return { url: candidate, quality };
    }
  }
  return firstUrl ? { url: firstUrl, quality: firstQuality } : undefined;
}

// 搜索策略 → 原生平台交错顺序（领先平台的结果排最前）。
export function searchPlatformOrder(
  strategy: RuntimeConfig["searchStrategy"],
): NativeSearchPlatform[] {
  switch (strategy) {
    case "kuwoFirst":
      return ["kw", "tx", "wy"];
    case "neteaseFirst":
      return ["wy", "tx", "kw"];
    case "qqFirst":
    default:
      return ["tx", "kw", "wy"];
  }
}

// 解析策略 → 尝试序列。偏好平台与原源相同则只剩 original 一步；
// 最多一次跨源搜索，避免死链歌曲把解析拖成全网大扫荡。
export function resolveAttemptOrder(
  strategy: RuntimeConfig["resolveStrategy"],
  originalSource: string,
): Array<"original" | NativeSearchPlatform> {
  const preferred: NativeSearchPlatform | undefined =
    strategy === "qqFirst"
      ? "tx"
      : strategy === "kuwoFirst"
        ? "kw"
        : strategy === "neteaseFirst"
          ? "wy"
          : undefined;
  if (!preferred || preferred === originalSource) return ["original"];
  return [preferred, "original"];
}

// 在指定平台找"同一首歌"：标题归一后互相包含 + 歌手至少一位对上（有歌手信息时）。
// 匹配从严——宁可回落原源，也不能换出翻唱/串烧。
async function findTrackOnPlatform(
  platform: NativeSearchPlatform,
  track: HMusicTrack,
): Promise<HMusicTrack | undefined> {
  if (track.source === platform) return track;
  try {
    const results = await nativeSearch(
      `${track.title} ${track.artist}`.trim(),
      1,
      [platform],
    );
    return results.find((candidate) => isSameSong(candidate, track));
  } catch {
    return undefined;
  }
}

export function isSameSong(
  candidate: HMusicTrack,
  target: HMusicTrack,
): boolean {
  const targetTitle = normalizeSongText(target.title);
  const candidateTitle = normalizeSongText(candidate.title);
  if (!targetTitle || !candidateTitle) return false;
  if (
    candidateTitle !== targetTitle &&
    !candidateTitle.includes(targetTitle) &&
    !targetTitle.includes(candidateTitle)
  ) {
    return false;
  }

  const targetArtists = artistTokens(target.artist);
  const candidateArtists = artistTokens(candidate.artist);
  if (targetArtists.length === 0 || candidateArtists.length === 0) return true;
  return targetArtists.some((a) =>
    candidateArtists.some((c) => c.includes(a) || a.includes(c)),
  );
}

function normalizeSongText(value: string): string {
  return (value || "")
    .toLowerCase()
    .replace(/[\s'"''""·・\-—–~！!？?。.，,、（）()[\]【】<>《》]+/g, "");
}

function artistTokens(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[/、,，&]|feat\.?|ft\.?/)
    .map((token) => token.replace(/\s+/g, ""))
    .filter((token) => token && token !== "未知艺术家");
}
