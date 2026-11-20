// O(1) bijective slot allocator (slots/{0..99} <-> integer uidToSlot/{uid} + roster/{s}),
// 20 s lease renewal, idle reclamation (90 s warn, 120 s vacate, 300 s goOffline),
// reload recovery for expired uidToSlot, eviction reconciliation, and conditional leaf-delete tracking.

import { MAX_SLOTS, PACING_MS, PROTOCOL_VERSION, defaultCallsign, getBuildHash, sanitizeCallsign } from './config.js';
import { isPermissionDenied } from './RtdbAdapter.js';

export const SLOT_LEASE_MS = 40000;
export const SLOT_RENEW_INTERVAL_MS = 20000;
export const WORLD_TTL_MS = 82_800_000; // 23 h (strictly <= 24 h / 86400000 ms with clock-skew headroom)
export const IDLE_WARN_MS = 90000;
export const IDLE_VACATE_MS = 120000;
export const IDLE_OFFLINE_MS = 300000;

const MAX_CLAIM_RETRIES = 8;

/** Count non-expired active slots in a `worlds/$w/slots` snapshot. */
export function countActiveSlots(slotsMap, now, excludeUid = null) {
  if (!slotsMap || typeof slotsMap !== 'object') return 0;
  let active = 0;
  for (let s = 0; s < MAX_SLOTS; s++) {
    const entry = slotsMap[String(s)];
    if (!entry || typeof entry.leaseUntil !== 'number' || entry.leaseUntil <= now) continue;
    if (excludeUid && entry.uid === excludeUid) continue;
    active++;
  }
  return active;
}

/** Compute staggered basin-perimeter entry spawn pose for slotId 0..99. */
export function computeEntrySpawnPose(slotId, terrain) {
  const halfWorld = terrain?.halfWorld ?? 1024;
  const radius = halfWorld * 0.62;
  const angle = ((slotId * 137.508) % 360) * (Math.PI / 180);
  const x = Math.sin(angle) * radius;
  const z = -Math.cos(angle) * radius;
  const groundY = terrain?.getHeight ? terrain.getHeight(x, z) : 20;
  const waterY = terrain?.waterLevel ?? 12;
  const baseElevation = Math.max(groundY, waterY);
  const agl = 52 + (slotId % 5) * 8;
  const y = baseElevation + agl;
  const yawDeg = ((Math.atan2(-x, z) * 180) / Math.PI + 360) % 360;
  return {
    x,
    y,
    z,
    yawDeg,
    pitchDeg: 0,
    rollDeg: 0,
    speedKmh: 158,
    tankPct: 100,
    slotId,
  };
}

export class SlotAllocator {
  constructor(adapter, worldId, {
    nowFn = () => adapter.now(),
    onIdleVacate = null,
    onIdleOffline = null,
    onEvicted = null,
  } = {}) {
    this.adapter = adapter;
    this.worldId = worldId;
    this._nowFn = nowFn;
    this.onIdleVacate = onIdleVacate;
    this.onIdleOffline = onIdleOffline;
    this.onEvicted = onEvicted;

    this.slotId = null;
    this.connId = null;
    this.hasSlot = false;
    this.hasUidToSlot = false;
    this.hasRoster = false;
    this.hasWrittenIn = false;

    this._lastRenewAt = 0;
    this._lastRosterAt = 0;
    this._claimedAt = 0;
    this._lastActiveAt = this._nowFn();
    this._idleVacated = false;
    this._idleOfflined = false;
    this._claiming = false;
    this.callsign = 'EF-07';
    this.colorIdx = 0;
  }

  get basePath() {
    return `worlds/${this.worldId}`;
  }

  get isSeated() {
    return this.slotId !== null && this.hasSlot;
  }

  /** True within 5 s of claiming a slot (guards against stale RTDB onValue(slots) cache ticks). */
  get recentlyClaimed() {
    return this.isSeated && this._claimedAt > 0 && (this._nowFn() - this._claimedAt) < 5000;
  }

