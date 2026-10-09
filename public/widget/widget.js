/*
 * The mini player. Polls /api/now-playing once a second and sends commands
 * the same way the desktop widgets do, so it doubles as their reference.
 */

const $ = (id) => document.getElementById(id);
let view = null;
let fetchedAt = 0;
let artFor = null;

const clock = (value) => {
  const total = Math.floor(value || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

function position() {
  if (!view?.active) return 0;
  const moved = view.playing ? (Date.now() - fetchedAt) / 1000 : 0;
  return Math.min(view.duration || 0, view.position + moved);
}

function render() {
  const track = view?.track;
  $('caption').textContent = view?.locked ? 'Locked' : !view?.active ? 'Melora' : view.playing ? 'Now playing' : 'Paused';
  $('title').textContent = view?.locked ? 'Drive not connected' : track?.title || 'Nothing playing';
  $('sub').textContent = view?.locked
    ? 'Plug in the library drive'
    : track
      ? [track.artist, track.album].filter(Boolean).join(' — ')
      : view === null ? 'Melora is not running' : 'Open Melora in your browser to play';
  document.title = track ? `${track.title} — Melora` : 'Melora — Now Playing';

  const at = position();
  $('bar').style.width = view?.duration ? `${Math.min(100, (at / view.duration) * 100)}%` : '0';
  $('time').textContent = clock(at);
  $('duration').textContent = clock(view?.duration);

  $('toggle-glyph').setAttribute('href', view?.playing ? '#i-pause' : '#i-play');
  $('toggle').setAttribute('aria-label', view?.playing ? 'Pause' : 'Play');
  for (const id of ['prev', 'toggle', 'next']) $(id).disabled = !(view?.controllable && view?.active);

  const art = view?.art ?? null;
  if (art !== artFor) {
    artFor = art;
    $('art-img').hidden = !art;
    if (art) $('art-img').src = art;
    else $('art-img').removeAttribute('src');
  }
}

async function poll() {
  try {
    const response = await fetch('/api/now-playing', { cache: 'no-store' });
    view = await response.json();
    fetchedAt = Date.now();
  } catch {
    view = null;
  }
  render();
}

async function send(command) {
  await fetch(`/api/remote/${command}`, { method: 'POST', headers: { 'x-melora-remote': '1' } }).catch(() => {});
  setTimeout(poll, 150);
}

$('art-img').addEventListener('error', () => { $('art-img').hidden = true; });
$('prev').addEventListener('click', () => send('previous'));
$('toggle').addEventListener('click', () => send('toggle'));
$('next').addEventListener('click', () => send('next'));
document.addEventListener('keydown', (event) => {
  if (event.key === ' ') { event.preventDefault(); send('toggle'); }
});

poll();
setInterval(poll, 1000);
setInterval(render, 250);
