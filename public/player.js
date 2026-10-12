/*
 * Playback.
 *
 * One <audio> element, a queue, and the two toggles everybody expects. It
 * knows nothing about the DOM beyond that element: the app subscribes and
 * re-renders, which keeps the transport, the track list and the queue panel
 * from each having their own idea of what is playing.
 *
 * Audio is streamed from the drive with `Cache-Control: no-store`, so seeking
 * costs a range request rather than a copy of your library appearing in the
 * browser's disk cache. That is the whole point of the project, and it is why
 * this file never fetches a whole file up front.
 */

/** Long enough to mean you listened to it, short enough to catch a 90-second song. */
const PLAY_THRESHOLD_SECONDS = 20;

export class Player {
  constructor(audio) {
    this.audio = audio;
    this.queue = [];
    this.order = [];        // Indices into `queue`, in the order they will play.
    this.position = -1;     // Index into `order`.
    this.shuffle = false;
    this.repeat = 'off';    // 'off' | 'all' | 'one'
    this.source = null;     // Where the queue came from, for the panel's header.
    this.listeners = new Set();
    this.counted = false;   // Whether this track has been reported as played.
    this.listened = 0;
    this.lastTime = 0;
    // Autoplay: when the queue runs out, `suggest(seed, exclude)` is asked for
    // a track like the last one. The app supplies it; the player only knows
    // when to ask.
    this.autoplay = true;
    this.suggest = null;
    this.suggesting = false;
    this.failures = 0;      // Files in a row that would not play.

    audio.addEventListener('play', () => this.emit());
    audio.addEventListener('playing', () => { this.failures = 0; });
    audio.addEventListener('pause', () => this.emit());
    audio.addEventListener('durationchange', () => this.emit());
    audio.addEventListener('ended', () => this.advance(true));
    audio.addEventListener('error', () => {
      const track = this.current;
      if (!track) return;
      this.notify('error', track);
      this.failures += 1;
      // A file the drive can no longer supply should not wedge the queue.
      this.advance(true);
    });

    audio.addEventListener('timeupdate', () => {
      // Accumulate only forward, contiguous listening, so scrubbing back and
      // forth across the same ten seconds does not count as a play.
      const now = audio.currentTime;
      const step = now - this.lastTime;
      if (step > 0 && step < 1.5) this.listened += step;
      this.lastTime = now;

      if (!this.counted && this.current) {
        const target = Math.min(PLAY_THRESHOLD_SECONDS, (audio.duration || 60) * 0.5);
        if (this.listened >= target) {
          this.counted = true;
          this.notify('played', this.current);
        }
      }
      this.emit('time');
    });
  }

  // ------------------------------------------------------------- subscribing

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** `kind` is 'time' for the once-a-quarter-second tick, 'state' otherwise. */
  emit(kind = 'state') {
    for (const fn of this.listeners) fn(kind, this);
  }

  notify(kind, payload) {
    for (const fn of this.listeners) fn(kind, this, payload);
  }

  // ------------------------------------------------------------------ state

  get current() {
    const index = this.order[this.position];
    return index === undefined ? null : this.queue[index] ?? null;
  }

  get playing() {
    return !this.audio.paused && !this.audio.ended && this.current !== null;
  }

  /** What is still to come, in play order, for the queue panel. */
  get upcoming() {
    return this.order.slice(this.position + 1).map((index) => this.queue[index]);
  }

  // ------------------------------------------------------------- the queue

  /**
   * Play `tracks`, starting at `startIndex`.
   *
   * Formats the browser cannot decode are dropped here rather than at the
   * point of failure: a queue that stops dead on an APE file three tracks in
   * is worse than one that never contained it.
   */
  load(tracks, startIndex = 0, { source = null } = {}) {
    const playable = tracks.filter((track) => track && track.state !== 'unplayable');
    if (playable.length === 0) return false;

    // The clicked track may have been one of the ones just dropped; fall to
    // the next thing that can actually play.
    const wanted = tracks[startIndex];
    let index = playable.indexOf(wanted);
    if (index === -1) {
      const after = tracks.slice(startIndex).find((track) => playable.includes(track));
      index = after ? playable.indexOf(after) : 0;
    }

    this.queue = playable;
    this.source = source;
    this.rebuildOrder(index);
    this.start();
    return true;
  }

  /** Put tracks at the end of what is already playing. */
  enqueue(tracks) {
    const playable = tracks.filter((track) => track && track.state !== 'unplayable');
    if (playable.length === 0) return 0;
    if (this.queue.length === 0) {
      this.load(playable, 0);
      return playable.length;
    }
    const base = this.queue.length;
    this.queue.push(...playable);
    // Appended tracks join the tail in order, shuffled or not: you asked for
    // these next, so "next" is what they should be.
    this.order.push(...playable.map((_, offset) => base + offset));
    this.emit();
    return playable.length;
  }

