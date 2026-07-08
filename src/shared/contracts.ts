export type HMusicTrack = {
  id: string;
  source: string;
  sourceTrackId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  coverUrl?: string;
  url?: string;
  qualities?: string[];
  raw?: unknown;
};

export type HMusicDevice = {
  id: string;
  name: string;
  type?: string;
  isOnline: boolean;
  ip?: string;
  isDefault: boolean;
  capabilities: {
    supportsPlayUrl: boolean;
    supportsPauseResume: boolean;
    supportsSeek: boolean;
    supportsVolume: boolean;
    supportsRichStatus: boolean;
    supportsDeviceNext: boolean;
  };
};

export type HMusicSource = {
  id: string;
  name: string;
  type: "manual" | "lx_js";
  enabled: boolean;
  priority: number;
  config: {
    defaultQuality: "128k" | "320k" | "flac" | "hires";
  };
  health: {
    status: "unknown" | "ok" | "failed";
    message?: string;
    checkedAt?: number;
  };
  updatedAt: number;
};

export type HMusicSearchResult = {
  query: string;
  source?: string;
  page: number;
  limit: number;
  total: number;
  tracks: HMusicTrack[];
};

export type HMusicResolvedTrack = {
  track: HMusicTrack;
  url: string;
  quality: string;
  expiresAt?: number;
};

export type HMusicPlaybackState = {
  sessionId: "default";
  deviceId?: string;
  deviceName?: string;
  state: "idle" | "loading" | "playing" | "paused" | "stopped" | "error";
  track?: HMusicTrack;
  positionMs: number;
  durationMs: number;
  volume: number;
  playMode:
    "list_loop" | "single_loop" | "shuffle" | "sequence" | "single_once";
  queueIndex: number;
  queueLength: number;
  seekEnabled: boolean;
  // 仅「本机播放」虚拟设备：浏览器 <audio> 直连的音频代理地址。
  streamUrl?: string;
  updatedAt: number;
};

export type HMusicQueueItem = {
  id: string;
  track: HMusicTrack;
  addedAt: number;
};

export type HMusicQueue = {
  sessionId: "default";
  items: HMusicQueueItem[];
  currentIndex: number;
  playMode: HMusicPlaybackState["playMode"];
  updatedAt: number;
};

export type HMusicPlaylistSummary = {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
};

export type HMusicPlaylistItem = {
  id: string;
  playlistId: string;
  track: HMusicTrack;
  position: number;
  addedAt: number;
};

export type HMusicPlaylistDetail = HMusicPlaylistSummary & {
  items: HMusicPlaylistItem[];
};

export type HMusicLyric = {
  trackId: string;
  source: string;
  lrc: string;
  lines: Array<{
    timeMs: number;
    text: string;
  }>;
  translatedLines: Array<{
    timeMs: number;
    text: string;
  }>;
  updatedAt: number;
};
