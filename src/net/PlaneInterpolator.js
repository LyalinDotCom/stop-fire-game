// Vanguard-grade remote aircraft interpolation, adaptive jitter smoothing, and never-stop flight kinematics.
// - Adaptive playback delay: >= max(160 ms, 1.55 * ewmaInterval + 2.0 * ewmaJitter) capped at 420 ms,
//   with gentle ±6% clock slew so the buffer stays continuously fed without starving or popping.
// - Fritsch-Carlson monotone cubic Hermite interpolation for (x, y, z) — zero overshoot or rubber-banding.
// - Shortest-arc angle interpolation for yaw, pitch, roll.
// - Never-stop constant-airspeed bank-curved dead-reckoning up to MAX_EXTRAPOLATE_MS (1200 ms):
//   a flying airplane NEVER freezes in mid-air during jitter spikes, late packets, or Host failover!
//   Wings hold steady for 400 ms then gently level out between 400–1200 ms.
// - Smooth exponential error convergence (tau = 190 ms) with forward-speed floor + max-step limiter
//   so delayed packets and Host transfers converge with 0 frozen frames and 0 teleport pops.

export const DELAY_MIN_MS = 160;
export const DELAY_MAX_MS = 420;
export const MAX_EXTRAPOLATE_MS = 1200;

