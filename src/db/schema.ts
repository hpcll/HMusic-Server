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
