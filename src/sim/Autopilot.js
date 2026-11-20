/**
 * EMBER FRONT — DEMO FLIGHT Counter-Clockwise Autopilot State Machine
 * Phases: APPROACH_FIRE -> RELEASE -> TURN_TO_LAKE -> DESCEND_AND_SCOOP -> CLIMB_OUT
 * Uses shared predictDropImpact() for accurate direct-hit drops and maintains safe treetop/terrain clearance.
 * Pure simulation module — zero DOM / Three.js dependencies.
 */

import { FLIGHT_CONSTANTS, predictDropImpact } from './FlightModel.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function normHeading(deg) {
  return ((deg % 360) + 360) % 360;
}

function wrapDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

function bearingDeg(ax, az, tx, tz) {
  return normHeading(Math.atan2(tx - ax, -(tz - az)) * RAD2DEG);
}

/**
 * Sample maximum surface elevation ahead of aircraft along `yawDeg` (plus wing fan)
 * so the autopilot smoothly clears hills, canyon walls, shorelines, and treetops.
 */
function sampleLookaheadSurface(terrain, x, z, yawDeg, distances) {
  const rad = yawDeg * DEG2RAD;
  const fx = Math.sin(rad);
  const fz = -Math.cos(rad);
  const rx = -fz;
  const rz = fx;
  let maxY = Math.max(terrain.waterLevel, terrain.getHeight(x, z));
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    const cx = x + fx * d;
    const cz = z + fz * d;
    const hC = Math.max(terrain.waterLevel, terrain.getHeight(cx, cz));
    if (hC > maxY) maxY = hC;
    const hL = Math.max(terrain.waterLevel, terrain.getHeight(cx - rx * 24, cz - rz * 24));
    if (hL > maxY) maxY = hL;
    const hR = Math.max(terrain.waterLevel, terrain.getHeight(cx + rx * 24, cz + rz * 24));
    if (hR > maxY) maxY = hR;
  }
  return maxY;
}

/**
 * Measure continuous open-water corridor ahead along `yawDeg` (checking wing clearance too).
 */
function waterRunwayAhead(terrain, x, z, yawDeg, maxDist = 300, step = 20) {
  const rad = yawDeg * DEG2RAD;
  const fx = Math.sin(rad);
  const fz = -Math.cos(rad);
  const rx = -fz;
  const rz = fx;
  let clear = 0;
  for (let d = step; d <= maxDist; d += step) {
    const cx = x + fx * d;
    const cz = z + fz * d;
    if (
      !terrain.isWater(cx, cz) ||
      !terrain.isWater(cx - rx * 14, cz - rz * 14) ||
      !terrain.isWater(cx + rx * 14, cz + rz * 14)
    ) {
      break;
    }
    clear = d;
  }
  return clear;
}

export class Autopilot {
  /**
   * @param {import('./TerrainGen.js').TerrainData} terrain
   */
  constructor(terrain) {
    this.terrain = terrain;
    this.reset();
  }

  reset() {
    this.phase = 'APPROACH_FIRE';
    this.phaseTime = 0;
    this.extendTimer = 0;
    this.activeLane = null;
    this.lastTarget = null;
  }

