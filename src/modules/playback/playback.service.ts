import type {
  HMusicPlaybackState,
  HMusicQueue,
  HMusicTrack,
} from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { listDevices } from "../devices/devices.service.js";
import { getRuntimeConfig } from "../config/config.service.js";
import {
  createMiAudioId,
  needsPlayMusicApi,
  playbackMediaContext,
} from "../mi/mi.hardware.js";
import { getStoredMiSession } from "../mi/mi.service.js";
import { sendXiaomiTts, sendXiaomiUbusRequest } from "../mi/xiaomi.client.js";
import { createAudioProxyUrl } from "../proxy/audio-proxy.service.js";
import {
  getQueue,
  setCurrentQueueIndex,
  setQueuePlayMode,
  syncQueuePlaybackTrack,
} from "../queue/queue.service.js";
import { resolveTrack } from "../search/search.service.js";

let playbackState: HMusicPlaybackState = {
  sessionId: "default",
  state: "idle",
  positionMs: 0,
  durationMs: 0,
  volume: 0,
  playMode: "list_loop",
  queueIndex: -1,
  queueLength: 0,
  seekEnabled: false,
  updatedAt: Date.now(),
};

export async function getPlaybackState(): Promise<HMusicPlaybackState> {
  await refreshPlaybackStateFromDevice();
  return playbackState;
}

export async function updatePlaybackMode(
  playMode: HMusicPlaybackState["playMode"],
): Promise<HMusicPlaybackState> {
  playbackState = {
    ...playbackState,
    playMode,
    updatedAt: Date.now(),
  };
  await setQueuePlayMode(playMode);
  return playbackState;
}

export type PlayUrlInput = {
  url: string;
  track?: HMusicTrack;
  deviceId?: string;
  durationMs?: number;
  positionMs?: number;
  queueIndex?: number;
};

export type PlayTrackInput = {
  url?: string;
  track?: HMusicTrack;
  deviceId?: string;
  quality?: string;
  durationMs?: number;
  positionMs?: number;
  queueIndex?: number;
};

export async function playTrack(
  input: PlayTrackInput,
): Promise<HMusicPlaybackState> {
  if (input.url) {
    return playUrl({
      url: input.url,
      track: input.track,
      deviceId: input.deviceId,
      durationMs: input.durationMs,
      positionMs: input.positionMs,
      queueIndex: input.queueIndex,
    });
  }

  if (!input.track) {
    throw new AppError(
      "PLAYBACK_TARGET_MISSING",
      "播放请求必须包含 url 或 track",
      400,
    );
  }

  const resolved = await resolveTrack({
    track: input.track,
    quality: input.quality,
  });

  return playUrl({
    url: resolved.url,
    track: resolved.track,
    deviceId: input.deviceId,
    durationMs: input.durationMs ?? resolved.track.durationMs,
    positionMs: input.positionMs,
    queueIndex: input.queueIndex,
  });
}

export async function playUrl(
  input: PlayUrlInput,
): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(input.deviceId);
  const playbackUrl = createAudioProxyUrl(input.url);
  await sendPlayerOperation(target.id, "pause");
  await sendPlayerOperation(target.id, "stop");
  await delay(500);
  await sendDevicePlayUrl({
    deviceId: target.id,
    hardware: target.type,
    url: playbackUrl,
    title: input.track?.title,
    durationMs: input.durationMs,
  });

  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    state: "playing",
    track: input.track,
    positionMs: input.positionMs ?? 0,
    durationMs: input.durationMs ?? input.track?.durationMs ?? 0,
    volume: playbackState.volume,
    seekEnabled: target.capabilities.supportsSeek,
    updatedAt: Date.now(),
  };
  if (input.track) {
    const queue = syncQueuePlaybackTrack(input.track, input.queueIndex);
    playbackState = {
      ...playbackState,
      queueIndex: queue.currentIndex,
      queueLength: queue.items.length,
    };
  }
  return playbackState;
}

