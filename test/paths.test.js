import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';
import {
  assertValidName, baseName, contains, parentOf, relFrom, safeJoin, sanitiseSegment, toPosix,
} from '../src/paths.js';

describe('safeJoin', () => {
  const root = path.resolve('/tmp/library');

  test('resolves ordinary relative paths', () => {
    assert.equal(safeJoin(root, 'Talk Talk/Laughing Stock/01.flac'),
      path.join(root, 'Talk Talk', 'Laughing Stock', '01.flac'));
    assert.equal(safeJoin(root, 'a.mp3'), path.join(root, 'a.mp3'));
  });

  test('refuses to climb out of the library', () => {
    for (const attempt of [
      '../secrets.txt',
      'Albums/../../secrets.txt',
      '..',
      'a/../../..',
    ]) {
      assert.throws(() => safeJoin(root, attempt), /escapes the library root/, attempt);
    }
  });

  test('refuses absolute paths and NUL bytes', () => {
    assert.throws(() => safeJoin(root, '/etc/passwd'), /expected a relative path/);
    assert.throws(() => safeJoin(root, 'C:\\Windows'), /expected a relative path/);
    assert.throws(() => safeJoin(root, 'a\0b'), /NUL byte/);
  });

  test('a name that merely starts with .. is fine', () => {
    // "..data" is a legal directory name; only real traversal is blocked.
    assert.equal(safeJoin(root, '..data/x.mp3'), path.join(root, '..data', 'x.mp3'));
  });
});

describe('contains', () => {
  test('is true for the root itself and its descendants', () => {
    assert.equal(contains('/a/b', '/a/b'), true);
    assert.equal(contains('/a/b', '/a/b/c'), true);
  });

  test('is false for siblings sharing a prefix', () => {
    assert.equal(contains('/a/b', '/a/bc'), false);
    assert.equal(contains('/a/b', '/a'), false);
  });
});

describe('posix helpers', () => {
  test('round-trips separators', () => {
    assert.equal(toPosix(path.join('a', 'b', 'c')), 'a/b/c');
  });

  test('relFrom produces posix-relative paths', () => {
    const root = path.resolve('/tmp/lib');
    assert.equal(relFrom(root, path.join(root, 'x', 'y.flac')), 'x/y.flac');
    assert.equal(relFrom(root, root), '');
  });

  test('parentOf and baseName agree on the tree shape', () => {
    assert.equal(parentOf('a/b/c'), 'a/b');
    assert.equal(parentOf('a'), '');
    assert.equal(parentOf(''), null);
    assert.equal(baseName('a/b/c'), 'c');
    assert.equal(baseName('a'), 'a');
  });
});

describe('assertValidName', () => {
  test('accepts and trims ordinary names', () => {
    assert.equal(assertValidName('  Laughing Stock '), 'Laughing Stock');
    assert.equal(assertValidName('Sigur Rós — ( )'), 'Sigur Rós — ( )');
  });

  test('rejects anything that would not survive a round trip between platforms', () => {
    for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a|b', 'a\0b']) {
      assert.throws(() => assertValidName(bad), Error, JSON.stringify(bad));
    }
  });

  test('rejects Windows reserved names and trailing periods', () => {
    assert.throws(() => assertValidName('CON'), /reserved/);
    assert.throws(() => assertValidName('lpt1.txt'), /reserved/);
    assert.throws(() => assertValidName('album.'), /period/);
  });

  test('rejects leading dots so folders cannot hide from the scanner', () => {
    // The scanner skips dot-directories, so a folder named ".x" would be
    // created and then immediately vanish from the index.
    assert.throws(() => assertValidName('.hidden'), /start with a period/);
  });
});

describe('sanitiseSegment', () => {
  test('tidies a tag into something every filesystem accepts', () => {
    // Refusing to import "AC/DC" would be worse than filing it under a name
    // that survives a copy to a FAT-formatted drive.
    assert.equal(sanitiseSegment('AC/DC'), 'AC DC');
    assert.equal(sanitiseSegment('Where?: The Album*'), 'Where The Album');
    assert.equal(sanitiseSegment('  spaced   out  '), 'spaced out');
    assert.equal(sanitiseSegment('trailing dots...'), 'trailing dots');
  });

  test('falls back rather than producing an unusable name', () => {
    assert.equal(sanitiseSegment('', 'Unknown artist'), 'Unknown artist');
    assert.equal(sanitiseSegment(null, 'Unknown album'), 'Unknown album');
    assert.equal(sanitiseSegment('///'), 'Unknown');
    assert.equal(sanitiseSegment('..'), 'Unknown');
    assert.equal(sanitiseSegment('NUL'), 'Unknown', 'reserved on Windows');
  });

  test('keeps names short enough to nest without blowing a path limit', () => {
    assert.ok(sanitiseSegment('x'.repeat(400)).length <= 80);
  });
});
