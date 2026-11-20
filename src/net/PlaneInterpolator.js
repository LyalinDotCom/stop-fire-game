// Vanguard-grade remote aircraft interpolation, adaptive jitter smoothing, and lag isolation.
// - Adaptive Playback delay (150–320 ms) with EWMA jitter tracking + smooth ±8% clock slew (zero jumps on clumped packets)
// - Fritsch-Carlson monotone cubic Hermite interpolation for (x, y, z) — zero overshoot or rubber-banding
// - Shortest-arc angle interpolation for yaw, pitch, roll
// - Smoothly damped bank-curved dead-reckoning (<= 350 ms cap) using coordinated turn rate:
//   yawRate = clamp((14.5 * tan(roll)) / v, -1.15, 1.15) rad/s
// - Exponential correction blending (~140 ms convergence) when delayed packets catch up (zero visual snap/pop)
// - Per-plane stale wing-leveling coast (> 1.5 s stale for one lagging player without affecting anyone else)

export const DELAY_MIN_MS = 150;
export const DELAY_MAX_MS = 320;
export const MAX_EXTRAPOLATE_MS = 350;

const MARGIN_MS = 24;
const WINDOW_MS = 6000;
const KEEP_MS = 2600;
const NOMINAL_STEP_MS = 250; // 4 Hz planes broadcast cadence
const MIN_TIMELINE_STEP_MS = 80; // prevents clumped arrival bursts from producing tiny dt spikes
const RUN_ON_TAU_SEC = 0.22; // exponential ease-out during dead-reckoning (Vanguard RUN_ON pattern)
const CORRECTION_TAU_SEC = 0.14; // ~140 ms exponential convergence when delayed packets catch up
const STALE_COAST_MS = 1500; // per-plane stale threshold -> smooth wing-leveling coast
const TELEPORT_SPEED_MS = 260; // > 260 m/s (~936 km/h) or >= 350 m jump (respawn / op change) snaps cleanly
const TELEPORT_MIN_DIST = 140;
const BLEND_MAX_DIST = 340; // offsets under 340 m blend smoothly over 140 ms; larger respawns snap cleanly
const RATE_MAX = 0.08; // smooth ±8% playback clock slew
const CATCH_RATE_MAX = 0.24; // gentle catch-up when > 150 ms behind after an outage
const CATCH_BEHIND_MS = 150;
const STEER = 1.6;
const JUMP_MS = 1500;
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
 * Vanguard-style adaptive playback clock smoothing arrival jitter into a 150–320 ms render delay.
 * Uses EWMA jitter + p95 arrival spacing and slews playback rate smoothly (±8%) without hard jumps.
 */
export class AdaptivePlayback {
  constructor() {
    this.gaps = []; // [arrivalMs, gapMs]
    this.lastArrivalMs = null;
    this.lastTimelineMs = null;
    this.jitterEwmaMs = 0;
    this.targetDelayMs = 200; // nominal 200 ms starting delay for 4 Hz stream
    this.renderMs = null;
    this.lastWallMs = null;
    this._offsetMs = null; // timelineMs - arrivalMs (least-delayed envelope)
  }

  heard(arrivalMs, timelineMs = arrivalMs) {
    if (this.lastArrivalMs !== null && arrivalMs > this.lastArrivalMs) {
      const gap = arrivalMs - this.lastArrivalMs;
      this.gaps.push([arrivalMs, gap]);
      const dev = Math.abs(gap - NOMINAL_STEP_MS);
      this.jitterEwmaMs = this.jitterEwmaMs * 0.8 + dev * 0.2;
    }
    this.lastArrivalMs = arrivalMs;
    this.lastTimelineMs = Math.max(this.lastTimelineMs ?? timelineMs, timelineMs);

    const rawOffset = timelineMs - arrivalMs;
    if (this._offsetMs === null || rawOffset > this._offsetMs) {
      this._offsetMs = rawOffset;
    } else {
      this._offsetMs += (rawOffset - this._offsetMs) * 0.05;
    }

    while (this.gaps.length && arrivalMs - this.gaps[0][0] > WINDOW_MS) {
      this.gaps.shift();
    }

    if (this.gaps.length >= 2) {
      const spread = p95(this.gaps);
      const desired = spread * 0.68 + this.jitterEwmaMs * 0.55 + MARGIN_MS;
      const clamped = clamp(desired, DELAY_MIN_MS, DELAY_MAX_MS);
      // Smooth target delay itself so spikes don't yank playback speed
      this.targetDelayMs += (clamped - this.targetDelayMs) * 0.25;
    }
  }

