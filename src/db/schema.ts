import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appConfig = sqliteTable("app_config", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type"),
  ip: text("ip"),
  isOnline: integer("is_online").notNull().default(0),
  isDefault: integer("is_default").notNull().default(0),
  capabilitiesJson: text("capabilities_json").notNull(),
  lastSeenAt: integer("last_seen_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const miAccounts = sqliteTable("mi_accounts", {
  id: text("id").primaryKey(),
  accountMasked: text("account_masked").notNull(),
  serviceTokenEnc: text("service_token_enc"),
  userIdEnc: text("user_id_enc"),
  ssecurityEnc: text("ssecurity_enc"),
  deviceId: text("device_id"),
  isLoggedIn: integer("is_logged_in").notNull().default(0),
  // 小米侧 401 确证会话失效的时间；区分「登录已过期」与「主动退出」（后者为 NULL）。
  sessionExpiredAt: integer("session_expired_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const miVerificationSessions = sqliteTable(
  "mi_verification_sessions",
  {
    id: text("id").primaryKey(),
    accountEnc: text("account_enc").notNull(),
    accountMasked: text("account_masked").notNull(),
    deviceId: text("device_id").notNull(),
    stateJsonEnc: text("state_json_enc").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    expiresAtIndex: index("mi_verification_sessions_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export const miWebVerificationSessions = sqliteTable(
  "mi_web_verification_sessions",
  {
    id: text("id").primaryKey(),
    accountEnc: text("account_enc").notNull(),
    accountMasked: text("account_masked").notNull(),
    passwordEnc: text("password_enc").notNull(),
    deviceId: text("device_id").notNull(),
    verificationUrlEnc: text("verification_url_enc").notNull(),
    cookiesJsonEnc: text("cookies_json_enc"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    expiresAtIndex: index("mi_web_verification_sessions_expires_at_idx").on(
      table.expiresAt,
    ),
  }),
);

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceTrackId: text("source_track_id").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    durationMs: integer("duration_ms"),
    coverUrl: text("cover_url"),
    rawJson: text("raw_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    sourceTrackUnique: uniqueIndex("tracks_source_track_unique").on(
      table.source,
      table.sourceTrackId,
    ),
  }),
);

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const playlistTracks = sqliteTable(
  "playlist_tracks",
  {
    id: text("id").primaryKey(),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: integer("added_at").notNull(),
  },
  (table) => ({
    playlistPositionIndex: index("playlist_tracks_playlist_position_idx").on(
      table.playlistId,
      table.position,
    ),
    playlistTrackIndex: index("playlist_tracks_playlist_track_idx").on(
      table.playlistId,
      table.trackId,
    ),
  }),
);

// 播放历史：家庭热播榜的数据源。冗余存曲目快照（title/artist/cover），
// 不外键 tracks —— 搜索来的曲目未必入库，且历史应当独立于曲库存续。
export const playHistory = sqliteTable(
  "play_history",
  {
    id: text("id").primaryKey(),
    trackKey: text("track_key").notNull(), // source:sourceTrackId，聚合去重用
    source: text("source").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    coverUrl: text("cover_url"),
    trackJson: text("track_json").notNull(), // 完整 HMusicTrack，榜单点播直接回放
    playedAt: integer("played_at").notNull(),
  },
  (table) => ({
    playedAtIndex: index("play_history_played_at_idx").on(table.playedAt),
    trackKeyIndex: index("play_history_track_key_idx").on(table.trackKey),
  }),
);

// 已下载到服务器本地的音乐。file_path 相对 dataDir，播放解析优先命中本地文件，
// 彻底免疫平台直链过期；cover_url 存原始封面地址（前端展示用）。
export const downloads = sqliteTable(
  "downloads",
  {
    id: text("id").primaryKey(),
    trackKey: text("track_key").notNull().unique(), // source:sourceTrackId
    source: text("source").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    album: text("album"),
    coverUrl: text("cover_url"),
    trackJson: text("track_json").notNull(),
    quality: text("quality"),
    filePath: text("file_path").notNull(), // 相对 dataDir，如 music/xxx.mp3
    fileExt: text("file_ext").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    status: text("status").notNull().default("pending"), // pending|downloading|done|failed
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    statusIndex: index("downloads_status_idx").on(table.status),
    createdAtIndex: index("downloads_created_at_idx").on(table.createdAt),
  }),
);

// NAS 本地曲库：磁盘上的音乐文件索引（扫描/上传/下载三种来源统一入库）。
// file_path 存绝对路径——存量目录可以在 dataDir 之外，不能像 downloads 那样只存相对段。
// mtime_ms + byte_size 做增量扫描指纹：两者都没变就跳过重读标签（千首级全量重扫太慢）。
// track_key 唯一：扫描来源用 "local:<路径哈希>"，下载/上传沿用原始 source:sourceTrackId，
// 同一首歌无论从哪条路进来都只占一条，不会在曲库里出现两份。
export const library = sqliteTable(
  "library",
  {
    id: text("id").primaryKey(),
    trackKey: text("track_key").notNull().unique(),
    origin: text("origin").notNull().default("scan"), // scan|upload|download
    source: text("source").notNull().default("local"),
    title: text("title").notNull(),
    artist: text("artist").notNull().default(""),
    album: text("album"),
    durationMs: integer("duration_ms"),
    coverPath: text("cover_path"), // 内嵌封面落盘后的相对 dataDir 路径
    coverUrl: text("cover_url"), // 在线来源的原始封面地址
    lrc: text("lrc"), // 刮削到的歌词（本地 .lrc 或在线匹配）
    // 刮削状态：pending 待刮 / done 已完成 / miss 尝试过但没找到。
    // miss 与 done 都不重复刮，避免每轮扫描都为无解曲目打一次在线请求。
    scrapeStatus: text("scrape_status").notNull().default("pending"),
    // 相对扫描根的目录路径（"" = 根目录直属），文件夹分类浏览用。
    folder: text("folder").notNull().default(""),
    trackJson: text("track_json"), // 下载/上传时保留的原始曲目快照
    filePath: text("file_path").notNull().unique(), // 绝对路径
    fileExt: text("file_ext").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    mtimeMs: integer("mtime_ms").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    titleIndex: index("library_title_idx").on(table.title),
    artistIndex: index("library_artist_idx").on(table.artist),
    folderIndex: index("library_folder_idx").on(table.folder),
    scrapeIndex: index("library_scrape_idx").on(table.scrapeStatus),
    createdAtIndex: index("library_created_at_idx").on(table.createdAt),
  }),
);
