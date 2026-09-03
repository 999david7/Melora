import fsp from 'node:fs/promises';
import path from 'node:path';
import { dropArt } from './art.js';
import { findFolderArt, hashFile, isAudioFile, isPlayable, readTags } from './audio.js';
import { relFrom, safeJoin } from './paths.js';
import { mapPool, throwIfAborted } from './util.js';
import { INTERNAL_DIRNAME, PLAYLIST_DIRNAME } from './volume.js';

/**
 * Bringing the index in line with what is actually on the drive.
 *
 * The scan is deliberately reconciliation rather than rebuild. A music library
 * accumulates things that only exist in the index — a favourite, a note, a
 * play count, a folder cover — and those must survive a track being moved into
 * a different folder or the whole collection being reorganised in Finder. So
 * the scanner matches by content hash and *moves* index rows to follow their
 * files instead of deleting and reinserting them.
 */

/** Directories never worth walking into. */
const SKIP_DIRS = new Set([INTERNAL_DIRNAME, '.git', 'node_modules', '@eaDir', '.Trashes', '$RECYCLE.BIN']);

async function walk(root, { signal } = {}) {
  const files = [];
  const folders = [];
  const queue = [''];

  while (queue.length > 0) {
    throwIfAborted(signal);
    const relDir = queue.shift();
    const absDir = relDir === '' ? root : safeJoin(root, relDir);

    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (relDir === '') throw err;
      continue; // A directory that vanished mid-walk is simply not there.
    }

    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        // Playlists are files about the library, not part of it.
        if (relDir === '' && entry.name === PLAYLIST_DIRNAME) continue;
        folders.push(rel);
        queue.push(rel);
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        files.push(rel);
      }
      // Symlinks are skipped: following them can leave the library root and
      // can loop, and neither is worth supporting for an archive on a drive.
    }
  }
  return { files, folders };
}

/**
 * Cover art beside the music, resolved once per folder per scan.
 *
 * Without the cache an album of eighteen tracks would readdir and re-hash the
 * same `cover.jpg` eighteen times.
 */
function folderArtCache(root) {
  const seen = new Map();
  return async (folderPath) => {
    if (seen.has(folderPath)) return seen.get(folderPath);
    const absDir = folderPath === '' ? root : safeJoin(root, folderPath);
    const found = await findFolderArt(absDir);
    const art = found ? { key: await hashFile(found), relPath: relFrom(root, found) } : null;
    seen.set(folderPath, art);
    return art;
  };
}

async function describe(root, relPath, resolveFolderArt) {
  const abs = safeJoin(root, relPath);
  const folderPath = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
  const stat = await fsp.stat(abs);
  const hash = await hashFile(abs);
  const tags = await readTags(abs, { folderPath });

  // Art embedded in the file wins: it is what the person who made the file
  // chose, and it is right even when one folder holds several albums.
  let art = { source: null, key: null, path: null };
  if (tags.hasEmbeddedArt) {
    art = { source: 'embedded', key: hash, path: null };
  } else {
    const beside = await resolveFolderArt(folderPath);
    if (beside) art = { source: 'file', key: beside.key, path: beside.relPath };
  }

  return {
    relPath,
    folderPath,
    abs,
    size: stat.size,
    mtime: Math.round(stat.mtimeMs),
    hash,
    ...tags,
    art,
    state: isPlayable(relPath) ? 'ready' : 'unplayable',
  };
}

/** Named parameters shared by the insert and the move-a-row-to-a-new-path update. */
function rowParams(info) {
  return {
    relPath: info.relPath,
    folderPath: info.folderPath,
    filename: path.posix.basename(info.relPath),
    ext: path.extname(info.relPath).toLowerCase(),
    size: info.size,
    mtime: info.mtime,
    hash: info.hash,
    title: info.title,
    artist: info.artist,
    albumArtist: info.albumArtist,
    album: info.album,
    albumKey: info.albumKey,
    trackNo: info.trackNo,
    discNo: info.discNo,
    year: info.year,
    genre: info.genre,
    duration: info.duration,
    bitrate: info.bitrate,
    sampleRate: info.sampleRate,
    channels: info.channels,
    lossless: info.lossless,
    codec: info.codec,
    artSource: info.art.source,
    artKey: info.art.key,
    artPath: info.art.path,
    state: info.state,
    indexedAt: Date.now(),
  };
}

const INSERT_SQL = `
  INSERT INTO tracks (rel_path, folder_path, filename, ext, size, mtime, hash,
                      title, artist, album_artist, album, album_key, track_no, disc_no,
                      year, genre, duration, bitrate, sample_rate, channels, lossless,
                      codec, art_source, art_key, art_path, state, missing, indexed_at)
  VALUES (@relPath, @folderPath, @filename, @ext, @size, @mtime, @hash,
          @title, @artist, @albumArtist, @album, @albumKey, @trackNo, @discNo,
          @year, @genre, @duration, @bitrate, @sampleRate, @channels, @lossless,
          @codec, @artSource, @artKey, @artPath, @state, 0, @indexedAt)
  ON CONFLICT(rel_path) DO NOTHING`;

