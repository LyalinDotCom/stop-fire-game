// connId-fenced RTDB presence with strict sequential write -> onDisconnect arming
// and clean remove-before-cancel teardown (adapted from vanguard-protocol/src/net/Presence.js).
// - Commits `this.connId` ONLY after server ack (prevents un-acked connId on in/$uid and double-write races)
// - Resolves `this.ready` with null on stop() so callers never hang mid-connect

import { isPermissionDenied } from './RtdbAdapter.js';

const CONN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RETRY_MS = [150, 1000];

export function generateConnId() {
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 12; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let id = '';
  for (let i = 0; i < 12; i++) id += CONN_ALPHABET[bytes[i] % CONN_ALPHABET.length];
  return id;
}

export class Presence {
  constructor(adapter, worldId, link, { autoStart = true, nowFn = () => adapter.now(), onConnChange = null } = {}) {
    this.adapter = adapter;
    this.worldId = worldId;
    this.link = link;
    this._nowFn = nowFn;
    this.onConnChange = onConnChange;
    this.path = `worlds/${worldId}/presence/${adapter.uid}`;
    this.connId = null; // Strictly the last server-acknowledged live connId!
    this._inFlightConnId = null;
    this.record = null;
    this.written = false; // Tracks whether presence/$uid currently exists for conditional delete.
    this.stopped = false;
    this._marking = false;
    this._pending = false;
    this._retryTimer = null;
    this._retryAt = 0;
    this._failures = 0;
    this._resolveReady = null;
    this.ready = new Promise((resolve) => { this._resolveReady = resolve; });

    this._offs = [
      link ? link.on((up) => { if (up && !this._marking && !this.stopped) this.mark(); }) : () => {},
      adapter.onValue(this.path, (val) => {
        this.record = val ?? null;
        if (val) this.written = true;
        // Ignore initial null or own in-flight echo while a mark() write is already in progress.
        if (this._marking || this.stopped) return;
        if (
          this.connId &&
          (!this.link || this.link.up) &&
          (!val || val.conn !== this.connId || val.away)
        ) {
          this.mark();
        }
      }, () => {}),
      link ? link.every(1000, () => {
        if (this._retryAt && this._nowFn() >= this._retryAt) this._retryNow();
      }) : () => {},
    ];

    if (autoStart) this.mark();
  }

  /**
   * Mark this client present with a fresh 12-char alphanumeric connId, await server ack FIRST,
   * commit this.connId ONLY after ack, and ONLY THEN sequentially arm onDisconnect.
   */
  async mark() {
    if (this.stopped) return false;
    if (this._retryAt && this._nowFn() >= this._retryAt) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
      this._retryAt = 0;
    }
    if (this._marking || this._retryAt) {
      this._pending = !this._retryAt;
      return false;
    }

    this._marking = true;
    const id = generateConnId();
    this._inFlightConnId = id;
    let committed = false;

    try {
      // Step 1: Write live presence record and await server ack BEFORE publishing connId or arming onDisconnect.
      try {
        await this.adapter.set(this.path, {
          conn: id,
          at: this.adapter.serverTimestamp(),
        });
      } catch (err) {
        // Ack-lost replay: if our write actually committed pre-drop and watcher already has it, keep going.
        if (!isPermissionDenied(err) || this.stopped || this.record?.conn !== id || this.record?.away) {
          throw err;
        }
      }
      committed = true;
      this.written = true;
      if (this.stopped) return false;

      // Publish acked connId now that server holds { conn: id } without away: true.
      const changed = this.connId !== id;
      this.connId = id;
      if (changed) this.onConnChange?.(id);

      // Step 2: Sequentially arm connId-fenced onDisconnect away mark.
      await this.adapter.onDisconnect(this.path).set({
        conn: id,
        at: this.adapter.serverTimestamp(),
        away: true,
      });

      this._failures = 0;
      this._resolveReady?.(id);
      this._resolveReady = null;
      return true;
    } catch {
      if (!committed) {
        // Do not overwrite last known good connId on failed write.
      }
      if (!this.stopped) {
        const wait = RETRY_MS[Math.min(this._failures++, RETRY_MS.length - 1)];
        this._retryAt = this._nowFn() + wait;
        clearTimeout(this._retryTimer);
        if (wait < 1000) {
          this._retryTimer = setTimeout(() => this._retryNow(), wait);
          if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
        } else {
          this._retryTimer = null;
        }
      }
      return false;
    } finally {
      this._inFlightConnId = null;
      this._marking = false;
      const shouldRunAgain = this._pending && !this._retryAt && !this.stopped;
      this._pending = false;
      if (shouldRunAgain) this.mark();
    }
  }

  _retryNow() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._retryAt = 0;
    this.mark();
  }

  /**
   * Clean teardown: resolve any pending `ready` waiters, remove presence/$uid FIRST
   * (only if known to exist — conditional delete!), then cancel armed onDisconnect.
   */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._retryAt = 0;
    for (const off of this._offs) off?.();
    this._offs = [];

    // Ensure any caller awaiting `this.ready` unblocks cleanly instead of hanging forever.
    this._resolveReady?.(null);
    this._resolveReady = null;

    if (this.written) {
      this.written = false;
      await this.adapter.remove(this.path).catch(() => {});
    }
    await this.adapter.onDisconnect(this.path).cancel().catch(() => {});
  }
}