const WINDOW_MS = 6000;
const KEEP_MS = 2600;
const NOMINAL_STEP_MS = 165; // Initial EWMA spacing (adapts smoothly to 125 ms / 165 ms / 250 ms)
const MIN_TIMELINE_STEP_MS = 50; // Keeps clumped arrivals monotonic without distorting 8 Hz cadence
const LEVEL_WINGS_AFTER_SEC = 0.40; // Hold bank 400 ms during extrapolation, then gently level wings
const CORRECTION_TAU_SEC = 0.19; // ~190 ms exponential convergence when delayed packets catch up
const STALE_COAST_MS = 1500; // Per-plane stale threshold -> smooth wing-leveling coast
const TELEPORT_SPEED_MS = 260; // > 260 m/s (~936 km/h) or >= 340 m jump (respawn / op change) snaps cleanly
const TELEPORT_MIN_DIST = 140;
const BLEND_MAX_DIST = 340; // Offsets under 340 m blend smoothly; larger respawns snap cleanly
const RATE_MAX = 0.06; // Gentle ±6% playback clock slew
const CATCH_RATE_MAX = 0.20; // Smooth catch-up when > 160 ms behind after an outage
const CATCH_BEHIND_MS = 160;
const STEER = 1.4;
const JUMP_MS = 1800;
const CRASH_SPEED_THRESHOLD_KMH = 40;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const KMH_TO_MS = 1 / 3.6;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrap360(deg) {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/** Shortest signed angle delta in degrees (-180..+180]. */
export function shortestAngleDeltaDeg(fromDeg, toDeg) {
  let d = (toDeg - fromDeg) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Midpoint-integrated constant-airspeed aircraft kinematics matching FlightModel coordinated turns:
 *   yawRate = clamp((14.5 * tan(roll)) / v, -1.15, 1.15) rad/s
 *   dx = sin(yaw) * cos(pitch) * v * dt, dz = -cos(yaw) * cos(pitch) * v * dt, dy = sin(pitch) * v * dt
 * Optionally levels wings & pitch smoothly once `elapsedSec` exceeds `levelAfterSec`.
 */
export function integrateFlightPose(pose, dtSec, { levelAfterSec = Infinity, elapsedSec = 0 } = {}) {
  if (!pose || dtSec <= 1e-5 || pose.crashed || (pose.speedKmh ?? 0) < CRASH_SPEED_THRESHOLD_KMH) {
    return {
      x: pose?.x ?? 0,
      y: pose?.y ?? 0,
      z: pose?.z ?? 0,
      yawDeg: wrap360(pose?.yawDeg ?? 0),
      pitchDeg: pose?.pitchDeg ?? 0,
      rollDeg: pose?.rollDeg ?? 0,
    };
  }

  const vMs = Math.max(25, pose.speedKmh * KMH_TO_MS);
  const steps = Math.max(1, Math.min(30, Math.ceil(dtSec / 0.045)));
  const subDt = dtSec / steps;
  let x = pose.x;
  let y = pose.y;
  let z = pose.z;
  let yawRad = wrap360(pose.yawDeg) * DEG_TO_RAD;
  let pitchDeg = clamp(pose.pitchDeg || 0, -45, 45);
  let rollDeg = clamp(pose.rollDeg || 0, -60, 60);
  let t = elapsedSec;

  for (let s = 0; s < steps; s++) {
    t += subDt;
    if (t > levelAfterSec) {
      rollDeg *= Math.exp(-subDt / 0.55);
      pitchDeg *= Math.exp(-subDt / 0.45);
    }
    const rollRad = clamp(rollDeg, -55, 55) * DEG_TO_RAD;
    const pitchRad = clamp(pitchDeg, -35, 35) * DEG_TO_RAD;
    const yawRate = clamp((14.5 * Math.tan(rollRad)) / vMs, -1.15, 1.15);
    const horiz = vMs * Math.cos(pitchRad);
    const vy = vMs * Math.sin(pitchRad);

    yawRad += yawRate * subDt * 0.5;
    x += Math.sin(yawRad) * horiz * subDt;
    z += -Math.cos(yawRad) * horiz * subDt;
    y += vy * subDt;
    yawRad += yawRate * subDt * 0.5;
  }

  return {
    x,
    y,
    z,
    yawDeg: wrap360(yawRad * RAD_TO_DEG),
    pitchDeg,
    rollDeg,
  };
}

/**
 * Adaptive playback clock smoothing arrival jitter into a 160–420 ms render delay.
 * Sizes playback buffer cleanly above real inter-packet spacing:
 *   targetDelayMs >= max(160, 1.55 * ewmaInterval + 2.0 * ewmaJitter)
 * and slews playback speed gently (±6%) so the interpolation queue rarely runs dry.
 */
export class AdaptivePlayback {
  constructor() {
    this.gaps = []; // [arrivalMs, gapMs]
    this.lastArrivalMs = null;
    this.lastTimelineMs = null;
    this.ewmaIntervalMs = NOMINAL_STEP_MS;
    this.ewmaJitterMs = 12;
    this.jitterEwmaMs = 12; // Backward-compatible alias
    this.targetDelayMs = 240;
    this.renderMs = null;
    this.lastWallMs = null;
    this._offsetMs = null; // timelineMs - arrivalMs (minimum-latency envelope)
  }

  heard(arrivalMs, timelineMs = arrivalMs) {
    if (this.lastArrivalMs !== null && arrivalMs > this.lastArrivalMs) {
      const gap = clamp(arrivalMs - this.lastArrivalMs, 40, 650);
      this.gaps.push([arrivalMs, gap]);
      const dev = Math.abs(gap - this.ewmaIntervalMs);
      this.ewmaIntervalMs = this.ewmaIntervalMs * 0.82 + gap * 0.18;
      this.ewmaJitterMs = this.ewmaJitterMs * 0.80 + dev * 0.20;
      this.jitterEwmaMs = this.ewmaJitterMs;
    }
    this.lastArrivalMs = arrivalMs;
    this.lastTimelineMs = Math.max(this.lastTimelineMs ?? timelineMs, timelineMs);

    const rawOffset = timelineMs - arrivalMs;
    if (this._offsetMs === null || Math.abs(rawOffset - this._offsetMs) > 500) {
      this._offsetMs = rawOffset;
    } else if (rawOffset > this._offsetMs) {
      // Track lowest-latency envelope smoothly without snapping on a single early burst.
      this._offsetMs += (rawOffset - this._offsetMs) * 0.45;
    } else {
      this._offsetMs += (rawOffset - this._offsetMs) * 0.04;
    }

    while (this.gaps.length && arrivalMs - this.gaps[0][0] > WINDOW_MS) {
      this.gaps.shift();
    }

    const desired = clamp(
      Math.max(DELAY_MIN_MS, 1.55 * this.ewmaIntervalMs + 2.0 * this.ewmaJitterMs),
      DELAY_MIN_MS,
      DELAY_MAX_MS
    );
    this.targetDelayMs += (desired - this.targetDelayMs) * 0.22;
  }

  at(nowMs) {
    if (this.lastArrivalMs === null || this._offsetMs === null) return null;
    const estHostNow = nowMs + this._offsetMs;
    const desired = estHostNow - this.targetDelayMs;

    if (this.renderMs === null || Math.abs(desired - this.renderMs) > JUMP_MS) {
      this.renderMs = desired;
    } else if (this.lastWallMs !== null && nowMs > this.lastWallMs) {
      const dtMs = Math.min(250, nowMs - this.lastWallMs);
      const errSec = (desired - this.renderMs) / 1000;
      const hiRate = (desired - this.renderMs) > CATCH_BEHIND_MS ? CATCH_RATE_MAX : RATE_MAX;
      const rate = 1 + clamp(STEER * errSec, -RATE_MAX, hiRate);
      this.renderMs += dtMs * rate;
    }
    this.lastWallMs = nowMs;

    // Allow smooth constant-airspeed coasting up to MAX_EXTRAPOLATE_MS (1200 ms) through jitter & failover.
    const ceiling = (this.lastTimelineMs ?? this.lastArrivalMs) + MAX_EXTRAPOLATE_MS;
    this.renderMs = Math.min(this.renderMs, ceiling);
    return this.renderMs;
  }

  reset() {
    this.gaps.length = 0;
    this.lastArrivalMs = null;
    this.lastTimelineMs = null;
    this.ewmaIntervalMs = NOMINAL_STEP_MS;
    this.ewmaJitterMs = 12;
    this.jitterEwmaMs = 12;
    this.targetDelayMs = 240;
    this.renderMs = null;
    this.lastWallMs = null;
    this._offsetMs = null;
  }
}

function isTeleport(a, b, hSec) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  return dist > Math.max(TELEPORT_MIN_DIST, TELEPORT_SPEED_MS * hSec);
}

/** Fritsch-Carlson monotone cubic Hermite tangent (units/sec) at sample k for scalar field. */
function monotoneSlope(samples, k, field) {
  const a = samples[k - 1];
  const b = samples[k];
  const c = samples[k + 1];

  const secant = (p, q) => {
    if (!p || !q) return null;
    const h = Math.max(1e-3, (q.t - p.t) / 1000);
    if (isTeleport(p, q, h)) return null;
    return (q[field] - p[field]) / h;
  };

  const d0 = secant(a, b);
  const d1 = secant(b, c);
  if (d0 === null || d1 === null) return d0 ?? d1 ?? 0;
  if (d0 * d1 <= 0) return 0; // Local extremum or reversal: zero tangent prevents overshoot!

  const h0 = Math.max(1e-3, (b.t - a.t) / 1000);
  const h1 = Math.max(1e-3, (c.t - b.t) / 1000);
  const m = (d0 * h1 + d1 * h0) / (h0 + h1);
  const cap = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.sign(m) * Math.min(Math.abs(m), cap);
}

function evalHermite(p0, p1, m0, m1, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p0 +
    (u3 - 2 * u2 + u) * m0 +
    (-2 * u3 + 3 * u2) * p1 +
    (u3 - u2) * m1
  );
}

