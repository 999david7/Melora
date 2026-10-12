import fsp from 'node:fs/promises';
import path from 'node:path';
import { dropArt } from './art.js';
import { openDatabase, trashDir } from './db.js';
import { assertValidName, baseName, parentOf, relFrom, safeJoin, toPosix } from './paths.js';
import { listPlaylistFiles, playlistRelPath, readPlaylistFile, writePlaylistFile } from './playlists.js';

/**
 * Query and mutation layer over one mounted library.
 *
 * An instance is only ever alive while the drive is plugged in. The server
 * creates one on `mounted` and closes it on `unmounted`, so there is no way to
 * read a track, a title or a count through a stale handle after the SSD is
 * pulled.
 */

/** Escape LIKE wildcards in user input; pair with `ESCAPE '\'` in the SQL. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * SQL fragment matching a folder and everything beneath it. The root ('')
 * matches every track, which saves a pointless `LIKE '%'` scan.
 */
function subtree(relPath, column = 'folder_path') {
  if (relPath === '') return { sql: '1 = 1', params: [] };
  return {
    sql: `(${column} = ? OR ${column} LIKE ? ESCAPE '\\')`,
    params: [relPath, `${escapeLike(relPath)}/%`],
  };
}

/** The order tracks are listed in. `album_asc` is the library's natural order. */
const SORTS = {
  // Untagged files sink to the bottom rather than opening the library, where
  // SQLite would otherwise sort their NULL artist ahead of everything.
  album_asc:
    `COALESCE(album_artist, artist) IS NULL ASC,
     COALESCE(album_artist, artist) COLLATE NOCASE ASC, album COLLATE NOCASE ASC,
     COALESCE(disc_no, 1) ASC, COALESCE(track_no, 9999) ASC, filename COLLATE NOCASE ASC`,
  title_asc: 'title COLLATE NOCASE ASC, artist COLLATE NOCASE ASC',
  title_desc: 'title COLLATE NOCASE DESC',
  artist_asc:
    `artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC,
     COALESCE(disc_no, 1) ASC, COALESCE(track_no, 9999) ASC`,
  added_desc: 'indexed_at DESC, id DESC',
  plays_desc: 'play_count DESC, last_played DESC, title COLLATE NOCASE ASC',
  recent_desc: 'last_played IS NULL ASC, last_played DESC, title COLLATE NOCASE ASC',
  duration_desc: 'duration DESC NULLS LAST',
  path_asc: 'rel_path COLLATE NOCASE ASC',
};

/** Columns the interface needs for a track row. Never `SELECT *` over the wire. */
const TRACK_FIELDS = [
  'id', 'rel_path', 'folder_path', 'filename', 'ext', 'size', 'hash', 'title', 'artist',
  'album_artist', 'album', 'album_key', 'track_no', 'disc_no', 'year', 'genre', 'duration',
  'bitrate', 'sample_rate', 'channels', 'lossless', 'codec', 'art_source', 'art_key', 'note',
  'favorite', 'play_count', 'last_played', 'state',
];
const TRACK_COLUMNS = TRACK_FIELDS.join(', ');

/**
 * The same list qualified with a table alias, for the joined playlist query
 * where `rel_path` exists on both sides and an unqualified name is ambiguous.
 */
function trackColumns(alias) {
  return TRACK_FIELDS.map((field) => `${alias}.${field}`).join(', ');
}

