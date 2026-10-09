import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { loadConfig } from '../src/config.js';
import { asText, NowPlaying } from '../src/remote.js';
import { startServer } from '../src/server.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, isolateConfig, tempDir, writeCover, writeTrack } from './helpers.js';

await isolateConfig();

describe('NowPlaying', () => {
  const report = (overrides = {}) => ({
    track: { id: 7, title: 'Eden', artist: 'Talk Talk', album: 'Spirit of Eden', hasArt: true },
    duration: 300,
    position: 10,
    playing: true,
    upNext: [{ title: 'Desire', artist: 'Talk Talk' }],
    ...overrides,
  });

  test('carries the position forward while playing, and holds it while paused', () => {
    let clock = 1_000_000;
    const now = new NowPlaying({ now: () => clock });
    now.update('tab', report());
    clock += 4000;
    assert.equal(now.view().position, 14);
    now.update('tab', report({ playing: false, position: 14 }));
    clock += 60_000;
    assert.equal(now.view().position, 14);
    assert.equal(now.view().playing, false);
  });

  test('a tab that went quiet without a stream is no longer playing', () => {
    let clock = 0;
    const now = new NowPlaying({ now: () => clock });
    now.update('tab', report());
    clock += 60_000;
    assert.equal(now.view().playing, false);
    assert.equal(now.view().position, 10);
  });

  test('an idle tab does not take over from the one that is playing', () => {
    const now = new NowPlaying();
    now.update('playing', report());
    now.update('idle', { track: null });
    assert.equal(now.view().track.title, 'Eden');
    now.update('playing', { track: null });
    assert.equal(now.view().active, false);
  });

  test('commands go to the tab that is playing', () => {
    const now = new NowPlaying();
    const written = { a: [], b: [] };
    now.attach('a', { write: (chunk) => written.a.push(chunk) });
    now.attach('b', { write: (chunk) => written.b.push(chunk) });
    now.update('b', report());
    assert.equal(now.command('next'), true);
    assert.equal(written.a.length, 0);
    assert.match(written.b.join(''), /event: command\ndata: {"command":"next"}/);
    assert.throws(() => now.command('format-drive'));
  });

  test('without a listening tab a command reports that nothing heard it', () => {
    const now = new NowPlaying();
    now.update('tab', report());
    assert.equal(now.command('toggle'), false);
    assert.equal(now.view().controllable, false);
  });

  test('reports are trimmed to what a widget shows', () => {
    const now = new NowPlaying();
    now.update('tab', report({
      track: { id: 'x', title: 'a'.repeat(5000), artist: 42 },
      upNext: Array.from({ length: 50 }, () => ({ title: 'n' })),
      repeat: 'sideways',
    }));
    const view = now.view();
    assert.equal(view.track.id, null);
    assert.equal(view.track.title.length, 300);
    assert.equal(view.track.artist, '');
    assert.equal(view.upNext.length, 5);
    assert.equal(view.repeat, 'off');
  });

  test('the text form has every line in a fixed order, with no stray newlines', () => {
    const now = new NowPlaying();
    now.update('tab', report({ track: { id: 3, title: 'Line\nbreak', artist: 'A', album: 'B', hasArt: true } }));
    const lines = asText(now.view(), 'http://127.0.0.1:4610').trimEnd().split('\n');
    assert.deepEqual(lines.map((line) => line.split('=')[0]),
      ['state', 'title', 'artist', 'album', 'position', 'duration', 'progress', 'art', 'next', 'controllable']);
    assert.equal(lines[1], 'title=Line break');
    assert.equal(lines[7], 'art=http://127.0.0.1:4610/api/now-playing/art?track=3');
    assert.equal(lines[8], 'next=Desire — Talk Talk');
    assert.match(asText({ locked: true, active: false }, ''), /^state=locked\ntitle=Drive not connected\n/);
    assert.match(asText({ active: false }, ''), /^state=idle\ntitle=Nothing playing\n/);
  });
});