  setConnId(connId) {
    if (connId) this.connId = connId;
  }

  markActive() {
    this._lastActiveAt = this._nowFn();
    this._idleVacated = false;
    this._idleOfflined = false;
  }

  markInputWritten() {
    this.hasWrittenIn = true;
  }

  /** Reconcile local state if Host evicted our slot (stops spamming in/$uid with PERMISSION_DENIED). */
  markEvicted() {
    const wasSeated = this.isSeated;
    this.slotId = null;
    this.hasSlot = false;
    this.hasUidToSlot = false;
    this.hasRoster = false;
    this.hasWrittenIn = false;
    if (wasSeated) {
      this.onEvicted?.();
    }
  }

  /**
   * Evaluate idle timers (90 s warn -> 120 s vacate -> 300 s goOffline).
   */
  tickIdle() {
    const now = this._nowFn();
    const idleMs = Math.max(0, now - this._lastActiveAt);
    let idleCountdown = null;

    if (this.isSeated) {
      if (idleMs >= IDLE_VACATE_MS && !this._idleVacated) {
        this._idleVacated = true;
        this.onIdleVacate?.();
      } else if (idleMs >= IDLE_WARN_MS && idleMs < IDLE_VACATE_MS) {
        idleCountdown = Math.max(1, Math.ceil((IDLE_VACATE_MS - idleMs) / 1000));
      }
    }

    if (idleMs >= IDLE_OFFLINE_MS && !this._idleOfflined) {
      this._idleOfflined = true;
      this.onIdleOffline?.();
    }

    return {
      idleCountdown,
      vacated: this._idleVacated,
      offlined: this._idleOfflined,
    };
  }

