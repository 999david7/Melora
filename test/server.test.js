import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { initLibrary, MARKER_FILENAME } from '../src/volume.js';
import { cleanup, isolateConfig, tempDir, writeCover, writeTaggedMp3, writeTrack } from './helpers.js';

await isolateConfig();

let instance;
let drive;
let libraryPath;

/** Routes that must not answer while the drive is away. */
const GATED = [
  '/api/folders',
  '/api/folder?path=',
  '/api/tracks',
  '/api/tracks/1',
  '/api/tracks/1/stream',
  '/api/tracks/1/art',
  '/api/albums',
  '/api/album?key=x',
  '/api/artists',
  '/api/playlists',
  '/api/jobs',
  '/api/cache',
];

const url = (suffix) => `${instance.url}${suffix}`;
const get = (suffix, init) => fetch(url(suffix), init);
const send = (method) => (suffix, body) =>
  fetch(url(suffix), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const post = send('POST');
const patch = send('PATCH');
const put = send('PUT');
const del = send('DELETE');

/** Run a scan to completion, so assertions do not race the job. */
async function scan() {
  const { job } = await (await post('/api/jobs/scan')).json();
  for (let i = 0; i < 200; i += 1) {
    const { job: current } = await (await get(`/api/jobs/${job.id}`)).json();
    if (current.status !== 'running') return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the scan never finished');
}

before(async () => {
  drive = await tempDir();
  libraryPath = path.join(drive, 'Music');
  await initLibrary(libraryPath, 'Test drive');

  const album = path.join(libraryPath, 'Talk Talk', 'Spirit of Eden');
  await writeTrack(path.join(album, '01.wav'), {
    title: 'The Rainbow', artist: 'Talk Talk', album: 'Spirit of Eden', trackNo: 1, year: 1988, seconds: 4,
  });
  await writeTrack(path.join(album, '02.wav'), {
    title: 'Eden', artist: 'Talk Talk', album: 'Spirit of Eden', trackNo: 2, year: 1988, seconds: 3,
  });
  await writeCover(path.join(album, 'cover.jpg'));
  await writeTaggedMp3(path.join(libraryPath, 'Coil', 'Slow Light', '01.mp3'), {
    title: 'Ember', artist: 'Coil', album: 'Slow Light', art: true,
  });

  const config = loadConfig();
  config.server = { host: '127.0.0.1', port: 0 };
  config.scanOnUnlock = false;
  instance = await startServer({ config });
});

after(async () => {
  await instance?.close();
  await cleanup();
});

describe('before a library is paired', () => {
  test('status says so and every route that knows anything is closed', async () => {
    const status = await (await get('/api/status')).json();
    assert.equal(status.configured, false);
    assert.equal(status.locked, true);
    assert.equal(status.library, null);

    for (const route of GATED) {
      const response = await get(route);
      assert.equal(response.status, 423, route);
    }
  });

  test('the interface itself still loads, so it can show the setup screen', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Melora/);
  });
});

describe('pairing and unlocking', () => {
  test('attaching an existing library unlocks it', async () => {
    const response = await post('/api/volume/attach', { path: libraryPath });
    assert.equal(response.status, 200);

    const status = await (await get('/api/status')).json();
    assert.equal(status.configured, true);
    assert.equal(status.locked, false);
    assert.equal(status.volume.label, 'Test drive');
    assert.equal(status.volume.path, libraryPath);
  });

  test('attaching a folder with no library is refused', async () => {
    const response = await post('/api/volume/attach', { path: drive });
    assert.equal(response.status, 404);
  });

  test('a scan indexes what is on the drive', async () => {
    const job = await scan();
    assert.equal(job.status, 'done');
    assert.equal(job.result.added, 3);

    const status = await (await get('/api/status')).json();
    assert.equal(status.library.count, 3);
    assert.equal(status.library.albums, 2);
    assert.equal(status.library.artists, 2);
  });
});

