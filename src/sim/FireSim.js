/**
 * EMBER FRONT — 10 Hz 4-Bit Cellular Wildfire Simulation
 * Supports both Solo Operations (128x128 @ 16m) and 100-Pilot Mega-Basin (160x160 @ 20m).
 * Engineered with flat typed arrays and sparse active sets for p99 < 2.0 ms at 100 pilots.
 * Pure simulation module — zero DOM / Three.js dependencies.
 */

import { createRng } from './TerrainGen.js';
import { FLIGHT_CONSTANTS } from './FlightModel.js';

const DEG2RAD = Math.PI / 180;
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

// 8-way Moore neighborhood offsets
const NBR_DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NBR_DZ = [-1, -1, -1, 0, 0, 1, 1, 1];
const NBR_DIST = [Math.SQRT2, 1, Math.SQRT2, 1, 1, Math.SQRT2, 1, Math.SQRT2];
const NBR_UX = NBR_DX.map((dx, i) => dx / NBR_DIST[i]);
const NBR_UZ = NBR_DZ.map((dz, i) => dz / NBR_DIST[i]);

const MAX_PARCELS = 4096;
const ATTR_SLOTS_PER_CELL = 8; // Zero-GC fixed per-cell 3s attribution ring

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export class FireSim {
  /**
   * @param {import('./TerrainGen.js').TerrainData} terrain
   * @param {{ isMegaBasin?: boolean }} [opts]
   */
  constructor(terrain, { isMegaBasin = false } = {}) {
    this.terrain = terrain;
    this.isMegaBasin = Boolean(isMegaBasin || terrain.opConfig?.mode === 'megabasin');
    this.gridSize = terrain.gridSize;
    this.cellSize = terrain.cellSize;
    this.cellCount = this.gridSize * this.gridSize;

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

    // Cabin state
    const nCabins = terrain.cabins.length;
    this.cabinsTotal = nCabins;
    this.cabinHp = new Uint8Array(nCabins);
    this.cabinHpF = new Float32Array(nCabins);
    this.cabinAtRisk = new Uint8Array(nCabins);
    this.cabinThreatTime = new Float32Array(nCabins);
    this.cabinSavedCooldown = new Float32Array(nCabins);
    this.cabinLastHelperSlot = new Int16Array(nCabins);
    // Precompute cabin grid coordinates for fast inner loop
    this._cabinGx = new Int16Array(nCabins);
    this._cabinGz = new Int16Array(nCabins);
    for (let c = 0; c < nCabins; c++) {
      const g = terrain.worldToGrid(terrain.cabins[c].x, terrain.cabins[c].z);
      this._cabinGx[c] = g.gx;
      this._cabinGz[c] = g.gz;
    }

    // Fixed-size struct-of-arrays pool for ballistic water parcels
    this.parcelCount = 0;
    this.parcelSlot = new Int16Array(MAX_PARCELS);
    this.parcelX = new Float32Array(MAX_PARCELS);
    this.parcelY = new Float32Array(MAX_PARCELS);
    this.parcelZ = new Float32Array(MAX_PARCELS);
    this.parcelVx = new Float32Array(MAX_PARCELS);
    this.parcelVy = new Float32Array(MAX_PARCELS);
    this.parcelVz = new Float32Array(MAX_PARCELS);
    this.parcelReleaseAgl = new Float32Array(MAX_PARCELS);

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
  }

  /**
   * Reset fire simulation for a given wave (wave 1 resets score; wave > 1 in Mega-Basin preserves score).
   */
  reset(wave = 1) {
    this.wave = wave;
    const preserveScores = this.isMegaBasin && wave > 1;
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
    this.activePos.fill(-1);
    this.activeCount = 0;
    this.attrSlot.fill(-1);
    this.parcelCount = 0;
    this.simTime = 0;
    this.emberSpotAccum = 0;
    this.status = 'active';
    this.intermissionTimer = 0;
    this.intermissionReason = null;

    // Initialize fuel & per-cell burn duration (120..180 s)
    for (let i = 0; i < this.cellCount; i++) {
      if (this.terrain.fuelMask[i] === 1) {
        this.fuelRemaining[i] = 1.0;
        this.burnDuration[i] = 120 + this.rng() * 60;
      } else {
        this.fuelRemaining[i] = 0;
        this.burnDuration[i] = 150;
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

    // Wind base & peak gust amplitude (supports both peak-knot configs like 12->14 and delta configs)
    const baseDir = this.terrain.opConfig?.windDirDeg ?? 90;
    const waveRot = this.isMegaBasin ? ((wave - 1) * 55) % 360 : 0;
    this.baseWindDirDeg = (baseDir + waveRot + 360) % 360;
    this.baseWindSpeedKt = this.terrain.opConfig?.windSpeedKt ?? 12;
    const rawGust = this.terrain.opConfig?.windGustKt;
    this.windGustAmpKt =
      typeof rawGust === 'number'
        ? rawGust > this.baseWindSpeedKt
          ? rawGust - this.baseWindSpeedKt
          : Math.max(0, Math.min(rawGust, 6))
        : 2;
    this.windDirDeg = this.baseWindDirDeg;
    this.windSpeedKt = this.baseWindSpeedKt;
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

    this._updateReplicaCabinRisk();
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
        if (d > radius + (this.rng() - 0.5) * 1.4) continue;
        const idx = gz * gs + gx;
        if (this.terrain.fuelMask[idx] !== 1 || this.terrain.waterMask[idx] === 1) continue;

        const norm = clamp(1 - d / (radius + 0.5), 0.15, 1.0);
        const initInt = clamp(2 + norm * 8 + (this.rng() - 0.5) * 2, 2, 11);
        this.intensityF[idx] = initInt;
        this.cells[idx] = Math.round(initInt);
        this.phases[idx] = Math.floor(this.rng() * 255);
        this._addActive(idx);
      }
    }
  }

  /**
   * Spawn a ballistic water drop parcel (called at ~10 Hz per releasing aircraft).
   */
  spawnWaterParcel(slotId, x, y, z, vx, vy, vz, releaseAgl) {
    if (this.parcelCount >= MAX_PARCELS) return;
    const i = this.parcelCount++;
    this.parcelSlot[i] = slotId ?? 0;
    this.parcelX[i] = x;
    this.parcelY[i] = y;
    this.parcelZ[i] = z;
    this.parcelVx[i] = vx;
    this.parcelVy[i] = vy;
    this.parcelVz[i] = vz;
    this.parcelReleaseAgl[i] = Math.max(0, releaseAgl ?? 35);
  }

  _recordWet(idx, slotId, amount, isActiveFire) {
    if (amount <= 0) return;
    if (this.wetDirtyFlags[idx] === 0) {
      this.wetDirtyFlags[idx] = 1;
      this.wetDirtyList[this.wetDirtyCount++] = idx;
    }
    this.wetDelta[idx] += amount;

    // Only track 3.0 s attribution for burning / ember-warning cells (zero overhead on wet/intact cells)
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
   */
  _applyWaterSplash(slotId, x, z, releaseAgl) {
    const R = clamp(14 + 0.22 * releaseAgl, 16, 42);
    const K0 = 4.6;
    const knockdown = K0 * Math.pow(24 / R, 1.35);

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
        const falloff = 1.0 - 0.6 * (dSq / rSq);
        this._recordWet(idx, slotId, knockdown * falloff, isFire);
        if (isFire) hitActiveFire = true;
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

  /**
   * Advance the wildfire simulation by `dt` seconds (designed for 10 Hz, dt = 0.1 s).
   */
  step(dt = 0.1, activeManualPilots = 1) {
    const dtSafe = Math.max(0.001, Math.min(dt, 0.25));
    this.simTime += dtSafe;

    const changedCells = [];
    const cabinChanges = [];
    const scoreEvents = [];
    const impactEvents = [];
    this._changedCount = 0;

    // 1. Update smoothly gusting wind vector (baseWindSpeedKt .. baseWindSpeedKt + windGustAmpKt)
    const dirShift = Math.sin(this.simTime * 0.045) * 14 + Math.sin(this.simTime * 0.11) * 6;
    const gustWave = 0.5 + 0.5 * (Math.sin(this.simTime * 0.19) * 0.65 + Math.cos(this.simTime * 0.07) * 0.35);
    this.windDirDeg = ((this.baseWindDirDeg + dirShift) % 360 + 360) % 360;
    this.windSpeedKt = Math.max(4, this.baseWindSpeedKt + gustWave * this.windGustAmpKt);
    this._updateWindVector();

    // Handle Mega-Basin intermission countdown
    if (this.status === 'intermission') {
      this.intermissionTimer = Math.max(0, this.intermissionTimer - dtSafe);
      let fullReset = false;
      if (this.intermissionTimer <= 0) {
        this.reset(this.wave + 1);
        fullReset = true;
        for (let c = 0; c < this.cabinsTotal; c++) {
          cabinChanges.push({ id: c, hp: this.cabinHp[c] });
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
        wave: this.wave,
        fullReset,
      };
    }

    // 2. Step ballistic water parcels
    this._stepParcels(dtSafe, impactEvents);

    // 3. Apply accumulated conflict-free wetDelta to touched cells
    this._applyWetDeltas(scoreEvents);

    // 4. Cellular wildfire dynamics, ember spotting, and cabins
    if (this.status === 'active') {
      this._stepCellular(dtSafe, activeManualPilots);
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

    // 8. Recompute counts, burningPct, hotClusters, fireHead, targets, and win/loss
    this._recomputeMetricsAndTargets();

    if (this.status === 'active') {
      if (this.burningCount === 0 && this.emberCount === 0) {
        if (this.isMegaBasin) {
          this.status = 'intermission';
          this.intermissionReason = 'contained';
          this.intermissionTimer = 15.0;
          this.missionScore += SCORE.WAVE_CONTAINED;
        } else {
          this.status = 'victory';
        }
      } else if (this.cabinsTotal > 0 && this.cabinsAlive === 0) {
        if (this.isMegaBasin) {
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
      wave: this.wave,
      fullReset: false,
    };
  }

  _stepParcels(dtSafe, impactEvents) {
    const awx = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * this.windVx;
    const awz = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * this.windVz;
    const g = FLIGHT_CONSTANTS.DROP_GRAVITY;
    const halfDt = 0.5 * dtSafe;

    for (let i = this.parcelCount - 1; i >= 0; i--) {
      const vx0 = this.parcelVx[i];
      const vy0 = this.parcelVy[i];
      const vz0 = this.parcelVz[i];

      const vx1 = vx0 + awx * dtSafe;
      const vy1 = vy0 - g * dtSafe;
      const vz1 = vz0 + awz * dtSafe;

      const nx = this.parcelX[i] + (vx0 + vx1) * halfDt;
      const ny = this.parcelY[i] + (vy0 + vy1) * halfDt;
      const nz = this.parcelZ[i] + (vz0 + vz1) * halfDt;

      this.parcelVx[i] = vx1;
      this.parcelVy[i] = vy1;
      this.parcelVz[i] = vz1;
      this.parcelX[i] = nx;
      this.parcelY[i] = ny;
      this.parcelZ[i] = nz;

      const groundY = this._sampleGroundY(nx, nz);
      if (ny <= groundY) {
        const hitFire = this._applyWaterSplash(this.parcelSlot[i], nx, nz, this.parcelReleaseAgl[i]);
        impactEvents.push({ x: nx, y: groundY, z: nz, extinguished: hitFire });

        const last = --this.parcelCount;
        if (i !== last) {
          this.parcelSlot[i] = this.parcelSlot[last];
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

    for (let d = 0; d < count; d++) {
      const idx = list[d];
      const wet = wetDelta[idx];
      wetDelta[idx] = 0;
      wetDirtyFlags[idx] = 0;

      const st = cells[idx];
      if (st >= 1 && st <= 12) {
        const nextI = intensityF[idx] - wet;
        intensityF[idx] = nextI;
        if (nextI <= 0.4) {
          intensityF[idx] = 0;
          cells[idx] = CELL_STATE.WET;
          this.wetTimer[idx] = 15.0 + this.rng() * 5.0;
          this.phases[idx] = 255;
          this.ignitionAccum[idx] = 0;
          this._addActive(idx);
          this._markChanged(idx);
          this._awardExtinguishAttribution(idx, scoreEvents);
        } else {
          const q = clamp(Math.round(nextI), 1, 12);
          if (q !== st) {
            cells[idx] = q;
            this._markChanged(idx);
          }
        }
      } else if (st === CELL_STATE.EMBER_WARN) {
        if (wet >= 0.8) {
          cells[idx] = CELL_STATE.WET;
          this.emberTimer[idx] = 0;
          this.wetTimer[idx] = 15.0 + this.rng() * 5.0;
          this.phases[idx] = 255;
          this._addActive(idx);
          this._markChanged(idx);
          this._awardExtinguishAttribution(idx, scoreEvents);
        }
      } else if (st === CELL_STATE.INTACT && fuelMask[idx] === 1) {
        if (wet >= 1.6) {
          cells[idx] = CELL_STATE.WET;
          this.wetTimer[idx] = 15.0 + this.rng() * 5.0;
          this.ignitionAccum[idx] = 0;
          this.phases[idx] = 255;
          this._addActive(idx);
          this._markChanged(idx);
        }
      } else if (st === CELL_STATE.WET) {
        this.wetTimer[idx] = Math.min(20.0, this.wetTimer[idx] + wet * 1.5);
      }
    }
    this.wetDirtyCount = 0;
  }

  _tryEmberSpot(spotCandidateIdx, wHatX, wHatZ, pilotScale, dtSafe) {
    const spotRate = (this.isMegaBasin ? 0.02 : 0.012) * pilotScale;
    this.emberSpotAccum += spotRate * dtSafe;
    if (this.emberSpotAccum < 1.0) return;
    this.emberSpotAccum -= 1.0;

    const gs = this.gridSize;
    const sgx = spotCandidateIdx % gs;
    const sgz = (spotCandidateIdx - sgx) / gs;
    const jumpCells = 3 + Math.floor(this.rng() * 6);
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
    const pilotScale = this.isMegaBasin
      ? 1.0 + 0.55 * Math.log(1 + Math.max(0, activeManualPilots))
      : 1.0;

    const baseSpreadDt = 0.068 * pilotScale * dtSafe;
    const fuelMask = this.terrain.fuelMask;
    const cellHeights = this.terrain.cellHeights;
    const cells = this.cells;
    const intensityF = this.intensityF;
    const fuelRem = this.fuelRemaining;
    const burnDur = this.burnDuration;
    const ignAccum = this.ignitionAccum;

    const nbrWindFactor = this._nbrWindFactor;
    for (let n = 0; n < 8; n++) {
      const dotW = NBR_UX[n] * wHatX + NBR_UZ[n] * wHatZ;
      nbrWindFactor[n] = (1.0 + 1.8 * (dotW > 0 ? dotW : 0) * windSpeedScale) / NBR_DIST[n];
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
          ? Math.min(12.0, curInt + 0.8 * dtSafe)
          : Math.max(1.0, curInt - 1.5 * dtSafe);
        intensityF[idx] = nextInt;

        const q = clamp(Math.round(nextInt), 1, 12);
        if (q !== st) {
          cells[idx] = q;
          this._markChanged(idx);
        }

        if (q >= 7 && this.rng() < 0.04) {
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
          const uphillBoost = dh > 0 ? 1.0 + 1.2 * ((dh * invCellSize) / NBR_DIST[n]) : 1.0;

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
        this.phases[idx] = clamp(Math.round((nextW / 20.0) * 255), 0, 255);
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
        const nextH = ignAccum[idx] - 0.015 * dtSafe;
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

    if (windSpeedKt >= 14 && spotCandidateIdx >= 0) {
      this._tryEmberSpot(spotCandidateIdx, wHatX, wHatZ, pilotScale, dtSafe);
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
              dmgRate += 0.9 * (st / 12.0);
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

    if (headWeight > 0) {
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

    // Select top 6 macro-bins without allocating/sorting 64 temporary objects
    this._binUsed.fill(0);
    const hot = [];
    for (let pick = 0; pick < 6; pick++) {
      let bestBin = -1;
      let bestW = 0;
      for (let b = 0; b < 64; b++) {
        if (this._binUsed[b] === 0 && this._binWeight[b] > bestW) {
          bestW = this._binWeight[b];
          bestBin = b;
        }
      }
      if (bestBin === -1) break;
      this._binUsed[bestBin] = 1;
      const cnt = this._binCount[bestBin];
      hot.push({
        x: this._binSumX[bestBin] / bestW,
        z: this._binSumZ[bestBin] / bestW,
        y: this._binSumY[bestBin] / bestW + 4,
        intensity: clamp(bestW / (cnt * 12), 0.15, 1.0) * Math.min(1.5, 0.5 + cnt * 0.08),
      });
    }
    this.hotClusters = hot;
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

    for (let i = 0; i < this.cellCount; i++) {
      const st = this.cells[i];
      if (st >= 1 && st <= 12) {
        this.intensityF[i] = st;
        if (this.fuelRemaining[i] <= 0) this.fuelRemaining[i] = 0.7;
        this._addActive(i);
      } else if (st === CELL_STATE.WET) {
        this.intensityF[i] = 0;
        this.wetTimer[i] = Math.max(2.0, (this.phases[i] / 255) * 18.0 || 12.0);
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
    }
    if (typeof keyState.windSpeedKt === 'number') {
      this.windSpeedKt = keyState.windSpeedKt;
      this.baseWindSpeedKt = keyState.windSpeedKt;
    }
    this._updateWindVector();

    if (typeof keyState.wave === 'number') this.wave = keyState.wave;
    if (typeof keyState.status === 'string') this.status = keyState.status;
    if (typeof keyState.intermissionTimer === 'number') this.intermissionTimer = keyState.intermissionTimer;
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

    this._updateReplicaCabinRisk();
    this._recomputeMetricsAndTargets();
  }

  /**
   * Apply incremental `fireRing` delta on an MP replica.
   */
  applyExternalDelta(delta) {
    if (!delta) return [];
    const dirtyIndices = [];

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
        this.wetTimer[idx] = 16.0;
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
    }

    if (typeof delta.missionScore === 'number') this.missionScore = delta.missionScore;
    else if (typeof delta.ms === 'number') this.missionScore = delta.ms;

    if (typeof delta.wave === 'number') this.wave = delta.wave;
    if (typeof delta.status === 'string') this.status = delta.status;
    if (typeof delta.intermissionTimer === 'number') this.intermissionTimer = delta.intermissionTimer;

    const hits = delta.scoreEvents || delta.h || [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const sid = Array.isArray(h) ? h[0] : h.slotId;
      const pts = Array.isArray(h) ? h[1] : h.pts;
      if (typeof sid === 'number' && typeof pts === 'number') {
        this.slotScores.set(sid, (this.slotScores.get(sid) || 0) + pts);
      }
    }

    this._updateReplicaCabinRisk();
    this._recomputeMetricsAndTargets();
    return dirtyIndices;
  }

  _updateReplicaCabinRisk() {
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
  }

  /**
   * Return a copy of per-slot accumulated scores.
   * @returns {Map<number, number>}
   */
  getSlotScores() {
    return new Map(this.slotScores);
  }
}