  /**
   * Claim an O(1) random vacant slot in slots/{0..99} atomically with integer uidToSlot/{uid} and roster/{s}.
   * - Requires an acked `connId` (written into slots/$s.conn per live database.rules.json).
   * - On reload with an expired prior slot still pointing to us, re-claims that exact slot index!
   * - If world is fresh (!config), atomically writes config + authority (epoch 1, rev 0) together.
   */
  async claim({
    callsign,
    colorIdx = 0,
    connId = this.connId,
    buildHash = getBuildHash(),
    mapId = 'op01',
    cap = MAX_SLOTS,
  } = {}) {
    if (this._claiming) return { seated: false, slotId: this.slotId, createdWorld: false, queued: false };
    if (!connId) {
      throw new Error('SlotAllocator.claim() requires an acknowledged presence connId');
    }
    this._claiming = true;
    this.connId = connId;
    const uid = this.adapter.uid;

    try {
      const safeColor = Math.max(0, Math.min(15, Math.floor(colorIdx) || 0));
      this.colorIdx = safeColor;

      // Read only our own uidToSlot/$uid (parent uidToSlot is not readable under live rules!).
      const [existingSlotVal, config, slotsMap] = await Promise.all([
        this.adapter.get(`${this.basePath}/uidToSlot/${uid}`),
        this.adapter.get(`${this.basePath}/config`),
        this.adapter.get(`${this.basePath}/slots`),
      ]);

      const now = this.adapter.now();
      const slots = slotsMap || {};

      let preferredExpiredSlot = null;
      if (Number.isInteger(existingSlotVal) && existingSlotVal >= 0 && existingSlotVal < MAX_SLOTS) {
        const existingSlot = slots[String(existingSlotVal)];
        if (existingSlot && existingSlot.uid === uid && existingSlot.leaseUntil > now) {
          // Reloaded while our previous lease is still live: re-attach cleanly!
          this.slotId = existingSlotVal;
          this.hasSlot = true;
          this.hasUidToSlot = true;
          this.hasRoster = true;
          this._lastRenewAt = existingSlot.at || now;
          this._lastRosterAt = existingSlot.at || now;
          this._claimedAt = this._nowFn();
          this.callsign = sanitizeCallsign(callsign, defaultCallsign(existingSlotVal));
          this.markActive();
          return { seated: true, slotId: existingSlotVal, createdWorld: false, queued: false };
        }
        if (existingSlot && existingSlot.uid === uid && existingSlot.leaseUntil <= now) {
          // Reloaded after lease expired before Host evicted us: MUST re-claim same slot index (data.val() === newData.val()).
          preferredExpiredSlot = existingSlotVal;
        }
      }

      const effectiveCap = Math.max(1, Math.min(MAX_SLOTS, Math.floor(config?.cap ?? cap) || MAX_SLOTS));
      const activeByOthers = countActiveSlots(slots, now, uid);

      // Build shuffled list of vacant (missing or expired) slots.
      const vacant = [];
      for (let s = 0; s < MAX_SLOTS; s++) {
        if (s === preferredExpiredSlot) continue;
        const entry = slots[String(s)];
        if (!entry || entry.leaseUntil <= now || entry.uid === uid) {
          vacant.push(s);
        }
      }
      for (let i = vacant.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = vacant[i];
        vacant[i] = vacant[j];
        vacant[j] = tmp;
      }
      if (preferredExpiredSlot !== null) {
        vacant.unshift(preferredExpiredSlot);
      }

      if (vacant.length === 0 || activeByOthers >= effectiveCap) {
        return {
          seated: false,
          slotId: null,
          createdWorld: false,
          queued: true,
          full: true,
          activeCount: activeByOthers,
          cap: effectiveCap,
        };
      }

      const creatingWorld = !config;
      const attempts = Math.min(MAX_CLAIM_RETRIES, vacant.length);

      for (let a = 0; a < attempts; a++) {
        const s = vacant[a];
        const sKey = String(s);
        const cleanName = sanitizeCallsign(callsign, defaultCallsign(s));
        const tNow = this.adapter.now();
        const updates = {
          [`slots/${sKey}`]: {
            uid,
            conn: connId,
            at: this.adapter.serverTimestamp(),
            leaseUntil: tNow + SLOT_LEASE_MS,
          },
          [`uidToSlot/${uid}`]: s,
          [`roster/${sKey}`]: {
            uid,
            name: cleanName,
            color: safeColor,
            at: this.adapter.serverTimestamp(),
          },
        };

        if (creatingWorld) {
          updates.config = {
            mode: 'megabasin',
            mapId,
            cap: Math.max(1, Math.min(MAX_SLOTS, Math.floor(cap) || MAX_SLOTS)),
            protocolVersion: PROTOCOL_VERSION,
            buildHash,
            createdAt: this.adapter.serverTimestamp(),
            expiresAt: tNow + WORLD_TTL_MS,
          };
          updates.authority = {
            uid,
            epoch: 1,
            rev: 0,
            leaseUntil: tNow + 8000,
          };
        }

        try {
          await this.adapter.update(this.basePath, updates);
          this.slotId = s;
          this.hasSlot = true;
          this.hasUidToSlot = true;
          this.hasRoster = true;
          this._lastRenewAt = tNow;
          this._lastRosterAt = tNow;
          this._claimedAt = this._nowFn();
          this.callsign = cleanName;
          this.markActive();
          return { seated: true, slotId: s, createdWorld: creatingWorld, queued: false };
        } catch (err) {
          if (!isPermissionDenied(err)) throw err;
          if (creatingWorld) {
            const recheckCfg = await this.adapter.get(`${this.basePath}/config`).catch(() => null);
            if (recheckCfg) {
              this._claiming = false;
              return this.claim({ callsign, colorIdx: safeColor, connId, buildHash, mapId, cap });
            }
          }
        }
      }

      return {
        seated: false,
        slotId: null,
        createdWorld: false,
        queued: true,
        full: true,
        activeCount: countActiveSlots(slots, this.adapter.now(), uid),
        cap: effectiveCap,
      };
    } finally {
      this._claiming = false;
    }
  }

