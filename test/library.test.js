import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { ensureArt } from '../src/art.js';
import { Library } from '../src/library.js';
import { pruneMissing, scanLibrary, verifyLibrary } from '../src/scanner.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, closeBeforeCleanup, copyTrack, tempDir, writeCover, writeTaggedMp3, writeTrack } from './helpers.js';

after(cleanup);

const open = [];
async function makeLibrary() {
  const drive = await tempDir();
  const root = path.join(drive, 'Music');
  const marker = await initLibrary(root, 'Test drive');
  const library = new Library(root, marker);
  open.push(library);
  return library;
}

closeBeforeCleanup(() => { for (const library of open) library.close(); });

describe('scanning', () => {
  test('indexes audio and mirrors the directory tree into folders', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'loose.wav'), { title: 'Loose' });
    await writeTrack(path.join(library.path, 'Bark Psychosis', 'Hex', '01.wav'), {
      title: 'The Loom', artist: 'Bark Psychosis', album: 'Hex', trackNo: 1, seconds: 4,
    });
    await writeTrack(path.join(library.path, 'Bark Psychosis', 'Hex', '02.wav'), {
      title: 'A Street Scene', artist: 'Bark Psychosis', album: 'Hex', trackNo: 2, seconds: 6,
    });

    const report = await scanLibrary(library);
    assert.equal(report.added, 3);
    assert.equal(report.foldersAdded, 2, 'Bark Psychosis and Bark Psychosis/Hex');

    const tree = library.folderTree();
    assert.equal(tree.count, 3, 'the root counts everything beneath it');
    const artist = tree.children.find((node) => node.name === 'Bark Psychosis');
    assert.equal(artist.count, 2);
    assert.equal(artist.directCount, 0, 'tracks sit in the child folder, not in the artist folder');

    const { items } = library.listTracks({ folder: 'Bark Psychosis/Hex' });
    assert.deepEqual(items.map((t) => t.title), ['The Loom', 'A Street Scene'], 'album order');
    assert.equal(items[0].duration, 4, 'duration comes from the file, not a guess');
    assert.equal(items[0].sample_rate, 8000);
    assert.equal(items[0].state, 'ready');
  });

  test('reads tags out of a real ID3 tag too', async () => {
    const library = await makeLibrary();
    await writeTaggedMp3(path.join(library.path, 'a.mp3'), {
      title: 'Ember', artist: 'Coil', album: 'Slow Light', albumArtist: 'Coil', trackNo: 2,
    });
    await scanLibrary(library);

    const [track] = library.listTracks({ folder: '' }).items;
    assert.equal(track.title, 'Ember');
    assert.equal(track.artist, 'Coil');
    assert.equal(track.album, 'Slow Light');
    assert.equal(track.track_no, 2);
    assert.equal(track.codec, 'MPEG 1 Layer 3');
  });

  test('an untagged file still gets a usable title from its filename', async () => {
    const library = await makeLibrary();
    // No INFO chunk at all: the file has nothing but a name.
    await writeTrack(path.join(library.path, 'Rips', '04 - Cinnamon.wav'));
    await scanLibrary(library);

    const [track] = library.listTracks({ folder: 'Rips' }).items;
    assert.equal(track.title, 'Cinnamon', 'the leading index is chrome, not a title');
    assert.equal(track.album, null);
  });

  test('formats no browser can play are indexed but marked unplayable', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'plays.wav'));
    // Content does not matter here: the extension is what decides.
    await fsp.writeFile(path.join(library.path, 'old.ape'), 'not really an APE file');

    await scanLibrary(library);
    const stats = library.stats();
    assert.equal(stats.count, 2, 'both are in the library');
    assert.equal(stats.unplayable, 1);

    const opaque = library.listTracks({ folder: '' }).items.find((t) => t.ext === '.ape');
    assert.equal(opaque.state, 'unplayable');
    assert.equal(opaque.title, 'old', 'still browsable, still named');
  });

  test('skips the internal directory, hidden folders and Playlists', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'keep.wav'));
    await writeTrack(path.join(library.path, '.melora', 'trash', 'gone.wav'));
    await writeTrack(path.join(library.path, '.hidden', 'nope.wav'));
    await fsp.mkdir(path.join(library.path, 'Playlists'), { recursive: true });
    await writeTrack(path.join(library.path, 'Playlists', 'not-a-track.wav'));

    const report = await scanLibrary(library);
    assert.equal(report.added, 1);
    assert.equal(library.stats().count, 1);
  });

  test('a rescan with nothing changed does no work', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'));
    await scanLibrary(library);

    const second = await scanLibrary(library);
    assert.equal(second.added, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.unchanged, 1);
  });

  test('a moved file keeps its id, favourite, note and play count', async () => {
    const library = await makeLibrary();
    const original = path.join(library.path, 'a.wav');
    await writeTrack(original, { title: 'Drift' });
    await scanLibrary(library);

    const before = library.listTracks({ folder: '' }).items[0];
    library.updateTrack(before.id, { note: 'the good pressing', favorite: true });
    library.markPlayed(before.id);

    // Reorganised in the file manager, not in the app.
    await fsp.mkdir(path.join(library.path, 'Albums'), { recursive: true });
    await fsp.rename(original, path.join(library.path, 'Albums', 'renamed.wav'));

    const report = await scanLibrary(library);
    assert.equal(report.moved, 1);
    assert.equal(report.added, 0);

    const after = library.getTrack(before.id);
    assert.equal(after.rel_path, 'Albums/renamed.wav');
    assert.equal(after.note, 'the good pressing');
    assert.equal(after.favorite, 1);
    assert.equal(after.play_count, 1);
  });

  test('a deleted file is flagged missing, and restored if it comes back', async () => {
    const library = await makeLibrary();
    const file = path.join(library.path, 'a.wav');
    await writeTrack(file, { title: 'Gone' });
    await scanLibrary(library);
    const id = library.listTracks({ folder: '' }).items[0].id;

    const backup = await fsp.readFile(file);
    await fsp.rm(file);
    assert.equal((await scanLibrary(library)).missing, 1);
    assert.equal(library.stats().count, 0, 'missing tracks do not count as present');
    assert.equal(library.getTrack(id).missing, 1);

    await fsp.writeFile(path.join(library.path, 'back.wav'), backup);
    assert.equal((await scanLibrary(library)).restored, 1);
    assert.equal(library.getTrack(id).rel_path, 'back.wav');
  });

  test('prune forgets missing rows without touching the disk', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'));
    await writeTrack(path.join(library.path, 'b.wav'));
    await scanLibrary(library);
    await fsp.rm(path.join(library.path, 'a.wav'));
    await scanLibrary(library);

    assert.equal(pruneMissing(library).pruned, 1);
    assert.equal(library.stats().missing, 0);
    assert.ok(await fsp.stat(path.join(library.path, 'b.wav')), 'the surviving file is untouched');
  });
});

