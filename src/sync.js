import fsp from 'node:fs/promises';
import path from 'node:path';
import { findFolderArt, hashFile, isAudioFile, isPlayable, readTags } from './audio.js';
import { assertValidName, contains, safeJoin, sanitiseSegment, toPosix } from './paths.js';
import { throwIfAborted } from './util.js';

/**
 * Importing from the computer into the library on the SSD.
 *
 * Three rules this module does not bend:
 *
 *   1. Sources are read-only. Nothing here opens a source file for writing,
 *      renames it, or deletes it. "Sync" means copy-in; if you want the
 *      downloads folder cleared out afterwards, you do that yourself, once you
 *      can see the tracks in the library.
 *   2. Identity is the content hash, so importing the same folder twice, or
 *      two folders that overlap, cannot produce duplicates.
 *   3. Every copy is verified by re-reading what landed on the drive. A silent
 *      truncation during a copy to removable media is exactly the failure this
 *      whole project exists to protect against.
 */

const ORGANISE = new Set(['artist', 'mirror', 'flat']);

export function normaliseSource(source) {
  if (!source || typeof source.path !== 'string' || !source.path.trim()) {
    throw Object.assign(new Error('a sync source needs a path'), { status: 400 });
  }
  const organizeBy = source.organizeBy ?? 'artist';
  if (!ORGANISE.has(organizeBy)) {
    throw Object.assign(
      new Error(`organizeBy must be one of: ${[...ORGANISE].join(', ')}`),
      { status: 400 },
    );
  }
  // `into` is a folder name inside the library, not a path, so an import can
  // never be steered outside the drive by a config edit.
  const into = source.into ? assertValidName(source.into) : 'Imported';
  return { path: path.resolve(source.path), into, organizeBy };
}

async function collect(sourceRoot, { signal }) {
  const found = [];
  const queue = [sourceRoot];
  while (queue.length > 0) {
    throwIfAborted(signal);
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        queue.push(full);
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        found.push(full);
      }
    }
  }
  return found.sort();
}

/**
 * Where a track lands in the library.
 *
 * `artist` files by album artist and album, which is the layout every ripper
 * and every other music player already assumes — so the drive stays legible
 * with or without this program. Untagged files land under "Unknown artist"
 * rather than being refused.
 */
function destinationFor({ sourceRoot, absPath, into, organizeBy, tags }) {
  const filename = path.basename(absPath);
  if (organizeBy === 'flat') return `${into}/${filename}`;
  if (organizeBy === 'mirror') return `${into}/${toPosix(path.relative(sourceRoot, absPath))}`;

  const artist = sanitiseSegment(tags?.albumArtist ?? tags?.artist, 'Unknown artist');
  const album = sanitiseSegment(tags?.album, 'Unknown album');
  return `${into}/${artist}/${album}/${filename}`;
}

/** First free name at `relPath`, appending -1, -2, … before the extension. */
async function uniqueDestination(libraryRoot, relPath) {
  const ext = path.posix.extname(relPath);
  const stem = relPath.slice(0, relPath.length - ext.length);
  for (let n = 0; n < 1000; n += 1) {
    const candidate = n === 0 ? relPath : `${stem}-${n}${ext}`;
    const exists = await fsp.stat(safeJoin(libraryRoot, candidate)).then(() => true, () => false);
    if (!exists) return candidate;
  }
  throw new Error(`could not find a free filename for ${relPath}`);
}

/**
 * Copy every new track from the configured sources into the library.
 *
 * `onProgress` receives `{ phase, processed, total, current }`.
 */
