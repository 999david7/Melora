import { Player } from './player.js';
import {
  $, askChoice, askFields, askText, clear, confirmAction, debounce, el, formatBytes, formatDate,
  formatDuration, formatSpan, icon, plural, toast,
} from './ui.js';

/** Chrome labels are uppercase everywhere; do it in one place. */
const caps = (value) => String(value).toUpperCase();

/* Melora client.
   One page, three states: setting up, locked, and listening. The server is the
   authority on which — a poll of /api/status decides what is on screen, so the
   moment the drive is pulled the library goes away without the client having
   to guess. */

const PAGE = 150;

const state = {
  status: null,
  tree: null,
  playlists: [],
  // Opens on the whole library, which is what the lit TRACKS segment claims.
  view: { mode: 'all', folder: '', album: null, artist: null, playlist: null, q: '', sort: 'album_asc' },
  items: [],
  cards: [],
  hero: null,
  total: 0,
  seconds: 0,
  loading: false,
  exhausted: false,
  expanded: new Set(['']),
  rows: new Map(),
  watchedJob: null,
  browsePath: null,
  browseParent: null,
};

const player = new Player($('#audio'));

// ------------------------------------------------------------------- fetching

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 423) {
    // The drive went away between the click and the request. Re-read status so
    // the lock screen comes up instead of a stray error.
    refreshStatus();
    throw new ApiError('the drive is not connected', 423);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error ?? response.statusText, response.status);
  return payload;
}

/** Run an action, surfacing any failure as a toast rather than a console trace. */
async function attempt(fn, { silent423 = true } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 423 || !silent423) {
      toast(err.message ?? 'something went wrong', 'bad');
    }
    return null;
  }
}

const artUrl = (trackId, size = 'thumb') => `/api/tracks/${trackId}/art?size=${size}`;

/** A cover, or the blank record that stands in for one. */
function coverInto(node, trackId, { size = 'thumb', alt = '' } = {}) {
  clear(node);
  if (!trackId) {
    node.append(icon('i-disc'));
    return node;
  }
  const img = el('img', {
    loading: 'lazy',
    decoding: 'async',
    alt,
    src: artUrl(trackId, size),
    onLoad: (event) => event.target.classList.add('loaded'),
    onError: (event) => { event.target.remove(); node.append(icon('i-disc')); },
  });
  node.append(img);
  return node;
}

// --------------------------------------------------------------------- status

let previousLocked = null;

async function refreshStatus() {
  let status;
  try {
    status = await api('/api/status');
  } catch {
    return; // Server restarting or gone; the next poll will find it.
  }
  state.status = status;

  const setup = !status.configured;
  const locked = status.locked;

  $('#gate').hidden = !(setup || locked);
  $('#gate-setup').hidden = !setup;
  $('#gate-locked').hidden = setup || !locked;
  $('#app').hidden = setup || locked;
  if (locked || setup) {
    closeQueue();
    player.clear();
    // A <dialog> opened with showModal() sits in the browser's top layer, so
    // hiding #app leaves it on screen — still showing the library path after
    // the drive is gone. Close it explicitly.
    if ($('#settings').open) $('#settings').close();
  }

  if (setup && state.browsePath === null) browseTo(null);

  if (locked && !setup) {
    $('#gate-drive-label').textContent = status.volume?.label ?? 'your library';
    $('#gate-message').textContent =
      'Your music lives on an external drive, and that drive is not connected right now.';
  }

  if (!locked && !setup && previousLocked !== false) {
    // Crossing from locked to unlocked: rebuild the world. The drive can
    // vanish again mid-rebuild, so failing here is expected — leave
    // `previousLocked` alone and the next poll will try again.
    renderDriveStatus(status);
    try {
      await loadTree();
      await loadPlaylists();
      resetView();
    } catch {
      return;
    }
  } else if (!locked && !setup) {
    renderDriveStatus(status);
  }
  previousLocked = locked;

  renderJob(status.jobs?.find((job) => job.status === 'running') ?? null);
}

function renderDriveStatus(status) {
  $('#drive-name').textContent = caps(status.volume?.label ?? 'Library');
  $('#drive-space').textContent = status.volume?.free ? `${formatBytes(status.volume.free)} FREE` : '';

  const library = status.library;
  $('#count-all').textContent = library ? library.count.toLocaleString() : '';
  $('#count-albums').textContent = library?.albums ? library.albums.toLocaleString() : '';
  $('#count-artists').textContent = library?.artists ? library.artists.toLocaleString() : '';
  $('#count-fav').textContent = library?.favorites ? library.favorites.toLocaleString() : '';

  const stats = clear($('#lib-stats'));
  if (!library) return;
  const rows = [
    plural(library.count, 'track'),
    `${plural(library.albums, 'album')} · ${plural(library.artists, 'artist')}`,
    formatSpan(library.seconds),
    formatBytes(library.bytes),
    library.unplayable ? `${library.unplayable} not playable here` : null,
    library.missing ? `${library.missing} missing` : null,
  ];
  for (const row of rows) {
    if (row) stats.append(el('p', { class: 'dash-row' }, el('span', { class: 'v', text: row })));
  }
}

// ---------------------------------------------------------------- folder tree

async function loadTree() {
  const { tree } = await api('/api/folders');
  state.tree = tree;
  renderTree();
}

async function loadPlaylists() {
  const { playlists } = await api('/api/playlists');
  state.playlists = playlists;
  renderPlaylists();
}

function findNode(node, path) {
  if (!node) return null;
  if (node.path === path) return node;
  for (const child of node.children) {
    const hit = findNode(child, path);
    if (hit) return hit;
  }
  return null;
}

function renderTree() {
  const host = clear($('#tree'));
  if (!state.tree) return;
  for (const child of state.tree.children) host.append(treeRow(child));
  if (state.tree.children.length === 0) {
    host.append(el('p', { class: 'tree-empty', text: 'No folders yet. Make one with the + above.' }));
  }
}

function treeRow(node) {
  const expanded = state.expanded.has(node.path);
  const current = state.view.mode === 'folder' && state.view.folder === node.path;

  const twist = el('button', {
    class: `tree-twist${node.children.length ? '' : ' leaf'}`,
    'aria-expanded': String(expanded),
    'aria-label': expanded ? 'Collapse' : 'Expand',
    onClick: (event) => {
      event.stopPropagation();
      if (expanded) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderTree();
    },
  }, icon('i-chevron'));

  const row = el(
    'div',
    { class: 'tree-row', 'aria-current': String(current) },
    twist,
    el(
      'button',
      { class: 'tree-label', onClick: () => openFolder(node.path) },
      icon('i-folder'),
      el('span', { class: 'tree-name', text: node.name, title: node.path }),
      node.count ? el('span', { class: 'tree-count', text: node.count.toLocaleString() }) : null,
    ),
  );

  const children = node.children.length && expanded
    ? el('div', { class: 'tree-children' }, node.children.map(treeRow))
    : null;

  return el('div', {}, row, children);
}

