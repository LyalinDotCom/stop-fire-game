// Authoritative Host simulation runner and RTDB broadcaster for EMBER FRONT Mega-Basin.
// - Runs FireSim at 10 Hz (using BackgroundWorker when tab is hidden)
// - Validates client in/$uid speed/scoop/tank bounds + minimum 0.25 s drop burst on dropSeq increment
// - Publishes full fireKey immediately when Wave 2+ fullReset occurs (respecting >= 4 s pacing)
// - Evicts dead/away slots (>= 60 s grace, strict conditional leaf deletes, safe if deadUid re-seated)
// - Publishes planes (4 Hz), fireRing/{q%16} (2 Hz), fireKey (5 s), meta (0.5 Hz), worldsIndex (10 s)

import { createBackgroundTicker } from '../sim/BackgroundWorker.js';
import { FLIGHT_CONSTANTS } from '../sim/FlightModel.js';
import { PACING_MS, PROTOCOL_VERSION, RING_SIZE, defaultCallsign, getBuildHash } from './config.js';
import {
  decodeFireDelta,
  decodeFireKey,
  decodeInput,
  decodePlanes,
  encodeFireDeltaWithOverflow,
  encodeFireKey,
  encodeMeta,
  encodePlanes,
} from './protocol.js';

export const SIM_STEP_DT = 0.1; // 10 Hz
export const PLANES_INTERVAL_MS = 250; // 4 Hz
export const FIRE_RING_INTERVAL_MS = 500; // 2 Hz
export const FIRE_KEY_INTERVAL_MS = 5000; // 0.2 Hz (>= 4 s rule)
export const META_INTERVAL_MS = 2000; // 0.5 Hz (>= 0.8 s rule)
export const INDEX_INTERVAL_MS = 10000; // 0.1 Hz (>= 5 s rule)
export const EVICT_AWAY_GRACE_MS = 60000; // >= 60 s grace before evicting away slot
export const HOST_SCOOP_MAX_AGL = (FLIGHT_CONSTANTS.SCOOP_EXIT_AGL ?? 11.5) + 0.5; // Tracks forgiving lake scoop ceiling
const MIN_DROP_BURST_SEC = 0.25;
const CRASH_SPEED_THRESHOLD_KMH = 40;
const STALE_PEER_COAST_START_MS = 90; // integrate smooth dead-reckoning between 250 ms client beats AND through drops
const STALE_PEER_LEVEL_MS = 1100; // level wings & stop spray if one peer goes silent > 1.1 s

const KMH_TO_MS = 1 / 3.6;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MAX_PLAUSIBLE_SPEED_MS = 72;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function isDropSeqNewer(nextSeq, prevSeq) {
  const diff = (nextSeq - prevSeq) & 0xffff;
  return diff > 0 && diff < 32768;
}

export class HostBroadcaster {
  constructor(adapter, worldId, {
    terrain,
    fireSim,
    epoch = 1,
    opIndex = 0,
    buildHash = getBuildHash(),
    worldName = 'Cinderpine Basin',
    localSlotId = null,
    planesIntervalMs = PLANES_INTERVAL_MS,
    onScoreEvents = null,
    onImpactEvents = null,
    onDropOutcomes = null,
    onWorldEvents = null,
    onOperationAdvance = null,
    onOperationHydrated = null,
    onSimStep = null,
    enableBackgroundTicker = true,
  }) {
    this.adapter = adapter;
    this.worldId = worldId;
    this.terrain = terrain;
    this.fireSim = fireSim;
    this.epoch = epoch;
    this.opIndex = Math.max(0, Math.min(4, Math.floor(opIndex) || 0));
    this.buildHash = buildHash;
    this.worldName = worldName;
    this.localSlotId = localSlotId;
    this.planesIntervalMs = planesIntervalMs;
    this.onScoreEvents = onScoreEvents;
    this.onImpactEvents = onImpactEvents;
    this.onDropOutcomes = onDropOutcomes;
    this.onWorldEvents = onWorldEvents;
    this.onOperationAdvance = onOperationAdvance;
    this.onOperationHydrated = onOperationHydrated;
    this.onSimStep = onSimStep;

    this.basePath = `worlds/${worldId}`;
    this.running = false;
    this.hydrated = false;
    this._bootstrapping = false;

    this.planesSeq = 0;
    this.fireSeq = 0;

    this._config = null;
    this._slots = {};
    this._roster = {};
    this._presence = {};
    this._inputs = {};

    this._pilots = new Map();
    this._awaySince = new Map();

    this._localAircraft = null;
    this._localDropSeq = 0;

    this._pendingCells = new Map();
    this._pendingCabins = new Map();
    this._pendingScores = [];
    this._pendingDropOutcomes = [];
    this._overflowCells = [];
    this._needsWaveKeyPublish = false;
    this._advancingOperation = false;

    this._lastPlanesAt = 0;
    this._lastFireRingAt = 0;
    this._lastFireKeyAt = 0;
    this._lastMetaAt = 0;
    this._lastIndexAt = 0;
    this._lastEvictCheckAt = 0;
    this._simAccum = 0;
    this._planesWriteInFlightSince = 0;
    this._planesWriteToken = 0;
    this._planesPendingToken = 0;
    this._ringWriteInFlightSince = 0;
    this._ringWriteToken = 0;
    this._ringPendingToken = 0;

    this.lastPublishedPlanes = [];

    this._offs = [];
    this._bgTicker = enableBackgroundTicker
      ? createBackgroundTicker(100, () => {
          if (this.running && this.hydrated && this._bgTicker?.isHidden?.()) {
            this.step(SIM_STEP_DT);
          }
        })
      : null;
  }

