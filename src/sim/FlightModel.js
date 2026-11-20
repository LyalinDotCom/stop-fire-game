/**
 * EMBER FRONT — Fixed-60Hz Arcade Floatplane Flight Model
 * - Smooth, rock-steady drop-pass handling with crisp auto-leveling
 * - Altitude drop envelope coaching & skill curve (18-52 m optimal 1.8x peak vs >58 m misted vs <16 m low risk)
 * - Convective thermal updraft lift, smoke plume aerodynamic turbulence, & low-flame extreme heat ticks
 * - Realistic heavy-tank inertia (~13% slower climb/roll loaded) & upward drop buoyancy surge on release
 * - Forgiving water-skim survival (0 damage, 3.0 m hydroplane cushion) + skillful optimal vs rough scooping
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
  SCOOP_RATE: 75.0,
  SCOOP_RATE_OPTIMAL: 75.0,
  SCOOP_RATE_ROUGH: 30.0,
  SCOOP_OPTIMAL_MAX_ROLL_DEG: 16,
  SCOOP_OPTIMAL_MIN_SPEED_KMH: 120,
  SCOOP_OPTIMAL_MAX_SPEED_KMH: 175,
  SCOOP_DRAG: 2.2,
  DROP_RATE: 80.0,
  DROP_GRAVITY: 40.0,
  WIND_DRIFT_FACTOR: 0.35,
  DROP_BUOYANCY_VY: 3.4,
  TANK_WEIGHT_PENALTY: 0.13,
  DROP_ALT_TOO_LOW: 16.0,
  DROP_ALT_MIN_OPTIMAL: 18.0,
  DROP_ALT_MAX_OPTIMAL: 52.0,
  DROP_ALT_TOO_HIGH: 58.0,
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
  HEAT_TICK_COOLDOWN_S: 0.85,
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
 * Evaluate the aerial firefighting altitude drop envelope for a given AGL.
 * - `< 16 m`: `'too_low'` / `'low_risk'` — narrow splash + thermal danger over flames
 * - `16–58 m` (ideal `18–52 m`, peak `25–42 m`): `'optimal'` — concentrated dense curtain (up to 1.8x cooling!)
 * - `> 58 m`: `'too_high'` / `'misted_high'` — wind shears load into wide mist (1.0x at 55m -> 0.22x at 100m+)
 *
 * @param {number} releaseAgl
 * @returns {{ altZone: 'optimal'|'too_high'|'too_low', dropQuality: 'optimal'|'misted_high'|'low_risk', coolingMult: number, radiusMult: number, releaseAgl: number }}
 */
export function evaluateDropAltitude(releaseAgl) {
  const agl = Math.max(0, Number.isFinite(releaseAgl) ? releaseAgl : 35);

  if (agl < FLIGHT_CONSTANTS.DROP_ALT_TOO_LOW) {
    const t = clamp(agl / FLIGHT_CONSTANTS.DROP_ALT_TOO_LOW, 0, 1);
    return {
      altZone: 'too_low',
      dropQuality: 'low_risk',
      coolingMult: 1.05 + 0.15 * t,
      radiusMult: 0.66 + 0.16 * t,
      releaseAgl: agl,
    };
  }

  if (agl <= FLIGHT_CONSTANTS.DROP_ALT_TOO_HIGH) {
    let coolingMult;
    let radiusMult;
    if (agl >= 25 && agl <= 42) {
      coolingMult = 1.8;
      radiusMult = 1.0;
    } else if (agl < 25) {
      const u = clamp((agl - 16) / 9, 0, 1);
      coolingMult = 1.2 + 0.6 * u;
      radiusMult = 0.85 + 0.15 * u;
    } else if (agl <= 52) {
      const u = clamp((agl - 42) / 10, 0, 1);
      coolingMult = 1.8 - 0.65 * u;
      radiusMult = 1.0;
    } else {
      const u = clamp((agl - 52) / 6, 0, 1);
      coolingMult = 1.15 - 0.43 * u;
      radiusMult = 1.0 + 0.08 * u;
    }
    return {
      altZone: 'optimal',
      dropQuality: 'optimal',
      coolingMult,
      radiusMult,
      releaseAgl: agl,
    };
  }

  // > 58 m AGL: wind shear & convective evaporation shred water load into weak wide mist
  // Decays sharply from 0.72x @ 58 m -> ~0.25x @ 70 m -> ~0.05x @ 88 m -> 0.04x floor @ 95 m+
  const excess = Math.max(0, agl - FLIGHT_CONSTANTS.DROP_ALT_TOO_HIGH);
  const coolingMult = Math.max(0.04, 0.72 * Math.exp(-excess / 11.5));
  const radiusMult = 1.08 + 0.56 * clamp(excess / 42, 0, 1);
  return {
    altZone: 'too_high',
    dropQuality: 'misted_high',
    coolingMult,
    radiusMult,
    releaseAgl: agl,
  };
}

