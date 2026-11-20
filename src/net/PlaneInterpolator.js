// Remote aircraft interpolation and dead-reckoning for EMBER FRONT 100-player Mega-Basin.
// - Adaptive Playback delay (150-280 ms) adapted from vanguard-protocol/src/net/Playback.js
// - Fritsch-Carlson monotone cubic Hermite interpolation for (x, y, z)
// - Shortest-arc angle interpolation for yaw, pitch, roll
// - Bank-curved dead-reckoning (<= 250 ms cap) using exact coordinated turn rate:
//   yawRate = clamp((14.5 * tan(roll)) / v, -1.15, 1.15) rad/s

export const DELAY_MIN_MS = 150;
export const DELAY_MAX_MS = 280;
export const MAX_EXTRAPOLATE_MS = 250;

const MARGIN_MS = 20;
const WINDOW_MS = 6000;
const KEEP_MS = 2000;
const TELEPORT_SPEED_MS = 240; // > 240 m/s (~864 km/h) snaps instead of interpolating
const TELEPORT_MIN_DIST = 120;
const RATE_MAX = 0.12;
const STEER = 2.0;
const JUMP_MS = 1000;
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

function p95(list) {
  if (!list.length) return 0;
  const sorted = list.map((e) => e[1]).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
}

/**
 * Adaptive playback clock smoothing jitter into a 150-280 ms render delay.
 */
export class AdaptivePlayback {
  constructor() {
    this.gaps = []; // [arrivalMs, gapMs]
    this.lastArrivalMs = null;
    this.targetDelayMs = 200; // starts at 200 ms nominal for 4 Hz (250 ms) stream
    this.renderMs = null;
    this.lastWallMs = null;
  }

  heard(arrivalMs) {
    if (this.lastArrivalMs !== null && arrivalMs > this.lastArrivalMs) {
      const gap = arrivalMs - this.lastArrivalMs;
      this.gaps.push([arrivalMs, gap]);
    }
    this.lastArrivalMs = arrivalMs;
    while (this.gaps.length && arrivalMs - this.gaps[0][0] > WINDOW_MS) {
      this.gaps.shift();
    }
    if (this.gaps.length >= 2) {
      // Scale target delay to stream arrival cadence + jitter, bounded strictly within [150, 280] ms.
      const spread = p95(this.gaps);
      this.targetDelayMs = clamp(spread * 0.72 + MARGIN_MS, DELAY_MIN_MS, DELAY_MAX_MS);
    }
  }

  at(nowMs) {
    if (this.lastArrivalMs === null) return null;
    const desired = nowMs - this.targetDelayMs;
    if (this.renderMs === null || Math.abs(desired - this.renderMs) > JUMP_MS) {
      this.renderMs = desired;
    } else if (this.lastWallMs !== null && nowMs > this.lastWallMs) {
      const dtMs = nowMs - this.lastWallMs;
      const errSec = (desired - this.renderMs) / 1000;
      const rate = 1 + clamp(STEER * errSec, -RATE_MAX, RATE_MAX);
      this.renderMs += dtMs * rate;
    }
    this.lastWallMs = nowMs;
    // Never run further than MAX_EXTRAPOLATE_MS past the newest received snapshot.
    this.renderMs = Math.min(this.renderMs, this.lastArrivalMs + MAX_EXTRAPOLATE_MS);
    return this.renderMs;
  }

