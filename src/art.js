import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { cacheDir } from './db.js';
import { readEmbeddedArt } from './audio.js';

/**
 * Cover art.
 *
 * The cache lives on the SSD alongside the music, not in a system cache
 * directory. Anything else would defeat the premise — a locked library that
 * still had a folder of readable album covers on the internal disk would be
 * showing you your record collection with the drive unplugged.
 *
 * Cache keys are content hashes, so every track on an album shares one
 * rendered cover, and replacing `cover.jpg` naturally misses the cache instead
 * of serving the old picture forever.
 */

export const SIZES = {
  thumb: { edge: 400, quality: 74 },
  full: { edge: 1000, quality: 84 },
};

export function isValidSize(size) {
  return Object.hasOwn(SIZES, size);
}

export function artPath(libraryPath, key, size) {
  if (!isValidSize(size)) throw new Error(`unknown art size: ${size}`);
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('cache key must be a sha256 hex digest');
  // Two-character fan-out keeps directories small enough for filesystems that
  // slow down with tens of thousands of entries (exFAT very much among them).
  return path.join(cacheDir(libraryPath), size, key.slice(0, 2), `${key}.webp`);
}

/**
 * Render `size` for one cover, reusing the cached file when it exists.
 *
 * `source` is 'embedded' (art inside the audio file at `absPath`) or 'file'
 * (an image beside it). Returns the cache path, or null when there is no art
 * or it cannot be decoded — the caller draws a placeholder record instead.
 */
export async function ensureArt(libraryPath, { source, absPath, key, size = 'thumb' }) {
  if (!source || !key || !absPath) return null;
  const target = artPath(libraryPath, key, size);
  try {
    const stat = await fsp.stat(target);
    if (stat.size > 0) return target;
  } catch {
    // Not cached yet.
  }

  // Both ends of the render go through node's fs rather than sharp's own file
  // handling: libvips opens paths with the plain Win32 calls, which give up at
  // 260 characters, while node uses the long-path form. A library a few levels
  // down a Windows drive — or an album with a wordy name — would otherwise
  // fail to render a single cover, and the failure looks exactly like art that
  // cannot be decoded.
  let input;
  if (source === 'embedded') {
    input = await readEmbeddedArt(absPath);
  } else {
    input = await fsp.readFile(absPath).catch(() => null);
  }
  if (!input) return null;

  const { edge, quality } = SIZES[size];
  await fsp.mkdir(path.dirname(target), { recursive: true });

  // Render to a unique temp name and rename into place, so two requests racing
  // for the same uncached cover cannot serve each other a partial file.
  const tmp = `${target}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const rendered = await sharp(input, { failOn: 'none' })
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality, effort: 4 })
      .toBuffer();
    await fsp.writeFile(tmp, rendered);
    await fsp.rename(tmp, target);
    return target;
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    return null;
  }
}

/** Drop every rendered size of one cover. Used when the source changes. */
export async function dropArt(libraryPath, key) {
  if (!key) return;
  await Promise.all(
    Object.keys(SIZES).map((size) =>
      fsp.rm(artPath(libraryPath, key, size), { force: true }).catch(() => {}),
    ),
  );
}

/**
 * Cache size on disk, for the settings screen. Walks the cache tree, which is
 * cheap enough to do on demand and avoids keeping a running total that could
 * drift out of sync with reality.
 */
export async function cacheStats(libraryPath) {
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.webp')) {
        files += 1;
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) bytes += stat.size;
      }
    }
  };
  await walk(cacheDir(libraryPath));
  return { files, bytes };
}

export async function clearCache(libraryPath) {
  await fsp.rm(cacheDir(libraryPath), { recursive: true, force: true });
}
