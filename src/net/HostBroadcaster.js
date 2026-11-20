// Authoritative Host simulation runner and RTDB broadcaster for EMBER FRONT Mega-Basin.
// - Runs FireSim at 10 Hz (using BackgroundWorker when tab is hidden)
// - Continuously propagates remote aircraft kinematics at 10 Hz + blends arriving in/$uid poses
// - Adaptive planes broadcast rate: 8 Hz (<= 12 pilots), 6 Hz (13–40), 4 Hz (41–100) + sub-tick micro-projection
// - Validates client in/$uid speed/scoop/tank bounds + minimum 0.25 s drop burst on dropSeq increment
// - Publishes full fireKey immediately when Wave 2+ fullReset occurs (respecting >= 4 s pacing)
// - Evicts dead/away slots (>= 60 s grace, strict conditional leaf deletes, safe if deadUid re-seated)
// - Publishes planes (8/6/4 Hz adaptive), fireRing/{q%16} (2 Hz), fireKey (5 s), meta (0.5 Hz), worldsIndex (10 s)

import { createBackgroundTicker } from '../sim/BackgroundWorker.js';
import { FLIGHT_CONSTANTS } from '../sim/FlightModel.js';
import { PACING_MS, PROTOCOL_VERSION, RING_SIZE, defaultCallsign, getBuildHash } from './config.js';
import { integrateFlightPose, shortestAngleDeltaDeg } from './PlaneInterpolator.js';
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
export const PLANES_INTERVAL_SMALL_MS = 125; // 8 Hz (<= 12 pilots)
export const PLANES_INTERVAL_MED_MS = 165; // 6 Hz (13–40 pilots)
export const PLANES_INTERVAL_MS = 250; // 4 Hz (41–100 pilots)
export const FIRE_RING_INTERVAL_MS = 500; // 2 Hz
export const FIRE_KEY_INTERVAL_MS = 5000; // 0.2 Hz (>= 4 s rule)
export const META_INTERVAL_MS = 2000; // 0.5 Hz (>= 0.8 s rule)
export const INDEX_INTERVAL_MS = 10000; // 0.1 Hz (>= 5 s rule)
export const EVICT_AWAY_GRACE_MS = 60000; // >= 60 s grace before evicting away slot
export const HOST_SCOOP_MAX_AGL = (FLIGHT_CONSTANTS.SCOOP_EXIT_AGL ?? 11.5) + 0.5; // Tracks forgiving lake scoop ceiling
const MIN_DROP_BURST_SEC = 0.25;
const CRASH_SPEED_THRESHOLD_KMH = 40;
const STALE_PEER_LEVEL_MS = 1100; // level wings & stop spray if one peer goes silent > 1.1 s
const HOST_WORLD_TTL_MS = 23 * 3600 * 1000;
const Q_RESET_THRESHOLD = 900_000_000;