/**
 * Shared water splash impact radius (meters) used identically by FireSim & predictDropImpact.
 * Tight & dense in optimal 25-42 m window (~42 m on 16 m grid), narrows < 16 m, widens into mist > 58 m.
 * @param {number} releaseAgl
 * @param {number} [cellSize=16]
 * @returns {number}
 */
export function computeSplashRadius(releaseAgl, cellSize = 16) {
  const agl = Math.max(0, Number.isFinite(releaseAgl) ? releaseAgl : 35);
  const scale = (cellSize || 16) / 16;
  const { radiusMult } = evaluateDropAltitude(agl);
  const baseR = 44.0 * scale;
  return clamp(baseR * radiusMult, 28 * scale, 74 * scale);
}

/**
 * Create a new AircraftState matching docs/INTERFACES.md §3 plus hull, crash, scoop & atmosphere fields.
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
    scoopQuality: opts.scoopQuality ?? 'none',
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
    heatTickCooldown: opts.heatTickCooldown ?? 0,
    turbulence: 0,
    smokeDensity: 0,
    thermalLift: 0,
    heatDanger: 0,
    turbTime: 0,
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
  state.scoopQuality = 'none';
  state.dropBurstTimer = 0;
  state.stallWarn = false;
  state.vx = 0;
  state.vy = 0;
  state.vz = 0;
  state.speedKmh = 0;
  state.turbulence = 0;
  state.smokeDensity = 0;
  state.thermalLift = 0;
  state.heatDanger = 0;

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
 * @param {{ externalTankSync?: boolean, fireCells?: Uint8Array|null, atmosphere?: { smokeDensity?: number, thermalLift?: number, turbulence?: number, heatDanger?: number }|null, fireSim?: object|null }} [options]
 */