export async function pausePlayback(): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(playbackState.deviceId);
  await sendPlayerOperation(target.id, "pause");
  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    state: "paused",
    updatedAt: Date.now(),
  };
  return playbackState;
}

export async function resumePlayback(): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(playbackState.deviceId);
  await sendPlayerOperation(target.id, "play");
  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    state: "playing",
    updatedAt: Date.now(),
  };
  return playbackState;
}

export async function stopPlayback(): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(playbackState.deviceId);
  // 部分小爱型号单独调用 stop 不会真正停止，先 pause 再 stop（对齐 参考实现）。
  await sendPlayerOperation(target.id, "pause");
  await sendPlayerOperation(target.id, "stop");
  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    state: "stopped",
    positionMs: 0,
    updatedAt: Date.now(),
  };
  return playbackState;
}

export async function nextPlayback(): Promise<HMusicPlaybackState> {
  const queueTarget = await getQueuePlaybackTarget("next");
  if (queueTarget) {
    await setCurrentQueueIndex(queueTarget.index);
    return playTrack({
      track: queueTarget.track,
      deviceId: playbackState.deviceId,
      queueIndex: queueTarget.index,
    });
  }

  const target = await resolveTargetDevice(playbackState.deviceId);
  await sendPlayerOperation(target.id, "next");
  return markLoading(target.id, target.name);
}

export async function previousPlayback(): Promise<HMusicPlaybackState> {
  const queueTarget = await getQueuePlaybackTarget("previous");
  if (queueTarget) {
    await setCurrentQueueIndex(queueTarget.index);
    return playTrack({
      track: queueTarget.track,
      deviceId: playbackState.deviceId,
      queueIndex: queueTarget.index,
    });
  }

  const target = await resolveTargetDevice(playbackState.deviceId);
  await sendPlayerOperation(target.id, "prev");
  return markLoading(target.id, target.name);
}

async function getQueuePlaybackTarget(
  direction: "next" | "previous",
): Promise<{ index: number; track: HMusicTrack } | undefined> {
  const queue = await getQueue();
  if (queue.items.length === 0 || queue.currentIndex < 0) {
    return undefined;
  }

  const index =
    direction === "next"
      ? getNextQueueIndex(queue)
      : getPreviousQueueIndex(queue);
  if (index === undefined) {
    throw new AppError(
      direction === "next" ? "QUEUE_END" : "QUEUE_START",
      direction === "next" ? "已是最后一首" : "已是第一首",
      409,
      {
        currentIndex: queue.currentIndex,
        length: queue.items.length,
        playMode: queue.playMode,
      },
    );
  }

  const item = queue.items[index];
  if (!item) {
    throw new AppError("QUEUE_INDEX_INVALID", "队列索引无效", 409, {
      index,
      length: queue.items.length,
    });
  }

  return { index, track: item.track };
}

function getNextQueueIndex(queue: HMusicQueue): number | undefined {
  switch (queue.playMode) {
    case "single_loop":
      return queue.currentIndex;
    case "shuffle":
      return getRandomQueueIndex(queue);
    case "sequence":
    case "single_once":
      return queue.currentIndex >= queue.items.length - 1
        ? undefined
        : queue.currentIndex + 1;
    case "list_loop":
    default:
      return (queue.currentIndex + 1) % queue.items.length;
  }
}

function getPreviousQueueIndex(queue: HMusicQueue): number | undefined {
  switch (queue.playMode) {
    case "single_loop":
      return queue.currentIndex;
    case "shuffle":
      return getRandomQueueIndex(queue);
    case "sequence":
    case "single_once":
      return queue.currentIndex <= 0 ? undefined : queue.currentIndex - 1;
    case "list_loop":
    default:
      return (queue.currentIndex - 1 + queue.items.length) % queue.items.length;
  }
}

function getRandomQueueIndex(queue: HMusicQueue): number {
  if (queue.items.length <= 1) return 0;

  let nextIndex = queue.currentIndex;
  while (nextIndex === queue.currentIndex) {
    nextIndex = Math.floor(Math.random() * queue.items.length);
  }
  return nextIndex;
}