export async function syncSources(library, sources, { onProgress = () => {}, signal, verifyCopies = true } = {}) {
  const report = {
    imported: 0, duplicates: 0, skipped: 0, failed: 0, bytes: 0, artwork: 0,
    sources: [], errors: [],
  };
  const normalised = sources.map(normaliseSource);

  onProgress({ phase: 'listing', processed: 0, total: 0, current: null });
  const work = [];
  for (const source of normalised) {
    const stat = await fsp.stat(source.path).catch(() => null);
    if (!stat?.isDirectory()) {
      report.errors.push({ source: source.path, error: 'source folder not found' });
      report.sources.push({ path: source.path, files: 0, imported: 0 });
      continue;
    }
    // Refuse to import a folder that is the library, or sits inside it — that
    // would copy the drive onto itself, forever.
    if (contains(library.path, source.path)) {
      report.errors.push({ source: source.path, error: 'source is inside the library itself' });
      report.sources.push({ path: source.path, files: 0, imported: 0 });
      continue;
    }
    const files = await collect(source.path, { signal });
    work.push({ source, files });
    report.sources.push({ path: source.path, files: files.length, imported: 0 });
  }

  const total = work.reduce((sum, item) => sum + item.files.length, 0);
  let processed = 0;

  const ledgerGet = library.db.prepare('SELECT size, mtime FROM import_ledger WHERE source_path = ?');
  const ledgerPut = library.db.prepare(
    `INSERT INTO import_ledger (source_path, size, mtime, hash, rel_path, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       size = excluded.size, mtime = excluded.mtime, hash = excluded.hash,
       rel_path = excluded.rel_path, imported_at = excluded.imported_at`,
  );
  const byHash = library.db.prepare('SELECT rel_path FROM tracks WHERE hash = ? AND missing = 0 LIMIT 1');
  const insertTrack = library.db.prepare(
    `INSERT INTO tracks (rel_path, folder_path, filename, ext, size, mtime, hash,
                         title, artist, album_artist, album, album_key, track_no, disc_no,
                         year, genre, duration, bitrate, sample_rate, channels, lossless,
                         codec, state, missing, indexed_at)
     VALUES (@relPath, @folderPath, @filename, @ext, @size, @mtime, @hash,
             @title, @artist, @albumArtist, @album, @albumKey, @trackNo, @discNo,
             @year, @genre, @duration, @bitrate, @sampleRate, @channels, @lossless,
             @codec, @state, 0, @indexedAt)
     ON CONFLICT(rel_path) DO NOTHING`,
  );

  // Album art sitting beside the music has to come across too, or every
  // imported album arrives with a blank cover. Copied once per source folder.
  const artDone = new Set();
  const bringArt = async (sourceDir, destDir) => {
    if (artDone.has(`${sourceDir}\0${destDir}`)) return;
    artDone.add(`${sourceDir}\0${destDir}`);
    const art = await findFolderArt(sourceDir);
    if (!art) return;
    const dest = path.join(destDir, path.basename(art));
    if (await fsp.stat(dest).then(() => true, () => false)) return;
    await fsp.copyFile(art, dest).then(
      () => { report.artwork += 1; },
      () => {}, // Artwork is a nicety; a failure here must not fail the import.
    );
  };

  // Sequential on purpose: this is a large streaming copy to removable media,
  // where parallel writes buy nothing and make progress meaningless.
  for (const { source, files } of work) {
    const summary = report.sources.find((entry) => entry.path === source.path);
    for (const absPath of files) {
      throwIfAborted(signal);
      processed += 1;
      onProgress({ phase: 'importing', processed, total, current: path.basename(absPath) });

      try {
        const stat = await fsp.stat(absPath);
        const mtime = Math.round(stat.mtimeMs);

        const seen = ledgerGet.get(absPath);
        if (seen && seen.size === stat.size && seen.mtime === mtime) {
          report.skipped += 1;
          continue;
        }

        const hash = await hashFile(absPath);
        if (byHash.get(hash)) {
          // Already in the library under some path. Record it so the next sync
          // does not have to hash it again.
          ledgerPut.run(absPath, stat.size, mtime, hash, null, Date.now());
          report.duplicates += 1;
          continue;
        }

        const tags = await readTags(absPath);
        const wanted = destinationFor({
          sourceRoot: source.path,
          absPath,
          into: source.into,
          organizeBy: source.organizeBy,
          tags,
        });
        const relPath = await uniqueDestination(library.path, wanted);
        const dest = safeJoin(library.path, relPath);

        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(absPath, dest);
        await fsp.utimes(dest, stat.atime, stat.mtime).catch(() => {});

        if (verifyCopies) {
          const written = await hashFile(dest);
          if (written !== hash) {
            await fsp.rm(dest, { force: true });
            throw new Error('copy did not match the source (drive full, or a bad cable?)');
          }
        }

        const folderPath = path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath);
        library.ensureFolderRow(folderPath);
        insertTrack.run({
          relPath,
          folderPath,
          filename: path.posix.basename(relPath),
          ext: path.extname(relPath).toLowerCase(),
          size: stat.size,
          mtime,
          hash,
          title: tags.title,
          artist: tags.artist,
          albumArtist: tags.albumArtist,
          album: tags.album,
          albumKey: tags.album
            ? tags.albumKey
            : `folder:${folderPath}`, // Re-key untagged files to where they landed.
          trackNo: tags.trackNo,
          discNo: tags.discNo,
          year: tags.year,
          genre: tags.genre,
          duration: tags.duration,
          bitrate: tags.bitrate,
          sampleRate: tags.sampleRate,
          channels: tags.channels,
          lossless: tags.lossless,
          codec: tags.codec,
          state: isPlayable(relPath) ? 'ready' : 'unplayable',
          indexedAt: Date.now(),
        });
        ledgerPut.run(absPath, stat.size, mtime, hash, relPath, Date.now());
        await bringArt(path.dirname(absPath), path.dirname(dest));

        report.imported += 1;
        report.bytes += stat.size;
        if (summary) summary.imported += 1;
      } catch (err) {
        if (err.cancelled) throw err;
        report.failed += 1;
        if (report.errors.length < 50) {
          report.errors.push({ source: absPath, error: err.message });
        }
      }
    }
  }

  onProgress({ phase: 'done', processed: total, total, current: null });
  return report;
}
