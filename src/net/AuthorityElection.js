// Authority host election, 2.5 s lease renewal, voluntary abdication on pagehide/hidden > 3 s,
// tiered contention backoff, and zero-reset failover trigger.
// CRITICAL RULE: Always attaches onValue to `authority` BEFORE calling runTransaction(authority).

export const AUTHORITY_LEASE_MS = 8000;
export const AUTHORITY_RENEW_INTERVAL_MS = 2500;
export const HIDDEN_ABDICATE_MS = 3000;
export const ABDICATE_COOLDOWN_MS = 6000;

function isMobileClient() {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent || '');
}

function isTabHidden() {
  return typeof document !== 'undefined' && !!document.hidden;
}

export class AuthorityElection {
  constructor(adapter, worldId, {
    link = null,
    onBecameHost = null,
    onLostHost = null,
    onAuthorityChange = null,
    canBeHost = () => true,
    hasOtherPeers = () => true,
    backoffRangeMs = null,
    disablePageHooks = false,
  } = {}) {
    this.adapter = adapter;
    this.worldId = worldId;
    this.link = link;
    this.onBecameHost = onBecameHost;
    this.onLostHost = onLostHost;
    this.onAuthorityChange = onAuthorityChange;
    this.canBeHost = canBeHost;
    this.hasOtherPeers = hasOtherPeers;
    this._backoffRangeMs = backoffRangeMs;

    this.path = `worlds/${worldId}/authority`;
    this.authority = null; // { hostUid, epoch, rev, leaseUntil }
    this.isHost = false;
    this.epoch = 0;
    this.rev = 0;
    this.syncing = false;
    this.stopped = false;

    this._lastRenewAt = 0;
    this._hiddenSince = 0;
    this._abdicateCooldownUntil = 0;
    this._takeoverTimer = null;
    this._takeoverScheduledAt = 0;
    this._txInFlight = false;
    this._listenerAttached = false;
    this._offAuth = null;
    this._offBeat = null;

    this._onPageHide = () => {
      if (this.isHost) this.abdicate();
    };
    this._onVisChange = () => {
      if (isTabHidden()) {
        this._hiddenSince = this.adapter.now();
      } else {
        this._hiddenSince = 0;
      }
    };

    if (!disablePageHooks) {
      if (typeof globalThis.window?.addEventListener === 'function') {
        globalThis.window.addEventListener('pagehide', this._onPageHide);
      }
      if (typeof globalThis.document?.addEventListener === 'function') {
        globalThis.document.addEventListener('visibilitychange', this._onVisChange);
      }
    }
  }

  /**
   * Attach onValue listener to `authority` FIRST (required before any runTransaction).
   */
  start() {
    if (this._listenerAttached || this.stopped) return;
    this._listenerAttached = true;

    this._offAuth = this.adapter.onValue(this.path, (val) => {
      this._handleAuthoritySnapshot(val);
    }, () => {});

    if (this.link) {
      this._offBeat = this.link.every(1000, () => {
        this.tick();
      });
    }
  }

  /** Directly inform election when we atomically created a fresh world with epoch 1, rev 0. */
  notifyInitialHost(authObj) {
    this._handleAuthoritySnapshot(authObj, false);
  }

