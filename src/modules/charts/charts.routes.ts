import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { playTrack } from "../playback/playback.service.js";
import { replaceQueue } from "../queue/queue.service.js";
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

  // 整榜播放：条目带 track 的榜（家庭/网易云/QQ）整个灌进队列开播。
  // 组合逻辑放路由层——playback.service 已 import charts.service（recordPlay），
  // charts.service 反向 import playTrack 会成环。
  app.post("/:id/play", async (request) => {
    const params = paramsSchema.parse(request.params);
    const body = playChartSchema.parse(request.body ?? {});

    const chart = await getChart(params.id);
    const tracks = chart.entries
      .map((entry) => entry.track)
      .filter((track): track is HMusicTrack => track !== undefined);
    if (tracks.length === 0) {
      throw new AppError(
        "CHART_NOT_PLAYABLE",
        "该榜单不支持整榜播放（条目不含可播曲目）",
        409,
        { chartId: params.id },
      );
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
