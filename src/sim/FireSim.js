/**
 * EMBER FRONT — 10 Hz 4-Bit Cellular Wildfire Simulation
 * Supports focused Operations 01-05 (128x128 @ 16m, scaling 1..100 pilots) and Mega-Basin (160x160 @ 20m).
 * Engineered with flat typed arrays and sparse active sets for p99 < 2.0 ms at 100 pilots.
 * Pure simulation module — zero DOM / Three.js dependencies.
 */

import { createRng } from './TerrainGen.js';
import { FLIGHT_CONSTANTS, computeSplashRadius, evaluateDropAltitude } from './FlightModel.js';
import { getNextOperation } from '../config/operations.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const KNOTS_TO_MS = 0.514444;

// Cell states (4-bit: 0..15)
export const CELL_STATE = {
  INTACT: 0,
  FIRE_MIN: 1,
  FIRE_MAX: 12,
  WET: 13,
  CHARRED: 14,
  EMBER_WARN: 15,
};

// Scoring constants
export const SCORE = {
  CELL_PRIMARY: 70,
  CELL_ASSIST: 35,
  CABIN_SAVED: 500,
  WAVE_CONTAINED: 1000,
};

// Compact wire-friendly code tables for Drop Outcome telemetry
export const OUTCOME_CODES = ['direct', 'partial', 'miss'];
export const MISS_CODES = ['none', 'overshot', 'short', 'wide'];
export const COMPASS_DIRS = ['', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const DROP_QUALITY_CODES = ['optimal', 'misted_high', 'low_risk'];

// Wet firebreak cooldown bounds (seconds)
export const WET_COOLDOWN_MIN = 28.0;
export const WET_COOLDOWN_MAX = 35.0;

// 8-way Moore neighborhood offsets
const NBR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NBR_DZ = [-1, -1, -1, 0, 0, 1, 1, 1];
const NBR_DIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const NBR_UX = NBR_DX.map((dx, i) => dx / NBR_DIST[i]);
const NBR_UZ = NBR_DZ.map((dz, i) => dz / NBR_DIST[i]);

const MAX_PARCELS = 4096;
const ATTR_SLOTS_PER_CELL = 8; // Zero-GC fixed per-cell 3s attribution ring
const BASE_SPREAD_RATE = 0.0065; // Solo-winnable in 2-4 min at 1 pilot; scales smoothly 1..100 via pilotScale

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function shortestAngleDiffDeg(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d < -180) d += 360;
  return Math.abs(d);
}

/**
 * Convert a 2D horizontal vector (dx = East, -dz = North) to an 8-point compass direction.
 */
function vectorToCompass(dx, dz) {
  if (dx * dx + dz * dz < 1e-4) return '';
  const bearingDeg = ((Math.atan2(dx, -dz) * RAD2DEG) % 360 + 360) % 360;
  const idx = Math.round(bearingDeg / 45) % 8;
  return COMPASS_DIRS[idx + 1];
}

function normalizeExternalOutcome(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    // Compact fireRing tuple: [slotId, ix, iz, cells, pts, outcomeCode, missCode, dirCode, missDistM?, cabinSaved?, qualityCode?, releaseAgl?]
    return {
      dropId: 0,
      slotId: raw[0] | 0,
      impactX: Number(raw[1]) || 0,
      impactZ: Number(raw[2]) || 0,
      cellsExtinguished: Math.max(0, raw[3] | 0),
      cellsCooled: 0,
      pointsAwarded: Math.max(0, Math.round(Number(raw[4]) || 0)),
      outcome: OUTCOME_CODES[raw[5] | 0] || 'miss',
      missType: MISS_CODES[raw[6] | 0] || 'none',
      missDirCompass: COMPASS_DIRS[raw[7] | 0] || '',
      missDistM: Math.max(0, Math.round(Number(raw[8]) || 0)),
      cabinSaved: Boolean(raw[9]),
      dropQuality: DROP_QUALITY_CODES[raw[10] | 0] || 'optimal',
      releaseAgl: raw[11] != null ? Math.max(0, Math.round(Number(raw[11]) || 0)) : 35,
    };
  }
  return {
    dropId: raw.dropId ?? 0,
    slotId: raw.slotId | 0,
    impactX: Number(raw.impactX) || 0,
    impactZ: Number(raw.impactZ) || 0,
    cellsExtinguished: Math.max(0, raw.cellsExtinguished | 0),
    cellsCooled: Math.max(0, raw.cellsCooled | 0),
    pointsAwarded: Math.max(0, Math.round(Number(raw.pointsAwarded) || 0)),
    outcome: OUTCOME_CODES.includes(raw.outcome) ? raw.outcome : 'miss',
    missType: MISS_CODES.includes(raw.missType) ? raw.missType : 'none',
    missDirCompass: typeof raw.missDirCompass === 'string' ? raw.missDirCompass : '',
    missDistM: Math.max(0, Math.round(Number(raw.missDistM) || 0)),
    cabinSaved: Boolean(raw.cabinSaved),
    dropQuality: DROP_QUALITY_CODES.includes(raw.dropQuality) ? raw.dropQuality : 'optimal',
    releaseAgl: raw.releaseAgl != null ? Math.max(0, Math.round(Number(raw.releaseAgl) || 0)) : 35,
  };
}

export class FireSim {
  /**
   * @param {import('./TerrainGen.js').TerrainData} terrain
   * @param {{ isMegaBasin?: boolean, rollingIntermission?: boolean, onDropOutcome?: (ev: object) => void, onWorldEvent?: (ev: object) => void }} [opts]
   */
  constructor(
    terrain,
    { isMegaBasin = false, rollingIntermission = undefined, onDropOutcome = null, onWorldEvent = null } = {}
  ) {
    this.terrain = terrain;
    this.isMegaBasin = Boolean(isMegaBasin || terrain.opConfig?.mode === 'megabasin');
    this.rollingIntermission =
      rollingIntermission !== undefined ? Boolean(rollingIntermission) : this.isMegaBasin;
    this.gridSize = terrain.gridSize;
    this.cellSize = terrain.cellSize;
    this.cellCount = this.gridSize * this.gridSize;

    this._onDropOutcome = typeof onDropOutcome === 'function' ? onDropOutcome : null;
    this._onWorldEvent = typeof onWorldEvent === 'function' ? onWorldEvent : null;

    // 4-bit grid state & animation phase
    this.cells = new Uint8Array(this.cellCount);
    this.phases = new Uint8Array(this.cellCount);

    // Continuous simulation state per cell
    this.intensityF = new Float32Array(this.cellCount);
    this.fuelRemaining = new Float32Array(this.cellCount);
    this.burnDuration = new Float32Array(this.cellCount);
    this.wetTimer = new Float32Array(this.cellCount);
    this.emberTimer = new Float32Array(this.cellCount);
    this.ignitionAccum = new Float32Array(this.cellCount);

    // Conflict-free wet knockdown accumulation buffer (sparse dirty tracking)
    this.wetDelta = new Float32Array(this.cellCount);
    this.wetDirtyFlags = new Uint8Array(this.cellCount);
    this.wetDirtyList = new Int32Array(this.cellCount);
    this.wetDirtyCount = 0;

    // Last water burst id that touched each cell (for exact drop outcome attribution)
    this.cellLastDropId = new Int32Array(this.cellCount);

    // Sparse active cell set (burning 1..12, wet 13, ember 15, or heated intact)
    this.activeList = new Int32Array(this.cellCount);
    this.activePos = new Int32Array(this.cellCount);
    this.activePos.fill(-1);
    this.activeCount = 0;

    // Pre-allocated flat typed-array 3.0 s per-cell attribution ring (zero GC!)
    this.attrSlot = new Int16Array(this.cellCount * ATTR_SLOTS_PER_CELL);
    this.attrAmt = new Float32Array(this.cellCount * ATTR_SLOTS_PER_CELL);
    this.attrTime = new Float32Array(this.cellCount * ATTR_SLOTS_PER_CELL);
    this.attrSlot.fill(-1);

    // Precompute terrain refs for fast inline height lookup (zero closure overhead)
    this._heights = terrain.heights;
    this._vertStride = this.gridSize + 1;
    this._halfWorld = terrain.halfWorld;
    this._invCellSize = 1.0 / this.cellSize;
    this._nbrWindFactor = new Float32Array(8);
    this._changedCount = 0;

    // Scratch buffers reused every tick (zero GC)
    this._toRemove = new Int32Array(this.cellCount);
    this._changedMark = new Uint8Array(this.cellCount);
    this._changedIdxList = new Int32Array(this.cellCount);
    this._binWeight = new Float32Array(64);
    this._binSumX = new Float32Array(64);
    this._binSumZ = new Float32Array(64);
    this._binSumY = new Float32Array(64);
    this._binCount = new Int32Array(64);
    this._binUsed = new Uint8Array(64);

    // Precompute total flammable cells for burningPct
    let flammable = 0;
    for (let i = 0; i < this.cellCount; i++) {
      if (terrain.fuelMask[i] === 1) flammable++;
    }
    this.totalFlammable = Math.max(1, flammable);

    // Cabin & settlement state
    const nCabins = terrain.cabins.length;
    this.cabinsTotal = nCabins;
    this.cabinHp = new Uint8Array(nCabins);
    this.cabinHpF = new Float32Array(nCabins);
    this.cabinAtRisk = new Uint8Array(nCabins);
    this.cabinThreatTime = new Float32Array(nCabins);
    this.cabinSavedCooldown = new Float32Array(nCabins);
    this.cabinLastHelperSlot = new Int16Array(nCabins);
    this._cabinGx = new Int16Array(nCabins);
    this._cabinGz = new Int16Array(nCabins);
    for (let c = 0; c < nCabins; c++) {
      const g = terrain.worldToGrid(terrain.cabins[c].x, terrain.cabins[c].z);
      this._cabinGx[c] = g.gx;
      this._cabinGz[c] = g.gz;
    }

    const nSettlements = Math.max(1, terrain.settlements?.length ?? 1);
    this._settlementAtRisk = new Uint8Array(nSettlements);
    this._settlementAlertCooldown = new Float32Array(nSettlements);

    // Fixed-size struct-of-arrays pool for ballistic water parcels
    this.parcelCount = 0;
    this.parcelSlot = new Int16Array(MAX_PARCELS);
    this.parcelDropId = new Int32Array(MAX_PARCELS);
    this.parcelX = new Float32Array(MAX_PARCELS);
    this.parcelY = new Float32Array(MAX_PARCELS);
    this.parcelZ = new Float32Array(MAX_PARCELS);
    this.parcelVx = new Float32Array(MAX_PARCELS);
    this.parcelVy = new Float32Array(MAX_PARCELS);
    this.parcelVz = new Float32Array(MAX_PARCELS);
    this.parcelReleaseAgl = new Float32Array(MAX_PARCELS);

    // Per-drop burst tracking & structured event queues
    this._nextDropId = 0;
    /** @type {Map<number, object>} */
    this._activeBurstBySlot = new Map();
    /** @type {Map<number, object>} */
    this._latestBurstBySlot = new Map();
    /** @type {Map<number, object>} */
    this._burstsById = new Map();
    this._dropOutcomeQueue = [];
    this._worldEventQueue = [];

    // Wind shift telemetry state
    this._lastReportedWindDir = terrain.opConfig?.windDirDeg ?? 90;
    this._lastReportedWindSpeed = terrain.opConfig?.windSpeedKt ?? 12;
    this._windShiftCooldown = 30.0;

    // Score & wave state
    this.missionScore = 0;
    /** @type {Map<number, number>} */
    this.slotScores = new Map();
    this.wave = 1;
    this.status = 'active';
    this.intermissionTimer = 0;
    this.intermissionReason = null;
    this.simTime = 0;
    this.emberSpotAccum = 0;

    // Derived metrics & targets
    this.burningCount = 0;
    this.emberCount = 0;
    this.burningPct = 0;
    this.cabinsAlive = nCabins;
    this.windDirDeg = terrain.opConfig?.windDirDeg ?? 90;
    this.windSpeedKt = terrain.opConfig?.windSpeedKt ?? 12;
    this.windVx = 0;
    this.windVz = 0;
    this.fireHead = null;
    this.atRiskTarget = null;
    this.settlementTarget = null;
    this.hotClusters = [];

    this.reset(1);
  }