export function stepFlight(state, input = {}, terrain, dt, options = {}) {
  const events = {
    bounced: false,
    scoopStarted: false,
    scoopEnded: false,
    scoopRough: false,
    scoopRoughStarted: false,
    tankFull: false,
    dropStarted: false,
    dropEnded: false,
    treeHit: null,
    heatDamage: null,
    planeCrash: null,
    respawned: false,
    flightEvents: [],
  };

  // Lazily initialize extended fields on legacy state objects if needed
  if (typeof state.maxHp !== 'number') state.maxHp = FLIGHT_CONSTANTS.MAX_HP;
  if (typeof state.hp !== 'number') state.hp = state.maxHp;
  if (typeof state.crashed !== 'boolean') state.crashed = false;
  if (typeof state.crashTimer !== 'number') state.crashTimer = 0;
  if (typeof state.crashReason !== 'string') state.crashReason = '';
  if (typeof state.treeHitCooldown !== 'number') state.treeHitCooldown = 0;
  if (typeof state.heatTickCooldown !== 'number') state.heatTickCooldown = 0;
  if (typeof state.scoopQuality !== 'string') state.scoopQuality = 'none';
  if (typeof state.turbTime !== 'number') state.turbTime = 0;

  const dtSafe = Math.max(0, Math.min(dt, 0.05));
  if (dtSafe <= 0) return { events };

  // 0. Handle active crash & 3.5 s auto-respawn timer
  if (state.crashed) {
    state.releasing = false;
    state.scooping = false;
    state.scoopQuality = 'none';
    state.dropBurstTimer = 0;
    state.vx = 0;
    state.vy = 0;
    state.vz = 0;
    state.speedKmh = 0;
    state.turbulence = 0;
    state.smokeDensity = 0;
    state.thermalLift = 0;
    state.heatDanger = 0;
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
      state.heatTickCooldown = 1.0;

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

  state.turbTime += dtSafe;
  if (state.treeHitCooldown > 0) {
    state.treeHitCooldown = Math.max(0, state.treeHitCooldown - dtSafe);
  }
  if (state.heatTickCooldown > 0) {
    state.heatTickCooldown = Math.max(0, state.heatTickCooldown - dtSafe);
  }
  if (state.bounceTimer > 0) {
    state.bounceTimer = Math.max(0, state.bounceTimer - dtSafe);
  }

  const pitchIn = clamp(input.pitch ?? 0, -1, 1);
  const rollIn = clamp(input.roll ?? 0, -1, 1);
  const throttleDelta = clamp(input.throttleDelta ?? 0, -1, 1);

  // Sample fire atmosphere (smoke plumes, convective thermal columns, low-altitude flame heat)
  const atm = options.atmosphere
    ? options.atmosphere
    : options.fireSim && typeof options.fireSim.sampleFireAtmosphere === 'function'
      ? options.fireSim.sampleFireAtmosphere(state.x, state.y, state.z)
      : null;

  const smokeDensity = atm ? clamp(Number(atm.smokeDensity) || 0, 0, 1) : 0;
  const thermalLift = atm ? clamp(Number(atm.thermalLift) || 0, 0, 1) : 0;
  const turbulence = atm ? clamp(Number(atm.turbulence) || 0, 0, 1) : 0;
  const heatDanger = atm ? clamp(Number(atm.heatDanger) || 0, 0, 1) : 0;

  state.smokeDensity = smokeDensity;
  state.thermalLift = thermalLift;
  state.turbulence = turbulence;
  state.heatDanger = heatDanger;

  // Heavy water load inertia: 100% tank feels ~13% heavier on roll & climb authority
  const tankNorm = clamp((state.tankPct ?? 0) / 100, 0, 1);
  const weightAgility = 1.0 - FLIGHT_CONSTANTS.TANK_WEIGHT_PENALTY * tankNorm;

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

  // 3. Roll dynamics: tank-weighted bank-in, crisp auto-level when released (softened in heavy turbulence so wings genuinely rock)
  const apAtmScale = state.autopilot ? 0.35 : 1.0;
  const effectiveTurb = state.scooping ? 0 : turbulence * apAtmScale;
  if (isOob) {
    const inwardYawDeg = normHeading(Math.atan2(-state.x, state.z) * RAD2DEG);
    const err = wrapDeg(inwardYawDeg - state.yawDeg);
    const targetRoll = clamp(err * 0.9, -42, 42);
    state.rollDeg = moveToward(state.rollDeg, targetRoll, FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * dtSafe);
  } else if (Math.abs(rollIn) > 0.01) {
    const bankMag = Math.abs(state.rollDeg) / FLIGHT_CONSTANTS.MAX_ROLL_DEG;
    const fineFactor = Math.sign(rollIn) === Math.sign(state.rollDeg) || Math.abs(state.rollDeg) < 10
      ? 0.78 + 0.22 * bankMag
      : 1.15;
    state.rollDeg += rollIn * FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * fineFactor * weightAgility * dtSafe;
  } else {
    const autoLevelRate = FLIGHT_CONSTANTS.ROLL_AUTOLEVEL_DEG_S * (1.0 - 0.78 * effectiveTurb);
    state.rollDeg = moveToward(state.rollDeg, 0, autoLevelRate * dtSafe);
  }
  state.rollDeg = clamp(state.rollDeg, -FLIGHT_CONSTANTS.MAX_ROLL_DEG, FLIGHT_CONSTANTS.MAX_ROLL_DEG);

  // 4. Pitch dynamics: tank-weighted climb authority + snappy auto-trim + buoyancy relief + gentle bank-lift assist
  if (Math.abs(pitchIn) > 0.01) {
    const pitchWeight = pitchIn > 0 ? weightAgility : 1.0 + 0.05 * tankNorm;
    state.pitchDeg += pitchIn * FLIGHT_CONSTANTS.PITCH_RATE_DEG_S * pitchWeight * dtSafe;
  } else {
    const bankTrimTarget = Math.min(2.2, (Math.abs(state.rollDeg) / FLIGHT_CONSTANTS.MAX_ROLL_DEG) * 1.8);
    const buoyancyTrimBoost = state.releasing ? 4.2 * (state.autopilot ? 0.45 : 1.0) : 0;
    const pitchTrimRate = FLIGHT_CONSTANTS.PITCH_TRIM_DEG_S * (1.0 - 0.65 * effectiveTurb);
    state.pitchDeg = moveToward(state.pitchDeg, bankTrimTarget + buoyancyTrimBoost, pitchTrimRate * dtSafe);
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

  // 4b. Convective thermal updraft & aerodynamic smoke/heat turbulence (applied after trim so wings/nose genuinely buck!)
  let thermalUpdraftMs = 0;
  let turbVertMs = 0;
  if (!state.scooping) {
    if (thermalLift > 0.04) {
      const liftBlend = Math.min(1, thermalLift * 1.8);
      thermalUpdraftMs = (2.5 + 4.0 * thermalLift) * liftBlend * apAtmScale;
      state.pitchDeg += thermalUpdraftMs * 0.55 * dtSafe;
    }
    if (turbulence > 0.04) {
      const t = state.turbTime;
      const gustRoll = Math.sin(t * 7.3) * 0.62 + Math.sin(t * 17.1 + 1.4) * 0.38;
      const gustPitch = Math.cos(t * 6.1 + 0.7) * 0.55 + Math.sin(t * 14.7 + 2.3) * 0.45;
      const gustVert = Math.sin(t * 9.7 + 0.3) * 0.65 + Math.cos(t * 19.3) * 0.35;
      state.rollDeg = clamp(
        state.rollDeg + gustRoll * turbulence * 48.0 * apAtmScale * dtSafe,
        -FLIGHT_CONSTANTS.MAX_ROLL_DEG,
        FLIGHT_CONSTANTS.MAX_ROLL_DEG
      );
      state.pitchDeg += gustPitch * turbulence * 20.0 * apAtmScale * dtSafe;
      turbVertMs = gustVert * turbulence * 4.0 * apAtmScale;
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

  // 6. Airspeed integration (heavier climb energy bleed when loaded, gentle/rough scoop drag)
  const energyAccel = -(35.0 + 7.5 * tankNorm) * Math.sin(pitchRad);
  const relaxAccel = (vTargetKmh - state.speedKmh) / 2.0;
  const dragAccel = state.scooping
    ? -(state.scoopQuality === 'rough' ? FLIGHT_CONSTANTS.SCOOP_DRAG * 2.1 : FLIGHT_CONSTANTS.SCOOP_DRAG)
    : 0;
  state.speedKmh = clamp(
    state.speedKmh + (energyAccel + relaxAccel + dragAccel) * dtSafe,
    FLIGHT_CONSTANTS.MIN_SPEED_KMH,
    FLIGHT_CONSTANTS.MAX_SPEED_KMH
  );

  // 7. Integrate velocity and position (+ convective updraft & turbulence vertical gusts)
  const yawRad = state.yawDeg * DEG2RAD;
  const vMs = state.speedKmh / 3.6;
  const cosP = Math.cos(pitchRad);
  const sinP = Math.sin(pitchRad);

  state.vx = Math.sin(yawRad) * cosP * vMs;
  state.vy = sinP * vMs + thermalUpdraftMs + turbVertMs;
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
    const fireCells = options.fireCells || options.fireSim?.cells || null;
    if (
      state.treeHitCooldown <= 0 &&
      agl <= 19.0 &&
      typeof terrain.findCollidingTree === 'function'
    ) {
      const hitTree = terrain.findCollidingTree(state.x, state.y, state.z, 2.6, fireCells);
      if (hitTree) {
        const dmg = FLIGHT_CONSTANTS.TREE_HIT_DAMAGE;
        state.hp = Math.max(0, state.hp - dmg);
        state.treeHitCooldown = FLIGHT_CONSTANTS.TREE_HIT_COOLDOWN_S;
        state.speedKmh = Math.max(FLIGHT_CONSTANTS.MIN_SPEED_KMH, state.speedKmh * 0.84);

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

    // Extreme convective flame heat hull ticks if flying dangerously low (< 16 m AGL) straight through raging fire
    if (
      !state.autopilot &&
      heatDanger >= 0.45 &&
      agl < FLIGHT_CONSTANTS.DROP_ALT_TOO_LOW + 0.5 &&
      state.heatTickCooldown <= 0
    ) {
      const dmg = Math.round(6 + heatDanger * 8);
      state.hp = Math.max(0, state.hp - dmg);
      state.heatTickCooldown = FLIGHT_CONSTANTS.HEAT_TICK_COOLDOWN_S;

      const heatEv = {
        type: 'heat_damage',
        x: state.x,
        y: state.y,
        z: state.z,
        damage: dmg,
        hp: state.hp,
        heatDanger,
      };
      events.heatDamage = heatEv;
      events.flightEvents.push(heatEv);

      if (state.hp <= 0) {
        state.agl = agl;
        triggerCrash(state, 'heat', events);
        return { events };
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

  // 9. Forgiving scoop hysteresis + skillful technique check (optimal 75%/s vs rough 30%/s)
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
    const prevQuality = state.scoopQuality;
    const isOptimalScoop =
      Math.abs(state.rollDeg) < FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MAX_ROLL_DEG &&
      state.speedKmh >= FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MIN_SPEED_KMH &&
      state.speedKmh <= FLIGHT_CONSTANTS.SCOOP_OPTIMAL_MAX_SPEED_KMH;

    state.scoopQuality = isOptimalScoop ? 'optimal' : 'rough';
    const scoopRate = isOptimalScoop
      ? FLIGHT_CONSTANTS.SCOOP_RATE_OPTIMAL
      : FLIGHT_CONSTANTS.SCOOP_RATE_ROUGH;

    if (!isOptimalScoop) {
      events.scoopRough = true;
      if (prevQuality !== 'rough') {
        events.scoopRoughStarted = true;
      }
      // Choppy spray jolt & wave slap (never damages hull — forgiving survival!)
      const waveChop = Math.sin(state.turbTime * 23.0) * 14.0;
      state.rollDeg = clamp(
        moveToward(state.rollDeg, 0, 22.0 * dtSafe) + waveChop * dtSafe,
        -FLIGHT_CONSTANTS.MAX_ROLL_DEG,
        FLIGHT_CONSTANTS.MAX_ROLL_DEG
      );
      state.pitchDeg = clamp(
        state.pitchDeg + (Math.cos(state.turbTime * 19.0) * 6.0 + 3.0) * dtSafe,
        0,
        FLIGHT_CONSTANTS.MAX_PITCH_DEG
      );
    }

    const prevTank = state.tankPct;
    state.tankPct = Math.min(100, state.tankPct + scoopRate * dtSafe);
    if (prevTank < 100 && state.tankPct >= 100) {
      events.tankFull = true;
    }
  } else {
    state.scoopQuality = 'none';
  }

  // 10. Water drop, 0.25 s minimum tactical burst & upward drop buoyancy lift surge!
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

    // Real upward buoyancy / lift surge as tons of water drop from the belly!
    const buoyancyScale = state.autopilot ? 0.45 : 1.0;
    const buoyancyVy = FLIGHT_CONSTANTS.DROP_BUOYANCY_VY * buoyancyScale;
    state.y += buoyancyVy * dtSafe;
    state.vy += buoyancyVy;
    if (pitchIn >= -0.05) {
      state.pitchDeg = clamp(
        state.pitchDeg + 5.2 * buoyancyScale * dtSafe,
        -FLIGHT_CONSTANTS.MAX_PITCH_DEG,
        FLIGHT_CONSTANTS.MAX_PITCH_DEG
      );
    }
    state.speedKmh = clamp(
      state.speedKmh + 3.0 * buoyancyScale * dtSafe,
      FLIGHT_CONSTANTS.MIN_SPEED_KMH,
      FLIGHT_CONSTANTS.MAX_SPEED_KMH
    );
    state.agl = Math.min(FLIGHT_CONSTANTS.HARD_CEILING_AGL, state.y - surfaceY);
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
 * Uses the EXACT same gravity, wind-drift, altitude-envelope, and splash-radius equations as FireSim.
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
  const finalH = Math.max(0.25, y0 - groundY);
  tFall = Math.max(0.02, (vy + Math.sqrt(Math.max(0, vy * vy + 2 * g * finalH))) / g);
  ix = x0 + vx * tFall + 0.5 * awx * tFall * tFall;
  iz = z0 + vz * tFall + 0.5 * awz * tFall * tFall;
  groundY = Math.max(terrain.waterLevel, terrain.getHeight(ix, iz));

  const altEval = evaluateDropAltitude(releaseAgl);
  const radiusM = computeSplashRadius(releaseAgl, terrain.cellSize);

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
    altZone: altEval.altZone,
    dropQuality: altEval.dropQuality,
    releaseAgl,
    coolingMult: altEval.coolingMult,
    // Legacy aliases preserved for backward compatibility
    x: ix,
    z: iz,
    y: groundY,
    tFall,
    radius: radiusM,
  };
}
