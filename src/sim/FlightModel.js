/**
 * EMBER FRONT — Fixed-60Hz Arcade Floatplane Flight Model
 * - Smooth, rock-steady drop-pass handling with crisp auto-leveling
 * - Forgiving lake scooping (<= 9.0 m AGL enter, >= 11.5 m exit, 3.0 m hydroplane cushion, 70%/s refill)
 * - Standing tree hull damage (-30 HP, 0.9 s cooldown) and instant non-water ground crash + 3.5 s respawn
 * - Exact shared ballistic drop predictor matching FireSim water parcel physics
 * Pure simulation module — zero DOM / Three.js dependencies.
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const FLIGHT_CONSTANTS = {
  CRUISE_SPEED_KMH: 158,
  MIN_SPEED_KMH: 115,
  MAX_SPEED_KMH: 210,
  THROTTLE_MIN_KMH: 125,
  THROTTLE_MAX_KMH: 195,
  SCOOP_ENTER_AGL: 9.0,
  SCOOP_EXIT_AGL: 11.5,
  SCOOP_RATE: 70.0,
  SCOOP_DRAG: 2.2,
  DROP_RATE: 80.0,
  DROP_GRAVITY: 40.0,
  WIND_DRIFT_FACTOR: 0.35,
  MAX_ROLL_DEG: 48,
  ROLL_RATE_DEG_S: 105,
  ROLL_AUTOLEVEL_DEG_S: 95,
  MAX_PITCH_DEG: 30,
  PITCH_RATE_DEG_S: 58,
  PITCH_TRIM_DEG_S: 32,
  MAX_YAW_RATE_RAD_S: 1.15,
  SOFT_CEILING_AGL: 195,
  HARD_CEILING_AGL: 220,
  HYDROPLANE_FLOOR_AGL: 3.0,
  GROUND_CRASH_AGL: 1.8,
  TERRAIN_BOUNCE_AGL: 1.8,
  MIN_DROP_BURST_S: 0.25,
  MAX_HP: 100,
  TREE_HIT_DAMAGE: 30,
  TREE_HIT_COOLDOWN_S: 0.9,
  CRASH_RESPAWN_S: 3.5,
};

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function normHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

function moveToward(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/**
 * Shared water splash impact radius (meters) used identically by FireSim & predictDropImpact.
 * Yields ~2.2-2.8x cellSize (~35-45 m on 16 m grids) at normal drop altitudes.
 * @param {number} releaseAgl
 * @param {number} [cellSize=16]
 * @returns {number}
 */
export function computeSplashRadius(releaseAgl, cellSize = 16) {
  const agl = Math.max(0, Number.isFinite(releaseAgl) ? releaseAgl : 40);
  const scale = (cellSize || 16) / 16;
  return clamp((32 + 0.30 * agl) * scale, 34 * scale, 54 * scale);
}

/**
 * Create a new AircraftState matching docs/INTERFACES.md §3 plus hull/crash fields.
 * @param {object} opts
 */