  setEpoch(epoch) {
    this.epoch = epoch;
  }

  setLocalSlotId(slotId) {
    this.localSlotId = slotId;
  }

  setLocalAircraft(aircraft, dropSeq = 0) {
    this._localAircraft = aircraft;
    this._localDropSeq = dropSeq;
  }

  /**
   * Swap active Operation terrain & FireSim (called on Operation 01->05->01 rollover
   * or during Host failover hydration when the shard is already on another Operation).
   */
  setWorld({ terrain, fireSim, opIndex, worldName = null, publishNow = true } = {}) {
    if (terrain) this.terrain = terrain;
    if (fireSim) this.fireSim = fireSim;
    if (typeof opIndex === 'number') {
      this.opIndex = Math.max(0, Math.min(4, Math.floor(opIndex)));
    }
    if (typeof worldName === 'string' && worldName) {
      this.worldName = worldName;
    }

    this._pendingCells.clear();
    this._overflowCells.length = 0;
    this._pendingCabins.clear();
    this._pendingScores.length = 0;
    this._pendingDropOutcomes.length = 0;
    this._pilots.clear();
    this._needsWaveKeyPublish = true;
    this._advancingOperation = false;

    if (publishNow && this.running && this.hydrated) {
      const now = this.adapter.now();
      if (!this._lastFireKeyAt || now - this._lastFireKeyAt >= PACING_MS.fireKey + 250) {
        this._needsWaveKeyPublish = false;
        this.publishFireKey().catch(() => {});
      }
      if (!this._lastMetaAt || now - this._lastMetaAt >= PACING_MS.meta + 250) {
        this.publishMeta().catch(() => {});
      }
      if (!this._lastIndexAt || now - this._lastIndexAt >= PACING_MS.worldsIndex + 250) {
        this.publishWorldsIndex().catch(() => {});
      }
    }
  }