function renderPlaylists() {
  const host = clear($('#playlists'));
  if (state.playlists.length === 0) {
    host.append(el('p', { class: 'tree-empty', text: 'No playlists yet.' }));
    return;
  }
  for (const playlist of state.playlists) {
    const current = state.view.mode === 'playlist' && state.view.playlist === playlist.id;
    host.append(
      el(
        'div',
        { class: 'tree-row', 'aria-current': String(current) },
        el(
          'button',
          { class: 'tree-label', onClick: () => openPlaylist(playlist.id) },
          icon('i-list'),
          el('span', { class: 'tree-name', text: playlist.name, title: playlist.rel_path }),
          playlist.missing
            ? el('span', { class: 'pl-missing', text: `${playlist.missing}!`, title: `${playlist.missing} entr${playlist.missing === 1 ? 'y' : 'ies'} point at files that are not there` })
            : null,
          el('span', { class: 'tree-count', text: playlist.count.toLocaleString() }),
        ),
      ),
    );
  }
}

// ----------------------------------------------------------------- navigation

function clearSegments() {
  for (const segment of document.querySelectorAll('.segment')) {
    segment.classList.remove('is-on');
    segment.setAttribute('aria-pressed', 'false');
  }
}

function litSegment(mode) {
  clearSegments();
  const button = document.querySelector(`.segment[data-view="${mode}"]`);
  if (button) {
    button.classList.add('is-on');
    button.setAttribute('aria-pressed', 'true');
  }
}

function ancestry(path) {
  const parts = path.split('/').filter(Boolean);
  const out = [''];
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}

function openFolder(path) {
  state.view = { ...state.view, mode: 'folder', folder: path, album: null, artist: null, playlist: null, q: '' };
  $('#search').value = '';
  // Browsing a folder is none of the four segments; leaving one lit would have
  // the capsule claiming something the list is not showing.
  clearSegments();
  for (const part of ancestry(path)) state.expanded.add(part);
  renderTree();
  renderPlaylists();
  resetView();
}

function openAlbum(key, title) {
  state.view = { ...state.view, mode: 'album', album: key, albumTitle: title, artist: null, playlist: null, q: '' };
  $('#search').value = '';
  clearSegments();
  renderTree();
  renderPlaylists();
  resetView();
}

function openArtist(name) {
  state.view = { ...state.view, mode: 'artist', artist: name, album: null, playlist: null, q: '' };
  $('#search').value = '';
  clearSegments();
  renderTree();
  renderPlaylists();
  resetView();
}

function openPlaylist(id) {
  state.view = { ...state.view, mode: 'playlist', playlist: id, album: null, artist: null, q: '' };
  $('#search').value = '';
  clearSegments();
  renderTree();
  renderPlaylists();
  resetView();
}

function setView(mode) {
  state.view = {
    ...state.view,
    mode,
    folder: '',
    album: null,
    artist: null,
    playlist: null,
  };
  litSegment(mode);
  renderTree();
  renderPlaylists();
  resetView();
}

function renderCrumbs() {
  const host = clear($('#crumbs'));
  const { mode, folder, q } = state.view;

  const single = (text) => host.append(el('span', { class: 'crumb-last', text }));

  if (q) {
    // The results span the library, so a folder path here would be a lie.
    single(`Results — ${q}`);
  } else if (mode === 'favorites') single('Favorites');
  else if (mode === 'albums') single('Albums');
  else if (mode === 'artists') single('Artists');
  else if (mode === 'album') single(state.hero?.title ?? state.view.albumTitle ?? 'Album');
  else if (mode === 'artist') single(state.view.artist ?? 'Artist');
  else if (mode === 'playlist') single(state.hero?.name ?? 'Playlist');
  else if (mode === 'all' || folder === '') single('All music');
  else {
    host.append(el('button', { text: 'All music', onClick: () => openFolder('') }));
    const parts = folder.split('/');
    let acc = '';
    parts.forEach((part, index) => {
      acc = acc ? `${acc}/${part}` : part;
      const at = acc;
      const last = index === parts.length - 1;
      host.append(el('span', { class: 'sep', text: '/' }));
      host.append(
        last
          ? el('span', { class: 'crumb-last', text: part })
          : el('button', { text: part, onClick: () => openFolder(at) }),
      );
    });
  }

  if (state.total && showsTracks()) {
    host.append(el('span', { class: 'crumb-count', text: plural(state.total, 'track') }));
  }

  // The edit affordance trails the whole line rather than splitting the folder
  // name from its count.
  if (mode === 'folder' && folder !== '' && !q) {
    host.append(
      el('button', {
        class: 'icon-btn icon-btn--sm',
        title: 'Edit this folder',
        'aria-label': 'Edit this folder',
        onClick: editFolder,
      }, icon('i-pencil')),
    );
  }
  if (mode === 'playlist' && !q) {
    host.append(
      el('button', {
        class: 'icon-btn icon-btn--sm',
        title: 'Edit this playlist',
        'aria-label': 'Edit this playlist',
        onClick: editPlaylist,
      }, icon('i-pencil')),
    );
  }

  // The band carries a description when there is one. An empty band inviting
  // you to write one would sit on every folder in the library forever.
  const node = mode === 'folder' && !q ? findNode(state.tree, folder) : null;
  const note = clear($('#folder-note'));
  const text = node?.description ?? (mode === 'playlist' ? state.hero?.description : null);
  note.hidden = !text;
  if (text) note.append(el('span', { text }));
}

/** Name and description are one decision about a folder, so one dialog. */
async function editFolder() {
  const path = state.view.folder;
  const node = findNode(state.tree, path);
  if (!node) return;

  const result = await askFields({
    title: 'Edit folder',
    confirm: 'Save',
    fields: [
      { name: 'name', label: 'Name — renames the folder on the drive too', value: node.name },
      { name: 'description', label: 'Description', value: node.description ?? '', multiline: true, placeholder: 'What is in here?' },
    ],
  });
  if (!result) return;

  const name = result.name.trim();
  if (!name) return toast('A folder needs a name', 'bad');

  return attempt(async () => {
    const body = { path, description: result.description };
    if (name !== node.name) body.name = name;
    const { folder } = await api('/api/folders', { method: 'PATCH', body });
    await loadTree();
    await loadPlaylists();
    if (folder.rel_path !== path) openFolder(folder.rel_path);
    else renderCrumbs();
    toast('Folder updated');
  });
}

async function editPlaylist() {
  const playlist = state.hero;
  if (!playlist) return;

  const result = await askFields({
    title: 'Edit playlist',
    confirm: 'Save',
    fields: [
      { name: 'name', label: 'Name — renames the .m3u8 file too', value: playlist.name },
      { name: 'description', label: 'Description', value: playlist.description ?? '', multiline: true },
    ],
  });
  if (!result) return;
  const name = result.name.trim();
  if (!name) return toast('A playlist needs a name', 'bad');

  return attempt(async () => {
    await api(`/api/playlists/${playlist.id}`, {
      method: 'PATCH',
      body: { name, description: result.description },
    });
    await loadPlaylists();
    resetView();
    toast('Playlist updated');
  });
}

