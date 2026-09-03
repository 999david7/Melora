import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { Library } from '../src/library.js';
import { readPlaylistFile } from '../src/playlists.js';
import { scanLibrary } from '../src/scanner.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, tempDir, writeTrack } from './helpers.js';

after(cleanup);

const open = [];

/** A library with three tracks in it, ready to be arranged. */
async function stocked() {
  const drive = await tempDir();
  const root = path.join(drive, 'Music');
  const marker = await initLibrary(root, 'Test drive');
  const library = new Library(root, marker);
  open.push(library);

  await writeTrack(path.join(root, 'Talk Talk', 'Spirit of Eden', '01.wav'), {
    title: 'The Rainbow', artist: 'Talk Talk', album: 'Spirit of Eden', trackNo: 1, seconds: 9,
  });
  await writeTrack(path.join(root, 'Talk Talk', 'Spirit of Eden', '02.wav'), {
    title: 'Eden', artist: 'Talk Talk', album: 'Spirit of Eden', trackNo: 2, seconds: 6,
  });
  await writeTrack(path.join(root, 'Bark Psychosis', 'Hex', '01.wav'), {
    title: 'The Loom', artist: 'Bark Psychosis', album: 'Hex', trackNo: 1, seconds: 5,
  });
  await scanLibrary(library);
  return library;
}

after(() => { for (const library of open) library.close(); });