  /**
   * Register optional push callbacks for drop outcomes and tactical world events.
   */
  setEventCallbacks({ onDropOutcome = null, onWorldEvent = null } = {}) {
    this._onDropOutcome = typeof onDropOutcome === 'function' ? onDropOutcome : null;
    this._onWorldEvent = typeof onWorldEvent === 'function' ? onWorldEvent : null;
  }

  /**
   * Drain and return all completed Drop Outcome Events since the last drain.
   */
  drainDropOutcomes() {
    if (this._dropOutcomeQueue.length === 0) return [];
    const out = this._dropOutcomeQueue;
    this._dropOutcomeQueue = [];
    return out;
  }

  /**
   * Drain and return all tactical World Events since the last drain.
   */
  drainWorldEvents() {
    if (this._worldEventQueue.length === 0) return [];
    const out = this._worldEventQueue;
    this._worldEventQueue = [];
    return out;
  }

  _emitDropOutcome(outcome) {
    this._dropOutcomeQueue.push(outcome);
    if (this._onDropOutcome) this._onDropOutcome(outcome);
  }

  _emitWorldEvent(event) {
    this._worldEventQueue.push(event);
    if (this._onWorldEvent) this._onWorldEvent(event);
  }

  _addActive(idx) {
    if (this.activePos[idx] === -1) {
      this.activePos[idx] = this.activeCount;
      this.activeList[this.activeCount++] = idx;
    }
  }

  _removeActive(idx) {
    const pos = this.activePos[idx];
    if (pos !== -1) {
      const last = this.activeList[--this.activeCount];
      this.activeList[pos] = last;
      this.activePos[last] = pos;
      this.activePos[idx] = -1;
    }
  }

  _clearCellAttr(idx) {
    const base = idx * ATTR_SLOTS_PER_CELL;
    for (let k = 0; k < ATTR_SLOTS_PER_CELL; k++) {
      this.attrSlot[base + k] = -1;
    }
  }

  _updateWindVector() {
    const rad = this.windDirDeg * DEG2RAD;
    const speedMs = this.windSpeedKt * KNOTS_TO_MS;
    this.windVx = Math.sin(rad) * speedMs;
    this.windVz = -Math.cos(rad) * speedMs;
  }

  _addScore(slotId, pts, kind, x, z, scoreEvents) {
    this.missionScore += pts;
    const sid = slotId ?? 0;
    this.slotScores.set(sid, (this.slotScores.get(sid) || 0) + pts);
    scoreEvents.push({ slotId: sid, pts, kind, x, z });

    const burst = this._latestBurstBySlot.get(sid);
    if (burst && !burst.emitted) {
      burst.pointsAwarded += pts;
      if (kind === 'cabin') {
        burst.cabinSaved = true;
      }
    }
  }

  /**
   * Reset fire simulation for a given wave (wave 1 resets score; wave > 1 in rolling/Mega-Basin preserves score).
   */
  reset(wave = 1) {
    this.wave = Number.isFinite(wave) ? Math.max(1, Math.round(wave)) : 1;
    const preserveScores = (this.isMegaBasin || this.rollingIntermission) && this.wave > 1;
    if (!preserveScores) {
      this.missionScore = 0;
      this.slotScores.clear();
    }

    const baseSeed = ((this.terrain.opConfig?.seed ?? 101) + wave * 7919) >>> 0;
    this.rng = createRng(baseSeed);

    this.cells.fill(0);
    this.phases.fill(0);
    this.intensityF.fill(0);
    this.wetTimer.fill(0);
    this.emberTimer.fill(0);
    this.ignitionAccum.fill(0);
    this.wetDelta.fill(0);
    this.wetDirtyFlags.fill(0);
    this.wetDirtyCount = 0;
    this.cellLastDropId.fill(0);
    this.activePos.fill(-1);
    this.activeCount = 0;
    this.attrSlot.fill(-1);
    this.parcelCount = 0;
    this.simTime = 0;
    this.emberSpotAccum = 0;
    this.status = 'active';
    this.intermissionTimer = 0;
    this.intermissionReason = null;

    this._activeBurstBySlot.clear();
    this._latestBurstBySlot.clear();
    this._burstsById.clear();
    this._dropOutcomeQueue = [];
    this._worldEventQueue = [];
    this._settlementAtRisk.fill(0);
    this._settlementAlertCooldown.fill(0);

    // Initialize fuel & per-cell burn duration (140..210 s)
    for (let i = 0; i < this.cellCount; i++) {
      if (this.terrain.fuelMask[i] === 1) {
        this.fuelRemaining[i] = 1.0;
        this.burnDuration[i] = 140 + this.rng() * 70;
      } else {
        this.fuelRemaining[i] = 0;
        this.burnDuration[i] = 160;
      }
    }

    // Restore cabins
    for (let c = 0; c < this.cabinsTotal; c++) {
      this.cabinHp[c] = 100;
      this.cabinHpF[c] = 100;
      this.cabinAtRisk[c] = 0;
      this.cabinThreatTime[c] = 0;
      this.cabinSavedCooldown[c] = 0;
      this.cabinLastHelperSlot[c] = -1;
    }
    this.cabinsAlive = this.cabinsTotal;

    // Wind base & peak gust amplitude
    const baseDir = this.terrain.opConfig?.windDirDeg ?? 90;
    const waveRot = this.isMegaBasin ? ((wave - 1) * 55) % 360 : 0;
    this.baseWindDirDeg = (baseDir + waveRot + 360) % 360;
    this.baseWindSpeedKt = this.terrain.opConfig?.windSpeedKt ?? 10;
    const rawGust = this.terrain.opConfig?.windGustKt;
    this.windGustAmpKt =
      typeof rawGust === 'number'
        ? rawGust > this.baseWindSpeedKt
          ? rawGust - this.baseWindSpeedKt
          : Math.max(0, Math.min(rawGust, 6))
        : 2;
    this.windDirDeg = this.baseWindDirDeg;
    this.windSpeedKt = this.baseWindSpeedKt;
    this._lastReportedWindDir = this.windDirDeg;
    this._lastReportedWindSpeed = this.windSpeedKt;
    this._windShiftCooldown = 30.0;
    this._updateWindVector();

    // Seed initial wildfire patches
    const seeds = this.terrain.initialFireSeeds || [];
    const activeSeedCount = this.isMegaBasin
      ? Math.min(seeds.length, Math.max(2, Math.min(seeds.length, 2 + ((wave - 1) % 4))))
      : seeds.length;

    for (let s = 0; s < activeSeedCount; s++) {
      const seed = seeds[s];
      this._ignitePatch(seed.gx, seed.gz, seed.radius);
    }

    this._updateReplicaCabinRisk(false);
    this._recomputeMetricsAndTargets();
  }

  _ignitePatch(cx, cz, radius) {
    const gs = this.gridSize;
    const rCeil = Math.ceil(radius);
    for (let dz = -rCeil; dz <= rCeil; dz++) {
      const gz = cz + dz;
      if (gz < 1 || gz >= gs - 1) continue;
      for (let dx = -rCeil; dx <= rCeil; dx++) {
        const gx = cx + dx;
        if (gx < 1 || gx >= gs - 1) continue;
        const d = Math.hypot(dx, dz);
        if (d > radius + (this.rng() - 0.5) * 1.1) continue;
        const idx = gz * gs + gx;
        if (this.terrain.fuelMask[idx] !== 1 || this.terrain.waterMask[idx] === 1) continue;

        const norm = clamp(1 - d / (radius + 0.5), 0.15, 1.0);
        const initInt = clamp(2 + norm * 7.5 + (this.rng() - 0.5) * 1.8, 2, 10);
        this.intensityF[idx] = initInt;
        this.cells[idx] = Math.round(initInt);
        this.phases[idx] = Math.floor(this.rng() * 255);
        this._addActive(idx);
      }
    }
  }

  /**
   * Spawn a ballistic water drop parcel (called at ~10 Hz per releasing aircraft).
   * Automatically groups consecutive parcels from the same pilot into one tracked drop burst
   * unless an explicit `dropId` is provided.
   */
  spawnWaterParcel(slotId, x, y, z, vx, vy, vz, releaseAgl, dropId = null) {
    if (this.parcelCount >= MAX_PARCELS) return;
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      !Number.isFinite(vx) ||
      !Number.isFinite(vy) ||
      !Number.isFinite(vz)
    ) {
      return;
    }
    const sid = slotId ?? 0;

    let burst = this._activeBurstBySlot.get(sid);
    const shouldStartNew =
      !burst ||
      burst.emitted ||
      (dropId != null && burst.externalDropId !== dropId) ||
      (dropId == null && this.simTime - burst.lastSpawnTime > 0.45);

    if (shouldStartNew) {
      const id = ++this._nextDropId;
      burst = {
        id,
        externalDropId: dropId,
        slotId: sid,
        createdTime: this.simTime,
        lastSpawnTime: this.simTime,
        lastImpactTime: -1,
        parcelsInFlight: 0,
        totalParcels: 0,
        releaseAglSum: 0,
        headingSumX: 0,
        headingSumZ: 0,
        impactSumX: 0,
        impactSumZ: 0,
        impactCount: 0,
        cellsExtinguished: 0,
        cooledCellSet: new Set(),
        fireCellsTouched: new Set(),
        pointsAwarded: 0,
        cabinSaved: false,
        emitted: false,
      };
      this._activeBurstBySlot.set(sid, burst);
      this._latestBurstBySlot.set(sid, burst);
      this._burstsById.set(id, burst);
    }