// -------------------------------------------------------------- loading views

/** True for the modes whose main content is a list of tracks. */
function showsTracks() {
  return ['all', 'folder', 'favorites', 'album', 'artist', 'playlist'].includes(state.view.mode)
    || Boolean(state.view.q);
}

function resetView() {
  state.items = [];
  state.cards = [];
  state.hero = null;
  state.total = 0;
  state.seconds = 0;
  state.exhausted = false;
  state.rows = new Map();
  clear($('#tracks')).hidden = true;
  clear($('#cards')).hidden = true;
  clear($('#hero')).hidden = true;
  clear($('#subfolders')).hidden = true;
  $('#empty').hidden = true;
  renderCrumbs();
  $('#scroller').scrollTop = 0;

  const { mode, q } = state.view;
  if (!q && mode === 'albums') return void loadAlbums();
  if (!q && mode === 'artists') return void loadArtists();
  if (!q && mode === 'album') return void loadAlbum();
  if (!q && mode === 'artist') return void loadArtistPage();
  if (!q && mode === 'playlist') return void loadPlaylistPage();

  renderSubfolders();
  loadMore();
  return undefined;
}

function trackQuery() {
  const { mode, folder, q, sort } = state.view;
  const params = new URLSearchParams({ sort, limit: String(PAGE), offset: String(state.items.length) });
  if (q) {
    // Searching looks at the whole library, not just the folder you happen to
    // be standing in — a track you cannot find is the reason you are searching.
    params.set('folder', '');
    params.set('recursive', '1');
    params.set('q', q);
  } else if (mode === 'favorites') {
    params.set('favorite', '1');
    params.set('folder', '');
    params.set('recursive', '1');
  } else if (mode === 'all') {
    params.set('folder', '');
    params.set('recursive', '1');
  } else {
    params.set('folder', folder);
  }
  return params;
}

async function loadMore() {
  if (state.loading || state.exhausted || !state.status || state.status.locked) return;
  if (!showsTracks()) return;
  // An album, an artist page and a playlist all arrive whole, so there is
  // nothing to page through — unless a search is running, which replaces
  // whichever view you were in with results from the whole library.
  if (!state.view.q && ['album', 'artist', 'playlist'].includes(state.view.mode)) return;
  state.loading = true;
  const token = JSON.stringify(state.view);

  try {
    const page = await api(`/api/tracks?${trackQuery()}`);
    // A different folder was opened while this was in flight.
    if (token !== JSON.stringify(state.view)) return;

    state.total = page.total;
    state.seconds = page.seconds;
    appendTracks(page.items);
    if (page.items.length < page.limit || state.items.length >= page.total) state.exhausted = true;

    renderCrumbs();
    renderEmpty();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 423) toast(err.message, 'bad');
    state.exhausted = true;
  } finally {
    state.loading = false;
  }
}

async function loadAlbums() {
  const result = await attempt(() => api(`/api/albums?limit=500${state.view.artist ? `&artist=${encodeURIComponent(state.view.artist)}` : ''}`));
  if (!result) return;
  state.cards = result.items;
  state.exhausted = true;
  renderAlbumCards(result.items);
  renderEmpty();
}

async function loadArtists() {
  const result = await attempt(() => api('/api/artists'));
  if (!result) return;
  state.cards = result.artists;
  state.exhausted = true;

  const host = clear($('#cards'));
  host.hidden = result.artists.length === 0;
  for (const artist of result.artists) {
    host.append(
      card({
        round: true,
        coverTrackId: artist.cover_track_id,
        title: artist.name,
        sub: caps(`${plural(artist.albums, 'album')} · ${plural(artist.count, 'track')}`),
        onOpen: () => openArtist(artist.name),
        onPlay: () => playCollection({ artist: artist.name }, artist.name),
      }),
    );
  }
  renderEmpty();
}

async function loadAlbum() {
  const result = await attempt(() => api(`/api/album?key=${encodeURIComponent(state.view.album)}`));
  if (!result) return;
  state.hero = result.album;
  state.total = result.album.count;
  state.seconds = result.album.seconds;
  state.exhausted = true;

  renderHero({
    coverTrackId: result.album.cover_track_id,
    eyebrow: result.album.untagged ? 'Folder' : 'Album',
    title: result.album.title,
    subtitle: result.album.artist,
    facts: [
      result.album.year ? String(result.album.year) : null,
      plural(result.album.count, 'track'),
      formatSpan(result.album.seconds),
      formatBytes(result.album.bytes),
    ],
    tracks: result.tracks,
    onArtist: result.album.artist ? () => openArtist(result.album.artist) : null,
  });
  appendTracks(result.tracks, { numbered: true });
  renderCrumbs();
  renderEmpty();
}

async function loadArtistPage() {
  const name = state.view.artist;
  const result = await attempt(() => api(`/api/albums?limit=500&artist=${encodeURIComponent(name)}`));
  if (!result) return;
  const totals = result.items.reduce(
    (acc, album) => ({ count: acc.count + album.count, seconds: acc.seconds + album.seconds }),
    { count: 0, seconds: 0 },
  );
  state.cards = result.items;
  state.exhausted = true;

  renderHero({
    round: true,
    coverTrackId: result.items.find((album) => album.cover_track_id)?.cover_track_id ?? null,
    eyebrow: 'Artist',
    title: name,
    facts: [plural(result.items.length, 'album'), plural(totals.count, 'track'), formatSpan(totals.seconds)],
    play: () => playCollection({ artist: name }, name),
  });
  renderAlbumCards(result.items);
  renderCrumbs();
  renderEmpty();
}

async function loadPlaylistPage() {
  const result = await attempt(() => api(`/api/playlists/${state.view.playlist}`));
  if (!result) return;
  const live = result.tracks.filter((row) => row.id !== null);
  state.hero = result.playlist;
  state.total = result.tracks.length;
  state.seconds = live.reduce((sum, row) => sum + (row.duration ?? 0), 0);
  state.exhausted = true;

  renderHero({
    coverTrackId: live.find((row) => row.art_key)?.id ?? null,
    eyebrow: 'Playlist',
    title: result.playlist.name,
    facts: [
      plural(result.tracks.length, 'track'),
      formatSpan(state.seconds),
      result.tracks.length - live.length ? `${result.tracks.length - live.length} missing` : null,
    ],
    tracks: live,
  });
  appendTracks(result.tracks, { numbered: true });
  renderCrumbs();
  renderEmpty();
}

