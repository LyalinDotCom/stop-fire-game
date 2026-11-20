import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { OPERATIONS, MEGA_BASIN_OP, WATER_LEVEL } from '../src/config/operations.js';
import { generateTerrain } from '../src/sim/TerrainGen.js';
import {
  FLIGHT_CONSTANTS,
  createAircraftState,
  stepFlight,
  predictDropImpact,
} from '../src/sim/FlightModel.js';
import { Autopilot } from '../src/sim/Autopilot.js';
import { FireSim, CELL_STATE, SCORE } from '../src/sim/FireSim.js';
import { createBackgroundTicker } from '../src/sim/BackgroundWorker.js';

const ALL_OPS = [...OPERATIONS, MEGA_BASIN_OP];

describe('TerrainGen', () => {
  it('generates all 5 Solo Operations and Mega-Basin with valid counts and zero cabins/trees in water', () => {
    for (const op of ALL_OPS) {
      const t = generateTerrain(op);
      assert.equal(t.gridSize, op.gridSize, `${op.id} gridSize`);
      assert.equal(t.cellSize, op.cellSize, `${op.id} cellSize`);
      assert.equal(t.waterLevel, WATER_LEVEL, `${op.id} waterLevel`);
      assert.equal(t.heights.length, (op.gridSize + 1) * (op.gridSize + 1));
      assert.equal(t.cellHeights.length, op.gridSize * op.gridSize);
      assert.equal(t.waterMask.length, op.gridSize * op.gridSize);
      assert.equal(t.fuelMask.length, op.gridSize * op.gridSize);
      assert.equal(t.biomeMask.length, op.gridSize * op.gridSize);

      // Exact cabin & tower counts
      assert.equal(t.cabins.length, op.cabinCount, `${op.id} cabinCount`);
      assert.equal(t.towers.length, op.towerCount, `${op.id} towerCount`);

      // Zero cabins or towers in water
      for (const c of t.cabins) {
        assert.equal(t.isWater(c.x, c.z), false, `${op.id} cabin ${c.id} must not be in water`);
        assert.ok(c.y >= t.waterLevel + 3, `${op.id} cabin ${c.id} elevation above water`);
      }
      for (const tw of t.towers) {
        assert.equal(t.isWater(tw.x, tw.z), false, `${op.id} tower ${tw.id} must not be in water`);
      }

      // Water presence & valid scoop zones
      let waterCells = 0;
      for (let i = 0; i < t.waterMask.length; i++) if (t.waterMask[i] === 1) waterCells++;
      assert.ok(waterCells > 200, `${op.id} should have substantial water body (got ${waterCells})`);
      assert.ok(t.scoopZones.length >= 1, `${op.id} must have at least 1 scoopZone`);
      for (const sz of t.scoopZones) {
        assert.equal(t.isWater(sz.x, sz.z), true, `${op.id} scoopZone ${sz.name} center must be water`);
      }

      if (op.id === 'megabasin') {
        assert.equal(t.scoopZones.length, 3, 'megabasin has 3 scoop zones');
        assert.equal(t.settlements.length, 4, 'megabasin has 4 settlements');
        assert.ok(t.trees.length >= 7000 && t.trees.length <= 10500, `megabasin tree count ${t.trees.length}`);
      } else {
        assert.ok(t.trees.length >= 3500 && t.trees.length <= 5800, `${op.id} tree count ${t.trees.length}`);
      }

      // Trees never in water and never overlapping cabins
      for (let i = 0; i < t.trees.length; i++) {
        const tr = t.trees[i];
        assert.equal(t.waterMask[tr.cellIdx], 0, `${op.id} tree ${i} in water`);
        for (let c = 0; c < t.cabins.length; c++) {
          const d = Math.hypot(tr.x - t.cabins[c].x, tr.z - t.cabins[c].z);
          assert.ok(d >= 17.5, `${op.id} tree ${i} overlaps cabin ${c} (d=${d})`);
        }
      }

      assert.ok(t.initialFireSeeds.length >= 2, `${op.id} has initial fire seeds`);
    }
  });

  it('is 100% deterministic for identical opConfig seed', () => {
    const a = generateTerrain(OPERATIONS[0]);
    const b = generateTerrain(OPERATIONS[0]);
    assert.deepEqual(a.heights, b.heights);
    assert.deepEqual(a.waterMask, b.waterMask);
    assert.deepEqual(a.cabins, b.cabins);
    assert.equal(a.trees.length, b.trees.length);
  });
});

