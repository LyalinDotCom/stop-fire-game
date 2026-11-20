// Connection health supervisor and 1 Hz Web Worker beat adapted from vanguard-protocol/src/net/Link.js.
// Hurries RTDB reconnects along [3, 6, 12, 24] s ladder and drops black-holed sockets after STALL_KICK (6 s).

const HELD_SEC = 2;
const KICK_LADDER_SEC = [3, 6, 12, 24];
export const STALL_THRESHOLD_SEC = 3;
export const STALL_KICK_SEC = 6;
const MIN_BEAT_MS = 900;
const WORKER_SRC = 'const t = setInterval(() => postMessage(0), 1000); onmessage = () => clearInterval(t);';

function startBeatTicker(fn) {
  if (
    typeof document !== 'undefined' &&
    typeof Worker === 'function' &&
    typeof Blob === 'function' &&
    typeof URL?.createObjectURL === 'function'
  ) {
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      const worker = new Worker(url);
      URL.revokeObjectURL(url);
      worker.onmessage = fn;
      return () => {
        worker.onmessage = null;
        worker.postMessage(0);
        worker.terminate();
      };
    } catch {
      // Fall back to setInterval when Blob Workers are unavailable.
    }
  }
  const timer = setInterval(fn, 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export class Link {
  constructor(adapter, { nowFn = () => performance.now(), disableTicker = false } = {}) {
    this.adapter = adapter;
    this._nowFn = nowFn;
    this.up = adapter.connected !== false;
    this.since = this._nowFn();
    this.lastOutage = null;
    this.drops = 0;
    this.kicks = 0;
    this.kickAt = 0;
    this.stallAt = 0;
    this.steppedAt = 0;
    this.beatAt = this.since - MIN_BEAT_MS;
    this.handlers = new Set();
    this.beats = new Set();
    this.paused = false;
    this.stopped = false;

    this._offConnected = adapter.onConnected((up) => this.set(!!up));

    const wake = () => {
      if (this.stopped) return;
      if (!this.up || this.downFor() >= STALL_KICK_SEC) this.kick();
    };
    this._onOnline = () => wake();
    this._onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) wake();
    };

    this._stopTicker = disableTicker ? () => {} : startBeatTicker(() => this.beat());
    if (typeof globalThis.window?.addEventListener === 'function') {
      globalThis.window.addEventListener('online', this._onOnline);
    }
    if (typeof globalThis.document?.addEventListener === 'function') {
      globalThis.document.addEventListener('visibilitychange', this._onVisible);
    }
  }

  /** Pause auto-reconnect (used for intentional 5-min idle socket-save goOffline). */
  pause() {
    this.paused = true;
    this.stallAt = 0;
  }

  resume() {
    this.paused = false;
  }

  set(up) {
    if (this.stopped || up === this.up) return;
    const now = this._nowFn();
    const from = up ? now : (this.stallAt || now);
    const ms = Math.max(0, from - this.since);
    const freshDrop = !up && !this.paused && !this.stallAt && ms >= HELD_SEC * 1000;

    this.up = up;
    this.since = from;
    if (up) {
      this.lastOutage = { at: now, ms };
    } else {
      this.drops++;
      if (!this.stallAt) {
        this.kicks = 0;
        this.kickAt = KICK_LADDER_SEC[0];
      }
    }
    this.stallAt = 0;

    for (const fn of [...this.handlers]) {
      try { fn(up); } catch { /* ignore handler error */ }
    }
    if (freshDrop) this.reconnect();
  }

  kick() {
    if (this.stopped || this.paused) return;
    if (this.up && !this.stallAt) return;
    const stepSec = KICK_LADDER_SEC[Math.min(this.kicks, KICK_LADDER_SEC.length - 1)];
    this.kicks++;
    this.kickAt = this.downFor() + stepSec;
    this.reconnect();
  }

  reconnect() {
    if (this.stopped) return;
    this.adapter.goOffline();
    this.adapter.goOnline();
  }

  /** Report age (ms) of oldest unacknowledged in-flight write or get(). */
  step(waitingMs) {
    if (this.stopped) return;
    const now = this._nowFn();
    this.steppedAt = now;
    if (this.up && waitingMs < STALL_THRESHOLD_SEC * 1000) {
      this.stallAt = 0;
      this.kicks = 0;
    } else if (this.up && !this.stallAt && now - this.since >= STALL_THRESHOLD_SEC * 1000) {
      this.stallAt = Math.max(now - waitingMs, this.since);
      this.kickAt = Math.max(STALL_KICK_SEC, KICK_LADDER_SEC[Math.min(this.kicks, KICK_LADDER_SEC.length - 1)]);
    }
    if (now - this.beatAt >= MIN_BEAT_MS) {
      queueMicrotask(() => this.beat());
    }
  }

  beat() {
    if (this.stopped) return;
    const now = this._nowFn();
    if (now - this.beatAt < MIN_BEAT_MS) return;
    this.beatAt = now;
    if (this.stallAt && now - this.steppedAt > 2 * MIN_BEAT_MS) {
      this.stallAt = 0;
    }
    if ((!this.up || this.stallAt) && this.downFor(now) >= this.kickAt) {
      this.kick();
    }
    for (const fn of [...this.beats]) {
      try { fn(now); } catch { /* ignore beat error */ }
    }
  }

  downFor(now = this._nowFn()) {
    const from = this.up ? this.stallAt : this.since;
    return from ? Math.max(0, now - from) / 1000 : 0;
  }

  recentlyDown(ms, now = this._nowFn()) {
    return !this.up || (!!this.lastOutage && now - this.lastOutage.at < ms);
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  every(ms, fn) {
    let interval = ms;
    let callback = fn;
    if (typeof ms === 'function') {
      callback = ms;
      interval = 1000;
    }
    let last = this._nowFn();
    const entry = interval <= 1000
      ? () => callback()
      : (now) => {
          if (now - last >= interval - 100) {
            last = now;
            callback();
          }
        };
    this.beats.add(entry);
    return () => this.beats.delete(entry);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this._offConnected?.();
    this._stopTicker?.();
    if (typeof globalThis.window?.removeEventListener === 'function') {
      globalThis.window.removeEventListener('online', this._onOnline);
    }
    if (typeof globalThis.document?.removeEventListener === 'function') {
      globalThis.document.removeEventListener('visibilitychange', this._onVisible);
    }
    this.handlers.clear();
    this.beats.clear();
  }
}
