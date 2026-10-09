import crypto from 'node:crypto';

/**
 * Now playing, for desktop widgets.
 *
 * Playback happens in the browser tab, so the server only knows what the tab
 * tells it. The tab reports its state whenever it changes; widgets read that
 * back and send play/pause/next/previous, which reach the tab over an event
 * stream. Nothing here is written to disk: what you are listening to is as
 * locked as the rest of the library, and goes with it when the drive does.
 */

export const COMMANDS = new Set(['toggle', 'next', 'previous']);

/** A tab that stopped reporting this long ago has probably been closed mid-song. */
const STALE_MS = 15_000;
const UP_NEXT = 5;

const text = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');
const seconds = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

export class NowPlaying {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.report = null;
    this.owner = null;      // The tab whose state is shown and which gets commands.
    this.streams = new Map(); // client id -> Set of responses
  }

  /** Record what a tab is playing. A tab with nothing loaded never takes over from one that has. */
  update(clientId, body = {}) {
    const client = text(clientId, 64);
    if (!client) return false;
    const track = body.track && typeof body.track === 'object' ? body.track : null;
    if (!track && this.owner && this.owner !== client) return true;
    this.owner = client;
    this.report = track
      ? {
          track: {
            id: Number.isInteger(track.id) ? track.id : null,
            title: text(track.title),
            artist: text(track.artist),
            album: text(track.album),
            hasArt: Boolean(track.hasArt),
          },
          duration: seconds(body.duration),
          position: seconds(body.position),
          playing: Boolean(body.playing),
          shuffle: Boolean(body.shuffle),
          repeat: ['off', 'all', 'one'].includes(body.repeat) ? body.repeat : 'off',
          upNext: Array.isArray(body.upNext)
            ? body.upNext.slice(0, UP_NEXT).map((item) => ({ title: text(item?.title), artist: text(item?.artist) }))
            : [],
          at: this.now(),
        }
      : null;
    return true;
  }

  clear() {
    this.report = null;
    this.owner = null;
    this.broadcast('cleared');
  }

  /** The state a widget shows, with the position carried forward to now. */
  view() {
    const report = this.report;
    const connected = Boolean(this.owner && this.streams.get(this.owner)?.size);
    if (!report) return { active: false, playing: false, controllable: connected, track: null };
    const age = this.now() - report.at;
    // A playing tab reports at least every few seconds; if it has gone quiet
    // it was closed, and the song is not really still playing.
    const playing = report.playing && (connected || age < STALE_MS);
    const position = playing
      ? Math.min(report.duration || Infinity, report.position + age / 1000)
      : report.position;
    return {
      active: true,
      playing,
      controllable: connected,
      track: report.track,
      position: Math.round(position * 10) / 10,
      duration: report.duration,
      shuffle: report.shuffle,
      repeat: report.repeat,
      upNext: report.upNext,
    };
  }

  // ---------------------------------------------------------------- commands

  /** Attach a tab's event stream. Returns a function that detaches it. */
  attach(clientId, res) {
    const client = text(clientId, 64) || crypto.randomUUID();
    if (!this.streams.has(client)) this.streams.set(client, new Set());
    this.streams.get(client).add(res);
    return () => {
      const set = this.streams.get(client);
      set?.delete(res);
      if (set && set.size === 0) this.streams.delete(client);
    };
  }

  /** Send a command to the tab that is playing. False when no tab is listening. */
  command(name) {
    if (!COMMANDS.has(name)) throw new Error(`unknown command: ${name}`);
    const targets = this.streams.get(this.owner) ?? this.streams.values().next().value;
    if (!targets || targets.size === 0) return false;
    for (const res of targets) res.write(`event: command\ndata: ${JSON.stringify({ command: name })}\n\n`);
    return true;
  }

  broadcast(event) {
    for (const set of this.streams.values()) {
      for (const res of set) res.write(`event: ${event}\ndata: {}\n\n`);
    }
  }

  /** Keeps idle event streams from being cut by anything that times out quiet sockets. */
  ping() {
    for (const set of this.streams.values()) {
      for (const res of set) res.write(': ping\n\n');
    }
  }
}

/**
 * The same state as plain `key=value` lines, for widget engines that cannot
 * parse JSON (Rainmeter's WebParser reads it with a regular expression).
 * Values are single-line and always present, in a fixed order.
 */
export function asText(view, baseUrl) {
  const clock = (value) => {
    const total = Math.floor(value || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const line = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ');
  const track = view.track ?? {};
  // Engines without logic of their own just print these, so idle and locked
  // come with their own wording.
  const [title, artist] = view.locked
    ? ['Drive not connected', 'Plug in the library drive']
    : !view.active
      ? ['Nothing playing', 'Open Melora in your browser']
      : [track.title, track.artist];
  const fields = [
    ['state', view.locked ? 'locked' : !view.active ? 'idle' : view.playing ? 'playing' : 'paused'],
    ['title', title],
    ['artist', artist],
    ['album', track.album],
    ['position', clock(view.position)],
    ['duration', clock(view.duration)],
    ['progress', view.duration ? Math.min(1, view.position / view.duration).toFixed(4) : '0'],
    ['art', track.hasArt && track.id !== null ? `${baseUrl}/api/now-playing/art?track=${track.id}` : ''],
    ['next', view.upNext?.[0] ? [view.upNext[0].title, view.upNext[0].artist].filter(Boolean).join(' — ') : ''],
    ['controllable', view.controllable ? '1' : '0'],
  ];
  return `${fields.map(([key, value]) => `${key}=${line(value)}`).join('\n')}\n`;
}
