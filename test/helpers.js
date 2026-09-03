import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Test fixtures.
 *
 * Every test gets its own throwaway "drive" and its own MELORA_HOME, so a test
 * run can never read or write the config of whoever is running it.
 *
 * The audio files below are real files, not stubs: a genuine RIFF/WAVE with a
 * genuine LIST-INFO tag block, and a genuine MPEG stream behind a genuine
 * ID3v2 tag. The scanner reads them with the same parser it uses on your
 * library, so these tests exercise the tag reader rather than a mock of it.
 */

const roots = [];

export async function tempDir(prefix = 'melora-test-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export async function cleanup() {
  await Promise.all(roots.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
}

/** Point config at a scratch directory before anything reads or writes it. */
export async function isolateConfig() {
  const home = await tempDir('melora-home-');
  process.env.MELORA_HOME = home;
  return home;
}

/** RIFF chunk: a four-character id, a little-endian length, then the payload. */
function chunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  // Chunks are word-aligned; an odd payload gets a pad byte that is not counted.
  const pad = payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  return Buffer.concat([head, payload, pad]);
}

/**
 * INFO tags, as every ripper has written them into WAV since 1991.
 * INAM title, IART artist, IPRD album, ICRD date, IPRT track, IGNR genre.
 */
const INFO_IDS = {
  title: 'INAM',
  artist: 'IART',
  album: 'IPRD',
  year: 'ICRD',
  trackNo: 'IPRT',
  genre: 'IGNR',
  comment: 'ICMT',
};

/** Write a real, silent WAV file carrying real tags. */
export async function writeTrack(absPath, { seconds = 2, sampleRate = 8000, channels = 1, ...tags } = {}) {
  const bytesPerSample = 2;
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const audio = Buffer.alloc(frames * channels * bytesPerSample);

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 8);
  fmt.writeUInt16LE(channels * bytesPerSample, 12);
  fmt.writeUInt16LE(8 * bytesPerSample, 14);

  const infoFields = Object.entries(tags)
    .filter(([key, value]) => INFO_IDS[key] && value !== undefined && value !== null)
    .map(([key, value]) => chunk(INFO_IDS[key], Buffer.from(`${value}\0`, 'utf8')));
  const list = infoFields.length
    ? chunk('LIST', Buffer.concat([Buffer.from('INFO', 'ascii'), ...infoFields]))
    : Buffer.alloc(0);

  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    list,
    chunk('data', audio),
  ]);

  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, chunk('RIFF', body));
  return absPath;
}

// ------------------------------------------------------------------ ID3 / MP3

function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

function id3Frame(id, body) {
  const head = Buffer.alloc(10);
  head.write(id, 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}

function id3Text(id, value) {
  return id3Frame(id, Buffer.concat([Buffer.from([0x00]), Buffer.from(String(value), 'latin1')]));
}

/** A small real JPEG, for cover art. */
export async function coverBytes({ width = 60, height = 60, tint } = {}) {
  return sharp({
    create: { width, height, channels: 3, background: tint ?? { r: 190, g: 40, b: 70 } },
  })
    .jpeg({ quality: 70 })
    .toBuffer();
}

/** Write a real cover image beside an album, the way rippers do. */
export async function writeCover(absPath, options) {
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, await coverBytes(options));
  return absPath;
}

/**
 * A real MP3: an ID3v2.3 tag (optionally carrying embedded cover art) followed
 * by three silent MPEG-1 Layer III frames.
 */
export async function writeTaggedMp3(absPath, { title, artist, album, albumArtist, trackNo, art = false } = {}) {
  const frames = [];
  if (title) frames.push(id3Text('TIT2', title));
  if (artist) frames.push(id3Text('TPE1', artist));
  if (album) frames.push(id3Text('TALB', album));
  if (albumArtist) frames.push(id3Text('TPE2', albumArtist));
  if (trackNo) frames.push(id3Text('TRCK', String(trackNo)));
  if (art) {
    const jpeg = await coverBytes();
    frames.push(
      id3Frame(
        'APIC',
        Buffer.concat([
          Buffer.from([0x00]),                    // latin1 text encoding
          Buffer.from('image/jpeg\0', 'latin1'),
          Buffer.from([0x03]),                    // picture type: cover (front)
          Buffer.from('\0', 'latin1'),            // empty description
          jpeg,
        ]),
      ),
    );
  }

  const body = Buffer.concat(frames);
  const tag = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);

  // MPEG-1 Layer III, 128 kbps, 44.1 kHz, mono: 417 bytes per frame.
  const audioFrame = Buffer.alloc(417);
  audioFrame[0] = 0xff;
  audioFrame[1] = 0xfb;
  audioFrame[2] = 0x90;
  audioFrame[3] = 0xc0;

  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, Buffer.concat([tag, audioFrame, audioFrame, audioFrame]));
  return absPath;
}

/** An identical copy, byte for byte — for dedupe and rename-detection tests. */
export async function copyTrack(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return to;
}

export async function listFiles(dir) {
  const out = [];
  const walk = async (current, prefix) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}
