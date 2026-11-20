// Replica stream consumer for EMBER FRONT multiplayer.
// CRITICAL BANDWIDTH INVARIANT:
// - Listens to `fireRing` (never `onValue` on `fireKey`!)
// - One-shot `get(fireKey)` ONLY on cold start, ring gap > 15, epoch failover, or Wave 2+ transition
// - Strict monotonic `(e, q)` delta ordering across fireRing and planes
// - Decodes planes, meta, and roster cleanly

import { RING_SIZE, defaultCallsign } from './config.js';
import { decodeFireDelta, decodeFireKey, decodeMeta, decodePlanes } from './protocol.js';

const KEY_RETRY_MS = 500;
const WAVE_KEY_RETRY_MS = 1000;

export class StreamClient {
  constructor(adapter, worldId, {
    fireSim = null,
    opIndex = 0,
    onFireKey = null,
    onFireDelta = null,
    onPlanes = null,
    onMeta = null,
    onRoster = null,
    onSlots = null,
    onScoreEvents = null,
    onDropOutcomes = null,
    onOperationChange = null,
    onPilotJoined = null,
    nowFn = () => performance.now(),
  } = {}) {
    this.adapter = adapter;
    this.worldId = worldId;
    this.fireSim = fireSim;
    this.onFireKey = onFireKey;
    this.onFireDelta = onFireDelta;
    this.onPlanes = onPlanes;
    this.onMeta = onMeta;
    this.onRoster = onRoster;
    this.onSlots = onSlots;
    this.onScoreEvents = onScoreEvents;
    this.onDropOutcomes = onDropOutcomes;
    this.onOperationChange = onOperationChange;
    this.onPilotJoined = onPilotJoined;
    this._nowFn = nowFn;

    this.basePath = `worlds/${worldId}`;
    this.running = false;
    this.stopped = false;

    this.lastFireEpoch = 0;
    this.lastFireQ = -1;
    this.lastPlanesEpoch = 0;
    this.lastPlanesQ = -1;
    this.currentWave = 1;
    this._wantWave = 0;
    this.currentOpIndex = Math.max(0, Math.min(4, Math.floor(opIndex) || 0));
    this._wantOpIndex = null;

    this._ringSnapshot = null;
    this._syncingKey = false;
    this._keyWaitAt = 0;
    this._retryAt = 0;
    this._retryTimer = null;

    this.roster = {};
    this._rosterInitialized = false;
    this._knownRosterUids = new Set();
    this.slots = {};
    this.meta = null;
    this.stats = {
      keyFetches: 0,
      deltasApplied: 0,
      planesFrames: 0,
      gapsDetected: 0,
      waveResyncs: 0,
    };

    this._offs = [];
  }

  setOperationIndex(opIndex, { fireSim = undefined } = {}) {
    this.currentOpIndex = Math.max(0, Math.min(4, Math.floor(opIndex) || 0));
    if (this._wantOpIndex === this.currentOpIndex) this._wantOpIndex = null;
    if (fireSim !== undefined) this.fireSim = fireSim;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    this._offs = [
      this.adapter.onValue(`${this.basePath}/fireRing`, (val) => {
        this._ringSnapshot = val || null;
        this._pumpRing();
      }, () => {}),
      this.adapter.onValue(`${this.basePath}/planes`, (val) => {
        this._handlePlanes(val);
      }, () => {}),
      this.adapter.onValue(`${this.basePath}/meta`, (val) => {
        this._handleMeta(val);
      }, () => {}),
      this.adapter.onValue(`${this.basePath}/roster`, (val) => {
        this._handleRoster(val);
      }, () => {}),
      this.adapter.onValue(`${this.basePath}/slots`, (val) => {
        this.slots = val || {};
        this.onSlots?.(this.slots);
      }, () => {}),
    ];

    await this.resyncFireKey();
  }

  _handleRoster(val) {
    this.roster = val || {};
    const currentUids = new Set();
    const newlyJoined = [];

    for (const [slotKey, entry] of Object.entries(this.roster)) {
      if (!entry || typeof entry.uid !== 'string') continue;
      currentUids.add(entry.uid);
      if (this._rosterInitialized && !this._knownRosterUids.has(entry.uid) && entry.uid !== this.adapter.uid) {
        const slotId = Number(slotKey);
        newlyJoined.push({
          slotId,
          uid: entry.uid,
          name: entry.name || defaultCallsign(slotId),
          colorIdx: Number.isInteger(entry.color) ? entry.color : (slotId % 16),
        });
      }
    }

    this._knownRosterUids = currentUids;
    this._rosterInitialized = true;
    this.onRoster?.(this.roster);
    for (const pilot of newlyJoined) {
      this.onPilotJoined?.(pilot);
    }
  }

  waitingMs(now = this._nowFn()) {
    return this._keyWaitAt ? Math.max(0, now - this._keyWaitAt) : 0;
  }

