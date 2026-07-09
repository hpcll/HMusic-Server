import { and, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { playlistTracks, playlists, tracks } from "../../db/schema.js";
import type {
  HMusicPlaybackState,
  HMusicPlaylistDetail,
  HMusicPlaylistItem,
  HMusicPlaylistSummary,
  HMusicQueue,
  HMusicTrack,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { playTrack } from "../playback/playback.service.js";
import { replaceQueue } from "../queue/queue.service.js";
import {
  importPlaylistFromUrl,
  platformDisplayName,
} from "./playlist-import.service.js";

type PlaylistRow = typeof playlists.$inferSelect;
type PlaylistTrackRow = typeof playlistTracks.$inferSelect;
type TrackRow = typeof tracks.$inferSelect;

export async function listPlaylists(): Promise<HMusicPlaylistSummary[]> {
  const rows = await db
    .select()
    .from(playlists)
    .orderBy(desc(playlists.updatedAt), asc(playlists.name));
  const itemRows = await db.select().from(playlistTracks);
  const counts = new Map<string, number>();

  for (const item of itemRows) {
    counts.set(item.playlistId, (counts.get(item.playlistId) ?? 0) + 1);
  }

  return rows.map((row) => playlistRowToSummary(row, counts.get(row.id) ?? 0));
}

export async function createPlaylist(input: {
  name: string;
  description?: string;
}): Promise<HMusicPlaylistDetail> {
  const now = Date.now();
  const id = nanoid(12);
  const name = normalizeName(input.name);

  await db.insert(playlists).values({
    id,
    name,
    description: normalizeNullableString(input.description),
    createdAt: now,
    updatedAt: now,
  });

  return getPlaylist(id);
}

export type ImportPlaylistResult = {
  playlist: HMusicPlaylistDetail;
  platform: string;
  platformName: string;
  imported: number;
  totalCount: number;
  skipped: {
    emptyTitle: number;
    duplicate: number;
    truncated: number;
  };
};

// 歌单导入：抓取远端歌单 → 新建本地歌单 → 批量入库曲目并建立曲目关联。
// 歌单名默认取远端标题，可由 input.name 覆盖。
export async function importPlaylist(input: {
  url: string;
  name?: string;
}): Promise<ImportPlaylistResult> {
  const fetched = await importPlaylistFromUrl(input.url);
  const name = normalizeName(input.name?.trim() || fetched.name);

  const now = Date.now();
  const playlistId = nanoid(12);
  await db.insert(playlists).values({
    id: playlistId,
    name,
    description: `从${platformDisplayName(fetched.platform)}导入 · 共${fetched.totalCount}首`,
    createdAt: now,
    updatedAt: now,
  });

  let position = 0;
  for (const track of fetched.tracks) {
    const trackId = await upsertStoredTrack(track);
    // 同一歌单内去重（远端已清洗，这里再兜底一次防并发/重名）。
    const existing = await db
      .select()
      .from(playlistTracks)
      .where(
        and(
          eq(playlistTracks.playlistId, playlistId),
          eq(playlistTracks.trackId, trackId),
        ),
      )
      .limit(1);
    if (existing[0]) continue;

    await db.insert(playlistTracks).values({
      id: nanoid(16),
      playlistId,
      trackId,
      position: position++,
      addedAt: Date.now(),
    });
  }

  await touchPlaylist(playlistId);
  const playlist = await getPlaylist(playlistId);

  return {
    playlist,
    platform: fetched.platform,
    platformName: platformDisplayName(fetched.platform),
    imported: playlist.items.length,
    totalCount: fetched.totalCount,
    skipped: fetched.skipped,
  };
}

export async function getPlaylist(
  playlistId: string,
): Promise<HMusicPlaylistDetail> {
  const playlist = await findPlaylist(playlistId);
  const items = await listPlaylistItems(playlistId);

  return {
    ...playlistRowToSummary(playlist, items.length),
    items,
  };
}

export async function updatePlaylist(
  playlistId: string,
  input: {
    name?: string;
    description?: string;
  },
): Promise<HMusicPlaylistDetail> {
  await findPlaylist(playlistId);
  const next: Partial<PlaylistRow> = {
    updatedAt: Date.now(),
  };

  if (input.name !== undefined) {
    next.name = normalizeName(input.name);
  }
  if (input.description !== undefined) {
    next.description = normalizeNullableString(input.description);
  }

  await db.update(playlists).set(next).where(eq(playlists.id, playlistId));
  return getPlaylist(playlistId);
}

export async function deletePlaylist(
  playlistId: string,
): Promise<{ deletedPlaylistId: string }> {
  await findPlaylist(playlistId);
  await db.delete(playlists).where(eq(playlists.id, playlistId));
  return { deletedPlaylistId: playlistId };
}

export async function addPlaylistTrack(
  playlistId: string,
  track: HMusicTrack,
): Promise<HMusicPlaylistDetail> {
  await findPlaylist(playlistId);
  const trackId = await upsertStoredTrack(track);
  const existing = await db
    .select()
    .from(playlistTracks)
    .where(
      and(
        eq(playlistTracks.playlistId, playlistId),
        eq(playlistTracks.trackId, trackId),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    const lastItem = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(desc(playlistTracks.position))
      .limit(1);
    await db.insert(playlistTracks).values({
      id: nanoid(16),
      playlistId,
      trackId,
      position: (lastItem[0]?.position ?? -1) + 1,
      addedAt: Date.now(),
    });
  }

  await touchPlaylist(playlistId);
  return getPlaylist(playlistId);
}

export async function removePlaylistTrack(
  playlistId: string,
  itemId: string,
): Promise<HMusicPlaylistDetail> {
  await findPlaylist(playlistId);
  const item = await db
    .select()
    .from(playlistTracks)
    .where(
      and(
        eq(playlistTracks.playlistId, playlistId),
        eq(playlistTracks.id, itemId),
      ),
    )
    .limit(1);
  if (!item[0]) {
    throw new AppError("PLAYLIST_ITEM_NOT_FOUND", "歌单歌曲不存在", 404, {
      playlistId,
      itemId,
    });
  }

  await db.delete(playlistTracks).where(eq(playlistTracks.id, itemId));
  await normalizePlaylistPositions(playlistId);
  await touchPlaylist(playlistId);
  return getPlaylist(playlistId);
}

export async function playPlaylist(input: {
  playlistId: string;
  startIndex?: number;
  playMode?: HMusicPlaybackState["playMode"];
  deviceId?: string;
}): Promise<{ queue: HMusicQueue; playback: HMusicPlaybackState }> {
  const playlist = await getPlaylist(input.playlistId);
  if (playlist.items.length === 0) {
    throw new AppError("PLAYLIST_EMPTY", "歌单为空，无法播放", 409, {
      playlistId: input.playlistId,
    });
  }

  const startIndex = input.startIndex ?? 0;
  const targetItem = playlist.items[startIndex];
  if (!targetItem) {
    throw new AppError("PLAYLIST_INDEX_INVALID", "歌单播放索引无效", 400, {
      playlistId: input.playlistId,
      startIndex,
      length: playlist.items.length,
    });
  }

  const queue = await replaceQueue({
    tracks: playlist.items.map((item) => item.track),
    currentIndex: startIndex,
    playMode: input.playMode,
  });
  const playback = await playTrack({
    track: targetItem.track,
    deviceId: input.deviceId,
    queueIndex: startIndex,
  });

  return { queue, playback };
}

async function findPlaylist(playlistId: string): Promise<PlaylistRow> {
  const rows = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId))
    .limit(1);
  if (!rows[0]) {
    throw new AppError("PLAYLIST_NOT_FOUND", "歌单不存在", 404, {
      playlistId,
    });
  }
  return rows[0];
}

async function listPlaylistItems(
  playlistId: string,
): Promise<HMusicPlaylistItem[]> {
  const rows = await db
    .select({
      item: playlistTracks,
      track: tracks,
    })
    .from(playlistTracks)
    .innerJoin(tracks, eq(playlistTracks.trackId, tracks.id))
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position), asc(playlistTracks.addedAt));

  return rows.map(({ item, track }) => playlistItemToContract(item, track));
}