export function createAircraftState(opts = {}) {
  const speedKmh = opts.speedKmh ?? FLIGHT_CONSTANTS.CRUISE_SPEED_KMH;
  const throttle = opts.throttle ?? clamp(
    (speedKmh - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH) /
      (FLIGHT_CONSTANTS.THROTTLE_MAX_KMH - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH),
    0,
    1
  );
  const yawDeg = normHeading(opts.yawDeg ?? 90);
  const pitchDeg = clamp(opts.pitchDeg ?? 0, -FLIGHT_CONSTANTS.MAX_PITCH_DEG, FLIGHT_CONSTANTS.MAX_PITCH_DEG);
  const rollDeg = clamp(opts.rollDeg ?? 0, -FLIGHT_CONSTANTS.MAX_ROLL_DEG, FLIGHT_CONSTANTS.MAX_ROLL_DEG);

  const yawRad = yawDeg * DEG2RAD;
  const pitchRad = pitchDeg * DEG2RAD;
  const vMs = speedKmh / 3.6;
  const cosP = Math.cos(pitchRad);
  const maxHp = opts.maxHp ?? FLIGHT_CONSTANTS.MAX_HP;

  return {
    x: opts.x ?? -335,
    y: opts.y ?? 62,
    z: opts.z ?? 240,
    yawDeg,
    pitchDeg,
    rollDeg,
    speedKmh,
    throttle,
    tankPct: opts.tankPct ?? 100,
    agl: opts.agl ?? 50,
    vx: Math.sin(yawRad) * cosP * vMs,
    vy: Math.sin(pitchRad) * vMs,
    vz: -Math.cos(yawRad) * cosP * vMs,
    scooping: Boolean(opts.scooping ?? false),
    releasing: Boolean(opts.releasing ?? false),
    dropBurstTimer: opts.dropBurstTimer ?? 0,
    stallWarn: Boolean(opts.stallWarn ?? false),
    bounceTimer: opts.bounceTimer ?? 0,
    outOfBounds: Boolean(opts.outOfBounds ?? false),
    autopilot: Boolean(opts.autopilot ?? true),
    callsign: opts.callsign ?? 'EF-07',
    slotId: opts.slotId ?? 7,
    colorIdx: opts.colorIdx ?? 0,
    hp: opts.hp ?? maxHp,
    maxHp,
    crashed: Boolean(opts.crashed ?? false),
    crashTimer: opts.crashTimer ?? 0,
    crashReason: opts.crashReason ?? '',
    treeHitCooldown: opts.treeHitCooldown ?? 0,
  };
}

/**
 * Compute surface height beneath (x, z), using waterLevel when over scoopable water.
 */
function getSurfaceHeight(terrain, x, z) {
  const overWater = terrain.isWater(x, z);
  const h = terrain.getHeight(x, z);
  const surfaceY = overWater ? terrain.waterLevel : Math.max(terrain.waterLevel, h);
  return { overWater, surfaceY };
}

/**
 * Compute a safe perimeter air corridor respawn pose facing inward toward the basin.
 */
function computeRespawnPose(state, terrain) {
  const halfWorld = terrain?.halfWorld ?? 1024;
  const radius = halfWorld * 0.64;
  const slotSeed = typeof state.slotId === 'number' ? state.slotId : 7;
  // Staggered angle on basin perimeter well inside outer mountain ring
  const angleDeg = (slotSeed * 137.508 + 215) % 360;
  const rad = angleDeg * DEG2RAD;
  const rx = Math.sin(rad) * radius;
  const rz = -Math.cos(rad) * radius;
  const groundY = Math.max(terrain.waterLevel, terrain.getHeight(rx, rz));
  const ry = groundY + 68;
  const yawDeg = normHeading(Math.atan2(-rx, rz) * RAD2DEG);
  return { x: rx, y: ry, z: rz, yawDeg, agl: ry - groundY };
}

function triggerCrash(state, reason, events) {
  state.hp = 0;
  state.crashed = true;
  state.crashReason = reason;
  state.crashTimer = FLIGHT_CONSTANTS.CRASH_RESPAWN_S;
  state.tankPct = 0;
  state.releasing = false;
  state.scooping = false;
  state.dropBurstTimer = 0;
  state.stallWarn = false;
  state.vx = 0;
  state.vy = 0;
  state.vz = 0;
  state.speedKmh = 0;

  const crashEv = {
    type: 'plane_crash',
    x: state.x,
    y: state.y,
    z: state.z,
    reason,
  };
  events.planeCrash = crashEv;
  events.flightEvents.push(crashEv);
}

/**
 * Advance aircraft physics by `dt` seconds (designed for fixed 60 Hz, dt = 1/60).
 * Mutates `state` in place and returns `{ events }`.
 *
 * @param {object} state
 * @param {object} [input]
 * @param {import('./TerrainGen.js').TerrainData} terrain
 * @param {number} dt
 * @param {{ externalTankSync?: boolean, fireCells?: Uint8Array|null }} [options]
 */
