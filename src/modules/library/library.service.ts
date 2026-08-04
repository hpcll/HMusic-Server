import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, like, or, sql } from "drizzle-orm";
import { parseFile } from "music-metadata";
import { nanoid } from "nanoid";
import { env } from "../../config/env.js";
import { db } from "../../db/index.js";
import { library } from "../../db/schema.js";
import type { HMusicTrack } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { moduleLogger } from "../../shared/logger.js";
import { getRuntimeConfig } from "../config/config.service.js";
import { createLocalAudioUrl } from "../proxy/audio-proxy.service.js";
import { startLibraryScrape } from "./library.scraper.js";

const log = moduleLogger("library");

const MUSIC_DIR = path.join(env.dataDir, "music");
const COVER_DIR = path.join(env.dataDir, "covers");
const AUDIO_EXTS = new Set(["mp3", "flac", "m4a", "ogg", "wav", "aac"]);

export type LibraryItem = {
  id: string;
  trackKey: string;
  origin: "scan" | "upload" | "download";
  source: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  folder: string;
  hasLyric: boolean;
  fileExt: string;
  byteSize: number;
  createdAt: number;
  updatedAt: number;
};

export type LibraryScanState = {
  status: "idle" | "scanning" | "done" | "failed";
  startedAt?: number;
  finishedAt?: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  error?: string;
};

let scanState: LibraryScanState = {
  status: "idle",
  added: 0,
  updated: 0,
  removed: 0,
  skipped: 0,
};

export function getScanState(): LibraryScanState {
  return scanState;
}

// 扫描来源的稳定身份：绝对路径哈希。文件不动身份不变——重扫后 id 可能重生成，
// 但 trackKey 及其派生的播放 URL（签名 token 即 trackKey）保持有效，
// 歌单里存的本地曲目快照不会因重扫而断链。
function scanTrackKey(absPath: string): string {
  const digest = createHash("sha1").update(absPath).digest("hex").slice(0, 16);
  return `local:${digest}`;
}