/** Play everything matching a filter, without needing it on screen first. */
async function playCollection(filter, label, { shuffle = false } = {}) {
  const params = new URLSearchParams({ folder: '', recursive: '1', limit: '500', sort: 'album_asc' });
  for (const [key, value] of Object.entries(filter)) params.set(key, String(value));
  const page = await attempt(() => api(`/api/tracks?${params}`));
  if (!page) return;
  if (page.items.length === 0) return toast('Nothing to play here', 'bad');

  player.setShuffle(shuffle);
  const started = player.load(page.items, 0, { source: label });
  if (!started) toast('Nothing here can be played in a browser', 'bad');
  return undefined;
}

// ------------------------------------------------------------------ rendering

function renderHero({ coverTrackId, eyebrow, title, subtitle, facts = [], tracks = null, play = null, round = false, onArtist = null }) {
  const host = clear($('#hero'));
  host.hidden = false;

  const cover = el('div', { class: `hero-cover${round ? ' hero-cover--round' : ''}` });
  coverInto(cover, coverTrackId, { size: 'full', alt: '' });

  const start = play ?? (tracks ? () => {
    if (!player.load(tracks, 0, { source: title })) toast('Nothing here can be played in a browser', 'bad');
  } : null);
  const startShuffled = tracks
    ? () => {
        player.setShuffle(true);
        if (!player.load(tracks, Math.floor(Math.random() * tracks.length), { source: title })) {
          toast('Nothing here can be played in a browser', 'bad');
        }
      }
    : () => playCollection({ artist: state.view.artist }, title, { shuffle: true });

  const actions = el(
    'div',
    { class: 'hero-actions' },
    start ? el('button', { class: 'btn', onClick: start }, icon('i-play'), 'PLAY') : null,
    el('button', { class: 'btn', onClick: startShuffled }, icon('i-shuffle'), 'SHUFFLE'),
    tracks
      ? el('button', {
          class: 'btn',
          onClick: () => addToPlaylist(tracks.map((track) => track.id)),
        }, icon('i-list'), 'ADD TO PLAYLIST')
      : null,
  );

  host.append(
    cover,
    el(
      'div',
      { class: 'hero-body' },
      el('p', { class: 'label', text: eyebrow }),
      el('h1', { class: 'display', text: title }),
      subtitle
        ? onArtist
          ? el('p', { class: 'hero-artist' }, el('button', { class: 'text-btn', text: subtitle, onClick: onArtist }))
          : el('p', { class: 'meta-line', text: subtitle })
        : null,
      el('div', { class: 'hero-facts' }, facts.filter(Boolean).map((fact, index) => [
        index > 0 ? el('span', { class: 'dot-sep', text: '·' }) : null,
        el('span', { text: caps(fact) }),
      ]).flat().filter(Boolean)),
      actions,
    ),
  );
}

function card({ coverTrackId, title, sub, onOpen, onPlay, round = false, pinned = false }) {
  const cover = el('div', { class: 'card-cover' });
  coverInto(cover, coverTrackId, { alt: '' });
  if (pinned) cover.append(el('span', { class: 'pin', title: 'Cover chosen by you' }, icon('i-star')));
  if (onPlay) {
    cover.append(
      el('span', {
        class: 'card-play',
        title: `Play ${title}`,
        onClick: (event) => { event.stopPropagation(); onPlay(); },
      }, icon('i-play')),
    );
  }

  return el(
    'button',
    { class: `card${round ? ' card--round' : ''}`, onClick: onOpen, title },
    cover,
    el(
      'div',
      { class: 'card-body' },
      el('strong', { text: title }),
      sub ? el('small', { text: sub }) : null,
    ),
  );
}

function renderAlbumCards(albums) {
  const host = clear($('#cards'));
  host.hidden = albums.length === 0;
  for (const album of albums) {
    host.append(
      card({
        coverTrackId: album.cover_track_id,
        title: album.title,
        sub: caps([album.artist, album.year].filter(Boolean).join(' · ') || plural(album.count, 'track')),
        onOpen: () => openAlbum(album.key, album.title),
        onPlay: () => playCollection({ album: album.key }, album.title),
      }),
    );
  }
}

function renderSubfolders() {
  const host = clear($('#subfolders'));
  // Folders belong above the tracks when you are browsing structure. In the
  // favorites view they would be noise, and a search spans everything.
  const browsing = (state.view.mode === 'folder' || state.view.mode === 'all') && !state.view.q;
  const node = browsing ? findNode(state.tree, state.view.folder) : null;
  const children = node?.children ?? [];
  host.hidden = children.length === 0;

  for (const child of children) {
    host.append(
      card({
        coverTrackId: child.cover?.id ?? null,
        pinned: Boolean(child.cover?.explicit),
        title: child.name,
        sub: child.count
          ? caps(`${plural(child.count, 'track')}${child.children.length ? ` · ${plural(child.children.length, 'folder')}` : ''}`)
          : 'EMPTY',
        onOpen: () => openFolder(child.path),
        onPlay: child.count ? () => playCollection({ folder: child.path, recursive: 1 }, child.name) : null,
      }),
    );
  }
}

/**
 * Append track rows.
 *
 * `numbered` uses the track's own number from its tags, which is what you want
 * inside an album; everywhere else the running position is more useful.
 */
function appendTracks(tracks, { numbered = false } = {}) {
  const host = $('#tracks');
  host.hidden = false;
  for (const track of tracks) {
    const position = state.items.length + 1;
    if (track.id === null) {
      // A playlist entry whose file is not there. Shown, greyed, in its place.
      host.append(missingRow(track, position));
      continue;
    }
    state.items.push(track);
    const row = trackRow(track, numbered ? (track.track_no ?? position) : position);
    state.rows.set(track.id, row);
    host.append(row);
  }
  paintNowPlaying();
}