  async start({ isFailover = false, forceFreshMission = false } = {}) {
    if (this.running) return;
    this.running = true;
    this._bootstrapping = true;

    this._offs = [
      this.adapter.onValue(`${this.basePath}/slots`, (v) => { this._slots = v || {}; }, () => {}),
      this.adapter.onValue(`${this.basePath}/roster`, (v) => { this._roster = v || {}; }, () => {}),
      this.adapter.onValue(`${this.basePath}/presence`, (v) => { this._presence = v || {}; }, () => {}),
      this.adapter.onValue(`${this.basePath}/in`, (v) => { this._inputs = v || {}; }, () => {}),
    ];

    const [configNode, fireKey, fireRing, planesNode, metaNode, indexNode, slots, roster, presence, inputs] =
      await Promise.all([
        this.adapter.get(`${this.basePath}/config`).catch(() => null),
        this.adapter.get(`${this.basePath}/fireKey`).catch(() => null),
        this.adapter.get(`${this.basePath}/fireRing`).catch(() => null),
        this.adapter.get(`${this.basePath}/planes`).catch(() => null),
        this.adapter.get(`${this.basePath}/meta`).catch(() => null),
        this.adapter.queryWorldsIndex({ limit: 20 }).then((all) => all?.[this.worldId] ?? null).catch(() => null),
        this.adapter.get(`${this.basePath}/slots`).catch(() => null),
        this.adapter.get(`${this.basePath}/roster`).catch(() => null),
        this.adapter.get(`${this.basePath}/presence`).catch(() => null),
        this.adapter.get(`${this.basePath}/in`).catch(() => null),
      ]);

    if (!this.running) {
      this._bootstrapping = false;
      return;
    }

    this._config = configNode || null;
    this._slots = slots || {};
    this._roster = roster || {};
    this._presence = presence || {};
    this._inputs = inputs || {};

    this._lastFireKeyAt = fireKey?.t || 0;
    this._lastMetaAt = metaNode?.t || 0;
    this._lastIndexAt = indexNode?.updatedAt || 0;

    if (planesNode && Number.isInteger(planesNode.q)) {
      this.planesSeq = planesNode.q;
      if (!forceFreshMission && planesNode.p) {
        try {
          const decoded = decodePlanes(planesNode.p);
          for (const p of decoded) {
            this._pilots.set(p.slotId, {
              slotId: p.slotId,
              uid: this._slots[String(p.slotId)]?.uid || null,
              x: p.x,
              y: p.y,
              z: p.z,
              yawDeg: p.yawDeg,
              pitchDeg: p.pitchDeg,
              rollDeg: p.rollDeg,
              speedKmh: p.speedKmh,
              tankPct: p.tankPct,
              releasing: p.releasing,
              scooping: p.scooping,
              autopilot: p.autopilot,
              flags: p.flags,
              lastInputT: 0,
              lastDropSeq: 0,
              dropBurstTimer: 0,
            });
          }
        } catch {
          // Ignore malformed old planes payload.
        }
      }
    }

    if (forceFreshMission) {
      // Starting a brand-new hosted lobby on a fresh or stale shard:
      // keep our fresh Operation 01 FireSim, only advance seq past any prior RTDB entries.
      let maxQ = Number.isInteger(fireKey?.q) ? fireKey.q : 0;
      if (fireRing && typeof fireRing === 'object') {
        for (const entry of Object.values(fireRing)) {
          if (entry && Number.isInteger(entry.q) && entry.q > maxQ) maxQ = entry.q;
        }
      }
      this.fireSeq = maxQ;
      this._pilots.clear();
    } else if (fireKey && typeof fireKey.d === 'string') {
      try {
        const keyState = decodeFireKey(fireKey.d);
        if (
          typeof keyState.opIndex === 'number' &&
          (keyState.opIndex !== this.opIndex || keyState.gridSize !== this.fireSim?.gridSize)
        ) {
          this.opIndex = Math.max(0, Math.min(4, keyState.opIndex));
          await this.onOperationHydrated?.(this.opIndex, keyState);
        }
        if (this.fireSim && keyState.gridSize === this.fireSim.gridSize) {
          this.fireSim.applyExternalKey(keyState);
          this.fireSeq = Number.isInteger(fireKey.q) ? fireKey.q : 0;

          if (fireRing && typeof fireRing === 'object') {
            const deltas = Object.values(fireRing)
              .filter((entry) => entry && Number.isInteger(entry.q) && entry.q > this.fireSeq && typeof entry.d === 'string')
              .sort((a, b) => a.q - b.q);
            for (const entry of deltas) {
              try {
                const delta = decodeFireDelta(entry.d);
                if (typeof delta.opIndex === 'number' && delta.opIndex !== this.opIndex) continue;
                this.fireSim.applyExternalDelta(delta);
                this.fireSeq = entry.q;
              } catch {
                // Skip corrupted ring entry.
              }
            }
          }
        }
      } catch {
        // Keep current FireSim state if fireKey unreadable.
      }
    } else if (!isFailover) {
      this.fireSeq = 0;
    }

    const now = this.adapter.now();
    this._lastPlanesAt = now;
    this._lastFireRingAt = now;

    // Publish initial snapshots BEFORE flipping hydrated = true so step() cannot
    // race with start() and fire a duplicate meta/fireKey/worldsIndex write inside pacing rules.
    const epochAdvanced = !fireKey || this.epoch > (fireKey.e | 0);
    if (epochAdvanced || !this._lastFireKeyAt || now - this._lastFireKeyAt >= PACING_MS.fireKey + 250) {
      await this.publishFireKey().catch(() => {});
    } else {
      this._lastFireKeyAt = Math.max(this._lastFireKeyAt, (fireKey?.t || 0) + 250);
    }
    const metaEpochAdvanced = !metaNode || this.epoch > (metaNode.e | 0);
    if (metaEpochAdvanced || !this._lastMetaAt || now - this._lastMetaAt >= PACING_MS.meta + 250) {
      await this.publishMeta().catch(() => {});
    } else {
      this._lastMetaAt = Math.max(this._lastMetaAt, (metaNode?.t || 0) + 250);
    }
    if (!this._lastIndexAt || now - this._lastIndexAt >= PACING_MS.worldsIndex + 250) {
      await this.publishWorldsIndex().catch(() => {});
    } else {
      this._lastIndexAt = Math.max(this._lastIndexAt, (indexNode?.updatedAt || 0) + 250);
    }

    if (!this.running) {
      this._bootstrapping = false;
      return;
    }

    const readyAt = this.adapter.now();
    this._lastPlanesAt = readyAt;
    this._lastFireRingAt = readyAt;
    this._bootstrapping = false;
    this.hydrated = true;
    this._bgTicker?.start?.();
  }

  getPilotTank(slotId) {
    const p = this._pilots.get(slotId);
    return p ? p.tankPct : null;
  }

  /** Oldest unacknowledged Host publish write age (ms); 0 when healthy. */
  getPublishWaitMs(now = this.adapter.now()) {
    const planesWait = this._planesWriteInFlightSince ? Math.max(0, now - this._planesWriteInFlightSince) : 0;
    const ringWait = this._ringWriteInFlightSince ? Math.max(0, now - this._ringWriteInFlightSince) : 0;
    return Math.max(planesWait, ringWait);
  }

  _countLiveSlots(now) {
    let count = 0;
    let hasLocal = false;
    for (const [slotKey, sObj] of Object.entries(this._slots)) {
      if (sObj && typeof sObj.leaseUntil === 'number' && sObj.leaseUntil > now) {
        count++;
        if (this.localSlotId !== null && Number(slotKey) === this.localSlotId) hasLocal = true;
      }
    }
    if (!hasLocal && this.localSlotId !== null) count++;
    return count;
  }

