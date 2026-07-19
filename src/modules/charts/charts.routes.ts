import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { playTrack } from "../playback/playback.service.js";
import { addQueueTrack, replaceQueue } from "../queue/queue.service.js";
import { searchTracks } from "../search/search.service.js";
import { getChart, listCharts } from "./charts.service.js";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const playChartSchema = z
  .object({
    startIndex: z.number().int().nonnegative().optional(),
    deviceId: z.string().min(1).optional(),
  })
  .strict();

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);

  app.get("/", async () => {
    return { charts: listCharts() };
  });

  app.get("/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return getChart(params.id);
  });

  // 整榜播放：条目带 track 的榜（家庭/网易云/QQ）整个灌进队列开播；
  // 条目不带 track 的榜（Apple RSS）逐条搜索匹配——先匹配到第一首就开播，
  // 其余条目后台继续匹配补进队列，按钮不用等 50 次搜索。
  // 组合逻辑放路由层——playback.service 已 import charts.service（recordPlay），
  // charts.service 反向 import playTrack 会成环。
  app.post("/:id/play", async (request) => {
    const params = paramsSchema.parse(request.params);
    const body = playChartSchema.parse(request.body ?? {});

    const chart = await getChart(params.id);
    // 任一整榜播放开始都作废上一次的后台补队列任务（队列已被替换）。
    const seq = ++chartBackfillSeq;
    const tracks = chart.entries
      .map((entry) => entry.track)
      .filter((track): track is HMusicTrack => track !== undefined);
    if (tracks.length === 0) {
      if (chart.entries.length === 0) {
        throw new AppError(
          "CHART_NOT_PLAYABLE",
          "该榜单不支持整榜播放（榜单为空）",
          409,
          { chartId: params.id },
        );
      }
      return playChartBySearch(chart.entries, body, seq);
    }

    const startIndex = body.startIndex ?? 0;
    const target = tracks[startIndex];
    if (!target) {
      throw new AppError("CHART_INDEX_INVALID", "榜单播放索引无效", 400, {
        chartId: params.id,
        startIndex,
        length: tracks.length,
      });
    }

    const queue = await replaceQueue({ tracks, currentIndex: startIndex });
    const playback = await playTrack({
      track: target,
      deviceId: body.deviceId,
      queueIndex: startIndex,
    });
    return { queue, playback };
  });
}

// 后台补队列任务序号：新一轮整榜播放（无论哪种榜）把旧任务作废。
let chartBackfillSeq = 0;

// 榜单条目 → 搜索匹配曲目：搜「歌名 歌手」取第一条，搜不到返回 undefined。
async function matchChartEntry(entry: {
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
    return undefined; // 单条匹配失败尽力而为，不阻断整榜
  }
}

// Apple 榜整榜播放：从 startIndex 起顺序匹配，第一首命中即替换队列开播；
// 其余条目由后台任务逐条匹配追加（保持榜单顺序）。期间用户再次整榜播放会
// 替换队列并作废本任务；其它队列操作与追加并存（追加是尽力而为的补齐）。
async function playChartBySearch(
  entries: Array<{ title: string; artist: string }>,
  body: { startIndex?: number; deviceId?: string },
  seq: number,
): Promise<{ queue: unknown; playback: unknown }> {
  const startIndex = body.startIndex ?? 0;
  if (startIndex >= entries.length) {
    throw new AppError("CHART_INDEX_INVALID", "榜单播放索引无效", 400, {
      startIndex,
      length: entries.length,
    });
  }

  let firstTrack: HMusicTrack | undefined;
  let firstAt = -1;
  for (let i = startIndex; i < entries.length; i++) {
    firstTrack = await matchChartEntry(entries[i]!);
    if (firstTrack) {
      firstAt = i;
      break;
    }
  }
  if (!firstTrack) {
    throw new AppError(
      "CHART_MATCH_EMPTY",
      "榜单条目没有匹配到可播放的曲目",
      409,
    );
  }

  const queue = await replaceQueue({ tracks: [firstTrack], currentIndex: 0 });
  const playback = await playTrack({
    track: firstTrack,
    deviceId: body.deviceId,
    queueIndex: 0,
  });

  void (async () => {
    for (let i = firstAt + 1; i < entries.length; i++) {
      if (seq !== chartBackfillSeq) return;
      const track = await matchChartEntry(entries[i]!);
      if (seq !== chartBackfillSeq) return;
      if (!track) continue;
      try {
        await addQueueTrack(track);
      } catch {
        return; // 队列写入失败（如已被清空重建）就收手
      }
    }
  })();

  return { queue, playback };
}