describe('now-playing routes', () => {
  let instance;
  let libraryPath;
  let trackId;
  const url = (suffix) => `${instance.url}${suffix}`;
  const put = (body) => fetch(url('/api/now-playing'), {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const remote = (command, headers = { 'x-melora-remote': '1' }) =>
    fetch(url(`/api/remote/${command}`), { method: 'POST', headers });

  before(async () => {
    const drive = await tempDir();
    libraryPath = path.join(drive, 'Music');
    await initLibrary(libraryPath, 'Test drive');
    const album = path.join(libraryPath, 'Talk Talk', 'Spirit of Eden');
    await writeTrack(path.join(album, '01.wav'), { title: 'The Rainbow', artist: 'Talk Talk', album: 'Spirit of Eden', seconds: 2 });
    await writeCover(path.join(album, 'cover.jpg'));
    const config = loadConfig();
    config.server = { host: '127.0.0.1', port: 0 };
    config.scanOnUnlock = false;
    instance = await startServer({ config });
  });

  after(async () => {
    await instance?.close();
    await cleanup();
  });

  test('while locked, widgets are told so instead of getting an error', async () => {
    const view = await (await fetch(url('/api/now-playing'))).json();
    assert.equal(view.locked, true);
    assert.match(await (await fetch(url('/api/now-playing.txt'))).text(), /^state=locked\n/);
    assert.equal((await put({ client: 'tab', track: null })).status, 423);
  });

  test('a tab reports, a widget reads it back with the cover', async () => {
    assert.equal((await fetch(url('/api/volume/attach'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: libraryPath }),
    })).status, 200);
    const { job } = await (await fetch(url('/api/jobs/scan'), { method: 'POST' })).json();
    for (let i = 0; i < 200; i += 1) {
      const { job: current } = await (await fetch(url(`/api/jobs/${job.id}`))).json();
      if (current.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const { items } = await (await fetch(url('/api/tracks?folder=&recursive=1'))).json();
    trackId = items[0].id;

    assert.equal((await put({
      client: 'tab',
      track: { id: trackId, title: 'The Rainbow', artist: 'Talk Talk', album: 'Spirit of Eden', hasArt: true },
      duration: 2, position: 1, playing: false,
    })).status, 200);
    const view = await (await fetch(url('/api/now-playing'))).json();
    assert.equal(view.track.title, 'The Rainbow');
    assert.equal(view.art, `${instance.url}/api/now-playing/art?track=${trackId}`);

    const art = await fetch(view.art);
    assert.equal(art.status, 200);
    assert.equal(art.headers.get('content-type'), 'image/jpeg');
    assert.equal((await art.arrayBuffer()).byteLength > 0, true);
  });

  test('commands need the widget header, so a web page cannot send them', async () => {
    assert.equal((await remote('toggle', {})).status, 403);
    assert.equal((await remote('format')).status, 404);
    assert.equal((await remote('toggle')).status, 409);
  });

  test('a command reaches the tab listening on the event stream', async () => {
    const received = new Promise((resolve, reject) => {
      const req = httpRequest(url('/api/remote/events?client=tab'), (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        let buffer = '';
        res.setEncoding('utf8');
        let sent = false;
        res.on('data', (chunk) => {
          buffer += chunk;
          if (!sent && buffer.includes('retry:')) {
            sent = true;
            remote('next').then((response) => {
              if (response.status !== 200) reject(new Error(`command answered ${response.status}`));
            }, reject);
          }
          const match = buffer.match(/event: command\ndata: (.*)\n/);
          if (match) {
            req.destroy();
            resolve(JSON.parse(match[1]));
          }
        });
      });
      req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
      req.end();
    });
    assert.deepEqual(await received, { command: 'next' });
  });

  test('unplugging the drive forgets what was playing', async () => {
    instance.watcher.emit('unmounted', { path: libraryPath });
    const view = await (await fetch(url('/api/now-playing'))).json();
    assert.equal(view.locked, true);
    assert.equal(instance.state.nowPlaying.view().active, false);
  });
});
