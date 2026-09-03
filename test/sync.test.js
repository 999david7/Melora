import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test, { after, describe } from 'node:test';
import { Library } from '../src/library.js';
import { scanLibrary } from '../src/scanner.js';
import { normaliseSource, syncSources } from '../src/sync.js';
import { initLibrary } from '../src/volume.js';
import { cleanup, copyTrack, listFiles, tempDir, writeCover, writeTrack } from './helpers.js';

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

after(() => { for (const library of open) library.close(); });

describe('normaliseSource', () => {
  test('fills in the defaults', () => {
    const source = normaliseSource({ path: '/home/you/Music' });
    assert.equal(source.into, 'Imported');
    assert.equal(source.organizeBy, 'artist');
    assert.equal(source.path, path.resolve('/home/you/Music'));
  });

  test('refuses an unknown layout and a missing path', () => {
    assert.throws(() => normaliseSource({ path: '/x', organizeBy: 'whatever' }), /organizeBy/);
    assert.throws(() => normaliseSource({}), /needs a path/);
  });

  test('`into` is a name, not a path, so an import cannot be steered off the drive', () => {
    assert.throws(() => normaliseSource({ path: '/x', into: '../../elsewhere' }), Error);
    assert.throws(() => normaliseSource({ path: '/x', into: '/etc' }), Error);
  });
});

describe('importing', () => {
  test('copies new tracks in and files them by artist and album', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'one.wav'), {
      title: 'Alison', artist: 'Slowdive', album: 'Souvlaki', trackNo: 1,
    });
    await writeTrack(path.join(source, 'nested', 'two.wav'), {
      title: 'Machine Gun', artist: 'Slowdive', album: 'Souvlaki', trackNo: 2,
    });

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 2);
    assert.ok(report.bytes > 0);

    const files = await listFiles(library.path);
    assert.ok(files.includes('Imported/Slowdive/Souvlaki/one.wav'), files.join(', '));
    assert.ok(files.includes('Imported/Slowdive/Souvlaki/two.wav'));
    assert.equal(library.stats().count, 2, 'imported tracks are indexed without a rescan');
  });

  test('the source folder is left exactly as it was', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a.wav'), { title: 'Keep me' });
    const before = await listFiles(source);
    const bytes = await fsp.readFile(path.join(source, 'a.wav'));

    await syncSources(library, [{ path: source }]);

    assert.deepEqual(await listFiles(source), before, 'nothing moved, renamed or deleted');
    assert.deepEqual(await fsp.readFile(path.join(source, 'a.wav')), bytes);
  });

  test('the same file imported twice lands once', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    const first = await writeTrack(path.join(source, 'a.wav'), { title: 'Twice' });
    // A second copy under a different name, and the same folder synced again.
    await copyTrack(first, path.join(source, 'copy-of-a.wav'));

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 1);
    assert.equal(report.duplicates, 1, 'identical bytes are recognised by hash');

    const second = await syncSources(library, [{ path: source }]);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2, 'a repeat sync does not even re-hash them');
  });

  test('mirror keeps the source layout and flat collapses it', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'Live', '1997', 'a.wav'), { title: 'A' });

    await syncSources(library, [{ path: source, into: 'Mirrored', organizeBy: 'mirror' }]);
    assert.ok((await listFiles(library.path)).includes('Mirrored/Live/1997/a.wav'));

    const other = await tempDir();
    await writeTrack(path.join(other, 'deep', 'b.wav'), { title: 'B' });
    await syncSources(library, [{ path: other, into: 'Flat', organizeBy: 'flat' }]);
    assert.ok((await listFiles(library.path)).includes('Flat/b.wav'));
  });

  test('untagged files land under a name rather than being refused', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'mystery.wav'));

    await syncSources(library, [{ path: source }]);
    const files = await listFiles(library.path);
    assert.ok(files.includes('Imported/Unknown artist/Unknown album/mystery.wav'), files.join(', '));
  });

  test('a name that no filesystem would accept is tidied, not rejected', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a.wav'), { artist: 'AC/DC', album: 'Back: In Black' });

    await syncSources(library, [{ path: source }]);
    assert.ok((await listFiles(library.path)).includes('Imported/AC DC/Back In Black/a.wav'));
  });

  test('two different tracks with the same filename both survive', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a', 'track.wav'), { artist: 'X', album: 'Y', title: 'One', seconds: 1 });
    await writeTrack(path.join(source, 'b', 'track.wav'), { artist: 'X', album: 'Y', title: 'Two', seconds: 2 });

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.imported, 2);
    const files = (await listFiles(library.path)).filter((f) => f.startsWith('Imported/'));
    assert.deepEqual(files.sort(), ['Imported/X/Y/track-1.wav', 'Imported/X/Y/track.wav']);
  });

  test('cover art beside the music comes across too', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a.wav'), { artist: 'Slowdive', album: 'Souvlaki' });
    await writeCover(path.join(source, 'cover.jpg'));

    const report = await syncSources(library, [{ path: source }]);
    assert.equal(report.artwork, 1);
    assert.ok((await listFiles(library.path)).includes('Imported/Slowdive/Souvlaki/cover.jpg'));

    await scanLibrary(library);
    assert.ok(library.listTracks({ folder: null, recursive: true }).items[0].art_key);
  });

  test('a corrupted copy is deleted rather than left in the library', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a.wav'), { title: 'Truncated' });

    // Stand in for a bad cable or a full disk: what lands is not what was read.
    const original = fsp.copyFile;
    fsp.copyFile = async (from, to) => { await fsp.writeFile(to, 'half a file'); };
    try {
      const report = await syncSources(library, [{ path: source }]);
      assert.equal(report.imported, 0);
      assert.equal(report.failed, 1);
      assert.match(report.errors[0].error, /did not match the source/);
    } finally {
      fsp.copyFile = original;
    }

    const stray = (await listFiles(library.path)).filter((f) => f.startsWith('Imported/'));
    assert.deepEqual(stray, [], 'a bad copy leaves nothing behind');
  });

  test('a source inside the library is refused', async () => {
    const library = await makeLibrary();
    const inside = path.join(library.path, 'Albums');
    await writeTrack(path.join(inside, 'a.wav'));

    const report = await syncSources(library, [{ path: inside }]);
    assert.equal(report.imported, 0);
    assert.match(report.errors[0].error, /inside the library/);
  });

  test('a source folder that is not there is reported, not thrown', async () => {
    const library = await makeLibrary();
    const report = await syncSources(library, [{ path: path.join(await tempDir(), 'nope') }]);
    assert.equal(report.imported, 0);
    assert.match(report.errors[0].error, /not found/);
  });

  test('importing then scanning does not duplicate anything', async () => {
    const library = await makeLibrary();
    const source = await tempDir();
    await writeTrack(path.join(source, 'a.wav'), { artist: 'X', album: 'Y' });

    await syncSources(library, [{ path: source }]);
    const report = await scanLibrary(library);
    assert.equal(report.added, 0, 'the sync already indexed it');
    assert.equal(library.stats().count, 1);
  });
});
