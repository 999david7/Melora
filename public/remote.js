/*
 * Desktop widgets and the system's media controls.
 *
 * The tab tells the server what it is playing so widgets (Rainmeter on
 * Windows, the Plasma widget on Linux, the mini player page) can show it, and
 * listens for their play/pause/next/previous over an event stream. The same
 * state goes to the Media Session API, which is how the browser puts Melora in
 * the Windows media flyout and in MPRIS on Linux (GNOME, KDE and every panel
 * widget built on it).
 */

const HEARTBEAT_MS = 5000;

export function connectRemote(player) {
  const client = crypto.randomUUID();
  let pending = null;
  let reportedAt = 0;
  let reportedPosition = 0;

  const snapshot = () => {
    const track = player.current;
    const audio = player.audio;
    return {
      client,
      track: track
        ? {
            id: track.id,
            title: track.title || track.filename || '',
            artist: track.artist || '',
            album: track.album || '',
            hasArt: Boolean(track.art_key),
          }
        : null,
      duration: Number.isFinite(audio.duration) ? audio.duration : (track?.duration ?? 0),
      position: audio.currentTime || 0,
      playing: player.playing,
      shuffle: player.shuffle,
      repeat: player.repeat,
      upNext: player.upcoming.slice(0, 5).map((item) => ({
        title: item.title || item.filename || '',
        artist: item.artist || '',
      })),
    };
  };

  const report = (body = snapshot()) => {
    clearTimeout(pending);
    pending = null;
    reportedAt = Date.now();
    reportedPosition = body.position ?? 0;
    // Widgets are a nicety: a failed report (drive just pulled, server
    // restarting) must never surface in the player.
    fetch('/api/now-playing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  };

  const soon = () => {
    if (!pending) pending = setTimeout(() => report(), 150);
  };

  player.subscribe((kind) => {
    if (kind === 'played' || kind === 'error') return;
    if (kind !== 'time') {
      soon();
      updateMediaSession(player);
      return;
    }
    // Time ticks four times a second; only a seek, or the heartbeat that
    // tells the server this tab is still alive, needs a report.
    const expected = reportedPosition + (player.playing ? (Date.now() - reportedAt) / 1000 : 0);
    if (Math.abs(player.audio.currentTime - expected) > 2 || (player.playing && Date.now() - reportedAt > HEARTBEAT_MS)) {
      soon();
    }
  });

  const commands = {
    toggle: () => player.toggle(),
    next: () => player.advance(false),
    previous: () => player.back(),
  };

  const listen = () => {
    const events = new EventSource(`/api/remote/events?client=${encodeURIComponent(client)}`);
    events.addEventListener('command', (event) => {
      try {
        commands[JSON.parse(event.data).command]?.();
      } catch {
        // A malformed event is not worth interrupting playback over.
      }
    });
    // A reconnected stream (server restart, drive back) needs the state again.
    events.addEventListener('open', () => report());
    // EventSource retries a dropped connection itself, but gives up for good
    // on an error status, which is what a locked library answers with.
    events.addEventListener('error', () => {
      if (events.readyState === EventSource.CLOSED) setTimeout(listen, 3000);
    });
  };
  listen();

  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => player.current && player.audio.paused && player.toggle(),
      pause: () => player.current && !player.audio.paused && player.toggle(),
      nexttrack: commands.next,
      previoustrack: commands.previous,
      seekto: (details) => player.seekTo(details.seekTime),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Older browsers reject actions they do not know.
      }
    }
  }

  // A closed tab is not playing anything any more.
  window.addEventListener('pagehide', () => report({ client, track: null }));
  report();
}

let sessionTrackId = null;

function updateMediaSession(player) {
  if (!('mediaSession' in navigator)) return;
  const track = player.current;
  navigator.mediaSession.playbackState = track ? (player.playing ? 'playing' : 'paused') : 'none';
  if (!track) {
    navigator.mediaSession.metadata = null;
    sessionTrackId = null;
    return;
  }
  if (track.id === sessionTrackId) return;
  sessionTrackId = track.id;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title || track.filename || '',
    artist: track.artist || '',
    album: track.album || '',
    artwork: track.art_key
      ? [{ src: `/api/tracks/${track.id}/art?size=thumb`, sizes: '400x400', type: 'image/webp' }]
      : [],
  });
}
