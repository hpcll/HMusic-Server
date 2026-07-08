import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

fs.mkdirSync(path.dirname(env.databaseUrl), { recursive: true });

const sqlite = new Database(env.databaseUrl);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

export function ensureSchema(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      ip TEXT,
      is_online INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      capabilities_json TEXT NOT NULL,
      last_seen_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mi_accounts (
      id TEXT PRIMARY KEY,
      account_masked TEXT NOT NULL,
      service_token_enc TEXT,
      user_id_enc TEXT,
      ssecurity_enc TEXT,
      device_id TEXT,
      is_logged_in INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mi_verification_sessions (
      id TEXT PRIMARY KEY,
      account_enc TEXT NOT NULL,
      account_masked TEXT NOT NULL,
      device_id TEXT NOT NULL,
      state_json_enc TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS mi_verification_sessions_expires_at_idx
      ON mi_verification_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS mi_web_verification_sessions (
      id TEXT PRIMARY KEY,
      account_enc TEXT NOT NULL,
      account_masked TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      device_id TEXT NOT NULL,
      verification_url_enc TEXT NOT NULL,
      cookies_json_enc TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS mi_web_verification_sessions_expires_at_idx
      ON mi_web_verification_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_track_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration_ms INTEGER,
      cover_url TEXT,
      raw_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source, source_track_id)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_position_idx
      ON playlist_tracks(playlist_id, position);
    CREATE INDEX IF NOT EXISTS playlist_tracks_playlist_track_idx
      ON playlist_tracks(playlist_id, track_id);

    CREATE TABLE IF NOT EXISTS play_history (
      id TEXT PRIMARY KEY,
      track_key TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      cover_url TEXT,
      track_json TEXT NOT NULL,
      played_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS play_history_played_at_idx
      ON play_history(played_at);
    CREATE INDEX IF NOT EXISTS play_history_track_key_idx
      ON play_history(track_key);
	  `);

  try {
    sqlite.exec(`
      ALTER TABLE mi_web_verification_sessions
      ADD COLUMN cookies_json_enc TEXT;
    `);
  } catch {
    // Column already exists on databases created by newer builds.
  }
}