  step(dtSec) {
    if (!this.running || !this.hydrated || this._bootstrapping) return;

    this._simAccum += Math.min(0.5, Math.max(0, dtSec));
    const maxSubsteps = 5;
    let steps = 0;

    while (this._simAccum >= SIM_STEP_DT - 1e-6 && steps < maxSubsteps) {
      this._simAccum -= SIM_STEP_DT;
      this._tickSim10Hz(SIM_STEP_DT);
      steps++;
    }

    const now = this.adapter.now();

    if (now - this._lastPlanesAt >= this.planesIntervalMs) {
      this._lastPlanesAt = now;
      this.publishPlanes().catch(() => {});
    }
    if (now - this._lastFireRingAt >= FIRE_RING_INTERVAL_MS) {
      this._lastFireRingAt = now;
      this.publishFireRing().catch(() => {});
    }
    // Wave 2+ fullReset forces a fireKey publish as soon as >= 4250 ms pacing allows.
    const keyInterval = this._needsWaveKeyPublish ? (PACING_MS.fireKey + 250) : FIRE_KEY_INTERVAL_MS;
    if (now - this._lastFireKeyAt >= keyInterval) {
      this._lastFireKeyAt = now;
      this._needsWaveKeyPublish = false;
      this.publishFireKey().catch(() => {});
    }
    if (now - this._lastMetaAt >= META_INTERVAL_MS) {
      this._lastMetaAt = now;
      this.publishMeta().catch(() => {});
    }
    if (now - this._lastIndexAt >= INDEX_INTERVAL_MS) {
      this._lastIndexAt = now;
      this.publishWorldsIndex().catch(() => {});
    }
    if (now - this._lastEvictCheckAt >= 5000) {
      this._lastEvictCheckAt = now;
      this.evictDeadSlots().catch(() => {});
    }
  }

