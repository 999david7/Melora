import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';

/**
 * Format knowledge, content hashing and tag reading.
 *
 * Melora indexes more file types than a browser can play. A collection that
 * has been carried across twenty years has APE and WavPack and the odd WMA in
 * it, and dropping those files from the library because `<audio>` cannot
 * decode them would make the index lie about what is on the drive. They are
 * indexed, counted, searchable and included in folder listings; they simply
 * cannot be played here, and the interface says so rather than failing
 * silently when you press play.
 *
 * Nothing in this module ever opens an audio file for writing. Tags are read
 * out of your files and cached in the index; your files are never rewritten.
 */

/** Formats a browser can be expected to play. */
export const PLAYABLE_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus',
  '.wav', '.wave', '.weba', '.webm', '.aif', '.aiff', '.aifc',
]);

/** Formats we index but cannot hand to `<audio>`. */
export const OPAQUE_EXTENSIONS = new Set([
  '.wma', '.ape', '.wv', '.mpc', '.dsf', '.dff', '.tta', '.ofr', '.shn',
  '.ra', '.au', '.mid', '.midi', '.mod', '.it', '.s3m', '.xm',
]);

/** What to send as Content-Type when streaming. */
export const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.wave': 'audio/wav',
  '.weba': 'audio/webm', '.webm': 'audio/webm',
  '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.aifc': 'audio/aiff',
};

/** Image files that count as a folder's cover art. */
const ART_FILENAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'artwork'];
const ART_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

export function extensionOf(filename) {
  return path.extname(filename).toLowerCase();
}

export function isPlayable(filename) {
  return PLAYABLE_EXTENSIONS.has(extensionOf(filename));
}

export function isAudioFile(filename) {
  if (filename.startsWith('.')) return false; // ._resource forks, .DS_Store, etc.
  const ext = extensionOf(filename);
  return PLAYABLE_EXTENSIONS.has(ext) || OPAQUE_EXTENSIONS.has(ext);
}

/** Streaming sha256 — identity for dedupe, rename detection and cache keys. */
export function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function hashString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function text(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, 500);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * What groups tracks into one album.
 *
 * Keyed on the album artist rather than the track artist so a compilation does
 * not shatter into one album per guest vocalist. Untagged music — a folder of
 * files ripped before anyone cared about metadata — keys on the folder
 * instead, because on disk that folder *is* the album, and showing every one
 * of those tracks as its own record would be useless.
 */
export function albumKeyFor({ album, albumArtist, artist, folderPath }) {
  const name = text(album);
  if (!name) return `folder:${folderPath}`;
  const by = text(albumArtist) ?? text(artist) ?? '';
  return `tag:${by.toLowerCase()}\u0000${name.toLowerCase()}`;
}

/**
 * A cover image sitting next to the music, the way ripping tools have written
 * it for decades. One readdir per folder, cached by the caller.
 */
export async function findFolderArt(absDir) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);

  for (const stem of ART_FILENAMES) {
    for (const ext of ART_EXTENSIONS) {
      const match = files.find((name) => name.toLowerCase() === `${stem}${ext}`);
      if (match) return path.join(absDir, match);
    }
  }
  // Nothing conventionally named: a lone image in an album folder is almost
  // always the cover, so use it rather than showing a blank record.
  const images = files.filter((name) => ART_EXTENSIONS.includes(extensionOf(name)));
  return images.length === 1 ? path.join(absDir, images[0]) : null;
}

/**
 * Everything the index wants to know about one file.
 *
 * A file whose tags cannot be parsed is not an error: it still has a name, a
 * size and a place in a folder, and that is enough to list it and play it.
 * The filename becomes the title, which is what every other player does too.
 */
export async function readTags(absPath, { folderPath = '' } = {}) {
  const result = {
    title: null,
    artist: null,
    albumArtist: null,
    album: null,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    duration: null,
    bitrate: null,
    sampleRate: null,
    channels: null,
    lossless: null,
    codec: null,
    hasEmbeddedArt: false,
  };

  try {
    const meta = await parseFile(absPath, { duration: true, skipCovers: false });
    const { common = {}, format = {} } = meta;

    result.title = text(common.title);
    result.artist = text(common.artist) ?? text(common.artists?.[0]);
    result.albumArtist = text(common.albumartist);
    result.album = text(common.album);
    result.trackNo = positiveInt(common.track?.no);
    result.discNo = positiveInt(common.disk?.no);
    result.year = positiveInt(common.year);
    result.genre = text(Array.isArray(common.genre) ? common.genre[0] : common.genre);
    result.hasEmbeddedArt = Array.isArray(common.picture) && common.picture.length > 0;

    result.duration = Number.isFinite(format.duration) && format.duration > 0 ? format.duration : null;
    result.bitrate = positiveInt(format.bitrate);
    result.sampleRate = positiveInt(format.sampleRate);
    result.channels = positiveInt(format.numberOfChannels);
    result.lossless = typeof format.lossless === 'boolean' ? (format.lossless ? 1 : 0) : null;
    result.codec = text(format.codec) ?? text(format.container);
  } catch {
    // Unparseable tags. Everything below still applies.
  }

  if (!result.title) {
    // "04 - Cinnamon.flac" reads better as "Cinnamon" than as the filename,
    // but only strip a leading index when one is clearly there.
    const stem = path.basename(absPath, path.extname(absPath));
    result.title = stem.replace(/^\s*\d{1,3}\s*[-._)]\s*/, '').trim() || stem;
  }
  result.albumKey = albumKeyFor({
    album: result.album,
    albumArtist: result.albumArtist,
    artist: result.artist,
    folderPath,
  });
  return result;
}

/** The first embedded picture in a file, or null. */
export async function readEmbeddedArt(absPath) {
  try {
    const meta = await parseFile(absPath, { duration: false, skipCovers: false });
    const picture = meta.common?.picture?.[0];
    if (!picture?.data?.length) return null;
    return Buffer.from(picture.data);
  } catch {
    return null;
  }
}