async function upsertStoredTrack(track: HMusicTrack): Promise<string> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(tracks)
    .where(
      and(
        eq(tracks.source, track.source),
        eq(tracks.sourceTrackId, track.sourceTrackId),
      ),
    )
    .limit(1);
  const trackId = existing[0]?.id ?? track.id;
  const values = {
    source: track.source,
    sourceTrackId: track.sourceTrackId,
    title: track.title,
    artist: track.artist,
    album: normalizeNullableString(track.album),
    durationMs: track.durationMs ?? null,
    coverUrl: normalizeNullableString(track.coverUrl),
    rawJson: serializeStoredRaw(track.raw),
    updatedAt: now,
  };

  await db
    .insert(tracks)
    .values({
      id: trackId,
      ...values,
      createdAt: existing[0]?.createdAt ?? now,
    })
    .onConflictDoUpdate({
      target: tracks.id,
      set: values,
    });

  return trackId;
}

async function touchPlaylist(playlistId: string): Promise<void> {
  await db
    .update(playlists)
    .set({ updatedAt: Date.now() })
    .where(eq(playlists.id, playlistId));
}

async function normalizePlaylistPositions(playlistId: string): Promise<void> {
  const items = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position), asc(playlistTracks.addedAt));

  for (const [index, item] of items.entries()) {
    if (item.position === index) continue;
    await db
      .update(playlistTracks)
      .set({ position: index })
      .where(eq(playlistTracks.id, item.id));
  }
}