  _tickSim10Hz(dt) {
    const now = this.adapter.now();
    const activeSlots = new Set();
    let activeManualPilots = 0;

    // Build slot list, ensuring local Host pilot is ALWAYS processed even before onValue(slots) echoes back.
    const slotEntries = Object.entries(this._slots);
    if (
      this.localSlotId !== null &&
      this._localAircraft &&
      !this._slots[String(this.localSlotId)]
    ) {
      slotEntries.push([
        String(this.localSlotId),
        { uid: this.adapter.uid, leaseUntil: now + 40000 },
      ]);
    }

    for (const [slotKey, slotObj] of slotEntries) {
      if (!slotObj || typeof slotObj.uid !== 'string') continue;
      if (typeof slotObj.leaseUntil === 'number' && slotObj.leaseUntil <= now) continue;

      const slotId = Number(slotKey);
      if (!Number.isInteger(slotId) || slotId < 0 || slotId >= 100) continue;
      activeSlots.add(slotId);

      const uid = slotObj.uid;
      let pilot = this._pilots.get(slotId);
      const isLocalHostPilot =
        (slotId === this.localSlotId || uid === this.adapter.uid) && !!this._localAircraft;

      if (isLocalHostPilot) {
        const a = this._localAircraft;
        const isCrashed = !!a.crashed;
        if (!pilot) {
          pilot = {
            slotId,
            uid,
            x: a.x,
            y: a.y,
            z: a.z,
            yawDeg: a.yawDeg,
            pitchDeg: a.pitchDeg,
            rollDeg: a.rollDeg,
            speedKmh: isCrashed ? 0 : a.speedKmh,
            tankPct: isCrashed ? 0 : (a.tankPct ?? 100),
            releasing: isCrashed ? false : !!a.releasing,
            scooping: isCrashed ? false : !!a.scooping,
            autopilot: !!a.autopilot,
            crashed: isCrashed,
            flags: 0,
            lastInputT: now,
            lastDropSeq: this._localDropSeq,
            dropBurstTimer: (!isCrashed && a.releasing) ? MIN_DROP_BURST_SEC : 0,
          };
          this._pilots.set(slotId, pilot);
        } else {
          if (isCrashed) {
            pilot.crashed = true;
            pilot.tankPct = 0;
            pilot.releasing = false;
            pilot.scooping = false;
            pilot.dropBurstTimer = 0;
            pilot.speedKmh = 0;
            pilot.x = a.x;
            pilot.y = a.y;
            pilot.z = a.z;
          } else {
            if (pilot.crashed) {
              pilot.crashed = false;
            }
            if (isDropSeqNewer(this._localDropSeq, pilot.lastDropSeq)) {
              pilot.dropBurstTimer = Math.max(pilot.dropBurstTimer, MIN_DROP_BURST_SEC);
              pilot.lastDropSeq = this._localDropSeq;
            }
            pilot.x = a.x;
            pilot.y = a.y;
            pilot.z = a.z;
            pilot.yawDeg = a.yawDeg;
            pilot.pitchDeg = a.pitchDeg;
            pilot.rollDeg = a.rollDeg;
            pilot.speedKmh = a.speedKmh;
            // Host is authoritative for its own plane — ALWAYS keep tankPct synced with FlightModel
            // so Host water drops are NEVER silently blocked by a tankPct desync!
            pilot.tankPct = typeof a.tankPct === 'number' ? a.tankPct : pilot.tankPct;
            pilot.releasing = !!a.releasing;
            pilot.scooping = !!a.scooping;
          }
          pilot.uid = uid;
          pilot.autopilot = !!a.autopilot;
          pilot.lastInputT = now;
        }
      } else {
        const rawIn = this._inputs[uid];
        const decoded = rawIn && typeof rawIn.d === 'string' ? decodeInput(rawIn.d) : null;
        const inputSeq = rawIn && Number.isInteger(rawIn.s) ? rawIn.s : null;
        if (decoded) {
          const isCrashed = decoded.speedKmh < CRASH_SPEED_THRESHOLD_KMH;
          if (!pilot || pilot.uid !== uid) {
            pilot = {
              slotId,
              uid,
              x: decoded.x,
              y: decoded.y,
              z: decoded.z,
              yawDeg: decoded.yawDeg,
              pitchDeg: decoded.pitchDeg,
              rollDeg: decoded.rollDeg,
              speedKmh: isCrashed
                ? 0
                : clamp(decoded.speedKmh, FLIGHT_CONSTANTS.MIN_SPEED_KMH, FLIGHT_CONSTANTS.MAX_SPEED_KMH),
              tankPct: isCrashed ? 0 : (pilot && pilot.uid === uid ? pilot.tankPct : 100),
              releasing: isCrashed ? false : decoded.releasing,
              scooping: isCrashed ? false : decoded.scooping,
              autopilot: decoded.autopilot,
              crashed: isCrashed,
              flags: decoded.flags,
              lastInputT: rawIn.t || now,
              lastInputSeq: inputSeq,
              lastFreshAt: now,
              lastDropSeq: decoded.dropSeq,
              dropBurstTimer: (!isCrashed && decoded.dropSeq > 0 && decoded.releasing) ? MIN_DROP_BURST_SEC : 0,
            };
            this._pilots.set(slotId, pilot);
          } else {
            const isFresh =
              (inputSeq !== null && inputSeq !== pilot.lastInputSeq) ||
              ((rawIn.t || 0) > (pilot.lastInputT || 0));

            if (isFresh) {
              const prevFreshAt = pilot.lastFreshAt || now;
              pilot.lastInputSeq = inputSeq;
              pilot.lastInputT = rawIn.t || now;
              pilot.lastFreshAt = now;

              if (isCrashed) {
                pilot.crashed = true;
                pilot.tankPct = 0;
                pilot.releasing = false;
                pilot.scooping = false;
                pilot.dropBurstTimer = 0;
                pilot.speedKmh = 0;
                pilot.x = decoded.x;
                pilot.y = decoded.y;
                pilot.z = decoded.z;
                pilot.yawDeg = decoded.yawDeg;
                pilot.pitchDeg = clamp(decoded.pitchDeg, -45, 45);
                pilot.rollDeg = clamp(decoded.rollDeg, -60, 60);
                pilot.autopilot = decoded.autopilot;
                pilot.flags = decoded.flags;
              } else {
                if (pilot.crashed) {
                  // Remote pilot respawned on perimeter air corridor — snap immediately with empty tank.
                  pilot.crashed = false;
                  pilot.tankPct = 0;
                  pilot.x = decoded.x;
                  pilot.y = decoded.y;
                  pilot.z = decoded.z;
                } else {
                  const elapsedSec = Math.max(0.1, Math.min(2.0, (now - prevFreshAt) / 1000 || dt));
                  const dx = decoded.x - pilot.x;
                  const dy = decoded.y - pilot.y;
                  const dz = decoded.z - pilot.z;
                  const dist = Math.hypot(dx, dy, dz);
                  const maxDist = Math.max(45, MAX_PLAUSIBLE_SPEED_MS * elapsedSec);
                  if (dist > maxDist && dist > 1e-3) {
                    const scale = maxDist / dist;
                    pilot.x += dx * scale;
                    pilot.y += dy * scale;
                    pilot.z += dz * scale;
                  } else {
                    pilot.x = decoded.x;
                    pilot.y = decoded.y;
                    pilot.z = decoded.z;
                  }
                }
                if (isDropSeqNewer(decoded.dropSeq, pilot.lastDropSeq)) {
                  pilot.dropBurstTimer = Math.max(pilot.dropBurstTimer, MIN_DROP_BURST_SEC);
                  pilot.lastDropSeq = decoded.dropSeq;
                }
                pilot.yawDeg = decoded.yawDeg;
                pilot.pitchDeg = clamp(decoded.pitchDeg, -45, 45);
                pilot.rollDeg = clamp(decoded.rollDeg, -60, 60);
                pilot.speedKmh = clamp(decoded.speedKmh, FLIGHT_CONSTANTS.MIN_SPEED_KMH, FLIGHT_CONSTANTS.MAX_SPEED_KMH);
                pilot.releasing = decoded.releasing;
                pilot.scooping = decoded.scooping;
                pilot.autopilot = decoded.autopilot;
                pilot.flags = decoded.flags;
              }
            } else if (!pilot.crashed) {
              // Strict per-pilot lag isolation: this ONE peer missed its beat; gently coast & level wings
              // without stalling the Host or affecting any healthy peer!
              const staleMs = Math.max(0, now - (pilot.lastFreshAt || now));
              if (staleMs > STALE_PEER_COAST_START_MS) {
                const vMs = Math.max(25, (pilot.speedKmh || 155) * KMH_TO_MS);
                const rollRad = clamp(pilot.rollDeg || 0, -55, 55) * DEG_TO_RAD;
                const pitchRad = clamp(pilot.pitchDeg || 0, -35, 35) * DEG_TO_RAD;
                const yawRate = clamp((14.5 * Math.tan(rollRad)) / vMs, -1.15, 1.15);
                let yawRad = ((pilot.yawDeg || 0) * DEG_TO_RAD) + yawRate * dt;
                const horiz = vMs * Math.cos(pitchRad);
                pilot.x += Math.sin(yawRad) * horiz * dt;
                pilot.z += -Math.cos(yawRad) * horiz * dt;
                pilot.y += vMs * Math.sin(pitchRad) * dt;
                pilot.yawDeg = (((yawRad * RAD_TO_DEG) % 360) + 360) % 360;
                // Smoothly level wings & pitch only once peer is genuinely lagging (> 400 ms silent)
                if (staleMs > 400) {
                  pilot.rollDeg *= Math.exp(-dt / 0.75);
                  pilot.pitchDeg *= Math.exp(-dt / 0.55);
                }
                const safeFloor = (this.terrain?.getHeight
                  ? Math.max(this.terrain.waterLevel ?? 12, this.terrain.getHeight(pilot.x, pilot.z))
                  : (this.terrain?.waterLevel ?? 12)) + 24;
                if (pilot.y < safeFloor) pilot.y = safeFloor;
                if (staleMs > STALE_PEER_LEVEL_MS) {
                  pilot.releasing = false;
                  pilot.scooping = false;
                }
              }
            }
          }
        }
      }

      if (!pilot) continue;
      if (!pilot.autopilot) activeManualPilots++;

      const bound = (this.terrain?.halfWorld ?? 1600) + 120;
      pilot.x = clamp(pilot.x, -bound, bound);
      pilot.z = clamp(pilot.z, -bound, bound);

      if (pilot.crashed) {
        pilot.scooping = false;
        pilot.releasing = false;
        pilot.tankPct = 0;
        continue;
      }

      // Authoritative scoop validation: tracks FlightModel forgiving water scoop ceiling & optimal/rough scoop rate.
      const maxScoopAgl = (FLIGHT_CONSTANTS.SCOOP_EXIT_AGL ?? 11.5) + 0.5;
      const overWater = this.terrain?.isWater ? this.terrain.isWater(pilot.x, pilot.z) : false;
      const waterLevel = this.terrain?.waterLevel ?? 12.0;
      const aglWater = pilot.y - waterLevel;
      const validScoop = pilot.scooping && overWater && aglWater <= maxScoopAgl;
      pilot.scooping = validScoop;

      if (validScoop) {
        if (!isLocalHostPilot) {
          const optRoll = FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MAX_ROLL_DEG ?? 16;
          const optMinSpd = FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MIN_SPEED_KMH ?? 120;
          const optMaxSpd = FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MAX_SPEED_KMH ?? 175;
          const isOptimalScoop =
            Math.abs(pilot.rollDeg || 0) < optRoll &&
            pilot.speedKmh >= optMinSpd &&
            pilot.speedKmh <= optMaxSpd;
          const scoopRate = isOptimalScoop
            ? (FLIGHT_CONSTANTS.SCOOP_RATE_OPTIMAL ?? FLIGHT_CONSTANTS.SCOOP_RATE ?? 75)
            : (FLIGHT_CONSTANTS.SCOOP_RATE_ROUGH ?? 30);
          pilot.tankPct = Math.min(100, pilot.tankPct + scoopRate * dt);
        }
        pilot.dropBurstTimer = 0;
      }

      // Authoritative drop validation honoring minimum 0.25 s burst triggered by dropSeq increment.
      const burstActive = pilot.dropBurstTimer > 0;
      const wantsRelease = pilot.releasing || burstActive;
      const hasWater = isLocalHostPilot
        ? (pilot.releasing || pilot.tankPct > 0.1)
        : (pilot.tankPct > 0.1);
      const validRelease = wantsRelease && hasWater && !validScoop;
      pilot.releasing = validRelease;

      if (burstActive) {
        pilot.dropBurstTimer = Math.max(0, pilot.dropBurstTimer - dt);
      }

      if (validRelease) {
        if (!isLocalHostPilot) {
          pilot.tankPct = Math.max(0, pilot.tankPct - FLIGHT_CONSTANTS.DROP_RATE * dt);
        }
        let vx;
        let vy;
        let vz;
        if (
          isLocalHostPilot &&
          this._localAircraft &&
          typeof this._localAircraft.vx === 'number' &&
          typeof this._localAircraft.vy === 'number' &&
          typeof this._localAircraft.vz === 'number'
        ) {
          vx = this._localAircraft.vx;
          vy = this._localAircraft.vy;
          vz = this._localAircraft.vz;
        } else {
          const speedMs = pilot.speedKmh * KMH_TO_MS;
          const yawRad = pilot.yawDeg * DEG_TO_RAD;
          const pitchRad = pilot.pitchDeg * DEG_TO_RAD;
          const cosP = Math.cos(pitchRad);
          vx = Math.sin(yawRad) * cosP * speedMs;
          vy = Math.sin(pitchRad) * speedMs;
          vz = -Math.cos(yawRad) * cosP * speedMs;
        }
        const groundY = this.terrain?.getHeight ? this.terrain.getHeight(pilot.x, pilot.z) : waterLevel;
        const releaseAgl = Math.max(4, pilot.y - Math.max(groundY, waterLevel));
        this.fireSim.spawnWaterParcel(slotId, pilot.x, pilot.y - 1.4, pilot.z, vx, vy, vz, releaseAgl);
      }
    }

    for (const slotId of [...this._pilots.keys()]) {
      if (!activeSlots.has(slotId)) this._pilots.delete(slotId);
    }

    const stepDelta = this.fireSim.step(dt, Math.max(1, activeManualPilots || activeSlots.size));
    const dropOutcomes = typeof this.fireSim.drainDropOutcomes === 'function'
      ? this.fireSim.drainDropOutcomes()
      : (stepDelta?.dropOutcomes || []);
    const worldEvents = typeof this.fireSim.drainWorldEvents === 'function'
      ? this.fireSim.drainWorldEvents()
      : (stepDelta?.worldEvents || []);

    if (dropOutcomes.length > 0) {
      this._pendingDropOutcomes.push(...dropOutcomes);
      if (this._pendingDropOutcomes.length > 24) {
        this._pendingDropOutcomes.splice(0, this._pendingDropOutcomes.length - 24);
      }
      this.onDropOutcomes?.(dropOutcomes);
    }
    if (worldEvents.length > 0) {
      this.onWorldEvents?.(worldEvents);
    }

    if (stepDelta) {
      const wantsOpAdvance = Boolean(stepDelta.advanceOperation);
      if (wantsOpAdvance && this.onOperationAdvance && !this._advancingOperation) {
        this._advancingOperation = true;
        const fromOpIndex = this.opIndex;
        const nextOpIndex = (fromOpIndex + 1) % 5;
        const handled = this.onOperationAdvance({ fromOpIndex, nextOpIndex, stepDelta });
        if (handled !== false) return;
        this._advancingOperation = false;
      }

      if (stepDelta.fullReset) {
        // Wave 2+ full reset: discard stale wave deltas and force a fresh fireKey!
        this._pendingCells.clear();
        this._overflowCells.length = 0;
        this._pendingCabins.clear();
        this._needsWaveKeyPublish = true;
      }
      for (const c of stepDelta.changedCells) {
        this._pendingCells.set(c.idx, {
          idx: c.idx,
          state: c.state,
          phase: Math.min(31, (c.phase ?? 0) >> 3),
        });
      }
      for (const cc of stepDelta.cabinChanges) {
        this._pendingCabins.set(cc.id, cc.hp);
      }
      if (stepDelta.scoreEvents?.length) {
        this._pendingScores.push(...stepDelta.scoreEvents);
        this.onScoreEvents?.(stepDelta.scoreEvents);
      }
      if (stepDelta.impactEvents?.length) {
        this.onImpactEvents?.(stepDelta.impactEvents);
      }
      this.onSimStep?.(stepDelta);
    }
  }

