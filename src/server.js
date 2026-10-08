import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { cacheStats, clearCache, ensureArt, isValidSize } from './art.js';
import { CONTENT_TYPES } from './audio.js';
import { loadConfig, saveConfig } from './config.js';
import { JobManager, publicView } from './jobs.js';
import { Library } from './library.js';
import { safeJoin } from './paths.js';
import { pruneMissing, scanLibrary, verifyLibrary } from './scanner.js';
import { normaliseSource, syncSources } from './sync.js';
import { mapPool } from './util.js';
import { freeSpace, initLibrary, mountRoots, readMarker, VolumeWatcher } from './volume.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

/** Hosts allowed in the Host header. Anything else is a rebinding attempt. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

/** Wrap an async handler so a rejected promise becomes a 4xx/5xx, not a hang. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createServer({ config = loadConfig() } = {}) {
  const state = {
    config,
    library: null,
    jobs: new JobManager(),
    // Cover rendering is CPU-bound; without a gate, opening a wall of albums
    // would start a hundred decodes at once.
    renderSlots: 4,
    renderQueue: [],
  };

  const watcher = new VolumeWatcher({
    getVolume: () => state.config.volume,
    getExtraRoots: () => state.config.extraMountRoots ?? [],
    intervalMs: state.config.watch?.intervalMs ?? 4000,
  });

  watcher.on('mounted', ({ path: libraryPath, marker }) => {
    try {
      state.library = new Library(libraryPath, marker);
    } catch (err) {
      state.library = null;
      console.error(`[melora] could not open the library at ${libraryPath}: ${err.message}`);
      return;
    }
    // Remember where it turned up, so next time is a single stat.
    state.config = saveConfig({
      ...state.config,
      volume: { ...state.config.volume, label: marker.label, lastPath: libraryPath },
    });
    console.log(`[melora] library unlocked at ${libraryPath}`);
    if (state.config.scanOnUnlock) startScan(state);
  });

  watcher.on('unmounted', ({ path: libraryPath }) => {
    console.log(`[melora] library at ${libraryPath} went away — locking`);
    // Cancel first: a job mid-write against a yanked drive throws EIO, and
    // there is nothing useful it can do once the files are gone.
    state.jobs.cancelAll();
    state.library?.close();
    state.library = null;
  });

  watcher.on('error', (err) => console.error(`[melora] volume watcher: ${err.message}`));

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // --- guards ---------------------------------------------------------------

  app.use((req, res, next) => {
    // A page on the open internet can point a <script> or an <audio> at
    // 127.0.0.1, and DNS rebinding can get around the browser's origin rules.
    // Pinning the Host header closes that off.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!LOCAL_HOSTS.has(host) && host !== (state.config.server?.host ?? '').toLowerCase()) {
      return fail(res, 403, 'unexpected Host header');
    }
    // Everything is served from this origin; nothing is fetched from anywhere.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'; " +
        "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return next();
  });

  app.use(express.json({ limit: '256kb' }));

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /**
   * The lock. Every route that could reveal something about the music sits
   * behind it, audio and metadata alike — a library you can still read the
   * track titles of with the drive unplugged is not locked.
   */
  const gate = (req, res, next) => {
    if (!state.library) {
      return fail(
        res,
        423,
        state.config.volume ? 'the library drive is not connected' : 'no library has been set up yet',
      );
    }
    return next();
  };

  // --- status and setup -----------------------------------------------------

  app.get('/api/status', wrap(async (req, res) => {
    const volume = state.config.volume;
    const space = state.library ? freeSpace(state.library.path) : null;
    res.json({
      configured: Boolean(volume),
      locked: !state.library,
      platform: process.platform,
      volume: volume
        ? {
            label: volume.label ?? 'Melora library',
            lastPath: volume.lastPath ?? null,
            path: state.library?.path ?? null,
            free: space?.free ?? null,
            total: space?.total ?? null,
          }
        : null,
      library: state.library ? state.library.stats() : null,
      jobs: state.jobs.list().slice(0, 5),
      settings: {
        scanOnUnlock: state.config.scanOnUnlock,
        sources: state.config.sync?.sources ?? [],
        watchIntervalMs: state.config.watch?.intervalMs,
      },
    });
  }));

  app.post('/api/volume/init', wrap(async (req, res) => {
    const target = String(req.body?.path ?? '').trim();
    if (!target) return fail(res, 400, 'a folder path is required');
    if (!path.isAbsolute(target)) return fail(res, 400, 'the path must be absolute');

    const result = await initLibrary(target, req.body?.label);
    state.config = saveConfig({
      ...state.config,
      volume: { id: result.id, label: result.label, lastPath: result.path },
    });
    await watcher.check();
    return res.json({ ok: true, adopted: result.adopted, label: result.label, path: result.path });
  }));

  app.post('/api/volume/attach', wrap(async (req, res) => {
    const target = String(req.body?.path ?? '').trim();
    if (!target) return fail(res, 400, 'a folder path is required');
    const marker = await readMarker(target);
    if (!marker) return fail(res, 404, 'no Melora library found in that folder');

    state.config = saveConfig({
      ...state.config,
      volume: { id: marker.id, label: marker.label, lastPath: path.resolve(target) },
    });
    await watcher.check();
    return res.json({ ok: true, label: marker.label, path: path.resolve(target) });
  }));

  app.post('/api/volume/forget', wrap(async (req, res) => {
    state.jobs.cancelAll();
    state.library?.close();
    state.library = null;
    watcher.reset();
    state.config = saveConfig({ ...state.config, volume: null });
    res.json({ ok: true });
  }));

  app.post('/api/volume/recheck', wrap(async (req, res) => {
    await watcher.check();
    res.json({ ok: true, locked: !state.library });
  }));

  /**
   * Where to start looking. An external drive is the point of the exercise, so
   * the picker opens on the first mount root that actually has something in it
   * rather than on the home folder, which is never the answer.
   */
  const pickerShortcuts = async () => {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const candidates = [
      ...(home ? [{ name: 'Home', path: path.resolve(home) }] : []),
      ...mountRoots(state.config.extraMountRoots ?? []).map((root) => ({
        name: path.basename(root) || root,
        path: root,
      })),
    ];
    const usable = [];
    for (const candidate of candidates) {
      const entries = await fsp.readdir(candidate.path).catch(() => null);
      if (entries) usable.push({ ...candidate, populated: entries.length > 0 });
    }
    return usable;
  };

  /**
   * Directory listing for the setup screen's folder picker. Deliberately
   * limited to directory names — it never reveals file contents, and it is the
   * only route that reads outside the library.
   */
  app.get('/api/browse', wrap(async (req, res) => {
    const target = req.query.path ? String(req.query.path) : null;
    const shortcuts = await pickerShortcuts();
    const fallback =
      shortcuts.find((entry) => entry.name !== 'Home' && entry.populated)?.path ??
      shortcuts[0]?.path ??
      '/';
    const dir = target && path.isAbsolute(target) ? path.resolve(target) : fallback;
    let entries = [];
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, 500);
    } catch (err) {
      return fail(res, err.code === 'ENOENT' ? 404 : 403, `cannot read ${dir}`);
    }
    const parent = path.dirname(dir);
    return res.json({
      path: dir,
      parent: parent === dir ? null : parent,
      entries,
      shortcuts: shortcuts.map(({ name, path: at }) => ({ name, path: at })),
    });
  }));

  app.get('/api/config', wrap(async (req, res) => {
    res.json({
      server: state.config.server,
      watch: state.config.watch,
      sync: state.config.sync,
      scanOnUnlock: state.config.scanOnUnlock,
      extraMountRoots: state.config.extraMountRoots,
    });
  }));

  app.patch('/api/config', wrap(async (req, res) => {
    const next = { ...state.config };
    const body = req.body ?? {};

    if (body.sync?.sources !== undefined) {
      if (!Array.isArray(body.sync.sources)) return fail(res, 400, 'sync.sources must be an array');
      next.sync = { ...next.sync, sources: body.sync.sources.map(normaliseSource) };
    }
    if (body.scanOnUnlock !== undefined) next.scanOnUnlock = Boolean(body.scanOnUnlock);
    if (body.extraMountRoots !== undefined) {
      if (!Array.isArray(body.extraMountRoots)) return fail(res, 400, 'extraMountRoots must be an array');
      next.extraMountRoots = body.extraMountRoots.map((p) => path.resolve(String(p)));
    }
    if (body.watch?.intervalMs !== undefined) {
      const ms = Number(body.watch.intervalMs);
      if (!Number.isFinite(ms) || ms < 1000 || ms > 120000) {
        return fail(res, 400, 'watch interval must be between 1000 and 120000 ms');
      }
      next.watch = { ...next.watch, intervalMs: ms };
      watcher.intervalMs = ms;
      watcher.stop();
      watcher.start();
    }

    state.config = saveConfig(next);
    return res.json({
      ok: true,
      config: {
        sync: state.config.sync,
        scanOnUnlock: state.config.scanOnUnlock,
        watch: state.config.watch,
        extraMountRoots: state.config.extraMountRoots,
      },
    });
  }));

  // --- folders --------------------------------------------------------------

  app.get('/api/folders', gate, wrap(async (req, res) => {
    res.json({ tree: state.library.folderTree() });
  }));

  app.get('/api/folder', gate, wrap(async (req, res) => {
    const relPath = String(req.query.path ?? '');
    const folder = state.library.getFolder(relPath);
    if (!folder) return fail(res, 404, 'folder not found');
    return res.json({ folder });
  }));

  app.post('/api/folders', gate, wrap(async (req, res) => {
    const parent = String(req.body?.parent ?? '');
    const folder = await state.library.createFolder(parent, String(req.body?.name ?? ''));
    res.status(201).json({ folder });
  }));

  app.patch('/api/folders', gate, wrap(async (req, res) => {
    const relPath = String(req.body?.path ?? '');
    let folder = state.library.getFolder(relPath);
    if (!folder) return fail(res, 404, 'folder not found');

    if (req.body?.name !== undefined) {
      folder = await state.library.renameFolder(relPath, String(req.body.name));
    }
    if (req.body?.description !== undefined || req.body?.coverTrackId !== undefined) {
      folder = state.library.updateFolder(folder.rel_path, {
        description: req.body.description,
        coverTrackId: req.body.coverTrackId,
      });
    }
    return res.json({ folder });
  }));

  // --- tracks ---------------------------------------------------------------

  app.get('/api/tracks', gate, wrap(async (req, res) => {
    const { folder = '', recursive, q, favorite, album, artist, genre, sort, limit, offset } = req.query;
    res.json(
      state.library.listTracks({
        folder: String(folder),
        recursive: recursive === '1' || recursive === 'true',
        q: q ? String(q).slice(0, 200) : '',
        favorite: favorite === '1' || favorite === 'true',
        album: album ? String(album).slice(0, 500) : null,
        artist: artist ? String(artist).slice(0, 300) : null,
        genre: genre ? String(genre).slice(0, 120) : null,
        sort: sort ? String(sort) : 'album_asc',
        limit,
        offset,
      }),
    );
  }));

  app.get('/api/tracks/:id', gate, wrap(async (req, res) => {
    const track = state.library.getTrack(req.params.id);
    if (!track) return fail(res, 404, 'track not found');
    return res.json({ track });
  }));

  app.patch('/api/tracks/:id', gate, wrap(async (req, res) => {
    res.json({ track: state.library.updateTrack(req.params.id, req.body ?? {}) });
  }));

  app.post('/api/tracks/:id/played', gate, wrap(async (req, res) => {
    res.json({ track: state.library.markPlayed(req.params.id) });
  }));

  app.delete('/api/tracks/:id', gate, wrap(async (req, res) => {
    res.json(await state.library.deleteTrack(req.params.id));
  }));

  /**
   * Audio.
   *
   * `no-store` on every response, and it is not an oversight: a browser disk
   * cache full of FLACs on the internal drive would quietly undo the thing
   * this app is for. Seeking still works — a range request is answered from
   * the drive each time, which is what `acceptRanges` below is for.
   */
  app.get('/api/tracks/:id/stream', gate, wrap(async (req, res) => {
    const track = state.library.getTrack(req.params.id);
    if (!track) return fail(res, 404, 'track not found');
    if (track.state === 'unplayable') {
      return fail(res, 415, 'no browser can play this format — the file is on the drive, though');
    }

    const abs = state.library.absPathOf(track);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Type', CONTENT_TYPES[track.ext] ?? 'application/octet-stream');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(track.filename)}"`);
    }
    return new Promise((resolve, reject) => {
      res.sendFile(abs, { dotfiles: 'allow', acceptRanges: true }, (err) => (err ? reject(err) : resolve()));
    });
  }));

  /** Bounded cover rendering, so a wall of albums cannot swamp the CPU. */
  const renderLimited = (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        state.renderSlots -= 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            state.renderSlots += 1;
            state.renderQueue.shift()?.();
          });
      };
      if (state.renderSlots > 0) run();
      else state.renderQueue.push(run);
    });

  app.get('/api/tracks/:id/art', gate, wrap(async (req, res) => {
    const size = req.query.size ? String(req.query.size) : 'thumb';
    if (!isValidSize(size)) return fail(res, 400, 'unknown size');

    const track = state.library.getTrack(req.params.id);
    if (!track) return fail(res, 404, 'track not found');
    if (!track.art_key) return fail(res, 404, 'this track has no cover art');

    const library = state.library;
    const absPath =
      track.art_source === 'embedded'
        ? library.absPathOf(track)
        : safeJoin(library.path, track.art_path ?? '');

    const file = await renderLimited(() =>
      ensureArt(library.path, { source: track.art_source, absPath, key: track.art_key, size }),
    );
    if (!file) {
      // Forget the art only when the file it came from has actually gone, so
      // the grid draws a blank record immediately next time instead of
      // retrying every scroll. A render that failed while the file is still
      // sitting there is worth trying again: clearing the row on a passing
      // failure would hide a cover that is really on the drive until the file
      // itself changed and a scan looked at it afresh.
      const sourceGone = await fsp.stat(absPath).then(() => false, () => true);
      if (sourceGone && state.library === library) {
        library.db
          .prepare('UPDATE tracks SET art_source = NULL, art_key = NULL, art_path = NULL WHERE id = ?')
          .run(track.id);
      }
      return fail(res, 404, 'the cover art could not be read');
    }

    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    return new Promise((resolve, reject) => {
      res.sendFile(file, { dotfiles: 'allow' }, (err) => (err ? reject(err) : resolve()));
    });
  }));

  // --- albums and artists ---------------------------------------------------

  app.get('/api/albums', gate, wrap(async (req, res) => {
    const { q, artist, sort, limit, offset } = req.query;
    res.json(
      state.library.listAlbums({
        q: q ? String(q).slice(0, 200) : '',
        artist: artist ? String(artist).slice(0, 300) : null,
        sort: sort ? String(sort) : 'artist_asc',
        limit,
        offset,
      }),
    );
  }));

  /** Album keys carry spaces and colons, so they travel as a query parameter. */
  app.get('/api/album', gate, wrap(async (req, res) => {
    const key = String(req.query.key ?? '');
    if (!key) return fail(res, 400, 'an album key is required');
    const found = state.library.getAlbum(key);
    if (!found) return fail(res, 404, 'album not found');
    return res.json(found);
  }));

  app.get('/api/artists', gate, wrap(async (req, res) => {
    res.json({ artists: state.library.listArtists({ q: req.query.q ? String(req.query.q) : '' }) });
  }));

  // --- playlists ------------------------------------------------------------

  app.get('/api/playlists', gate, wrap(async (req, res) => {
    res.json({ playlists: state.library.listPlaylists() });
  }));

  app.get('/api/playlists/:id', gate, wrap(async (req, res) => {
    const found = state.library.getPlaylist(req.params.id);
    if (!found) return fail(res, 404, 'playlist not found');
    return res.json(found);
  }));

  app.post('/api/playlists', gate, wrap(async (req, res) => {
    const playlist = await state.library.createPlaylist(String(req.body?.name ?? ''), {
      description: req.body?.description ?? null,
    });
    if (Array.isArray(req.body?.trackIds) && req.body.trackIds.length > 0) {
      await state.library.addToPlaylist(playlist.id, req.body.trackIds);
    }
    res.status(201).json({ playlist });
  }));

  app.patch('/api/playlists/:id', gate, wrap(async (req, res) => {
    const playlist = await state.library.renamePlaylist(req.params.id, req.body?.name, {
      description: req.body?.description,
    });
    res.json({ playlist });
  }));

  app.put('/api/playlists/:id/tracks', gate, wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.trackIds) ? req.body.trackIds : [];
    res.json(await state.library.setPlaylistTracks(req.params.id, ids));
  }));

  app.post('/api/playlists/:id/tracks', gate, wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.trackIds)
      ? req.body.trackIds
      : req.body?.trackId !== undefined
        ? [req.body.trackId]
        : [];
    if (ids.length === 0) return fail(res, 400, 'no tracks given');
    return res.json(await state.library.addToPlaylist(req.params.id, ids));
  }));

  app.delete('/api/playlists/:id', gate, wrap(async (req, res) => {
    res.json(await state.library.deletePlaylist(req.params.id));
  }));

  // --- jobs -----------------------------------------------------------------

  function startScan(current = state) {
    if (!current.library) return null;
    const library = current.library;
    return current.jobs.start('scan', ({ onProgress, signal }) =>
      scanLibrary(library, { onProgress, signal }),
    );
  }

  app.post('/api/jobs/scan', gate, wrap(async (req, res) => {
    res.json({ job: publicView(startScan()) });
  }));

  app.post('/api/jobs/sync', gate, wrap(async (req, res) => {
    const sources = req.body?.sources ?? state.config.sync?.sources ?? [];
    if (!Array.isArray(sources) || sources.length === 0) {
      return fail(res, 400, 'no sync sources are configured');
    }
    const library = state.library;
    const job = state.jobs.start('sync', async ({ onProgress, signal }) => {
      const result = await syncSources(library, sources, { onProgress, signal });
      // Fold anything that arrived outside the copy loop into the index too.
      await scanLibrary(library, { onProgress, signal });
      return result;
    });
    return res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/verify', gate, wrap(async (req, res) => {
    const library = state.library;
    const job = state.jobs.start('verify', ({ onProgress, signal }) =>
      verifyLibrary(library, { onProgress, signal }),
    );
    res.json({ job: publicView(job) });
  }));

  /** Pre-render every cover that has not been made yet. */
  app.post('/api/jobs/artwork', gate, wrap(async (req, res) => {
    const library = state.library;
    const job = state.jobs.start('artwork', async ({ onProgress, signal }) => {
      // One render per distinct cover: an album's worth of tracks shares one.
      const rows = library.db
        .prepare(
          `SELECT MIN(id) AS id, art_key, art_source, MIN(art_path) AS art_path, MIN(rel_path) AS rel_path
           FROM tracks WHERE missing = 0 AND art_key IS NOT NULL GROUP BY art_key`,
        )
        .all();
      let processed = 0;
      let failed = 0;
      await mapPool(rows, 4, async (row) => {
        if (signal.aborted) return;
        const absPath =
          row.art_source === 'embedded'
            ? safeJoin(library.path, row.rel_path)
            : safeJoin(library.path, row.art_path ?? '');
        const file = await ensureArt(library.path, {
          source: row.art_source,
          absPath,
          key: row.art_key,
          size: 'thumb',
        });
        if (!file) failed += 1;
        processed += 1;
        onProgress({ phase: 'rendering', processed, total: rows.length, current: row.art_path ?? row.rel_path });
      });
      return { rendered: processed - failed, undecodable: failed, total: rows.length };
    });
    res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/prune', gate, wrap(async (req, res) => {
    res.json(pruneMissing(state.library));
  }));

  app.get('/api/jobs', gate, wrap(async (req, res) => {
    res.json({ jobs: state.jobs.list() });
  }));

  app.get('/api/jobs/:id', gate, wrap(async (req, res) => {
    const job = state.jobs.get(req.params.id);
    if (!job) return fail(res, 404, 'job not found');
    return res.json({ job: publicView(job) });
  }));

  app.post('/api/jobs/:id/cancel', gate, wrap(async (req, res) => {
    res.json({ ok: state.jobs.cancel(req.params.id) });
  }));

  // --- cache ----------------------------------------------------------------

  app.get('/api/cache', gate, wrap(async (req, res) => {
    res.json(await cacheStats(state.library.path));
  }));

  app.delete('/api/cache', gate, wrap(async (req, res) => {
    await clearCache(state.library.path);
    res.json({ ok: true });
  }));

  // --- static ---------------------------------------------------------------

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      dotfiles: 'ignore',
      // The UI is small and served from disk; revalidating keeps a rebuilt
      // client from being shadowed by a stale cached copy.
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  app.use('/api', (req, res) => fail(res, 404, 'no such endpoint'));
  app.use((req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  app.use((err, req, res, next) => {
    // A transfer that dies partway — the drive pulled mid-track, the browser
    // navigating away — lands here with the response already open. Express's
    // own handler knows to close the socket; ours cannot.
    if (res.headersSent) return next(err);
    const status = err.status ?? (err.code === 'ENOENT' ? 404 : 500);
    if (status >= 500) console.error('[melora]', err);
    return res.status(status).json({ error: err.message ?? 'something went wrong' });
  });

  return { app, state, watcher, startScan };
}

export async function startServer(options = {}) {
  const { app, state, watcher } = createServer(options);
  const { host = '127.0.0.1', port = 4610 } = state.config.server ?? {};

  await watcher.check();
  watcher.start();

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.on('error', reject);
  });

  return {
    app,
    state,
    watcher,
    server,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`,
    async close() {
      watcher.stop();
      state.jobs.cancelAll();
      state.library?.close();
      state.library = null;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