function playlistRowToSummary(
  row: PlaylistRow,
  trackCount: number,
): HMusicPlaylistSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    trackCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function playlistItemToContract(
  item: PlaylistTrackRow,
  track: TrackRow,
): HMusicPlaylistItem {
  return {
    id: item.id,
    playlistId: item.playlistId,
    track: trackRowToContract(track),
    position: item.position,
    addedAt: item.addedAt,
  };
}

function trackRowToContract(row: TrackRow): HMusicTrack {
  return {
    id: row.id,
    source: row.source,
    sourceTrackId: row.sourceTrackId,
    title: row.title,
    artist: row.artist,
    album: row.album ?? undefined,
    durationMs: row.durationMs ?? undefined,
    coverUrl: row.coverUrl ?? undefined,
    raw: parseRawJson(row.rawJson),
  };
}

function parseRawJson(rawJson: string | null): unknown | undefined {
  if (!rawJson) return undefined;
  try {
    return JSON.parse(rawJson);
  } catch {
    return undefined;
  }
}

function serializeStoredRaw(raw: unknown): string | null {
  const sanitized = sanitizeStoredRaw(raw);
  return sanitized === undefined ? null : JSON.stringify(sanitized);
}

function sanitizeStoredRaw(raw: unknown): unknown | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => sanitizeStoredRaw(item))
      .filter((item) => item !== undefined);
  }
  if (typeof raw !== "object") return raw;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isPlaybackUrlKey(key)) continue;
    const nextValue = sanitizeStoredRaw(value);
    if (nextValue !== undefined) sanitized[key] = nextValue;
  }

  return sanitized;
}

function isPlaybackUrlKey(key: string): boolean {
  return ["url", "playUrl", "play_url", "src"].includes(key);
}

function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError("PLAYLIST_NAME_EMPTY", "歌单名称不能为空", 400);
  }
  return normalized;
}

function normalizeNullableString(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized || null;
}