export function stepFlight(state, input = {}, terrain, dt, options = {}) {
  const events = {
    bounced: false,
    scoopStarted: false,
    scoopEnded: false,
    tankFull: false,
    dropStarted: false,
    dropEnded: false,
    treeHit: null,
    planeCrash: null,
    respawned: false,
    flightEvents: [],
  };

  // Lazily initialize hull fields on legacy state objects if needed
  if (typeof state.maxHp !== 'number') state.maxHp = FLIGHT_CONSTANTS.MAX_HP;
  if (typeof state.hp !== 'number') state.hp = state.maxHp;
  if (typeof state.crashed !== 'boolean') state.crashed = false;
  if (typeof state.crashTimer !== 'number') state.crashTimer = 0;
  if (typeof state.crashReason !== 'string') state.crashReason = '';
  if (typeof state.treeHitCooldown !== 'number') state.treeHitCooldown = 0;

  const dtSafe = Math.max(0, Math.min(dt, 0.05));
  if (dtSafe <= 0) return { events };

  // 0. Handle active crash & 3.5 s auto-respawn timer
  if (state.crashed) {
    state.releasing = false;
    state.scooping = false;
    state.dropBurstTimer = 0;
    state.vx = 0;
    state.vy = 0;
    state.vz = 0;
    state.speedKmh = 0;
    state.crashTimer = Math.max(0, state.crashTimer - dtSafe);

    if (state.crashTimer <= 0) {
      const pose = computeRespawnPose(state, terrain);
      state.x = pose.x;
      state.y = pose.y;
      state.z = pose.z;
      state.yawDeg = pose.yawDeg;
      state.pitchDeg = 0;
      state.rollDeg = 0;
      state.speedKmh = FLIGHT_CONSTANTS.CRUISE_SPEED_KMH;
      state.throttle = clamp(
        (FLIGHT_CONSTANTS.CRUISE_SPEED_KMH - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH) /
          (FLIGHT_CONSTANTS.THROTTLE_MAX_KMH - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH),
        0,
        1
      );
      const yawRad = state.yawDeg * DEG2RAD;
      const vMs = state.speedKmh / 3.6;
      state.vx = Math.sin(yawRad) * vMs;
      state.vy = 0;
      state.vz = -Math.cos(yawRad) * vMs;
      state.agl = pose.agl;
      state.hp = state.maxHp;
      state.tankPct = 0;
      state.crashed = false;
      state.crashReason = '';
      state.crashTimer = 0;
      state.stallWarn = false;
      state.outOfBounds = false;
      state.treeHitCooldown = 1.5;

      events.respawned = true;
      events.flightEvents.push({
        type: 'plane_respawn',
        x: state.x,
        y: state.y,
        z: state.z,
      });
    }
    return { events };
  }

  if (state.treeHitCooldown > 0) {
    state.treeHitCooldown = Math.max(0, state.treeHitCooldown - dtSafe);
  }
  if (state.bounceTimer > 0) {
    state.bounceTimer = Math.max(0, state.bounceTimer - dtSafe);
  }

  const pitchIn = clamp(input.pitch ?? 0, -1, 1);
  const rollIn = clamp(input.roll ?? 0, -1, 1);
  const throttleDelta = clamp(input.throttleDelta ?? 0, -1, 1);

  // 1. Throttle & target cruise speed
  state.throttle = clamp(state.throttle + throttleDelta * 0.6 * dtSafe, 0, 1);
  const vTargetKmh =
    FLIGHT_CONSTANTS.THROTTLE_MIN_KMH +
    (FLIGHT_CONSTANTS.THROTTLE_MAX_KMH - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH) * state.throttle;

  // 2. Basin perimeter fence check (guides smoothly back inward)
  const fenceLimit = terrain.halfWorld * 0.88;
  const hardLimit = terrain.halfWorld * 0.96;
  const isOob = Math.abs(state.x) > fenceLimit || Math.abs(state.z) > fenceLimit;
  state.outOfBounds = isOob;

  // 3. Roll dynamics: smooth bank-in, crisp auto-level when released for rock-steady aiming
  if (isOob) {
    const inwardYawDeg = normHeading(Math.atan2(-state.x, state.z) * RAD2DEG);
    const err = wrapDeg(inwardYawDeg - state.yawDeg);
    const targetRoll = clamp(err * 0.9, -42, 42);
    state.rollDeg = moveToward(state.rollDeg, targetRoll, FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * dtSafe);
  } else if (Math.abs(rollIn) > 0.01) {
    // Slightly gentler fine-control response near wings-level for pinpoint fireline alignment
    const bankMag = Math.abs(state.rollDeg) / FLIGHT_CONSTANTS.MAX_ROLL_DEG;
    const fineFactor = Math.sign(rollIn) === Math.sign(state.rollDeg) || Math.abs(state.rollDeg) < 10
      ? 0.78 + 0.22 * bankMag
      : 1.15; // snappy counter-bank recovery
    state.rollDeg += rollIn * FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * fineFactor * dtSafe;
  } else {
    state.rollDeg = moveToward(state.rollDeg, 0, FLIGHT_CONSTANTS.ROLL_AUTOLEVEL_DEG_S * dtSafe);
  }
  state.rollDeg = clamp(state.rollDeg, -FLIGHT_CONSTANTS.MAX_ROLL_DEG, FLIGHT_CONSTANTS.MAX_ROLL_DEG);

  // 4. Pitch dynamics: smooth response + snappy auto-trim + gentle bank-lift assist
  if (Math.abs(pitchIn) > 0.01) {
    state.pitchDeg += pitchIn * FLIGHT_CONSTANTS.PITCH_RATE_DEG_S * dtSafe;
  } else {
    // Gentle coordinated turn trim keeps nose flat during banking turns
    const bankTrimTarget = Math.min(2.2, (Math.abs(state.rollDeg) / FLIGHT_CONSTANTS.MAX_ROLL_DEG) * 1.8);
    state.pitchDeg = moveToward(state.pitchDeg, bankTrimTarget, FLIGHT_CONSTANTS.PITCH_TRIM_DEG_S * dtSafe);
  }

  // Stall guard (< 120 km/h -> soft nose-down assist -10 deg/s until > 128 km/h)
  if (state.speedKmh < 120) {
    state.stallWarn = true;
  } else if (state.speedKmh > 128) {
    state.stallWarn = false;
  }
  if (state.stallWarn) {
    state.pitchDeg -= 10 * dtSafe;
  }

  // Soft ceiling progressive pitch-down trim above 195 m AGL
  if (state.agl > FLIGHT_CONSTANTS.SOFT_CEILING_AGL) {
    const excess = clamp(
      (state.agl - FLIGHT_CONSTANTS.SOFT_CEILING_AGL) /
        (FLIGHT_CONSTANTS.HARD_CEILING_AGL - FLIGHT_CONSTANTS.SOFT_CEILING_AGL),
      0,
      1
    );
    state.pitchDeg -= (12 + 28 * excess) * dtSafe;
    if (state.agl >= FLIGHT_CONSTANTS.HARD_CEILING_AGL - 1 && state.pitchDeg > 0) {
      state.pitchDeg = 0;
    }
  }

  state.pitchDeg = clamp(state.pitchDeg, -FLIGHT_CONSTANTS.MAX_PITCH_DEG, FLIGHT_CONSTANTS.MAX_PITCH_DEG);

  // 5. Coordinated turn heading rate
  const rollRad = state.rollDeg * DEG2RAD;
  const pitchRad = state.pitchDeg * DEG2RAD;
  const vMsPre = Math.max(state.speedKmh / 3.6, 10);
  const yawRateRad = clamp(
    (15.2 * Math.tan(rollRad)) / vMsPre,
    -FLIGHT_CONSTANTS.MAX_YAW_RATE_RAD_S,
    FLIGHT_CONSTANTS.MAX_YAW_RATE_RAD_S
  );
  state.yawDeg = normHeading(state.yawDeg + yawRateRad * RAD2DEG * dtSafe);

  // 6. Airspeed integration (energy exchange, gentle scoop drag, relaxation tau = 2.0 s)
  const energyAccel = -38.0 * Math.sin(pitchRad);
  const relaxAccel = (vTargetKmh - state.speedKmh) / 2.0;
  const dragAccel = state.scooping ? -FLIGHT_CONSTANTS.SCOOP_DRAG : 0;
  state.speedKmh = clamp(
    state.speedKmh + (energyAccel + relaxAccel + dragAccel) * dtSafe,
    FLIGHT_CONSTANTS.MIN_SPEED_KMH,
    FLIGHT_CONSTANTS.MAX_SPEED_KMH
  );

  // 7. Integrate velocity and position
  const yawRad = state.yawDeg * DEG2RAD;
  const vMs = state.speedKmh / 3.6;
  const cosP = Math.cos(pitchRad);
  const sinP = Math.sin(pitchRad);

  state.vx = Math.sin(yawRad) * cosP * vMs;
  state.vy = sinP * vMs;
  state.vz = -Math.cos(yawRad) * cosP * vMs;

  state.x = clamp(state.x + state.vx * dtSafe, -hardLimit, hardLimit);
  state.y += state.vy * dtSafe;
  state.z = clamp(state.z + state.vz * dtSafe, -hardLimit, hardLimit);

  // 8. Surface & tree collision: ONLY water pickup is forgiving; trees damage hull, land crashes!
  const { overWater, surfaceY } = getSurfaceHeight(terrain, state.x, state.z);
  let agl = state.y - surfaceY;

  if (overWater) {
    // Forgiving smooth hydroplane lift floor over water: zero damage, stays smoothly inside scoop band!
    if (agl <= 5.5 && state.pitchDeg < 0 && pitchIn <= 0.01) {
      state.pitchDeg = moveToward(state.pitchDeg, 0, 52 * dtSafe);
    }
    if (agl <= FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL) {
      state.y = terrain.waterLevel + FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL;
      if (state.pitchDeg < 0) {
        state.pitchDeg = 0;
      }
      if (state.vy < 0) state.vy = 0;
      agl = FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL;
    }
  } else {
    // Ground collision = instant crash (no land bounce-deflect!)
    if (agl <= FLIGHT_CONSTANTS.GROUND_CRASH_AGL) {
      state.y = surfaceY + FLIGHT_CONSTANTS.GROUND_CRASH_AGL;
      state.agl = FLIGHT_CONSTANTS.GROUND_CRASH_AGL;
      triggerCrash(state, 'terrain', events);
      return { events };
    }

    // Standing tree collision = hull damage (-30 HP, 0.9 s cooldown, speed drop + jolt)
    if (
      state.treeHitCooldown <= 0 &&
      agl <= 19.0 &&
      typeof terrain.findCollidingTree === 'function'
    ) {
      const hitTree = terrain.findCollidingTree(
        state.x,
        state.y,
        state.z,
        2.6,
        options.fireCells || null
      );
      if (hitTree) {
        const dmg = FLIGHT_CONSTANTS.TREE_HIT_DAMAGE;
        state.hp = Math.max(0, state.hp - dmg);
        state.treeHitCooldown = FLIGHT_CONSTANTS.TREE_HIT_COOLDOWN_S;
        state.speedKmh = Math.max(FLIGHT_CONSTANTS.MIN_SPEED_KMH, state.speedKmh * 0.84);

        // Deflect slightly away from tree laterally and kick nose up
        const rightX = Math.cos(yawRad);
        const rightZ = Math.sin(yawRad);
        const sideSign = (state.x - hitTree.x) * rightX + (state.z - hitTree.z) * rightZ >= 0 ? 1 : -1;
        state.rollDeg = clamp(
          state.rollDeg + sideSign * 18,
          -FLIGHT_CONSTANTS.MAX_ROLL_DEG,
          FLIGHT_CONSTANTS.MAX_ROLL_DEG
        );
        state.pitchDeg = clamp(
          Math.max(state.pitchDeg + 9, 8),
          -FLIGHT_CONSTANTS.MAX_PITCH_DEG,
          FLIGHT_CONSTANTS.MAX_PITCH_DEG
        );

        const jPitchRad = state.pitchDeg * DEG2RAD;
        const jVms = state.speedKmh / 3.6;
        state.vx = Math.sin(yawRad) * Math.cos(jPitchRad) * jVms;
        state.vy = Math.sin(jPitchRad) * jVms;
        state.vz = -Math.cos(yawRad) * Math.cos(jPitchRad) * jVms;

        const hitEv = {
          type: 'tree_hit',
          x: hitTree.x,
          y: state.y,
          z: hitTree.z,
          damage: dmg,
          hp: state.hp,
        };
        events.treeHit = hitEv;
        events.flightEvents.push(hitEv);

        if (state.hp <= 0) {
          state.agl = agl;
          triggerCrash(state, 'trees', events);
          return { events };
        }
      }
    }
  }

  // Hard ceiling clamp at 220 m AGL
  if (agl > FLIGHT_CONSTANTS.HARD_CEILING_AGL) {
    state.y = surfaceY + FLIGHT_CONSTANTS.HARD_CEILING_AGL;
    if (state.pitchDeg > 0) state.pitchDeg = 0;
    if (state.vy > 0) state.vy = 0;
    agl = FLIGHT_CONSTANTS.HARD_CEILING_AGL;
  }

  state.agl = agl;

  // 9. Forgiving scoop hysteresis: enter <= 9.0 m AGL over water, exit >= 11.5 m or leaving water
  const wasScooping = state.scooping;
  if (!state.scooping) {
    if (overWater && state.agl <= FLIGHT_CONSTANTS.SCOOP_ENTER_AGL) {
      state.scooping = true;
    }
  } else {
    if (!overWater || state.agl >= FLIGHT_CONSTANTS.SCOOP_EXIT_AGL) {
      state.scooping = false;
    }
  }

  if (state.scooping && !wasScooping) events.scoopStarted = true;
  if (!state.scooping && wasScooping) events.scoopEnded = true;

  if (state.scooping) {
    const prevTank = state.tankPct;
    state.tankPct = Math.min(100, state.tankPct + FLIGHT_CONSTANTS.SCOOP_RATE * dtSafe);
    if (prevTank < 100 && state.tankPct >= 100) {
      events.tankFull = true;
    }
  }

  // 10. Water drop & 0.25 s (20%) minimum tactical burst
  const wasReleasing = state.releasing;
  if (input.dropJustPressed && state.tankPct > 0.01 && !state.scooping) {
    state.dropBurstTimer = Math.max(state.dropBurstTimer, FLIGHT_CONSTANTS.MIN_DROP_BURST_S);
  }

  const wantsDrop = Boolean(input.drop) || state.dropBurstTimer > 0;
  if (wantsDrop && state.tankPct > 0 && !state.scooping) {
    state.releasing = true;
    state.tankPct = Math.max(0, state.tankPct - FLIGHT_CONSTANTS.DROP_RATE * dtSafe);
    if (state.dropBurstTimer > 0) {
      state.dropBurstTimer = Math.max(0, state.dropBurstTimer - dtSafe);
    }
    if (state.tankPct <= 0) {
      state.dropBurstTimer = 0;
    }
  } else {
    state.releasing = false;
    if (state.dropBurstTimer > 0) {
      state.dropBurstTimer = Math.max(0, state.dropBurstTimer - dtSafe);
    }
  }

  if (state.releasing && !wasReleasing) events.dropStarted = true;
  if (!state.releasing && wasReleasing) events.dropEnded = true;

  return { events };
}