describe('verify', () => {
  test('notices a file whose bytes changed under it', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'));
    await writeTrack(path.join(library.path, 'b.wav'));
    await scanLibrary(library);

    let report = await verifyLibrary(library);
    assert.equal(report.checked, 2);
    assert.equal(report.ok, 2);

    // Silent corruption: same length, different bytes.
    const target = path.join(library.path, 'a.wav');
    const bytes = await fsp.readFile(target);
    bytes[bytes.length - 1] ^= 0xff;
    await fsp.writeFile(target, bytes);

    report = await verifyLibrary(library);
    assert.equal(report.ok, 1);
    assert.equal(report.changed.length, 1);
    assert.equal(report.changed[0].path, 'a.wav');
  });
});

describe('albums and artists', () => {
  async function stockLibrary() {
    const library = await makeLibrary();
    const hex = path.join(library.path, 'Bark Psychosis', 'Hex');
    await writeTrack(path.join(hex, '01.wav'), {
      title: 'The Loom', artist: 'Bark Psychosis', album: 'Hex', trackNo: 1, year: 1994, seconds: 3,
    });
    await writeTrack(path.join(hex, '02.wav'), {
      title: 'A Street Scene', artist: 'Bark Psychosis', album: 'Hex', trackNo: 2, year: 1994, seconds: 5,
    });
    await writeTrack(path.join(library.path, 'Talk Talk', 'Spirit', '01.wav'), {
      title: 'The Rainbow', artist: 'Talk Talk', album: 'Spirit of Eden', trackNo: 1, year: 1988, seconds: 7,
    });
    await scanLibrary(library);
    return library;
  }

  test('groups tracks into albums with a running time', async () => {
    const library = await stockLibrary();
    const { items, total } = library.listAlbums({});
    assert.equal(total, 2);

    const hex = items.find((album) => album.title === 'Hex');
    assert.equal(hex.artist, 'Bark Psychosis');
    assert.equal(hex.count, 2);
    assert.equal(hex.year, 1994);
    assert.equal(hex.seconds, 8);
  });

  test('an album opens in disc and track order', async () => {
    const library = await stockLibrary();
    const key = library.listAlbums({}).items.find((a) => a.title === 'Hex').key;
    const { album, tracks } = library.getAlbum(key);
    assert.equal(album.count, 2);
    assert.deepEqual(tracks.map((t) => t.title), ['The Loom', 'A Street Scene']);
  });

  test('untagged tracks group by the folder they sit in', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'Bootlegs', 'Berlin 1979', 'a.wav'));
    await writeTrack(path.join(library.path, 'Bootlegs', 'Berlin 1979', 'b.wav'));
    await scanLibrary(library);

    const { items } = library.listAlbums({});
    assert.equal(items.length, 1, 'one folder, one record — not two loose files');
    assert.equal(items[0].title, 'Berlin 1979', 'named after the folder it lives in');
    assert.equal(items[0].untagged, true);
    assert.equal(items[0].count, 2);
  });

  test('lists artists with their album counts', async () => {
    const library = await stockLibrary();
    const artists = library.listArtists({});
    assert.deepEqual(artists.map((a) => a.name), ['Bark Psychosis', 'Talk Talk']);
    assert.equal(artists[0].count, 2);
    assert.equal(artists[0].albums, 1);
  });

  test('searching by artist finds their tracks either way they are credited', async () => {
    const library = await stockLibrary();
    assert.equal(library.listTracks({ folder: null, artist: 'talk talk' }).total, 1);
    assert.equal(library.listTracks({ folder: null, q: 'spirit' }).total, 1, 'album name matches');
    assert.equal(library.listTracks({ folder: null, q: 'loom' }).total, 1, 'title matches');
  });
});