  getRosterInfo(slotId) {
    const entry = this.roster[String(slotId)];
    return {
      callsign: entry?.name || defaultCallsign(slotId),
      colorIdx: Number.isInteger(entry?.color) ? entry.color : (slotId % 16),
    };
  }

  getSeatedCount(serverNow = this.adapter.now()) {
    let count = 0;
    for (const s of Object.values(this.slots)) {
      if (s && typeof s.leaseUntil === 'number' && s.leaseUntil > serverNow) count++;
    }
    return count;
  }

  _handlePlanes(node) {
    if (this.stopped || !node || typeof node.p !== 'string') return;
    const e = node.e | 0;
    const q = node.q | 0;
    if (e < this.lastPlanesEpoch) return;
    if (e === this.lastPlanesEpoch && q <= this.lastPlanesQ) return;

    this.lastPlanesEpoch = e;
    this.lastPlanesQ = q;
    this.stats.planesFrames++;

    try {
      const planes = decodePlanes(node.p);
      this.onPlanes?.(planes, { epoch: e, q, arrivedAtMs: this._nowFn() });
    } catch {
      // Ignore malformed planes payload.
    }
  }

  _handleMeta(node) {
    if (this.stopped || !node || typeof node.d !== 'string') return;
    const decoded = decodeMeta(node.d);
    if (!decoded) return;
    decoded.top10 = decoded.top10.map((entry) => {
      const info = this.getRosterInfo(entry.slotId);
      return {
        slotId: entry.slotId,
        score: entry.score,
        name: info.callsign,
        colorIdx: info.colorIdx,
      };
    });
    this.meta = decoded;
    if (
      typeof decoded.opIndex === 'number' &&
      decoded.opIndex !== this.currentOpIndex &&
      this._wantOpIndex !== decoded.opIndex
    ) {
      this._wantOpIndex = decoded.opIndex;
      this.stats.waveResyncs++;
      this.resyncFireKey({ forWave: true });
    }
    this.onMeta?.(decoded, { epoch: node.e | 0, t: node.t || 0 });
  }

  _needsOperationOrWaveSync() {
    return (
      this._wantWave > this.currentWave ||
      (this._wantOpIndex !== null && this._wantOpIndex !== this.currentOpIndex)
    );
  }

  _pumpRing() {
    if (this.stopped || this._syncingKey || !this._ringSnapshot) return;

    // If a wave or operation resync is pending and retry time passed, fetch fireKey first!
    if (this._needsOperationOrWaveSync() && this._nowFn() >= this._retryAt) {
      this.resyncFireKey({ forWave: true });
      return;
    }

    let maxEpoch = 0;
    let maxQForMaxEpoch = -1;
    const entries = [];
    for (let i = 0; i < RING_SIZE; i++) {
      const entry = this._ringSnapshot[String(i)];
      if (!entry || !Number.isInteger(entry.e) || !Number.isInteger(entry.q) || typeof entry.d !== 'string') {
        continue;
      }
      if (entry.q % RING_SIZE !== i) continue;
      entries.push(entry);
      if (entry.e > maxEpoch || (entry.e === maxEpoch && entry.q > maxQForMaxEpoch)) {
        maxEpoch = entry.e;
        maxQForMaxEpoch = entry.q;
      }
    }

    if (entries.length === 0) return;

    if (this.lastFireEpoch === 0 && this.lastFireQ < 0) {
      this.resyncFireKey();
      return;
    }

    if (maxEpoch < this.lastFireEpoch) return;
    if (maxEpoch > this.lastFireEpoch) {
      const gap = maxQForMaxEpoch - this.lastFireQ;
      if (gap >= RING_SIZE || gap < 0) {
        this.stats.gapsDetected++;
        this.resyncFireKey();
        return;
      }
      const byQ = new Map();
      for (const entry of entries) {
        if (entry.e >= this.lastFireEpoch) byQ.set(entry.q, entry);
      }
      for (let q = this.lastFireQ + 1; q <= maxQForMaxEpoch; q++) {
        if (!byQ.has(q)) {
          this.stats.gapsDetected++;
          this.resyncFireKey();
          return;
        }
      }
      for (let q = this.lastFireQ + 1; q <= maxQForMaxEpoch; q++) {
        if (!this._applyDeltaEntry(byQ.get(q))) return;
      }
      return;
    }

    if (maxQForMaxEpoch <= this.lastFireQ) return;
    if (maxQForMaxEpoch - this.lastFireQ >= RING_SIZE) {
      this.stats.gapsDetected++;
      this.resyncFireKey();
      return;
    }

    const byQ = new Map();
    for (const entry of entries) {
      if (entry.e === this.lastFireEpoch) byQ.set(entry.q, entry);
    }

    for (let q = this.lastFireQ + 1; q <= maxQForMaxEpoch; q++) {
      const entry = byQ.get(q);
      if (!entry) {
        this.stats.gapsDetected++;
        this.resyncFireKey();
        return;
      }
      if (!this._applyDeltaEntry(entry)) return;
    }
  }

