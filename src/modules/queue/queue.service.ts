import type {
  HMusicPlaybackState,
  HMusicQueue,
  HMusicTrack,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";

let queue: HMusicQueue = {
  sessionId: "default",
  items: [],
  currentIndex: -1,
  playMode: "list_loop",
  updatedAt: Date.now(),
};

export async function getQueue(): Promise<HMusicQueue> {
  return queue;
}

export async function replaceQueue(input: {
  tracks: HMusicTrack[];
  currentIndex?: number;
  playMode?: HMusicPlaybackState["playMode"];
}): Promise<HMusicQueue> {
  const currentIndex = normalizeQueueIndex(
    input.currentIndex ?? (input.tracks.length > 0 ? 0 : -1),
    input.tracks.length,
  );

  queue = {
    ...queue,
    items: input.tracks.map((track) => createQueueItem(track)),
    currentIndex,
    playMode: input.playMode ?? queue.playMode,
    updatedAt: Date.now(),
  };
  return queue;
}

export async function addQueueTrack(track: HMusicTrack): Promise<HMusicQueue> {
  queue = {
    ...queue,
    items: [...queue.items, createQueueItem(track)],
    currentIndex: queue.currentIndex < 0 ? 0 : queue.currentIndex,
    updatedAt: Date.now(),
  };
  return queue;
}

export async function setCurrentQueueIndex(
  index: number,
): Promise<HMusicQueue> {
  queue = {
    ...queue,
    currentIndex: normalizeQueueIndex(index, queue.items.length),
    updatedAt: Date.now(),
  };
  return queue;
}

export async function setQueuePlayMode(
  playMode: HMusicPlaybackState["playMode"],
): Promise<HMusicQueue> {
  queue = {
    ...queue,
    playMode,
    updatedAt: Date.now(),
  };
  return queue;
}

export function syncQueuePlaybackTrack(
  track: HMusicTrack,
  preferredIndex?: number,
): HMusicQueue {
  const indexToSync =
    preferredIndex !== undefined && Number.isInteger(preferredIndex)
      ? preferredIndex
      : queue.currentIndex;

  if (isSameQueueTrack(queue.items[indexToSync]?.track, track)) {
    const items = [...queue.items];
    items[indexToSync] = {
      ...items[indexToSync],
      track,
    };
    queue = {
      ...queue,
      items,
      currentIndex: indexToSync,
      updatedAt: Date.now(),
    };
    return queue;
  }

  const existingIndex = queue.items.findIndex((item) =>
    isSameQueueTrack(item.track, track),
  );

  if (existingIndex >= 0) {
    const items = [...queue.items];
    items[existingIndex] = {
      ...items[existingIndex],
      track,
    };
    queue = {
      ...queue,
      items,
      currentIndex: existingIndex,
      updatedAt: Date.now(),
    };
    return queue;
  }

  queue = {
    ...queue,
    items: [...queue.items, createQueueItem(track)],
    currentIndex: queue.items.length,
    updatedAt: Date.now(),
  };
  return queue;
}

export async function clearQueue(): Promise<HMusicQueue> {
  queue = {
    ...queue,
    items: [],
    currentIndex: -1,
    updatedAt: Date.now(),
  };
  return queue;
}

function createQueueItem(track: HMusicTrack) {
  return {
    id: `${track.id}:${Date.now()}`,
    track,
    addedAt: Date.now(),
  };
}

function isSameQueueTrack(
  left: HMusicTrack | undefined,
  right: HMusicTrack,
): boolean {
  if (!left) return false;
  return (
    left.id === right.id ||
    (left.source === right.source && left.sourceTrackId === right.sourceTrackId)
  );
}

function normalizeQueueIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new AppError("QUEUE_INDEX_INVALID", "队列索引无效", 400, {
      index,
      length,
    });
  }
  return index;
}