describe('cover art', () => {
  test('finds a cover.jpg beside the music and renders it', async () => {
    const library = await makeLibrary();
    const album = path.join(library.path, 'Slowdive', 'Souvlaki');
    await writeTrack(path.join(album, '01.wav'), { title: 'Alison', artist: 'Slowdive', album: 'Souvlaki' });
    await writeCover(path.join(album, 'cover.jpg'));
    await scanLibrary(library);

    const [track] = library.listTracks({ folder: 'Slowdive/Souvlaki' }).items;
    assert.equal(track.art_source, 'file');
    assert.match(track.art_key, /^[0-9a-f]{64}$/);

    const rendered = await ensureArt(library.path, {
      source: 'file',
      absPath: path.join(library.path, 'Slowdive', 'Souvlaki', 'cover.jpg'),
      key: track.art_key,
      size: 'thumb',
    });
    assert.ok(rendered, 'the cover renders');
    assert.ok((await fsp.stat(rendered)).size > 0);
    assert.ok(rendered.startsWith(library.path), 'the cache lives on the drive, not on this computer');
  });

  test('art embedded in the file wins over a cover beside it', async () => {
    const library = await makeLibrary();
    const album = path.join(library.path, 'Coil', 'Slow Light');
    await writeTaggedMp3(path.join(album, '01.mp3'), { title: 'Ember', album: 'Slow Light', art: true });
    await writeCover(path.join(album, 'cover.jpg'));
    await scanLibrary(library);

    const [track] = library.listTracks({ folder: 'Coil/Slow Light' }).items;
    assert.equal(track.art_source, 'embedded');

    const rendered = await ensureArt(library.path, {
      source: 'embedded',
      absPath: library.absPathOf(track),
      key: track.art_key,
      size: 'thumb',
    });
    assert.ok(rendered, 'the embedded picture renders');
  });

  test('adding artwork later is picked up by a rescan', async () => {
    const library = await makeLibrary();
    const album = path.join(library.path, 'Grouper', 'Dragging');
    await writeTrack(path.join(album, '01.wav'), { title: 'Heavy Water', album: 'Dragging' });
    await scanLibrary(library);
    assert.equal(library.listTracks({ folder: 'Grouper/Dragging' }).items[0].art_key, null);

    // The cover.jpg does not touch a single audio file, so only the dedicated
    // artwork pass can notice it.
    await writeCover(path.join(album, 'folder.jpg'));
    const report = await scanLibrary(library);
    assert.equal(report.artUpdated, 1);
    assert.ok(library.listTracks({ folder: 'Grouper/Dragging' }).items[0].art_key);
  });

  test('a folder tile borrows a cover from the albums inside it', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'Slowdive', 'Souvlaki', '01.wav'), { album: 'Souvlaki' });
    await writeCover(path.join(library.path, 'Slowdive', 'Souvlaki', 'cover.jpg'));
    await scanLibrary(library);

    const tree = library.folderTree();
    const slowdive = tree.children.find((node) => node.name === 'Slowdive');
    assert.ok(slowdive.cover, 'the artist folder shows the album art from inside it');
    assert.equal(slowdive.cover.explicit, false);
  });
});