/**
 * Per-aircraft pose track:
 * - Fritsch-Carlson monotone cubic Hermite on (x, y, z)
 * - Shortest-arc angles on (yaw, pitch, roll)
 * - Never-stop constant-airspeed bank-curved dead-reckoning up to MAX_EXTRAPOLATE_MS (1200 ms)
 * - Exponential visual error convergence (~190 ms) with forward-speed floor + max-step limiter
 *   so remote planes NEVER freeze in mid-air and NEVER pop across the sky!
 */
export class PlaneTrack {
  constructor(slotId, uid = null) {
    this.slotId = slotId;
    this.uid = uid;
    this.samples = [];
    this.lastSeenMs = 0;
    this.lastMovedMs = 0;

    // Exponential correction blend state (absorbs discontinuities smoothly without pops or stalls)
    this._lastRaw = null;
    this._lastOut = null;
    this._lastSampleWallMs = null;
    this._errX = 0;
    this._errY = 0;
    this._errZ = 0;
    this._errYaw = 0;
    this._errPitch = 0;
    this._errRoll = 0;
  }

  push(tMs, pose, arrivalMs = tMs) {
    const last = this.samples[this.samples.length - 1];
    let stampMs = tMs;
    if (last && stampMs <= last.t) {
      // Clumped arrival: space ahead so timeline stays strictly monotonic without zero-dt spikes.
      stampMs = last.t + MIN_TIMELINE_STEP_MS;
    }

    const moved = !last || Math.hypot(pose.x - last.x, pose.y - last.y, pose.z - last.z) > 0.25;
    if (moved || !this.lastMovedMs) {
      this.lastMovedMs = arrivalMs;
    }

    this.samples.push({
      t: stampMs,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      yawDeg: wrap360(pose.yawDeg),
      pitchDeg: pose.pitchDeg,
      rollDeg: pose.rollDeg,
      speedKmh: pose.speedKmh,
      tankPct: pose.tankPct,
      releasing: !!pose.releasing,
      scooping: !!pose.scooping,
      autopilot: !!pose.autopilot,
    });
    this.lastSeenMs = arrivalMs;
    while (this.samples.length > 4 && stampMs - this.samples[1].t > KEEP_MS) {
      this.samples.shift();
    }
  }