  _handleAuthoritySnapshot(val, isFailoverPossible = true) {
    if (this.stopped) return;
    const prevIsHost = this.isHost;
    const prevEpoch = this.epoch;
    this.authority = val || null;

    const now = this.adapter.now();
    const amLiveHost = !!(
      val &&
      val.uid === this.adapter.uid &&
      typeof val.leaseUntil === 'number' &&
      val.leaseUntil > now
    );

    if (val) {
      this.epoch = val.epoch || 0;
      this.rev = val.rev || 0;
    }

    this.isHost = amLiveHost;
    this.syncing = !!(val && val.leaseUntil <= now);

    this.onAuthorityChange?.(this.authority, this.isHost);

    if (amLiveHost && (!prevIsHost || this.epoch !== prevEpoch)) {
      this._cancelTakeover();
      this._lastRenewAt = now;
      this.onBecameHost?.({
        epoch: this.epoch,
        rev: this.rev,
        isFailover: isFailoverPossible && this.epoch > 1,
      });
    } else if (!amLiveHost && prevIsHost) {
      this.onLostHost?.({ epoch: this.epoch });
    }

    // If lease is missing, expired, or abdicated, schedule tiered contention takeover
    // unless we voluntarily abdicated within ABDICATE_COOLDOWN_MS while peers exist.
    const inAbdicateCooldown = now < this._abdicateCooldownUntil && this.hasOtherPeers();
    const needsElection = !val || val.leaseUntil <= now;
    if (needsElection && !amLiveHost && !inAbdicateCooldown && this.canBeHost()) {
      this._scheduleTakeover();
    } else if (val && val.leaseUntil > now) {
      this._cancelTakeover();
    }
  }

  _computeBackoffMs() {
    if (Array.isArray(this._backoffRangeMs) && this._backoffRangeMs.length === 2) {
      const [lo, hi] = this._backoffRangeMs;
      return lo + Math.random() * Math.max(0, hi - lo);
    }
    const deprioritized = isTabHidden() || isMobileClient();
    if (deprioritized) {
      return 1500 + Math.random() * 1000; // 1500–2500 ms for mobile / hidden tab
    }
    return 50 + Math.random() * 200; // 50–250 ms for visible desktop
  }

  _scheduleTakeover() {
    if (this.stopped || this._takeoverTimer || this._takeoverScheduledAt || this._txInFlight) return;
    if (this.adapter.now() < this._abdicateCooldownUntil && this.hasOtherPeers()) return;
    const delay = this._computeBackoffMs();
    this._takeoverScheduledAt = this.adapter.now() + delay;
    this._takeoverTimer = setTimeout(() => {
      this._takeoverTimer = null;
      this._takeoverScheduledAt = 0;
      this.attemptTakeover();
    }, delay);
    if (typeof this._takeoverTimer.unref === 'function') this._takeoverTimer.unref();
  }

  _cancelTakeover() {
    if (this._takeoverTimer) {
      clearTimeout(this._takeoverTimer);
      this._takeoverTimer = null;
    }
    this._takeoverScheduledAt = 0;
  }

  /** Periodic tick (call on frame / 1 Hz beat / virtual clock advance). */
  async tick() {
    if (this.stopped || !this._listenerAttached) return;
    const now = this.adapter.now();

    if (this.isHost) {
      // Voluntary abdication if tab hidden > 3 s and healthy peers are present to take over.
      if (isTabHidden()) {
        if (!this._hiddenSince) this._hiddenSince = now;
        if (now - this._hiddenSince > HIDDEN_ABDICATE_MS && this.hasOtherPeers()) {
          await this.abdicate();
          return;
        }
      } else {
        this._hiddenSince = 0;
      }

      // Check if our own lease already expired locally (e.g. tab slept or black-holed).
      if (this.authority && this.authority.leaseUntil <= now) {
        this.isHost = false;
        this.syncing = true;
        this.onLostHost?.({ epoch: this.epoch });
        if (this.canBeHost()) await this.attemptTakeover();
        return;
      }

      // Renew lease every 2.5 s (sets leaseUntil = now + 8000).
      if (now - this._lastRenewAt >= AUTHORITY_RENEW_INTERVAL_MS) {
        await this.renewLease();
      }
      return;
    }

    // Non-host: watch for missing or expired authority lease.
    if (!this.authority || this.authority.leaseUntil <= now) {
      this.syncing = true;
      const inAbdicateCooldown = now < this._abdicateCooldownUntil && this.hasOtherPeers();
      if (!inAbdicateCooldown && this.canBeHost()) {
        if (this._takeoverScheduledAt && now >= this._takeoverScheduledAt) {
          this._cancelTakeover();
          await this.attemptTakeover();
        } else if (!this._takeoverTimer && !this._takeoverScheduledAt) {
          this._scheduleTakeover();
        }
      }
    }
  }