/**
 * Evaluate active burning/ember cells inside and near a predicted drop zone (zero-GC).
 */
function evaluateFireTarget(impactX, impactZ, radiusM, terrain, fireSource) {
  if (!fireSource || !terrain) {
    return { fireCellsInTarget: 0, nearFireDistM: Infinity };
  }
  const cells = fireSource.cells;
  if (!cells) {
    return { fireCellsInTarget: 0, nearFireDistM: Infinity };
  }

  const gs = terrain.gridSize;
  const cellSize = terrain.cellSize;
  const halfWorld = terrain.halfWorld;
  const rSq = radiusM * radiusM;

  let fireCellsInTarget = 0;
  let nearestSq = Infinity;

  // Fast path: if FireSim instance with sparse activeList, scan activeList directly!
  if (fireSource.activeList && typeof fireSource.activeCount === 'number') {
    const activeList = fireSource.activeList;
    const count = fireSource.activeCount;
    for (let a = 0; a < count; a++) {
      const idx = activeList[a];
      const st = cells[idx];
      if (!((st >= 1 && st <= 12) || st === 15)) continue;
      const gx = idx % gs;
      const gz = (idx - gx) / gs;
      const wx = (gx + 0.5) * cellSize - halfWorld;
      const wz = (gz + 0.5) * cellSize - halfWorld;
      const dx = wx - impactX;
      const dz = wz - impactZ;
      const dSq = dx * dx + dz * dz;
      if (dSq < nearestSq) nearestSq = dSq;
      if (dSq <= rSq) fireCellsInTarget++;
    }
    return {
      fireCellsInTarget,
      nearFireDistM: Number.isFinite(nearestSq) ? Math.sqrt(nearestSq) : Infinity,
    };
  }

  // Snapshot path: scan local +/- 12-cell window (~192 m) around impact first
  const cgx = Math.floor((impactX + halfWorld) / cellSize);
  const cgz = Math.floor((impactZ + halfWorld) / cellSize);
  const searchCells = Math.max(Math.ceil(radiusM / cellSize) + 2, 12);
  const minGz = Math.max(0, cgz - searchCells);
  const maxGz = Math.min(gs - 1, cgz + searchCells);
  const minGx = Math.max(0, cgx - searchCells);
  const maxGx = Math.min(gs - 1, cgx + searchCells);

  for (let gz = minGz; gz <= maxGz; gz++) {
    const wz = (gz + 0.5) * cellSize - halfWorld;
    const dz = wz - impactZ;
    const dzSq = dz * dz;
    const rowBase = gz * gs;
    for (let gx = minGx; gx <= maxGx; gx++) {
      const st = cells[rowBase + gx];
      if (!((st >= 1 && st <= 12) || st === 15)) continue;
      const wx = (gx + 0.5) * cellSize - halfWorld;
      const dx = wx - impactX;
      const dSq = dx * dx + dzSq;
      if (dSq < nearestSq) nearestSq = dSq;
      if (dSq <= rSq) fireCellsInTarget++;
    }
  }

  // Fallback distance to hotClusters / fireHead if no fire in local 192 m window
  if (!Number.isFinite(nearestSq)) {
    const clusters = fireSource.hotClusters;
    if (Array.isArray(clusters)) {
      for (let i = 0; i < clusters.length; i++) {
        const dx = clusters[i].x - impactX;
        const dz = clusters[i].z - impactZ;
        const dSq = dx * dx + dz * dz;
        if (dSq < nearestSq) nearestSq = dSq;
      }
    }
    if (!Number.isFinite(nearestSq) && fireSource.fireHead) {
      const dx = fireSource.fireHead.x - impactX;
      const dz = fireSource.fireHead.z - impactZ;
      nearestSq = dx * dx + dz * dz;
    }
  }

  return {
    fireCellsInTarget,
    nearFireDistM: Number.isFinite(nearestSq) ? Math.sqrt(nearestSq) : Infinity,
  };
}