  /** Inspect current world capacity (returns full=true when all cap slots are occupied by other pilots). */
  async checkCapacity({ cap = MAX_SLOTS } = {}) {
    const uid = this.adapter.uid;
    const [config, slotsMap] = await Promise.all([
      this.adapter.get(`${this.basePath}/config`).catch(() => null),
      this.adapter.get(`${this.basePath}/slots`).catch(() => null),
    ]);
    const now = this.adapter.now();
    const slots = slotsMap || {};
    const effectiveCap = Math.max(1, Math.min(MAX_SLOTS, Math.floor(config?.cap ?? cap) || MAX_SLOTS));
    let alreadySeated = false;
    for (let s = 0; s < MAX_SLOTS; s++) {
      const entry = slots[String(s)];
      if (entry && entry.uid === uid && entry.leaseUntil > now) {
        alreadySeated = true;
        break;
      }
    }
    const activeByOthers = countActiveSlots(slots, now, uid);
    return {
      full: !alreadySeated && activeByOthers >= effectiveCap,
      activeCount: activeByOthers + (alreadySeated ? 1 : 0),
      cap: effectiveCap,
      alreadySeated,
    };
  }

  /** Renew slot lease every 20 s (respecting >= 10 s server pacing). Unseats cleanly if evicted. */
  async renewIfDue(force = false, connId = this.connId) {
    if (!this.isSeated || !connId) return false;
    const now = this.adapter.now();
    const minInterval = force ? PACING_MS.slotRenew + 200 : SLOT_RENEW_INTERVAL_MS;
    if (now - this._lastRenewAt < minInterval) return false;

    const s = this.slotId;
    try {
      await this.adapter.set(`${this.basePath}/slots/${s}`, {
        uid: this.adapter.uid,
        conn: connId,
        at: this.adapter.serverTimestamp(),
        leaseUntil: now + SLOT_LEASE_MS,
      });
      this.connId = connId;
      this._lastRenewAt = now;
      return true;
    } catch (err) {
      if (isPermissionDenied(err)) {
        // Check if our slot was evicted or taken over by another pilot.
        const current = await this.adapter.get(`${this.basePath}/slots/${s}`).catch(() => undefined);
        if (current !== undefined && (!current || current.uid !== this.adapter.uid)) {
          this.markEvicted();
        }
      }
      return false;
    }
  }

  /** Update callsign or livery color in roster/{s} (respecting >= 1 s pacing). */
  async updateProfile(callsign, colorIdx) {
    if (!this.isSeated) return false;
    const now = this.adapter.now();
    if (now - this._lastRosterAt < PACING_MS.roster + 100) return false;

    const s = this.slotId;
    const cleanName = sanitizeCallsign(callsign, defaultCallsign(s));
    const safeColor = Math.max(0, Math.min(15, Math.floor(colorIdx) || 0));

    try {
      await this.adapter.set(`${this.basePath}/roster/${s}`, {
        uid: this.adapter.uid,
        name: cleanName,
        color: safeColor,
        at: this.adapter.serverTimestamp(),
      });
      this.callsign = cleanName;
      this.colorIdx = safeColor;
      this._lastRosterAt = now;
      this.hasRoster = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleanly vacate slot + roster + uidToSlot (+ in/$uid ONLY if previously written!).
   * Strictly enforces conditional leaf deletion so missing leaves never cause PERMISSION_DENIED.
   */
  async vacate() {
    const uid = this.adapter.uid;
    const s = this.slotId;
    const updates = {};

    if (this.hasSlot && s !== null) updates[`slots/${s}`] = null;
    if (this.hasUidToSlot) updates[`uidToSlot/${uid}`] = null;
    if (this.hasRoster && s !== null) updates[`roster/${s}`] = null;
    if (this.hasWrittenIn) updates[`in/${uid}`] = null;

    this.slotId = null;
    this.hasSlot = false;
    this.hasUidToSlot = false;
    this.hasRoster = false;
    this.hasWrittenIn = false;

    if (Object.keys(updates).length === 0) return;

    try {
      await this.adapter.update(this.basePath, updates);
    } catch {
      for (const path of Object.keys(updates)) {
        await this.adapter.remove(`${this.basePath}/${path}`).catch(() => {});
      }
    }
  }
}