  async publishPlanes() {
    if (!this.running || !this.hydrated) return;
    const planes = Array.from(this._pilots.values()).sort((a, b) => a.slotId - b.slotId);
    this.lastPublishedPlanes = planes;
    const p = encodePlanes(planes);
    const q = ++this.planesSeq;
    const token = ++this._planesWriteToken;
    this._planesPendingToken = token;
    queueMicrotask(() => {
      if (this.running && this._planesPendingToken === token && !this._planesWriteInFlightSince) {
        this._planesWriteInFlightSince = this.adapter.now();
      }
    });
    try {
      await this.adapter.set(`${this.basePath}/planes`, {
        e: this.epoch,
        q,
        t: this.adapter.serverTimestamp(),
        p,
      });
    } finally {
      if (this._planesPendingToken === token) {
        this._planesPendingToken = 0;
        this._planesWriteInFlightSince = 0;
      }
    }
  }

  async publishFireRing() {
    if (!this.running || !this.hydrated) return;
    const snap = this.fireSim.getSnapshot();

    const changedCells = [...this._overflowCells];
    this._overflowCells = [];
    for (const c of this._pendingCells.values()) changedCells.push(c);
    this._pendingCells.clear();

    const cabinChanges = [];
    for (const [id, hp] of this._pendingCabins.entries()) cabinChanges.push({ id, hp });
    this._pendingCabins.clear();

    const scoreEvents = this._pendingScores.splice(0, 48);
    const dropOutcomes = this._pendingDropOutcomes.splice(0, 12);

    const { str, overflow } = encodeFireDeltaWithOverflow({
      windDirDeg: snap.windDirDeg,
      windSpeedKt: snap.windSpeedKt,
      changedCells,
      cabinChanges,
      scoreEvents,
      dropOutcomes,
      missionScore: snap.missionScore,
      wave: snap.wave,
      opIndex: this.opIndex,
      status: snap.status,
      intermissionTimer: snap.intermissionTimer,
    });

    if (overflow.length > 0) {
      this._overflowCells = overflow;
    }

    const q = ++this.fireSeq;
    const ringSlot = q % RING_SIZE;
    const token = ++this._ringWriteToken;
    this._ringPendingToken = token;
    queueMicrotask(() => {
      if (this.running && this._ringPendingToken === token && !this._ringWriteInFlightSince) {
        this._ringWriteInFlightSince = this.adapter.now();
      }
    });
    try {
      await this.adapter.set(`${this.basePath}/fireRing/${ringSlot}`, {
        e: this.epoch,
        q,
        t: this.adapter.serverTimestamp(),
        d: str,
      });
    } finally {
      if (this._ringPendingToken === token) {
        this._ringPendingToken = 0;
        this._ringWriteInFlightSince = 0;
      }
    }
  }

