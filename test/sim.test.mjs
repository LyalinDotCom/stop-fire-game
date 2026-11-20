import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  OPERATIONS,
  DEFAULT_OPERATION,
  MEGA_BASIN_OP,
  WATER_LEVEL,
  getOperationById,
  getOperationByIndex,
  getNextOperation,
} from '../src/config/operations.js';
import { generateTerrain } from '../src/sim/TerrainGen.js';
import {
  FLIGHT_CONSTANTS,
  computeSplashRadius,
  evaluateDropAltitude,
  createAircraftState,
  stepFlight,
  predictDropImpact,
} from '../src/sim/FlightModel.js';
import { Autopilot } from '../src/sim/Autopilot.js';
import {
  FireSim,
  CELL_STATE,
  SCORE,
  DROP_QUALITY_CODES,
  WET_COOLDOWN_MIN,
  WET_COOLDOWN_MAX,
} from '../src/sim/FireSim.js';
import { createBackgroundTicker } from '../src/sim/BackgroundWorker.js';

const ALL_OPS = [...OPERATIONS, MEGA_BASIN_OP];

describe('OperationsConfig', () => {
  it('starts on focused Operation 01 and cleanly wraps Operations 01 -> 05 -> 01', () => {
    assert.equal(DEFAULT_OPERATION.id, 'op01');
    assert.equal(DEFAULT_OPERATION.name, 'Cinderpine Basin');
    assert.equal(OPERATIONS.length, 5);
    for (let i = 0; i < OPERATIONS.length; i++) {
      assert.equal(OPERATIONS[i].opIndex, i);
      assert.equal(OPERATIONS[i].index, i + 1);
      assert.equal(OPERATIONS[i].maxPilots, 100);
      assert.equal(getOperationByIndex(i).id, OPERATIONS[i].id);
      assert.equal(getOperationById(OPERATIONS[i].id).id, OPERATIONS[i].id);
    }
    assert.equal(getOperationByIndex(5).id, 'op01');
    assert.equal(getOperationByIndex(-1).id, 'op05');
    assert.equal(getNextOperation('op01').id, 'op02');
    assert.equal(getNextOperation('op05').id, 'op01');
    assert.equal(getNextOperation(OPERATIONS[4]).id, 'op01');
    assert.equal(getOperationById('megabasin').id, 'megabasin');
  });
});