describe('FlightModel', () => {
  const terrain = generateTerrain(OPERATIONS[0]);
  const lake = terrain.scoopZones[0];

  it('activates scoop at 4.5 m AGL over water and does NOT activate at 6.0 m AGL', () => {
    // At 6.0 m AGL -> no scoop
    const highPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 6.0,
      yawDeg: lake.headingDeg,
      pitchDeg: 0,
      tankPct: 0,
    });
    stepFlight(highPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(highPlane.scooping, false, 'should NOT activate scoop at 6.0 m AGL');

    // At 4.5 m AGL -> scoop activates
    const lowPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 4.5,
      yawDeg: lake.headingDeg,
      pitchDeg: 0,
      tankPct: 0,
    });
    const { events } = stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, true, 'should activate scoop at 4.5 m AGL');
    assert.equal(events.scoopStarted, true);

    // Hysteresis: stays scooping at 6.0 m AGL, exits at >= 6.5 m AGL
    lowPlane.y = terrain.waterLevel + 6.0;
    stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, true, 'hysteresis keeps scoop active below 6.5 m AGL');

    lowPlane.y = terrain.waterLevel + 6.7;
    const resExit = stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, false, 'exits scoop at >= 6.5 m AGL');
    assert.equal(resExit.events.scoopEnded, true);
  });

  it('fills tank 0 -> 100% in ~1.92 s with hydrodynamic drag and hydroplane cushion', () => {
    const plane = createAircraftState({
      x: lake.x,
      z: lake.z + 250,
      y: terrain.waterLevel + 4.2,
      yawDeg: 0, // North along lake
      pitchDeg: 0,
      speedKmh: FLIGHT_CONSTANTS.CRUISE_SPEED_KMH,
      tankPct: 0,
    });

    const dt = 1 / 60;
    let elapsed = 0;
    let tankFullFired = false;
    while (plane.tankPct < 100 && elapsed < 3.0) {
      // Keep nose gently level over the lake
      const { events } = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
      if (events.tankFull) tankFullFired = true;
      // Keep aircraft within lake for test duration if it nears end
      if (!terrain.isWater(plane.x, plane.z)) {
        plane.x = lake.x;
        plane.z = lake.z + 200;
      }
      plane.y = terrain.waterLevel + 4.2;
      elapsed += dt;
    }

    assert.equal(tankFullFired, true, 'tankFull event must fire');
    assert.ok(elapsed >= 1.85 && elapsed <= 2.02, `0->100% scoop took ${elapsed.toFixed(3)}s (expected ~1.92s)`);
    assert.ok(plane.speedKmh < FLIGHT_CONSTANTS.CRUISE_SPEED_KMH - 2.0, `scoop drag reduced speed to ${plane.speedKmh}`);

    // Hydroplane cushion test: diving into lake floors at waterLevel + 3.5 and levels pitch >= +2 deg
    plane.y = terrain.waterLevel + 2.0;
    plane.pitchDeg = -15;
    stepFlight(plane, { pitch: -1, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
    assert.ok(plane.y >= terrain.waterLevel + 3.5 - 1e-4, 'hydroplane cushion floor');
    assert.ok(plane.pitchDeg >= 2.0, 'hydroplane cushion levels pitch >= +2 deg');
  });

  it('drains tank 100 -> 0% in ~1.25 s and supports 0.25 s (20%) min burst on brief tap', () => {
    const dt = 1 / 60;
    const plane = createAircraftState({
      x: 100,
      z: 0,
      y: terrain.getHeight(100, 0) + 50,
      yawDeg: 90,
      tankPct: 100,
    });

    let elapsed = 0;
    while (plane.tankPct > 0 && elapsed < 2.5) {
      stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: true }, terrain, dt);
      elapsed += dt;
    }
    assert.equal(plane.tankPct, 0);
    assert.ok(elapsed >= 1.2 && elapsed <= 1.32, `100->0% drop took ${elapsed.toFixed(3)}s (expected ~1.25s)`);

    // Minimum burst test on single tap
    const tapPlane = createAircraftState({
      x: 100,
      z: 0,
      y: terrain.getHeight(100, 0) + 50,
      yawDeg: 90,
      tankPct: 100,
    });
    stepFlight(tapPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false, dropJustPressed: true }, terrain, dt);
    for (let i = 0; i < 30; i++) {
      stepFlight(tapPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false, dropJustPressed: false }, terrain, dt);
    }
    assert.ok(tapPlane.tankPct >= 78 && tapPlane.tankPct <= 82, `brief tap drained ~20% (left ${tapPlane.tankPct.toFixed(1)}%)`);
  });

  it('deflect-bounces off land without killing aircraft and predicts ballistic impact accurately', () => {
    const lx = 200;
    const lz = -100;
    const groundY = terrain.getHeight(lx, lz);
    const plane = createAircraftState({
      x: lx,
      z: lz,
      y: groundY + 3.0,
      yawDeg: 90,
      pitchDeg: -10,
      speedKmh: 160,
    });
    const { events } = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(events.bounced, true);
    assert.ok(plane.pitchDeg >= 15, 'bounce pitches nose up >= +15 deg');
    assert.ok(plane.bounceTimer > 0.35);
    assert.ok(plane.speedKmh < 145, 'bounce sheds ~15% speed');

    // Ballistic impact prediction at 47 m AGL over flat water
    const flatPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 47,
      yawDeg: 0,
      pitchDeg: 0,
      speedKmh: 158,
    });
    const pred = predictDropImpact(flatPlane, 6.0, 0, terrain);
    assert.ok(Math.abs(pred.tFall - Math.sqrt((2 * 47) / 15.5)) < 0.08, `tFall=${pred.tFall}`);
    assert.ok(pred.x > flatPlane.x + 4, 'wind drift shifts impact east');
    assert.ok(pred.radius >= 23 && pred.radius <= 26, `radius=${pred.radius}`);
  });
});