  async publishFireKey() {
    if (!this.running || (!this.hydrated && !this._bootstrapping)) return;
    const full = this.fireSim.encodeFullState();
    const d = encodeFireKey({
      ...full,
      opIndex: this.opIndex,
      gridSize: this.terrain?.gridSize ?? this.fireSim.gridSize,
    });
    this._lastFireKeyAt = this.adapter.now();
    try {
      await this.adapter.set(`${this.basePath}/fireKey`, {
        e: this.epoch,
        q: this.fireSeq,
        t: this.adapter.serverTimestamp(),
        d,
      });
    } finally {
      this._lastFireKeyAt = this.adapter.now();
    }
  }

  async publishMeta() {
    if (!this.running || (!this.hydrated && !this._bootstrapping)) return;
    const snap = this.fireSim.getSnapshot();
    const now = this.adapter.now();
    const scores = this.fireSim.getSlotScores();
    const top10 = Array.from(scores.entries())
      .filter(([, sc]) => sc > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([slotId, score]) => ({
        slotId,
        score,
        name: this._roster[String(slotId)]?.name || defaultCallsign(slotId),
        colorIdx: this._roster[String(slotId)]?.color ?? (slotId % 16),
      }));

    const d = encodeMeta({
      wave: snap.wave,
      opIndex: this.opIndex,
      missionScore: snap.missionScore,
      burningPct: snap.burningPct,
      cabinsAlive: snap.cabinsAlive,
      cabinsTotal: snap.cabinsTotal,
      status: snap.status,
      intermissionTimer: snap.intermissionTimer,
      pilotsCount: this._countLiveSlots(now),
      top10,
    });

    this._lastMetaAt = now;
    try {
      await this.adapter.set(`${this.basePath}/meta`, {
        e: this.epoch,
        t: this.adapter.serverTimestamp(),
        d,
      });
    } finally {
      this._lastMetaAt = this.adapter.now();
    }
  }

