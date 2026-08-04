import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { library } from "../../db/schema.js";
import { moduleLogger } from "../../shared/logger.js";
import { getLyricByTrack } from "../lyrics/lyrics.service.js";
import { searchTracks } from "../search/search.service.js";

const log = moduleLogger("library-scrape");

export type ScrapeState = {
  status: "idle" | "running" | "done";
  total: number;
  filled: number;
  missed: number;
  startedAt?: number;
  finishedAt?: number;
};

let state: ScrapeState = { status: "idle", total: 0, filled: 0, missed: 0 };
let running: Promise<void> | undefined;

export function getScrapeState(): ScrapeState {
  return state;
}

// 后台补全本地曲目的封面/歌词。扫描完自动触发；重复触发返回当前进度（幂等）。
export function startLibraryScrape(): ScrapeState {
  if (running) return state;
  state = {
    status: "running",
    total: 0,
    filled: 0,
    missed: 0,
    startedAt: Date.now(),
  };
  running = runScrape()
    .catch((error) => {
      log.warn({ err: String(error) }, "曲库刮削异常");
    })
    .finally(() => {
      running = undefined;
      state = { ...state, status: "done", finishedAt: Date.now() };
      log.info(
        { total: state.total, filled: state.filled, missed: state.missed },
        "曲库刮削完成",
      );
    });
  return state;
}

async function runScrape(): Promise<void> {
  // 只处理 pending：done/miss 都不再打网络请求，避免每轮扫描重复刮无解曲目。
  const pending = db
    .select()
    .from(library)
    .where(eq(library.scrapeStatus, "pending"))
    .all();
  state = { ...state, total: pending.length };
  if (pending.length === 0) return;

  for (const row of pending) {
    try {
      const filled = await scrapeRow(row);
      state = filled
        ? { ...state, filled: state.filled + 1 }
        : { ...state, missed: state.missed + 1 };
    } catch (error) {
      state = { ...state, missed: state.missed + 1 };
      db.update(library)
        .set({ scrapeStatus: "miss", updatedAt: Date.now() })
        .where(eq(library.id, row.id))
        .run();
      log.warn({ title: row.title, err: String(error) }, "曲目刮削失败");
    }
    // 顺序处理 + 间隔：在线音源对高频请求敏感，慢一点换稳定。
    await sleep(400);
  }
}

async function scrapeRow(row: typeof library.$inferSelect): Promise<boolean> {
  const needsCover = !row.coverPath && !row.coverUrl;
  const needsLyric = !row.lrc;
  if (!needsCover && !needsLyric) {
    db.update(library)
      .set({ scrapeStatus: "done", updatedAt: Date.now() })
      .where(eq(library.id, row.id))
      .run();
    return true;
  }

  const match = await findOnlineMatch(row.title, row.artist);
  if (!match) {
    db.update(library)
      .set({ scrapeStatus: "miss", updatedAt: Date.now() })
      .where(eq(library.id, row.id))
      .run();
    return false;
  }

  const patch: Partial<typeof library.$inferInsert> = { updatedAt: Date.now() };
  if (needsCover && match.coverUrl) patch.coverUrl = match.coverUrl;
  if (needsLyric) {
    const lyric = await getLyricByTrack(match).catch(() => undefined);
    if (lyric?.lrc.trim()) patch.lrc = lyric.lrc;
  }

  const gotCover = !needsCover || !!patch.coverUrl;
  const gotLyric = !needsLyric || !!patch.lrc;
  patch.scrapeStatus = gotCover && gotLyric ? "done" : "miss";
  db.update(library).set(patch).where(eq(library.id, row.id)).run();
  return !!patch.coverUrl || !!patch.lrc;
}

// 从候选里挑标题/歌手都对得上的一条。宁缺毋滥：对不上就当没找到——
// 错配的封面歌词比空白更糟。导出供单测覆盖（匹配判定是刮削的正确性核心）。
export function pickMatch<T extends { title: string; artist: string }>(
  candidates: T[],
  title: string,
  artist: string,
): T | undefined {
  const wantTitle = normalize(title);
  const wantArtist = normalize(artist);
  if (!wantTitle) return undefined;

  return candidates.find((candidate) => {
    const gotTitle = normalize(candidate.title);
    if (gotTitle !== wantTitle && !gotTitle.includes(wantTitle)) return false;
    // 本地没有歌手信息时只认标题；有则要求歌手也能对上。
    if (!wantArtist) return true;
    const gotArtist = normalize(candidate.artist);
    return gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist);
  });
}

// 按「歌名 歌手」搜在线音源，取匹配度最高的一条。
async function findOnlineMatch(title: string, artist: string) {
  const query = [title, artist].filter((part) => part.trim()).join(" ");
  if (!query.trim()) return undefined;

  const result = await searchTracks({ query, page: 1, limit: 10 });
  return pickMatch(result.tracks, title, artist);
}

// 比对用归一化：去空白、括注（Live/Remix 版本差异）、大小写。
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(【[].*?[)）】\]]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
