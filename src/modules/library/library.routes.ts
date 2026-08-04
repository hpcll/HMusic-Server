import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../shared/auth.js";
import { AppError } from "../../shared/errors.js";
import { getScrapeState, startLibraryScrape } from "./library.scraper.js";
import {
  deleteLibraryItem,
  getScanState,
  ingestUploadedFile,
  libraryItemToTrack,
  listLibrary,
  listLibraryGroups,
  resolveUploadPath,
  startLibraryScan,
} from "./library.service.js";

const listQuerySchema = z.object({
  search: z.string().max(120).optional(),
  artist: z.string().max(200).optional(),
  album: z.string().max(200).optional(),
  // 空串是合法取值（根目录直属曲目），不能用 min(1) 卡掉。
  folder: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const groupsQuerySchema = z.object({
  by: z.enum(["artist", "album", "folder"]),
});

const paramsSchema = z.object({ id: z.string().min(1) });

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  requireAuth(app);
  // multipart 只在曲库作用域注册：单文件、上限 500MB（无损 flac 大文件）。
  await app.register(multipart, {
    limits: { fileSize: 500 * 1024 * 1024, files: 1 },
  });

  // 每条附带 track 形态：客户端拿到即可直接 POST /playback/play（url 短路直播）。
  app.get("/", async (request) => {
    const query = listQuerySchema.parse(request.query);
    const { items, total } = listLibrary(query);
    return {
      items: items.map((item) => ({
        ...item,
        track: libraryItemToTrack(item),
      })),
      total,
      scan: getScanState(),
      scrape: getScrapeState(),
    };
  });

  // 歌手/专辑/文件夹聚合列表（分类浏览）。
  app.get("/groups", async (request) => {
    const query = groupsQuerySchema.parse(request.query);
    return { groups: listLibraryGroups(query.by) };
  });

  // 幂等：扫描中重复触发返回当前进度。
  app.post("/scan", async () => ({ scan: startLibraryScan() }));

  // 手动补刮封面/歌词（扫描后会自动触发一轮，这里供用户按需重试）。
  app.post("/scrape", async () => ({ scrape: startLibraryScrape() }));

  // 客户端上传音乐文件：流式落盘（临时名 + 原子改名，半截文件不入库）→
  // ingest 读标签入库。返回入库条目，客户端无需再手动刷新扫描。
  app.post("/upload", async (request) => {
    const file = await request.file();
    if (!file) {
      throw new AppError("LIBRARY_UPLOAD_EMPTY", "请求未携带文件", 400);
    }
    const absPath = await resolveUploadPath(file.filename ?? "");
    const tmpPath = `${absPath}.part`;
    try {
      await pipeline(file.file, createWriteStream(tmpPath));
      if (file.file.truncated) {
        throw new AppError("LIBRARY_UPLOAD_TOO_LARGE", "文件超过 500MB 上限", 413);
      }
      await fs.rename(tmpPath, absPath);
      const item = await ingestUploadedFile(absPath);
      return { item: { ...item, track: libraryItemToTrack(item) } };
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await fs.rm(absPath, { force: true }).catch(() => {});
      throw error;
    }
  });

  app.delete("/:id", async (request) => {
    const params = paramsSchema.parse(request.params);
    return deleteLibraryItem(params.id);
  });
}