  async publishWorldsIndex() {
    if (!this.running || (!this.hydrated && !this._bootstrapping)) return;
    const now = this.adapter.now();
    if (!this._config) {
      this._config = await this.adapter.get(`${this.basePath}/config`).catch(() => null);
    }
    if (!this._config) return;

    const players = Math.min(100, this._countLiveSlots(now));
    this._lastIndexAt = now;
    try {
      await this.adapter.set(`worldsIndex/${this.worldId}`, {
        name: this.worldName,
        mode: 'megabasin',
        players,
        cap: this._config.cap ?? 100,
        buildHash: this._config.buildHash || this.buildHash,
        protocolVersion: PROTOCOL_VERSION,
        updatedAt: this.adapter.serverTimestamp(),
        expiresAt: this._config.expiresAt,
      });
    } finally {
      this._lastIndexAt = this.adapter.now();
    }
  }

  /**
   * Evict slots whose leases expired or whose presence has been away/missing >= 60 s.
   * Uses strict conditional leaf deletion AND avoids touching uidToSlot/in/presence
   * if `deadUid` has already re-seated in another live slot!
   */
  async evictDeadSlots() {
    if (!this.running || !this.hydrated) return;
    const now = this.adapter.now();
    const myUid = this.adapter.uid;

    for (const [slotKey, slotObj] of Object.entries(this._slots)) {
      if (!slotObj || !slotObj.uid || slotObj.uid === myUid) continue;
      const deadUid = slotObj.uid;
      const pres = this._presence[deadUid];
      const leaseExpired = typeof slotObj.leaseUntil === 'number' && slotObj.leaseUntil <= now;
      const isAwayOrMissing = !pres || pres.away === true;

      if (!leaseExpired && !isAwayOrMissing) {
        this._awaySince.delete(deadUid);
        continue;
      }

      if (!leaseExpired && isAwayOrMissing) {
        let since = this._awaySince.get(deadUid);
        if (!since) {
          since = pres?.at || now;
          this._awaySince.set(deadUid, since);
        }
        if (now - since < EVICT_AWAY_GRACE_MS) continue;
      }

      const updates = {
        [`slots/${slotKey}`]: null,
      };
      if (this._roster[slotKey] && this._roster[slotKey].uid === deadUid) {
        updates[`roster/${slotKey}`] = null;
      }

      // Check current uidToSlot/$deadUid before touching uidToSlot, in, or presence!
      const mappedSlot = await this.adapter.get(`${this.basePath}/uidToSlot/${deadUid}`).catch(() => null);
      const stillMappedHere = mappedSlot !== null && String(mappedSlot) === slotKey;
      const reseatedElsewhere =
        mappedSlot !== null &&
        String(mappedSlot) !== slotKey &&
        this._slots[String(mappedSlot)]?.uid === deadUid &&
        this._slots[String(mappedSlot)].leaseUntil > now;

      if (stillMappedHere && !reseatedElsewhere) {
        updates[`uidToSlot/${deadUid}`] = null;
        if (this._inputs[deadUid]) {
          updates[`in/${deadUid}`] = null;
        }
        if (pres && (pres.away === true || (now - (pres.at || 0) >= 15000))) {
          updates[`presence/${deadUid}`] = null;
        }
      }

      this._awaySince.delete(deadUid);
      try {
        await this.adapter.update(this.basePath, updates);
      } catch {
        // Race with client returning or another eviction; ignore cleanly.
      }
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._bootstrapping = false;
    this.hydrated = false;
    this._bgTicker?.stop?.();
    for (const off of this._offs) off?.();
    this._offs = [];
  }
}