function extOf(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function rowToItem(row: typeof library.$inferSelect): LibraryItem {
  return {
    id: row.id,
    trackKey: row.trackKey,
    origin: row.origin as LibraryItem["origin"],
    source: row.source,
    title: row.title,
    artist: row.artist,
    album: row.album ?? undefined,
    durationMs: row.durationMs ?? undefined,
    coverUrl: coverUrlFor(row),
    folder: row.folder,
    hasLyric: !!row.lrc,
    fileExt: row.fileExt,
    byteSize: row.byteSize,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// 封面优先级：在线原始封面（下载来源自带、随处可达）> 内嵌封面出流端点。
function coverUrlFor(row: typeof library.$inferSelect): string | undefined {
  if (row.coverUrl) return row.coverUrl;
  if (row.coverPath) {
    return createLocalAudioUrl(`cover:${row.trackKey}`);
  }
  return undefined;
}

// 曲库条目 → 全链路可播的 track：url 即本地代理地址，resolveTrack 见 url
// 短路直播，队列/歌单/歌词/历史全部免改造。下载来源保留原平台身份
// （歌词、榜单标识等按 source:sourceTrackId 匹配才能命中）。
export function libraryItemToTrack(item: LibraryItem): HMusicTrack {
  const [source, ...rest] = item.trackKey.split(":");
  return {
    id: item.trackKey,
    source,
    sourceTrackId: rest.join(":"),
    title: item.title,
    artist: item.artist,
    album: item.album,
    durationMs: item.durationMs,
    coverUrl: item.coverUrl,
    url: createLocalAudioUrl(item.trackKey),
    qualities: ["source"],
  };
}

export function listLibrary(options: {
  search?: string;
  artist?: string;
  album?: string;
  folder?: string;
  limit: number;
  offset: number;
}): { items: LibraryItem[]; total: number } {
  const term = options.search?.trim();
  const conditions = [
    term
      ? or(
          like(library.title, `%${term}%`),
          like(library.artist, `%${term}%`),
          like(library.album, `%${term}%`),
        )
      : undefined,
    options.artist != null ? eq(library.artist, options.artist) : undefined,
    options.album != null ? eq(library.album, options.album) : undefined,
    options.folder != null ? eq(library.folder, options.folder) : undefined,
  ].filter((condition) => condition !== undefined);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(library)
    .where(where)
    .all()[0];
  const rows = db
    .select()
    .from(library)
    .where(where)
    .orderBy(asc(library.artist), asc(library.title))
    .limit(options.limit)
    .offset(options.offset)
    .all();
  return { items: rows.map(rowToItem), total: totalRow?.count ?? 0 };
}

// 歌手/专辑/文件夹聚合（分类浏览）：空值归入「未知」由客户端展示层处理，这里如实返回。
export function listLibraryGroups(
  by: "artist" | "album" | "folder",
): Array<{ name: string; count: number }> {
  const column =
    by === "artist"
      ? library.artist
      : by === "album"
        ? library.album
        : library.folder;
  const rows = db
    .select({ name: column, count: sql<number>`count(*)` })
    .from(library)
    .groupBy(column)
    .orderBy(asc(column))
    .all();
  return rows.map((row) => ({ name: row.name ?? "", count: row.count }));
}

// 本地曲目歌词：刮削阶段已落库（本地 .lrc 或在线匹配），歌词接口按 trackKey 取。
export function getLibraryLyric(trackKey: string): string | undefined {
  const row = db
    .select({ lrc: library.lrc })
    .from(library)
    .where(eq(library.trackKey, trackKey))
    .limit(1)
    .all()[0];
  return row?.lrc ?? undefined;
}

// 播放解析用：按 track 身份查曲库，命中且文件仍在 → 本地代理地址。
// 文件被手动删了视为不在库（回落在线解析），与 downloads 同一哲学。
export function getLibraryAudioUrl(track: HMusicTrack): string | undefined {
  const trackKey = `${track.source}:${track.sourceTrackId}`;
  const row = db
    .select()
    .from(library)
    .where(eq(library.trackKey, trackKey))
    .limit(1)
    .all()[0];
  if (!row || !existsSync(row.filePath)) return undefined;
  return createLocalAudioUrl(row.trackKey);
}

const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

// /proxy/local 出流用：token 可能是曲库 trackKey、曲库条目 id，
// 或封面 token（cover:<trackKey>）。
export function getLibraryFile(
  idOrKey: string,
): { absPath: string; mime: string } | undefined {
  if (idOrKey.startsWith("cover:")) {
    const row = findRow(idOrKey.slice("cover:".length));
    if (!row?.coverPath) return undefined;
    const absPath = path.join(env.dataDir, row.coverPath);
    if (!existsSync(absPath)) return undefined;
    return { absPath, mime: "image/jpeg" };
  }
  const row = findRow(idOrKey);
  if (!row || !existsSync(row.filePath)) return undefined;
  return { absPath: row.filePath, mime: AUDIO_MIME[row.fileExt] ?? "audio/mpeg" };
}

function findRow(idOrKey: string): typeof library.$inferSelect | undefined {
  return db
    .select()
    .from(library)
    .where(or(eq(library.trackKey, idOrKey), eq(library.id, idOrKey)))
    .limit(1)
    .all()[0];
}

// 下载完成后入库：trackKey 沿用原始平台身份，在线点播同一首歌时
// getLibraryAudioUrl 直接命中本地文件。重复下载覆盖更新。
export function upsertFromDownload(input: {
  track: HMusicTrack;
  absPath: string;
  fileExt: string;
  byteSize: number;
}): void {
  const { track } = input;
  const now = Date.now();
  const shared = {
    filePath: input.absPath,
    fileExt: input.fileExt,
    byteSize: input.byteSize,
    mtimeMs: now,
    updatedAt: now,
  };
  db.insert(library)
    .values({
      id: nanoid(),
      trackKey: `${track.source}:${track.sourceTrackId}`,
      origin: "download",
      source: track.source,
      title: track.title,
      artist: track.artist,
      album: track.album ?? null,
      durationMs: track.durationMs ?? null,
      coverUrl: track.coverUrl ?? null,
      trackJson: JSON.stringify(track),
      createdAt: now,
      ...shared,
    })
    .onConflictDoUpdate({ target: library.trackKey, set: shared })
    .run();
}

export async function deleteLibraryItem(id: string): Promise<{ deletedId: string }> {
  const row = db.select().from(library).where(eq(library.id, id)).limit(1).all()[0];
  if (!row) {
    throw new AppError("LIBRARY_NOT_FOUND", "曲库条目不存在", 404, { id });
  }
  // 存量目录承诺只读：scan 来源仅移出曲库、绝不删用户原文件（且原目录仍在
  // 配置里时，下次扫描会重新收录——要真正移除请在 NAS 上处理文件本身）。
  if (row.origin !== "scan") {
    await fs.rm(row.filePath, { force: true }).catch(() => {});
  }
  if (row.coverPath) {
    await fs.rm(path.join(env.dataDir, row.coverPath), { force: true }).catch(() => {});
  }
  db.delete(library).where(eq(library.id, id)).run();
  return { deletedId: id };
}

// 上传落盘路径：扩展名白名单 + 文件名清洗 + 同名加序号，落自管 music 目录
//（下次扫描按增量指纹跳过，不会重复入库）。
export async function resolveUploadPath(filename: string): Promise<string> {
  const ext = extOf(filename);
  if (!AUDIO_EXTS.has(ext)) {
    throw new AppError(
      "LIBRARY_UPLOAD_TYPE",
      "仅支持音频文件（mp3/flac/m4a/ogg/wav/aac）",
      400,
    );
  }
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  const stem =
    path
      .basename(filename, path.extname(filename))
      .replace(/[/\\:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "上传曲目";
  let candidate = path.join(MUSIC_DIR, `${stem}.${ext}`);
  for (let i = 2; existsSync(candidate); i += 1) {
    candidate = path.join(MUSIC_DIR, `${stem} (${i}).${ext}`);
  }
  return candidate;
}

// 上传入库：文件已由路由落盘到 music/，走与扫描同一条 ingest 链（读标签、
// 提封面、文件名兜底），origin 标记 upload。返回入库后的条目。
export async function ingestUploadedFile(absPath: string): Promise<LibraryItem> {
  const stat = await fs.stat(absPath);
  const existing = db
    .select()
    .from(library)
    .where(eq(library.filePath, absPath))
    .limit(1)
    .all()[0];
  await ingestFile(
    absPath,
    { size: stat.size, mtimeMs: stat.mtimeMs },
    existing,
    "upload",
    MUSIC_DIR,
  );
  const row = db
    .select()
    .from(library)
    .where(eq(library.filePath, absPath))
    .limit(1)
    .all()[0];
  if (!row) {
    throw new AppError("LIBRARY_INGEST_FAILED", "上传文件入库失败", 500);
  }
  return rowToItem(row);
}

// 手动触发或启动时调用。已在扫描中则直接返回当前状态（幂等）。
export function startLibraryScan(): LibraryScanState {
  if (scanState.status === "scanning") return scanState;
  scanState = {
    status: "scanning",
    startedAt: Date.now(),
    added: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
  };
  void runScan().catch((error) => {
    scanState = {
      ...scanState,
      status: "failed",
      finishedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    log.warn({ err: String(error) }, "曲库扫描异常");
  });
  return scanState;
}

async function runScan(): Promise<void> {
  const config = await getRuntimeConfig();
  // 自管目录始终在列；配置目录去重、仅保留真实存在的。
  const roots: string[] = [];
  for (const dir of [MUSIC_DIR, ...config.libraryDirs]) {
    const normalized = path.resolve(dir);
    if (!roots.includes(normalized) && existsSync(normalized)) {
      roots.push(normalized);
    }
  }
  await fs.mkdir(MUSIC_DIR, { recursive: true });

  const files = new Map<string, { size: number; mtimeMs: number; root: string }>();
  for (const root of roots) {
    await walk(root, files, root);
  }

  const existing = new Map(
    db
      .select()
      .from(library)
      .all()
      .map((row) => [row.filePath, row]),
  );

  for (const [absPath, stat] of files) {
    const row = existing.get(absPath);
    if (row && row.mtimeMs === Math.floor(stat.mtimeMs) && row.byteSize === stat.size) {
      scanState.skipped += 1;
      continue;
    }
    try {
      await ingestFile(absPath, stat, row, "scan", stat.root);
      if (row) {
        scanState.updated += 1;
      } else {
        scanState.added += 1;
      }
    } catch (error) {
      log.warn({ file: absPath, err: String(error) }, "文件入库失败，跳过");
    }
  }

  // 清理：记录对应的文件已不存在，或（scan 来源）已不在任何配置根之下
  // ——目录被移出配置即视为下架。download/upload 的文件被手动删同样清账。
  for (const row of existing.values()) {
    const underRoot = roots.some((root) => row.filePath.startsWith(root + path.sep));
    const gone = !existsSync(row.filePath);
    if (gone || (row.origin === "scan" && !underRoot)) {
      if (row.coverPath) {
        await fs
          .rm(path.join(env.dataDir, row.coverPath), { force: true })
          .catch(() => {});
      }
      db.delete(library).where(eq(library.id, row.id)).run();
      scanState.removed += 1;
    }
  }

  scanState = { ...scanState, status: "done", finishedAt: Date.now() };
  log.info(
    {
      roots: roots.length,
      added: scanState.added,
      updated: scanState.updated,
      removed: scanState.removed,
      skipped: scanState.skipped,
    },
    "曲库扫描完成",
  );
  // 扫描完接着后台补封面/歌词：不阻塞扫描收尾，曲库先能用，元数据陆续到位。
  startLibraryScrape();
}

async function walk(
  dir: string,
  out: Map<string, { size: number; mtimeMs: number; root: string }>,
  root: string,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/挂载掉线的子目录跳过，不让整轮扫描失败。
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out, root);
    } else if (entry.isFile() && AUDIO_EXTS.has(extOf(entry.name))) {
      try {
        const stat = await fs.stat(full);
        out.set(full, { size: stat.size, mtimeMs: stat.mtimeMs, root });
      } catch {
        // stat 失败（竞态删除等）跳过。
      }
    }
  }
}

async function ingestFile(
  absPath: string,
  stat: { size: number; mtimeMs: number },
  existingRow: typeof library.$inferSelect | undefined,
  origin: "scan" | "upload" = "scan",
  root?: string,
): Promise<void> {
  // 文件名兜底先行（标签读到会覆盖）：剥下载命名的「[source_id]」尾巴，
  // 「歌手 - 歌名」句式拆出 artist——无标签的孤儿文件也不至于一行乱码展示。
  let title = path
    .basename(absPath, path.extname(absPath))
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
  let artist = "";
  const dashAt = title.indexOf(" - ");
  if (dashAt > 0) {
    artist = title.slice(0, dashAt).trim();
    title = title.slice(dashAt + 3).trim() || title;
  }
  let album: string | undefined;
  let durationMs: number | undefined;
  let coverPath: string | undefined = existingRow?.coverPath ?? undefined;
  const trackKey = existingRow?.trackKey ?? scanTrackKey(absPath);

  try {
    const meta = await parseFile(absPath, { duration: true });
    if (meta.common.title?.trim()) title = meta.common.title.trim();
    if (meta.common.artist?.trim()) artist = meta.common.artist.trim();
    if (meta.common.album?.trim()) album = meta.common.album.trim();
    if (meta.format.duration) durationMs = Math.round(meta.format.duration * 1000);

    const picture = meta.common.picture?.[0];
    if (picture && !coverPath) {
      coverPath = await writeCover(trackKey, picture.data);
    }
  } catch {
    // 标签读不出来就用文件名兜底，照样入库——能播比信息全更重要。
  }

  // 本地附属文件优先于在线刮削：同目录 cover/folder 图、同名 .lrc 歌词。
  if (!coverPath) coverPath = await readFolderCover(absPath, trackKey);
  const lrc = await readSidecarLyric(absPath);
  const folder = folderOf(absPath, root);
  // 本地已拿到封面和歌词就不必再去在线音源刮，省一次网络请求。
  const scrapeStatus = coverPath && lrc ? "done" : "pending";

  const now = Date.now();
  if (existingRow) {
    db.update(library)
      .set({
        title,
        artist,
        album: album ?? null,
        durationMs: durationMs ?? null,
        coverPath: coverPath ?? null,
        lrc: lrc ?? existingRow.lrc,
        folder,
        // 文件变更后重新刮一轮（可能换了标签/补了附属文件）。
        scrapeStatus: lrc && coverPath ? "done" : "pending",
        byteSize: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        fileExt: extOf(absPath),
        updatedAt: now,
      })
      .where(eq(library.id, existingRow.id))
      .run();
    return;
  }
  db.insert(library)
    .values({
      id: nanoid(),
      trackKey,
      origin,
      source: "local",
      title,
      artist,
      album: album ?? null,
      durationMs: durationMs ?? null,
      coverPath: coverPath ?? null,
      lrc: lrc ?? null,
      folder,
      scrapeStatus,
      filePath: absPath,
      fileExt: extOf(absPath),
      byteSize: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      // 同一文件极端情况下 trackKey 撞车（路径哈希一致必然同路径）：更新为准。
      target: library.trackKey,
      set: {
        filePath: absPath,
        byteSize: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        updatedAt: now,
      },
    })
    .run();
}

async function writeCover(trackKey: string, data: Uint8Array): Promise<string> {
  const coverName = `${trackKey.replace(/[^a-zA-Z0-9_-]+/g, "_")}.jpg`;
  await fs.mkdir(COVER_DIR, { recursive: true });
  await fs.writeFile(path.join(COVER_DIR, coverName), data);
  return path.join("covers", coverName);
}

// 相对扫描根的目录路径（"" = 根目录直属）。root 未知时（上传/下载）留空。
function folderOf(absPath: string, root?: string): string {
  if (!root) return "";
  const rel = path.relative(root, path.dirname(absPath));
  return rel === "." || rel.startsWith("..") ? "" : rel;
}

// 同目录整轨封面：cover.jpg / folder.jpg / front.jpg（专辑目录的通行约定）。
async function readFolderCover(
  absPath: string,
  trackKey: string,
): Promise<string | undefined> {
  const dir = path.dirname(absPath);
  for (const base of ["cover", "folder", "front", "album"]) {
    for (const ext of ["jpg", "jpeg", "png"]) {
      const candidate = path.join(dir, `${base}.${ext}`);
      try {
        const data = await fs.readFile(candidate);
        return await writeCover(trackKey, data);
      } catch {
        // 不存在就试下一个。
      }
    }
  }
  return undefined;
}

// 同名 .lrc 歌词文件（曲库整理的通行约定：歌.mp3 + 歌.lrc）。
async function readSidecarLyric(absPath: string): Promise<string | undefined> {
  const candidate = absPath.slice(0, -path.extname(absPath).length) + ".lrc";
  try {
    const text = await fs.readFile(candidate, "utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}