    const safeAgl = Math.max(0, releaseAgl ?? 35);
    burst.lastSpawnTime = this.simTime;
    burst.parcelsInFlight++;
    burst.totalParcels++;
    burst.releaseAglSum += safeAgl;
    burst.headingSumX += vx;
    burst.headingSumZ += vz;

    const i = this.parcelCount++;
    this.parcelSlot[i] = sid;
    this.parcelDropId[i] = burst.id;
    this.parcelX[i] = x;
    this.parcelY[i] = y;
    this.parcelZ[i] = z;
    this.parcelVx[i] = vx;
    this.parcelVy[i] = vy;
    this.parcelVz[i] = vz;
    this.parcelReleaseAgl[i] = safeAgl;
  }

  _recordWet(idx, slotId, dropId, amount, isActiveFire) {
    if (amount <= 0) return;
    if (this.wetDirtyFlags[idx] === 0) {
      this.wetDirtyFlags[idx] = 1;
      this.wetDirtyList[this.wetDirtyCount++] = idx;
    }
    this.wetDelta[idx] += amount;
    if (dropId > 0) {
      this.cellLastDropId[idx] = dropId;
    }

    if (!isActiveFire) return;

    const base = idx * ATTR_SLOTS_PER_CELL;
    const now = this.simTime;
    const cutoff = now - 3.0;
    let emptyIdx = -1;
    let minIdx = base;
    let minAmt = Infinity;

    for (let k = 0; k < ATTR_SLOTS_PER_CELL; k++) {
      const pos = base + k;
      const s = this.attrSlot[pos];
      if (s === slotId && this.attrTime[pos] >= cutoff) {
        this.attrAmt[pos] += amount;
        this.attrTime[pos] = now;
        return;
      }
      if (s === -1 || this.attrTime[pos] < cutoff) {
        if (emptyIdx === -1) emptyIdx = pos;
      } else if (this.attrAmt[pos] < minAmt) {
        minAmt = this.attrAmt[pos];
        minIdx = pos;
      }
    }

    const writePos = emptyIdx !== -1 ? emptyIdx : minIdx;
    this.attrSlot[writePos] = slotId;
    this.attrAmt[writePos] = amount;
    this.attrTime[writePos] = now;
  }

  /**
   * Apply a landed water parcel splash onto the grid via conflict-free wetDelta.
   * Uses the exact shared evaluateDropAltitude() & computeSplashRadius() formulas matching predictDropImpact().
   * - Optimal 18-52 m (peak 25-42 m): concentrated curtain (up to 1.8x cooling -> massive knockdown)
   * - Too high > 58 m: wide wind-sheared evaporated mist with quadratic 2D area dilution (refR/R)^2
   */
  _applyWaterSplash(slotId, dropId, x, z, releaseAgl) {
    const altEval = evaluateDropAltitude(releaseAgl);
    const R = computeSplashRadius(releaseAgl, this.cellSize);
    const refR = 44.0 * (this.cellSize / 16.0);
    const K0 = 6.0;
    // True 2D area dilution (refR/R)^2 so wide wind-sheared mist loses liquid density quadratically
    const areaDilution = Math.min(1.35, (refR * refR) / (R * R));
    const knockdown = K0 * altEval.coolingMult * areaDilution;
    const edgeFalloff = altEval.dropQuality === 'misted_high' ? 0.72 : 0.32;

    const burst = dropId > 0 ? this._burstsById.get(dropId) : null;
    if (burst) {
      burst.impactSumX += x;
      burst.impactSumZ += z;
      burst.impactCount++;
      burst.lastImpactTime = this.simTime;
    }

    const gs = this.gridSize;
    const cellSize = this.cellSize;
    const halfWorld = this.terrain.halfWorld;
    const cgx = Math.floor((x + halfWorld) / cellSize);
    const cgz = Math.floor((z + halfWorld) / cellSize);
    const rCells = Math.ceil(R / cellSize);
    const rSq = R * R;
    const waterMask = this.terrain.waterMask;
    const cells = this.cells;
    let hitActiveFire = false;

    for (let dz = -rCells; dz <= rCells; dz++) {
      const gz = cgz + dz;
      if (gz < 0 || gz >= gs) continue;
      const wz = (gz + 0.5) * cellSize - halfWorld;
      const dzW = wz - z;
      const dzSq = dzW * dzW;
      const rowBase = gz * gs;

      for (let dx = -rCells; dx <= rCells; dx++) {
        const gx = cgx + dx;
        if (gx < 0 || gx >= gs) continue;
        const idx = rowBase + gx;
        if (waterMask[idx] === 1) continue;

        const wx = (gx + 0.5) * cellSize - halfWorld;
        const dxW = wx - x;
        const dSq = dxW * dxW + dzSq;
        if (dSq > rSq) continue;

        const st = cells[idx];
        const isFire = (st >= 1 && st <= 12) || st === CELL_STATE.EMBER_WARN;
        const falloff = 1.0 - edgeFalloff * (dSq / rSq);
        this._recordWet(idx, slotId, dropId, knockdown * falloff, isFire);
        if (isFire) {
          hitActiveFire = true;
          if (burst) burst.fireCellsTouched.add(idx);
        }
      }
    }
    return hitActiveFire;
  }

  /**
   * Resolve primary (+70) and assist (+35 for >= 15% share) scoring from flat 3.0 s ring.
   */
  _awardExtinguishAttribution(idx, scoreEvents) {
    const base = idx * ATTR_SLOTS_PER_CELL;
    const cutoff = this.simTime - 3.0;

    let totalWet = 0;
    let primarySlot = -1;
    let primaryAmt = -1;

    for (let k = 0; k < ATTR_SLOTS_PER_CELL; k++) {
      const pos = base + k;
      const sid = this.attrSlot[pos];
      if (sid === -1) continue;
      if (this.attrTime[pos] < cutoff) {
        this.attrSlot[pos] = -1;
        continue;
      }
      const amt = this.attrAmt[pos];
      totalWet += amt;
      if (amt > primaryAmt) {
        primaryAmt = amt;
        primarySlot = sid;
      }
    }

    if (totalWet <= 0 || primarySlot < 0) {
      this._clearCellAttr(idx);
      return -1;
    }

    const gx = idx % this.gridSize;
    const gz = (idx - gx) / this.gridSize;
    const x = (gx + 0.5) * this.cellSize - this.terrain.halfWorld;
    const z = (gz + 0.5) * this.cellSize - this.terrain.halfWorld;

    this._addScore(primarySlot, SCORE.CELL_PRIMARY, 'cell', x, z, scoreEvents);

    const assistThreshold = totalWet * 0.15;
    for (let k = 0; k < ATTR_SLOTS_PER_CELL; k++) {
      const pos = base + k;
      const sid = this.attrSlot[pos];
      if (sid !== -1 && sid !== primarySlot && this.attrAmt[pos] >= assistThreshold) {
        this._addScore(sid, SCORE.CELL_ASSIST, 'assist', x, z, scoreEvents);
      }
      this.attrSlot[pos] = -1;
    }

    // Track last helper for any nearby alive cabin within 64 m (for +500 Cabin Saved credit)
    const cabins = this.terrain.cabins;
    for (let c = 0; c < this.cabinsTotal; c++) {
      if (this.cabinHp[c] <= 0) continue;
      const dx = x - cabins[c].x;
      const dz = z - cabins[c].z;
      if (dx * dx + dz * dz <= 64 * 64) {
        this.cabinLastHelperSlot[c] = primarySlot;
      }
    }

    return primarySlot;
  }

  _markChanged(idx) {
    if (this._changedMark[idx] === 0) {
      this._changedMark[idx] = 1;
      this._changedIdxList[this._changedCount++] = idx;
    }
  }

  _sampleGroundY(x, z) {
    const gs = this.gridSize;
    const fx = (x + this._halfWorld) * this._invCellSize;
    const fz = (z + this._halfWorld) * this._invCellSize;
    const cx = fx < 0 ? 0 : fx > gs - 1e-4 ? gs - 1e-4 : fx;
    const cz = fz < 0 ? 0 : fz > gs - 1e-4 ? gs - 1e-4 : fz;
    const ix = cx | 0;
    const iz = cz | 0;
    const tx = cx - ix;
    const tz = cz - iz;
    const stride = this._vertStride;
    const heights = this._heights;
    const i00 = iz * stride + ix;
    const h0 = heights[i00] + (heights[i00 + 1] - heights[i00]) * tx;
    const h1 = heights[i00 + stride] + (heights[i00 + stride + 1] - heights[i00 + stride]) * tx;
    const th = h0 + (h1 - h0) * tz;
    const wl = this.terrain.waterLevel;
    return th > wl ? th : wl;
  }

  _checkWindShiftEvent(dtSafe) {
    if (this._windShiftCooldown > 0) {
      this._windShiftCooldown = Math.max(0, this._windShiftCooldown - dtSafe);
      return;
    }
    const dirDelta = shortestAngleDiffDeg(this.windDirDeg, this._lastReportedWindDir);
    const spdDelta = Math.abs(this.windSpeedKt - this._lastReportedWindSpeed);
    if (dirDelta >= 18 || spdDelta >= 4) {
      this._lastReportedWindDir = this.windDirDeg;
      this._lastReportedWindSpeed = this.windSpeedKt;
      this._windShiftCooldown = 35.0;
      const rad = this.windDirDeg * DEG2RAD;
      this._emitWorldEvent({
        type: 'wind_shift',
        windDirDeg: Math.round(this.windDirDeg),
        windSpeedKt: Math.round(this.windSpeedKt),
        compass: vectorToCompass(Math.sin(rad), -Math.cos(rad)),
      });
    }
  }

  /**
   * Advance the wildfire simulation by `dt` seconds (designed for 10 Hz, dt = 0.1 s).
   */
  step(dt = 0.1, activeManualPilots = 1) {
    const dtSafe = Number.isFinite(dt) ? Math.max(0.001, Math.min(dt, 0.25)) : 0.1;
    const pilotsSafe = Number.isFinite(activeManualPilots) ? Math.max(1, activeManualPilots) : 1;
    this.simTime += dtSafe;

    const changedCells = [];
    const cabinChanges = [];
    const scoreEvents = [];
    const impactEvents = [];
    this._changedCount = 0;

    // 1. Update smoothly gusting wind vector
    const dirShift = Math.sin(this.simTime * 0.045) * 14 + Math.sin(this.simTime * 0.11) * 6;
    const gustWave = 0.5 + 0.5 * (Math.sin(this.simTime * 0.19) * 0.65 + Math.cos(this.simTime * 0.07) * 0.35);
    this.windDirDeg = ((this.baseWindDirDeg + dirShift) % 360 + 360) % 360;
    this.windSpeedKt = Math.max(4, this.baseWindSpeedKt + gustWave * this.windGustAmpKt);
    this._updateWindVector();
    this._checkWindShiftEvent(dtSafe);

    // Handle rolling intermission countdown (live shared mission & Mega-Basin)
    if (this.status === 'intermission') {
      this.intermissionTimer = Math.max(0, this.intermissionTimer - dtSafe);
      let fullReset = false;
      let advanceOperation = false;
      if (this.intermissionTimer <= 0) {
        const prevReason = this.intermissionReason || 'contained';
        const fromOp = this.terrain.opConfig;
        const fromOpId = fromOp?.id || 'op01';
        const fromOpIndex = typeof fromOp?.opIndex === 'number' ? fromOp.opIndex : 0;
        const nextOp = getNextOperation(fromOp);
        const isOverrunRedeploy = prevReason === 'overrun' && !this.isMegaBasin;
        const nextWave = isOverrunRedeploy ? 1 : this.wave + 1;
        advanceOperation = prevReason === 'contained';

        this.reset(nextWave);
        fullReset = true;
        for (let c = 0; c < this.cabinsTotal; c++) {
          cabinChanges.push({ id: c, hp: this.cabinHp[c] });
        }
        if (isOverrunRedeploy) {
          this._emitWorldEvent({
            type: 'sector_redeploy',
            fromOpId,
            fromOpIndex,
            nextOpId: fromOpId,
            nextOpIndex: fromOpIndex,
            wave: 1,
            reason: prevReason,
          });
        } else {
          this._emitWorldEvent({
            type: 'operation_advance',
            fromOpId,
            fromOpIndex,
            nextOpId: nextOp.id,
            nextOpIndex: nextOp.opIndex,
            wave: nextWave,
            reason: prevReason,
          });
        }
      }
      return {
        changedCells,
        cabinChanges,
        scoreEvents,
        impactEvents,
        missionScore: this.missionScore,
        burningPct: this.burningPct,
        burningCount: this.burningCount,
        emberCount: this.emberCount,
        cabinsAlive: this.cabinsAlive,
        cabinsTotal: this.cabinsTotal,
        windDirDeg: this.windDirDeg,
        windSpeedKt: this.windSpeedKt,
        windVx: this.windVx,
        windVz: this.windVz,
        status: this.status,
        intermissionTimer: this.intermissionTimer,
        intermissionReason: this.intermissionReason,
        wave: this.wave,
        fullReset,
        advanceOperation,
      };
    }

    // 2. Step ballistic water parcels (with exact sub-step ground crossing interpolation)
    this._stepParcels(dtSafe, impactEvents);

    // 3. Apply accumulated conflict-free wetDelta to touched cells
    this._applyWetDeltas(scoreEvents);

    // 4. Cellular wildfire dynamics, ember spotting, and cabins
    if (this.status === 'active') {
      this._stepCellular(dtSafe, pilotsSafe);
      this._stepCabins(dtSafe, cabinChanges, scoreEvents);
    }

    // 5. Build changedCells output & clear markers
    const cCount = this._changedCount;
    for (let i = 0; i < cCount; i++) {
      const idx = this._changedIdxList[i];
      this._changedMark[idx] = 0;
      changedCells.push({
        idx,
        state: this.cells[idx],
        phase: this.phases[idx],
      });
    }

    // 6. Recompute counts, burningPct, hotClusters, fireHead, targets
    this._recomputeMetricsAndTargets();

    // 7. Finalize settled drop bursts and emit structured Drop Outcome Events
    this._finalizeSettledBursts();

    // 8. Evaluate victory / containment / overrun transitions
    if (this.status === 'active') {
      if (this.burningCount === 0 && this.emberCount === 0) {
        const opCfg = this.terrain.opConfig;
        if (this.rollingIntermission) {
          this.status = 'intermission';
          this.intermissionReason = 'contained';
          this.intermissionTimer = 15.0;
          this.missionScore += SCORE.WAVE_CONTAINED;
        } else {
          this.status = 'victory';
        }
        this._emitWorldEvent({
          type: 'fire_contained',
          opId: opCfg?.id || 'op01',
          opIndex: typeof opCfg?.opIndex === 'number' ? opCfg.opIndex : 0,
          wave: this.wave,
          missionScore: this.missionScore,
          cabinsAlive: this.cabinsAlive,
          cabinsTotal: this.cabinsTotal,
        });
      } else if (this.cabinsTotal > 0 && this.cabinsAlive === 0) {
        if (this.rollingIntermission) {
          this.status = 'intermission';
          this.intermissionReason = 'overrun';
          this.intermissionTimer = 15.0;
        } else {
          this.status = 'defeat';
        }
      }
    }

    return {
      changedCells,
      cabinChanges,
      scoreEvents,
      impactEvents,
      missionScore: this.missionScore,
      burningPct: this.burningPct,
      burningCount: this.burningCount,
      emberCount: this.emberCount,
      cabinsAlive: this.cabinsAlive,
      cabinsTotal: this.cabinsTotal,
      windDirDeg: this.windDirDeg,
      windSpeedKt: this.windSpeedKt,
      windVx: this.windVx,
      windVz: this.windVz,
      status: this.status,
      intermissionTimer: this.intermissionTimer,
      intermissionReason: this.intermissionReason,
      wave: this.wave,
      fullReset: false,
      advanceOperation: false,
    };
  }

  _stepParcels(dtSafe, impactEvents) {
    const awx = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * this.windVx;
    const awz = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * this.windVz;
    const g = FLIGHT_CONSTANTS.DROP_GRAVITY;
    const halfDt = 0.5 * dtSafe;

    for (let i = this.parcelCount - 1; i >= 0; i--) {
      const x0 = this.parcelX[i];
      const y0 = this.parcelY[i];
      const z0 = this.parcelZ[i];
      const vx0 = this.parcelVx[i];
      const vy0 = this.parcelVy[i];
      const vz0 = this.parcelVz[i];

      const vx1 = vx0 + awx * dtSafe;
      const vy1 = vy0 - g * dtSafe;
      const vz1 = vz0 + awz * dtSafe;

      const nx = x0 + (vx0 + vx1) * halfDt;
      const ny = y0 + (vy0 + vy1) * halfDt;
      const nz = z0 + (vz0 + vz1) * halfDt;

      this.parcelVx[i] = vx1;
      this.parcelVy[i] = vy1;
      this.parcelVz[i] = vz1;
      this.parcelX[i] = nx;
      this.parcelY[i] = ny;
      this.parcelZ[i] = nz;

      const groundY = this._sampleGroundY(nx, nz);
      if (ny <= groundY) {
        // Sub-step exact terrain crossing interpolation so impacts match predictDropImpact() < 1 cell
        const prevGroundY = this._sampleGroundY(x0, z0);
        const prevAbove = Math.max(0, y0 - prevGroundY);
        const curBelow = Math.max(0, groundY - ny);
        const denom = prevAbove + curBelow;
        const frac = denom > 1e-5 ? clamp(prevAbove / denom, 0, 1) : 1.0;
        const ix = x0 + (nx - x0) * frac;
        const iz = z0 + (nz - z0) * frac;
        const iy = this._sampleGroundY(ix, iz);

        const slotId = this.parcelSlot[i];
        const dropId = this.parcelDropId[i];
        const hitFire = this._applyWaterSplash(slotId, dropId, ix, iz, this.parcelReleaseAgl[i]);
        impactEvents.push({ x: ix, y: iy, z: iz, extinguished: hitFire });

        if (dropId > 0) {
          const burst = this._burstsById.get(dropId);
          if (burst) {
            burst.parcelsInFlight = Math.max(0, burst.parcelsInFlight - 1);
          }
        }

        const last = --this.parcelCount;
        if (i !== last) {
          this.parcelSlot[i] = this.parcelSlot[last];
          this.parcelDropId[i] = this.parcelDropId[last];
          this.parcelX[i] = this.parcelX[last];
          this.parcelY[i] = this.parcelY[last];
          this.parcelZ[i] = this.parcelZ[last];
          this.parcelVx[i] = this.parcelVx[last];
          this.parcelVy[i] = this.parcelVy[last];
          this.parcelVz[i] = this.parcelVz[last];
          this.parcelReleaseAgl[i] = this.parcelReleaseAgl[last];
        }
      }
    }
  }

  _applyWetDeltas(scoreEvents) {
    const count = this.wetDirtyCount;
    const list = this.wetDirtyList;
    const wetDelta = this.wetDelta;
    const wetDirtyFlags = this.wetDirtyFlags;
    const cells = this.cells;
    const intensityF = this.intensityF;
    const fuelMask = this.terrain.fuelMask;
    const wetSpan = WET_COOLDOWN_MAX - WET_COOLDOWN_MIN;

    for (let d = 0; d < count; d++) {
      const idx = list[d];
      const wet = wetDelta[idx];
      wetDelta[idx] = 0;
      wetDirtyFlags[idx] = 0;

      const dropId = this.cellLastDropId[idx];
      const burst = dropId > 0 ? this._burstsById.get(dropId) : null;

      const st = cells[idx];
      if (st >= 1 && st <= 12) {
        const nextI = intensityF[idx] - wet;
        intensityF[idx] = nextI;
        if (nextI <= 1.2) {
          intensityF[idx] = 0;
          cells[idx] = CELL_STATE.WET;
          this.wetTimer[idx] = WET_COOLDOWN_MIN + this.rng() * wetSpan;
          this.phases[idx] = 255;
          this.ignitionAccum[idx] = 0;
          this._addActive(idx);
          this._markChanged(idx);
          if (burst && !burst.emitted) {
            burst.cellsExtinguished++;
            burst.cooledCellSet.delete(idx);
          }
          this._awardExtinguishAttribution(idx, scoreEvents);
        } else {
          if (burst && !burst.emitted) {
            burst.cooledCellSet.add(idx);
          }
          const q = clamp(Math.round(nextI), 1, 12);
          if (q !== st) {
            cells[idx] = q;
            this._markChanged(idx);
          }
        }
      } else if (st === CELL_STATE.EMBER_WARN) {
        if (wet >= 0.6) {
          cells[idx] = CELL_STATE.WET;
          this.emberTimer[idx] = 0;
          this.wetTimer[idx] = WET_COOLDOWN_MIN + this.rng() * wetSpan;
          this.phases[idx] = 255;
          this._addActive(idx);
          this._markChanged(idx);
          if (burst && !burst.emitted) {
            burst.cellsExtinguished++;
            burst.cooledCellSet.delete(idx);
          }
          this._awardExtinguishAttribution(idx, scoreEvents);
        } else if (burst && !burst.emitted) {
          burst.cooledCellSet.add(idx);
        }
      } else if (st === CELL_STATE.INTACT && fuelMask[idx] === 1) {
        // Any water mist cools pre-heated foliage; >= 1.8 creates a full 28-35 s wet firebreak
        this.ignitionAccum[idx] = 0;
        if (wet >= 1.8) {
          cells[idx] = CELL_STATE.WET;
          this.wetTimer[idx] = WET_COOLDOWN_MIN + this.rng() * wetSpan;
          this.phases[idx] = 255;
          this._addActive(idx);
          this._markChanged(idx);
        }
      } else if (st === CELL_STATE.WET) {
        this.wetTimer[idx] = Math.min(WET_COOLDOWN_MAX, this.wetTimer[idx] + wet * 2.0);
      }
    }
    this.wetDirtyCount = 0;
  }

  /**
   * Find nearest burning or ember-warning cell to world coordinates (wx, wz).
   */
  _findNearestFireCell(wx, wz) {
    const gs = this.gridSize;
    const cellSize = this.cellSize;
    const halfWorld = this.terrain.halfWorld;
    const cells = this.cells;
    let bestSq = Infinity;
    let bestX = 0;
    let bestZ = 0;

    for (let a = 0; a < this.activeCount; a++) {
      const idx = this.activeList[a];
      const st = cells[idx];
      if (!((st >= 1 && st <= 12) || st === CELL_STATE.EMBER_WARN)) continue;
      const gx = idx % gs;
      const gz = (idx - gx) / gs;
      const fx = (gx + 0.5) * cellSize - halfWorld;
      const fz = (gz + 0.5) * cellSize - halfWorld;
      const dx = fx - wx;
      const dz = fz - wz;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestSq) {
        bestSq = dSq;
        bestX = fx;
        bestZ = fz;
      }
    }

    if (!Number.isFinite(bestSq)) return null;
    return { x: bestX, z: bestZ, distM: Math.sqrt(bestSq) };
  }

  /**
   * Emit Drop Outcome Events for any pilot water bursts whose parcels have all landed and settled.
   */
  _finalizeSettledBursts() {
    if (this._burstsById.size === 0) return;
    const now = this.simTime;

    for (const [id, burst] of this._burstsById) {
      if (burst.emitted) {
        this._burstsById.delete(id);
        continue;
      }
      if (burst.parcelsInFlight > 0) continue;

      const sinceSpawn = now - burst.lastSpawnTime;
      const sinceImpact = burst.lastImpactTime >= 0 ? now - burst.lastImpactTime : 0;
      const settled =
        burst.impactCount > 0 &&
        (sinceSpawn >= 0.35 || sinceImpact >= 0.25);

      if (!settled) continue;

      burst.emitted = true;
      this._burstsById.delete(id);
      if (this._activeBurstBySlot.get(burst.slotId) === burst) {
        this._activeBurstBySlot.delete(burst.slotId);
      }

      const impactX = burst.impactSumX / burst.impactCount;
      const impactZ = burst.impactSumZ / burst.impactCount;
      const cellsExtinguished = burst.cellsExtinguished;
      const cellsCooled = burst.cooledCellSet.size;
      const pointsAwarded = Math.round(burst.pointsAwarded);
      const targetFireCount = burst.fireCellsTouched.size;
      const avgReleaseAgl = burst.totalParcels > 0 ? burst.releaseAglSum / burst.totalParcels : 35;
      const { dropQuality } = evaluateDropAltitude(avgReleaseAgl);

      let outcome;
      if (dropQuality === 'misted_high') {
        if (cellsExtinguished >= 8 && targetFireCount > 0 && cellsExtinguished >= targetFireCount * 0.5) {
          outcome = 'direct';
        } else if (cellsExtinguished >= 1 || cellsCooled >= 1) {
          outcome = 'partial';
        } else {
          outcome = 'miss';
        }
      } else if (
        cellsExtinguished >= 3 ||
        (cellsExtinguished >= 1 && targetFireCount > 0 && cellsExtinguished >= targetFireCount * 0.5)
      ) {
        outcome = 'direct';
      } else if (cellsExtinguished >= 1 || cellsCooled >= 1) {
        outcome = 'partial';
      } else {
        outcome = 'miss';
      }

      let missType = 'none';
      let missDirCompass = '';
      let missDistM = 0;

      if (outcome === 'miss') {
        const nearest = this._findNearestFireCell(impactX, impactZ);
        if (nearest) {
          // Vector from nearest fire -> impact point (shows where the water landed relative to fire)
          const dx = impactX - nearest.x;
          const dz = impactZ - nearest.z;
          missDistM = Math.round(nearest.distM);
          missDirCompass = vectorToCompass(dx, dz);

          const hMag = Math.hypot(burst.headingSumX, burst.headingSumZ);
          if (hMag >= 0.5) {
            const hx = burst.headingSumX / hMag;
            const hz = burst.headingSumZ / hMag;
            // Right perpendicular vector: (-hz, hx)
            const along = dx * hx + dz * hz;
            const cross = dx * -hz + dz * hx;
            if (Math.abs(cross) > Math.abs(along) * 1.15) {
              missType = 'wide';
            } else if (along > 0) {
              missType = 'overshot';
            } else {
              missType = 'short';
            }
          } else {
            missType = 'wide';
          }
        } else {
          missType = 'wide';
        }
      }

      this._emitDropOutcome({
        dropId: burst.id,
        slotId: burst.slotId,
        impactX: Math.round(impactX * 10) / 10,
        impactZ: Math.round(impactZ * 10) / 10,
        cellsExtinguished,
        cellsCooled,
        pointsAwarded,
        outcome,
        missType,
        missDirCompass,
        missDistM,
        cabinSaved: burst.cabinSaved,
        dropQuality,
        releaseAgl: Math.round(avgReleaseAgl),
      });
    }
  }

  _tryEmberSpot(spotCandidateIdx, wHatX, wHatZ, effPilots, dtSafe) {
    // Heavily reduced random ember spotting for 1-2 pilots; scales smoothly with larger squadrons
    const pilotEmberFactor =
      effPilots <= 2
        ? 0.22
        : 0.22 + 0.42 * Math.log(1 + (effPilots - 2));
    const spotRate = (this.isMegaBasin ? 0.012 : 0.008) * pilotEmberFactor;
    this.emberSpotAccum += spotRate * dtSafe;
    if (this.emberSpotAccum < 1.0) return;
    this.emberSpotAccum -= 1.0;

    const gs = this.gridSize;
    const sgx = spotCandidateIdx % gs;
    const sgz = (spotCandidateIdx - sgx) / gs;
    const jumpCells = 3 + Math.floor(this.rng() * 5);
    const lateral = (this.rng() - 0.5) * 3;
    const tgx = Math.round(sgx + wHatX * jumpCells - wHatZ * lateral);
    const tgz = Math.round(sgz + wHatZ * jumpCells + wHatX * lateral);
    if (tgx >= 2 && tgx < gs - 2 && tgz >= 2 && tgz < gs - 2) {
      const tIdx = tgz * gs + tgx;
      if (this.cells[tIdx] === CELL_STATE.INTACT && this.terrain.fuelMask[tIdx] === 1) {
        this.cells[tIdx] = CELL_STATE.EMBER_WARN;
        this.emberTimer[tIdx] = 4.0;
        this.phases[tIdx] = 0;
        this._addActive(tIdx);
        this._markChanged(tIdx);
      }
    }
  }

  _stepCellular(dtSafe, activeManualPilots) {
    const gs = this.gridSize;
    const invCellSize = this._invCellSize;
    const windSpeedKt = this.windSpeedKt;
    const windMag = Math.sqrt(this.windVx * this.windVx + this.windVz * this.windVz);
    const wHatX = windMag > 1e-4 ? this.windVx / windMag : 0;
    const wHatZ = windMag > 1e-4 ? this.windVz / windMag : 0;
    const windSpeedScale = windSpeedKt / 14.0;

    // Unified sublinear pilot pressure scaling: 1.0x at 1 pilot -> ~7.7x at 100 pilots
    const effPilots = Math.max(1, activeManualPilots || 1);
    const pilotScale = 1.0 + 1.45 * Math.log(effPilots);

    const baseSpreadDt = BASE_SPREAD_RATE * pilotScale * dtSafe;
    const fuelMask = this.terrain.fuelMask;
    const cellHeights = this.terrain.cellHeights;
    const cells = this.cells;
    const intensityF = this.intensityF;
    const fuelRem = this.fuelRemaining;
    const burnDur = this.burnDuration;
    const ignAccum = this.ignitionAccum;

    // Realistic wind-driven spread: crisp downwind head advance, minimal upwind/flank backing
    const nbrWindFactor = this._nbrWindFactor;
    for (let n = 0; n < 8; n++) {
      const dotW = NBR_UX[n] * wHatX + NBR_UZ[n] * wHatZ;
      const windMult = dotW >= 0
        ? 0.14 + 3.45 * dotW * windSpeedScale
        : Math.max(0.05, 0.14 + 0.10 * dotW * windSpeedScale);
      nbrWindFactor[n] = windMult / NBR_DIST[n];
    }

    const snapCount = this.activeCount;
    let removeCount = 0;
    let spotCandidateIdx = -1;
    let spotCandidateScore = -1;

    for (let a = 0; a < snapCount; a++) {
      const idx = this.activeList[a];
      const st = cells[idx];

      if (st >= 1 && st <= 12) {
        const curInt = intensityF[idx];
        const nextFuel = fuelRem[idx] - ((0.5 + 0.5 * (curInt / 12)) / burnDur[idx]) * dtSafe;
        fuelRem[idx] = nextFuel;

        if (nextFuel <= 0) {
          fuelRem[idx] = 0;
          intensityF[idx] = 0;
          cells[idx] = CELL_STATE.CHARRED;
          this.phases[idx] = 0;
          this._clearCellAttr(idx);
          this._markChanged(idx);
          this._toRemove[removeCount++] = idx;
          continue;
        }

        const nextInt = nextFuel > 0.15
          ? Math.min(12.0, curInt + 0.55 * dtSafe)
          : Math.max(1.0, curInt - 1.5 * dtSafe);
        intensityF[idx] = nextInt;

        const q = clamp(Math.round(nextInt), 1, 12);
        if (q !== st) {
          cells[idx] = q;
          this._markChanged(idx);
        }

        if (q >= 7 && this.rng() < 0.03) {
          const sc = q + this.rng() * 4;
          if (sc > spotCandidateScore) {
            spotCandidateScore = sc;
            spotCandidateIdx = idx;
          }
        }

        const gx = idx % gs;
        const gz = (idx - gx) / gs;
        const myH = cellHeights[idx];
        const spreadScale = baseSpreadDt * (nextInt / 12.0);

        for (let n = 0; n < 8; n++) {
          const nx = gx + NBR_DX[n];
          const nz = gz + NBR_DZ[n];
          if (nx < 1 || nx >= gs - 1 || nz < 1 || nz >= gs - 1) continue;
          const nIdx = nz * gs + nx;
          if (cells[nIdx] !== CELL_STATE.INTACT || fuelMask[nIdx] !== 1) continue;

          const dh = cellHeights[nIdx] - myH;
          const uphillBoost = dh > 0 ? 1.0 + 1.0 * ((dh * invCellSize) / NBR_DIST[n]) : 1.0;

          const prevHeat = ignAccum[nIdx];
          const nextHeat = prevHeat + spreadScale * nbrWindFactor[n] * uphillBoost;
          ignAccum[nIdx] = nextHeat;

          if (nextHeat >= 1.0) {
            ignAccum[nIdx] = 0;
            intensityF[nIdx] = 2.0;
            cells[nIdx] = 2;
            this.phases[nIdx] = Math.floor(this.rng() * 255);
            this._addActive(nIdx);
            this._markChanged(nIdx);
          } else if (prevHeat === 0) {
            this._addActive(nIdx);
          }
        }
      } else if (st === CELL_STATE.WET) {
        const nextW = this.wetTimer[idx] - dtSafe;
        this.wetTimer[idx] = nextW;
        this.phases[idx] = clamp(Math.round((nextW / WET_COOLDOWN_MAX) * 255), 0, 255);
        if (nextW <= 0) {
          this.wetTimer[idx] = 0;
          cells[idx] = fuelRem[idx] > 0.05 ? CELL_STATE.INTACT : CELL_STATE.CHARRED;
          this.phases[idx] = 0;
          this._markChanged(idx);
          this._toRemove[removeCount++] = idx;
        }
      } else if (st === CELL_STATE.EMBER_WARN) {
        const nextE = this.emberTimer[idx] - dtSafe;
        this.emberTimer[idx] = nextE;
        this.phases[idx] = clamp(Math.round((1 - nextE / 4.0) * 255), 0, 255);
        if (nextE <= 0) {
          this.emberTimer[idx] = 0;
          intensityF[idx] = 3.0;
          cells[idx] = 3;
          this.phases[idx] = Math.floor(this.rng() * 255);
          this._markChanged(idx);
        }
      } else if (st === CELL_STATE.INTACT) {
        const nextH = ignAccum[idx] - 0.008 * dtSafe;
        if (nextH <= 0) {
          ignAccum[idx] = 0;
          this._toRemove[removeCount++] = idx;
        } else {
          ignAccum[idx] = nextH;
        }
      } else {
        this._toRemove[removeCount++] = idx;
      }
    }

    for (let r = 0; r < removeCount; r++) {
      this._removeActive(this._toRemove[r]);
    }

    const spotWindMinKt = effPilots <= 2 ? 16 : 14;
    if (windSpeedKt >= spotWindMinKt && spotCandidateIdx >= 0) {
      this._tryEmberSpot(spotCandidateIdx, wHatX, wHatZ, effPilots, dtSafe);
    }
  }

  _emitCabinRiskTransitions(dtSafe) {
    const settlements = this.terrain.settlements || [];
    for (let s = 0; s < this._settlementAlertCooldown.length; s++) {
      if (this._settlementAlertCooldown[s] > 0) {
        this._settlementAlertCooldown[s] = Math.max(0, this._settlementAlertCooldown[s] - dtSafe);
      }
    }

    for (let s = 0; s < settlements.length; s++) {
      const stObj = settlements[s];
      let riskCount = 0;
      let worstCabin = null;
      let worstHp = 101;
      for (let k = 0; k < stObj.cabins.length; k++) {
        const cid = stObj.cabins[k].id;
        if (this.cabinHp[cid] > 0 && this.cabinAtRisk[cid] === 1) {
          riskCount++;
          if (this.cabinHp[cid] < worstHp) {
            worstHp = this.cabinHp[cid];
            worstCabin = this.terrain.cabins[cid];
          }
        }
      }

      const wasAtRisk = this._settlementAtRisk[s] === 1;
      const nowAtRisk = riskCount > 0;
      this._settlementAtRisk[s] = nowAtRisk ? 1 : 0;

      if (nowAtRisk && !wasAtRisk && worstCabin && this._settlementAlertCooldown[s] <= 0) {
        this._settlementAlertCooldown[s] = 22.0;
        this._emitWorldEvent({
          type: 'cabin_at_risk',
          cabinId: worstCabin.id,
          settlementIdx: s,
          settlementName: stObj.name,
          x: worstCabin.x,
          z: worstCabin.z,
          hp: this.cabinHp[worstCabin.id],
          cabinsAtRiskCount: riskCount,
        });
      }
    }
  }

  _stepCabins(dt, cabinChanges, scoreEvents) {
    const gs = this.gridSize;
    const cellSize = this.cellSize;
    const halfWorld = this.terrain.halfWorld;
    const riskRadiusSq = 48 * 48;
    const dmgRadiusSq = 24 * 24;
    const rCells = Math.ceil(48 / cellSize);
    const cells = this.cells;
    const cabins = this.terrain.cabins;

    let alive = 0;
    for (let c = 0; c < this.cabinsTotal; c++) {
      if (this.cabinSavedCooldown[c] > 0) {
        this.cabinSavedCooldown[c] = Math.max(0, this.cabinSavedCooldown[c] - dt);
      }

      if (this.cabinHpF[c] <= 0) {
        this.cabinAtRisk[c] = 0;
        continue;
      }

      const cab = cabins[c];
      const cgx = this._cabinGx[c];
      const cgz = this._cabinGz[c];

      let atRisk = false;
      let dmgRate = 0;

      for (let dz = -rCells; dz <= rCells; dz++) {
        const gz = cgz + dz;
        if (gz < 0 || gz >= gs) continue;
        const wz = (gz + 0.5) * cellSize - halfWorld;
        const dzW = wz - cab.z;
        const dzSq = dzW * dzW;
        const rowBase = gz * gs;

        for (let dx = -rCells; dx <= rCells; dx++) {
          const gx = cgx + dx;
          if (gx < 0 || gx >= gs) continue;
          const st = cells[rowBase + gx];
          if (!((st >= 1 && st <= 12) || st === CELL_STATE.EMBER_WARN)) continue;

          const wx = (gx + 0.5) * cellSize - halfWorld;
          const dxW = wx - cab.x;
          const dSq = dxW * dxW + dzSq;
          if (dSq <= riskRadiusSq) {
            atRisk = true;
            if (dSq <= dmgRadiusSq && st >= 1 && st <= 12) {
              dmgRate += 0.85 * (st / 12.0);
            }
          }
        }
      }

      if (dmgRate > 0) {
        this.cabinHpF[c] = Math.max(0, this.cabinHpF[c] - dmgRate * dt);
        const newHp = Math.ceil(this.cabinHpF[c]);
        if (newHp !== this.cabinHp[c]) {
          this.cabinHp[c] = newHp;
          cabinChanges.push({ id: c, hp: newHp });
        }
      }

      if (this.cabinHpF[c] <= 0) {
        this.cabinAtRisk[c] = 0;
        this.cabinThreatTime[c] = 0;
        continue;
      }

      alive++;

      if (atRisk) {
        this.cabinAtRisk[c] = 1;
        this.cabinThreatTime[c] += dt;
      } else {
        if (
          this.cabinAtRisk[c] === 1 &&
          this.cabinThreatTime[c] >= 3.0 &&
          this.cabinSavedCooldown[c] <= 0 &&
          this.cabinLastHelperSlot[c] >= 0
        ) {
          this._addScore(this.cabinLastHelperSlot[c], SCORE.CABIN_SAVED, 'cabin', cab.x, cab.z, scoreEvents);
          this.cabinSavedCooldown[c] = 30.0;
        }
        this.cabinAtRisk[c] = 0;
        this.cabinThreatTime[c] = 0;
        this.cabinLastHelperSlot[c] = -1;
      }
    }

    this.cabinsAlive = alive;
    this._emitCabinRiskTransitions(dt);
  }

  _recomputeMetricsAndTargets() {
    const gs = this.gridSize;
    const cellSize = this.cellSize;
    const halfWorld = this.terrain.halfWorld;
    const cellHeights = this.terrain.cellHeights;
    const cells = this.cells;

    this._binWeight.fill(0);
    this._binSumX.fill(0);
    this._binSumZ.fill(0);
    this._binSumY.fill(0);
    this._binCount.fill(0);

    let burning = 0;
    let embers = 0;
    let headSumX = 0;
    let headSumZ = 0;
    let headWeight = 0;

    let primarySetX = 0;
    let primarySetZ = 0;
    const primarySet = this.terrain.settlements[0] || null;
    if (primarySet) {
      primarySetX = primarySet.x;
      primarySetZ = primarySet.z;
    }

    let worstRiskCabin = null;
    let worstRiskHp = 101;
    for (let c = 0; c < this.cabinsTotal; c++) {
      if (this.cabinHp[c] > 0 && this.cabinAtRisk[c] === 1) {
        if (this.cabinHp[c] < worstRiskHp) {
          worstRiskHp = this.cabinHp[c];
          worstRiskCabin = this.terrain.cabins[c];
        }
      }
    }

    if (worstRiskCabin) {
      const sObj = this.terrain.settlements[worstRiskCabin.settlementIdx];
      this.atRiskTarget = {
        x: worstRiskCabin.x,
        z: worstRiskCabin.z,
        name: sObj ? sObj.name : 'SETTLEMENT',
      };
      primarySetX = worstRiskCabin.x;
      primarySetZ = worstRiskCabin.z;
    } else {
      this.atRiskTarget = null;
    }

    let chosenSet = worstRiskCabin ? this.terrain.settlements[worstRiskCabin.settlementIdx] || null : null;
    if (!chosenSet) {
      for (let s = 0; s < this.terrain.settlements.length; s++) {
        const stObj = this.terrain.settlements[s];
        let hasAlive = false;
        for (let k = 0; k < stObj.cabins.length; k++) {
          if (this.cabinHp[stObj.cabins[k].id] > 0) {
            hasAlive = true;
            break;
          }
        }
        if (hasAlive) {
          chosenSet = stObj;
          break;
        }
      }
    }
    this.settlementTarget = chosenSet
      ? { x: chosenSet.x, z: chosenSet.z, name: chosenSet.name }
      : null;

    const invGs8 = 8 / gs;
    for (let a = 0; a < this.activeCount; a++) {
      const idx = this.activeList[a];
      const st = cells[idx];
      if (st === CELL_STATE.EMBER_WARN) {
        embers++;
        continue;
      }
      if (st < 1 || st > 12) continue;

      burning++;
      const gx = idx % gs;
      const gz = (idx - gx) / gs;
      const wx = (gx + 0.5) * cellSize - halfWorld;
      const wz = (gz + 0.5) * cellSize - halfWorld;
      const wy = cellHeights[idx];

      const dxSet = wx - primarySetX;
      const dzSet = wz - primarySetZ;
      const dToSet = Math.sqrt(dxSet * dxSet + dzSet * dzSet);
      const w = st * (1.0 + 300.0 / (dToSet + 120.0));
      headSumX += wx * w;
      headSumZ += wz * w;
      headWeight += w;

      const bx = (gx * invGs8) | 0;
      const bz = (gz * invGs8) | 0;
      const bin = bz * 8 + bx;
      this._binWeight[bin] += st;
      this._binSumX[bin] += wx * st;
      this._binSumZ[bin] += wz * st;
      this._binSumY[bin] += wy * st;
      this._binCount[bin]++;
    }

    this.burningCount = burning;
    this.emberCount = embers;
    this.burningPct = (burning / this.totalFlammable) * 100;

    // Select top 6 macro-bins prioritized by intensity + proximity to threatened settlement
    this._binUsed.fill(0);
    const hot = [];
    let primaryBin = -1;
    for (let pick = 0; pick < 6; pick++) {
      let bestBin = -1;
      let bestScore = 0;
      for (let b = 0; b < 64; b++) {
        const bw = this._binWeight[b];
        if (this._binUsed[b] !== 0 || bw <= 0) continue;
        const bx = this._binSumX[b] / bw;
        const bz = this._binSumZ[b] / bw;
        const dSet = Math.hypot(bx - primarySetX, bz - primarySetZ);
        const threatScore = bw * (1.0 + 360.0 / (dSet + 120.0));
        if (threatScore > bestScore) {
          bestScore = threatScore;
          bestBin = b;
        }
      }
      if (bestBin === -1) break;
      if (pick === 0) primaryBin = bestBin;
      this._binUsed[bestBin] = 1;
      const bestW = this._binWeight[bestBin];
      const cnt = this._binCount[bestBin];
      hot.push({
        x: this._binSumX[bestBin] / bestW,
        z: this._binSumZ[bestBin] / bestW,
        y: this._binSumY[bestBin] / bestW + 4,
        intensity: clamp(bestW / (cnt * 12), 0.15, 1.0) * Math.min(1.5, 0.5 + cnt * 0.08),
      });
    }
    this.hotClusters = hot;

    if (primaryBin >= 0) {
      // Snap fireHead onto an ACTUAL burning cell in the primary cluster (closest to centroid
      // biased toward settlement) so fireHead NEVER sits inside an extinguished donut hole!
      const cx = hot[0].x;
      const cz = hot[0].z;
      let bestCellX = cx;
      let bestCellZ = cz;
      let bestCellScore = Infinity;
      for (let a = 0; a < this.activeCount; a++) {
        const idx = this.activeList[a];
        const st = cells[idx];
        if (st < 1 || st > 12) continue;
        const gx = idx % gs;
        const gz = (idx - gx) / gs;
        const bx = (gx * invGs8) | 0;
        const bz = (gz * invGs8) | 0;
        if (bz * 8 + bx !== primaryBin) continue;
        const wx = (gx + 0.5) * cellSize - halfWorld;
        const wz = (gz + 0.5) * cellSize - halfWorld;
        // Prefer burning cells near the hot core & facing the threatened settlement
        const dCore = Math.hypot(wx - cx, wz - cz);
        const dSet = Math.hypot(wx - primarySetX, wz - primarySetZ);
        const score = dCore * 0.65 + dSet * 0.35 - st * 1.5;
        if (score < bestCellScore) {
          bestCellScore = score;
          bestCellX = wx;
          bestCellZ = wz;
        }
      }
      this.fireHead = { x: bestCellX, z: bestCellZ };
    } else if (headWeight > 0) {
      this.fireHead = { x: headSumX / headWeight, z: headSumZ / headWeight };
    } else if (embers > 0) {
      for (let a = 0; a < this.activeCount; a++) {
        const idx = this.activeList[a];
        if (cells[idx] === CELL_STATE.EMBER_WARN) {
          const gx = idx % gs;
          const gz = (idx - gx) / gs;
          this.fireHead = this.terrain.gridToWorld(gx, gz);
          break;
        }
      }
    } else {
      this.fireHead = null;
    }
  }

  /**
   * Sample fire-driven atmospheric conditions at world position (x, y, z):
   * downwind tilted smoke plumes, rising convective thermal columns, aerodynamic turbulence,
   * and dangerously low-altitude radiant/flame heat.
   * Fast O(1) zero-GC grid lookup — works identically on Host and Replica.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {{ smokeDensity: number, thermalLift: number, turbulence: number, heatDanger: number }}
   */
  sampleFireAtmosphere(x, y, z) {
    if (this.burningCount <= 0) {
      return { smokeDensity: 0, thermalLift: 0, turbulence: 0, heatDanger: 0 };
    }
    const groundY = this._sampleGroundY(x, z);
    const h = Math.max(0, y - groundY);
    if (h > 195) {
      return { smokeDensity: 0, thermalLift: 0, turbulence: 0, heatDanger: 0 };
    }

    const gs = this.gridSize;
    const cs = this.cellSize;
    const halfWorld = this._halfWorld;
    const cells = this.cells;
    const cellHeights = this.terrain.cellHeights;
    const wvx = this.windVx;
    const wvz = this.windVz;

    // 1. Convective thermal updraft column (tilts gently downwind with height) + low-flame heat danger
    const tTherm = h / 18.0;
    const thermSrcX = x - wvx * tTherm;
    const thermSrcZ = z - wvz * tTherm;
    const rTherm = 26.0 + h * 0.22;
    const invTwoRThermSq = 1.0 / (2.0 * rTherm * rTherm);
    const thermVertEnv = h < 135
      ? Math.min(1.0, (h + 10.0) / 22.0) * (1.0 - Math.max(0, (h - 40.0) / 95.0))
      : 0;

    let thermalEnergy = 0;
    let heatEnergy = 0;

    const tCgx = Math.floor((thermSrcX + halfWorld) * this._invCellSize);
    const tCgz = Math.floor((thermSrcZ + halfWorld) * this._invCellSize);
    const tWin = 3;
    const tMinGz = Math.max(0, tCgz - tWin);
    const tMaxGz = Math.min(gs - 1, tCgz + tWin);
    const tMinGx = Math.max(0, tCgx - tWin);
    const tMaxGx = Math.min(gs - 1, tCgx + tWin);

    for (let gz = tMinGz; gz <= tMaxGz; gz++) {
      const wz = (gz + 0.5) * cs - halfWorld;
      const dzT = wz - thermSrcZ;
      const dzDirect = wz - z;
      const rowBase = gz * gs;
      for (let gx = tMinGx; gx <= tMaxGx; gx++) {
        const idx = rowBase + gx;
        const st = cells[idx];
        if (st < 1 || st > 12) continue;
        const iNorm = st / 12.0;
        const wx = (gx + 0.5) * cs - halfWorld;

        if (thermVertEnv > 0) {
          const dxT = wx - thermSrcX;
          const dSqT = dxT * dxT + dzT * dzT;
          thermalEnergy += iNorm * Math.exp(-dSqT * invTwoRThermSq) * thermVertEnv;
        }

        const cellH = Math.max(0, y - cellHeights[idx]);
        if (cellH < 22.0) {
          const dxD = wx - x;
          const dSqD = dxD * dxD + dzDirect * dzDirect;
          if (dSqD < 26.0 * 26.0) {
            const altFactor = clamp((22.0 - cellH) / 14.0, 0, 1);
            const radFactor = 1.0 - Math.sqrt(dSqD) / 26.0;
            heatEnergy += iNorm * altFactor * radFactor;
          }
        }
      }
    }

    // 2. Downwind tilted smoke plume (2 bands: rising core plume + trailing downwind smoke deck)
    let smokeEnergy = 0;
    const smokeVertEnv = h >= 4.0 && h < 185.0
      ? Math.min(1.0, (h - 2.0) / 16.0) * (1.0 - Math.max(0, (h - 75.0) / 110.0))
      : 0;

    if (smokeVertEnv > 0) {
      const tRise = h / 13.0;
      const rSmoke = 28.0 + h * 0.34;
      const invTwoRSmokeSq = 1.0 / (2.0 * rSmoke * rSmoke);
      const sWin = 4;

      for (let band = 0; band < 2; band++) {
        const driftMult = band === 0 ? 0.90 : 1.55;
        const bandWeight = band === 0 ? 1.0 : 0.62;
        const srcX = x - wvx * driftMult * tRise;
        const srcZ = z - wvz * driftMult * tRise;
        const sCgx = Math.floor((srcX + halfWorld) * this._invCellSize);
        const sCgz = Math.floor((srcZ + halfWorld) * this._invCellSize);
        const sMinGz = Math.max(0, sCgz - sWin);
        const sMaxGz = Math.min(gs - 1, sCgz + sWin);
        const sMinGx = Math.max(0, sCgx - sWin);
        const sMaxGx = Math.min(gs - 1, sCgx + sWin);

        for (let gz = sMinGz; gz <= sMaxGz; gz++) {
          const wz = (gz + 0.5) * cs - halfWorld;
          const dzS = wz - srcZ;
          const dzSqS = dzS * dzS;
          const rowBase = gz * gs;
          for (let gx = sMinGx; gx <= sMaxGx; gx++) {
            const st = cells[rowBase + gx];
            if (st < 1 || st > 12) continue;
            const wx = (gx + 0.5) * cs - halfWorld;
            const dxS = wx - srcX;
            const dSqS = dxS * dxS + dzSqS;
            smokeEnergy += (st / 12.0) * bandWeight * Math.exp(-dSqS * invTwoRSmokeSq) * smokeVertEnv;
          }
        }
      }
    }

    const smokeDensity = clamp(1.0 - Math.exp(-smokeEnergy * 0.42), 0, 1);
    const thermalLift = clamp(1.0 - Math.exp(-thermalEnergy * 0.58), 0, 1);
    const turbulence = clamp(
      Math.max(smokeDensity * 0.74, thermalLift * 0.90) + Math.min(smokeDensity, thermalLift) * 0.25,
      0,
      1
    );
    const heatDanger = clamp(1.0 - Math.exp(-heatEnergy * 1.15), 0, 1);

    return { smokeDensity, thermalLift, turbulence, heatDanger };
  }

  /**
   * Return current read-only snapshot matching docs/INTERFACES.md §3.
   */
  getSnapshot() {
    return {
      cells: this.cells,
      phases: this.phases,
      cabinHp: this.cabinHp,
      cabinAtRisk: this.cabinAtRisk,
      windDirDeg: this.windDirDeg,
      windSpeedKt: this.windSpeedKt,
      windVx: this.windVx,
      windVz: this.windVz,
      missionScore: this.missionScore,
      burningPct: this.burningPct,
      burningCount: this.burningCount,
      emberCount: this.emberCount,
      cabinsAlive: this.cabinsAlive,
      cabinsTotal: this.cabinsTotal,
      wave: this.wave,
      status: this.status,
      intermissionTimer: this.intermissionTimer,
      intermissionReason: this.intermissionReason,
      fireHead: this.fireHead,
      atRiskTarget: this.atRiskTarget,
      atRiskCabin: this.atRiskTarget,
      settlementTarget: this.settlementTarget,
      hotClusters: this.hotClusters,
    };
  }

  /**
   * Encode full authoritative state for MP `fireKey` snapshots.
   */
  encodeFullState() {
    return {
      cells: new Uint8Array(this.cells),
      phases: new Uint8Array(this.phases),
      cabinHp: new Uint8Array(this.cabinHp),
      cabinAtRisk: new Uint8Array(this.cabinAtRisk),
      windDirDeg: this.windDirDeg,
      windSpeedKt: this.windSpeedKt,
      wave: this.wave,
      status: this.status,
      intermissionTimer: this.intermissionTimer,
      missionScore: this.missionScore,
      slotScores: Object.fromEntries(this.slotScores),
    };
  }

  /**
   * Hydrate full fire state from an external `fireKey` snapshot (for MP replicas & zero-reset takeover).
   */
  applyExternalKey(keyState) {
    if (!keyState) return;
    if (keyState.cells && keyState.cells.length === this.cellCount) {
      this.cells.set(keyState.cells);
    }
    if (keyState.phases && keyState.phases.length === this.cellCount) {
      this.phases.set(keyState.phases);
    }

    this.activePos.fill(-1);
    this.activeCount = 0;
    this.ignitionAccum.fill(0);
    this.attrSlot.fill(-1);
    this.cellLastDropId.fill(0);

    for (let i = 0; i < this.cellCount; i++) {
      const st = this.cells[i];
      if (st >= 1 && st <= 12) {
        this.intensityF[i] = st;
        if (this.fuelRemaining[i] <= 0) this.fuelRemaining[i] = 0.7;
        this._addActive(i);
      } else if (st === CELL_STATE.WET) {
        this.intensityF[i] = 0;
        this.wetTimer[i] = Math.max(4.0, (this.phases[i] / 255) * WET_COOLDOWN_MAX || 30.0);
        this._addActive(i);
      } else if (st === CELL_STATE.EMBER_WARN) {
        this.intensityF[i] = 0;
        this.emberTimer[i] = Math.max(0.5, (1 - this.phases[i] / 255) * 4.0);
        this._addActive(i);
      } else if (st === CELL_STATE.CHARRED) {
        this.intensityF[i] = 0;
        this.fuelRemaining[i] = 0;
      } else {
        this.intensityF[i] = 0;
      }
    }

    if (keyState.cabinHp) {
      const n = Math.min(this.cabinsTotal, keyState.cabinHp.length);
      let alive = 0;
      for (let c = 0; c < n; c++) {
        this.cabinHp[c] = keyState.cabinHp[c];
        this.cabinHpF[c] = keyState.cabinHp[c];
        if (this.cabinHp[c] > 0) alive++;
      }
      this.cabinsAlive = alive;
    }
    if (keyState.cabinAtRisk) {
      const n = Math.min(this.cabinsTotal, keyState.cabinAtRisk.length);
      for (let c = 0; c < n; c++) this.cabinAtRisk[c] = keyState.cabinAtRisk[c];
    }

    if (typeof keyState.windDirDeg === 'number') {
      this.windDirDeg = keyState.windDirDeg;
      this.baseWindDirDeg = keyState.windDirDeg;
      this._lastReportedWindDir = keyState.windDirDeg;
    }
    if (typeof keyState.windSpeedKt === 'number') {
      this.windSpeedKt = keyState.windSpeedKt;
      this.baseWindSpeedKt = keyState.windSpeedKt;
      this._lastReportedWindSpeed = keyState.windSpeedKt;
    }
    this._updateWindVector();

    if (typeof keyState.wave === 'number') this.wave = keyState.wave;
    if (typeof keyState.status === 'string') this.status = keyState.status;
    if (typeof keyState.intermissionTimer === 'number') this.intermissionTimer = keyState.intermissionTimer;
    if (typeof keyState.intermissionReason === 'string' || keyState.intermissionReason === null) {
      this.intermissionReason = keyState.intermissionReason;
    } else if (this.status === 'intermission') {
      this.intermissionReason = this.cabinsTotal > 0 && this.cabinsAlive === 0 ? 'overrun' : 'contained';
    } else {
      this.intermissionReason = null;
    }
    if (typeof keyState.missionScore === 'number') this.missionScore = keyState.missionScore;

    if (keyState.slotScores) {
      this.slotScores.clear();
      if (keyState.slotScores instanceof Map) {
        for (const [k, v] of keyState.slotScores) this.slotScores.set(Number(k), Number(v));
      } else if (Array.isArray(keyState.slotScores)) {
        for (const [k, v] of keyState.slotScores) this.slotScores.set(Number(k), Number(v));
      } else {
        for (const [k, v] of Object.entries(keyState.slotScores)) this.slotScores.set(Number(k), Number(v));
      }
    }

    this._updateReplicaCabinRisk(false);
    this._recomputeMetricsAndTargets();
  }

  /**
   * Apply incremental `fireRing` delta on an MP replica.
   * Mirrors remote drop outcomes (`delta.dropOutcomes` or compact `delta.o`) and tactical world events cleanly!
   */
  applyExternalDelta(delta) {
    if (!delta) return [];
    const dirtyIndices = [];
    const prevStatus = this.status;

    const cellList = delta.changedCells || delta.cells || [];
    for (let i = 0; i < cellList.length; i++) {
      const item = cellList[i];
      const idx = item.idx;
      if (idx < 0 || idx >= this.cellCount) continue;
      const st = item.state;
      this.cells[idx] = st;
      if (typeof item.phase === 'number') this.phases[idx] = item.phase;

      if (st >= 1 && st <= 12) {
        this.intensityF[idx] = st;
        this._addActive(idx);
      } else if (st === CELL_STATE.WET) {
        this.intensityF[idx] = 0;
        this.wetTimer[idx] = 31.0;
        this._addActive(idx);
      } else if (st === CELL_STATE.EMBER_WARN) {
        this.intensityF[idx] = 0;
        this.emberTimer[idx] = 4.0;
        this._addActive(idx);
      } else {
        this.intensityF[idx] = 0;
        if (st === CELL_STATE.CHARRED) this.fuelRemaining[idx] = 0;
        this._removeActive(idx);
      }
      dirtyIndices.push(idx);
    }

    const cabList = delta.cabinChanges || delta.c || [];
    for (let i = 0; i < cabList.length; i++) {
      const entry = cabList[i];
      const id = Array.isArray(entry) ? entry[0] : entry.id;
      const hp = Array.isArray(entry) ? entry[1] : entry.hp;
      if (id >= 0 && id < this.cabinsTotal) {
        this.cabinHp[id] = hp;
        this.cabinHpF[id] = hp;
      }
    }
    let alive = 0;
    for (let c = 0; c < this.cabinsTotal; c++) {
      if (this.cabinHp[c] > 0) alive++;
    }
    this.cabinsAlive = alive;

    if (typeof delta.windDirDeg === 'number') this.windDirDeg = delta.windDirDeg;
    if (typeof delta.windSpeedKt === 'number') this.windSpeedKt = delta.windSpeedKt;
    if (typeof delta.windDirDeg === 'number' || typeof delta.windSpeedKt === 'number') {
      this._updateWindVector();
      this._checkWindShiftEvent(0.5);
    }

    if (typeof delta.missionScore === 'number') this.missionScore = delta.missionScore;
    else if (typeof delta.ms === 'number') this.missionScore = delta.ms;

    if (typeof delta.wave === 'number') this.wave = delta.wave;
    if (typeof delta.status === 'string') this.status = delta.status;
    if (typeof delta.intermissionTimer === 'number') this.intermissionTimer = delta.intermissionTimer;
    if (typeof delta.intermissionReason === 'string' || delta.intermissionReason === null) {
      this.intermissionReason = delta.intermissionReason;
    } else if (this.status === 'intermission') {
      this.intermissionReason = this.cabinsTotal > 0 && this.cabinsAlive === 0 ? 'overrun' : 'contained';
    } else if (typeof delta.status === 'string') {
      this.intermissionReason = null;
    }

    const hits = delta.scoreEvents || delta.h || [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const sid = Array.isArray(h) ? h[0] : h.slotId;
      const pts = Array.isArray(h) ? h[1] : h.pts;
      if (typeof sid === 'number' && typeof pts === 'number') {
        this.slotScores.set(sid, (this.slotScores.get(sid) || 0) + pts);
      }
    }

    // Mirror synced Drop Outcome Events from Host fireRing delta onto replica queue
    const outcomes = delta.dropOutcomes || delta.o || null;
    if (Array.isArray(outcomes) && outcomes.length > 0) {
      for (let i = 0; i < outcomes.length; i++) {
        const norm = normalizeExternalOutcome(outcomes[i]);
        if (norm) this._emitDropOutcome(norm);
      }
    }

    this._updateReplicaCabinRisk(true);
    this._recomputeMetricsAndTargets();

    // Emit replica fire_contained world event on transition out of active
    if (
      prevStatus === 'active' &&
      (this.status === 'victory' || (this.status === 'intermission' && this.burningCount === 0))
    ) {
      const opCfg = this.terrain.opConfig;
      this._emitWorldEvent({
        type: 'fire_contained',
        opId: opCfg?.id || 'op01',
        opIndex: typeof opCfg?.opIndex === 'number' ? opCfg.opIndex : 0,
        wave: this.wave,
        missionScore: this.missionScore,
        cabinsAlive: this.cabinsAlive,
        cabinsTotal: this.cabinsTotal,
      });
    }

    return dirtyIndices;
  }

  _updateReplicaCabinRisk(emitEvents = false) {
    const gs = this.gridSize;
    const cellSize = this.cellSize;
    const halfWorld = this.terrain.halfWorld;
    const riskRadiusSq = 48 * 48;
    const rCells = Math.ceil(48 / cellSize);

    for (let c = 0; c < this.cabinsTotal; c++) {
      if (this.cabinHp[c] <= 0) {
        this.cabinAtRisk[c] = 0;
        continue;
      }
      const cab = this.terrain.cabins[c];
      const cgx = this._cabinGx[c];
      const cgz = this._cabinGz[c];
      let risk = 0;
      for (let dz = -rCells; dz <= rCells && !risk; dz++) {
        const gz = cgz + dz;
        if (gz < 0 || gz >= gs) continue;
        for (let dx = -rCells; dx <= rCells; dx++) {
          const gx = cgx + dx;
          if (gx < 0 || gx >= gs) continue;
          const st = this.cells[gz * gs + gx];
          if ((st >= 1 && st <= 12) || st === CELL_STATE.EMBER_WARN) {
            const wx = (gx + 0.5) * cellSize - halfWorld;
            const wz = (gz + 0.5) * cellSize - halfWorld;
            if ((wx - cab.x) * (wx - cab.x) + (wz - cab.z) * (wz - cab.z) <= riskRadiusSq) {
              risk = 1;
              break;
            }
          }
        }
      }
      this.cabinAtRisk[c] = risk;
    }

    if (emitEvents) {
      this._emitCabinRiskTransitions(0.5);
    } else {
      // Seed baseline settlement risk without firing spurious alerts on initial hydration
      const settlements = this.terrain.settlements || [];
      for (let s = 0; s < settlements.length; s++) {
        let anyRisk = 0;
        for (let k = 0; k < settlements[s].cabins.length; k++) {
          const cid = settlements[s].cabins[k].id;
          if (this.cabinHp[cid] > 0 && this.cabinAtRisk[cid] === 1) {
            anyRisk = 1;
            break;
          }
        }
        this._settlementAtRisk[s] = anyRisk;
      }
    }
  }

  /**
   * Return a copy of per-slot accumulated scores.
   * @returns {Map<number, number>}
   */
  getSlotScores() {
    return new Map(this.slotScores);
  }
}