  /**
   * Select best scoop zone and pass direction that produces a smooth
   * counter-clockwise circuit (favoring left bank turn-in).
   */
  _chooseScoopLane(aircraft) {
    const zones = this.terrain.scoopZones;
    if (!zones || zones.length === 0) {
      return {
        zone: { x: 0, z: 0, headingDeg: 0, length: 500, width: 180 },
        dirDeg: 0,
        entryX: 0,
        entryZ: 200,
        exitX: 0,
        exitZ: -200,
        ux: 0,
        uz: -1,
        rx: 1,
        rz: 0,
        halfRun: 200,
      };
    }

    let bestScore = Infinity;
    let bestLane = null;

    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      // Use a tight ~260 m half-run so scoop circuits stay crisp (~22-26 s) instead of flying past the lake ends
      const halfRun = Math.min(z.length * 0.34, 240);

      for (let flip = 0; flip < 2; flip++) {
        const dirDeg = normHeading(z.headingDeg + flip * 180);
        const rad = dirDeg * DEG2RAD;
        const ux = Math.sin(rad);
        const uz = -Math.cos(rad);
        const rx = -uz;
        const rz = ux;

        const entryX = z.x - ux * halfRun;
        const entryZ = z.z - uz * halfRun;
        const exitX = z.x + ux * halfRun;
        const exitZ = z.z + uz * halfRun;

        const interceptX = entryX - ux * 85;
        const interceptZ = entryZ - uz * 85;

        const distIntercept = Math.hypot(interceptX - aircraft.x, interceptZ - aircraft.z);
        const toInterceptDeg = bearingDeg(aircraft.x, aircraft.z, interceptX, interceptZ);
        const turnErr = wrapDeg(toInterceptDeg - aircraft.yawDeg);

        const ccwBias = turnErr < 0 ? -110 : 60;
        const tooClosePenalty = distIntercept < 160 ? (160 - distIntercept) * 2.5 : 0;
        const alignErr = Math.abs(wrapDeg(dirDeg - toInterceptDeg));

        const score = distIntercept + alignErr * 1.8 + ccwBias + tooClosePenalty;
        if (score < bestScore) {
          bestScore = score;
          bestLane = { zone: z, dirDeg, entryX, entryZ, exitX, exitZ, ux, uz, rx, rz, halfRun };
        }
      }
    }

    if (!bestLane) {
      const z = zones[0];
      const halfRun = Math.min(z.length * 0.36, 260);
      const dirDeg = normHeading(z.headingDeg);
      const rad = dirDeg * DEG2RAD;
      const ux = Math.sin(rad);
      const uz = -Math.cos(rad);
      bestLane = {
        zone: z,
        dirDeg,
        entryX: z.x - ux * halfRun,
        entryZ: z.z - uz * halfRun,
        exitX: z.x + ux * halfRun,
        exitZ: z.z + uz * halfRun,
        ux,
        uz,
        rx: -uz,
        rz: ux,
        halfRun,
      };
    }