  /** Sample smoothed pose at timeline renderMs (wall clock nowMs drives correction decay & stale coasting). */
  sampleAt(renderMs, nowMs = renderMs) {
    const raw = this._evaluateRaw(renderMs, nowMs);
    if (!raw) return null;

    if (!this._lastOut || this._lastSampleWallMs === null) {
      this._lastRaw = raw;
      this._lastOut = { ...raw };
      this._lastSampleWallMs = nowMs;
      return { ...raw };
    }

    const dtSec = clamp((nowMs - this._lastSampleWallMs) / 1000, 0, 0.25);
    this._lastSampleWallMs = nowMs;

    const isFlying = (raw.speedKmh ?? 0) >= CRASH_SPEED_THRESHOLD_KMH;
    let isLargeTeleport = false;

    // Detect sudden discontinuity in raw evaluated pose (e.g. exiting dead-reckoning or Host failover)
    // and fold it into exponential error offsets while projecting forward 1 frame (0 frozen frames!).
    if (this._lastRaw) {
      const jumpDist = Math.hypot(raw.x - this._lastRaw.x, raw.y - this._lastRaw.y, raw.z - this._lastRaw.z);
      const maxContinuousStep = Math.max(1.2, 72 * Math.max(dtSec, 0.016));
      if (jumpDist >= BLEND_MAX_DIST) {
        // Genuine respawn or Operation change teleport -> snap cleanly!
        isLargeTeleport = true;
        this._errX = this._errY = this._errZ = 0;
        this._errYaw = this._errPitch = this._errRoll = 0;
      } else if (jumpDist > maxContinuousStep) {
        const proj = isFlying && dtSec > 0
          ? integrateFlightPose(this._lastOut, dtSec)
          : this._lastOut;
        this._errX = proj.x - raw.x;
        this._errY = proj.y - raw.y;
        this._errZ = proj.z - raw.z;
        this._errYaw = shortestAngleDeltaDeg(raw.yawDeg, proj.yawDeg);
        this._errPitch = proj.pitchDeg - raw.pitchDeg;
        this._errRoll = proj.rollDeg - raw.rollDeg;
      }
    }

    const decay = dtSec > 0 ? Math.exp(-dtSec / CORRECTION_TAU_SEC) : 1;
    this._errX *= decay;
    this._errY *= decay;
    this._errZ *= decay;
    this._errYaw *= decay;
    this._errPitch *= decay;
    this._errRoll *= decay;

    // Never-stop forward-speed floor & anti-pop frame-step clamp for flying aircraft:
    // ensures convergence never stalls/reverses a flying plane and never jumps > ~2 m in a 60 Hz frame,
    // while gating on staleMoveMs <= 600 so parked/hidden-tab static poses do not drift off-position!
    const staleMs = Math.max(0, nowMs - (this.lastSeenMs || 0));
    const staleMoveMs = Math.max(0, nowMs - (this.lastMovedMs || this.lastSeenMs));
    if (
      isFlying &&
      !isLargeTeleport &&
      dtSec > 0.002 &&
      staleMs <= MAX_EXTRAPOLATE_MS + 350 &&
      staleMoveMs <= 600
    ) {
      const vMs = Math.max(25, raw.speedKmh * KMH_TO_MS);
      const yawR = wrap360(this._lastOut.yawDeg) * DEG_TO_RAD;
      const pitchR = clamp(this._lastOut.pitchDeg || 0, -35, 35) * DEG_TO_RAD;
      const fx = Math.sin(yawR) * Math.cos(pitchR);
      const fy = Math.sin(pitchR);
      const fz = -Math.cos(yawR) * Math.cos(pitchR);

      let candX = raw.x + this._errX;
      let candY = raw.y + this._errY;
      let candZ = raw.z + this._errZ;
      let sx = candX - this._lastOut.x;
      let sy = candY - this._lastOut.y;
      let sz = candZ - this._lastOut.z;

      const fwdDot = sx * fx + sy * fy + sz * fz;
      const minFwd = 0.58 * vMs * dtSec; // Strictly >= ~25 m/s at cruise speed (0 frozen frames!)
      if (fwdDot < minFwd) {
        const push = minFwd - fwdDot;
        this._errX += fx * push;
        this._errY += fy * push;
        this._errZ += fz * push;
        const errMag = Math.hypot(this._errX, this._errY, this._errZ);
        if (errMag > BLEND_MAX_DIST) {
          const s = BLEND_MAX_DIST / errMag;
          this._errX *= s;
          this._errY *= s;
          this._errZ *= s;
        }
        candX = raw.x + this._errX;
        candY = raw.y + this._errY;
        candZ = raw.z + this._errZ;
        sx = candX - this._lastOut.x;
        sy = candY - this._lastOut.y;
        sz = candZ - this._lastOut.z;
      }

      const stepDist = Math.hypot(sx, sy, sz);
      const maxStep = Math.max(1.8, 82 * dtSec); // Strictly <= ~1.8 m at 60 Hz (0 teleport pops!)
      if (stepDist > maxStep && stepDist < BLEND_MAX_DIST) {
        const scale = maxStep / stepDist;
        this._errX = (this._lastOut.x + sx * scale) - raw.x;
        this._errY = (this._lastOut.y + sy * scale) - raw.y;
        this._errZ = (this._lastOut.z + sz * scale) - raw.z;
      }
    }

    if (Math.abs(this._errX) < 0.01) this._errX = 0;
    if (Math.abs(this._errY) < 0.01) this._errY = 0;
    if (Math.abs(this._errZ) < 0.01) this._errZ = 0;
    if (Math.abs(this._errYaw) < 0.05) this._errYaw = 0;
    if (Math.abs(this._errPitch) < 0.05) this._errPitch = 0;
    if (Math.abs(this._errRoll) < 0.05) this._errRoll = 0;

    // Per-plane stale protection: if this ONE remote plane hasn't moved for > 1.5 s (bad Wi-Fi),
    // smoothly level its wings so it doesn't freeze awkwardly in a steep bank.
    let pitchDeg = raw.pitchDeg + this._errPitch;
    let rollDeg = raw.rollDeg + this._errRoll;
    if (staleMoveMs > STALE_COAST_MS) {
      const levelFactor = Math.exp(-((staleMoveMs - STALE_COAST_MS) / 600));
      pitchDeg *= levelFactor;
      rollDeg *= levelFactor;
    }

    const out = {
      ...raw,
      x: raw.x + this._errX,
      y: raw.y + this._errY,
      z: raw.z + this._errZ,
      yawDeg: wrap360(raw.yawDeg + this._errYaw),
      pitchDeg: clamp(pitchDeg, -60, 60),
      rollDeg: clamp(rollDeg, -64, 64),
    };

    this._lastRaw = raw;
    this._lastOut = out;
    return { ...out };
  }