describe('TerrainGen', () => {
  it('generates all 5 Operations and Mega-Basin with valid counts, spatial tree hash, and zero cabins/trees in water', () => {
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
      assert.equal(t.treeCellOffsets.length, op.gridSize * op.gridSize + 1);
      assert.equal(t.treeCellIndices.length, t.trees.length);
      assert.equal(typeof t.findCollidingTree, 'function');

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
        // Initial burning % stays crisp & readable (~2.5%-4.5%)
        const sim = new FireSim(t);
        assert.ok(
          sim.burningPct >= 2.3 && sim.burningPct <= 4.7,
          `${op.id} initial burningPct ${sim.burningPct.toFixed(2)}% should be ~2.5%-4.5%`
        );
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

      // Spatial tree hash detects direct hit on sample tree and returns null high overhead
      const sampleTree = t.trees[Math.floor(t.trees.length / 2)];
      assert.ok(
        t.findCollidingTree(sampleTree.x, sampleTree.y + 4.0, sampleTree.z) !== null,
        `${op.id} spatial hash hits standing tree`
      );
      assert.equal(
        t.findCollidingTree(sampleTree.x, sampleTree.y + 30.0, sampleTree.z),
        null,
        `${op.id} spatial hash clears high overhead`
      );

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

  it('has forgiving scoop zone (<= 9.0 m enter, >= 11.5 m exit) and zero water-skim damage', () => {
    // At 10.0 m AGL -> does NOT enter scoop
    const highPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 10.0,
      yawDeg: lake.headingDeg,
      pitchDeg: 0,
      tankPct: 0,
    });
    stepFlight(highPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(highPlane.scooping, false, 'should NOT activate scoop at 10.0 m AGL');

    // At 8.5 m AGL -> scoop activates
    const lowPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 8.5,
      yawDeg: lake.headingDeg,
      pitchDeg: 0,
      tankPct: 0,
    });
    const { events } = stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, true, 'should activate scoop at 8.5 m AGL');
    assert.equal(events.scoopStarted, true);
    assert.equal(lowPlane.hp, 100, 'water skim deals zero hull damage');
    assert.equal(lowPlane.crashed, false);

    // Hysteresis: stays scooping at 10.5 m AGL, exits at >= 11.5 m AGL
    lowPlane.y = terrain.waterLevel + 10.5;
    stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, true, 'hysteresis keeps scoop active below 11.5 m AGL');

    lowPlane.y = terrain.waterLevel + 11.7;
    const resExit = stepFlight(lowPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(lowPlane.scooping, false, 'exits scoop at >= 11.5 m AGL');
    assert.equal(resExit.events.scoopEnded, true);
  });

  it('fills tank 0 -> 100% in ~1.33 s on optimal level scoop vs ~30%/s on rough banked/overspeed scoop (0 damage)', () => {
    const plane = createAircraftState({
      x: lake.x,
      z: lake.z + 250,
      y: terrain.waterLevel + 5.0,
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 0,
      speedKmh: 150,
      tankPct: 0,
    });

    const dt = 1 / 60;
    let elapsed = 0;
    let tankFullFired = false;
    while (plane.tankPct < 100 && elapsed < 2.5) {
      const { events } = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
      if (events.tankFull) tankFullFired = true;
      assert.equal(events.scoopRough, false, 'level 150 km/h scoop is optimal, not rough');
      if (!terrain.isWater(plane.x, plane.z)) {
        plane.x = lake.x;
        plane.z = lake.z + 200;
      }
      plane.y = terrain.waterLevel + 5.0;
      elapsed += dt;
    }

    assert.equal(tankFullFired, true, 'tankFull event must fire');
    assert.ok(elapsed >= 1.28 && elapsed <= 1.42, `0->100% optimal scoop took ${elapsed.toFixed(3)}s (expected ~1.33s)`);
    assert.equal(plane.hp, 100, 'full scoop leaves hull at 100 HP');

    // Rough banked scoop (> 16 deg roll) refills slower (~30%/s), emits scoopRough, and still deals 0 hull damage!
    const roughPlane = createAircraftState({
      x: lake.x,
      z: lake.z + 200,
      y: terrain.waterLevel + 5.0,
      yawDeg: 0,
      pitchDeg: 0,
      rollDeg: 28,
      speedKmh: 155,
      tankPct: 0,
    });
    let sawRoughStart = false;
    let sawRough = false;
    for (let i = 0; i < 60; i++) {
      roughPlane.rollDeg = 28;
      roughPlane.y = terrain.waterLevel + 5.0;
      roughPlane.x = lake.x;
      roughPlane.z = lake.z;
      const { events } = stepFlight(roughPlane, { pitch: 0, roll: 0.5, throttleDelta: 0, drop: false }, terrain, dt);
      if (events.scoopRoughStarted) sawRoughStart = true;
      if (events.scoopRough) sawRough = true;
    }
    assert.equal(sawRoughStart, true, 'rough scoop emits scoopRoughStarted');
    assert.equal(sawRough, true, 'rough scoop emits scoopRough');
    assert.equal(roughPlane.scoopQuality, 'rough');
    assert.ok(roughPlane.tankPct >= 25 && roughPlane.tankPct <= 35, `1 s rough scoop filled ~30% (got ${roughPlane.tankPct.toFixed(1)}%)`);
    assert.equal(roughPlane.hp, 100, 'rough water scoop still deals 0 hull damage (forgiving survival)');

    // Forgiving hydroplane floor: diving into lake floors cleanly at waterLevel + 3.0 m with 0 damage and level pitch
    plane.y = terrain.waterLevel + 1.5;
    plane.pitchDeg = -15;
    const diveRes = stepFlight(plane, { pitch: -1, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
    assert.ok(plane.y >= terrain.waterLevel + FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL - 1e-4, 'hydroplane floor >= 3.0m');
    assert.ok(plane.pitchDeg >= 0, 'hydroplane levels pitch >= 0 deg without bouncing out');
    assert.equal(plane.hp, 100, 'water hydroplane cushion takes zero damage');
    assert.equal(plane.crashed, false);
    assert.equal(diveRes.events.planeCrash, null);
  });

  it('models heavy full-tank inertia (~13% slower climb/roll) and upward buoyancy surge when dropping water', () => {
    const dt = 1 / 60;
    const emptyPlane = createAircraftState({
      x: 0, z: 0, y: terrain.getHeight(0, 0) + 60, yawDeg: 90, pitchDeg: 0, rollDeg: 0, tankPct: 0, autopilot: false,
    });
    const fullPlane = createAircraftState({
      x: 0, z: 0, y: terrain.getHeight(0, 0) + 60, yawDeg: 90, pitchDeg: 0, rollDeg: 0, tankPct: 100, autopilot: false,
    });

    for (let i = 0; i < 18; i++) {
      stepFlight(emptyPlane, { pitch: 1, roll: 1, throttleDelta: 0, drop: false }, terrain, dt);
      stepFlight(fullPlane, { pitch: 1, roll: 1, throttleDelta: 0, drop: false }, terrain, dt);
    }
    assert.ok(fullPlane.rollDeg < emptyPlane.rollDeg * 0.92, `loaded roll (${fullPlane.rollDeg.toFixed(1)}) slower than empty (${emptyPlane.rollDeg.toFixed(1)})`);
    assert.ok(fullPlane.pitchDeg < emptyPlane.pitchDeg * 0.92, `loaded climb pitch (${fullPlane.pitchDeg.toFixed(1)}) slower than empty (${emptyPlane.pitchDeg.toFixed(1)})`);

    // Upward buoyancy/lift surge when dumping water vs holding water in level flight
    const holdPlane = createAircraftState({
      x: 0, z: 0, y: terrain.getHeight(0, 0) + 60, yawDeg: 90, pitchDeg: 0, rollDeg: 0, tankPct: 100, autopilot: false,
    });
    const dropPlane = createAircraftState({
      x: 0, z: 0, y: terrain.getHeight(0, 0) + 60, yawDeg: 90, pitchDeg: 0, rollDeg: 0, tankPct: 100, autopilot: false,
    });
    for (let i = 0; i < 36; i++) {
      stepFlight(holdPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
      stepFlight(dropPlane, { pitch: 0, roll: 0, throttleDelta: 0, drop: true }, terrain, dt);
    }
    assert.ok(
      dropPlane.y > holdPlane.y + 1.5,
      `water drop buoyancy surged altitude (drop=${dropPlane.y.toFixed(2)}m vs hold=${holdPlane.y.toFixed(2)}m)`
    );
    assert.ok(dropPlane.pitchDeg > holdPlane.pitchDeg + 1.0, 'drop release lightens nose upward');
  });

  it('applies convective thermal updraft lift, smoke turbulence buffet, and extreme low-fire heat ticks', () => {
    const sim = new FireSim(terrain);
    const seed = terrain.initialFireSeeds[0];
    const center = terrain.gridToWorld(seed.gx, seed.gz);
    const groundY = terrain.getHeight(center.x, center.z);

    // 1. Calm lake air has zero fire atmosphere
    const calmAtm = sim.sampleFireAtmosphere(lake.x, terrain.waterLevel + 40, lake.z);
    assert.equal(calmAtm.smokeDensity, 0);
    assert.equal(calmAtm.thermalLift, 0);
    assert.equal(calmAtm.turbulence, 0);
    assert.equal(calmAtm.heatDanger, 0);

    // 2. Directly over fire at 35 m AGL: strong thermal lift + smoke + turbulence, safe from flame heat
    const hotAtm = sim.sampleFireAtmosphere(center.x, groundY + 35, center.z);
    assert.ok(hotAtm.thermalLift > 0.45, `thermalLift over fire=${hotAtm.thermalLift.toFixed(2)}`);
    assert.ok(hotAtm.turbulence > 0.45, `turbulence over fire=${hotAtm.turbulence.toFixed(2)}`);
    assert.ok(hotAtm.smokeDensity > 0.35, `smokeDensity over fire=${hotAtm.smokeDensity.toFixed(2)}`);
    assert.equal(hotAtm.heatDanger, 0, '35 m AGL is above direct flame heat danger');

    // 3. Downwind smoke plume (45 m downwind at 48 m AGL): noticeable smoke & turbulence
    const downwindAtm = sim.sampleFireAtmosphere(center.x + 42, groundY + 48, center.z);
    assert.ok(downwindAtm.smokeDensity > 0.15, `downwind smokeDensity=${downwindAtm.smokeDensity.toFixed(2)}`);
    assert.ok(downwindAtm.turbulence > 0.12, `downwind turbulence=${downwindAtm.turbulence.toFixed(2)}`);

    // 4. Convective updraft + turbulence visibly lifts and rocks aircraft vs calm flight
    const dt = 1 / 60;
    const calmAc = createAircraftState({
      x: center.x, z: center.z, y: groundY + 42, yawDeg: 90, pitchDeg: 0, rollDeg: 0, autopilot: false,
    });
    const thermalAc = createAircraftState({
      x: center.x, z: center.z, y: groundY + 42, yawDeg: 90, pitchDeg: 0, rollDeg: 0, autopilot: false,
    });
    let maxRollDeviation = 0;
    for (let i = 0; i < 30; i++) {
      stepFlight(calmAc, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt, {
        atmosphere: { smokeDensity: 0, thermalLift: 0, turbulence: 0, heatDanger: 0 },
      });
      stepFlight(thermalAc, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt, {
        atmosphere: hotAtm,
      });
      maxRollDeviation = Math.max(maxRollDeviation, Math.abs(thermalAc.rollDeg));
    }
    assert.ok(
      thermalAc.y > calmAc.y + 1.5,
      `thermal updraft lifted aircraft (thermal=${thermalAc.y.toFixed(2)}m vs calm=${calmAc.y.toFixed(2)}m)`
    );
    assert.ok(maxRollDeviation > 0.4, `turbulence rocked wings (maxRoll=${maxRollDeviation.toFixed(2)} deg)`);

    // 5. Dangerously low (< 16 m AGL) directly over roaring flames triggers heatDanger & hull heat ticks
    const lowAtm = sim.sampleFireAtmosphere(center.x, groundY + 10, center.z);
    assert.ok(lowAtm.heatDanger > 0.5, `low flame heatDanger=${lowAtm.heatDanger.toFixed(2)}`);
    const scorchedAc = createAircraftState({
      x: center.x, z: center.z, y: groundY + 11, yawDeg: 90, pitchDeg: 0, rollDeg: 0, autopilot: false,
    });
    const res = stepFlight(scorchedAc, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt, {
      atmosphere: lowAtm,
    });
    assert.ok(res.events.heatDamage, 'extreme low-flame flight emits heat_damage');
    assert.equal(res.events.heatDamage.type, 'heat_damage');
    assert.ok(scorchedAc.hp < 100, `heat tick reduced hull HP (${scorchedAc.hp})`);
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

  it('deals 30 HP hull damage on standing tree strike with 0.9 s cooldown and crashes at 0 HP', () => {
    const tree = terrain.trees[Math.floor(terrain.trees.length * 0.4)];
    const plane = createAircraftState({
      x: tree.x - 1.0,
      z: tree.z,
      y: tree.y + 5.5,
      yawDeg: 90,
      pitchDeg: 0,
      speedKmh: 165,
      tankPct: 80,
      autopilot: false,
    });

    const r1 = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.ok(r1.events.treeHit, 'tree_hit event emitted');
    assert.equal(r1.events.treeHit.type, 'tree_hit');
    assert.equal(r1.events.treeHit.damage, 30);
    assert.equal(r1.events.treeHit.hp, 70);
    assert.equal(plane.hp, 70);
    assert.equal(plane.crashed, false);
    assert.ok(plane.speedKmh < 155, 'tree strike causes speed drop');

    // Immediate next frame on same tree does NOT multi-drain (0.9 s cooldown)
    plane.x = tree.x;
    plane.z = tree.z;
    plane.y = tree.y + 5.5;
    const r2 = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(r2.events.treeHit, null, 'cooldown prevents instant multi-frame drain');
    assert.equal(plane.hp, 70);

    // Repeat 3 more strikes after cooldown -> hp reaches 0 -> crashes with reason 'trees'
    for (let k = 0; k < 3; k++) {
      plane.treeHitCooldown = 0;
      plane.x = tree.x - 0.5;
      plane.z = tree.z;
      plane.y = tree.y + 5.5;
      const rk = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
      if (k === 2) {
        assert.equal(plane.hp, 0);
        assert.equal(plane.crashed, true);
        assert.equal(plane.crashReason, 'trees');
        assert.equal(plane.tankPct, 0);
        assert.ok(rk.events.planeCrash && rk.events.planeCrash.reason === 'trees');
      }
    }
  });

  it('instantly crashes on non-water terrain impact and auto-respawns cleanly after 3.5 s preserving manual control', () => {
    const lx = 200;
    const lz = -100;
    const groundY = terrain.getHeight(lx, lz);
    const plane = createAircraftState({
      x: lx,
      z: lz,
      y: groundY + 1.4,
      yawDeg: 90,
      pitchDeg: -10,
      speedKmh: 160,
      tankPct: 90,
      autopilot: false,
      slotId: 3,
    });

    const { events } = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, 1 / 60);
    assert.equal(events.bounced, false, 'no land bounce-deflect');
    assert.ok(events.planeCrash, 'plane_crash event emitted');
    assert.equal(events.planeCrash.type, 'plane_crash');
    assert.equal(events.planeCrash.reason, 'terrain');
    assert.equal(plane.hp, 0);
    assert.equal(plane.crashed, true);
    assert.equal(plane.crashReason, 'terrain');
    assert.equal(plane.tankPct, 0, 'crash dumps tank to 0%');
    assert.ok(plane.crashTimer >= 3.45 && plane.crashTimer <= 3.5, `crashTimer=${plane.crashTimer}`);

    // Advance 3.0 s -> still crashed
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 3; i++) {
      stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
    }
    assert.equal(plane.crashed, true, 'still crashed at 3.0 s');

    // Advance remaining 0.6 s -> auto-respawns cleanly
    let sawRespawn = false;
    for (let i = 0; i < 40; i++) {
      const r = stepFlight(plane, { pitch: 0, roll: 0, throttleDelta: 0, drop: false }, terrain, dt);
      if (r.events.respawned) sawRespawn = true;
    }
    assert.equal(sawRespawn, true, 'respawned after 3.5 s');
    assert.equal(plane.crashed, false);
    assert.equal(plane.hp, 100, 'respawns at 100 HP');
    assert.equal(plane.tankPct, 0, 'respawns with 0% tank');
    assert.equal(plane.autopilot, false, 'manual control preserved on respawn');
    assert.ok(plane.agl >= 50, `respawns cleanly on elevated air corridor (agl=${plane.agl.toFixed(1)}m)`);
  });

  it('predictDropImpact() matches actual FireSim parcel impact coordinates within < 1 cell across flat & sloped terrain', () => {
    const sim = new FireSim(terrain);

    // Check 45 m AGL snappy fall time (~1.3-1.6 s)
    const flatPlane = createAircraftState({
      x: lake.x,
      z: lake.z,
      y: terrain.waterLevel + 45,
      yawDeg: 0,
      pitchDeg: 0,
      speedKmh: 158,
    });
    const flatPred = predictDropImpact(flatPlane, { windVx: 6.0, windVz: 0 }, terrain, sim);
    assert.ok(
      flatPred.flightTimeSec >= 1.3 && flatPred.flightTimeSec <= 1.6,
      `45 m AGL flightTimeSec=${flatPred.flightTimeSec.toFixed(3)}s (expected 1.3-1.6s)`
    );
    assert.ok(flatPred.impactX > flatPlane.x + 1.5, 'east wind shifts impact east');
    assert.equal(flatPred.radiusM, computeSplashRadius(45, terrain.cellSize));

    // Compare predictDropImpact() directly against simulated FireSim parcels in 4 diverse scenarios (sloped hills, wind, climb/dive)
    const scenarios = [
      { x: -120, z: -80, yawDeg: 75, pitchDeg: 0, agl: 45, windVx: 5.5, windVz: -2.0 },
      { x: 180, z: 120, yawDeg: 315, pitchDeg: -8, agl: 52, windVx: -4.0, windVz: 6.0 },
      { x: 40, z: -200, yawDeg: 145, pitchDeg: 6, agl: 38, windVx: 8.0, windVz: 3.5 },
      { x: -335, z: 50, yawDeg: 10, pitchDeg: 0, agl: 42, windVx: 0, windVz: -5.0 },
    ];

    for (const sc of scenarios) {
      const testSim = new FireSim(terrain);
      // Lock constant wind for exact comparison
      const gy = Math.max(terrain.waterLevel, terrain.getHeight(sc.x, sc.z));
      const p = createAircraftState({
        x: sc.x,
        y: gy + sc.agl,
        z: sc.z,
        yawDeg: sc.yawDeg,
        pitchDeg: sc.pitchDeg,
        speedKmh: 158,
        tankPct: 100,
      });

      // Step sim wind once, use exact sim wind vector
      testSim.windVx = sc.windVx;
      testSim.windVz = sc.windVz;
      const pred = predictDropImpact(p, { windVx: sc.windVx, windVz: sc.windVz }, terrain, testSim);

      testSim.spawnWaterParcel(7, p.x, p.y, p.z, p.vx, p.vy, p.vz, sc.agl);
      let impact = null;
      for (let step = 0; step < 60 && !impact; step++) {
        // Hold wind constant while parcel falls to isolate ballistic math comparison
        testSim.windVx = sc.windVx;
        testSim.windVz = sc.windVz;
        const evs = [];
        testSim._stepParcels(0.1, evs);
        if (evs.length > 0) impact = evs[0];
      }

      assert.ok(impact, 'parcel landed');
      const errM = Math.hypot(impact.x - pred.impactX, impact.z - pred.impactZ);
      assert.ok(
        errM < terrain.cellSize,
        `predictDropImpact error ${errM.toFixed(2)}m must be < 1 cell (${terrain.cellSize}m)`
      );
    }
  });
});

describe('Autopilot', () => {
  it('completes a full drop + scoop + climb cycle on Cinderpine Basin with direct hit, 0 tree hits, 0 crashes', () => {
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
    let totalTreeHits = 0;
    let totalCrashes = 0;
    const outcomes = [];

    const dt = 1 / 60;
    let simAccum = 0;
    let parcelAccum = 0;

    for (let step = 0; step < 60 * 95; step++) {
      const snap = sim.getSnapshot();
      const input = ap.update(plane, snap, dt);
      visited.add(input.phase);

      const { events } = stepFlight(plane, input, terrain, dt, { fireCells: snap.cells });
      if (events.treeHit) totalTreeHits++;
      if (events.planeCrash) totalCrashes++;

      if (plane.tankPct < minTank) minTank = plane.tankPct;
      if (minTank < 5 && plane.tankPct >= 99) scoopedBackToFull = true;
      if (scoopedBackToFull && input.phase === 'CLIMB_OUT' && plane.agl >= 34) {
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
        outcomes.push(...sim.drainDropOutcomes());
      }

      if (climbedAfterScoop && outcomes.some((o) => o.outcome === 'direct')) break;
    }

    assert.ok(visited.has('APPROACH_FIRE'), 'visited APPROACH_FIRE');
    assert.ok(visited.has('RELEASE'), 'visited RELEASE');
    assert.ok(visited.has('TURN_TO_LAKE'), 'visited TURN_TO_LAKE');
    assert.ok(visited.has('DESCEND_AND_SCOOP'), 'visited DESCEND_AND_SCOOP');
    assert.ok(visited.has('CLIMB_OUT'), 'visited CLIMB_OUT');
    assert.ok(minTank < 5, `emptied tank during release (minTank=${minTank.toFixed(1)}%)`);
    assert.equal(scoopedBackToFull, true, 'scooped tank back up to ~100%');
    assert.equal(climbedAfterScoop, true, 'climbed out cleanly after scooping');
    const directHit = outcomes.find((o) => o.outcome === 'direct');
    assert.ok(directHit && directHit.cellsExtinguished >= 5, `autopilot scored direct hit >= 5 cells (got ${directHit?.cellsExtinguished})`);
    assert.equal(totalTreeHits, 0, 'autopilot must avoid treetops');
    assert.equal(totalCrashes, 0, 'autopilot must never crash');
    assert.equal(plane.hp, 100);
  });

  it('stays safe with 0 tree hits and 0 crashes across all 6 maps', () => {
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

      let treeHits = 0;
      let crashes = 0;
      let dropped = false;
      let scooped = false;
      const dt = 1 / 60;
      let simAccum = 0;

      for (let s = 0; s < 60 * 75; s++) {
        const snap = sim.getSnapshot();
        const input = ap.update(plane, snap, dt);
        const { events } = stepFlight(plane, input, terrain, dt, { fireCells: snap.cells });
        if (events.treeHit) treeHits++;
        if (events.planeCrash) crashes++;
        if (plane.releasing) dropped = true;
        if (plane.scooping) scooped = true;
        assert.ok(Number.isFinite(plane.x) && Number.isFinite(plane.y) && Number.isFinite(plane.z), `${op.id} finite pose`);
        simAccum += dt;
        if (simAccum >= 0.1) {
          simAccum -= 0.1;
          sim.step(0.1, 1);
        }
      }

      assert.equal(treeHits, 0, `${op.id} autopilot zero tree hits (got ${treeHits})`);
      assert.equal(crashes, 0, `${op.id} autopilot zero crashes (got ${crashes})`);
      assert.equal(plane.hp, 100, `${op.id} autopilot full HP`);
      assert.equal(dropped, true, `${op.id} autopilot dropped water`);
      assert.equal(scooped, true, `${op.id} autopilot scooped water`);
    }
  });
});