describe('Autopilot', () => {
  it('completes a full drop + scoop + climb cycle on Cinderpine Basin and scores +70 pts', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain, { isMegaBasin: false });
    const ap = new Autopilot(terrain);
    const lake = terrain.scoopZones[0];

    const plane = createAircraftState({
      x: lake.x,
      z: lake.z + 180,
      y: terrain.waterLevel + 52,
      yawDeg: 45,
      tankPct: 100,
      slotId: 7,
      autopilot: true,
    });

    const visited = new Set();
    let minTank = 100;
    let scoopedBackToFull = false;
    let climbedAfterScoop = false;
    let totalBounces = 0;

    const dt = 1 / 60;
    let simAccum = 0;
    let parcelAccum = 0;

    for (let step = 0; step < 60 * 95; step++) {
      const snap = sim.getSnapshot();
      const input = ap.update(plane, snap, dt);
      visited.add(input.phase);

      const { events } = stepFlight(plane, input, terrain, dt);
      if (events.bounced) totalBounces++;

      if (plane.tankPct < minTank) minTank = plane.tankPct;
      if (minTank < 5 && plane.tankPct >= 99) scoopedBackToFull = true;
      if (scoopedBackToFull && input.phase === 'CLIMB_OUT' && plane.agl >= 40) {
        climbedAfterScoop = true;
      }

      if (plane.releasing) {
        parcelAccum += dt;
        if (parcelAccum >= 0.1) {
          parcelAccum -= 0.1;
          sim.spawnWaterParcel(plane.slotId, plane.x, plane.y, plane.z, plane.vx, plane.vy, plane.vz, plane.agl);
        }
      } else {
        parcelAccum = 0;
      }

      simAccum += dt;
      if (simAccum >= 0.1) {
        simAccum -= 0.1;
        sim.step(0.1, 1);
      }

      if (climbedAfterScoop && sim.missionScore >= 70) break;
    }

    assert.ok(visited.has('APPROACH_FIRE'), 'visited APPROACH_FIRE');
    assert.ok(visited.has('RELEASE'), 'visited RELEASE');
    assert.ok(visited.has('TURN_TO_LAKE'), 'visited TURN_TO_LAKE');
    assert.ok(visited.has('DESCEND_AND_SCOOP'), 'visited DESCEND_AND_SCOOP');
    assert.ok(visited.has('CLIMB_OUT'), 'visited CLIMB_OUT');
    assert.ok(minTank < 5, `emptied tank during release (minTank=${minTank.toFixed(1)}%)`);
    assert.equal(scoopedBackToFull, true, 'scooped tank back up to ~100%');
    assert.equal(climbedAfterScoop, true, 'climbed out cleanly after scooping');
    assert.ok(sim.missionScore >= 70, `extinguished fire cells for >= +70 pts (got ${sim.missionScore})`);
    assert.equal(totalBounces, 0, `autopilot must not hit terrain (bounces=${totalBounces})`);
  });

  it('stays safe and never crashes or loops stuck across all 6 maps', () => {
    for (const op of ALL_OPS) {
      const terrain = generateTerrain(op);
      const sim = new FireSim(terrain, { isMegaBasin: op.mode === 'megabasin' });
      const ap = new Autopilot(terrain);
      const lake = terrain.scoopZones[0];

      const plane = createAircraftState({
        x: lake.x,
        z: lake.z,
        y: terrain.waterLevel + 55,
        yawDeg: lake.headingDeg,
        tankPct: 100,
        slotId: 0,
      });

      let bounces = 0;
      let dropped = false;
      let scooped = false;
      const dt = 1 / 60;
      let simAccum = 0;

      for (let s = 0; s < 60 * 75; s++) {
        const input = ap.update(plane, sim.getSnapshot(), dt);
        const { events } = stepFlight(plane, input, terrain, dt);
        if (events.bounced) bounces++;
        if (plane.releasing) dropped = true;
        if (plane.scooping) scooped = true;
        assert.ok(Number.isFinite(plane.x) && Number.isFinite(plane.y) && Number.isFinite(plane.z), `${op.id} finite pose`);
        simAccum += dt;
        if (simAccum >= 0.1) {
          simAccum -= 0.1;
          sim.step(0.1, 1);
        }
      }

      assert.equal(bounces, 0, `${op.id} autopilot zero terrain bounces (got ${bounces})`);
      assert.equal(dropped, true, `${op.id} autopilot dropped water`);
      assert.equal(scooped, true, `${op.id} autopilot scooped water`);
    }
  });
});