function trackRow(track, position) {
  const opaque = track.state === 'unplayable';

  const index = el(
    'span',
    { class: 'track-index' },
    el('span', { class: 'track-index-n', text: String(position).padStart(2, '0') }),
    opaque ? null : el('span', { class: 'track-index-play' }, icon('i-play')),
    opaque ? null : el('span', { class: 'track-index-bars' }, el('i'), el('i'), el('i')),
  );

  const fav = el('span', {
    class: `track-fav${track.favorite ? ' on' : ''}`,
    role: 'button',
    tabindex: '0',
    title: track.favorite ? 'Remove from favorites' : 'Add to favorites',
    onClick: (event) => { event.stopPropagation(); toggleFavorite(track); },
    onKeydown: (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      toggleFavorite(track);
    },
  }, icon('i-star'));

  return el(
    'div',
    {
      class: `track${opaque ? ' is-opaque' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-current': 'false',
      dataset: { id: String(track.id) },
      onClick: () => playFromList(track),
      onKeydown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        playFromList(track);
      },
    },
    index,
    el(
      'span',
      { class: 'track-main' },
      el('span', { class: 'track-title', text: track.title || track.filename, title: track.title || track.filename }),
      el('span', { class: 'track-artist', text: track.artist ?? (opaque ? caps(track.ext.replace('.', '')) : '—') }),
    ),
    el('span', { class: 'track-album', text: track.album ?? '' }),
    el('span', { class: 'track-time', text: opaque ? '—' : formatDuration(track.duration) }),
    fav,
  );
}

function missingRow(entry, position) {
  return el(
    'div',
    { class: 'track is-opaque', title: entry.entry_path },
    el('span', { class: 'track-index' }, el('span', { class: 'track-index-n', text: String(position).padStart(2, '0') })),
    el(
      'span',
      { class: 'track-main' },
      el('span', { class: 'track-title', text: entry.entry_path.split('/').pop() }),
      el('span', { class: 'track-artist', text: 'NOT ON THE DRIVE' }),
    ),
    el('span', { class: 'track-album', text: '' }),
    el('span', { class: 'track-time', text: '—' }),
    el('span', { class: 'track-fav' }),
  );
}

function playFromList(track) {
  if (track.state === 'unplayable') {
    toast('No browser can play this format — the file is still on the drive', 'bad');
    return;
  }
  const index = state.items.indexOf(track);
  const label = state.hero?.title ?? state.hero?.name ?? crumbLabel();
  if (!player.load(state.items, index, { source: label })) {
    toast('Nothing here can be played in a browser', 'bad');
  }
}

function crumbLabel() {
  const { mode, folder, q } = state.view;
  if (q) return `Results — ${q}`;
  if (mode === 'favorites') return 'Favorites';
  if (mode === 'folder' && folder) return folder.split('/').pop();
  return 'All music';
}

function renderEmpty() {
  const host = $('#empty');
  const nothing =
    state.items.length === 0 &&
    state.cards.length === 0 &&
    $('#subfolders').hidden &&
    $('#hero').hidden;
  host.hidden = !nothing;
  if (!nothing) return;

  clear(host);
  const { mode, q } = state.view;
  const [heading, body] = q
    ? ['No matches', `Nothing in the library matches “${q}”.`]
    : mode === 'favorites'
      ? ['No favorites yet', 'Press F while something is playing, or use the star at the end of a row.']
      : mode === 'albums' || mode === 'artists'
        ? ['Nothing indexed yet', 'Copy music in with Sync, or drop files onto the drive and press Scan.']
        : ['Nothing here yet', 'Copy music in with Sync, or drop files straight into this folder on the drive and press Scan.'];

  host.append(
    el('p', { class: 'label', text: heading }),
    el('span', { class: 'rule' }),
    el('p', { text: body }),
  );
}

// ---------------------------------------------------------------- the player

/** The transport, the now-playing block and the queue, from one state object. */
function renderPlayer() {
  const track = player.current;
  const audio = player.audio;

  $('#now-title').textContent = track ? (track.title || track.filename) : 'Nothing playing';
  $('#now-sub').textContent = track
    ? [track.artist, track.album].filter(Boolean).join(' — ') || track.folder_path || ''
    : 'Pick something from the library';
  coverInto($('#now-art'), track?.art_key ? track.id : null, { alt: '' });

  $('#now-fav').setAttribute('aria-pressed', String(Boolean(track?.favorite)));
  $('#now-fav').disabled = !track;

  const glyph = $('#play-glyph');
  glyph.classList.toggle('is-pause', player.playing);
  glyph.firstElementChild.setAttribute('href', player.playing ? '#i-pause' : '#i-play');
  $('#btn-play').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');

  $('#btn-shuffle').setAttribute('aria-pressed', String(player.shuffle));
  $('#btn-repeat').setAttribute('aria-pressed', String(player.repeat !== 'off'));
  $('#btn-repeat').title = { off: 'Repeat', all: 'Repeating the queue', one: 'Repeating this track' }[player.repeat];
  // One glyph, three states: the mono badge says which without a second icon.
  $('#btn-repeat').dataset.mode = player.repeat;

  $('#btn-mute').firstElementChild.firstElementChild.setAttribute(
    'href', audio.muted || audio.volume === 0 ? '#i-muted' : '#i-volume',
  );

  const count = player.upcoming.length;
  $('#queue-count').textContent = count ? String(count) : '';
  $('#seek').disabled = !track;

  renderTime();
  paintNowPlaying();
  if (!$('#queue-panel').hidden) renderQueuePanel();
}

let seeking = false;

function renderTime() {
  const audio = player.audio;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : (player.current?.duration ?? 0);

  $('#time-at').textContent = formatDuration(audio.currentTime || 0);
  $('#time-of').textContent = duration ? formatDuration(duration) : '--:--';
  if (!seeking) {
    $('#seek').value = String(duration ? Math.round((audio.currentTime / duration) * 1000) : 0);
  }
}

/** Mark the row that is playing, in whichever list is on screen. */
function paintNowPlaying() {
  const currentId = player.current?.id ?? null;
  for (const [id, row] of state.rows) {
    const on = id === currentId;
    row.setAttribute('aria-current', String(on));
    row.classList.toggle('is-paused', on && !player.playing);
  }
}

// ----------------------------------------------------------------- the queue

function openQueue() {
  $('#queue-panel').hidden = false;
  $('#btn-queue').setAttribute('aria-pressed', 'true');
  renderQueuePanel();
}

function closeQueue() {
  $('#queue-panel').hidden = true;
  $('#btn-queue').setAttribute('aria-pressed', 'false');
}

function renderQueuePanel() {
  const track = player.current;

  $('#q-where').textContent = track
    ? [player.source, track.folder_path || 'Library root'].filter(Boolean).join('  ·  ')
    : 'Nothing playing';
  $('#q-title').textContent = track ? (track.title || track.filename) : '—';
  coverInto($('#q-cover'), track?.art_key ? track.id : null, { size: 'full', alt: '' });

  $('#q-ext').textContent = track ? caps(track.ext.replace('.', '')) : 'FILE';
  const flag = track?.favorite ? 'FAVORITE' : '';
  $('#q-state').textContent = flag;
  $('#q-state').hidden = !flag;
  $('#q-state').classList.toggle('chip-dot--gold', Boolean(track?.favorite));

  const meta = clear($('#q-meta'));
  const rows = track
    ? [
        ['Artist', track.artist],
        ['Album', track.album],
        ['Year', track.year ? String(track.year) : null],
        ['Genre', track.genre],
        ['Length', formatDuration(track.duration)],
        ['Format', [track.codec, track.sample_rate ? `${(track.sample_rate / 1000).toFixed(1)} kHz` : null,
          track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : null].filter(Boolean).join(' · ')],
        ['Weight', formatBytes(track.size)],
        ['Plays', track.play_count ? `${track.play_count}${track.last_played ? ` · last ${formatDate(track.last_played)}` : ''}` : null],
        ['File', track.filename],
      ]
    : [];
  for (const [key, value] of rows) {
    if (!value) continue;
    meta.append(
      el('div', { class: 'dash-row' }, el('span', { class: 'k', text: key }), el('span', { class: 'v', text: value })),
    );
  }

  // Only rewrite the note field when it is not the one being typed into.
  const note = $('#q-note');
  if (document.activeElement !== note) note.value = track?.note ?? '';
  note.disabled = !track;

  $('#q-fav').classList.toggle('on', Boolean(track?.favorite));
  $('#q-fav').setAttribute('aria-pressed', String(Boolean(track?.favorite)));
  for (const id of ['#q-fav', '#q-add', '#q-cover-set', '#q-delete']) $(id).disabled = !track;
  $('#q-download').href = track ? `/api/tracks/${track.id}/stream?download=1` : '#';
  if (track) $('#q-download').setAttribute('download', track.filename);

  const list = clear($('#q-list'));
  const upcoming = player.upcoming;
  if (upcoming.length === 0) {
    list.append(el('li', {}, el('span', { class: 'q-empty', text: 'Nothing queued after this one.' })));
    return;
  }
  upcoming.forEach((item, offset) => {
    list.append(
      el(
        'li',
        {},
        el(
          'button',
          { onClick: () => player.jumpTo(item.id), title: item.title || item.filename },
          el('span', { class: 'n', text: String(offset + 1).padStart(2, '0') }),
          el(
            'span',
            { class: 't' },
            item.title || item.filename,
            el('small', { text: [item.artist, item.album].filter(Boolean).join(' — ') }),
          ),
          el('span', { class: 'd', text: formatDuration(item.duration) }),
        ),
      ),
    );
  });
}

// ------------------------------------------------------------- track editing

/** Keep every copy of a track in sync after the server confirms a change. */
function applyTrackUpdate(updated) {
  for (const list of [state.items, player.queue]) {
    const found = list.find((track) => track.id === updated.id);
    if (found) Object.assign(found, updated);
  }
  const row = state.rows.get(updated.id);
  if (row) {
    const star = row.querySelector('.track-fav');
    star.classList.toggle('on', Boolean(updated.favorite));
    star.title = updated.favorite ? 'Remove from favorites' : 'Add to favorites';
  }
  renderPlayer();
}

async function toggleFavorite(track) {
  await attempt(async () => {
    const { track: updated } = await api(`/api/tracks/${track.id}`, {
      method: 'PATCH',
      body: { favorite: !track.favorite },
    });
    applyTrackUpdate(updated);
    refreshStatus();
  });
}

async function addToPlaylist(trackIds) {
  if (trackIds.length === 0) return;
  await loadPlaylists();

  const choice = await askChoice({
    title: trackIds.length === 1 ? 'Add to a playlist' : `Add ${plural(trackIds.length, 'track')} to a playlist`,
    body: 'Playlists are .m3u8 files in Playlists/ on the drive.',
    options: state.playlists.map((playlist) => ({
      value: playlist.id,
      label: playlist.name,
      hint: plural(playlist.count, 'track'),
    })),
    extra: 'New playlist',
  });
  if (choice === null) return;

  if (choice === 'new') {
    const name = await askText({ title: 'New playlist', label: 'Name', placeholder: 'Late night', confirm: 'Create' });
    if (!name?.trim()) return;
    await attempt(async () => {
      await api('/api/playlists', { method: 'POST', body: { name: name.trim(), trackIds } });
      await loadPlaylists();
      toast(`Added to “${name.trim()}”`);
    });
    return;
  }

  await attempt(async () => {
    const result = await api(`/api/playlists/${choice}/tracks`, { method: 'POST', body: { trackIds } });
    await loadPlaylists();
    if (state.view.mode === 'playlist' && state.view.playlist === choice) resetView();
    toast(`Added ${plural(result.added, 'track')}`);
  });
}

// ---------------------------------------------------------------------- jobs

function renderJob(job) {
  const bar = $('#job-bar');
  if (!job) {
    bar.hidden = true;
    $('#job-fill').style.setProperty('width', '0');
    return;
  }
  bar.hidden = false;

  const { phase, processed, total } = job.progress ?? {};
  $('#job-label').textContent = caps(`${job.type} — ${phase ?? 'working'}`);
  $('#job-detail').textContent = total ? `${processed} / ${total}` : `${processed ?? 0}`;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 4;
  $('#job-fill').style.setProperty('width', `${pct}%`);
  $('#job-cancel').onclick = () => attempt(() => api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }));
}

async function runJob(kind, label) {
  const started = await attempt(() => api(`/api/jobs/${kind}`, { method: 'POST' }));
  if (!started?.job) return;
  toast(`${label} started`);
  state.watchedJob = started.job.id;
  pollJob(started.job.id);
}

async function pollJob(id) {
  let payload;
  try {
    payload = await api(`/api/jobs/${id}`);
  } catch {
    state.watchedJob = null;
    return;
  }
  const job = payload.job;
  renderJob(job.status === 'running' ? job : null);

  if (job.status === 'running') {
    setTimeout(() => pollJob(id), 600);
    return;
  }

  state.watchedJob = null;
  if (job.status === 'error') toast(`${job.type} failed: ${job.error}`, 'bad');
  else if (job.status === 'cancelled') toast(`${job.type} cancelled`);
  else toast(summarise(job));

  if (job.result) {
    $('#job-report-wrap').hidden = false;
    $('#job-report').textContent = JSON.stringify(job.result, null, 2);
  }
  // A scan or sync moves things around, so reload rather than patch. If the
  // drive left while the job was finishing, the status poll takes over.
  if (await attempt(loadTree) !== null) {
    await attempt(loadPlaylists);
    resetView();
  }
  refreshStatus();
}

function summarise(job) {
  const result = job.result ?? {};
  if (job.type === 'scan') {
    return `Scan done — ${result.added ?? 0} new, ${result.updated ?? 0} updated, ${result.moved ?? 0} moved`;
  }
  if (job.type === 'sync') {
    return `Imported ${result.imported ?? 0} track(s); ${result.duplicates ?? 0} already here`;
  }
  if (job.type === 'verify') {
    const bad = (result.changed?.length ?? 0) + (result.missing?.length ?? 0) + (result.unreadable?.length ?? 0);
    return bad === 0
      ? `All ${result.checked ?? 0} files match the index`
      : `${bad} file(s) need attention — see Settings`;
  }
  if (job.type === 'artwork') return `Rendered ${result.rendered ?? 0} cover(s)`;
  return `${job.type} finished`;
}

// ------------------------------------------------------------------ settings

async function openSettings() {
  const dialog = $('#settings');
  const [config, cache] = await Promise.all([
    attempt(() => api('/api/config')),
    attempt(() => api('/api/cache')),
  ]);
  if (config) {
    $('#scan-on-unlock').checked = Boolean(config.scanOnUnlock);
    renderSources(config.sync?.sources ?? []);
  }
  $('#cache-info').textContent = cache
    ? `Cover art cache: ${plural(cache.files, 'file')}, ${formatBytes(cache.bytes)} — stored on the drive.`
    : '';
  $('#info-path').textContent = state.status?.volume?.path ?? '—';
  dialog.showModal();
}

function renderSources(sources) {
  const host = clear($('#sources'));
  if (sources.length === 0) {
    host.append(el('li', { class: 'sources-empty' }, el('span', { class: 'muted', text: 'No source folders yet.' })));
    return;
  }
  sources.forEach((source, index) => {
    host.append(
      el(
        'li',
        {},
        el('code', { text: source.path, title: source.path }),
        el('span', { class: 'tag', text: `→ ${source.into}/ (${source.organizeBy})` }),
        el('button', {
          class: 'icon-btn',
          title: 'Remove',
          onClick: async () => {
            const next = sources.filter((_, i) => i !== index);
            await attempt(async () => {
              await api('/api/config', { method: 'PATCH', body: { sync: { sources: next } } });
              renderSources(next);
            });
          },
        }, icon('i-close')),
      ),
    );
  });
}

async function addSource() {
  const path = $('#source-path').value.trim();
  if (!path) return toast('Type the full path of a folder on this computer', 'bad');

  const config = await attempt(() => api('/api/config'));
  const sources = [...(config?.sync?.sources ?? []), {
    path,
    into: $('#source-into').value.trim() || 'Imported',
    organizeBy: $('#source-organize').value,
  }];

  return attempt(async () => {
    const saved = await api('/api/config', { method: 'PATCH', body: { sync: { sources } } });
    renderSources(saved.config.sync.sources);
    $('#source-path').value = '';
    $('#source-into').value = '';
    toast('Source added');
  });
}

// --------------------------------------------------------------- setup wizard

async function browseTo(path) {
  const result = await attempt(() => api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`));
  if (!result) return;
  state.browsePath = result.path;
  state.browseParent = result.parent;

  $('#picker-current').textContent = result.path;
  $('#picker-up').disabled = !result.parent;

  const shortcuts = clear($('#picker-shortcuts'));
  shortcuts.hidden = !result.shortcuts?.length;
  for (const shortcut of result.shortcuts ?? []) {
    shortcuts.append(
      el('button', {
        class: `chip${shortcut.path === result.path ? ' on' : ''}`,
        text: shortcut.name,
        title: shortcut.path,
        onClick: () => browseTo(shortcut.path),
      }),
    );
  }

  const host = clear($('#picker-list'));
  if (result.entries.length === 0) {
    host.append(el('li', { class: 'picker-empty', text: 'No folders in here.' }));
  }
  for (const entry of result.entries) {
    host.append(
      el('li', {}, el('button', { onClick: () => browseTo(entry.path) }, icon('i-folder'), entry.name)),
    );
  }
  renderSetupTarget();
}