export class Library {
  constructor(libraryPath, marker) {
    this.path = libraryPath;
    this.marker = marker;
    this.db = openDatabase(libraryPath);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // Already closed, or the drive vanished mid-flight. Nothing to salvage.
    }
  }

  /** Absolute path of a track, guaranteed to sit inside the library. */
  absPathOf(track) {
    return safeJoin(this.path, track.rel_path);
  }

  // ---------------------------------------------------------------- folders

  getFolder(relPath) {
    return this.db.prepare('SELECT * FROM folders WHERE rel_path = ?').get(relPath) ?? null;
  }

  /**
   * The whole folder tree in three queries: the folders, a per-folder track
   * count, and a per-folder track carrying cover art. Counts and cover
   * fallbacks are then rolled up through the tree in JavaScript, which beats
   * issuing a recursive query per folder for a structure that is only ever a
   * few hundred nodes.
   */
  folderTree() {
    const rows = this.db.prepare('SELECT * FROM folders ORDER BY rel_path').all();

    const counts = new Map();
    for (const row of this.db
      .prepare(
        `SELECT folder_path, COUNT(*) AS n, SUM(size) AS bytes, SUM(COALESCE(duration, 0)) AS seconds
         FROM tracks WHERE missing = 0 GROUP BY folder_path`,
      )
      .all()) {
      counts.set(row.folder_path, { n: row.n, bytes: row.bytes ?? 0, seconds: row.seconds ?? 0 });
    }

    // SQLite's bare-column rule: with exactly one min() aggregate, the other
    // selected columns come from the row that produced the minimum. The first
    // track alphabetically is a stable, boring choice — which is what you want
    // from a fallback cover.
    const arted = new Map();
    for (const row of this.db
      .prepare(
        `SELECT folder_path, id, MIN(rel_path) AS rel_path
         FROM tracks WHERE missing = 0 AND art_key IS NOT NULL GROUP BY folder_path`,
      )
      .all()) {
      arted.set(row.folder_path, { id: row.id, sortKey: row.rel_path });
    }

    const nodes = new Map();
    for (const row of rows) {
      const own = counts.get(row.rel_path) ?? { n: 0, bytes: 0, seconds: 0 };
      nodes.set(row.rel_path, {
        path: row.rel_path,
        parent: row.parent_path,
        name: row.rel_path === '' ? 'All music' : row.name,
        description: row.description ?? null,
        coverTrackId: row.cover_track_id ?? null,
        directCount: own.n,
        count: 0,
        bytes: 0,
        seconds: 0,
        children: [],
        // Bubbled up below so a folder holding only subfolders still shows a
        // cover from the albums inside it.
        _fallback: arted.get(row.rel_path) ?? null,
      });
    }

    for (const node of nodes.values()) {
      if (node.parent === null) continue;
      nodes.get(node.parent)?.children.push(node);
    }

    // Deepest-first so a child is always finished before its parent reads it.
    // The root is depth 0; ''.split('/') would otherwise report 1 and tie with
    // the top-level folders it needs to sum.
    const depth = (relPath) => (relPath === '' ? 0 : relPath.split('/').length);
    const ordered = [...nodes.values()].sort((a, b) => depth(b.path) - depth(a.path));
    for (const node of ordered) {
      const own = counts.get(node.path) ?? { n: 0, bytes: 0, seconds: 0 };
      node.count = own.n;
      node.bytes = own.bytes;
      node.seconds = own.seconds;
      for (const child of node.children) {
        node.count += child.count;
        node.bytes += child.bytes;
        node.seconds += child.seconds;
        if (child._fallback && (!node._fallback || child._fallback.sortKey < node._fallback.sortKey)) {
          node._fallback = child._fallback;
        }
      }
      node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }

    // Resolve each folder's cover: the explicit choice when it still points at
    // a track that has art, otherwise any cover from inside.
    const validCover = this.db.prepare(
      'SELECT id FROM tracks WHERE id = ? AND missing = 0 AND art_key IS NOT NULL',
    );
    for (const node of nodes.values()) {
      let cover = null;
      if (node.coverTrackId && validCover.get(node.coverTrackId)) {
        cover = { id: node.coverTrackId, explicit: true };
      } else if (node._fallback) {
        cover = { id: node._fallback.id, explicit: false };
      }
      node.cover = cover;
      delete node._fallback;
      delete node.parent;
    }

    return nodes.get('') ?? null;
  }

  /** Register a directory that exists on disk. Idempotent; used by the scanner. */
  ensureFolderRow(relPath) {
    if (relPath === '') return;
    const parent = parentOf(relPath);
    if (parent !== null && parent !== '') this.ensureFolderRow(parent);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO folders (rel_path, parent_path, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(rel_path) DO NOTHING`,
      )
      .run(relPath, parent, baseName(relPath), now, now);
  }

  async createFolder(parentPath, rawName) {
    const name = assertValidName(rawName);
    const parent = this.getFolder(parentPath);
    if (!parent) throw Object.assign(new Error('parent folder not found'), { status: 404 });

    const relPath = parentPath === '' ? name : `${parentPath}/${name}`;
    const abs = safeJoin(this.path, relPath);
    if (await fsp.stat(abs).catch(() => null)) {
      throw Object.assign(new Error(`"${name}" already exists here`), { status: 409 });
    }
    await fsp.mkdir(abs, { recursive: false });
    this.ensureFolderRow(relPath);
    return this.getFolder(relPath);
  }

  /**
   * Rename the directory on disk and repoint every index row beneath it.
   * Folders are real directories, so this has to move actual bytes' worth of
   * paths — but a rename within one filesystem is atomic and instant.
   */
  async renameFolder(relPath, rawName) {
    if (relPath === '') throw Object.assign(new Error('the library root cannot be renamed'), { status: 400 });
    const name = assertValidName(rawName);
    const folder = this.getFolder(relPath);
    if (!folder) throw Object.assign(new Error('folder not found'), { status: 404 });
    if (name === folder.name) return folder;

    const parent = parentOf(relPath);
    const nextPath = parent === '' ? name : `${parent}/${name}`;
    const from = safeJoin(this.path, relPath);
    const to = safeJoin(this.path, nextPath);

    if (await fsp.stat(to).catch(() => null)) {
      throw Object.assign(new Error(`"${name}" already exists here`), { status: 409 });
    }
    await fsp.rename(from, to);

    const prefix = `${relPath}/`;
    const nextPrefix = `${nextPath}/`;
    const now = Date.now();

    // Playlist files spell out where their tracks live, so any playlist
    // reaching into this folder has to be rewritten as well — otherwise the
    // next scan reads the old paths back out of the file and every one of
    // those entries goes missing.
    const affected = this.db
      .prepare(
        `SELECT DISTINCT playlist_id FROM playlist_items WHERE rel_path LIKE ? ESCAPE '\\'`,
      )
      .all(`${escapeLike(relPath)}/%`)
      .map((row) => row.playlist_id);

    this.db.transaction(() => {
      this.db
        .prepare('UPDATE folders SET rel_path = ?, name = ?, updated_at = ? WHERE rel_path = ?')
        .run(nextPath, name, now, relPath);
      this.db
        .prepare(
          `UPDATE folders
           SET rel_path    = ? || substr(rel_path, ?),
               parent_path = ? || substr(parent_path, ?)
           WHERE rel_path LIKE ? ESCAPE '\\'`,
        )
        .run(nextPrefix, prefix.length + 1, nextPrefix, prefix.length + 1, `${escapeLike(relPath)}/%`);
      this.db
        .prepare('UPDATE folders SET parent_path = ? WHERE parent_path = ?')
        .run(nextPath, relPath);
      this.db
        .prepare(
          `UPDATE tracks
           SET rel_path    = ? || substr(rel_path, ?),
               folder_path = CASE WHEN folder_path = ?
                                  THEN ?
                                  ELSE ? || substr(folder_path, ?) END
           WHERE rel_path LIKE ? ESCAPE '\\'`,
        )
        .run(
          nextPrefix, prefix.length + 1,
          relPath, nextPath,
          nextPrefix, prefix.length + 1,
          `${escapeLike(relPath)}/%`,
        );
      // Playlist entries address tracks by path, so they have to follow too or
      // every playlist touching this folder would go missing at once.
      this.db
        .prepare(
          `UPDATE playlist_items SET rel_path = ? || substr(rel_path, ?)
           WHERE rel_path LIKE ? ESCAPE '\\'`,
        )
        .run(nextPrefix, prefix.length + 1, `${escapeLike(relPath)}/%`);
      // Relink now that the paths have moved, so the rewrite below emits
      // entries that resolve.
      this.db
        .prepare(
          `UPDATE playlist_items
           SET track_id = (SELECT id FROM tracks WHERE tracks.rel_path = playlist_items.rel_path AND missing = 0)
           WHERE playlist_id IN (SELECT id FROM playlists)`,
        )
        .run();
    })();

    for (const playlistId of affected) {
      await this.flushPlaylist(playlistId);
    }
    return this.getFolder(nextPath);
  }

  /** Set a folder's description or its cover track. */
  updateFolder(relPath, { description, coverTrackId }) {
    const folder = this.getFolder(relPath);
    if (!folder) throw Object.assign(new Error('folder not found'), { status: 404 });

    if (coverTrackId !== undefined && coverTrackId !== null) {
      const track = this.getTrack(coverTrackId);
      if (!track) throw Object.assign(new Error('cover track not found'), { status: 404 });
      // A cover must come from inside the folder, otherwise the tile lies about
      // what you are about to open.
      const inside =
        relPath === '' || track.folder_path === relPath || track.folder_path.startsWith(`${relPath}/`);
      if (!inside) {
        throw Object.assign(
          new Error('a cover must come from a track in that folder or one inside it'),
          { status: 400 },
        );
      }
    }

    const fields = [];
    const params = [];
    if (description !== undefined) {
      fields.push('description = ?');
      params.push(description === null || description === '' ? null : String(description).slice(0, 2000));
    }
    if (coverTrackId !== undefined) {
      fields.push('cover_track_id = ?');
      params.push(coverTrackId === null ? null : Number(coverTrackId));
    }
    if (fields.length === 0) return folder;

    fields.push('updated_at = ?');
    params.push(Date.now(), relPath);
    this.db.prepare(`UPDATE folders SET ${fields.join(', ')} WHERE rel_path = ?`).run(...params);
    return this.getFolder(relPath);
  }

  // ----------------------------------------------------------------- tracks

  getTrack(id) {
    return this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(Number(id)) ?? null;
  }

  listTracks({
    folder = '',
    recursive = false,
    q = '',
    favorite = false,
    album = null,
    artist = null,
    genre = null,
    sort = 'album_asc',
    limit = 200,
    offset = 0,
  } = {}) {
    const where = ['missing = 0'];
    const params = [];

    if (folder !== null) {
      if (recursive) {
        const scope = subtree(folder);
        where.push(scope.sql);
        params.push(...scope.params);
      } else {
        where.push('folder_path = ?');
        params.push(folder);
      }
    }
    if (favorite) where.push('favorite = 1');
    if (album) {
      where.push('album_key = ?');
      params.push(String(album));
    }
    if (artist) {
      // Either credit counts as "by this artist": an album artist browsing the
      // record, a track artist browsing the song.
      where.push('(artist = ? COLLATE NOCASE OR album_artist = ? COLLATE NOCASE)');
      params.push(String(artist), String(artist));
    }
    if (genre) {
      where.push('genre = ? COLLATE NOCASE');
      params.push(String(genre));
    }
    if (q) {
      const needle = `%${escapeLike(q.toLowerCase())}%`;
      where.push(
        `(LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(artist, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(album_artist, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(album, '')) LIKE ? ESCAPE '\\'
          OR LOWER(filename) LIKE ? ESCAPE '\\'
          OR LOWER(folder_path) LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle, needle, needle, needle);
    }

    const orderBy = SORTS[sort] ?? SORTS.album_asc;
    const clause = where.join(' AND ');
    const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const skip = Math.max(Number(offset) || 0, 0);

    const items = this.db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, capped, skip);

    const { total, seconds } = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(duration), 0) AS seconds
         FROM tracks WHERE ${clause}`,
      )
      .get(...params);

    return { items, total, seconds, limit: capped, offset: skip };
  }

  /**
   * Editable fields.
   *
   * Deliberately short: a note and a favourite, both index-only. Melora never
   * writes to your audio files, so the title you see is the title your file
   * carries — an override stored here would quietly disagree with every other
   * player you own, and with the file you would still have if this program
   * disappeared. Fix a wrong tag in a tag editor and rescan.
   */
  updateTrack(id, { note, favorite }) {
    const track = this.getTrack(id);
    if (!track) throw Object.assign(new Error('track not found'), { status: 404 });

    const fields = [];
    const params = [];
    if (note !== undefined) {
      fields.push('note = ?');
      params.push(note === null || note === '' ? null : String(note).slice(0, 4000));
    }
    if (favorite !== undefined) {
      fields.push('favorite = ?');
      params.push(favorite ? 1 : 0);
    }
    if (fields.length === 0) return track;

    params.push(Number(id));
    this.db.prepare(`UPDATE tracks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getTrack(id);
  }

  /** Count a play. The only thing Melora records about your listening. */
  markPlayed(id) {
    const track = this.getTrack(id);
    if (!track) throw Object.assign(new Error('track not found'), { status: 404 });
    this.db
      .prepare('UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?')
      .run(Date.now(), Number(id));
    return this.getTrack(id);
  }

  /**
   * Tracks that sound like they belong after `id`, best first, for autoplay
   * once a queue runs out.
   *
   * The match is made from what the index already knows — tags, and the
   * playlists you put both tracks in — so it works offline and tells no one
   * what you listen to. The same artist counts most, then a shared genre or
   * playlist, then era, album and folder. A little randomness on top keeps a
   * long evening from settling into one record on a loop.
   *
   * `exclude` is what has already played. When it covers every playable
   * track, the library starts over rather than falling silent.
   */
  similarTracks(id, { exclude = [], limit = 1 } = {}) {
    const seed = this.getTrack(id);
    if (!seed) throw Object.assign(new Error('track not found'), { status: 404 });

    const credits = [seed.artist, seed.album_artist].filter(Boolean).map((name) => name.toLowerCase());
    const capped = Math.min(Math.max(Number(limit) || 1, 1), 50);
    const score = `
      (CASE WHEN LOWER(artist) IN (SELECT value FROM json_each(@credits))
              OR LOWER(album_artist) IN (SELECT value FROM json_each(@credits)) THEN 4 ELSE 0 END)
      + (CASE WHEN genre = @genre COLLATE NOCASE THEN 3 ELSE 0 END)
      + (CASE WHEN id IN (SELECT track_id FROM playlist_items WHERE playlist_id IN
              (SELECT playlist_id FROM playlist_items WHERE track_id = @seed)) THEN 2 ELSE 0 END)
      + (CASE WHEN year IS NULL OR @year IS NULL THEN 0
              WHEN ABS(year - @year) <= 3 THEN 2
              WHEN ABS(year - @year) <= 8 THEN 1 ELSE 0 END)
      + (CASE WHEN album_key = @album THEN 1 ELSE 0 END)
      + (CASE WHEN folder_path = @folder THEN 1 ELSE 0 END)
      + favorite`;
    const query = this.db.prepare(
      `SELECT ${TRACK_COLUMNS} FROM tracks
       WHERE missing = 0 AND state = 'ready' AND id <> @seed
         AND id NOT IN (SELECT value FROM json_each(@exclude))
       ORDER BY ${score} + (ABS(RANDOM()) % 1000) / 400.0 DESC
       LIMIT @limit`,
    );
    const params = {
      seed: seed.id,
      credits: JSON.stringify(credits),
      genre: seed.genre,
      year: seed.year,
      album: seed.album_key,
      folder: seed.folder_path,
      limit: capped,
    };
    const ids = [...new Set(exclude.map(Number).filter(Number.isInteger))];
    const items = query.all({ ...params, exclude: JSON.stringify(ids) });
    return { items: items.length ? items : query.all({ ...params, exclude: '[]' }) };
  }

  /**
   * Remove a track from the library.
   *
   * The file is moved into `.melora/trash/`, never unlinked. Melora is pointed
   * at collections that took years to assemble and often at the only copy of a
   * rip; a bug or a misclick here has to be recoverable, and "it is still on
   * the drive, in a folder called trash" is a guarantee anyone can verify
   * without trusting the code.
   */
  async deleteTrack(id) {
    const track = this.getTrack(id);
    if (!track) throw Object.assign(new Error('track not found'), { status: 404 });

    const from = this.absPathOf(track);
    const stamp = new Date().toISOString().slice(0, 10);
    const destDir = path.join(trashDir(this.path), stamp, path.dirname(track.rel_path));
    await fsp.mkdir(destDir, { recursive: true });

    let dest = path.join(destDir, track.filename);
    for (let n = 1; await fsp.stat(dest).then(() => true, () => false); n += 1) {
      const ext = path.extname(track.filename);
      dest = path.join(destDir, `${path.basename(track.filename, ext)}-${n}${ext}`);
    }

    try {
      await fsp.rename(from, dest);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Already gone from disk; drop the row and call it done.
    }

    this.db.prepare('UPDATE folders SET cover_track_id = NULL WHERE cover_track_id = ?').run(track.id);
    this.db.prepare('DELETE FROM tracks WHERE id = ?').run(track.id);

    // Only discard the rendered cover once nothing else uses that art. Art is
    // shared across a whole album, so this is usually a no-op.
    if (track.art_key) {
      const stillUsed = this.db.prepare('SELECT 1 FROM tracks WHERE art_key = ? LIMIT 1').get(track.art_key);
      if (!stillUsed) await dropArt(this.path, track.art_key);
    }

    return { id: track.id, movedTo: toPosix(relFrom(this.path, dest)) };
  }

  // ----------------------------------------------------------------- albums

  /**
   * One row per album, with the cover, the year and the running time.
   *
   * `MIN(...)` picks the cover track deterministically under SQLite's bare
   * column rule, so an album does not change its face between two page loads.
   */
  listAlbums({ q = '', artist = null, sort = 'artist_asc', limit = 200, offset = 0 } = {}) {
    const where = ['missing = 0'];
    const params = [];

    if (artist) {
      where.push('(artist = ? COLLATE NOCASE OR album_artist = ? COLLATE NOCASE)');
      params.push(String(artist), String(artist));
    }
    if (q) {
      const needle = `%${escapeLike(q.toLowerCase())}%`;
      where.push(
        `(LOWER(COALESCE(album, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(album_artist, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(artist, '')) LIKE ? ESCAPE '\\')`,
      );
      params.push(needle, needle, needle);
    }

    const order = {
      artist_asc: 'artist COLLATE NOCASE ASC, year ASC, title COLLATE NOCASE ASC',
      title_asc: 'title COLLATE NOCASE ASC',
      year_desc: 'year IS NULL ASC, year DESC, artist COLLATE NOCASE ASC',
      added_desc: 'added DESC',
    }[sort] ?? 'artist COLLATE NOCASE ASC, year ASC, title COLLATE NOCASE ASC';

    const capped = Math.min(Math.max(Number(limit) || 200, 1), 500);
    const skip = Math.max(Number(offset) || 0, 0);
    const clause = where.join(' AND ');

    const items = this.db
      .prepare(
        `SELECT album_key                                   AS key,
                COALESCE(MAX(album), '')                    AS title,
                COALESCE(MAX(album_artist), MAX(artist), '') AS artist,
                MAX(year)                                   AS year,
                COUNT(*)                                    AS count,
                SUM(COALESCE(duration, 0))                  AS seconds,
                SUM(size)                                   AS bytes,
                MAX(indexed_at)                             AS added,
                MAX(folder_path)                            AS folder_path,
                MIN(CASE WHEN art_key IS NOT NULL THEN id END) AS cover_track_id
         FROM tracks WHERE ${clause}
         GROUP BY album_key ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, capped, skip);

    const { total } = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM (SELECT 1 FROM tracks WHERE ${clause} GROUP BY album_key)`,
      )
      .get(...params);

    return { items: items.map(withAlbumTitle), total, limit: capped, offset: skip };
  }

  getAlbum(key) {
    const row = this.db
      .prepare(
        `SELECT album_key                                   AS key,
                COALESCE(MAX(album), '')                    AS title,
                COALESCE(MAX(album_artist), MAX(artist), '') AS artist,
                MAX(year)                                   AS year,
                MAX(genre)                                  AS genre,
                COUNT(*)                                    AS count,
                SUM(COALESCE(duration, 0))                  AS seconds,
                SUM(size)                                   AS bytes,
                MAX(folder_path)                            AS folder_path,
                MIN(CASE WHEN art_key IS NOT NULL THEN id END) AS cover_track_id
         FROM tracks WHERE missing = 0 AND album_key = ? GROUP BY album_key`,
      )
      .get(String(key));
    if (!row || row.count === 0) return null;

    const tracks = this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks
         WHERE missing = 0 AND album_key = ?
         ORDER BY COALESCE(disc_no, 1) ASC, COALESCE(track_no, 9999) ASC, filename COLLATE NOCASE ASC`,
      )
      .all(String(key));

    return { album: withAlbumTitle(row), tracks };
  }

  // ---------------------------------------------------------------- artists

  listArtists({ q = '' } = {}) {
    const where = ['missing = 0'];
    const params = [];
    if (q) {
      const needle = `%${escapeLike(q.toLowerCase())}%`;
      where.push(`LOWER(COALESCE(album_artist, artist, '')) LIKE ? ESCAPE '\\'`);
      params.push(needle);
    }
    return this.db
      .prepare(
        `SELECT COALESCE(album_artist, artist) AS name,
                COUNT(*)                       AS count,
                COUNT(DISTINCT album_key)      AS albums,
                SUM(COALESCE(duration, 0))     AS seconds,
                MIN(CASE WHEN art_key IS NOT NULL THEN id END) AS cover_track_id
         FROM tracks WHERE ${where.join(' AND ')} AND COALESCE(album_artist, artist) IS NOT NULL
         GROUP BY name COLLATE NOCASE ORDER BY name COLLATE NOCASE ASC`,
      )
      .all(...params);
  }

  // -------------------------------------------------------------- playlists

  listPlaylists() {
    return this.db
      .prepare(
        `SELECT p.id, p.rel_path, p.name, p.description, p.updated_at,
                COUNT(i.rel_path)                     AS count,
                COALESCE(SUM(t.duration), 0)          AS seconds,
                SUM(CASE WHEN i.rel_path IS NOT NULL AND t.id IS NULL THEN 1 ELSE 0 END) AS missing
         FROM playlists p
         LEFT JOIN playlist_items i ON i.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = i.track_id AND t.missing = 0
         GROUP BY p.id ORDER BY p.name COLLATE NOCASE ASC`,
      )
      .all();
  }

  getPlaylist(id) {
    const playlist = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
    if (!playlist) return null;
    // A row whose file has gone missing keeps its place in the list rather
    // than silently vanishing, so you can see what needs fixing.
    const tracks = this.db
      .prepare(
        `SELECT i.position, i.rel_path AS entry_path, ${trackColumns('t')}
         FROM playlist_items i LEFT JOIN tracks t ON t.id = i.track_id AND t.missing = 0
         WHERE i.playlist_id = ? ORDER BY i.position ASC`,
      )
      .all(Number(id));
    return { playlist, tracks };
  }

  /**
   * Replace a playlist's contents in the index, keeping the given order.
   *
   * An entry with no live track behind it keeps its path and gets a null id:
   * that is how a playlist referring to a file that has gone stays visible and
   * repairable instead of quietly shrinking.
   */
  setPlaylistRows(playlistId, relPaths) {
    const lookup = this.db.prepare('SELECT id FROM tracks WHERE rel_path = ? AND missing = 0');
    const insert = this.db.prepare(
      'INSERT INTO playlist_items (playlist_id, position, rel_path, track_id) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId);
      relPaths.forEach((relPath, index) => {
        insert.run(playlistId, index, relPath, lookup.get(relPath)?.id ?? null);
      });
      this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
    })();
  }

  async createPlaylist(rawName, { description = null } = {}) {
    const name = assertValidName(rawName);
    const relPath = playlistRelPath(name);
    if (this.db.prepare('SELECT 1 FROM playlists WHERE rel_path = ?').get(relPath)) {
      throw Object.assign(new Error(`a playlist called "${name}" already exists`), { status: 409 });
    }
    await writePlaylistFile(this.path, relPath, { name, description, tracks: [] });

    const now = Date.now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO playlists (rel_path, name, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(relPath, name, description, now, now);
    return this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(lastInsertRowid);
  }

  /** Rewrite the playlist file from the index rows. The file stays canonical. */
  async flushPlaylist(id) {
    const found = this.getPlaylist(id);
    if (!found) throw Object.assign(new Error('playlist not found'), { status: 404 });
    const tracks = found.tracks.map((row) => ({
      rel_path: row.rel_path ?? row.entry_path,
      duration: row.duration,
      artist: row.artist,
      title: row.title,
      filename: row.filename,
    }));
    await writePlaylistFile(this.path, found.playlist.rel_path, {
      name: found.playlist.name,
      description: found.playlist.description,
      tracks,
    });
    return found.playlist;
  }

  async setPlaylistTracks(id, trackIds) {
    const playlist = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
    if (!playlist) throw Object.assign(new Error('playlist not found'), { status: 404 });

    const relPaths = [];
    for (const trackId of trackIds) {
      const track = this.getTrack(trackId);
      if (track) relPaths.push(track.rel_path);
    }
    this.setPlaylistRows(playlist.id, relPaths);
    await this.flushPlaylist(playlist.id);
    return this.getPlaylist(playlist.id);
  }

  async addToPlaylist(id, trackIds) {
    const found = this.getPlaylist(id);
    if (!found) throw Object.assign(new Error('playlist not found'), { status: 404 });
    const existing = found.tracks.map((row) => row.entry_path);
    const added = [];
    for (const trackId of trackIds) {
      const track = this.getTrack(trackId);
      if (track) added.push(track.rel_path);
    }
    this.setPlaylistRows(found.playlist.id, [...existing, ...added]);
    await this.flushPlaylist(found.playlist.id);
    return { added: added.length, playlist: this.getPlaylist(found.playlist.id) };
  }

  async renamePlaylist(id, rawName, { description } = {}) {
    const playlist = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
    if (!playlist) throw Object.assign(new Error('playlist not found'), { status: 404 });

    let relPath = playlist.rel_path;
    let name = playlist.name;
    if (rawName !== undefined && rawName !== null && String(rawName).trim() !== playlist.name) {
      name = assertValidName(rawName);
      relPath = playlistRelPath(name);
      if (relPath !== playlist.rel_path) {
        const to = safeJoin(this.path, relPath);
        if (await fsp.stat(to).catch(() => null)) {
          throw Object.assign(new Error(`a playlist called "${name}" already exists`), { status: 409 });
        }
        await fsp.rename(safeJoin(this.path, playlist.rel_path), to).catch(async (err) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
    }
    const nextDescription =
      description === undefined
        ? playlist.description
        : description === null || description === ''
          ? null
          : String(description).slice(0, 2000);

    this.db
      .prepare('UPDATE playlists SET rel_path = ?, name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(relPath, name, nextDescription, Date.now(), playlist.id);
    await this.flushPlaylist(playlist.id);
    return this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlist.id);
  }

  /** Delete a playlist. The `.m3u8` goes to the trash, like anything else. */
  async deletePlaylist(id) {
    const playlist = this.db.prepare('SELECT * FROM playlists WHERE id = ?').get(Number(id));
    if (!playlist) throw Object.assign(new Error('playlist not found'), { status: 404 });

    const stamp = new Date().toISOString().slice(0, 10);
    const destDir = path.join(trashDir(this.path), stamp, path.dirname(playlist.rel_path));
    await fsp.mkdir(destDir, { recursive: true });
    await fsp
      .rename(safeJoin(this.path, playlist.rel_path), path.join(destDir, path.basename(playlist.rel_path)))
      .catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });

    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(playlist.id);
    return { id: playlist.id };
  }

  /**
   * Reconcile the playlist tables with the `.m3u8` files on the drive. Called
   * by the scanner, so a playlist edited in another program — or copied onto
   * the drive from somewhere else — turns up here.
   */
  async syncPlaylistsFromDisk() {
    const files = await listPlaylistFiles(this.path);
    const report = { playlists: 0, entries: 0, removed: 0 };
    const seen = new Set();

    for (const relPath of files) {
      let parsed;
      try {
        parsed = await readPlaylistFile(this.path, relPath);
      } catch {
        continue; // Unreadable file; leave whatever the index already had.
      }
      seen.add(relPath);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO playlists (rel_path, name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(rel_path) DO UPDATE SET
             name = excluded.name, description = excluded.description, updated_at = excluded.updated_at`,
        )
        .run(relPath, parsed.name, parsed.description, now, now);
      const { id } = this.db.prepare('SELECT id FROM playlists WHERE rel_path = ?').get(relPath);
      this.setPlaylistRows(id, parsed.entries);
      report.playlists += 1;
      report.entries += parsed.entries.length;
    }

    for (const row of this.db.prepare('SELECT id, rel_path FROM playlists').all()) {
      if (seen.has(row.rel_path)) continue;
      this.db.prepare('DELETE FROM playlists WHERE id = ?').run(row.id);
      report.removed += 1;
    }
    return report;
  }

  // ------------------------------------------------------------------ stats

  stats() {
    const tracks = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(size), 0) AS bytes,
                COALESCE(SUM(duration), 0) AS seconds,
                COALESCE(SUM(favorite), 0) AS favorites,
                COALESCE(SUM(state = 'unplayable'), 0) AS unplayable,
                COUNT(DISTINCT album_key) AS albums
         FROM tracks WHERE missing = 0`,
      )
      .get();
    const { artists } = this.db
      .prepare(
        `SELECT COUNT(*) AS artists FROM (
           SELECT COALESCE(album_artist, artist) AS name FROM tracks
           WHERE missing = 0 AND COALESCE(album_artist, artist) IS NOT NULL
           GROUP BY name COLLATE NOCASE)`,
      )
      .get();
    const { folders } = this.db
      .prepare("SELECT COUNT(*) AS folders FROM folders WHERE rel_path <> ''")
      .get();
    const { playlists } = this.db.prepare('SELECT COUNT(*) AS playlists FROM playlists').get();
    const { missing } = this.db.prepare('SELECT COUNT(*) AS missing FROM tracks WHERE missing = 1').get();
    return { ...tracks, artists, folders, playlists, missing };
  }
}

/** Albums keyed on their folder have no album tag; name them after the folder. */
function withAlbumTitle(row) {
  if (row.title) return row;
  const folder = String(row.folder_path ?? '');
  const name = folder ? baseName(folder) : '';
  return { ...row, title: name || 'Unknown album', untagged: true };
}