export async function seekPlayback(
  positionMs: number,
): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(playbackState.deviceId);
  if (!target.capabilities.supportsSeek) {
    throw new AppError(
      "DEVICE_SEEK_UNSUPPORTED",
      "当前设备不支持进度跳转",
      409,
      {
        deviceId: target.id,
      },
    );
  }

  await sendPlaybackUbus(target.id, "player_set_positon", {
    position: positionMs,
    media: "app_ios",
  });
  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    positionMs,
    updatedAt: Date.now(),
  };
  return playbackState;
}

export async function setPlaybackVolume(
  volume: number,
): Promise<HMusicPlaybackState> {
  const target = await resolveTargetDevice(playbackState.deviceId);
  const normalizedVolume = Math.max(0, Math.min(100, Math.round(volume)));
  await sendPlaybackUbus(target.id, "player_set_volume", {
    volume: normalizedVolume,
    media: "app_ios",
  });
  playbackState = {
    ...playbackState,
    deviceId: target.id,
    deviceName: target.name,
    volume: normalizedVolume,
    updatedAt: Date.now(),
  };
  return playbackState;
}

export async function speakOnDevice(
  text: string,
  deviceId?: string,
): Promise<{ deviceId: string; deviceName: string }> {
  const target = await resolveTargetDevice(deviceId);
  const session = await getStoredMiSession();
  await sendXiaomiTts({ session, deviceId: target.id, text });
  return { deviceId: target.id, deviceName: target.name };
}

async function sendPlayerOperation(
  deviceId: string,
  action: "pause" | "stop" | "play" | "next" | "prev",
): Promise<void> {
  await sendPlaybackUbus(deviceId, "player_play_operation", {
    action,
    media: "app_ios",
  });
}

async function sendDevicePlayUrl(input: {
  deviceId: string;
  hardware?: string;
  url: string;
  title?: string;
  durationMs?: number;
}): Promise<void> {
  const { extraPlayMusicModels } = await getRuntimeConfig();
  const media = playbackMediaContext(input.hardware);
  const attempts = needsPlayMusicApi(input.hardware, extraPlayMusicModels)
    ? [createPlayMusicAttempt(input, media), createPlayUrlAttempt(input, media)]
    : [
        createPlayUrlAttempt(input, media),
        createPlayMusicAttempt(input, media),
      ];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await sendPlaybackUbus(input.deviceId, attempt.method, attempt.message);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof AppError) {
    throw lastError;
  }
  throw new AppError("MI_PLAYBACK_FAILED", "小米设备播放失败", 502);
}

function createPlayUrlAttempt(
  input: {
    url: string;
    durationMs?: number;
  },
  media: string,
): { method: string; message: Record<string, unknown> } {
  return {
    method: "player_play_url",
    message: {
      url: input.url,
      type: 2,
      media,
      ...(input.durationMs ? { duration: input.durationMs } : {}),
    },
  };
}

function createPlayMusicAttempt(
  input: {
    deviceId: string;
    url: string;
    title?: string;
    durationMs?: number;
  },
  media: string,
): { method: string; message: Record<string, unknown> } {
  const audioId = createMiAudioId({
    url: input.url,
    title: input.title,
  });
  const music = {
    payload: {
      audio_type: "",
      audio_items: [
        {
          item_id: {
            audio_id: audioId,
            cp: {
              album_id: "-1",
              episode_index: 0,
              id: "355454500",
              name: "xiaowei",
            },
          },
          stream: { url: input.url },
        },
      ],
      list_params: {
        listId: "-1",
        loadmore_offset: 0,
        origin: "xiaowei",
        type: "MUSIC",
      },
    },
    play_behavior: "REPLACE_ALL",
  };

  return {
    method: "player_play_music",
    message: {
      startaudioid: audioId,
      music: JSON.stringify(music),
      media,
      ...(input.durationMs ? { duration: input.durationMs } : {}),
    },
  };
}