  _evaluateRaw(renderMs, nowMs) {
    const s = this.samples;
    if (s.length === 0) return null;

    const last = s[s.length - 1];
    if (renderMs >= last.t) {
      return this._extrapolateBanked(renderMs - last.t, nowMs);
    }

    let i = s.length - 1;
    while (i > 0 && s[i - 1].t > renderMs) i--;
    if (i === 0) {
      // Smoothly lead newly appeared flying planes into s[0] instead of parking them motionless
      // while renderMs catches up to their first sample timestamp!
      const first = s[0];
      const leadSec = clamp((first.t - renderMs) / 1000, 0, 0.5);
      if (leadSec > 1e-4 && (first.speedKmh ?? 0) >= CRASH_SPEED_THRESHOLD_KMH) {
        const vMs = Math.max(25, first.speedKmh * KMH_TO_MS);
        const yawR = wrap360(first.yawDeg) * DEG_TO_RAD;
        const pitchR = clamp(first.pitchDeg || 0, -35, 35) * DEG_TO_RAD;
        const horiz = vMs * Math.cos(pitchR);
        return {
          ...first,
          slotId: this.slotId,
          x: first.x - Math.sin(yawR) * horiz * leadSec,
          y: first.y - vMs * Math.sin(pitchR) * leadSec,
          z: first.z + Math.cos(yawR) * horiz * leadSec,
        };
      }
      return { ...first, slotId: this.slotId };
    }

    const a = s[i - 1];
    const b = s[i];
    const hSec = Math.max(1e-3, (b.t - a.t) / 1000);
    const u = clamp((renderMs - a.t) / Math.max(1, b.t - a.t), 0, 1);

    if (isTeleport(a, b, hSec)) {
      return { ...b, slotId: this.slotId };
    }

    const x = evalHermite(a.x, b.x, monotoneSlope(s, i - 1, 'x') * hSec, monotoneSlope(s, i, 'x') * hSec, u);
    const y = evalHermite(a.y, b.y, monotoneSlope(s, i - 1, 'y') * hSec, monotoneSlope(s, i, 'y') * hSec, u);
    const z = evalHermite(a.z, b.z, monotoneSlope(s, i - 1, 'z') * hSec, monotoneSlope(s, i, 'z') * hSec, u);

    const yawDeg = wrap360(a.yawDeg + shortestAngleDeltaDeg(a.yawDeg, b.yawDeg) * u);
    const pitchDeg = a.pitchDeg + (b.pitchDeg - a.pitchDeg) * u;
    const rollDeg = a.rollDeg + (b.rollDeg - a.rollDeg) * u;
    const speedKmh = a.speedKmh + (b.speedKmh - a.speedKmh) * u;
    const tankPct = a.tankPct + (b.tankPct - a.tankPct) * u;

    return {
      slotId: this.slotId,
      x,
      y,
      z,
      yawDeg,
      pitchDeg,
      rollDeg,
      speedKmh,
      tankPct,
      releasing: u < 0.5 ? a.releasing : b.releasing,
      scooping: u < 0.5 ? a.scooping : b.scooping,
      autopilot: b.autopilot,
    };
  }