describe('browsing', () => {
  test('the folder tree mirrors the drive', async () => {
    const { tree } = await (await get('/api/folders')).json();
    assert.equal(tree.count, 3);
    assert.deepEqual(tree.children.map((node) => node.name).sort(), ['Coil', 'Talk Talk']);
  });

  test('tracks come back in album order with their tags', async () => {
    const page = await (await get('/api/tracks?folder=Talk%20Talk/Spirit%20of%20Eden')).json();
    assert.equal(page.total, 2);
    assert.equal(page.seconds, 7);
    assert.deepEqual(page.items.map((t) => t.title), ['The Rainbow', 'Eden']);
    assert.equal(page.items[0].artist, 'Talk Talk');
  });

  test('albums and artists are grouped', async () => {
    const { items } = await (await get('/api/albums')).json();
    assert.equal(items.length, 2);
    const spirit = items.find((album) => album.title === 'Spirit of Eden');
    assert.equal(spirit.count, 2);
    assert.equal(spirit.year, 1988);

    const detail = await (await get(`/api/album?key=${encodeURIComponent(spirit.key)}`)).json();
    assert.deepEqual(detail.tracks.map((t) => t.title), ['The Rainbow', 'Eden']);

    const { artists } = await (await get('/api/artists')).json();
    assert.deepEqual(artists.map((a) => a.name).sort(), ['Coil', 'Talk Talk']);
  });

  test('search spans titles, artists and albums', async () => {
    // Searching is always library-wide: a track you cannot find is the whole
    // reason you are searching, so the client asks from the root, recursively.
    const search = (q) => get(`/api/tracks?folder=&recursive=1&q=${encodeURIComponent(q)}`);
    assert.equal((await (await search('rainbow')).json()).total, 1, 'by title');
    assert.equal((await (await search('coil')).json()).total, 1, 'by artist');
    assert.equal((await (await search('spirit of eden')).json()).total, 2, 'by album');
    assert.equal((await (await search('nothing here')).json()).total, 0);
  });
});