async function sendPlaybackUbus(
  deviceId: string,
  method: string,
  message: Record<string, unknown>,
): Promise<unknown> {
  const session = await getStoredMiSession();
  return sendXiaomiUbusRequest({
    session,
    deviceId,
    method,
    message,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshPlaybackStateFromDevice(): Promise<void> {
  try {
    const target = await resolveTargetDevice(playbackState.deviceId);
    const response = await sendPlaybackUbus(
      target.id,
      "player_get_play_status",
      {
        media: "app_ios",
      },
    );
    const status = parseDevicePlaybackStatus(response);
    if (!status) return;

    playbackState = {
      ...playbackState,
      deviceId: target.id,
      deviceName: target.name,
      state: status.state ?? playbackState.state,
      positionMs: status.positionMs ?? playbackState.positionMs,
      durationMs: status.durationMs ?? playbackState.durationMs,
      volume: status.volume ?? playbackState.volume,
      playMode: status.playMode ?? playbackState.playMode,
      track: status.track ?? playbackState.track,
      seekEnabled: target.capabilities.supportsSeek,
      updatedAt: Date.now(),
    };
  } catch {
    // Device status is best-effort. Keep the optimistic in-memory state.
  }
}

function parseDevicePlaybackStatus(
  response: unknown,
): Partial<HMusicPlaybackState> | undefined {
  const root = asRecord(response);
  const data = asRecord(root?.data);
  const info = data?.info;
  const rawStatus =
    typeof info === "string"
      ? safeJsonParse(info)
      : (asRecord(info) ?? data ?? root);
  if (!rawStatus) return undefined;

  const detail = asRecord(rawStatus.play_song_detail);
  const title = asString(detail?.title);
  const artist = asString(detail?.artist);
  const audioId =
    asString(detail?.audio_id) ||
    asString(detail?.global_id) ||
    asString(detail?.id);

  return {
    state: mapDeviceStatus(asNumber(rawStatus.status)),
    volume: asNumber(rawStatus.volume),
    positionMs: asNumber(detail?.position),
    durationMs: asNumber(detail?.duration),
    playMode: mapDeviceLoopType(asNumber(rawStatus.loop_type)),
    track:
      detail && (title || audioId)
        ? {
            id: playbackState.track?.id || audioId || "device:current",
            source: playbackState.track?.source || "device",
            sourceTrackId:
              playbackState.track?.sourceTrackId || audioId || "current",
            title: title || playbackState.track?.title || "未知歌曲",
            artist: artist || playbackState.track?.artist || "未知艺术家",
            album: asString(detail.album) || playbackState.track?.album,
            durationMs:
              asNumber(detail.duration) || playbackState.track?.durationMs,
            coverUrl: asString(detail.cover) || playbackState.track?.coverUrl,
            url: playbackState.track?.url,
            qualities: playbackState.track?.qualities,
            raw: detail,
          }
        : undefined,
  };
}

function mapDeviceStatus(
  status: number | undefined,
): HMusicPlaybackState["state"] | undefined {
  if (status === 0) return "idle";
  if (status === 1) return "playing";
  if (status === 2) return "paused";
  return undefined;
}

function mapDeviceLoopType(
  loopType: number | undefined,
): HMusicPlaybackState["playMode"] | undefined {
  if (loopType === 0) return "single_loop";
  if (loopType === 1) return "list_loop";
  if (loopType === 3) return "shuffle";
  return undefined;
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function resolveTargetDevice(deviceId?: string) {
  const devices = await listDevices();
  const target =
    (deviceId ? devices.find((device) => device.id === deviceId) : undefined) ??
    devices.find((device) => device.isDefault) ??
    devices[0];

  if (!target) {
    throw new AppError(
      "DEVICE_NOT_FOUND",
      "请先登录小米账号并选择播放设备",
      404,
    );
  }

  return target;
}

function markLoading(
  deviceId: string,
  deviceName: string,
): HMusicPlaybackState {
  playbackState = {
    ...playbackState,
    deviceId,
    deviceName,
    state: "loading",
    updatedAt: Date.now(),
  };
  return playbackState;
}