  /**
   * Constant-airspeed bank-curved dead-reckoning past the newest sample up to MAX_EXTRAPOLATE_MS (1200 ms).
   * A flying aircraft NEVER decelerates to a mid-air halt during late packets or Host transfer;
   * wings hold bank for 400 ms then smoothly level out over 400–1200 ms.
   */
  _extrapolateBanked(overMs, nowMs) {
    const last = this.samples[this.samples.length - 1];
    const clampedSec = clamp(overMs, 0, MAX_EXTRAPOLATE_MS) / 1000;
    if (clampedSec <= 1e-4 || (last.speedKmh ?? 0) < CRASH_SPEED_THRESHOLD_KMH) {
      return { ...last, slotId: this.slotId };
    }

    const integrated = integrateFlightPose(last, clampedSec, {
      levelAfterSec: LEVEL_WINGS_AFTER_SEC,
      elapsedSec: 0,
    });

    const staleMs = Math.max(0, nowMs - (this.lastSeenMs || 0));
    const levelDamp = staleMs > STALE_COAST_MS ? Math.exp(-(staleMs - STALE_COAST_MS) / 600) : 1;

    return {
      slotId: this.slotId,
      x: integrated.x,
      y: integrated.y,
      z: integrated.z,
      yawDeg: integrated.yawDeg,
      pitchDeg: integrated.pitchDeg * levelDamp,
      rollDeg: integrated.rollDeg * levelDamp,
      speedKmh: last.speedKmh,
      tankPct: last.tankPct,
      releasing: clampedSec < 0.30 ? last.releasing : false,
      scooping: clampedSec < 0.30 ? last.scooping : false,
      autopilot: last.autopilot,
    };
  }
}

export class PlaneInterpolator {
  constructor() {
    this.playback = new AdaptivePlayback();
    this.tracks = new Map(); // slotId -> PlaneTrack
    this.localAuthTank = null;
    this._lastTimelineMs = null;
  }