describe('FireSim', () => {
  it('spreads fire downwind, enforces 28-35 s wet firebreak immunity, and ignites ember warnings after 4 s', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);
    const startCount = sim.burningCount;
    assert.ok(startCount > 30, `initial burning cells (${startCount})`);

    // Step 45 seconds without water -> fire visibly spreads downwind at calm solo pace
    for (let i = 0; i < 450; i++) sim.step(0.1, 1);
    assert.ok(sim.burningCount > startCount, `fire spread downwind (${startCount} -> ${sim.burningCount})`);
    assert.ok(
      sim.burningCount < startCount * 1.5,
      `1-pilot spread stays controlled (${startCount} -> ${sim.burningCount})`
    );

    // Pick a burning cell, extinguish to state 13 (WET)
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

    for (let k = 0; k < 3; k++) {
      sim.spawnWaterParcel(7, pos.x, groundY + 0.5, pos.z, 0, -20, 0, 35);
    }
    sim.step(0.1, 1);
    assert.equal(sim.cells[targetIdx], CELL_STATE.WET, 'extinguished cell enters WET state 13');

    // Remains wet & immune for at least 27.5 seconds (WET_COOLDOWN_MIN = 28 s)
    for (let i = 0; i < 274; i++) sim.step(0.1, 1);
    assert.equal(sim.cells[targetIdx], CELL_STATE.WET, `remains immune in WET state after 27.4s (min ${WET_COOLDOWN_MIN}s)`);

    // Expires by 36 seconds total (WET_COOLDOWN_MAX = 35 s)
    for (let i = 0; i < 86; i++) sim.step(0.1, 1);
    assert.notEqual(sim.cells[targetIdx], CELL_STATE.WET, `wet cooldown expires within ${WET_COOLDOWN_MIN}-${WET_COOLDOWN_MAX}s`);

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

  it('extinguishes >= 5 cells in one accurate pass and emits a direct Drop Outcome Event', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);
    const seed = terrain.initialFireSeeds[0];
    const center = terrain.gridToWorld(seed.gx, seed.gz);

    const gy = terrain.getHeight(center.x - 100, center.z);
    const plane = createAircraftState({
      x: center.x - 120,
      y: gy + 45,
      z: center.z,
      yawDeg: 90,
      speedKmh: 158,
      tankPct: 100,
      slotId: 7,
    });

    let started = false;
    let pAcc = 0;
    let sAcc = 0;
    const outcomes = [];
    for (let i = 0; i < 60 * 6; i++) {
      const pred = predictDropImpact(plane, sim, terrain, sim);
      const shouldDrop = (!started && pred.onTarget && pred.fireCellsInTarget >= 6) || (started && plane.tankPct > 0);
      if (shouldDrop && !started) started = true;
      stepFlight(plane, { drop: shouldDrop, dropJustPressed: shouldDrop && !plane.releasing }, terrain, 1 / 60);
      if (plane.releasing) {
        pAcc += 1 / 60;
        if (pAcc >= 0.1) {
          pAcc -= 0.1;
          sim.spawnWaterParcel(7, plane.x, plane.y, plane.z, plane.vx, plane.vy, plane.vz, plane.agl);
        }
      }
      sAcc += 1 / 60;
      if (sAcc >= 0.1) {
        sAcc -= 0.1;
        sim.step(0.1, 1);
        outcomes.push(...sim.drainDropOutcomes());
      }
    }

    assert.equal(outcomes.length, 1, 'grouped entire drop pass into 1 outcome event');
    const out = outcomes[0];
    assert.equal(out.slotId, 7);
    assert.equal(out.outcome, 'direct');
    assert.equal(out.dropQuality, 'optimal');
    assert.equal(out.missType, 'none');
    assert.equal(out.missDirCompass, '');
    assert.equal(out.missDistM, 0);
    assert.ok(out.cellsExtinguished >= 12, `single optimal pass extinguished ${out.cellsExtinguished} cells (expected >= 12)`);
    assert.ok(out.pointsAwarded >= out.cellsExtinguished * SCORE.CELL_PRIMARY);
  });

  it('enforces real altitude drop skill on natural fire: 34 m optimal extinguishes massive swath vs 88 m / 105 m misted_high', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const seed = terrain.initialFireSeeds[0];
    const center = terrain.gridToWorld(seed.gx, seed.gz);

    // Check evaluateDropAltitude & predictDropImpact altZone classifications
    assert.equal(evaluateDropAltitude(12).altZone, 'too_low');
    assert.equal(evaluateDropAltitude(34).altZone, 'optimal');
    assert.ok(evaluateDropAltitude(34).coolingMult >= 1.79, 'peak optimal cooling is 1.8x');
    assert.equal(evaluateDropAltitude(88).altZone, 'too_high');
    assert.equal(evaluateDropAltitude(88).dropQuality, 'misted_high');
    assert.ok(evaluateDropAltitude(88).coolingMult <= 0.12, '88m misted cooling sharply diluted');
    assert.equal(evaluateDropAltitude(105).dropQuality, 'misted_high');
    assert.ok(evaluateDropAltitude(105).coolingMult <= 0.08, '105m misted cooling <= 0.08x');
    assert.ok(computeSplashRadius(105, 16) > computeSplashRadius(34, 16) * 1.4, 'high mist widens splash radius');

    // Run identical targeted 11-parcel drop passes over UNMODIFIED natural Operation 01 fire at 34 m, 88 m, and 105 m AGL
    const runAltitudePass = (agl) => {
      const sim = new FireSim(terrain);
      const gy = terrain.getHeight(center.x, center.z);
      const plane = createAircraftState({
        x: center.x - 160,
        y: gy + agl,
        z: center.z,
        yawDeg: 90,
        speedKmh: 158,
        tankPct: 100,
        slotId: 7,
      });
      const pred0 = predictDropImpact(plane, sim, terrain, sim);
      let dropped = 0;
      let started = false;
      const outcomes = [];
      for (let i = 0; i < 120; i++) {
        const pred = predictDropImpact(plane, sim, terrain, sim);
        if (!started && pred.impactX >= center.x - 28) started = true;
        if (started && dropped < 11) {
          const curAgl = Math.max(4, plane.y - terrain.getHeight(plane.x, plane.z));
          sim.spawnWaterParcel(7, plane.x, plane.y, plane.z, plane.vx, plane.vy, plane.vz, curAgl, 1);
          dropped++;
        }
        plane.x += plane.vx * 0.1;
        plane.y = Math.max(terrain.waterLevel, terrain.getHeight(plane.x, plane.z)) + agl;
        sim.step(0.1, 1);
        outcomes.push(...sim.drainDropOutcomes());
      }
      return { pred0, outcome: outcomes[0] };
    };

    const optRes = runAltitudePass(34);
    const high88Res = runAltitudePass(88);
    const high105Res = runAltitudePass(105);

    assert.equal(optRes.pred0.altZone, 'optimal');
    assert.equal(high88Res.pred0.altZone, 'too_high');
    assert.equal(high105Res.pred0.altZone, 'too_high');
    assert.ok(optRes.outcome, 'optimal pass emitted outcome');
    assert.ok(high88Res.outcome, '88m high pass emitted outcome');
    assert.ok(high105Res.outcome, '105m high pass emitted outcome');
    assert.equal(optRes.outcome.dropQuality, 'optimal');
    assert.equal(optRes.outcome.outcome, 'direct');
    assert.equal(high88Res.outcome.dropQuality, 'misted_high');
    assert.equal(high88Res.outcome.outcome, 'partial');
    assert.equal(high105Res.outcome.dropQuality, 'misted_high');
    assert.equal(high105Res.outcome.outcome, 'partial');
    assert.ok(
      optRes.outcome.cellsExtinguished >= 20,
      `optimal 34m pass extinguished ${optRes.outcome.cellsExtinguished} cells (expected >= 20)`
    );
    assert.ok(
      high88Res.outcome.cellsExtinguished <= 6,
      `88m misted pass must extinguish <= 6 cells (got ${high88Res.outcome.cellsExtinguished} vs optimal ${optRes.outcome.cellsExtinguished})`
    );
    assert.ok(
      high88Res.outcome.cellsCooled > 0,
      `88m misted pass still cools fire slightly (cellsCooled=${high88Res.outcome.cellsCooled})`
    );
    assert.ok(
      high105Res.outcome.cellsExtinguished <= 2,
      `105m misted pass must extinguish <= 2 cells (got ${high105Res.outcome.cellsExtinguished})`
    );
  });

  it('classifies off-target drops accurately as miss with overshot / short / wide + compass direction', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    // Clear grid and place a single crisp fire cell at (0, 0)
    sim.cells.fill(0);
    sim.intensityF.fill(0);
    sim.activePos.fill(-1);
    sim.activeCount = 0;
    const centerG = terrain.worldToGrid(0, 0);
    // Find nearest flammable dry cell near (0, 0)
    let fx = 0;
    let fz = 0;
    let fIdx = -1;
    for (let rad = 0; rad <= 10 && fIdx < 0; rad++) {
      for (let dz = -rad; dz <= rad && fIdx < 0; dz++) {
        for (let dx = -rad; dx <= rad && fIdx < 0; dx++) {
          const idx = (centerG.gz + dz) * terrain.gridSize + (centerG.gx + dx);
          if (terrain.fuelMask[idx] === 1) {
            fIdx = idx;
            const p = terrain.gridToWorld(centerG.gx + dx, centerG.gz + dz);
            fx = p.x;
            fz = p.z;
          }
        }
      }
    }
    assert.ok(fIdx >= 0);
    sim.cells[fIdx] = 10;
    sim.intensityF[fIdx] = 10;
    sim._addActive(fIdx);

    // Helper: spawn 2 low parcels flying East (+X) landing at (tx, tz) and wait 0.5 s for outcome
    const runMissCase = (slotId, tx, tz, vx, vz) => {
      const gy = terrain.getHeight(tx, tz);
      sim.spawnWaterParcel(slotId, tx, gy + 0.5, tz, vx, -20, vz, 30);
      sim.spawnWaterParcel(slotId, tx, gy + 0.5, tz, vx, -20, vz, 30);
      const found = [];
      for (let i = 0; i < 6; i++) {
        sim.step(0.1, 1);
        found.push(...sim.drainDropOutcomes());
      }
      return found.find((o) => o.slotId === slotId);
    };

    // 1. Flying East (+X): water lands 110 m EAST (ahead of fire) -> overshot, E
    const overshot = runMissCase(1, fx + 110, fz, 44, 0);
    assert.ok(overshot);
    assert.equal(overshot.outcome, 'miss');
    assert.equal(overshot.missType, 'overshot');
    assert.equal(overshot.missDirCompass, 'E');
    assert.ok(overshot.missDistM >= 95 && overshot.missDistM <= 125);

    // 2. Flying East (+X): water lands 110 m WEST (behind fire) -> short, W
    const shortDrop = runMissCase(2, fx - 110, fz, 44, 0);
    assert.ok(shortDrop);
    assert.equal(shortDrop.outcome, 'miss');
    assert.equal(shortDrop.missType, 'short');
    assert.equal(shortDrop.missDirCompass, 'W');
    assert.ok(shortDrop.missDistM >= 95 && shortDrop.missDistM <= 125);

    // 3. Flying East (+X): water lands 110 m NORTH (lateral flank) -> wide, N
    const wideDrop = runMissCase(3, fx + 5, fz - 110, 44, 0);
    assert.ok(wideDrop);
    assert.equal(wideDrop.outcome, 'miss');
    assert.equal(wideDrop.missType, 'wide');
    assert.equal(wideDrop.missDirCompass, 'N');
    assert.ok(wideDrop.missDistM >= 95 && wideDrop.missDistM <= 125);
  });

  it('allows 1 solo pilot to genuinely contain Operation 01 within 4 minutes and emits fire_contained world event', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    let dropCount = 0;
    let victorySec = -1;
    const worldEvents = [];

    for (let sec = 0; sec < 240; sec++) {
      // Simulate 1 solo pilot making one well-aimed pass every 20 seconds
      if (sec > 0 && sec % 20 === 8 && sim.burningCount > 0) {
        dropCount++;
        let bestX = sim.fireHead.x;
        let bestZ = sim.fireHead.z;
        let bestCnt = -1;
        for (let a = 0; a < sim.activeCount; a++) {
          const idx = sim.activeList[a];
          if (sim.cells[idx] < 1 || sim.cells[idx] > 12) continue;
          const gx = idx % terrain.gridSize;
          const gz = (idx - gx) / terrain.gridSize;
          let cnt = 0;
          for (let dz = -2; dz <= 2; dz++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = gx + dx;
              const nz = gz + dz;
              if (nx >= 0 && nx < terrain.gridSize && nz >= 0 && nz < terrain.gridSize) {
                const st = sim.cells[nz * terrain.gridSize + nx];
                if (st >= 1 && st <= 12) cnt++;
              }
            }
          }
          if (cnt > bestCnt) {
            bestCnt = cnt;
            const p = terrain.gridToWorld(gx, gz);
            bestX = p.x;
            bestZ = p.z;
          }
        }
        const gy = terrain.getHeight(bestX, bestZ);
        const plane = createAircraftState({
          x: bestX,
          y: gy + 36,
          z: bestZ + 105,
          yawDeg: 0,
          speedKmh: 158,
          tankPct: 100,
          slotId: 7,
        });
        let dropped = 0;
        for (let step = 0; step < 60; step++) {
          const pred = predictDropImpact(plane, sim, terrain, sim);
          if (dropped > 0 || pred.impactZ <= bestZ + 22) {
            sim.spawnWaterParcel(
              7,
              plane.x,
              plane.y,
              plane.z,
              plane.vx,
              plane.vy,
              plane.vz,
              Math.max(10, plane.y - terrain.getHeight(plane.x, plane.z)),
              dropCount
            );
            dropped++;
            if (dropped >= 12) break;
          }
          plane.x += plane.vx * 0.1;
          plane.z += plane.vz * 0.1;
          plane.y = Math.max(terrain.waterLevel, terrain.getHeight(plane.x, plane.z)) + 36;
        }
      }

      for (let tick = 0; tick < 10; tick++) {
        sim.step(0.1, 1);
        worldEvents.push(...sim.drainWorldEvents());
      }
      if (sim.status === 'victory') {
        victorySec = sec;
        break;
      }
    }

    assert.equal(sim.status, 'victory', `1 solo pilot must contain op01 within 4 min (burnLeft=${sim.burningCount})`);
    assert.ok(victorySec > 0 && victorySec < 240, `solo victory achieved in ${victorySec}s`);
    assert.equal(sim.cabinsAlive, sim.cabinsTotal, 'all cabins protected during solo victory');
    assert.ok(worldEvents.some((e) => e.type === 'fire_contained'), 'fire_contained world event emitted');
  });

  it('awards +70 primary and +35 co-bomber assist (>= 15% share) within 3 s window', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

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

  it('detects CABIN AT RISK within 48 m, emits cabin_at_risk world event, damages within 24 m, and awards +500 Cabin Saved', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

    sim.cells.fill(0);
    sim.intensityF.fill(0);
    sim.activePos.fill(-1);
    sim.activeCount = 0;
    sim.drainWorldEvents();

    const cab = terrain.cabins[0];
    const { gx, gz } = terrain.worldToGrid(cab.x, cab.z);
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

    const wEvents = [];
    for (let i = 0; i < 35; i++) {
      sim.step(0.1, 1);
      wEvents.push(...sim.drainWorldEvents());
    }
    assert.equal(sim.cabinAtRisk[0], 1, 'cabin 0 marked AT RISK');
    assert.ok(wEvents.some((e) => e.type === 'cabin_at_risk'), 'cabin_at_risk world event emitted');
    assert.ok(sim.cabinHp[0] < 100, `cabin 0 took fire damage (hp=${sim.cabinHp[0]})`);

    const groundY = terrain.getHeight(firePos.x, firePos.z);
    for (let k = 0; k < 4; k++) {
      sim.spawnWaterParcel(7, firePos.x, groundY + 0.5, firePos.z, 0, -20, 0, 28);
    }
    for (let i = 0; i < sim.cells.length; i++) {
      if (sim.cells[i] >= 1 && sim.cells[i] <= 12 && i !== fireIdx) {
        const p = terrain.gridToWorld(i % terrain.gridSize, Math.floor(i / terrain.gridSize));
        sim.spawnWaterParcel(7, p.x, terrain.getHeight(p.x, p.z) + 0.5, p.z, 0, -20, 0, 24);
      }
    }
    const delta = sim.step(0.1, 1);
    const savedEv = delta.scoreEvents.find((e) => e.kind === 'cabin' && e.pts === SCORE.CABIN_SAVED);
    assert.ok(savedEv, 'awarded +500 Cabin Saved');
    assert.equal(savedEv.slotId, 7);
    assert.equal(sim.cabinAtRisk[0], 0);
  });

  it('round-trips MP fireKey + fireRing delta (including mirrored dropOutcomes) and handles 15 s rolling intermission + operation_advance', () => {
    const terrain = generateTerrain(MEGA_BASIN_OP);
    const hostSim = new FireSim(terrain, { isMegaBasin: true });
    const replicaSim = new FireSim(terrain, { isMegaBasin: true });

    for (let i = 0; i < 10; i++) hostSim.step(0.1, 10);
    const fullKey = hostSim.encodeFullState();
    replicaSim.applyExternalKey(fullKey);
    assert.deepEqual(replicaSim.cells, hostSim.cells);
    assert.equal(replicaSim.burningCount, hostSim.burningCount);

    // Apply delta + compact mirrored remote drop outcome tuple `o` (including optional qualityCode)
    const delta = hostSim.step(0.1, 10);
    assert.equal(delta.fullReset, false, 'normal step sets fullReset: false');
    delta.o = [[7, 120, -45, 14, 980, 0, 0, 0, 0, 1, 1, 88]];
    replicaSim.applyExternalDelta(delta);
    assert.deepEqual(replicaSim.cells, hostSim.cells);
    const mirrored = replicaSim.drainDropOutcomes();
    assert.equal(mirrored.length, 1);
    assert.equal(mirrored[0].slotId, 7);
    assert.equal(mirrored[0].outcome, 'direct');
    assert.equal(mirrored[0].cellsExtinguished, 14);
    assert.equal(mirrored[0].cabinSaved, true);
    assert.equal(mirrored[0].dropQuality, DROP_QUALITY_CODES[1]);
    assert.equal(mirrored[0].releaseAgl, 88);

    hostSim.cabinHp[0] = 40;
    hostSim.cabinHpF[0] = 40;

    // Extinguish all fires on host -> enters 15 s intermission -> emits fire_contained & operation_advance
    hostSim.cells.fill(0);
    hostSim.intensityF.fill(0);
    hostSim.activePos.fill(-1);
    hostSim.activeCount = 0;
    hostSim.drainWorldEvents();

    const preScore = hostSim.missionScore;
    const enterIntermission = hostSim.step(0.1, 10);
    assert.equal(enterIntermission.fullReset, false);
    assert.equal(hostSim.status, 'intermission');
    assert.equal(hostSim.missionScore, preScore + SCORE.WAVE_CONTAINED);
    assert.ok(hostSim.intermissionTimer > 14.5);
    assert.ok(hostSim.drainWorldEvents().some((e) => e.type === 'fire_contained'));

    let resetDelta = null;
    const advEvents = [];
    for (let i = 0; i < 155; i++) {
      const d = hostSim.step(0.1, 10);
      advEvents.push(...hostSim.drainWorldEvents());
      if (d.fullReset) {
        assert.equal(resetDelta, null, 'fullReset fires exactly once on wave transition');
        resetDelta = d;
      }
    }
    assert.ok(resetDelta, 'Wave 2 transition emitted fullReset: true');
    assert.equal(resetDelta.advanceOperation, true, 'contained intermission sets advanceOperation: true');
    assert.ok(advEvents.some((e) => e.type === 'operation_advance'), 'operation_advance world event emitted');
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

    const wireKey = hostSim.encodeFullState();
    delete wireKey.cabinAtRisk;

    replicaSim.applyExternalKey(wireKey);
    assert.equal(replicaSim.cabinAtRisk[0], 1, 'replica cabinAtRisk populated on applyExternalKey');
    assert.ok(replicaSim.atRiskTarget, 'replica atRiskTarget populated on applyExternalKey');
  });

  it('does NOT award phantom slot 7 +500 Cabin Saved when nearby fire burns out naturally', () => {
    const terrain = generateTerrain(OPERATIONS[0]);
    const sim = new FireSim(terrain);

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

    sim.cells[fireIdx] = 6;
    sim.intensityF[fireIdx] = 6.0;
    sim.burnDuration[fireIdx] = 4.0;
    sim.fuelRemaining[fireIdx] = 0.72;
    sim._addActive(fireIdx);

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

    const clusters = sim.hotClusters.length > 0 ? sim.hotClusters : [{ x: 0, z: 0, y: 40 }];
    for (let i = 0; i < 40; i++) {
      for (let p = 0; p < 30; p++) {
        const cl = clusters[p % clusters.length];
        sim.spawnWaterParcel((i * 7 + p) % 100, cl.x + ((p * 17) % 80) - 40, cl.y + 42, cl.z + ((p * 23) % 80) - 40, 20, -2, -15, 42);
      }
      sim.step(0.1, 100);
      sim.drainDropOutcomes();
    }

    const timesMs = [];

    for (let tick = 0; tick < 200; tick++) {
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
      sim.drainDropOutcomes();
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
