import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertValidName, contains, relFrom, safeJoin, toPosix } from './paths.js';
import { formatDuration } from './util.js';
import { PLAYLIST_DIRNAME } from './volume.js';

/**
 * Playlists, as ordinary `.m3u8` files on the drive.
 *
 * The same argument as folders being real folders: a playlist you can only
 * read back through this program is a playlist you lose when the program goes
 * away. These are plain UTF-8 M3U files in `Playlists/`, with paths relative
 * to the playlist itself, which is what VLC, foobar2000, Rockbox, a car
 * stereo and a twenty-year-old iPod all already understand. Copy the drive to
 * a friend and the playlists go with it.
 *
 * The files are the source of truth. The index mirrors them so the interface
 * can query them quickly, and a scan reconciles the two.
 */

export function playlistDir(libraryPath) {
  return path.join(libraryPath, PLAYLIST_DIRNAME);
}

/** The library-relative path of the file backing a playlist of this name. */
export function playlistRelPath(name) {
  return `${PLAYLIST_DIRNAME}/${assertValidName(name)}.m3u8`;
}

/** Every playlist file in the library, as POSIX relative paths. */
export async function listPlaylistFiles(libraryPath) {
  let entries;
  try {
    entries = await fsp.readdir(playlistDir(libraryPath), { withFileTypes: true });
  } catch {
    return []; // No Playlists folder yet: no playlists.
  }
  return entries
    .filter((entry) => entry.isFile() && /\.m3u8?$/i.test(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => `${PLAYLIST_DIRNAME}/${entry.name}`)
    .sort();
}

/**
 * Parse one playlist file.
 *
 * Entries that point outside the library, or at a URL, are dropped rather than
 * followed: a playlist is a list of things in *this* library, and honouring an
 * absolute path from someone else's machine would at best 404 and at worst
 * read a file the lock is supposed to be covering.
 */
export async function readPlaylistFile(libraryPath, relPath) {
  const abs = safeJoin(libraryPath, relPath);
  const raw = await fsp.readFile(abs, 'utf8');
  const dir = path.dirname(abs);

  const result = {
    relPath,
    name: path.basename(relPath).replace(/\.m3u8?$/i, ''),
    description: null,
    entries: [],
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#PLAYLIST:')) result.name = trimmed.slice(10).trim() || result.name;
      else if (trimmed.startsWith('#DESCRIPTION:')) result.description = trimmed.slice(13).trim() || null;
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) continue; // A URL, not our file.

    const resolved = path.resolve(dir, trimmed.split('/').join(path.sep));
    if (!contains(libraryPath, resolved)) continue;
    const rel = relFrom(libraryPath, resolved);
    if (rel) result.entries.push(rel);
  }
  return result;
}

/**
 * Write a playlist file. Atomic, because a half-written playlist read by
 * another program is worse than one that never changed.
 */
export async function writePlaylistFile(libraryPath, relPath, { name, description, tracks }) {
  const abs = safeJoin(libraryPath, relPath);
  const dir = path.dirname(abs);
  await fsp.mkdir(dir, { recursive: true });

  const lines = ['#EXTM3U', `#PLAYLIST:${name}`];
  if (description) lines.push(`#DESCRIPTION:${String(description).replace(/[\r\n]+/g, ' ')}`);

  for (const track of tracks) {
    const seconds = Number.isFinite(track.duration) ? Math.round(track.duration) : -1;
    const label = [track.artist, track.title].filter(Boolean).join(' - ') || track.filename || track.rel_path;
    lines.push(`#EXTINF:${seconds},${label.replace(/[\r\n]+/g, ' ')}`);
    lines.push(toPosix(path.relative(dir, safeJoin(libraryPath, track.rel_path))));
  }

  const body = `${lines.join('\n')}\n`;
  const tmp = `${abs}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, abs);
  return abs;
}

/** Human-readable total, for the playlist header. */
export function totalDuration(tracks) {
  const seconds = tracks.reduce((sum, track) => sum + (Number(track.duration) || 0), 0);
  return { seconds, label: formatDuration(seconds) };
}