const KMH_TO_MS = 1 / 3.6;
const DEG_TO_RAD = Math.PI / 180;
const MAX_PLAUSIBLE_SPEED_MS = 72;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrap360(deg) {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
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
    planesIntervalMs = null,
    onScoreEvents = null,
    onImpactEvents = null,
    onDropOutcomes = null,
    onWorldEvents = null,
    onOperationAdvance = null,
    onOperationHydrated = null,
    onSimStep = null,
    onHiddenAutopilotTick = null,
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
    this._fixedPlanesIntervalMs = typeof planesIntervalMs === 'number' && planesIntervalMs > 0 ? planesIntervalMs : null;
    this.planesIntervalMs = this._fixedPlanesIntervalMs ?? PLANES_INTERVAL_SMALL_MS;
    this.onScoreEvents = onScoreEvents;
    this.onImpactEvents = onImpactEvents;
    this.onDropOutcomes = onDropOutcomes;
    this.onWorldEvents = onWorldEvents;
    this.onOperationAdvance = onOperationAdvance;
    this.onOperationHydrated = onOperationHydrated;
    this.onSimStep = onSimStep;
    this.onHiddenAutopilotTick = onHiddenAutopilotTick;

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
    this._worldResetAt = 0;
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
            // Keep local autopilot flying while Host tab is hidden so peers don't see a frozen plane.
            if (this._localAircraft?.autopilot && this.onHiddenAutopilotTick) {
              try { this.onHiddenAutopilotTick(SIM_STEP_DT); } catch { /* ignore */ }
            }
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
    this._worldResetAt = this.adapter.now();
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

  async start({ isFailover = false, forceFreshMission = false, seedPlanes = null } = {}) {
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

    const startNow = this.adapter.now();

    // Refresh expired/near-expiry or misconfigured shard config (prevents 23-hr bricking & cap DoS!).
    const isPublicShard = /^megabasin-(0[1-9]|1[0-8])$/.test(this.worldId);
    if (
      this._config &&
      ((this._config.expiresAt ?? 0) <= startNow + 3_600_000 || (isPublicShard && this._config.cap !== 100))
    ) {
      const refreshedCfg = {
        mode: 'megabasin',
        mapId: this._config.mapId || 'op01',
        cap: isPublicShard ? 100 : (this._config.cap ?? 100),
        protocolVersion: PROTOCOL_VERSION,
        buildHash: this.buildHash,
        createdAt: this.adapter.serverTimestamp(),
        expiresAt: startNow + HOST_WORLD_TTL_MS,
      };
      try {
        await this.adapter.set(`${this.basePath}/config`, refreshedCfg);
        this._config = { ...refreshedCfg, createdAt: startNow };
      } catch {
        // Keep existing config if another host refreshed concurrently.
      }
    }

    if (planesNode && Number.isInteger(planesNode.q)) {
      const planesEpochBumped = this.epoch > (planesNode.e | 0);
      this.planesSeq = (planesEpochBumped && (forceFreshMission || planesNode.q >= Q_RESET_THRESHOLD))
        ? 0
        : planesNode.q;
      if (!forceFreshMission && planesNode.p) {
        try {
          const decoded = decodePlanes(planesNode.p);
          const staleAgeSec = planesNode.t ? clamp((startNow - planesNode.t) / 1000, 0, 1.0) : 0;
          for (const p of decoded) {
            const isCrashed = (p.speedKmh ?? 0) < CRASH_SPEED_THRESHOLD_KMH;
            const proj = !isCrashed && staleAgeSec > 0.01
              ? integrateFlightPose(p, staleAgeSec, { levelAfterSec: 0.4, elapsedSec: 0 })
              : p;
            this._pilots.set(p.slotId, {
              slotId: p.slotId,
              uid: this._slots[String(p.slotId)]?.uid || null,
              x: proj.x,
              y: proj.y,
              z: proj.z,
              yawDeg: proj.yawDeg,
              pitchDeg: proj.pitchDeg,
              rollDeg: proj.rollDeg,
              speedKmh: p.speedKmh,
              tankPct: p.tankPct,
              releasing: p.releasing,
              scooping: p.scooping,
              autopilot: p.autopilot,
              crashed: isCrashed,
              flags: p.flags,
              lastInputT: 0,
              lastInputSeq: null,
              lastFreshAt: startNow,
              lastDropSeq: 0,
              dropBurstTimer: 0,
            });
          }
        } catch {
          // Ignore malformed old planes payload.
        }
      }
    }

    // On Host failover, overlay live interpolated poses from the new Host's PlaneInterpolator so
    // every remote plane glides smoothly across Host transfer with zero snap or freeze!
    if (isFailover && !forceFreshMission && Array.isArray(seedPlanes) && seedPlanes.length > 0) {
      for (const sp of seedPlanes) {
        if (!sp || !Number.isInteger(sp.slotId)) continue;
        const slotObj = this._slots[String(sp.slotId)];
        if (!slotObj || typeof slotObj.uid !== 'string') continue;
        const existing = this._pilots.get(sp.slotId);
        const isCrashed = (sp.speedKmh ?? 0) < CRASH_SPEED_THRESHOLD_KMH;
        this._pilots.set(sp.slotId, {
          slotId: sp.slotId,
          uid: slotObj.uid,
          x: sp.x,
          y: sp.y,
          z: sp.z,
          yawDeg: wrap360(sp.yawDeg || 0),
          pitchDeg: clamp(sp.pitchDeg || 0, -45, 45),
          rollDeg: clamp(sp.rollDeg || 0, -60, 60),
          speedKmh: isCrashed ? 0 : clamp(sp.speedKmh || 155, FLIGHT_CONSTANTS.MIN_SPEED_KMH, FLIGHT_CONSTANTS.MAX_SPEED_KMH),
          tankPct: existing ? existing.tankPct : (sp.tankPct ?? 100),
          releasing: !!sp.releasing,
          scooping: !!sp.scooping,
          autopilot: !!sp.autopilot,
          crashed: isCrashed,
          flags: existing?.flags ?? 0,
          lastInputT: existing?.lastInputT ?? 0,
          lastInputSeq: existing?.lastInputSeq ?? null,
          lastFreshAt: startNow,
          lastDropSeq: existing?.lastDropSeq ?? 0,
          dropBurstTimer: 0,
        });
      }
    }

    if (forceFreshMission) {
      // Starting a brand-new hosted lobby on a fresh or stale shard:
      // keep our fresh Operation 01 FireSim; reset seq to 0 on epoch bump (or if near 1e9 cap).
      let maxQ = Number.isInteger(fireKey?.q) ? fireKey.q : 0;
      let maxRingE = fireKey?.e | 0;
      if (fireRing && typeof fireRing === 'object') {
        for (const entry of Object.values(fireRing)) {
          if (entry && Number.isInteger(entry.q) && entry.q > maxQ) maxQ = entry.q;
          if (entry && Number.isInteger(entry.e) && entry.e > maxRingE) maxRingE = entry.e;
        }
      }
      const fireEpochBumped = this.epoch > maxRingE;
      this.fireSeq = (fireEpochBumped || maxQ >= Q_RESET_THRESHOLD) ? 0 : maxQ;
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
                // If fireRing rolled over to a newer Operation before the old Host's 4.25 s fireKey fired,
                // hydrate that newer Operation on the failover Host so Replicas never deadlock!
                if (typeof delta.opIndex === 'number' && delta.opIndex !== this.opIndex) {
                  this.opIndex = Math.max(0, Math.min(4, delta.opIndex));
                  await this.onOperationHydrated?.(this.opIndex, null);
                }
                this.fireSim.applyExternalDelta(delta);
                this.fireSeq = entry.q;
              } catch {
                // Skip corrupted ring entry.
              }
            }
          }
          if (this.epoch > (fireKey.e | 0) && this.fireSeq >= Q_RESET_THRESHOLD) {
            this.fireSeq = 0;
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

    // Seed local Host aircraft and publish an immediate new-epoch planes frame on failover/start
    // so replicas glide seamlessly across Host transfer without waiting for the next interval tick.
    if (this._pilots.size > 0 || (this.localSlotId !== null && this._localAircraft)) {
      await this.publishPlanes().catch(() => {});
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

  /** Adaptive planes broadcast cadence: 8 Hz (<=12), 6 Hz (13–40), 4 Hz (41–100). */
  getPlanesIntervalMs(now = this.adapter.now()) {
    if (this._fixedPlanesIntervalMs) return this._fixedPlanesIntervalMs;
    const live = this._countLiveSlots(now);
    if (live <= 12) return PLANES_INTERVAL_SMALL_MS;
    if (live <= 40) return PLANES_INTERVAL_MED_MS;
    return PLANES_INTERVAL_MS;
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
    this.planesIntervalMs = this.getPlanesIntervalMs(now);

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
        const stalePreRollover =
          rawIn && this._worldResetAt > 0 && typeof rawIn.t === 'number' && rawIn.t > 0 && rawIn.t < this._worldResetAt;
        const decoded = !stalePreRollover && rawIn && typeof rawIn.d === 'string' ? decodeInput(rawIn.d) : null;
        const inputSeq = !stalePreRollover && rawIn && Number.isInteger(rawIn.s) ? rawIn.s : null;
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
                const nextSpeed = clamp(decoded.speedKmh, FLIGHT_CONSTANTS.MIN_SPEED_KMH, FLIGHT_CONSTANTS.MAX_SPEED_KMH);
                const ageSec = clamp((now - (rawIn.t || now)) / 1000, 0, 0.35);
                const decodedPose = {
                  x: decoded.x,
                  y: decoded.y,
                  z: decoded.z,
                  yawDeg: decoded.yawDeg,
                  pitchDeg: clamp(decoded.pitchDeg, -45, 45),
                  rollDeg: clamp(decoded.rollDeg, -60, 60),
                  speedKmh: nextSpeed,
                  crashed: false,
                };
                const proj = ageSec > 0.005 ? integrateFlightPose(decodedPose, ageSec) : decodedPose;

                if (pilot.crashed) {
                  // Remote pilot respawned on perimeter air corridor — snap immediately with empty tank.
                  pilot.crashed = false;
                  pilot.tankPct = 0;
                  pilot.x = proj.x;
                  pilot.y = proj.y;
                  pilot.z = proj.z;
                  pilot.yawDeg = proj.yawDeg;
                  pilot.pitchDeg = proj.pitchDeg;
                  pilot.rollDeg = proj.rollDeg;
                } else {
                  const elapsedSec = Math.max(0.1, Math.min(2.0, (now - prevFreshAt) / 1000 || dt));
                  const prevX = pilot.x;
                  const prevZ = pilot.z;
                  const pred = integrateFlightPose(pilot, dt);
                  const errX = proj.x - pred.x;
                  const errY = proj.y - pred.y;
                  const errZ = proj.z - pred.z;
                  const errDist = Math.hypot(errX, errY, errZ);
                  const maxDist = Math.max(45, MAX_PLAUSIBLE_SPEED_MS * elapsedSec);

                  if (errDist > 260) {
                    // Legitimate respawn or Operation rollover warp -> snap cleanly without 5s drag!
                    pilot.x = proj.x;
                    pilot.y = proj.y;
                    pilot.z = proj.z;
                    pilot.yawDeg = proj.yawDeg;
                    pilot.pitchDeg = proj.pitchDeg;
                    pilot.rollDeg = proj.rollDeg;
                  } else if (errDist > maxDist && errDist > 1e-3) {
                    const scale = maxDist / errDist;
                    pilot.x = pred.x + errX * scale;
                    pilot.y = pred.y + errY * scale;
                    pilot.z = pred.z + errZ * scale;
                    pilot.yawDeg = proj.yawDeg;
                    pilot.pitchDeg = proj.pitchDeg;
                    pilot.rollDeg = proj.rollDeg;
                  } else {
                    // Smooth blend between kinematic propagation and age-compensated in/$uid arrival
                    // with anti-backstep guard so uplink jitter NEVER broadcasts a stopped/reversing plane.
                    const alpha = 0.55;
                    let nx = pred.x + errX * alpha;
                    const ny = pred.y + errY * alpha;
                    let nz = pred.z + errZ * alpha;

                    const yawRad = wrap360(pred.yawDeg) * DEG_TO_RAD;
                    const fx = Math.sin(yawRad);
                    const fz = -Math.cos(yawRad);
                    const vMs = Math.max(25, nextSpeed * KMH_TO_MS);
                    const fwdMove = (nx - prevX) * fx + (nz - prevZ) * fz;
                    const minFwd = 0.45 * vMs * dt;
                    if (fwdMove < minFwd) {
                      const push = minFwd - fwdMove;
                      nx += fx * push;
                      nz += fz * push;
                    }

                    pilot.x = nx;
                    pilot.y = ny;
                    pilot.z = nz;
                    pilot.yawDeg = wrap360(pred.yawDeg + shortestAngleDeltaDeg(pred.yawDeg, proj.yawDeg) * 0.65);
                    pilot.pitchDeg = clamp(pred.pitchDeg + (proj.pitchDeg - pred.pitchDeg) * 0.65, -45, 45);
                    pilot.rollDeg = clamp(pred.rollDeg + (proj.rollDeg - pred.rollDeg) * 0.65, -60, 60);
                  }
                }
                if (isDropSeqNewer(decoded.dropSeq, pilot.lastDropSeq)) {
                  pilot.dropBurstTimer = Math.max(pilot.dropBurstTimer, MIN_DROP_BURST_SEC);
                  pilot.lastDropSeq = decoded.dropSeq;
                }
                pilot.speedKmh = nextSpeed;
                pilot.releasing = decoded.releasing;
                pilot.scooping = decoded.scooping;
                pilot.autopilot = decoded.autopilot;
                pilot.flags = decoded.flags;
              }
            } else if (!pilot.crashed) {
              // Continuous 10 Hz kinematic propagation between in/$uid beats (zero dead-zone stop!)
              // with gentle wing-leveling once silent > 400 ms and strict per-pilot lag isolation.
              const staleMs = Math.max(0, now - (pilot.lastFreshAt || now));
              const next = integrateFlightPose(pilot, dt, {
                levelAfterSec: 0.4,
                elapsedSec: staleMs / 1000,
              });
              pilot.x = next.x;
              pilot.y = next.y;
              pilot.z = next.z;
              pilot.yawDeg = next.yawDeg;
              pilot.pitchDeg = next.pitchDeg;
              pilot.rollDeg = next.rollDeg;

              const ground = this.terrain?.getHeight
                ? Math.max(this.terrain.waterLevel ?? 12, this.terrain.getHeight(pilot.x, pilot.z))
                : (this.terrain?.waterLevel ?? 12);
              const safeFloor = ground + (staleMs > 400 ? 24 : 3.5);
              if (pilot.y < safeFloor) pilot.y = safeFloor;
              if (staleMs > STALE_PEER_LEVEL_MS) {
                pilot.releasing = false;
                pilot.scooping = false;
              }
            }
          }
        } else if (pilot && !pilot.crashed) {
          // Seeded remote peer (e.g. right after Host transfer) before its first in/$uid arrives:
          // keep propagating smoothly so it NEVER freezes across Host failover!
          const staleMs = Math.max(0, now - (pilot.lastFreshAt || now));
          const next = integrateFlightPose(pilot, dt, {
            levelAfterSec: 0.4,
            elapsedSec: staleMs / 1000,
          });
          pilot.x = next.x;
          pilot.y = next.y;
          pilot.z = next.z;
          pilot.yawDeg = next.yawDeg;
          pilot.pitchDeg = next.pitchDeg;
          pilot.rollDeg = next.rollDeg;
          const ground = this.terrain?.getHeight
            ? Math.max(this.terrain.waterLevel ?? 12, this.terrain.getHeight(pilot.x, pilot.z))
            : (this.terrain?.waterLevel ?? 12);
          const safeFloor = ground + (staleMs > 400 ? 24 : 3.5);
          if (pilot.y < safeFloor) pilot.y = safeFloor;
          if (staleMs > STALE_PEER_LEVEL_MS) {
            pilot.releasing = false;
            pilot.scooping = false;
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
        // Pure kinematic release velocity (matches FlightModel.predictDropImpact & main.js to 0.0 m;
        // does NOT inject aircraft buoyancy/thermal upward kick into falling water parcels!).
        const speedMs = pilot.speedKmh * KMH_TO_MS;
        const yawRad = pilot.yawDeg * DEG_TO_RAD;
        const pitchRad = pilot.pitchDeg * DEG_TO_RAD;
        const cosP = Math.cos(pitchRad);
        const vx = Math.sin(yawRad) * cosP * speedMs;
        const vy = Math.sin(pitchRad) * speedMs;
        const vz = -Math.cos(yawRad) * cosP * speedMs;
        const groundY = this.terrain?.getHeight ? this.terrain.getHeight(pilot.x, pilot.z) : waterLevel;
        const releaseAgl = Math.max(4, pilot.y - Math.max(groundY, waterLevel));
        this.fireSim.spawnWaterParcel(
          slotId,
          pilot.x,
          pilot.y - 1.4,
          pilot.z,
          vx,
          vy,
          vz,
          releaseAgl,
          pilot.lastDropSeq || 0
        );
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
    if (!this.running || (!this.hydrated && !this._bootstrapping)) return;

    // Ensure local Host aircraft is always synced with its exact live 60 Hz pose at broadcast time.
    if (this.localSlotId !== null && this._localAircraft) {
      const a = this._localAircraft;
      const isCrashed = !!a.crashed;
      let localPilot = this._pilots.get(this.localSlotId);
      if (!localPilot) {
        localPilot = {
          slotId: this.localSlotId,
          uid: this.adapter.uid,
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
          lastInputT: this.adapter.now(),
          lastDropSeq: this._localDropSeq,
          dropBurstTimer: 0,
        };
        this._pilots.set(this.localSlotId, localPilot);
      } else {
        localPilot.x = a.x;
        localPilot.y = a.y;
        localPilot.z = a.z;
        localPilot.yawDeg = a.yawDeg;
        localPilot.pitchDeg = a.pitchDeg;
        localPilot.rollDeg = a.rollDeg;
        localPilot.speedKmh = isCrashed ? 0 : a.speedKmh;
        localPilot.tankPct = isCrashed ? 0 : (typeof a.tankPct === 'number' ? a.tankPct : localPilot.tankPct);
        localPilot.releasing = isCrashed ? false : !!a.releasing;
        localPilot.scooping = isCrashed ? false : !!a.scooping;
        localPilot.autopilot = !!a.autopilot;
        localPilot.crashed = isCrashed;
      }
    }

    // Sub-tick micro-projection: eliminate 10 Hz sim / 8 Hz (125 ms) broadcast beat aliasing
    // by projecting flying remote pilots forward by the fractional _simAccum elapsed since last tick!
    const subSec = clamp(this._simAccum, 0, SIM_STEP_DT);
    const planes = Array.from(this._pilots.values())
      .sort((a, b) => a.slotId - b.slotId)
      .map((pilot) => {
        const isLocal = this.localSlotId !== null && pilot.slotId === this.localSlotId && !!this._localAircraft;
        if (isLocal || pilot.crashed || subSec <= 0.002 || (pilot.speedKmh ?? 0) < CRASH_SPEED_THRESHOLD_KMH) {
          return pilot;
        }
        const proj = integrateFlightPose(pilot, subSec);
        return {
          ...pilot,
          x: proj.x,
          y: proj.y,
          z: proj.z,
          yawDeg: proj.yawDeg,
          pitchDeg: proj.pitchDeg,
          rollDeg: proj.rollDeg,
        };
      });

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

  async publishWorldsIndex({ playersOverride = null } = {}) {
    if (!this.running || (!this.hydrated && !this._bootstrapping)) return;
    const now = this.adapter.now();
    if (!this._config) {
      this._config = await this.adapter.get(`${this.basePath}/config`).catch(() => null);
    }
    if (!this._config) return;

    const players = playersOverride !== null
      ? Math.max(0, Math.min(100, Math.floor(playersOverride)))
      : Math.min(100, this._countLiveSlots(now));
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
   * Evict slots whose leases expired or whose presence has been away/missing >= 60 s,
   * AND sweep unseated orphan presence / in / roster entries cleanly.
   * Uses strict conditional leaf deletion AND avoids touching uidToSlot/in/presence
   * if `deadUid` has already re-seated in another live slot!
   */
  async evictDeadSlots() {
    if (!this.running || !this.hydrated) return;
    const now = this.adapter.now();
    const myUid = this.adapter.uid;
    const liveSlotUids = new Set([myUid]);

    for (const [slotKey, slotObj] of Object.entries(this._slots)) {
      if (!slotObj || !slotObj.uid) continue;
      if (slotObj.uid === myUid) continue;
      const deadUid = slotObj.uid;
      const pres = this._presence[deadUid];
      const leaseExpired = typeof slotObj.leaseUntil === 'number' && slotObj.leaseUntil <= now;
      const isAwayOrMissing = !pres || pres.away === true;

      if (!leaseExpired && !isAwayOrMissing) {
        this._awaySince.delete(deadUid);
        liveSlotUids.add(deadUid);
        continue;
      }

      if (!leaseExpired && isAwayOrMissing) {
        let since = this._awaySince.get(deadUid);
        if (!since) {
          since = pres?.at || now;
          this._awaySince.set(deadUid, since);
        }
        if (now - since < EVICT_AWAY_GRACE_MS) {
          liveSlotUids.add(deadUid);
          continue;
        }
      }

      const updates = {
        [`slots/${slotKey}`]: null,
      };
      if (this._roster[slotKey]) {
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

    // Sweep orphan slot-less roster entries, unseated stale presence, and unseated in/$uid leaves.
    const orphanUpdates = {};
    for (const slotKey of Object.keys(this._roster)) {
      if (!this._slots[slotKey]) {
        orphanUpdates[`roster/${slotKey}`] = null;
      }
    }
    const candidateOrphanUids = new Set([
      ...Object.keys(this._presence),
      ...Object.keys(this._inputs),
    ]);
    for (const uid of candidateOrphanUids) {
      if (!uid || liveSlotUids.has(uid)) continue;
      const pres = this._presence[uid];
      const inp = this._inputs[uid];
      const presSweepable = pres && (pres.away === true || (now - (pres.at || 0) >= 15000));
      const inpSweepable = Boolean(inp);
      if (!presSweepable && !inpSweepable) continue;
      const mapped = await this.adapter.get(`${this.basePath}/uidToSlot/${uid}`).catch(() => undefined);
      if (mapped !== null) continue; // Only sweep strictly unseated orphans!
      if (presSweepable) orphanUpdates[`presence/${uid}`] = null;
      if (inpSweepable) orphanUpdates[`in/${uid}`] = null;
    }

    if (Object.keys(orphanUpdates).length > 0) {
      try {
        await this.adapter.update(this.basePath, orphanUpdates);
      } catch {
        // Ignore concurrent client return/cleanup race.
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
