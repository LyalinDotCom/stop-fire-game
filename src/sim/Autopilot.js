/**
 * EMBER FRONT — DEMO FLIGHT Counter-Clockwise Autopilot State Machine
 * Phases: APPROACH_FIRE -> RELEASE -> TURN_TO_LAKE -> DESCEND_AND_SCOOP -> CLIMB_OUT
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
 * Sample maximum surface elevation ahead of aircraft along `yawDeg` (plus slight wing fan)
 * so the autopilot smoothly clears hills, canyon walls, and shorelines.
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
    const hL = Math.max(terrain.waterLevel, terrain.getHeight(cx - rx * 22, cz - rz * 22));
    if (hL > maxY) maxY = hL;
    const hR = Math.max(terrain.waterLevel, terrain.getHeight(cx + rx * 22, cz + rz * 22));
    if (hR > maxY) maxY = hR;
  }
  return maxY;
}

/**
 * Measure continuous open-water corridor ahead along `yawDeg`.
 */
function waterRunwayAhead(terrain, x, z, yawDeg, maxDist = 300, step = 20) {
  const rad = yawDeg * DEG2RAD;
  const fx = Math.sin(rad);
  const fz = -Math.cos(rad);
  let clear = 0;
  for (let d = step; d <= maxDist; d += step) {
    if (!terrain.isWater(x + fx * d, z + fz * d)) break;
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
      // Start entry right at the start of the lake so we have maximum scoop runway
      const halfRun = Math.min(z.length * 0.42, 340);

      for (let flip = 0; flip < 2; flip++) {
        const dirDeg = normHeading(z.headingDeg + flip * 180);
        const rad = dirDeg * DEG2RAD;
        const ux = Math.sin(rad);
        const uz = -Math.cos(rad);
        // Right-hand perpendicular vector
        const rx = -uz;
        const rz = ux;

        const entryX = z.x - ux * halfRun;
        const entryZ = z.z - uz * halfRun;
        const exitX = z.x + ux * halfRun;
        const exitZ = z.z + uz * halfRun;

        const interceptX = entryX - ux * 80;
        const interceptZ = entryZ - uz * 80;

        const distIntercept = Math.hypot(interceptX - aircraft.x, interceptZ - aircraft.z);
        const toInterceptDeg = bearingDeg(aircraft.x, aircraft.z, interceptX, interceptZ);
        const turnErr = wrapDeg(toInterceptDeg - aircraft.yawDeg);

        // Favor counter-clockwise (left turn: negative turnErr) & moderate entry separation
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

    // Fallback if all intercepts were near edge
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
    return clamp((desiredRollDeg - aircraft.rollDeg) / 16, -1, 1);
  }

  _commandPitch(aircraft, desiredPitchDeg) {
    return clamp((desiredPitchDeg - aircraft.pitchDeg) / 12, -1, 1);
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

  _altitudePitch(aircraft, targetY, maxClimb = 18, maxDive = -16) {
    const altErr = targetY - aircraft.y;
    const desiredPitch = clamp(altErr * 0.65 - aircraft.vy * 0.55, maxDive, maxClimb);
    return this._commandPitch(aircraft, desiredPitch);
  }

  _impactHitsFire(impact, fireSnapshot) {
    const cells = fireSnapshot?.cells;
    if (!cells) return false;
    const { gx, gz, idx } = this.terrain.worldToGrid(impact.x, impact.z);
    if (idx < 0) return false;
    const gs = this.terrain.gridSize;
    for (let dz = -1; dz <= 1; dz++) {
      const nz = gz + dz;
      if (nz < 0 || nz >= gs) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = gx + dx;
        if (nx < 0 || nx >= gs) continue;
        const st = cells[nz * gs + nx];
        if ((st >= 1 && st <= 12) || st === 15) return true;
      }
    }
    return false;
  }

  /**
   * Advance autopilot state machine and return flight control inputs.
   */
  update(aircraft, fireSnapshot = {}, dt = 1 / 60) {
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
      [45, 100, 175, 260, 350]
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

        const impact = predictDropImpact(aircraft, windVx, windVz, this.terrain);
        const windLeadX = 0.5 * FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVx * impact.tFall * impact.tFall;
        const windLeadZ = 0.5 * FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR * windVz * impact.tFall * impact.tFall;
        const aimX = target.x - windLeadX;
        const aimZ = target.z - windLeadZ;

        const distAim = Math.hypot(aimX - aircraft.x, aimZ - aircraft.z);
        const desiredYaw = bearingDeg(aircraft.x, aircraft.z, aimX, aimZ);
        const headingErr = wrapDeg(desiredYaw - aircraft.yawDeg);

        if (distAim < 165 && Math.abs(headingErr) > 70 && this.extendTimer <= 0) {
          this.extendTimer = 2.4;
        }

        const desiredRoll = this.extendTimer > 0 ? 0 : clamp(headingErr * 1.15, -46, 46);
        roll = this._commandRoll(aircraft, desiredRoll);

        const targetGroundY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(target.x, target.z));
        const curGroundY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(aircraft.x, aircraft.z));
        const desiredY = Math.max(curGroundY + 47, lookaheadY + 34, targetGroundY + 47);
        pitch = this._altitudePitch(aircraft, desiredY, 18, -14);
        throttleDelta = this._commandSpeed(aircraft, 162);

        if (primaryTarget && aircraft.tankPct > 15 && aircraft.agl >= 15) {
          const impactDist = Math.hypot(impact.x - target.x, impact.z - target.z);
          const hitsFireCell = this._impactHitsFire(impact, fireSnapshot);
          if (
            hitsFireCell ||
            impactDist <= Math.max(58, impact.radius + 22) ||
            (distAim < 125 && Math.abs(headingErr) < 20 && impactDist < 95)
          ) {
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
        const desiredY = Math.max(curGroundY + 47, lookaheadY + 32);
        pitch = this._altitudePitch(aircraft, desiredY, 16, -10);
        throttleDelta = this._commandSpeed(aircraft, 158);

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

        // Compute plane position in lane coordinates (along, cross-track)
        const relX = aircraft.x - lane.zone.x;
        const relZ = aircraft.z - lane.zone.z;
        const along = relX * lane.ux + relZ * lane.uz;
        const xTrack = relX * lane.rx + relZ * lane.rz;
        const absXTrack = Math.abs(xTrack);

        // Two-stage final approach intercept staying INSIDE the low valley basin (never over mountain ring!):
        // Stage 1: fly to final intercept fix just behind entry point (-halfRun - 90 m)
        // Stage 2: once near/behind entry, curve cleanly onto lake centerline rabbit
        const fixAlong = -lane.halfRun - 90;
        const fixX = lane.zone.x + lane.ux * fixAlong;
        const fixZ = lane.zone.z + lane.uz * fixAlong;
        const distFix = Math.hypot(fixX - aircraft.x, fixZ - aircraft.z);

        let aimX;
        let aimZ;
        const linedUpBehind = along < -lane.halfRun + 140 && absXTrack < 180;
        if (linedUpBehind || distFix < 190) {
          // Pure pursuit onto lake centerline heading lane.dirDeg
          const rabbitAlong = Math.min(lane.halfRun, Math.max(-lane.halfRun + 120, along + 240));
          aimX = lane.zone.x + lane.ux * rabbitAlong;
          aimZ = lane.zone.z + lane.uz * rabbitAlong;
        } else {
          // Aim slightly outside the fix so the turn rolls out onto the lake centerline
          const sideSign = xTrack >= 0 ? 1 : -1;
          const lateralLead = absXTrack > 180 ? sideSign * 45 : 0;
          aimX = fixX + lane.rx * lateralLead;
          aimZ = fixZ + lane.rz * lateralLead;
        }

        const desiredYaw = bearingDeg(aircraft.x, aircraft.z, aimX, aimZ);
        const headingErr = wrapDeg(desiredYaw - aircraft.yawDeg);
        const laneAlignErr = Math.abs(wrapDeg(lane.dirDeg - aircraft.yawDeg));

        // Signature sweeping counter-clockwise left bank (-38 deg) on initial turn toward lake
        let desiredRoll;
        if (this.phaseTime < 1.6 && headingErr < -15) {
          desiredRoll = -38;
        } else {
          desiredRoll = clamp(headingErr * 1.35, -50, 50);
        }
        roll = this._commandRoll(aircraft, desiredRoll);

        // Descend progressively toward 14 m above lake while clearing ONLY nearby land hills (not far-side mountains!)
        const distToLake = Math.hypot(lane.entryX - aircraft.x, lane.entryZ - aircraft.z);
        const nearLakeT = clamp(1 - distToLake / 550, 0, 1);
        const desiredLakeAlt = 38 * (1 - nearLakeT) + 14 * nearLakeT;
        const nearLandY = sampleLookaheadSurface(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, [35, 85, 145]);
        const landClearance = overWaterNow ? 6 : 15;
        const desiredY = Math.max(this.terrain.waterLevel + desiredLakeAlt, nearLandY + landClearance);
        pitch = this._altitudePitch(aircraft, desiredY, 18, -16);
        throttleDelta = this._commandSpeed(aircraft, linedUpBehind ? 136 : 154);

        const runway = overWaterNow
          ? waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, 320, 20)
          : 0;

        // Enter DESCEND_AND_SCOOP when aligned with lake axis & plenty of open water ahead
        if (
          (overWaterNow && laneAlignErr < 38 && runway >= 200) ||
          (linedUpBehind && laneAlignErr < 28 && distToLake < 160)
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
        const maxScoopBank = aircraft.agl < 12 ? 20 : 32;
        roll = this._commandRoll(aircraft, clamp(headingErr * 0.95, -maxScoopBank, maxScoopBank));

        const runway = overWaterNow
          ? waterRunwayAhead(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, 260, 20)
          : 0;

        if (overWaterNow && runway >= 85) {
          // Over open water with runway ahead: crisp descent onto 4.0 m AGL skim (hydroplane cushion protects <= 3.5 m)
          const targetY = this.terrain.waterLevel + 4.0;
          const altErr = targetY - aircraft.y;
          const maxDive = aircraft.agl > 6.5 ? -22 : -10;
          const desiredPitch = clamp(altErr * 1.15 - aircraft.vy * 0.28, maxDive, 12);
          pitch = this._commandPitch(aircraft, desiredPitch);
        } else if (!overWaterNow) {
          // Still over land approaching shoreline — stay cleanly above shoreline trees
          const shoreLook = sampleLookaheadSurface(this.terrain, aircraft.x, aircraft.z, aircraft.yawDeg, [30, 75, 120]);
          const targetY = Math.max(this.terrain.waterLevel + 14, shoreLook + 14);
          pitch = this._altitudePitch(aircraft, targetY, 18, -12);
        } else {
          // Approaching far shoreline (< 85 m water ahead) -> pull up cleanly!
          pitch = this._commandPitch(aircraft, 16);
        }

        const targetSpd = aircraft.scooping ? 154 : 134;
        throttleDelta = this._commandSpeed(aircraft, targetSpd);

        if (aircraft.tankPct >= 99.5) {
          this.phase = 'CLIMB_OUT';
          this.phaseTime = 0;
        } else if (
          (overWaterNow && runway < 80) ||
          (!overWaterNow && along > lane.halfRun * 0.65) ||
          this.phaseTime > 14
        ) {
          this.phase = 'CLIMB_OUT';
          this.phaseTime = 0;
        }
        break;
      }

      case 'CLIMB_OUT': {
        const nearEdge =
          Math.abs(aircraft.x) > this.terrain.halfWorld * 0.66 ||
          Math.abs(aircraft.z) > this.terrain.halfWorld * 0.66;

        let desiredRoll = 0;
        if (nearEdge) {
          const inwardYaw = bearingDeg(aircraft.x, aircraft.z, 0, 0);
          desiredRoll = clamp(wrapDeg(inwardYaw - aircraft.yawDeg) * 0.75, -30, 30);
        }
        roll = this._commandRoll(aircraft, desiredRoll);

        const climbPitch = aircraft.agl < 26 || lookaheadY + 28 > aircraft.y ? 16 : 12;
        pitch = this._commandPitch(aircraft, climbPitch);
        throttleDelta = this._commandSpeed(aircraft, 174);

        const safeAgl = aircraft.agl >= 45 && aircraft.y >= Math.max(this.terrain.waterLevel + 45, lookaheadY + 26);
        if ((safeAgl && this.phaseTime >= 1.4) || this.phaseTime >= 6.5) {
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

    // Universal emergency terrain-clearance override when over land
    if (!overWaterNow && aircraft.agl < 18) {
      pitch = Math.max(pitch, this._commandPitch(aircraft, 18));
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