const MOVE_SQL = `
  UPDATE tracks SET rel_path = @relPath, folder_path = @folderPath, filename = @filename,
         ext = @ext, size = @size, mtime = @mtime, hash = @hash, title = @title,
         artist = @artist, album_artist = @albumArtist, album = @album, album_key = @albumKey,
         track_no = @trackNo, disc_no = @discNo, year = @year, genre = @genre,
         duration = @duration, bitrate = @bitrate, sample_rate = @sampleRate,
         channels = @channels, lossless = @lossless, codec = @codec,
         art_source = @artSource, art_key = @artKey, art_path = @artPath,
         state = @state, missing = 0, indexed_at = @indexedAt
   WHERE id = @id`;

/**
 * Reconcile the index with the filesystem.
 *
 * `onProgress` receives `{ phase, processed, total, current }`. `signal`
 * aborts between files, so cancelling never leaves a half-written row.
 */
export async function scanLibrary(library, { onProgress = () => {}, signal, concurrency = 4 } = {}) {
  const { db, path: root } = library;
  const report = {
    added: 0, updated: 0, moved: 0, missing: 0, restored: 0,
    foldersAdded: 0, foldersRemoved: 0, unchanged: 0, failed: 0, scanned: 0,
    artUpdated: 0, playlists: 0,
  };
  const resolveFolderArt = folderArtCache(root);

  onProgress({ phase: 'walking', processed: 0, total: 0, current: null });
  const { files, folders } = await walk(root, { signal });
  report.scanned = files.length;

  // ---- folders -------------------------------------------------------------
  const onDisk = new Set(folders);
  const known = new Set(
    db.prepare("SELECT rel_path FROM folders WHERE rel_path <> ''").all().map((r) => r.rel_path),
  );
  db.transaction(() => {
    for (const rel of onDisk) {
      if (!known.has(rel)) {
        library.ensureFolderRow(rel);
        report.foldersAdded += 1;
      }
    }
    const remove = db.prepare('DELETE FROM folders WHERE rel_path = ?');
    for (const rel of known) {
      if (!onDisk.has(rel)) {
        remove.run(rel);
        report.foldersRemoved += 1;
      }
    }
  })();

  // ---- classify ------------------------------------------------------------
  const rows = db
    .prepare('SELECT id, rel_path, size, mtime, hash, missing, art_key FROM tracks')
    .all();
  const byPath = new Map(rows.map((row) => [row.rel_path, row]));

  const fresh = [];  // On disk, no index row at this path.
  const dirty = [];  // Indexed here, but the bytes changed.

  await mapPool(files, concurrency, async (rel) => {
    throwIfAborted(signal);
    const row = byPath.get(rel);
    if (!row) {
      fresh.push(rel);
      return;
    }
    byPath.delete(rel);
    const stat = await fsp.stat(safeJoin(root, rel)).catch(() => null);
    if (!stat) {
      fresh.push(rel);
      return;
    }
    const mtime = Math.round(stat.mtimeMs);
    if (row.size === stat.size && row.mtime === mtime && row.missing === 0) {
      report.unchanged += 1;
      return;
    }
    dirty.push({ rel, row });
  });

  // Whatever is left in `byPath` has no file at its recorded path: either it
  // moved somewhere else in the library, or it is gone.
  const orphans = [...byPath.values()];
  const orphansByHash = new Map();
  for (const orphan of orphans) {
    if (!orphan.hash) continue;
    if (!orphansByHash.has(orphan.hash)) orphansByHash.set(orphan.hash, []);
    orphansByHash.get(orphan.hash).push(orphan);
  }
  const claimed = new Set();

  // ---- changed files -------------------------------------------------------
  let processed = 0;
  const total = dirty.length + fresh.length;
  const updateRow = db.prepare(MOVE_SQL);

  await mapPool(dirty, concurrency, async ({ rel, row }) => {
    throwIfAborted(signal);
    try {
      const info = await describe(root, rel, resolveFolderArt);
      if (row.art_key && row.art_key !== info.art.key) await dropArt(root, row.art_key);
      updateRow.run({ ...rowParams(info), id: row.id });
      report.updated += 1;
    } catch (err) {
      if (err.cancelled) throw err;
      report.failed += 1;
    }
    processed += 1;
    onProgress({ phase: 'indexing', processed, total, current: rel });
  });

  // ---- new files -----------------------------------------------------------
  const insertRow = db.prepare(INSERT_SQL);
  const moveRow = db.prepare(MOVE_SQL);

  await mapPool(fresh, concurrency, async (rel) => {
    throwIfAborted(signal);
    try {
      const info = await describe(root, rel, resolveFolderArt);
      const params = rowParams(info);

      // Did a track we thought was lost just turn up here under a new path?
      // Reusing its row keeps the favourite, the note, the play count and any
      // folder cover pointing at it.
      const candidates = orphansByHash.get(info.hash) ?? [];
      const inherit = candidates.find((row) => !claimed.has(row.id));
      if (inherit) {
        claimed.add(inherit.id);
        moveRow.run({ ...params, id: inherit.id });
        if (inherit.missing) report.restored += 1;
        else report.moved += 1;
      } else {
        insertRow.run(params);
        report.added += 1;
      }
    } catch (err) {
      if (err.cancelled) throw err;
      report.failed += 1;
    }
    processed += 1;
    onProgress({ phase: 'indexing', processed, total, current: rel });
  });

  // ---- everything still unaccounted for ------------------------------------
  const markMissing = db.prepare('UPDATE tracks SET missing = 1 WHERE id = ?');
  db.transaction(() => {
    for (const orphan of orphans) {
      if (claimed.has(orphan.id)) continue;
      if (orphan.missing) continue; // Already flagged by an earlier scan.
      markMissing.run(orphan.id);
      report.missing += 1;
    }
  })();

  // ---- cover art beside unchanged files ------------------------------------
  // Dropping a cover.jpg into an album folder does not touch a single audio
  // file, so nothing above would notice it. This pass is what makes "add the
  // artwork, press Scan" work.
  onProgress({ phase: 'artwork', processed: 0, total: 0, current: null });
  const artFolders = db
    .prepare(
      `SELECT DISTINCT folder_path FROM tracks
       WHERE missing = 0 AND (art_source IS NULL OR art_source = 'file')`,
    )
    .all();
  const setArt = db.prepare(
    `UPDATE tracks SET art_source = ?, art_key = ?, art_path = ?
     WHERE folder_path = ? AND missing = 0 AND (art_source IS NULL OR art_source = 'file')`,
  );
  for (const { folder_path: folderPath } of artFolders) {
    throwIfAborted(signal);
    const beside = await resolveFolderArt(folderPath);
    const current = db
      .prepare(
        `SELECT art_key FROM tracks
         WHERE folder_path = ? AND missing = 0 AND (art_source IS NULL OR art_source = 'file')
         LIMIT 1`,
      )
      .get(folderPath);
    const nextKey = beside?.key ?? null;
    if ((current?.art_key ?? null) === nextKey) continue;
    setArt.run(beside ? 'file' : null, nextKey, beside?.relPath ?? null, folderPath);
    report.artUpdated += 1;
  }

  // ---- playlists -----------------------------------------------------------
  const playlists = await library.syncPlaylistsFromDisk();
  report.playlists = playlists.playlists;

  onProgress({ phase: 'done', processed: total, total, current: null });
  return report;
}