  at(nowMs) {
    if (this.lastArrivalMs === null || this._offsetMs === null) return null;
    const estHostNow = nowMs + this._offsetMs;
    const desired = estHostNow - this.targetDelayMs;

    if (this.renderMs === null || Math.abs(desired - this.renderMs) > JUMP_MS) {
      this.renderMs = desired;
    } else if (this.lastWallMs !== null && nowMs > this.lastWallMs) {
      const dtMs = Math.min(100, nowMs - this.lastWallMs);
      const errSec = (desired - this.renderMs) / 1000;
      const hiRate = (desired - this.renderMs) > CATCH_BEHIND_MS ? CATCH_RATE_MAX : RATE_MAX;
      const rate = 1 + clamp(STEER * errSec, -RATE_MAX, hiRate);
      this.renderMs += dtMs * rate;
    }
    this.lastWallMs = nowMs;

    // Never run further than MAX_EXTRAPOLATE_MS past the newest received sample timeline.
    const ceiling = (this.lastTimelineMs ?? this.lastArrivalMs) + MAX_EXTRAPOLATE_MS;
    this.renderMs = Math.min(this.renderMs, ceiling);
    return this.renderMs;
  }

  reset() {
    this.gaps.length = 0;
    this.lastArrivalMs = null;
    this.lastTimelineMs = null;
    this.jitterEwmaMs = 0;
    this.targetDelayMs = 200;
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
 * - Damped bank-curved dead-reckoning up to MAX_EXTRAPOLATE_MS (350 ms)
 * - Exponential visual error convergence (~140 ms) so delayed packets NEVER pop/snap
 * - Per-plane stale detection (> 1.5 s motionless) -> smooth wing-leveling coast
 */
export class PlaneTrack {
  constructor(slotId) {
    this.slotId = slotId;
    this.samples = [];
    this.lastSeenMs = 0;
    this.lastMovedMs = 0;

    // Exponential correction blend state (absorbs discontinuities when delayed packets catch up)
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
      // Clumped arrival: space slightly ahead so timeline stays strictly monotonic without zero-dt spikes.
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

    // Detect sudden discontinuity in raw evaluated pose (e.g. exiting dead-reckoning or stale peer catch-up)
    // and absorb it smoothly into exponential error offsets instead of popping across the sky!
    if (this._lastRaw) {
      const jumpDist = Math.hypot(raw.x - this._lastRaw.x, raw.y - this._lastRaw.y, raw.z - this._lastRaw.z);
      const maxContinuousStep = Math.max(2.5, 95 * Math.max(dtSec, 0.016));
      if (jumpDist > maxContinuousStep && jumpDist < BLEND_MAX_DIST) {
        // Fold the discontinuity into our visual error offset so rendered position stays continuous.
        this._errX = this._lastOut.x - raw.x;
        this._errY = this._lastOut.y - raw.y;
        this._errZ = this._lastOut.z - raw.z;
        this._errYaw = shortestAngleDeltaDeg(raw.yawDeg, this._lastOut.yawDeg);
        this._errPitch = this._lastOut.pitchDeg - raw.pitchDeg;
        this._errRoll = this._lastOut.rollDeg - raw.rollDeg;
      } else if (jumpDist >= BLEND_MAX_DIST) {
        // Genuine respawn or Operation change teleport -> snap cleanly!
        this._errX = this._errY = this._errZ = 0;
        this._errYaw = this._errPitch = this._errRoll = 0;
      }
    }

    const decay = dtSec > 0 ? Math.exp(-dtSec / CORRECTION_TAU_SEC) : 1;
    this._errX *= decay;
    this._errY *= decay;
    this._errZ *= decay;
    this._errYaw *= decay;
    this._errPitch *= decay;
    this._errRoll *= decay;

    if (Math.abs(this._errX) < 0.01) this._errX = 0;
    if (Math.abs(this._errY) < 0.01) this._errY = 0;
    if (Math.abs(this._errZ) < 0.01) this._errZ = 0;
    if (Math.abs(this._errYaw) < 0.05) this._errYaw = 0;
    if (Math.abs(this._errPitch) < 0.05) this._errPitch = 0;
    if (Math.abs(this._errRoll) < 0.05) this._errRoll = 0;

    // Per-plane stale protection: if this ONE remote plane hasn't moved for > 1.5 s (bad Wi-Fi),
    // smoothly level its wings so it doesn't freeze awkwardly in a steep bank.
    const staleMs = Math.max(0, nowMs - (this.lastMovedMs || this.lastSeenMs));
    let pitchDeg = raw.pitchDeg + this._errPitch;
    let rollDeg = raw.rollDeg + this._errRoll;
    if (staleMs > STALE_COAST_MS) {
      const levelFactor = Math.exp(-((staleMs - STALE_COAST_MS) / 600));
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
   * Smoothly damped bank-curved dead-reckoning past the newest sample, capped strictly at MAX_EXTRAPOLATE_MS (350 ms).
   * Coordinated turn rate matches FlightModel: yawRate = clamp(14.5 * tan(roll) / v, -1.15, 1.15).
   * Uses exponential speed ease-out (Vanguard RUN_ON pattern) so planes slow gracefully instead of overshooting.
   */
  _extrapolateBanked(overMs, nowMs) {
    const last = this.samples[this.samples.length - 1];
    const clampedSec = clamp(overMs, 0, MAX_EXTRAPOLATE_MS) / 1000;
    if (clampedSec <= 1e-4) return { ...last, slotId: this.slotId };

    // Exponentially damped effective travel duration (smoothly approaches plateau as overMs -> 350 ms)
    const effectiveSec = RUN_ON_TAU_SEC * (1 - Math.exp(-clampedSec / RUN_ON_TAU_SEC));
    const vMs = Math.max(25, last.speedKmh * KMH_TO_MS);
    const rollRad = clamp(last.rollDeg, -55, 55) * DEG_TO_RAD;
    const pitchRad = clamp(last.pitchDeg, -35, 35) * DEG_TO_RAD;
    const yawRate = clamp((14.5 * Math.tan(rollRad)) / vMs, -1.15, 1.15);

    const steps = 4;
    const subDt = effectiveSec / steps;
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

    // Gently relax roll toward level as dead-reckoning stretches out
    const bankDamp = Math.exp(-clampedSec / 0.6);
    const staleMs = Math.max(0, nowMs - (this.lastSeenMs || 0));
    const levelDamp = staleMs > STALE_COAST_MS ? Math.exp(-(staleMs - STALE_COAST_MS) / 600) : 1;

    return {
      slotId: this.slotId,
      x,
      y,
      z,
      yawDeg: wrap360(yawRad * RAD_TO_DEG),
      pitchDeg: last.pitchDeg * bankDamp * levelDamp,
      rollDeg: last.rollDeg * bankDamp * levelDamp,
      speedKmh: last.speedKmh,
      tankPct: last.tankPct,
      releasing: clampedSec < 0.25 ? last.releasing : false,
      scooping: clampedSec < 0.25 ? last.scooping : false,
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
   * Ingest a decoded planes snapshot from StreamClient.
   * Optional `serverTimeMs` enables Host-clock timeline spacing even when client packets arrive clumped.
   */
  pushSnapshot(planes, arrivalMs, localSlotId = null, serverTimeMs = null) {
    let timelineMs = typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs) && serverTimeMs > 0
      ? serverTimeMs
      : arrivalMs;

    if (this._lastTimelineMs !== null && timelineMs <= this._lastTimelineMs) {
      timelineMs = this._lastTimelineMs + MIN_TIMELINE_STEP_MS;
    }
    this._lastTimelineMs = timelineMs;

    this.playback.heard(arrivalMs, timelineMs);
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
  sample(nowMs, { excludeSlotId = null, getRosterInfo = null } = {}) {
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