describe('playlist files', () => {
  test('a playlist is a real .m3u8 on the drive', async () => {
    const library = await stocked();
    const tracks = library.listTracks({ folder: null, recursive: true }).items;

    const playlist = await library.createPlaylist('Late night', { description: 'For the drive home' });
    assert.equal(playlist.rel_path, 'Playlists/Late night.m3u8');
    await library.addToPlaylist(playlist.id, [tracks[0].id, tracks[1].id]);

    const raw = await fsp.readFile(path.join(library.path, playlist.rel_path), 'utf8');
    assert.match(raw, /^#EXTM3U\n/);
    assert.match(raw, /#PLAYLIST:Late night/);
    assert.match(raw, /#DESCRIPTION:For the drive home/);
    // Relative to the playlist file, so the drive can be mounted anywhere and
    // any other player can still follow the entries.
    assert.match(raw, /^\.\.\/.+\.wav$/m);
    assert.ok(!raw.includes(library.path), 'no absolute paths from this machine');
  });

  test('#EXTINF carries the running time and a readable label', async () => {
    const library = await stocked();
    const track = library.listTracks({ folder: null, recursive: true, q: 'rainbow' }).items[0];
    const playlist = await library.createPlaylist('One');
    await library.addToPlaylist(playlist.id, [track.id]);

    const raw = await fsp.readFile(path.join(library.path, playlist.rel_path), 'utf8');
    assert.match(raw, /#EXTINF:9,Talk Talk - The Rainbow/);
  });

  test('the file round-trips back through the parser', async () => {
    const library = await stocked();
    const ids = library.listTracks({ folder: null, recursive: true }).items.map((t) => t.id);
    const playlist = await library.createPlaylist('Trip');
    await library.setPlaylistTracks(playlist.id, ids);

    const parsed = await readPlaylistFile(library.path, playlist.rel_path);
    assert.equal(parsed.name, 'Trip');
    assert.equal(parsed.entries.length, 3);
    for (const entry of parsed.entries) {
      assert.ok(library.db.prepare('SELECT 1 FROM tracks WHERE rel_path = ?').get(entry), entry);
    }
  });

  test('order is preserved exactly as given', async () => {
    const library = await stocked();
    const all = library.listTracks({ folder: null, recursive: true }).items;
    const wanted = [all[2].id, all[0].id, all[1].id];

    const playlist = await library.createPlaylist('Ordered');
    await library.setPlaylistTracks(playlist.id, wanted);

    const { tracks } = library.getPlaylist(playlist.id);
    assert.deepEqual(tracks.map((t) => t.id), wanted);
  });
});

describe('reading playlists off the drive', () => {
  test('a playlist written by another program turns up in a scan', async () => {
    const library = await stocked();
    // Exactly what VLC or a ripper would leave behind.
    await fsp.mkdir(path.join(library.path, 'Playlists'), { recursive: true });
    await fsp.writeFile(
      path.join(library.path, 'Playlists', 'Handmade.m3u8'),
      [
        '#EXTM3U',
        '#PLAYLIST:Handmade',
        '#EXTINF:9,Talk Talk - The Rainbow',
        '../Talk Talk/Spirit of Eden/01.wav',
        '#EXTINF:5,Bark Psychosis - The Loom',
        '../Bark Psychosis/Hex/01.wav',
        '',
      ].join('\n'),
    );

    const report = await scanLibrary(library);
    assert.equal(report.playlists, 1);

    const [summary] = library.listPlaylists();
    assert.equal(summary.name, 'Handmade');
    assert.equal(summary.count, 2);
    assert.equal(summary.seconds, 14);
    assert.equal(summary.missing, 0);
  });

  test('entries pointing outside the library are dropped, not followed', async () => {
    const library = await stocked();
    await fsp.mkdir(path.join(library.path, 'Playlists'), { recursive: true });
    await fsp.writeFile(
      path.join(library.path, 'Playlists', 'Hostile.m3u8'),
      [
        '#EXTM3U',
        '../../../../etc/passwd',
        '/etc/hosts',
        'https://example.com/stream.mp3',
        '../Bark Psychosis/Hex/01.wav',
        '',
      ].join('\n'),
    );

    const parsed = await readPlaylistFile(library.path, 'Playlists/Hostile.m3u8');
    assert.deepEqual(parsed.entries, ['Bark Psychosis/Hex/01.wav']);
  });

  test('a playlist entry whose file has gone keeps its place, marked missing', async () => {
    const library = await stocked();
    const tracks = library.listTracks({ folder: null, recursive: true }).items;
    const playlist = await library.createPlaylist('Fragile');
    await library.setPlaylistTracks(playlist.id, tracks.map((t) => t.id));

    await fsp.rm(path.join(library.path, 'Bark Psychosis', 'Hex', '01.wav'));
    await scanLibrary(library);

    const [summary] = library.listPlaylists();
    assert.equal(summary.count, 3, 'the entry is still listed');
    assert.equal(summary.missing, 1, 'and it is honest about being unplayable');
  });

  test('a playlist file deleted on the drive disappears from the index', async () => {
    const library = await stocked();
    const playlist = await library.createPlaylist('Temporary');
    await scanLibrary(library);
    assert.equal(library.listPlaylists().length, 1);

    await fsp.rm(path.join(library.path, playlist.rel_path));
    await scanLibrary(library);
    assert.equal(library.listPlaylists().length, 0);
  });
});

describe('editing playlists', () => {
  test('renaming moves the file and keeps the tracks', async () => {
    const library = await stocked();
    const ids = library.listTracks({ folder: null, recursive: true }).items.map((t) => t.id);
    const playlist = await library.createPlaylist('Before');
    await library.setPlaylistTracks(playlist.id, ids);

    const renamed = await library.renamePlaylist(playlist.id, 'After');
    assert.equal(renamed.rel_path, 'Playlists/After.m3u8');
    await assert.rejects(fsp.stat(path.join(library.path, 'Playlists', 'Before.m3u8')));

    const raw = await fsp.readFile(path.join(library.path, renamed.rel_path), 'utf8');
    assert.match(raw, /#PLAYLIST:After/);
    assert.equal(library.getPlaylist(playlist.id).tracks.length, 3);
  });

  test('two playlists cannot share a name', async () => {
    const library = await stocked();
    await library.createPlaylist('Mix');
    await assert.rejects(library.createPlaylist('Mix'), /already exists/);
  });

  test('deleting a playlist puts the file in the trash, like everything else', async () => {
    const library = await stocked();
    const playlist = await library.createPlaylist('Doomed');
    await library.deletePlaylist(playlist.id);

    assert.equal(library.listPlaylists().length, 0);
    await assert.rejects(fsp.stat(path.join(library.path, playlist.rel_path)));

    const trash = path.join(library.path, '.melora', 'trash');
    const found = [];
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else found.push(entry.name);
      }
    };
    await walk(trash);
    assert.ok(found.includes('Doomed.m3u8'), 'nothing is ever unlinked');
  });

  test('renaming a folder keeps its tracks in their playlists', async () => {
    const library = await stocked();
    const track = library.listTracks({ folder: 'Bark Psychosis/Hex' }).items[0];
    const playlist = await library.createPlaylist('Keeps up');
    await library.setPlaylistTracks(playlist.id, [track.id]);

    await library.renameFolder('Bark Psychosis', 'Bark Psychosis (UK)');
    await scanLibrary(library);

    const { tracks } = library.getPlaylist(playlist.id);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].rel_path, 'Bark Psychosis (UK)/Hex/01.wav');
    assert.equal(library.listPlaylists()[0].missing, 0);
  });
});
