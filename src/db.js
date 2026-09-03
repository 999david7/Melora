import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { INTERNAL_DIRNAME } from './volume.js';

/**
 * The index database.
 *
 * It lives on the SSD, next to the music it describes, not on the computer.
 * That is the whole point of the project: unplug the drive and there is
 * nothing left behind to browse — no track names, no artists, no cached list
 * of everything you own. It also means the library is portable between
 * machines with no export step, and that a lost laptop leaks nothing.
 */

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS folders (
  id             INTEGER PRIMARY KEY,
  rel_path       TEXT NOT NULL UNIQUE,   -- '' is the library root
  parent_path    TEXT,                   -- NULL only for the root
  name           TEXT NOT NULL,
  description    TEXT,
  cover_track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_path);

CREATE TABLE IF NOT EXISTS tracks (
  id           INTEGER PRIMARY KEY,
  rel_path     TEXT NOT NULL UNIQUE,
  folder_path  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  hash         TEXT,                     -- sha256 of file contents

  -- Read from the file's tags, never written back to it.
  title        TEXT,
  artist       TEXT,
  album_artist TEXT,
  album        TEXT,
  album_key    TEXT,                     -- what groups tracks into one album
  track_no     INTEGER,
  disc_no      INTEGER,
  year         INTEGER,
  genre        TEXT,

  duration     REAL,                     -- seconds; NULL when unknown
  bitrate      INTEGER,
  sample_rate  INTEGER,
  channels     INTEGER,
  lossless     INTEGER,
  codec        TEXT,

  -- Cover art: 'embedded' (inside the file), 'file' (cover.jpg beside it) or
  -- NULL. art_key is the cache key; art_path points at the image on disk.
  art_source   TEXT,
  art_key      TEXT,
  art_path     TEXT,

  note         TEXT,
  favorite     INTEGER NOT NULL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  last_played  INTEGER,

  -- 'ready' | 'unplayable'. Formats no browser can decode are still indexed
  -- and still counted; they simply cannot be played from the web interface.
  state        TEXT NOT NULL DEFAULT 'ready',
  missing      INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_folder   ON tracks(folder_path);
CREATE INDEX IF NOT EXISTS idx_tracks_hash     ON tracks(hash);
CREATE INDEX IF NOT EXISTS idx_tracks_album    ON tracks(album_key, disc_no, track_no);
CREATE INDEX IF NOT EXISTS idx_tracks_artist   ON tracks(artist);
CREATE INDEX IF NOT EXISTS idx_tracks_favorite ON tracks(favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_tracks_missing  ON tracks(missing);

-- Playlists are .m3u8 files in Playlists/ on the drive. These tables mirror
-- them so the interface can query them; the files stay the source of truth.
CREATE TABLE IF NOT EXISTS playlists (
  id          INTEGER PRIMARY KEY,
  rel_path    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  rel_path    TEXT NOT NULL,             -- kept even when the track is missing
  track_id    INTEGER REFERENCES tracks(id) ON DELETE SET NULL,
  PRIMARY KEY (playlist_id, position)
);
CREATE INDEX IF NOT EXISTS idx_playlist_items_track ON playlist_items(track_id);

-- Remembers which files a sync already pulled in, keyed by their path in the
-- source folder. Lets a repeat sync skip untouched files on a stat alone
-- instead of re-hashing gigabytes to rediscover that nothing changed.
CREATE TABLE IF NOT EXISTS import_ledger (
  source_path TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  rel_path    TEXT,
  imported_at INTEGER NOT NULL
);
`;

export function databasePath(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'index.db');
}

export function cacheDir(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'cache');
}

export function trashDir(libraryPath) {
  return path.join(libraryPath, INTERNAL_DIRNAME, 'trash');
}

export function openDatabase(libraryPath) {
  const file = databasePath(libraryPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);

  // WAL is the right mode on a normal filesystem, but external drives are
  // routinely exFAT, where the shared-memory file WAL needs may be refused.
  // Fall back rather than fail: a slower journal beats an unopenable library.
  try {
    db.pragma('journal_mode = WAL');
  } catch {
    db.pragma('journal_mode = TRUNCATE');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(SCHEMA);
  migrate(db);
  ensureRootFolder(db);
  return db;
}

function migrate(db) {
  const current = Number(db.pragma('user_version', { simple: true }));
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `this library was written by a newer version of Melora ` +
        `(schema ${current}, this build understands ${SCHEMA_VERSION})`,
    );
  }
  // Future schema changes go here as `if (current < N) { ... }` blocks.
  if (current !== SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function ensureRootFolder(db) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO folders (rel_path, parent_path, name, created_at, updated_at)
     VALUES ('', NULL, 'Library', ?, ?)
     ON CONFLICT(rel_path) DO NOTHING`,
  ).run(now, now);
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}