    return bestLane;
  }

  _commandRoll(aircraft, desiredRollDeg) {
    return clamp((desiredRollDeg - aircraft.rollDeg) / 14, -1, 1);
  }

  _commandPitch(aircraft, desiredPitchDeg) {
    return clamp((desiredPitchDeg - aircraft.pitchDeg) / 10, -1, 1);
  }

  _commandSpeed(aircraft, targetSpeedKmh) {
    const targetThrottle = clamp(
      (targetSpeedKmh - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH) /
        (FLIGHT_CONSTANTS.THROTTLE_MAX_KMH - FLIGHT_CONSTANTS.THROTTLE_MIN_KMH),
      0,
      1
    );
    return clamp((targetThrottle - aircraft.throttle) * 4.0, -1, 1);
  }

  _altitudePitch(aircraft, targetY, maxClimb = 18, maxDive = -14) {
    const altErr = targetY - aircraft.y;
    const desiredPitch = clamp(altErr * 0.65 - aircraft.vy * 0.55, maxDive, maxClimb);
    return this._commandPitch(aircraft, desiredPitch);
  }

  /**
   * Advance autopilot state machine and return flight control inputs.
   */
  update(aircraft, fireSnapshot = {}, dt = 1 / 60, fireSim = null) {
    this.phaseTime += dt;
    if (this.extendTimer > 0) {
      this.extendTimer = Math.max(0, this.extendTimer - dt);
    }

    const windVx = fireSnapshot.windVx ?? 0;
    const windVz = fireSnapshot.windVz ?? 0;
    const primaryTarget = fireSnapshot.atRiskCabin || fireSnapshot.atRiskTarget || fireSnapshot.fireHead || null;

    let pitch = 0;
    let roll = 0;
    let throttleDelta = 0;
    let drop = false;
    let dropJustPressed = false;

    const overWaterNow = this.terrain.isWater(aircraft.x, aircraft.z);
    const lookaheadY = sampleLookaheadSurface(
      this.terrain,
      aircraft.x,
      aircraft.z,
      aircraft.yawDeg,
      [35, 85, 155, 240, 340]
    );
    const nearLandY = sampleLookaheadSurface(
      this.terrain,
      aircraft.x,
      aircraft.z,
      aircraft.yawDeg,
      [25, 65, 115, 165]
    );

    if (this.phase === 'APPROACH_FIRE' && aircraft.tankPct <= 10) {
      this.activeLane = this._chooseScoopLane(aircraft);
      this.phase = 'TURN_TO_LAKE';
      this.phaseTime = 0;
    }

    switch (this.phase) {
      case 'APPROACH_FIRE': {
        const target = primaryTarget || { x: 0, z: 0 };
        this.lastTarget = target;

        // Shared exact ballistic predictor (matches FireSim parcel impact!)
        const fireSource = fireSim || fireSnapshot;
        const impact = predictDropImpact(aircraft, fireSnapshot, this.terrain, fireSource);
        const windLeadX = 0.5 * FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVx * impact.flightTimeSec * impact.flightTimeSec;
        const windLeadZ = 0.5 * FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVz * impact.flightTimeSec * impact.flightTimeSec;
        const aimX = target.x - windLeadX;
        const aimZ = target.z - windLeadZ;

        const distAim = Math.hypot(aimX - aircraft.x, aimZ - aircraft.z);
        const desiredYaw = bearingDeg(aircraft.x, aircraft.z, aimX, aimZ);
        const headingErr = wrapDeg(desiredYaw - aircraft.yawDeg);

        if (distAim < 165 && Math.abs(headingErr) > 70 && this.extendTimer <= 0) {
          this.extendTimer = 2.4;
        }

        const desiredRoll = this.extendTimer > 0 ? 0 : clamp(headingErr * 1.15, -42, 42);
        roll = this._commandRoll(aircraft, desiredRoll);

        const targetGroundY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(target.x, target.z));
        const curGroundY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(aircraft.x, aircraft.z));
        // Cruise right in peak optimal drop envelope (36-40 m AGL), well above all treetops (<= 16 m)
        const desiredY = Math.max(curGroundY + 38, lookaheadY + 32, targetGroundY + 38);
        pitch = this._altitudePitch(aircraft, desiredY, 18, -12);
        throttleDelta = this._commandSpeed(aircraft, 156);

        if (primaryTarget && aircraft.tankPct > 15 && aircraft.agl >= 24) {
          const impactDist = Math.hypot(impact.impactX - target.x, impact.impactZ - target.z);
          const hasCells = Boolean(fireSource && fireSource.cells);
          // Wait until impact footprint solidly overlaps the fire core (not grazing edge 45m early)
          const lockedOnFire = hasCells
            ? impact.onTarget &&
              (impact.fireCellsInTarget >= 6 ||
                impactDist <= impact.radiusM * 0.78 ||
                (impact.fireCellsInTarget >= 1 && impactDist <= impact.radiusM * 1.15 && Math.abs(headingErr) < 28))
            : impactDist <= Math.max(36, impact.radiusM * 0.85);

          if (lockedOnFire || (impactDist <= Math.max(32, impact.radiusM * 0.72) && Math.abs(headingErr) < 25)) {
            this.phase = 'RELEASE';
            this.phaseTime = 0;
            drop = true;
            dropJustPressed = true;
          }
        } else if (!primaryTarget && aircraft.tankPct < 80) {
          this.activeLane = this._chooseScoopLane(aircraft);
          this.phase = 'TURN_TO_LAKE';
          this.phaseTime = 0;
        }
        break;
      }

      case 'RELEASE': {
        drop = aircraft.tankPct > 0.5;
        roll = this._commandRoll(aircraft, 0);
        const curGroundY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(aircraft.x, aircraft.z));
        const desiredY = Math.max(curGroundY + 38, lookaheadY + 32);
        pitch = this._altitudePitch(aircraft, desiredY, 16, -10);
        throttleDelta = this._commandSpeed(aircraft, 154);

        if (aircraft.tankPct <= 0.5 || this.phaseTime >= 2.2) {
          drop = false;
          this.activeLane = this._chooseScoopLane(aircraft);
          this.phase = 'TURN_TO_LAKE';
          this.phaseTime = 0;
          this.extendTimer = 0;
        }
        break;
      }

      case 'TURN_TO_LAKE': {
        if (!this.activeLane) {
          this.activeLane = this._chooseScoopLane(aircraft);
        }
        const lane = this.activeLane;

        const relX = aircraft.x - lane.zone.x;
        const relZ = aircraft.z - lane.zone.z;
        const along = relX * lane.ux + relZ * lane.uz;
        const xTrack = relX * lane.rx + relZ * lane.rz;
        const absXTrack = Math.abs(xTrack);

        const fixAlong = -lane.halfRun - 40;
        const fixX = lane.zone.x + lane.ux * fixAlong;
        const fixZ = lane.zone.z + lane.uz * fixAlong;
        const distFix = Math.hypot(fixX - aircraft.x, fixZ - aircraft.z);

        let aimX;
        let aimZ;
        const linedUpBehind = along < -lane.halfRun + 160 && absXTrack < 180;
        if (linedUpBehind || distFix < 210) {
          const rabbitAlong = Math.min(lane.halfRun, Math.max(-lane.halfRun + 120, along + 240));
          aimX = lane.zone.x + lane.ux * rabbitAlong;
          aimZ = lane.zone.z + lane.uz * rabbitAlong;
        } else {
          const sideSign = xTrack >= 0 ? 1 : -1;
          const lateralLead = absXTrack > 180 ? sideSign * 40 : 0;
          aimX = fixX + lane.rx * lateralLead;
          aimZ = fixZ + lane.rz * lateralLead;
        }

        const desiredYaw = bearingDeg(aircraft.x, aircraft.z, aimX, aimZ);
        const headingErr = wrapDeg(desiredYaw - aircraft.yawDeg);
        const laneAlignErr = Math.abs(wrapDeg(lane.dirDeg - aircraft.yawDeg));

        let desiredRoll;
        if (this.phaseTime < 1.3 && headingErr < -15) {
          desiredRoll = -38;
        } else {
          desiredRoll = clamp(headingErr * 1.35, -45, 45);
        }
        roll = this._commandRoll(aircraft, desiredRoll);

        const runway = overWaterNow
          ? waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, 320, 20)
          : 0;

        // Short shoreline lookahead so we descend promptly as soon as approaching open water
        const shortLandY = sampleLookaheadSurface(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, [22, 55]);
        const distToLake = Math.hypot(lane.entryX - aircraft.x, lane.entryZ - aircraft.z);
        const nearLakeT = clamp(1 - distToLake / 480, 0, 1);
        const desiredLakeAlt = overWaterNow && runway >= 140
          ? 12
          : 38 * (1 - nearLakeT) + 22 * nearLakeT;
        const landClearance = overWaterNow && runway >= 140 ? 6 : 25;
        const desiredY = Math.max(this.terrain.waterLevel + desiredLakeAlt, shortLandY + landClearance);
        pitch = this._altitudePitch(aircraft, desiredY, 18, -16);
        throttleDelta = this._commandSpeed(aircraft, linedUpBehind ? 136 : 160);

        if (
          (overWaterNow && laneAlignErr < 44 && runway >= 150) ||
          (overWaterNow && runway >= 200)
        ) {
          this.phase = 'DESCEND_AND_SCOOP';
          this.phaseTime = 0;
        } else if (this.phaseTime > 26) {
          this.activeLane = this._chooseScoopLane(aircraft);
          this.phaseTime = 0;
        }
        break;
      }

      case 'DESCEND_AND_SCOOP': {
        if (!this.activeLane) {
          this.activeLane = this._chooseScoopLane(aircraft);
        }
        const lane = this.activeLane;

        const relX = aircraft.x - lane.zone.x;
        const relZ = aircraft.z - lane.zone.z;
        const along = relX * lane.ux + relZ * lane.uz;
        const targetAlong = Math.min(lane.halfRun + 180, along + 240);
        const pursuitX = lane.zone.x + lane.ux * targetAlong;
        const pursuitZ = lane.zone.z + lane.uz * targetAlong;

        let desiredYaw = bearingDeg(aircraft.x, aircraft.z, pursuitX, pursuitZ);

        // Hug open water corridor on curved lakes/rivers (e.g. Timberline Gorge S-curve)
        if (overWaterNow) {
          const runCenter = waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, desiredYaw, 280, 20);
          if (runCenter < 200) {
            const runLeft = waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, normHeading(desiredYaw - 22), 280, 20);
            const runRight = waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, normHeading(desiredYaw + 22), 280, 20);
            if (runLeft > runCenter + 30 && runLeft >= runRight) {
              desiredYaw = normHeading(desiredYaw - 22);
            } else if (runRight > runCenter + 30) {
              desiredYaw = normHeading(desiredYaw + 22);
            }
          }
        }

        const headingErr = wrapDeg(desiredYaw - aircraft.yawDeg);
        // Keep wings level (< 12 deg) when skimming low for smooth optimal 75%/s scoop
        const maxScoopBank = aircraft.agl < 13 ? 11 : 28;
        roll = this._commandRoll(aircraft, clamp(headingErr * 0.95, -maxScoopBank, maxScoopBank));

        const runway = overWaterNow
          ? waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, 280, 20)
          : 0;

        if (overWaterNow && runway >= 110) {
          // Brisk glide down onto center of generous 3.0-9.0 m AGL scoop band (~5.2 m AGL)
          const targetY = this.terrain.waterLevel + 5.2;
          const altErr = targetY - aircraft.y;
          const maxDive = aircraft.agl > 14.0 ? -24 : aircraft.agl > 9.5 ? -16 : -8;
          const desiredPitch = clamp(altErr * 1.1 - aircraft.vy * 0.30, maxDive, 12);
          pitch = this._commandPitch(aircraft, desiredPitch);
        } else if (!overWaterNow) {
          // Over land approaching shoreline: stay well above all shoreline pine canopies (>= 28 m)
          const targetY = Math.max(this.terrain.waterLevel + 28, nearLandY + 28);
          pitch = this._altitudePitch(aircraft, targetY, 20, -10);
        } else {
          // Approaching far shoreline (< 110 m water ahead) -> climb early & cleanly above shoreline trees!
          pitch = this._commandPitch(aircraft, 20);
        }

        const targetSpd = aircraft.scooping ? 152 : 134;
        throttleDelta = this._commandSpeed(aircraft, targetSpd);

        if (aircraft.tankPct >= 99.5) {
          this.phase = 'CLIMB_OUT';
          this.phaseTime = 0;
        } else if (
          (overWaterNow && runway < 105) ||
          (!overWaterNow && along > lane.halfRun * 0.6) ||
          this.phaseTime > 14
        ) {
          this.phase = 'CLIMB_OUT';
          this.phaseTime = 0;
        }
        break;
      }

      case 'CLIMB_OUT': {
        const nearEdge =
          Math.abs(aircraft.x) > this.terrain.halfWorld * 0.64 ||
          Math.abs(aircraft.z) > this.terrain.halfWorld * 0.64;

        let desiredRoll = 0;
        if (nearEdge) {
          const inwardYaw = bearingDeg(aircraft.x, aircraft.z, 0, 0);
          desiredRoll = clamp(wrapDeg(inwardYaw - aircraft.yawDeg) * 0.75, -28, 28);
        }
        roll = this._commandRoll(aircraft, desiredRoll);

        const climbPitch = aircraft.agl < 32 || lookaheadY + 32 > aircraft.y ? 20 : 14;
        pitch = this._commandPitch(aircraft, climbPitch);
        throttleDelta = this._commandSpeed(aircraft, 178);

        const safeAgl = aircraft.agl >= 38 && aircraft.y >= Math.max(this.terrain.waterLevel + 38, nearLandY + 28);
        if ((safeAgl && this.phaseTime >= 1.1) || this.phaseTime >= 5.5) {
          if (aircraft.tankPct >= 85) {
            this.phase = 'APPROACH_FIRE';
          } else {
            this.activeLane = this._chooseScoopLane(aircraft);
            this.phase = 'TURN_TO_LAKE';
          }
          this.phaseTime = 0;
          this.extendTimer = 0;
        }
        break;
      }

      default:
        this.phase = 'APPROACH_FIRE';
        this.phaseTime = 0;
        break;
    }

    // Universal treetop & terrain clearance safety override whenever over land
    if (!overWaterNow && (aircraft.agl < 26 || nearLandY + 24 > aircraft.y)) {
      pitch = Math.max(pitch, this._commandPitch(aircraft, 20));
      if (aircraft.agl < 20) {
        roll = this._commandRoll(aircraft, clamp(aircraft.rollDeg, -18, 18));
      }
    }

    return {
      pitch,
      roll,
      throttleDelta,
      drop,
      dropJustPressed,
      phase: this.phase,
    };
  }
}
