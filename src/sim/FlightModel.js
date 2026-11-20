/**
 * EMBER FRONT — Fixed-60Hz Arcade Floatplane Flight Model
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
  SCOOP_ENTER_AGL: 5.0,
  SCOOP_EXIT_AGL: 6.5,
  SCOOP_RATE: 52.0,
  SCOOP_DRAG: 3.5,
  DROP_RATE: 80.0,
  DROP_GRAVITY: 15.5,
  WIND_DRIFT_FACTOR: 0.35,
  MAX_ROLL_DEG: 55,
  ROLL_RATE_DEG_S: 140,
  ROLL_AUTOLEVEL_DEG_S: 65,
  MAX_PITCH_DEG: 35,
  PITCH_RATE_DEG_S: 85,
  PITCH_TRIM_DEG_S: 18,
  MAX_YAW_RATE_RAD_S: 1.15,
  SOFT_CEILING_AGL: 195,
  HARD_CEILING_AGL: 220,
  HYDROPLANE_FLOOR_AGL: 3.5,
  TERRAIN_BOUNCE_AGL: 5.0,
  MIN_DROP_BURST_S: 0.25,
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
 * Create a new AircraftState matching docs/INTERFACES.md §3.
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

  return {
    x: opts.x ?? -370,
    y: opts.y ?? 62,
    z: opts.z ?? 260,
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
 * Advance aircraft physics by `dt` seconds (designed for fixed 60 Hz, dt = 1/60).
 * Mutates `state` in place and returns `{ events }`.
 */