/**
 * Exact shared ballistic water drop impact predictor.
 * Uses the EXACT same gravity, wind-drift, and splash-radius equations as FireSim's falling parcels.
 *
 * Accepts BOTH:
 *   - New signature:    predictDropImpact(planeState, windState, terrain, fireSim?)
 *   - Legacy signature: predictDropImpact(planeState, windVx, windVz, terrain, fireSim?)
 */
export function predictDropImpact(planeState, windOrVx, terrainOrVz, fireSimOrTerrain, maybeFireSim) {
  let windVx = 0;
  let windVz = 0;
  let terrain = null;
  let fireSource = null;

  if (typeof windOrVx === 'number') {
    windVx = windOrVx;
    windVz = typeof terrainOrVz === 'number' ? terrainOrVz : 0;
    terrain = fireSimOrTerrain;
    fireSource = maybeFireSim || null;
  } else {
    if (windOrVx && typeof windOrVx === 'object') {
      windVx = Number(windOrVx.windVx) || 0;
      windVz = Number(windOrVx.windVz) || 0;
    }
    terrain = terrainOrVz;
    fireSource = fireSimOrTerrain || (windOrVx && windOrVx.cells ? windOrVx : null);
  }

  const g = FLIGHT_CONSTANTS.DROP_GRAVITY;
  const awx = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVx;
  const awz = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVz;

  const x0 = planeState.x;
  const y0 = planeState.y;
  const z0 = planeState.z;

  let vx = planeState.vx;
  let vy = planeState.vy;
  let vz = planeState.vz;
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz)) {
    const yawRad = (planeState.yawDeg ?? 0) * DEG2RAD;
    const pitchRad = (planeState.pitchDeg ?? 0) * DEG2RAD;
    const vMs = (planeState.speedKmh ?? FLIGHT_CONSTANTS.CRUISE_SPEED_KMH) / 3.6;
    vx = Math.sin(yawRad) * Math.cos(pitchRad) * vMs;
    vy = Math.sin(pitchRad) * vMs;
    vz = -Math.cos(yawRad) * Math.cos(pitchRad) * vMs;
  }

  const releaseGroundY = Math.max(terrain.waterLevel, terrain.getHeight(x0, z0));
  const releaseAgl = Math.max(0, y0 - releaseGroundY);

  let groundY = releaseGroundY;
  let tFall = 0.4;
  let ix = x0;
  let iz = z0;

  // 5 damped fixed-point iterations converge tightly even over sloped alpine terrain
  for (let iter = 0; iter < 5; iter++) {
    const hRel = Math.max(0.25, y0 - groundY);
    const disc = vy * vy + 2 * g * hRel;
    const nextT = Math.max(0.02, (vy + Math.sqrt(Math.max(0, disc))) / g);
    tFall = iter === 0 ? nextT : tFall * 0.25 + nextT * 0.75;
    ix = x0 + vx * tFall + 0.5 * awx * tFall * tFall;
    iz = z0 + vz * tFall + 0.5 * awz * tFall * tFall;
    groundY = Math.max(terrain.waterLevel, terrain.getHeight(ix, iz));
  }
  // Final unblended exact evaluation on converged terrain elevation
  const finalH = Math.max(0.25, y0 - groundY);
  tFall = Math.max(0.02, (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * finalH))) / g);
  ix = x0 + vx * tFall + 0.5 * awx * tFall * tFall;
  iz = z0 + vz * tFall + 0.5 * awz * tFall * tFall;
  groundY = Math.max(terrain.waterLevel, terrain.getHeight(ix, iz));

  const radiusM = computeSplashRadius(releaseAgl, terrain.cellSize);

  // Predicted water curtain corridor from immediate release to end of tactical burst
  const tankPct = Number.isFinite(planeState.tankPct) ? planeState.tankPct : 100;
  const burstDur = tankPct > 0
    ? clamp(tankPct / FLIGHT_CONSTANTS.DROP_RATE, FLIGHT_CONSTANTS.MIN_DROP_BURST_S, 1.0)
    : FLIGHT_CONSTANTS.MIN_DROP_BURST_S;

  const corridorStartX = ix;
  const corridorStartZ = iz;
  const corridorEndX = ix + vx * burstDur;
  const corridorEndZ = iz + vz * burstDur;

  const { fireCellsInTarget, nearFireDistM } = evaluateFireTarget(
    ix,
    iz,
    radiusM,
    terrain,
    fireSource
  );
  const onTarget = fireCellsInTarget > 0;

  return {
    impactX: ix,
    impactZ: iz,
    impactY: groundY,
    corridorStartX,
    corridorStartZ,
    corridorEndX,
    corridorEndZ,
    flightTimeSec: tFall,
    radiusM,
    fireCellsInTarget,
    nearFireDistM,
    onTarget,
    // Legacy aliases preserved for backward compatibility
    x: ix,
    z: iz,
    y: groundY,
    tFall,
    radius: radiusM,
  };
}
