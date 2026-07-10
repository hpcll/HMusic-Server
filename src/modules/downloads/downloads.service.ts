import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { desc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { downloads } from "../../db/schema.js";
import { env } from "../../config/env.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { moduleLogger } from "../../shared/logger.js";
import { createLocalAudioUrl } from "../proxy/audio-proxy.service.js";
import { resolveTrack } from "../search/search.service.js";

const log = moduleLogger("downloads");

// 下载目录（dataDir/music），文件名基于 trackKey 哈希避免特殊字符与碰撞。
const MUSIC_DIR = path.join(env.dataDir, "music");

// 服务重启会掐断进行中的任务：启动时把 pending/downloading 统一置为 failed，
// 列表里一键重试即可——比让它永远卡在"下载中…"诚实。
try {
  db.update(downloads)
    .set({
      status: "failed",
      error: "服务重启中断，请重试",
      updatedAt: Date.now(),
    })
    .where(inArray(downloads.status, ["pending", "downloading"]))
    .run();
} catch {
  // 首次启动表可能尚未建好，忽略
}

export type DownloadRecord = {
  id: string;
  trackKey: string;
  source: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
  track: HMusicTrack;
  quality?: string;
  status: "pending" | "downloading" | "done" | "failed";
  error?: string;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
};

function trackKeyOf(track: HMusicTrack): string {
  return `${track.source}:${track.sourceTrackId}`;
}

function safeFileBase(trackKey: string): string {
  return trackKey.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
}

function extFromUrl(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  const match = clean.match(/\.(flac|mp3|m4a|ogg|wav|aac)$/);
  return match ? match[1] : "mp3";
}

function rowToRecord(row: typeof downloads.$inferSelect): DownloadRecord {
  let track: HMusicTrack;
  try {
    track = JSON.parse(row.trackJson) as HMusicTrack;
  } catch {
    track = {
      id: row.trackKey,
      source: row.source,
      sourceTrackId: row.trackKey.split(":").slice(1).join(":"),
      title: row.title,
      artist: row.artist,
    };
  }
  return {
    id: row.id,
    trackKey: row.trackKey,
    source: row.source,
    title: row.title,
    artist: row.artist,
    album: row.album ?? undefined,
    coverUrl: row.coverUrl ?? undefined,
    track,
    quality: row.quality ?? undefined,
    status: row.status as DownloadRecord["status"],
    error: row.error ?? undefined,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listDownloads(): DownloadRecord[] {
  return db
    .select()
    .from(downloads)
    .orderBy(desc(downloads.createdAt))
    .all()
    .map(rowToRecord);
}

export function getDownloadByTrackKey(trackKey: string): DownloadRecord | undefined {
  const row = db
    .select()
    .from(downloads)
    .where(eq(downloads.trackKey, trackKey))
    .limit(1)
    .all()[0];
  return row ? rowToRecord(row) : undefined;
}

// 已完成下载且文件确实还在 → 返回可播的本地代理地址（音箱/浏览器都可达）。
// 文件被手动删了则视为未下载（播放自动回落在线解析）。
export function getLocalAudioUrl(track: HMusicTrack): string | undefined {
  const row = db
    .select()
    .from(downloads)
    .where(eq(downloads.trackKey, trackKeyOf(track)))
    .limit(1)
    .all()[0];
  if (!row || row.status !== "done") return undefined;
  if (!existsSync(path.join(env.dataDir, row.filePath))) return undefined;
  return createLocalAudioUrl(row.id);
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

// 本地文件服务用：按下载 id 取绝对路径与 MIME（仅 done 状态）。
export function getDownloadFile(id: string): { absPath: string; mime: string } {
  const row = db
    .select()
    .from(downloads)
    .where(eq(downloads.id, id))
    .limit(1)
    .all()[0];
  if (!row || row.status !== "done") {
    throw new AppError("DOWNLOAD_NOT_FOUND", "本地音频不存在", 404, { id });
  }
  const absPath = path.join(env.dataDir, row.filePath);
  if (!existsSync(absPath)) {
    throw new AppError("DOWNLOAD_FILE_MISSING", "本地音频文件已被移除", 404, { id });
  }
  return { absPath, mime: AUDIO_MIME[row.fileExt] ?? "audio/mpeg" };
}

// 发起下载：登记记录（downloading）→ 后台流式落盘 → done/failed。
// 立即返回记录，前端轮询 /downloads 看状态。同曲已存在且成功则直接返回。
export async function startDownload(
  track: HMusicTrack,
  quality?: string,
): Promise<DownloadRecord> {
  const trackKey = trackKeyOf(track);
  const existing = getDownloadByTrackKey(trackKey);
  if (existing && existing.status === "done") {
    return existing;
  }
  if (existing && existing.status === "downloading") {
    return existing; // 正在下，勿重复触发
  }

  const now = Date.now();
  const id = existing?.id ?? nanoid();
  // 真实扩展名要等解析出直链才知道，先占位 mp3，runDownload 里按实际 URL 修正。
  const placeholderExt = "mp3";
  const filePath = path.join(
    "music",
    `${safeFileBase(trackKey)}.${placeholderExt}`,
  );

  const values = {
    id,
    trackKey,
    source: track.source,
    title: track.title,
    artist: track.artist,
    album: track.album,
    coverUrl: track.coverUrl,
    trackJson: JSON.stringify(track),
    quality,
    filePath,
    fileExt: placeholderExt,
    byteSize: 0,
    status: "downloading" as const,
    error: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  db.insert(downloads)
    .values(values)
    .onConflictDoUpdate({
      target: downloads.trackKey,
      set: {
        status: "downloading",
        error: null,
        quality,
        updatedAt: now,
      },
    })
    .run();

  // 后台执行，不阻塞请求。失败落 failed 状态。
  void runDownload(id, track, quality).catch((error) => {
    log.warn({ err: String(error), trackKey }, "下载任务异常");
  });

  return getDownloadByTrackKey(trackKey)!;
}

async function runDownload(
  id: string,
  track: HMusicTrack,
  quality: string | undefined,
): Promise<void> {
  const trackKey = trackKeyOf(track);
  let absPath = "";
  try {
    await fs.mkdir(MUSIC_DIR, { recursive: true });

    // 解析出最新直链（本地下载不走音频代理，直接抓源站）。
    const resolved = await resolveTrack({ track, quality });
    const fileExt = extFromUrl(resolved.url);
    const relPath = path.join("music", `${safeFileBase(trackKey)}.${fileExt}`);
    absPath = path.join(env.dataDir, relPath);

    const response = await fetch(resolved.url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 HMusic-Server-Downloader" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`上游响应 ${response.status}`);
    }

    // 落盘到临时文件再原子改名，避免半截文件被当成完成。
    const tmpPath = `${absPath}.part`;
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));
    await fs.rename(tmpPath, absPath);
    const stat = await fs.stat(absPath);
    if (stat.size === 0) {
      throw new Error("下载文件为空");
    }

    db.update(downloads)
      .set({
        status: "done",
        filePath: relPath,
        fileExt,
        byteSize: stat.size,
        quality: resolved.quality,
        error: null,
        updatedAt: Date.now(),
      })
      .where(eq(downloads.id, id))
      .run();
    log.info({ id, size: stat.size }, "下载完成");
  } catch (error) {
    if (absPath) {
      await fs.rm(absPath, { force: true }).catch(() => {});
      await fs.rm(`${absPath}.part`, { force: true }).catch(() => {});
    }
    db.update(downloads)
      .set({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now(),
      })
      .where(eq(downloads.id, id))
      .run();
    log.warn({ id, err: String(error) }, "下载失败");
  }
}

export async function deleteDownload(id: string): Promise<{ deletedId: string }> {
  const row = db
    .select()
    .from(downloads)
    .where(eq(downloads.id, id))
    .limit(1)
    .all()[0];
  if (!row) {
    throw new AppError("DOWNLOAD_NOT_FOUND", "下载记录不存在", 404, { id });
  }
  await fs
    .rm(path.join(env.dataDir, row.filePath), { force: true })
    .catch(() => {});
  db.delete(downloads).where(eq(downloads.id, id)).run();
  return { deletedId: id };
}