describe('FireSim', () => {
  it('spreads fire downwind, enforces 15-20 s wet immunity, and ignites ember warnings after 4 s', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);
    const startCount = sim.burningCount;
    assert.ok(startCount > 30, `initial burning cells (${startCount})`);

    // Step 25 seconds without water -> fire must spread
    for (let i = 0; i < 250; i++) sim.step(0.1, 1);
    assert.ok(sim.burningCount > startCount, `fire spread (${startCount} -> ${sim.burningCount})`);

    // Pick a burning cell, drop direct water parcel on it to extinguish to state 13 (wet)
    let targetIdx = -1;
    for (let i = 0; i < sim.cells.length; i++) {
      if (sim.cells[i] >= 2 && sim.cells[i] <= 10) {
        targetIdx = i;
        break;
      }
    }
    assert.ok(targetIdx >= 0);
    const gx = targetIdx % terrain.gridSize;
    const gz = (targetIdx - gx) / terrain.gridSize;
    const pos = terrain.gridToWorld(gx, gz);
    const groundY = terrain.getHeight(pos.x, pos.z);

    // Spawn 4 parcels directly over cell (low height so they land on next step)
    for (let k = 0; k < 4; k++) {
      sim.spawnWaterParcel(7, pos.x, groundY + 0.5, pos.z, 0, -20, 0, 25);
    }
    sim.step(0.1, 1);
    assert.equal(sim.cells[targetIdx], CELL_STATE.WET, 'extinguished cell enters WET state 13');

    // Remains wet & immune for at least 14.5 seconds
    for (let i = 0; i < 140; i++) sim.step(0.1, 1);
    assert.equal(sim.cells[targetIdx], CELL_STATE.WET, 'remains immune in WET state after 14s');

    // Returns to INTACT (or CHARRED) by 21 seconds total
    for (let i = 0; i < 70; i++) sim.step(0.1, 1);
    assert.notEqual(sim.cells[targetIdx], CELL_STATE.WET, 'wet cooldown expires within 15-20s');

    // Ember warning test (state 15 -> ignites to 3 after 4.0 s)
    let intactIdx = -1;
    for (let i = 0; i < sim.cells.length; i++) {
      if (sim.cells[i] === CELL_STATE.INTACT && terrain.fuelMask[i] === 1) {
        intactIdx = i;
        break;
      }
    }
    sim.cells[intactIdx] = CELL_STATE.EMBER_WARN;
    sim.emberTimer[intactIdx] = 4.0;
    sim._addActive(intactIdx);
    for (let i = 0; i < 38; i++) sim.step(0.1, 1);
    assert.equal(sim.cells[intactIdx], CELL_STATE.EMBER_WARN, 'still ember warning at 3.8s');
    for (let i = 0; i < 4; i++) sim.step(0.1, 1);
    assert.ok(sim.cells[intactIdx] >= 3 && sim.cells[intactIdx] <= 5, 'ignited to >=3 after 4.0s');
  });

  it('awards +70 primary and +35 co-bomber assist (>= 15% share) within 3 s window', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    // Isolate a single high-intensity burning cell
    sim.cells.fill(0);
    sim.intensityF.fill(0);
    sim.activePos.fill(-1);
    sim.activeCount = 0;

    const targetIdx = terrain.initialFireSeeds[0].gz * terrain.gridSize + terrain.initialFireSeeds[0].gx;
    const gx = targetIdx % terrain.gridSize;
    const gz = (targetIdx - gx) / terrain.gridSize;
    const pos = terrain.gridToWorld(gx, gz);
    const groundY = terrain.getHeight(pos.x, pos.z);

    sim.cells[targetIdx] = 10;
    sim.intensityF[targetIdx] = 10.0;
    sim._addActive(targetIdx);

    // Slot 1 drops 2 parcels (majority), Slot 2 drops 1 parcel (~33% >= 15%)
    sim.spawnWaterParcel(1, pos.x, groundY + 0.5, pos.z, 0, -20, 0, 30);
    sim.spawnWaterParcel(1, pos.x, groundY + 0.5, pos.z, 0, -20, 0, 30);
    sim.spawnWaterParcel(2, pos.x, groundY + 0.5, pos.z, 0, -20, 0, 30);

    const delta = sim.step(0.1, 2);
    assert.equal(sim.cells[targetIdx], CELL_STATE.WET);

    const primaryEv = delta.scoreEvents.find((e) => e.slotId === 1 && e.kind === 'cell');
    const assistEv = delta.scoreEvents.find((e) => e.slotId === 2 && e.kind === 'assist');
    assert.ok(primaryEv && primaryEv.pts === SCORE.CELL_PRIMARY, 'primary pilot receives +70');
    assert.ok(assistEv && assistEv.pts === SCORE.CELL_ASSIST, 'co-bomber receives +35 assist');
  });

  it('detects CABIN AT RISK within 48 m, damages within 24 m, and awards +500 Cabin Saved with 30 s cooldown', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    // Clear all fires and ignite one cell right next to cabin 0 (within 24 m)
    sim.cells.fill(0);
    sim.intensityF.fill(0);
    sim.activePos.fill(-1);
    sim.activeCount = 0;

    const cab = terrain.cabins[0];
    const { gx, gz } = terrain.worldToGrid(cab.x, cab.z);
    // Find an adjacent flammable cell within 24 m
    let fireIdx = -1;
    let firePos = null;
    for (let dz = -1; dz <= 1 && fireIdx < 0; dz++) {
      for (let dx = -1; dx <= 1 && fireIdx < 0; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = gx + dx;
        const nz = gz + dz;
        const idx = nz * terrain.gridSize + nx;
        const p = terrain.gridToWorld(nx, nz);
        if (terrain.fuelMask[idx] === 1 && Math.hypot(p.x - cab.x, p.z - cab.z) <= 24) {
          fireIdx = idx;
          firePos = p;
        }
      }
    }
    assert.ok(fireIdx >= 0, 'found flammable cell within 24m of cabin 0');

    sim.cells[fireIdx] = 10;
    sim.intensityF[fireIdx] = 10.0;
    sim._addActive(fireIdx);

    // Run 3.5 seconds so cabin is at risk >= 3 s and takes damage
    for (let i = 0; i < 35; i++) sim.step(0.1, 1);
    assert.equal(sim.cabinAtRisk[0], 1, 'cabin 0 marked AT RISK');
    assert.ok(sim.cabinHp[0] < 100, `cabin 0 took fire damage (hp=${sim.cabinHp[0]})`);

    // Now extinguish all fires near cabin 0 with pilot slot 7
    const groundY = terrain.getHeight(firePos.x, firePos.z);
    for (let k = 0; k < 5; k++) {
      sim.spawnWaterParcel(7, firePos.x, groundY + 0.5, firePos.z, 0, -20, 0, 28);
    }
    // Also extinguish any adjacent cells that ignited during the 3.5 s window
    for (let i = 0; i < sim.cells.length; i++) {
      if (sim.cells[i] >= 1 && sim.cells[i] <= 12 && i !== fireIdx) {
        const p = terrain.gridToWorld(i % terrain.gridSize, Math.floor(i / terrain.gridSize));
        sim.spawnWaterParcel(7, p.x, terrain.getHeight(p.x, p.z) + 0.5, p.z, 0, -20, 0, 24);
        sim.spawnWaterParcel(7, p.x, terrain.getHeight(p.x, p.z) + 0.5, p.z, 0, -20, 0, 24);
      }
    }
    const delta = sim.step(0.1, 1);
    const savedEv = delta.scoreEvents.find((e) => e.kind === 'cabin' && e.pts === SCORE.CABIN_SAVED);
    assert.ok(savedEv, 'awarded +500 Cabin Saved');
    assert.equal(savedEv.slotId, 7);
    assert.equal(sim.cabinAtRisk[0], 0);
  });

  it('round-trips MP fireKey + fireRing delta and handles Mega-Basin 15 s rolling intermission', () => {
    const terrain = generateTerrain(MEGA_BASIN_OP);
    const hostSim = new FireSim(terrain, { isMegaBasin: true });
    const replicaSim = new FireSim(terrain, { isMegaBasin: true });

    // Advance host slightly and hydrate replica via encodeFullState / applyExternalKey
    for (let i = 0; i < 10; i++) hostSim.step(0.1, 10);
    const fullKey = hostSim.encodeFullState();
    replicaSim.applyExternalKey(fullKey);
    assert.deepEqual(replicaSim.cells, hostSim.cells);
    assert.equal(replicaSim.burningCount, hostSim.burningCount);

    // Apply delta
    const delta = hostSim.step(0.1, 10);
    assert.equal(delta.fullReset, false, 'normal step sets fullReset: false');
    replicaSim.applyExternalDelta(delta);
    assert.deepEqual(replicaSim.cells, hostSim.cells);

    // Damage cabin 0 so we verify full cabin restore is emitted on Wave 2 transition
    hostSim.cabinHp[0] = 40;
    hostSim.cabinHpF[0] = 40;

    // Extinguish all fires on host -> enters 15 s intermission with +1000 bonus -> rolls into wave 2
    hostSim.cells.fill(0);
    hostSim.intensityF.fill(0);
    hostSim.activePos.fill(-1);
    hostSim.activeCount = 0;
    const preScore = hostSim.missionScore;
    const enterIntermission = hostSim.step(0.1, 10);
    assert.equal(enterIntermission.fullReset, false);
    assert.equal(hostSim.status, 'intermission');
    assert.equal(hostSim.missionScore, preScore + SCORE.WAVE_CONTAINED);
    assert.ok(hostSim.intermissionTimer > 14.5);

    let resetDelta = null;
    for (let i = 0; i < 155; i++) {
      const d = hostSim.step(0.1, 10);
      if (d.fullReset) {
        assert.equal(resetDelta, null, 'fullReset fires exactly once on wave transition');
        resetDelta = d;
      }
    }
    assert.ok(resetDelta, 'Wave 2 transition emitted fullReset: true');
    assert.equal(resetDelta.wave, 2);
    assert.equal(resetDelta.cabinChanges.length, hostSim.cabinsTotal, 'fullReset includes all cabin HPs');
    assert.equal(resetDelta.cabinChanges[0].hp, 100, 'cabin 0 restored to 100 HP');
    assert.equal(hostSim.status, 'active');
    assert.equal(hostSim.wave, 2);
    assert.ok(hostSim.burningCount > 0, 'wave 2 ignited fresh fires');
  });

  it('populates cabinAtRisk and atRiskTarget in applyExternalKey even when cabinAtRisk is omitted', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const hostSim = new FireSim(terrain);
    const replicaSim = new FireSim(terrain);

    // Ignite one cell right next to cabin 0
    hostSim.cells.fill(0);
    hostSim.intensityF.fill(0);
    hostSim.activePos.fill(-1);
    hostSim.activeCount = 0;

    const cab = terrain.cabins[0];
    const { gx, gz } = terrain.worldToGrid(cab.x, cab.z);
    let fireIdx = -1;
    for (let dz = -1; dz <= 1 && fireIdx < 0; dz++) {
      for (let dx = -1; dx <= 1 && fireIdx < 0; dx++) {
        if (dx === 0 && dz === 0) continue;
        const idx = (gz + dz) * terrain.gridSize + (gx + dx);
        const p = terrain.gridToWorld(gx + dx, gz + dz);
        if (terrain.fuelMask[idx] === 1 && Math.hypot(p.x - cab.x, p.z - cab.z) <= 40) {
          fireIdx = idx;
        }
      }
    }
    assert.ok(fireIdx >= 0);
    hostSim.cells[fireIdx] = 8;
    hostSim.intensityF[fireIdx] = 8;
    hostSim._addActive(fireIdx);

    // Build wire-like fireKey payload WITHOUT cabinAtRisk field (matching decodeFireKey)
    const wireKey = hostSim.encodeFullState();
    delete wireKey.cabinAtRisk;

    replicaSim.applyExternalKey(wireKey);
    assert.equal(replicaSim.cabinAtRisk[0], 1, 'replica cabinAtRisk populated on applyExternalKey');
    assert.ok(replicaSim.atRiskTarget, 'replica atRiskTarget populated on applyExternalKey');
  });

  it('does NOT award phantom slot 7 +500 Cabin Saved when nearby fire burns out naturally', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    // Clear all fires and place a single nearly-exhausted burning cell near cabin 0
    sim.cells.fill(0);
    sim.intensityF.fill(0);
    sim.activePos.fill(-1);
    sim.activeCount = 0;

    const cab = terrain.cabins[0];
    const { gx, gz } = terrain.worldToGrid(cab.x, cab.z);
    let fireIdx = -1;
    for (let dz = -1; dz <= 1 && fireIdx < 0; dz++) {
      for (let dx = -1; dx <= 1 && fireIdx < 0; dx++) {
        if (dx === 0 && dz === 0) continue;
        const idx = (gz + dz) * terrain.gridSize + (gx + dx);
        const p = terrain.gridToWorld(gx + dx, gz + dz);
        if (terrain.fuelMask[idx] === 1 && Math.hypot(p.x - cab.x, p.z - cab.z) <= 40) {
          fireIdx = idx;
        }
      }
    }
    assert.ok(fireIdx >= 0);

    // Make fuel exhaust in ~3.5 s so cabin is at risk >= 3 s, then burns out naturally with zero pilot water
    sim.cells[fireIdx] = 6;
    sim.intensityF[fireIdx] = 6.0;
    sim.burnDuration[fireIdx] = 4.0;
    sim.fuelRemaining[fireIdx] = 0.72;
    sim._addActive(fireIdx);

    // Ensure no neighbor ignites while testing natural burnout
    const origFuel = new Uint8Array(terrain.fuelMask);
    terrain.fuelMask.fill(0);
    terrain.fuelMask[fireIdx] = 1;

    let sawAtRisk = false;
    let cabinSavedEvents = 0;
    try {
      for (let i = 0; i < 65; i++) {
        const d = sim.step(0.1, 1);
        if (sim.cabinAtRisk[0] === 1) sawAtRisk = true;
        for (const ev of d.scoreEvents) {
          if (ev.kind === 'cabin') cabinSavedEvents++;
        }
      }
    } finally {
      terrain.fuelMask.set(origFuel);
    }

    assert.equal(sawAtRisk, true, 'cabin 0 entered at-risk state');
    assert.equal(sim.cells[fireIdx], CELL_STATE.CHARRED, 'cell burned out naturally to CHARRED');
    assert.equal(sim.cabinAtRisk[0], 0, 'cabin 0 cleared at-risk after burnout');
    assert.equal(cabinSavedEvents, 0, 'must NOT award phantom +500 Cabin Saved without pilot intervention');
    assert.equal(sim.slotScores.get(7), undefined, 'slot 7 must NOT receive phantom score');
  });

  it('stays p99 < 2.0 ms per 10 Hz tick in 100-pilot Mega-Basin stress test', () => {
    const terrain = generateTerrain(MEGA_BASIN_OP);
    const sim = new FireSim(terrain, { isMegaBasin: true });

    // Warm up JIT with realistic parcels & steady-state fire
    const clusters = sim.hotClusters.length > 0 ? sim.hotClusters : [{ x: 0, z: 0, y: 40 }];
    for (let i = 0; i < 40; i++) {
      for (let p = 0; p < 30; p++) {
        const cl = clusters[p % clusters.length];
        sim.spawnWaterParcel((i * 7 + p) % 100, cl.x + ((p * 17) % 80) - 40, cl.y + 42, cl.z + ((p * 23) % 80) - 40, 20, -2, -15, 42);
      }
      sim.step(0.1, 100);
    }

    const timesMs = [];

    for (let tick = 0; tick < 200; tick++) {
      // Simulate 100 concurrent pilots (30 releasing simultaneously at 10 Hz -> ~300-750 parcels in flight)
      for (let p = 0; p < 30; p++) {
        const slotId = (tick * 7 + p) % 100;
        const cl = clusters[p % clusters.length];
        const ox = ((p * 17) % 80) - 40;
        const oz = ((p * 23) % 80) - 40;
        sim.spawnWaterParcel(slotId, cl.x + ox, cl.y + 42, cl.z + oz, 20, -2, -15, 42);
      }

      const t0 = performance.now();
      sim.step(0.1, 100);
      const elapsed = performance.now() - t0;
      timesMs.push(elapsed);
    }

    timesMs.sort((a, b) => a - b);
    const p50 = timesMs[Math.floor(timesMs.length * 0.5)];
    const p99 = timesMs[Math.floor(timesMs.length * 0.99)];
    console.log(`[FireSim 100P Mega-Basin benchmark] p50=${p50.toFixed(3)}ms, p99=${p99.toFixed(3)}ms`);
    assert.ok(p99 < 2.0, `Expected Mega-Basin 100-pilot p99 < 2.0 ms, got ${p99.toFixed(3)} ms`);
  });
});

describe('BackgroundWorker', () => {
  it('ticks reliably in Node fallback mode and stops cleanly', async () => {
    let ticks = 0;
    const ticker = createBackgroundTicker(20, () => {
      ticks++;
    });
    assert.equal(ticker.isHidden(), false);
    ticker.start();
    await new Promise((r) => setTimeout(r, 85));
    ticker.stop();
    const afterStop = ticks;
    assert.ok(afterStop >= 2, `expected >= 2 ticks, got ${afterStop}`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ticks, afterStop, 'no further ticks after stop()');
  });
});