  /** Renew active host lease by +8000 ms. */
  async renewLease() {
    if (this.stopped || !this.isHost || this._txInFlight || !this._listenerAttached) return false;
    this._txInFlight = true;
    const uid = this.adapter.uid;
    try {
      const res = await this.adapter.runTransaction(this.path, (cur) => {
        const now = this.adapter.now();
        if (!cur || cur.uid !== uid || cur.leaseUntil <= now) return undefined;
        return {
          uid,
          epoch: cur.epoch,
          rev: cur.rev + 1,
          leaseUntil: now + AUTHORITY_LEASE_MS,
        };
      });
      if (res.committed && res.value) {
        this._lastRenewAt = this.adapter.now();
        this._handleAuthoritySnapshot(res.value);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      this._txInFlight = false;
    }
  }

  /** Attempt to claim expired/abdicated authority via runTransaction (epoch + 1, rev + 1). */
  async attemptTakeover() {
    if (this.stopped || this.isHost || this._txInFlight || !this._listenerAttached || !this.canBeHost()) {
      return false;
    }
    if (this.adapter.now() < this._abdicateCooldownUntil && this.hasOtherPeers()) {
      return false;
    }
    this._txInFlight = true;
    const uid = this.adapter.uid;
    try {
      const res = await this.adapter.runTransaction(this.path, (cur) => {
        const now = this.adapter.now();
        if (!cur) {
          return {
            uid,
            epoch: 1,
            rev: 0,
            leaseUntil: now + AUTHORITY_LEASE_MS,
          };
        }
        if (cur.leaseUntil > now) return undefined;
        return {
          uid,
          epoch: cur.epoch + 1,
          rev: cur.rev + 1,
          leaseUntil: now + AUTHORITY_LEASE_MS,
        };
      });
      if (res.committed && res.value && res.value.uid === uid) {
        this._handleAuthoritySnapshot(res.value, true);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      this._txInFlight = false;
    }
  }

  /** Voluntary abdication: atomically sets leaseUntil = serverTimestamp() so takeover happens in < 1.5 s. */
  async abdicate() {
    if (!this.isHost || !this._listenerAttached) return false;
    const uid = this.adapter.uid;
    const now = this.adapter.now();
    this.isHost = false;
    this._abdicateCooldownUntil = now + ABDICATE_COOLDOWN_MS;
    this._hiddenSince = now;
    this._cancelTakeover();
    this.onLostHost?.({ epoch: this.epoch, voluntary: true });

    try {
      const res = await this.adapter.runTransaction(this.path, (cur) => {
        const now = this.adapter.now();
        if (!cur || cur.uid !== uid || cur.leaseUntil <= now) return undefined;
        return {
          uid,
          epoch: cur.epoch,
          rev: cur.rev + 1,
          leaseUntil: this.adapter.serverTimestamp(),
        };
      });
      return !!res.committed;
    } catch {
      return false;
    }
  }

  async stop({ abdicateIfHost = true } = {}) {
    if (this.stopped) return;
    if (abdicateIfHost && this.isHost) {
      await this.abdicate();
    }
    this.stopped = true;
    this._cancelTakeover();
    this._offAuth?.();
    this._offAuth = null;
    this._offBeat?.();
    this._offBeat = null;
    if (typeof globalThis.window?.removeEventListener === 'function') {
      globalThis.window.removeEventListener('pagehide', this._onPageHide);
    }
    if (typeof globalThis.document?.removeEventListener === 'function') {
      globalThis.document.removeEventListener('visibilitychange', this._onVisChange);
    }
  }
}
