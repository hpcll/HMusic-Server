import {
  getStoredMiSession,
  markMiSessionExpiredIfUnauthorized,
} from "./mi.service.js";
import { fetchXiaoaiAudioInfo, type XiaomiAudioInfo } from "./xiaomi.client.js";

const detailCacheTtlMs = 6 * 60 * 60_000;
const emptyCacheTtlMs = 15_000;
const minimumQueryIntervalMs = 1_500;
const maxCachedDetails = 256;

const detailCache = new Map<
  string,
  { value: XiaomiAudioInfo | undefined; expiresAt: number }
>();
const inFlight = new Map<string, Promise<XiaomiAudioInfo | undefined>>();
let queryQueue = Promise.resolve();
let lastQueryAt = 0;

export function getDeviceAudioInfo(
  deviceId: string,
  audioId: string,
): Promise<XiaomiAudioInfo | undefined> {
  const key = audioId.trim();
  if (!key) return Promise.resolve(undefined);

  const cached = detailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.value);
  }
  if (cached) detailCache.delete(key);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const request = enqueueQuery(async () => {
    try {
      const session = await getStoredMiSession();
      return await fetchXiaoaiAudioInfo({ session, deviceId, audioId: key });
    } catch (error) {
      try {
        await markMiSessionExpiredIfUnauthorized(error);
      } catch {
        // Song metadata is best-effort and must not interrupt playback.
      }
      return undefined;
    }
  })
    .then((value) => {
      cacheDetail(key, value);
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, request);
  return request;
}

function enqueueQuery<T>(query: () => Promise<T>): Promise<T> {
  const result = queryQueue.then(async () => {
    const waitMs = lastQueryAt + minimumQueryIntervalMs - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastQueryAt = Date.now();
    return query();
  });
  queryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function cacheDetail(
  audioId: string,
  value: XiaomiAudioInfo | undefined,
): void {
  if (detailCache.size >= maxCachedDetails) {
    const oldestKey = detailCache.keys().next().value;
    if (oldestKey) detailCache.delete(oldestKey);
  }
  detailCache.set(audioId, {
    value,
    expiresAt: Date.now() + (value ? detailCacheTtlMs : emptyCacheTtlMs),
  });
}