function setupTarget() {
  const base = state.browsePath ?? '';
  const name = $('#setup-folder').value.trim();
  if (!name) return base;
  return `${base.endsWith('/') ? base.slice(0, -1) : base}/${name}`;
}

function renderSetupTarget() {
  const node = clear($('#setup-target'));
  node.append('The library will be created at ', el('code', { text: setupTarget() || '…' }));
}

async function createLibrary() {
  const target = setupTarget();
  const label = $('#setup-label').value.trim();
  $('#setup-error').hidden = true;

  try {
    const result = await api('/api/volume/init', { method: 'POST', body: { path: target, label } });
    toast(result.adopted ? `Paired with "${result.label}"` : `Library created at ${result.path}`);
    previousLocked = null;
    await refreshStatus();
  } catch (err) {
    $('#setup-error').textContent = err.message;
    $('#setup-error').hidden = false;
  }
}

// -------------------------------------------------------------------- wiring

function wire() {
  /** Mutually exclusive buttons: one visual state, one announced state. */
  const exclusive = (nodes, chosen) => {
    for (const node of nodes) {
      const on = node === chosen;
      node.classList.toggle('is-on', on);
      node.setAttribute('aria-pressed', String(on));
    }
  };

  const segments = [...document.querySelectorAll('.segment')];
  for (const button of segments) {
    button.addEventListener('click', () => {
      exclusive(segments, button);
      setView(button.dataset.view);
    });
  }

  const strip = [...document.querySelectorAll('.strip-item')];
  for (const button of strip) {
    button.addEventListener('click', () => {
      exclusive(strip, button);
      state.view = { ...state.view, sort: button.dataset.sort };
      resetView();
    });
  }

  $('#search').addEventListener('input', debounce((event) => {
    state.view = { ...state.view, q: event.target.value.trim() };
    resetView();
  }, 220));

  // The toolbar only grows its rule once content is scrolling beneath it.
  const scroller = $('#scroller');
  let queued = false;
  scroller.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      document.querySelector('.toolbar').classList.toggle('is-stuck', scroller.scrollTop > 4);
      queued = false;
    });
  }, { passive: true });

  $('#new-folder').addEventListener('click', async () => {
    const name = await askText({
      title: 'New folder',
      label: `Created inside ${state.view.folder || 'the library root'}`,
      placeholder: 'Talk Talk',
      confirm: 'Create',
    });
    if (!name?.trim()) return;
    await attempt(async () => {
      const { folder } = await api('/api/folders', {
        method: 'POST',
        body: { parent: state.view.mode === 'folder' ? state.view.folder : '', name },
      });
      await loadTree();
      openFolder(folder.rel_path);
      toast('Folder created');
    });
  });

  $('#new-playlist').addEventListener('click', async () => {
    const name = await askText({
      title: 'New playlist',
      label: 'Saved as an .m3u8 file in Playlists/ on the drive',
      placeholder: 'Late night',
      confirm: 'Create',
    });
    if (!name?.trim()) return;
    await attempt(async () => {
      const { playlist } = await api('/api/playlists', { method: 'POST', body: { name: name.trim() } });
      await loadPlaylists();
      openPlaylist(playlist.id);
      toast('Playlist created');
    });
  });

  $('#btn-scan').addEventListener('click', () => runJob('scan', 'Scan'));
  $('#btn-sync').addEventListener('click', () => runJob('sync', 'Sync'));
  $('#btn-settings').addEventListener('click', openSettings);

  // Settings.
  $('#source-add').addEventListener('click', addSource);
  $('#scan-on-unlock').addEventListener('change', (event) =>
    attempt(() => api('/api/config', { method: 'PATCH', body: { scanOnUnlock: event.target.checked } })));
  $('#btn-verify').addEventListener('click', () => runJob('verify', 'Verify'));
  $('#btn-artwork').addEventListener('click', () => runJob('artwork', 'Artwork build'));

  $('#btn-clear-cache').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Clear the artwork cache?',
      body: 'Covers are rendered again as you browse. Your music is not touched.',
      confirm: 'Clear cache',
    });
    if (!ok) return;
    await attempt(() => api('/api/cache', { method: 'DELETE' }));
    toast('Cache cleared');
    resetView();
  });

  $('#btn-forget').addEventListener('click', async () => {
    const ok = await confirmAction({
      title: 'Unpair this drive?',
      body: 'This computer forgets which drive to look for. Nothing on the drive itself is changed, and you can pair with it again at any time.',
      confirm: 'Unpair',
      danger: true,
    });
    if (!ok) return;
    await attempt(() => api('/api/volume/forget', { method: 'POST' }));
    $('#settings').close();
    previousLocked = null;
    state.browsePath = null;
    refreshStatus();
  });

  // Lock screen.
  $('#gate-recheck').addEventListener('click', async () => {
    await attempt(() => api('/api/volume/recheck', { method: 'POST' }));
    refreshStatus();
  });
  $('#gate-forget').addEventListener('click', async () => {
    await attempt(() => api('/api/volume/forget', { method: 'POST' }));
    previousLocked = null;
    state.browsePath = null;
    refreshStatus();
  });

  // Setup wizard.
  $('#picker-up').addEventListener('click', () => browseTo(state.browseParent));
  $('#setup-folder').addEventListener('input', renderSetupTarget);
  $('#setup-create').addEventListener('click', createLibrary);

  // Transport.
  $('#btn-play').addEventListener('click', () => player.toggle());
  $('#btn-next').addEventListener('click', () => player.advance(false));
  $('#btn-prev').addEventListener('click', () => player.back());
  $('#btn-shuffle').addEventListener('click', () => player.setShuffle(!player.shuffle));
  $('#btn-repeat').addEventListener('click', () => player.cycleRepeat());
  $('#btn-mute').addEventListener('click', () => player.toggleMute());
  $('#volume').addEventListener('input', (event) => player.setVolume(Number(event.target.value) / 100));

  const seek = $('#seek');
  seek.addEventListener('pointerdown', () => { seeking = true; });
  seek.addEventListener('change', (event) => {
    seeking = false;
    const duration = player.audio.duration;
    if (Number.isFinite(duration)) player.seekTo((Number(event.target.value) / 1000) * duration);
  });
  seek.addEventListener('input', () => {
    const duration = player.audio.duration;
    if (Number.isFinite(duration)) {
      $('#time-at').textContent = formatDuration((Number(seek.value) / 1000) * duration);
    }
  });

  // Queue panel.
  $('#btn-queue').addEventListener('click', () =>
    ($('#queue-panel').hidden ? openQueue() : closeQueue()));
  $('#now-art').addEventListener('click', () =>
    ($('#queue-panel').hidden ? openQueue() : closeQueue()));
  $('#q-close').addEventListener('click', closeQueue);
  $('#q-clear').addEventListener('click', () => { player.clear(); toast('Queue cleared'); });
  $('#now-fav').addEventListener('click', () => player.current && toggleFavorite(player.current));
  $('#q-fav').addEventListener('click', () => player.current && toggleFavorite(player.current));
  $('#q-add').addEventListener('click', () => player.current && addToPlaylist([player.current.id]));

  // Save as you type. Waiting for blur meant clicking away from a half-typed
  // note and never knowing whether it stuck.
  const noteLabel = $('#q-note-label');
  const saveNote = debounce((value) => {
    const track = player.current;
    if (!track) return;
    attempt(async () => {
      const { track: updated } = await api(`/api/tracks/${track.id}`, { method: 'PATCH', body: { note: value } });
      applyTrackUpdate(updated);
      markSaved(noteLabel);
    });
  }, 650);
  $('#q-note').addEventListener('input', (event) => saveNote(event.target.value));

  $('#q-cover-set').addEventListener('click', async () => {
    const track = player.current;
    if (!track) return;
    const target = track.folder_path;
    await attempt(async () => {
      await api('/api/folders', { method: 'PATCH', body: { path: target, coverTrackId: track.id } });
      await loadTree();
      renderSubfolders();
      toast(`Cover set for ${target || 'the library root'}`);
    });
  });

  $('#q-delete').addEventListener('click', async () => {
    const track = player.current;
    if (!track) return;
    const ok = await confirmAction({
      title: `Move ${track.filename} to the trash?`,
      body: 'The file moves into .melora/trash on the drive. Nothing is erased — you can put it back from there yourself.',
      confirm: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      await api(`/api/tracks/${track.id}`, { method: 'DELETE' });
      player.forget(track.id);
      state.rows.get(track.id)?.remove();
      state.rows.delete(track.id);
      state.items = state.items.filter((item) => item.id !== track.id);
      state.total = Math.max(0, state.total - 1);
      renderCrumbs();
      renderEmpty();
      refreshStatus();
      toast('Moved to trash');
    });
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA'].includes(event.target.tagName);
    if (document.querySelector('dialog[open]:not(#settings)')) return;

    if (event.key === 'Escape') {
      if (event.target === $('#search') && $('#search').value) {
        $('#search').value = '';
        state.view = { ...state.view, q: '' };
        resetView();
        return;
      }
      if (!$('#queue-panel').hidden) closeQueue();
      return;
    }
    if (typing || $('#settings').open) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        player.toggle();
        break;
      case '/':
        event.preventDefault();
        $('#search').focus();
        $('#search').select();
        break;
      case 'ArrowRight':
        if (event.shiftKey) player.advance(false);
        else player.nudge(5);
        break;
      case 'ArrowLeft':
        if (event.shiftKey) player.back();
        else player.nudge(-5);
        break;
      case 'n': player.advance(false); break;
      case 'p': player.back(); break;
      case 'f': if (player.current) toggleFavorite(player.current); break;
      case 'm': player.toggleMute(); break;
      case 's': player.setShuffle(!player.shuffle); break;
      case 'q': if ($('#queue-panel').hidden) openQueue(); else closeQueue(); break;
      default: break;
    }
  });

  // Infinite scroll.
  new IntersectionObserver(
    (entries) => { if (entries.some((entry) => entry.isIntersecting)) loadMore(); },
    { root: $('#scroller'), rootMargin: '600px' },
  ).observe($('#sentinel'));

  // The player is the single source of truth for what is playing; everything
  // that shows it redraws from here.
  player.subscribe((kind, _player, payload) => {
    if (kind === 'time') return renderTime();
    if (kind === 'played') {
      return void attempt(() => api(`/api/tracks/${payload.id}/played`, { method: 'POST' }));
    }
    if (kind === 'error') {
      toast(`Could not play ${payload.filename}`, 'bad');
      return undefined;
    }
    return renderPlayer();
  });
}

/** A quiet "saved" on the field's own label, instead of a toast per keystroke. */
let savedTimer = null;
function markSaved(label) {
  for (const node of document.querySelectorAll('.label.is-saved')) node.classList.remove('is-saved');
  label.classList.add('is-saved');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => label.classList.remove('is-saved'), 1600);
}

wire();
renderPlayer();
refreshStatus();
// The drive can be pulled at any moment; this poll is how the UI finds out.
setInterval(() => { if (!state.watchedJob) refreshStatus(); }, 3000);