  clear() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.queue = [];
    this.order = [];
    this.position = -1;
    this.source = null;
    this.emit();
  }

  /** Drop tracks that are no longer in the library, keeping what is playing. */
  forget(trackId) {
    const index = this.queue.findIndex((track) => track.id === trackId);
    if (index === -1) return;
    const wasCurrent = this.order[this.position] === index;
    const remaining = this.queue.filter((track) => track.id !== trackId);
    if (remaining.length === 0) return this.clear();

    const currentTrack = wasCurrent ? null : this.current;
    this.queue = remaining;
    const nextIndex = currentTrack ? this.queue.indexOf(currentTrack) : 0;
    this.rebuildOrder(Math.max(nextIndex, 0));
    if (wasCurrent) this.start();
    else this.emit();
    return undefined;
  }

  /**
   * Rebuild the play order around `index`, which becomes the current track.
   * Shuffling puts the rest in a fresh random order behind it, so turning
   * shuffle on does not restart what you are listening to.
   */
  rebuildOrder(index) {
    const rest = this.queue.map((_, i) => i).filter((i) => i !== index);
    if (this.shuffle) {
      for (let i = rest.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
    }
    this.order = [index, ...rest];
    this.position = 0;
  }

  // -------------------------------------------------------------- transport

  start() {
    const track = this.current;
    if (!track) return;
    this.counted = false;
    this.listened = 0;
    this.lastTime = 0;
    this.audio.src = `/api/tracks/${track.id}/stream`;
    this.audio.play().catch(() => {
      // Autoplay refused, or the drive went away between click and request.
      // The transport shows a paused state; pressing play again is enough.
      this.emit();
    });
    this.emit();
  }

  toggle() {
    if (!this.current) return;
    if (this.audio.paused) this.audio.play().catch(() => this.emit());
    else this.audio.pause();
  }

  /** `auto` distinguishes a track ending from you pressing next. */
  advance(auto = false) {
    if (!this.current) return;
    if (auto && this.repeat === 'one') {
      this.audio.currentTime = 0;
      this.counted = false;
      this.listened = 0;
      this.lastTime = 0;
      this.audio.play().catch(() => this.emit());
      return;
    }
    if (this.position + 1 < this.order.length) {
      this.position += 1;
      this.start();
      return;
    }
    if (this.repeat === 'all') {
      this.position = 0;
      this.start();
      return;
    }
    // Several files failing in a row means the drive is struggling, not that
    // the next suggestion will fare better.
    if (this.autoplay && this.suggest && this.failures < 3) {
      this.playSimilar();
      return;
    }
    this.audio.pause();
    this.emit();
  }

  /** Carry on past the end of the queue with something like what just played. */
  async playSimilar() {
    if (this.suggesting) return;
    const seed = this.current;
    const position = this.position;
    this.suggesting = true;
    let track = null;
    try {
      track = await this.suggest(seed, this.queue.map((item) => item.id));
    } catch {
      // Drive gone, server restarting: stopping is the honest outcome.
    } finally {
      this.suggesting = false;
    }
    // You may have picked something else while it was being chosen.
    if (this.current !== seed || this.position !== position) return;
    if (this.position + 1 < this.order.length) {
      // …or queued something, which plays ahead of any suggestion.
      this.position += 1;
      this.start();
      return;
    }
    if (!track || track.state === 'unplayable') {
      this.audio.pause();
      this.emit();
      return;
    }
    this.queue.push({ ...track, autoplay: true });
    this.order.push(this.queue.length - 1);
    this.position += 1;
    this.start();
  }

  /** Back to the start of this track first, then to the previous one. */
  back() {
    if (!this.current) return;
    if (this.audio.currentTime > 3 || this.position === 0) {
      this.audio.currentTime = 0;
      this.listened = 0;
      this.lastTime = 0;
      this.emit();
      return;
    }
    this.position -= 1;
    this.start();
  }

  jumpTo(trackId) {
    const queueIndex = this.queue.findIndex((track) => track.id === trackId);
    if (queueIndex === -1) return;
    const at = this.order.indexOf(queueIndex);
    if (at === -1) return;
    this.position = at;
    this.start();
  }

  seekTo(seconds) {
    if (!Number.isFinite(this.audio.duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.audio.duration));
    this.lastTime = this.audio.currentTime;
    this.emit('time');
  }

  nudge(seconds) {
    if (!this.current) return;
    this.seekTo((this.audio.currentTime || 0) + seconds);
  }

  setShuffle(on) {
    this.shuffle = Boolean(on);
    if (this.queue.length > 0 && this.position >= 0) {
      this.rebuildOrder(this.order[this.position]);
    }
    this.emit();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit();
    return this.repeat;
  }

  setVolume(value) {
    this.audio.volume = Math.max(0, Math.min(1, value));
    this.audio.muted = false;
    this.emit();
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    this.emit();
    return this.audio.muted;
  }
}