describe('editing', () => {
  test('a favourite and a note are stored, and nothing else is', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'), { title: 'Drift', artist: 'Hanne' });
    await scanLibrary(library);
    const [track] = library.listTracks({ folder: '' }).items;

    const updated = library.updateTrack(track.id, { favorite: true, note: 'for the drive home' });
    assert.equal(updated.favorite, 1);
    assert.equal(updated.note, 'for the drive home');
    assert.equal(updated.title, 'Drift', 'the title still comes from the file');
    assert.equal(library.listTracks({ folder: null, favorite: true }).total, 1);
  });

  test('the file on disk is never rewritten by an edit', async () => {
    const library = await makeLibrary();
    const file = path.join(library.path, 'a.wav');
    await writeTrack(file, { title: 'Drift' });
    await scanLibrary(library);
    const before = await fsp.readFile(file);

    const [track] = library.listTracks({ folder: '' }).items;
    library.updateTrack(track.id, { favorite: true, note: 'x' });
    library.markPlayed(track.id);

    assert.deepEqual(await fsp.readFile(file), before, 'your audio files are read-only to Melora');
  });

  test('play counts accumulate', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'));
    await scanLibrary(library);
    const [track] = library.listTracks({ folder: '' }).items;

    library.markPlayed(track.id);
    library.markPlayed(track.id);
    const after = library.getTrack(track.id);
    assert.equal(after.play_count, 2);
    assert.ok(after.last_played > 0);
  });
});

describe('autoplay', () => {
  async function radioLibrary() {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'Hanne', 'Low Tide', '01.wav'), {
      title: 'Drift', artist: 'Hanne', album: 'Low Tide', genre: 'Ambient', year: 1990,
    });
    await writeTrack(path.join(library.path, 'Hanne', 'Later', '01.wav'), {
      title: 'Undertow', artist: 'Hanne', album: 'Later', genre: 'Pop', year: 2012,
    });
    await writeTrack(path.join(library.path, 'Various', 'haze.wav'), {
      title: 'Haze', artist: 'Someone Else', genre: 'ambient', year: 2015,
    });
    for (let n = 1; n <= 6; n += 1) {
      await writeTrack(path.join(library.path, 'Noise Co', `${n}.wav`), {
        title: `Noise ${n}`, artist: 'Noise Co', genre: 'Metal', year: 1970,
      });
    }
    await scanLibrary(library);
    const byTitle = (title) => library.listTracks({ folder: null, q: title }).items[0];
    return { library, byTitle };
  }

  test('the same artist or genre always beats an unrelated track', async () => {
    const { library, byTitle } = await radioLibrary();
    const seed = byTitle('Drift');
    for (let i = 0; i < 30; i += 1) {
      const [first, second] = library.similarTracks(seed.id, { limit: 2 }).items.map((track) => track.title);
      assert.deepEqual([first, second].sort(), ['Haze', 'Undertow'], 'same artist, and same genre in any case');
      const next = library.similarTracks(seed.id, { exclude: [byTitle('Undertow').id] }).items[0];
      assert.equal(next.title, 'Haze');
    }
  });

  test('never repeats what was excluded, then starts over rather than stopping', async () => {
    const { library, byTitle } = await radioLibrary();
    const seed = byTitle('Drift');
    const everything = library.listTracks({ folder: null, limit: 500 }).items.map((track) => track.id);

    const exclude = everything.filter((id) => id !== byTitle('Noise 4').id);
    assert.deepEqual(library.similarTracks(seed.id, { exclude }).items.map((t) => t.title), ['Noise 4']);

    const again = library.similarTracks(seed.id, { exclude: everything, limit: 50 }).items;
    assert.equal(again.length, everything.length - 1, 'every other track is back in the running');
    assert.ok(!again.some((track) => track.id === seed.id), 'but not the one that just played');
  });

  test('a missing file is never suggested, and a lone track has nothing to follow it', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'a.wav'), { title: 'Drift', artist: 'Hanne' });
    await writeTrack(path.join(library.path, 'b.wav'), { title: 'Undertow', artist: 'Hanne' });
    await scanLibrary(library);
    await fsp.rm(path.join(library.path, 'b.wav'));
    await scanLibrary(library);

    const [seed] = library.listTracks({ folder: '' }).items;
    assert.deepEqual(library.similarTracks(seed.id).items, []);
    assert.throws(() => library.similarTracks(9999), /track not found/);
  });
});