describe('playing', () => {
  async function firstTrack() {
    const page = await (await get('/api/tracks?folder=&recursive=1&q=rainbow')).json();
    return page.items[0];
  }

  test('a track streams with the right type and is never cached to disk', async () => {
    const track = await firstTrack();
    const response = await get(`/api/tracks/${track.id}/stream`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  });

  test('range requests are honoured, which is what seeking needs', async () => {
    const track = await firstTrack();
    const response = await get(`/api/tracks/${track.id}/stream`, { headers: { range: 'bytes=0-99' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), '100');
    assert.match(response.headers.get('content-range'), /^bytes 0-99\/\d+$/);
  });

  test('cover art renders as webp, from a file and from inside a tag', async () => {
    const fromFile = await firstTrack();
    let response = await get(`/api/tracks/${fromFile.id}/art?size=thumb`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');

    const embedded = (await (await get('/api/tracks?folder=&recursive=1&q=ember')).json()).items[0];
    response = await get(`/api/tracks/${embedded.id}/art?size=full`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
  });

  test('an unknown art size is refused rather than guessed at', async () => {
    const track = await firstTrack();
    assert.equal((await get(`/api/tracks/${track.id}/art?size=enormous`)).status, 400);
  });

  test('play counts are recorded through the API', async () => {
    const track = await firstTrack();
    const { track: played } = await (await post(`/api/tracks/${track.id}/played`)).json();
    assert.equal(played.play_count, track.play_count + 1);
    assert.ok(played.last_played > 0);
  });

  test('a favourite and a note round-trip', async () => {
    const track = await firstTrack();
    const response = await patch(`/api/tracks/${track.id}`, { favorite: true, note: 'side one' });
    const { track: updated } = await response.json();
    assert.equal(updated.favorite, 1);
    assert.equal(updated.note, 'side one');
    assert.equal((await (await get('/api/tracks?favorite=1&folder=&recursive=1')).json()).total, 1);
  });
});

describe('autoplay', () => {
  test('suggests the closest match and skips what already played', async () => {
    const { items: all } = await (await get('/api/tracks?folder=&recursive=1')).json();
    const rainbow = all.find((track) => track.title === 'The Rainbow');
    const eden = all.find((track) => track.title === 'Eden');

    let { items } = await (await post(`/api/tracks/${rainbow.id}/similar`, {})).json();
    assert.equal(items[0].title, 'Eden', 'same artist, album and year');

    ({ items } = await (await post(`/api/tracks/${rainbow.id}/similar`, { exclude: [eden.id] })).json());
    assert.equal(items[0].title, 'Ember');

    assert.equal((await post(`/api/tracks/${rainbow.id}/similar`, { exclude: 'all' })).status, 400);
    assert.equal((await post('/api/tracks/9999/similar', {})).status, 404);
  });

  test('is on by default and can be switched off', async () => {
    assert.equal((await (await get('/api/config')).json()).autoplay, true);
    await patch('/api/config', { autoplay: false });
    assert.equal((await (await get('/api/config')).json()).autoplay, false);
    assert.equal((await (await get('/api/status')).json()).settings.autoplay, false);
    await patch('/api/config', { autoplay: true });
  });
});

describe('playlists over HTTP', () => {
  let playlistId;

  test('a playlist can be made and filled', async () => {
    const created = await post('/api/playlists', { name: 'Evening', description: 'Quiet ones' });
    assert.equal(created.status, 201);
    const { playlist } = await created.json();
    playlistId = playlist.id;

    const { items } = await (await get('/api/tracks?folder=&recursive=1')).json();
    const response = await put(`/api/playlists/${playlistId}/tracks`, {
      trackIds: items.slice(0, 2).map((t) => t.id),
    });
    assert.equal(response.status, 200);

    const { tracks } = await response.json();
    assert.equal(tracks.length, 2);

    // And it is a real file on the drive, not just a row.
    const raw = await fsp.readFile(path.join(libraryPath, 'Playlists', 'Evening.m3u8'), 'utf8');
    assert.match(raw, /#EXTM3U/);
  });

  test('the listing reports its length and running time', async () => {
    const { playlists } = await (await get('/api/playlists')).json();
    const evening = playlists.find((p) => p.name === 'Evening');
    assert.equal(evening.count, 2);
    assert.equal(evening.missing, 0);
    assert.ok(evening.seconds > 0);
  });

  test('renaming and deleting work through the API', async () => {
    const renamed = await patch(`/api/playlists/${playlistId}`, { name: 'Late' });
    assert.equal(renamed.status, 200);
    assert.ok(await fsp.stat(path.join(libraryPath, 'Playlists', 'Late.m3u8')));

    assert.equal((await del(`/api/playlists/${playlistId}`)).status, 200);
    assert.equal((await (await get('/api/playlists')).json()).playlists.length, 0);
  });

  test('a playlist name that would escape the folder is refused', async () => {
    const response = await post('/api/playlists', { name: '../../escape' });
    assert.equal(response.status, 400);
  });
});

describe('guards', () => {
  test('a foreign Host header is refused, which closes off DNS rebinding', async () => {
    // fetch() refuses to set Host, so this one goes out over raw http.
    const status = (host) =>
      new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: Number(new URL(instance.url).port),
            path: '/api/status',
            headers: { host },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', reject);
        request.end();
      });

    assert.equal(await status('evil.example.com'), 403);
    assert.equal(await status('127.0.0.1:1234'), 200, 'a local host with any port is fine');
  });

  test('the page runs under a Content-Security-Policy that allows no outside media', async () => {
    const csp = (await get('/')).headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /media-src 'self'/);
    assert.match(csp, /object-src 'none'/);
  });

  test('an unknown API route is a 404, not the index page', async () => {
    const response = await get('/api/nope');
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'no such endpoint');
  });

  test('a track id that is not there is a 404', async () => {
    assert.equal((await get('/api/tracks/999999')).status, 404);
    assert.equal((await get('/api/tracks/999999/stream')).status, 404);
  });

  test('config changes are validated', async () => {
    assert.equal((await patch('/api/config', { watch: { intervalMs: 5 } })).status, 400);
    assert.equal((await patch('/api/config', { sync: { sources: 'nope' } })).status, 400);
    assert.equal((await patch('/api/config', { sync: { sources: [{ path: '/x', organizeBy: 'bad' }] } })).status, 400);
  });
});

describe('when the drive is pulled', () => {
  test('every route closes and the library goes away', async () => {
    // The marker vanishing is exactly what unplugging the drive looks like.
    await fsp.rm(path.join(libraryPath, MARKER_FILENAME));
    await post('/api/volume/recheck');

    const status = await (await get('/api/status')).json();
    assert.equal(status.locked, true);
    assert.equal(status.library, null, 'no counts survive the drive leaving');
    assert.equal(status.volume.path, null);

    for (const route of GATED) {
      assert.equal((await get(route)).status, 423, route);
    }
  });

  test('the interface still answers, so it can show the lock screen', async () => {
    assert.equal((await get('/')).status, 200);
  });
});