  reset() {
    this.gaps.length = 0;
    this.lastArrivalMs = null;
    this.renderMs = null;
    this.lastWallMs = null;
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

/** Per-aircraft pose sample history with Hermite interpolation + bank-curved dead-reckoning. */
export class PlaneTrack {
  constructor(slotId) {
    this.slotId = slotId;
    this.samples = [];
    this.lastSeenMs = 0;
  }

  push(tMs, pose) {
    const last = this.samples[this.samples.length - 1];
    if (last && tMs <= last.t) return;
    this.samples.push({
      t: tMs,
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
    this.lastSeenMs = tMs;
    while (this.samples.length > 3 && tMs - this.samples[1].t > KEEP_MS) {
      this.samples.shift();
    }
  }

  /** Sample interpolated or bank-curved dead-reckoned pose at renderMs. */
  sampleAt(renderMs) {
    const s = this.samples;
    if (s.length === 0) return null;

    const last = s[s.length - 1];
    if (renderMs >= last.t) {
      return this._extrapolateBanked(renderMs - last.t);
    }

    let i = s.length - 1;
    while (i > 0 && s[i - 1].t > renderMs) i--;
    if (i === 0) return { ...s[0], slotId: this.slotId };

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
   * Bank-curved dead-reckoning past the newest sample, capped strictly at MAX_EXTRAPOLATE_MS (250 ms).
   * Coordinated turn rate matches FlightModel: yawRate = clamp(14.5 * tan(roll) / v, -1.15, 1.15).
   */
  _extrapolateBanked(overMs) {
    const last = this.samples[this.samples.length - 1];
    const dtTotal = clamp(overMs, 0, MAX_EXTRAPOLATE_MS) / 1000;
    if (dtTotal <= 1e-4) return { ...last, slotId: this.slotId };

    const vMs = Math.max(25, last.speedKmh * KMH_TO_MS);
    const rollRad = clamp(last.rollDeg, -55, 55) * DEG_TO_RAD;
    const pitchRad = clamp(last.pitchDeg, -35, 35) * DEG_TO_RAD;
    const yawRate = clamp((14.5 * Math.tan(rollRad)) / vMs, -1.15, 1.15);

    // Integrate curved arc in 4 sub-steps for accurate curved flight path during banks.
    const steps = 4;
    const subDt = dtTotal / steps;
    let x = last.x;
    let y = last.y;
    let z = last.z;
    let yawRad = last.yawDeg * DEG_TO_RAD;
    const horizSpeed = vMs * Math.cos(pitchRad);
    const vy = vMs * Math.sin(pitchRad);

    for (let s = 0; s < steps; s++) {
      yawRad += yawRate * subDt * 0.5;
      x += Math.sin(yawRad) * horizSpeed * subDt;
      z += -Math.cos(yawRad) * horizSpeed * subDt;
      y += vy * subDt;
      yawRad += yawRate * subDt * 0.5;
    }

    return {
      slotId: this.slotId,
      x,
      y,
      z,
      yawDeg: wrap360(yawRad * RAD_TO_DEG),
      pitchDeg: last.pitchDeg,
      rollDeg: last.rollDeg,
      speedKmh: last.speedKmh,
      tankPct: last.tankPct,
      releasing: last.releasing,
      scooping: last.scooping,
      autopilot: last.autopilot,
    };
  }
}

export class PlaneInterpolator {
  constructor() {
    this.playback = new AdaptivePlayback();
    this.tracks = new Map(); // slotId -> PlaneTrack
    this.localAuthTank = null;
  }

  /** Ingest a decoded planes snapshot from StreamClient. */
  pushSnapshot(planes, arrivalMs, localSlotId = null) {
    this.playback.heard(arrivalMs);
    const seen = new Set();

    for (let i = 0; i < planes.length; i++) {
      const p = planes[i];
      seen.add(p.slotId);
      if (localSlotId !== null && p.slotId === localSlotId) {
        this.localAuthTank = p.tankPct;
      }
      let track = this.tracks.get(p.slotId);
      if (!track) {
        track = new PlaneTrack(p.slotId);
        this.tracks.set(p.slotId, track);
      }
      track.push(arrivalMs, p);
    }

    // Drop tracks absent for > 2 s so departed pilots disappear cleanly.
    for (const [slotId, track] of this.tracks.entries()) {
      if (!seen.has(slotId) && arrivalMs - track.lastSeenMs > KEEP_MS) {
        this.tracks.delete(slotId);
      }
    }
  }

  /**
   * Evaluate all remote planes at nowMs (excluding excludeSlotId) enriched with roster metadata.
   */
  sample(nowMs, { excludeSlotId = null, getRosterInfo = null } = {}) {
    const renderMs = this.playback.at(nowMs);
    if (renderMs === null) return [];

    const out = [];
    for (const [slotId, track] of this.tracks.entries()) {
      if (excludeSlotId !== null && slotId === excludeSlotId) continue;
      if (nowMs - track.lastSeenMs > KEEP_MS) continue;
      const pose = track.sampleAt(renderMs);
      if (!pose) continue;
      const info = getRosterInfo ? getRosterInfo(slotId) : { callsign: `EF-${String(slotId).padStart(2, '0')}`, colorIdx: slotId % 16 };
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
  }
}