describe('folders', () => {
  test('creating and renaming a folder moves the real directory', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'Live', 'a.wav'));
    await scanLibrary(library);

    const renamed = await library.renameFolder('Live', 'Live Sets');
    assert.equal(renamed.rel_path, 'Live Sets');
    assert.ok(await fsp.stat(path.join(library.path, 'Live Sets')));
    await assert.rejects(fsp.stat(path.join(library.path, 'Live')));

    const [track] = library.listTracks({ folder: 'Live Sets' }).items;
    assert.equal(track.rel_path, 'Live Sets/a.wav', 'index rows follow the directory');
  });

  test('renaming a nested folder repoints everything beneath it', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'A', 'B', 'C', 'x.wav'));
    await scanLibrary(library);

    await library.renameFolder('A/B', 'Bee');
    assert.equal(library.listTracks({ folder: 'A/Bee/C' }).total, 1);
    assert.ok(library.getFolder('A/Bee/C'), 'grandchildren move too');
  });

  test('a duplicate folder name is refused rather than merged', async () => {
    const library = await makeLibrary();
    await library.createFolder('', 'Live');
    await assert.rejects(library.createFolder('', 'Live'), /already exists/);
  });

  test('a cover has to come from inside the folder it fronts', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'A', 'a.wav'));
    await writeTrack(path.join(library.path, 'B', 'b.wav'));
    await scanLibrary(library);

    const inB = library.listTracks({ folder: 'B' }).items[0];
    assert.throws(
      () => library.updateFolder('A', { coverTrackId: inB.id }),
      /must come from a track in that folder/,
    );
  });
});

describe('deleting', () => {
  test('a deleted track is moved to the trash on the drive, not unlinked', async () => {
    const library = await makeLibrary();
    await writeTrack(path.join(library.path, 'Album', 'a.wav'), { title: 'Regret' });
    await scanLibrary(library);
    const [track] = library.listTracks({ folder: 'Album' }).items;

    const result = await library.deleteTrack(track.id);
    assert.match(result.movedTo, /^\.melora\/trash\//);
    assert.ok(await fsp.stat(path.join(library.path, result.movedTo)), 'the bytes are still there');
    assert.equal(library.getTrack(track.id), null);
    assert.equal(library.stats().count, 0);
  });

  test('deleting the track a folder used as its cover clears the cover', async () => {
    const library = await makeLibrary();
    const album = path.join(library.path, 'Album');
    await writeTrack(path.join(album, 'a.wav'));
    await writeCover(path.join(album, 'cover.jpg'));
    await scanLibrary(library);

    const [track] = library.listTracks({ folder: 'Album' }).items;
    library.updateFolder('Album', { coverTrackId: track.id });
    await library.deleteTrack(track.id);
    assert.equal(library.getFolder('Album').cover_track_id, null);
  });

  test('two copies of one file share a cache entry, so deleting one keeps it', async () => {
    const library = await makeLibrary();
    const first = path.join(library.path, 'A', 'a.mp3');
    await writeTaggedMp3(first, { title: 'Ember', art: true });
    await copyTrack(first, path.join(library.path, 'B', 'a.mp3'));
    await scanLibrary(library);

    const tracks = library.listTracks({ folder: null, recursive: true }).items;
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].art_key, tracks[1].art_key, 'identical bytes, identical cache key');

    const rendered = await ensureArt(library.path, {
      source: 'embedded',
      absPath: library.absPathOf(tracks[0]),
      key: tracks[0].art_key,
      size: 'thumb',
    });
    await library.deleteTrack(tracks[0].id);
    assert.ok(await fsp.stat(rendered), 'the surviving copy still has its cover');
  });
});