  /**
   * Reconcile tracks against authoritative `slots` map:
   * immediately evict vacated/expired slots (zero mid-air linger) and reset PlaneTrack if
   * a recycled slotId now belongs to a different uid (zero cross-pilot rubber-band!).
   */
  reconcileSlots(activeSlots, serverNow = null) {
    if (!activeSlots || typeof activeSlots !== 'object') return;
    for (const [slotId, track] of [...this.tracks.entries()]) {
      const slotObj = activeSlots[String(slotId)];
      const expired =
        !slotObj ||
        typeof slotObj.uid !== 'string' ||
        (typeof serverNow === 'number' && typeof slotObj.leaseUntil === 'number' && slotObj.leaseUntil <= serverNow);
      if (expired) {
        this.tracks.delete(slotId);
      } else if (track.uid && slotObj.uid !== track.uid) {
        // Recycled slot claimed by a new pilot -> drop old pilot's history cleanly!
        this.tracks.delete(slotId);
      } else if (!track.uid) {
        track.uid = slotObj.uid;
      }
    }
  }

  /**
   * Ingest a decoded planes snapshot from StreamClient.
   * Optional `serverTimeMs` enables Host-clock timeline spacing even when client packets arrive clumped.
   * Optional `activeSlots` binds each track to its occupant UID so recycled slots reset cleanly.
   */
  pushSnapshot(planes, arrivalMs, localSlotId = null, serverTimeMs = null, activeSlots = null, serverNow = null) {
    let timelineMs = typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs) && serverTimeMs > 0
      ? serverTimeMs
      : arrivalMs;

    if (this._lastTimelineMs !== null && timelineMs <= this._lastTimelineMs) {
      timelineMs = this._lastTimelineMs + MIN_TIMELINE_STEP_MS;
    }
    this._lastTimelineMs = timelineMs;

    this.playback.heard(arrivalMs, timelineMs);
    if (activeSlots) this.reconcileSlots(activeSlots, serverNow);
    const seen = new Set();

    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      const slotObj = activeSlots ? activeSlots[String(p.slotId)] : null;
      const slotUid = slotObj && typeof slotObj.uid === 'string' ? slotObj.uid : null;
      if (
        activeSlots &&
        (!slotUid || (typeof serverNow === 'number' && typeof slotObj.leaseUntil === 'number' && slotObj.leaseUntil <= serverNow))
      ) {
        continue;
      }
      seen.add(p.slotId);
      if (localSlotId !== null && p.slotId === localSlotId) {
        this.localAuthTank = p.tankPct;
      }
      let track = this.tracks.get(p.slotId);
      if (!track || (slotUid && track.uid && track.uid !== slotUid)) {
        track = new PlaneTrack(p.slotId, slotUid);
        this.tracks.set(p.slotId, track);
      } else if (slotUid && !track.uid) {
        track.uid = slotUid;
      }
      track.push(timelineMs, p, arrivalMs);
    }

    // Drop tracks absent for > KEEP_MS so departed pilots disappear cleanly.
    for (const [slotId, track] of this.tracks.entries()) {
      if (!seen.has(slotId) && arrivalMs - track.lastSeenMs > KEEP_MS) {
        this.tracks.delete(slotId);
      }
    }
  }

  /**
   * Evaluate all remote planes at nowMs (excluding excludeSlotId) enriched with roster metadata.
   */
  sample(nowMs, { excludeSlotId = null, getRosterInfo = null, activeSlots = null, serverNow = null } = {}) {
    if (activeSlots) this.reconcileSlots(activeSlots, serverNow);
    const renderMs = this.playback.at(nowMs);
    if (renderMs === null) return [];

    const out = [];
    for (const [slotId, track] of this.tracks.entries()) {
      if (excludeSlotId !== null && slotId === excludeSlotId) continue;
      if (nowMs - track.lastSeenMs > KEEP_MS) continue;
      const pose = track.sampleAt(renderMs, nowMs);
      if (!pose) continue;
      const info = getRosterInfo
        ? getRosterInfo(slotId)
        : { callsign: `EF-${String(slotId).padStart(2, '0')}`, colorIdx: slotId % 16 };
      pose.callsign = info.callsign;
      pose.colorIdx = info.colorIdx;
      out.push(pose);
    }
    return out;
  }

  clear() {
    this.playback.reset();
    this.tracks.clear();
    this.localAuthTank = null;
    this._lastTimelineMs = null;
  }
}