export function stepFlight(state, input = {}, terrain, dt, options = {}) {
  const events = {
    bounced: false,
    scoopStarted: false,
    scoopEnded: false,
    tankFull: false,
    dropStarted: false,
    dropEnded: false,
  };

  const dtSafe = Math.max(0, Math.min(dt, 0.05));
  if (dtSafe <= 0) return { events };

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

  // 3. Roll dynamics ([-55, +55] deg, 140 deg/s response, 65 deg/s auto-level)
  if (isOob) {
    // Banked auto-turnback toward basin origin (0, 0)
    const inwardYawDeg = normHeading(Math.atan2(-state.x, state.z) * RAD2DEG);
    const err = wrapDeg(inwardYawDeg - state.yawDeg);
    const targetRoll = clamp(err * 0.9, -45, 45);
    state.rollDeg = moveToward(state.rollDeg, targetRoll, FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * dtSafe);
  } else if (Math.abs(rollIn) > 0.01) {
    state.rollDeg += rollIn * FLIGHT_CONSTANTS.ROLL_RATE_DEG_S * dtSafe;
  } else {
    state.rollDeg = moveToward(state.rollDeg, 0, FLIGHT_CONSTANTS.ROLL_AUTOLEVEL_DEG_S * dtSafe);
  }
  state.rollDeg = clamp(state.rollDeg, -FLIGHT_CONSTANTS.MAX_ROLL_DEG, FLIGHT_CONSTANTS.MAX_ROLL_DEG);

  // 4. Pitch dynamics ([-35, +35] deg, 85 deg/s response, 18 deg/s damping)
  if (Math.abs(pitchIn) > 0.01) {
    state.pitchDeg += pitchIn * FLIGHT_CONSTANTS.PITCH_RATE_DEG_S * dtSafe;
  } else {
    state.pitchDeg = moveToward(state.pitchDeg, 0, FLIGHT_CONSTANTS.PITCH_TRIM_DEG_S * dtSafe);
  }

  // Stall guard (< 120 km/h -> soft nose-down assist -12 deg/s until > 128 km/h)
  if (state.speedKmh < 120) {
    state.stallWarn = true;
  } else if (state.speedKmh > 128) {
    state.stallWarn = false;
  }
  if (state.stallWarn) {
    state.pitchDeg -= 12 * dtSafe;
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

  // 5. Coordinated turn heading rate: clamp((14.5 * tan(roll)) / v_ms, -1.15, 1.15)
  const rollRad = state.rollDeg * DEG2RAD;
  const pitchRad = state.pitchDeg * DEG2RAD;
  const vMsPre = Math.max(state.speedKmh / 3.6, 10);
  const yawRateRad = clamp(
    (14.5 * Math.tan(rollRad)) / vMsPre,
    -FLIGHT_CONSTANTS.MAX_YAW_RATE_RAD_S,
    FLIGHT_CONSTANTS.MAX_YAW_RATE_RAD_S
  );
  state.yawDeg = normHeading(state.yawDeg + yawRateRad * RAD2DEG * dtSafe);

  // 6. Airspeed integration (energy exchange, scoop drag, relaxation tau = 2.2 s)
  const energyAccel = -42.0 * Math.sin(pitchRad);
  const relaxAccel = (vTargetKmh - state.speedKmh) / 2.2;
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

  // 8. Surface protection: water hydroplane cushion vs terrain deflect bounce
  if (state.bounceTimer > 0) {
    state.bounceTimer = Math.max(0, state.bounceTimer - dtSafe);
  }

  const { overWater, surfaceY } = getSurfaceHeight(terrain, state.x, state.z);
  let agl = state.y - surfaceY;

  if (overWater) {
    // Hydroplane cushion: floor at waterLevel + 3.5 m, level pitch >= +2 deg
    if (agl <= FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL) {
      state.y = terrain.waterLevel + FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL;
      if (state.pitchDeg < 2) {
        state.pitchDeg = 2;
      }
      if (state.vy < 0) state.vy = 0;
      agl = FLIGHT_CONSTANTS.HYDROPLANE_FLOOR_AGL;
    }
  } else {
    // Terrain deflect bounce (<= 5.0 m AGL over land): nose up +15 deg, 0.4s bounceTimer, -15% speed
    if (agl <= FLIGHT_CONSTANTS.TERRAIN_BOUNCE_AGL) {
      state.y = surfaceY + FLIGHT_CONSTANTS.TERRAIN_BOUNCE_AGL + 0.15;
      state.pitchDeg = Math.max(state.pitchDeg, 15);
      if (state.bounceTimer <= 0) {
        state.speedKmh = Math.max(FLIGHT_CONSTANTS.MIN_SPEED_KMH, state.speedKmh * 0.85);
        events.bounced = true;
      }
      state.bounceTimer = 0.4;
      const newPitchRad = state.pitchDeg * DEG2RAD;
      const newVms = state.speedKmh / 3.6;
      state.vx = Math.sin(yawRad) * Math.cos(newPitchRad) * newVms;
      state.vy = Math.sin(newPitchRad) * newVms;
      state.vz = -Math.cos(yawRad) * Math.cos(newPitchRad) * newVms;
      agl = state.y - surfaceY;
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

  // 9. Scoop hysteresis: enter <= 5.0 m AGL over water, exit >= 6.5 m or leaving water
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
    // Always locally update tank for responsive HUD; in MP replica mode host periodically overrides tankPct.
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
 * Predict ballistic water drop impact point and splash radius on terrain.
 * Uses exact FireSim parcel kinematics: g = 15.5 m/s^2, a_wind = 0.35 * W.
 */
export function predictDropImpact(state, windVx, windVz, terrain) {
  const g = FLIGHT_CONSTANTS.DROP_GRAVITY;
  const awx = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVx;
  const awz = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVz;

  const x0 = state.x;
  const y0 = state.y;
  const z0 = state.z;
  const vx = state.vx;
  const vy = state.vy;
  const vz = state.vz;

  let groundY = Math.max(terrain.waterLevel, terrain.getHeight(x0, z0));
  let tFall = 0.5;
  let ix = x0;
  let iz = z0;

  // 3 fixed-point iterations converge rapidly over sloped alpine terrain
  for (let iter = 0; iter < 3; iter++) {
    const hRel = Math.max(1.0, y0 - groundY);
    const disc = vy * vy + 2 * g * hRel;
    tFall = (vy + Math.sqrt(Math.max(0, disc))) / g;
    ix = x0 + vx * tFall + 0.5 * awx * tFall * tFall;
    iz = z0 + vz * tFall + 0.5 * awz * tFall * tFall;
    groundY = Math.max(terrain.waterLevel, terrain.getHeight(ix, iz));
  }

  const finalH = Math.max(0, y0 - groundY);
  const radius = clamp(14 + 0.22 * finalH, 16, 42);

  return {
    x: ix,
    z: iz,
    y: groundY,
    tFall,
    radius,
  };
}