  _applyDeltaEntry(entry) {
    try {
      const delta = decodeFireDelta(entry.d);

      // Detect Operation rollover (01->05->01): pause delta application and fetch fresh fireKey first!
      const opChanged = typeof delta.opIndex === 'number' && delta.opIndex !== this.currentOpIndex;
      if (opChanged) {
        this._wantOpIndex = delta.opIndex;
        this.stats.waveResyncs++;
        this.resyncFireKey({ forWave: true });
        return false;
      }

      this.lastFireEpoch = entry.e;
      this.lastFireQ = entry.q;
      this.stats.deltasApplied++;

      // Detect Mega-Basin Wave 2+ rollover -> trigger one-shot get(fireKey) for full grid & cabin hydration!
      const waveAdvanced = typeof delta.wave === 'number' && delta.wave > this.currentWave;
      if (waveAdvanced) {
        this._wantWave = Math.max(this._wantWave, delta.wave);
        this.stats.waveResyncs++;
      }

      const dirtyIndices = this.fireSim ? this.fireSim.applyExternalDelta(delta) : [];
      if (delta.scoreEvents?.length) {
        this.onScoreEvents?.(delta.scoreEvents);
      }
      if (delta.dropOutcomes?.length) {
        this.onDropOutcomes?.(delta.dropOutcomes);
      }
      this.onFireDelta?.(delta, { epoch: entry.e, q: entry.q, dirtyIndices });

      if (waveAdvanced) {
        this.resyncFireKey({ forWave: true });
      }
      return true;
    } catch {
      // Skip malformed delta.
      return true;
    }
  }

  /** One-shot get(fireKey) on cold start, ring gap > 15, epoch jump, Operation change, or Wave 2+ rollover. */
  async resyncFireKey({ forWave = false } = {}) {
    if (this.stopped || this._syncingKey) return false;
    const now = this._nowFn();
    if (!forWave && now < this._retryAt) return false;

    this._syncingKey = true;
    this._keyWaitAt = now;
    this.stats.keyFetches++;
    const prevEpoch = this.lastFireEpoch;
    const prevQ = this.lastFireQ;
    const prevWave = this.currentWave;
    const prevOpIndex = this.currentOpIndex;

    try {
      const key = await this.adapter.get(`${this.basePath}/fireKey`);
      if (this.stopped) return false;

      if (key && Number.isInteger(key.e) && Number.isInteger(key.q) && typeof key.d === 'string') {
        const decoded = decodeFireKey(key.d);
        const keyWave = decoded.wave || 1;
        const keyOpIndex = typeof decoded.opIndex === 'number' ? decoded.opIndex : this.currentOpIndex;
        const satisfiesWave = this._wantWave > this.currentWave && keyWave >= this._wantWave;
        const satisfiesOp = this._wantOpIndex !== null && keyOpIndex === this._wantOpIndex;
        const opDiffers = keyOpIndex !== this.currentOpIndex;
        const isNewer = key.e > this.lastFireEpoch || (key.e === this.lastFireEpoch && key.q > this.lastFireQ);

        if (satisfiesOp || opDiffers || satisfiesWave || isNewer || this.lastFireQ < 0) {
          if (opDiffers) {
            this.currentOpIndex = keyOpIndex;
            await this.onOperationChange?.(keyOpIndex, decoded);
            if (this.stopped) return false;
          }
          if (this._wantOpIndex === keyOpIndex) this._wantOpIndex = null;
          this.lastFireEpoch = key.e;
          this.lastFireQ = key.q;
          this.currentWave = keyWave;
          if (this._wantWave <= keyWave) this._wantWave = 0;
          this.fireSim?.applyExternalKey(decoded);
          this.onFireKey?.(decoded, { epoch: key.e, q: key.q, t: key.t });
        }
      }
    } catch {
      // Throttled retry below.
    } finally {
      this._keyWaitAt = 0;
      this._syncingKey = false;
    }

    if (this.stopped) return false;

    const stillNeedsSync = this._needsOperationOrWaveSync();
    const madeProgress =
      this.lastFireEpoch !== prevEpoch ||
      this.lastFireQ !== prevQ ||
      this.currentWave !== prevWave ||
      this.currentOpIndex !== prevOpIndex;

    if (stillNeedsSync || !madeProgress) {
      const delay = stillNeedsSync ? WAVE_KEY_RETRY_MS : KEY_RETRY_MS;
      this._retryAt = this._nowFn() + delay;
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (this._needsOperationOrWaveSync()) {
          this.resyncFireKey({ forWave: true });
        } else {
          this._pumpRing();
        }
      }, delay);
      if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
      return madeProgress;
    }

    this._pumpRing();
    return true;
  }

  /** Optional tick hook for virtual-clock environments to drive pending wave/operation resync retries. */
  tick() {
    if (this.stopped || this._syncingKey) return;
    if (this._needsOperationOrWaveSync() && this._nowFn() >= this._retryAt) {
      this.resyncFireKey({ forWave: true });
    }
  }

  stop() {
    this.stopped = true;
    this.running = false;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    for (const off of this._offs) off?.();
    this._offs = [];
  }
}