/** Forget index rows whose files are gone. Never touches anything on disk. */
export function pruneMissing(library) {
  const rows = library.db.prepare('SELECT id, art_key FROM tracks WHERE missing = 1').all();
  library.db.transaction(() => {
    for (const row of rows) {
      library.db
        .prepare('UPDATE folders SET cover_track_id = NULL WHERE cover_track_id = ?')
        .run(row.id);
      library.db.prepare('DELETE FROM tracks WHERE id = ?').run(row.id);
    }
  })();
  return { pruned: rows.length };
}

/**
 * Re-hash every indexed file and report what no longer matches.
 *
 * An archive drive is the one place silent corruption actually matters, and
 * the index already stores a hash per file — so verifying is nearly free to
 * offer and is the difference between having a backup and hoping you do. A
 * FLAC that has quietly lost a block will still play right up to the damage,
 * which is exactly why you want to hear about it before your only copy is the
 * broken one.
 */
export async function verifyLibrary(library, { onProgress = () => {}, signal, concurrency = 4 } = {}) {
  const rows = library.db
    .prepare('SELECT id, rel_path, hash, size FROM tracks WHERE missing = 0 ORDER BY rel_path')
    .all();
  const report = { checked: 0, ok: 0, changed: [], missing: [], unreadable: [] };
  let processed = 0;

  await mapPool(rows, concurrency, async (row) => {
    throwIfAborted(signal);
    const abs = safeJoin(library.path, row.rel_path);
    try {
      const stat = await fsp.stat(abs);
      const hash = await hashFile(abs);
      if (hash === row.hash) report.ok += 1;
      else report.changed.push({ id: row.id, path: row.rel_path, was: row.size, now: stat.size });
    } catch (err) {
      if (err.cancelled) throw err;
      if (err.code === 'ENOENT') report.missing.push({ id: row.id, path: row.rel_path });
      else report.unreadable.push({ id: row.id, path: row.rel_path, error: err.code ?? 'error' });
    }
    report.checked += 1;
    processed += 1;
    onProgress({ phase: 'verifying', processed, total: rows.length, current: row.rel_path });
  });

  return report;
}
