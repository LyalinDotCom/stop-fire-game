// Top-level multiplayer session orchestrator for EMBER FRONT (docs/INTERFACES.md §6).
// Coordinates Link, Presence, SlotAllocator, AuthorityElection, HostBroadcaster,
// StreamClient, and PlaneInterpolator with zero-write DEMO FLIGHT entry,
// live database.rules.json compliance, seamless Host/Replica failover, and clean teardown.

import { AuthorityElection } from './AuthorityElection.js';
import { DEFAULT_WORLD_ID } from './firebaseConfig.js';
import { HostBroadcaster } from './HostBroadcaster.js';
import { Link } from './Link.js';
import { PlaneInterpolator } from './PlaneInterpolator.js';
import { Presence } from './Presence.js';
import { SlotAllocator, computeEntrySpawnPose } from './SlotAllocator.js';
import { StreamClient } from './StreamClient.js';
import { MAX_SLOTS, PACING_MS, defaultCallsign, getBuildHash, sanitizeCallsign } from './config.js';
import { encodeInput } from './protocol.js';

const INPUT_SEND_INTERVAL_MS = 250; // 4 Hz nominal (safely above 180 ms server pacing rule)
const DEFAULT_CONNECT_TIMEOUT_MS = 5500;
const LINK_OFFLINE_FALLBACK_SEC = 12;
const HOST_PUBLISH_STALL_ABDICATE_MS = 4500;

export class WorldSession {
  constructor({
    adapter,
    terrain,
    fireSim,
    opConfig = null,
    opIndex = null,
    worldId = DEFAULT_WORLD_ID,
    buildHash = getBuildHash(),
    callsign = 'EF-07',
    colorIdx = 0,
    mode = 'mp',
    fallbackOnFull = false,
    forceFreshMission = false,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    onStatusChange = null,
    onScoreEvents = null,
    onDropOutcomes = null,
    onWorldEvents = null,
    onOperationChange = null,
    onOperationAdvance = null,
    onPilotJoined = null,
    onMetaUpdate = null,
    onImpactEvents = null,
    onFireSync = null,
    onIdleVacate = null,
    onIdleOffline = null,
    onEvicted = null,
    onCapacityFull = null,
    onConnectionError = null,
    disableRealTimers = false,
    electionBackoffRangeMs = null,
  }) {
    this.adapter = adapter;
    this.terrain = terrain;
    this.fireSim = fireSim;
    this.opConfig = opConfig;
    const initialOpIndex = opIndex ?? opConfig?.opIndex ?? 0;
    this.opIndex = Math.max(0, Math.min(4, Math.floor(initialOpIndex) || 0));
    this.worldId = worldId;
    this.buildHash = buildHash;
    this.callsign = sanitizeCallsign(callsign, 'EF-07');
    this.colorIdx = Math.max(0, Math.min(15, Math.floor(colorIdx) || 0));
    this.mode = mode;
    this.fallbackOnFull = Boolean(fallbackOnFull);
    this._forceFreshMission = Boolean(forceFreshMission);
    this.connectTimeoutMs = connectTimeoutMs;

    this.onStatusChange = onStatusChange;
    this.onScoreEvents = onScoreEvents;
    this.onDropOutcomes = onDropOutcomes;
    this.onWorldEvents = onWorldEvents;
    this.onOperationChange = onOperationChange;
    this.onOperationAdvance = onOperationAdvance;
    this.onPilotJoined = onPilotJoined;
    this.onMetaUpdate = onMetaUpdate;
    this.onImpactEvents = onImpactEvents;
    this.onFireSync = onFireSync;
    this.onIdleVacate = onIdleVacate;
    this.onIdleOffline = onIdleOffline;
    this.onEvicted = onEvicted;
    this.onCapacityFull = onCapacityFull;
    this.onConnectionError = onConnectionError;

    this._disableRealTimers = disableRealTimers;
    this._electionBackoffRangeMs = electionBackoffRangeMs;

    this.started = false;
    this.stopped = false;
    this.queued = false;
    this.offlineFallback = false;
    this._everConnected = false;
    this._offlineKind = null; // null | 'offline_full' | 'offline_error'
    this._offlineReason = null;
    this._fallbackTriggered = false;
    this._connectTimer = null;
    this._status = 'syncing';
    this._lastInputSentAt = 0;
    this._inputInFlightSince = 0;
    this._inputSeq = 0;
    this._inputSeqConnId = null;
    this._latestAircraft = null;
    this._latestDropSeq = 0;
    this._lastSentDropSeq = 0;
    this._idleCountdown = null;
    this._hostReadyResolvers = [];

    this.link = null;
    this.presence = null;
    this.allocator = null;
    this.election = null;
    this.host = null;
    this.stream = null;
    this.interpolator = new PlaneInterpolator();
    this._offLink = null;
    this._offRenewBeat = null;
  }

  get isHost() {
    return !!(this.election?.isHost && this.host?.running);
  }

  get localSlotId() {
    return this.allocator?.slotId ?? null;
  }

  _triggerOfflineFallback(kind, reason) {
    if (this._fallbackTriggered || this.stopped) return;
    this._fallbackTriggered = true;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this.queued = false;
    this.offlineFallback = true;
    this._offlineKind = kind;
    this._offlineReason = reason;
    this._stopHost();
    this.link?.pause();
    try {
      this.adapter.goOffline();
    } catch {
      // ignore
    }
    this._updateStatus();
    if (kind === 'offline_full') {
      this.onCapacityFull?.({ reason, cap: MAX_SLOTS });
    } else {
      this.onConnectionError?.({ reason, kind });
    }
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    const nowFn = this._disableRealTimers ? () => this.adapter.now() : () => performance.now();

    this.link = new Link(this.adapter, {
      nowFn,
      disableTicker: this._disableRealTimers,
    });
    if (this.link.up) {
      this._everConnected = true;
    }

    this._offLink = this.link.on((up) => {
      if (up) {
        this._everConnected = true;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
      }
      this._updateStatus();
      if (!up && this.link.downFor() > LINK_OFFLINE_FALLBACK_SEC) {
        this._triggerOfflineFallback('offline_error', 'Lost connection to live airspace');
      }
    });

    if (!this._disableRealTimers && this.connectTimeoutMs > 0 && !this._everConnected) {
      this._connectTimer = setTimeout(() => {
        this._connectTimer = null;
        if (!this.stopped && !this._everConnected && !this.link?.up) {
          this._triggerOfflineFallback('offline_error', 'Live airspace connection timed out');
        }
      }, this.connectTimeoutMs);
      if (typeof this._connectTimer.unref === 'function') this._connectTimer.unref();
    }

    this.allocator = new SlotAllocator(this.adapter, this.worldId, {
      nowFn: () => this.adapter.now(),
      onIdleVacate: () => {
        this.returnToDemoFlight().catch(() => {});
        this.onIdleVacate?.();
      },
      onIdleOffline: () => {
        this.offlineFallback = true;
        this.link?.pause();
        this.adapter.goOffline();
        this._updateStatus();
        this.onIdleOffline?.();
      },
      onEvicted: () => {
        this._stopHost();
        this._updateStatus();
        this.onEvicted?.();
      },
    });

    this.stream = new StreamClient(this.adapter, this.worldId, {
      fireSim: null,
      opIndex: this.opIndex,
      nowFn,
      onOperationChange: async (nextOpIndex, keyState) => {
        if (!this.isHost && !this._forceFreshMission) {
          this.opIndex = nextOpIndex;
          await this.onOperationChange?.(nextOpIndex, keyState);
        }
      },
      onFireKey: (keyState) => {
        if (!this.isHost && !this._forceFreshMission && this.fireSim && keyState.gridSize === this.fireSim.gridSize) {
          this.fireSim.applyExternalKey(keyState);
          this.onFireSync?.({ full: true, dirtyIndices: null });
        }
      },
      onFireDelta: (delta) => {
        if (!this.isHost && !this._forceFreshMission && this.fireSim) {
          const dirty = this.fireSim.applyExternalDelta(delta);
          // Drain FireSim's replica drop outcome mirror so it doesn't accumulate;
          // drop outcomes are delivered once via StreamClient.onDropOutcomes below.
          if (typeof this.fireSim.drainDropOutcomes === 'function') {
            this.fireSim.drainDropOutcomes();
          }
          const worldEvents = typeof this.fireSim.drainWorldEvents === 'function'
            ? this.fireSim.drainWorldEvents()
            : [];
          if (worldEvents.length) {
            this.onWorldEvents?.(worldEvents);
          }
          this.onFireSync?.({ full: false, dirtyIndices: dirty });
        }
      },
      onPlanes: (planes, info) => {
        this.interpolator.pushSnapshot(planes, info.arrivedAtMs, this.localSlotId, info.serverTimeMs);
      },
      onMeta: (meta) => {
        this.onMetaUpdate?.(meta);
      },
      onSlots: (slots) => {
        // Reconcile eviction: if Host evicted our slot, unseat locally instead of spamming in/$uid!
        // Ignore stale pre-claim snapshots arriving within 5 s of claim().
        if (this.allocator.isSeated && !this.allocator.recentlyClaimed) {
          const mine = slots?.[String(this.allocator.slotId)];
          if (!mine || mine.uid !== this.adapter.uid) {
            this.allocator.markEvicted();
            return;
          }
        }
        if (this.queued && slots) {
          const now = this.adapter.now();
          let active = 0;
          for (const s of Object.values(slots)) {
            if (s && s.leaseUntil > now) active++;
          }
          if (active < MAX_SLOTS) {
            this.requestManualControl().catch(() => {});
          }
        }
      },
      onScoreEvents: (events) => {
        if (!this.isHost) this.onScoreEvents?.(events);
      },
      onDropOutcomes: (outcomes) => {
        if (!this.isHost) this.onDropOutcomes?.(outcomes);
      },
      onPilotJoined: (pilot) => {
        this.onPilotJoined?.(pilot);
      },
    });

    this.election = new AuthorityElection(this.adapter, this.worldId, {
      link: this.link,
      canBeHost: () => this.allocator.isSeated && !!this.presence?.connId && !this.presence.record?.away,
      hasOtherPeers: () => (this.stream ? this.stream.getSeatedCount(this.adapter.now()) > 1 : false),
      backoffRangeMs: this._electionBackoffRangeMs,
      disablePageHooks: this._disableRealTimers,
      onBecameHost: ({ epoch, isFailover }) => {
        this._startHost(epoch, isFailover);
      },
      onLostHost: () => {
        this._stopHost();
      },
      onAuthorityChange: () => {
        this._updateStatus();
      },
    });

    this.election.start();
    await this.stream.start();

    if (this.stopped) return;

    if (this.fallbackOnFull) {
      const cap = await this.allocator.checkCapacity().catch(() => null);
      if (this.stopped) return;
      if (cap && cap.full) {
        this._triggerOfflineFallback('offline_full', `Airspace full (${cap.activeCount}/${cap.cap})`);
        return;
      }
    }

    this._offRenewBeat = this.link.every(2000, () => {
      if (this.allocator.isSeated) {
        this.allocator.renewIfDue(false, this.presence?.connId).catch(() => {});
      }
      this.election.tick().catch(() => {});
    });

    this._updateStatus();
  }

  /**
   * Swap active Operation terrain & FireSim while keeping the live RTDB session,
   * slot lease, presence, and Host authority continuously intact.
   */
  setWorld({ terrain, fireSim, opConfig = null, opIndex = null, publishNow = true } = {}) {
    if (terrain) this.terrain = terrain;
    if (fireSim) this.fireSim = fireSim;
    if (opConfig) this.opConfig = opConfig;
    const nextOpIndex = opIndex ?? opConfig?.opIndex;
    if (typeof nextOpIndex === 'number') {
      this.opIndex = Math.max(0, Math.min(4, Math.floor(nextOpIndex)));
      this.stream?.setOperationIndex(this.opIndex);
    }
    if (this.host?.running) {
      this.host.setWorld({
        terrain: this.terrain,
        fireSim: this.fireSim,
        opIndex: this.opIndex,
        worldName: this.opConfig?.name,
        publishNow,
      });
    }
  }

  _startHost(epoch, isFailover) {
    if (this.stopped) return;
    if (this.host?.running) {
      this.host.setEpoch(epoch);
      this.host.setLocalSlotId(this.localSlotId);
      return;
    }

    this.host = new HostBroadcaster(this.adapter, this.worldId, {
      terrain: this.terrain,
      fireSim: this.fireSim,
      epoch,
      opIndex: this.opIndex,
      buildHash: this.buildHash,
      worldName: this.opConfig?.name || 'Cinderpine Basin',
      localSlotId: this.localSlotId,
      enableBackgroundTicker: !this._disableRealTimers,
      onScoreEvents: (events) => this.onScoreEvents?.(events),
      onImpactEvents: (impacts) => this.onImpactEvents?.(impacts),
      onDropOutcomes: (outcomes) => this.onDropOutcomes?.(outcomes),
      onWorldEvents: (events) => this.onWorldEvents?.(events),
      onOperationAdvance: this.onOperationAdvance ? (info) => this.onOperationAdvance(info) : null,
      onOperationHydrated: async (opIdx, keyState) => {
        this.opIndex = opIdx;
        this.stream?.setOperationIndex(opIdx);
        await this.onOperationChange?.(opIdx, keyState);
      },
      onSimStep: (stepDelta) => {
        if (stepDelta.fullReset) {
          this.onFireSync?.({ full: true, dirtyIndices: null });
        } else if (stepDelta.changedCells?.length) {
          this.onFireSync?.({
            full: false,
            dirtyIndices: stepDelta.changedCells.map((c) => c.idx),
          });
        }
      },
    });

    if (this._latestAircraft) {
      this.host.setLocalAircraft(this._latestAircraft, this._latestDropSeq);
    }

    const forceFresh = this._forceFreshMission;
    this._forceFreshMission = false;

    this.host.start({ isFailover, forceFreshMission: forceFresh }).then(() => {
      this._updateStatus();
      const waiters = this._hostReadyResolvers.splice(0);
      for (const resolve of waiters) resolve(true);
    }).catch(() => {
      const waiters = this._hostReadyResolvers.splice(0);
      for (const resolve of waiters) resolve(false);
    });
  }

  /** Wait until this client is active & hydrated as authoritative Host (used by HOST LOBBY). */
  async waitUntilHostReady(timeoutMs = 5000) {
    if (this.stopped) return false;
    if (this.isHost && this.host?.hydrated) return true;
    if (!this.election?.isHost && this.allocator?.isSeated) {
      await this.election?.attemptTakeover().catch(() => false);
    }
    if (this.isHost && this.host?.hydrated) return true;
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(Boolean(this.isHost && this.host?.hydrated)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this._hostReadyResolvers.push(done);
    });
  }

  /** Keep latest local aircraft reference synced to HostBroadcaster even before seating finishes. */
  setLocalAircraft(aircraft, dropSeq = 0) {
    if (!aircraft) return;
    this._latestAircraft = aircraft;
    this._latestDropSeq = dropSeq;
    if (this.host?.running) {
      this.host.setLocalAircraft(aircraft, dropSeq);
    }
  }

  _stopHost() {
    if (this.host) {
      this.host.stop();
      this.host = null;
    }
    this._updateStatus();
  }

  async requestManualControl() {
    if (this.stopped) return { seated: false, slotId: null, spawnPose: null, queued: false };
    if (this.offlineFallback) {
      this.offlineFallback = false;
      this.link?.resume();
      this.adapter.goOnline();
    }

    this.allocator.markActive();

    if (this.allocator.isSeated) {
      return {
        seated: true,
        slotId: this.allocator.slotId,
        spawnPose: null,
        queued: false,
      };
    }

    // Step 1: Establish connId-fenced presence and await ack FIRST.
    if (!this.presence || this.presence.stopped) {
      this.presence = new Presence(this.adapter, this.worldId, this.link, {
        autoStart: true,
        nowFn: () => this.adapter.now(),
        onConnChange: (connId) => {
          this.allocator?.setConnId(connId);
        },
      });
    }
    const ackedConnId = await this.presence.ready;
    if (!ackedConnId || this.stopped) {
      return { seated: false, slotId: null, spawnPose: null, queued: false };
    }

    // Step 2: Claim O(1) slot atomically with acked connId (and config+authority if fresh world).
    const res = await this.allocator.claim({
      callsign: this.callsign,
      colorIdx: this.colorIdx,
      connId: ackedConnId,
      buildHash: this.buildHash,
      mapId: this.opConfig?.id || 'op01',
    });

    if (!res.seated) {
      if (res.full && this.fallbackOnFull) {
        const cap = res.cap ?? MAX_SLOTS;
        const count = res.activeCount ?? cap;
        this._triggerOfflineFallback('offline_full', `Airspace full (${count}/${cap})`);
        return { seated: false, slotId: null, spawnPose: null, queued: false, full: true };
      }
      this.queued = !!res.queued;
      this._updateStatus();
      return { seated: false, slotId: null, spawnPose: null, queued: this.queued, full: !!res.full };
    }

    this.queued = false;
    this.callsign = this.allocator.callsign;
    const spawnPose = computeEntrySpawnPose(res.slotId, this.terrain);

    if (res.createdWorld) {
      this.election.notifyInitialHost({
        uid: this.adapter.uid,
        epoch: 1,
        rev: 0,
        leaseUntil: this.adapter.now() + 8000,
      });
    } else if (this.host?.running) {
      this.host.setLocalSlotId(res.slotId);
    } else {
      await this.election.tick();
    }

    this._updateStatus();
    return { seated: true, slotId: res.slotId, spawnPose, queued: false };
  }

  async returnToDemoFlight() {
    this.queued = false;

    if (this.election?.isHost) {
      if (this.host?.running && this.host.hydrated) {
        await this.host.publishFireRing().catch(() => {});
      }
      await this.election.abdicate();
    }
    this._stopHost();

    if (this.allocator) {
      await this.allocator.vacate();
    }
    if (this.presence) {
      await this.presence.stop();
      this.presence = null;
    }

    this._lastInputSentAt = 0;
    this._inputSeq = 0;
    this._inputSeqConnId = null;
    this._idleCountdown = null;
    this._updateStatus();
  }

  resumeLive() {
    this.offlineFallback = false;
    this.allocator?.markActive();
    this.link?.resume();
    this.adapter.goOnline();
    this._updateStatus();
  }

  /** Send rate-limited 4 Hz local aircraft state to `in/$uid` while seated (keeps slot alive through crash/respawn). */
  sendLocalState(aircraft, dropSeq = 0) {
    if (this.stopped || !aircraft) return;
    this._latestAircraft = aircraft;
    this._latestDropSeq = dropSeq;

    if (!aircraft.autopilot) {
      this.allocator?.markActive();
    }

    if (this.host?.running) {
      this.host.setLocalAircraft(aircraft, dropSeq);
    }

    if (!this.allocator?.isSeated) return;
    const connId = this.presence?.connId;
    if (!connId || this.presence.record?.away) return;

    // Host consumes its own aircraft directly; skip redundant in/$uid self-write while hosting.
    if (this.isHost) return;

    const now = this.adapter.now();
    const urgentDrop = dropSeq !== this._lastSentDropSeq;
    const minInterval = urgentDrop ? (PACING_MS.input + 15) : INPUT_SEND_INTERVAL_MS;
    if (now - this._lastInputSentAt < minInterval) return;

    if (this._inputSeqConnId !== connId) {
      this._inputSeq = 0;
      this._inputSeqConnId = connId;
    }
    const seq = ++this._inputSeq;
    const wireState = aircraft.crashed
      ? { ...aircraft, speedKmh: 0, releasing: false, scooping: false }
      : aircraft;
    const d = encodeInput(wireState, dropSeq);
    this._lastInputSentAt = now;
    this._lastSentDropSeq = dropSeq;
    const path = `worlds/${this.worldId}/in/${this.adapter.uid}`;
    if (!this._inputInFlightSince) this._inputInFlightSince = this._nowPerf();

    this.adapter.set(path, {
      s: seq,
      t: this.adapter.serverTimestamp(),
      c: connId,
      d,
    }).then(() => {
      this._inputInFlightSince = 0;
      this.allocator?.markInputWritten();
    }).catch(() => {
      this._inputInFlightSince = 0;
    });
  }

  async updateProfile(callsign, colorIdx) {
    const clean = sanitizeCallsign(callsign, this.callsign || 'EF-07');
    const safeColor = Math.max(0, Math.min(15, Math.floor(colorIdx) || 0));
    this.callsign = clean;
    this.colorIdx = safeColor;
    if (this.allocator?.isSeated) {
      await this.allocator.updateProfile(clean, safeColor);
    }
  }

  _nowPerf() {
    return this._disableRealTimers ? this.adapter.now() : performance.now();
  }

  _updateStatus() {
    let next = 'live';
    if (this.offlineFallback || !this.link?.up) {
      next = 'offline';
    } else if (this.isHost) {
      next = 'host';
    } else if (this.election?.syncing) {
      next = 'syncing';
    }
    if (next !== this._status) {
      this._status = next;
      this.onStatusChange?.(next, this.getNetState());
    }
  }

  getNetState() {
    const slotId = this.localSlotId;
    const slotScores = this.fireSim?.getSlotScores?.() || new Map();
    const personalScore = slotId !== null ? (slotScores.get(slotId) || 0) : 0;

    let top10 = this.stream?.meta?.top10 || [];
    if (this.isHost || top10.length === 0) {
      top10 = Array.from(slotScores.entries())
        .filter(([, sc]) => sc > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([sid, score]) => {
          const info = this.stream?.getRosterInfo(sid) || {
            callsign: defaultCallsign(sid),
            colorIdx: sid % 16,
          };
          return { slotId: sid, name: info.callsign, score, colorIdx: info.colorIdx };
        });
    }

    const pilotsCount = Math.max(
      slotId !== null ? 1 : 0,
      this.stream ? this.stream.getSeatedCount(this.adapter.now()) : 0
    );

    let connStatus = this.isHost ? 'host' : 'online';
    if (this._offlineKind === 'offline_full') {
      connStatus = 'offline_full';
    } else if (this._offlineKind === 'offline_error' || this.offlineFallback) {
      connStatus = 'offline_error';
    } else if (!this.link || !this.link.up) {
      connStatus = 'connecting';
    }

    return {
      mode: this.mode,
      status: this._status,
      connStatus,
      isHost: this.isHost,
      worldId: this.worldId,
      offlineReason: this._offlineReason,
      opIndex: this.opIndex,
      pilotsCount,
      pilotsCap: MAX_SLOTS,
      localSlotId: slotId,
      personalScore,
      top10,
      queueBanner: this.queued ? 'SQUADRON FULL · AUTO-QUEUED' : null,
      idleCountdown: this._idleCountdown,
      offlineFallback: this.offlineFallback,
    };
  }

  step(dt, renderTimeMs = this._nowPerf()) {
    if (this.stopped) {
      return { remotePlanes: [], localAuthTank: null, isHost: false, netState: this.getNetState() };
    }

    const keyWait = this.stream?.waitingMs(renderTimeMs) || 0;
    const inWait = this._inputInFlightSince ? Math.max(0, renderTimeMs - this._inputInFlightSince) : 0;
    const hostPublishWait = this.host?.running ? this.host.getPublishWaitMs(this.adapter.now()) : 0;
    this.link?.step(Math.max(keyWait, inWait, hostPublishWait));

    // Laggy Host self-abdication: if our publish loop stalls > 4.5 s while healthy peers exist, yield cleanly!
    if (
      this.isHost &&
      hostPublishWait > HOST_PUBLISH_STALL_ABDICATE_MS &&
      (this.stream?.getSeatedCount(this.adapter.now()) || 0) > 1
    ) {
      this.election?.abdicate().catch(() => {});
    }

    // Prolonged connection outage -> clean offline fallback so player keeps flying locally.
    if (
      this.link &&
      !this.link.up &&
      !this.offlineFallback &&
      this.link.downFor(renderTimeMs) > LINK_OFFLINE_FALLBACK_SEC
    ) {
      this._triggerOfflineFallback('offline_error', 'Live airspace connection lost');
    }

    if (this.allocator) {
      const idle = this.allocator.tickIdle();
      this._idleCountdown = idle.idleCountdown;
    }

    if (this.host?.running) {
      this.host.step(dt);
    }

    this.stream?.tick();

    if (this._disableRealTimers) {
      this.election?.tick().catch(() => {});
      if (this.allocator?.isSeated) {
        this.allocator.renewIfDue(false, this.presence?.connId).catch(() => {});
      }
    }

    const remotePlanes = this.interpolator.sample(renderTimeMs, {
      excludeSlotId: this.localSlotId,
      getRosterInfo: (sid) => this.stream.getRosterInfo(sid),
    });

    const localAuthTank = this.isHost && this.localSlotId !== null
      ? this.host.getPilotTank(this.localSlotId)
      : this.interpolator.localAuthTank;

    this._updateStatus();

    return {
      remotePlanes,
      localAuthTank,
      isHost: this.isHost,
      netState: this.getNetState(),
    };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._offLink?.();
    this._offRenewBeat?.();

    if (this.election) {
      if (this.election.isHost && this.host?.running && this.host.hydrated) {
        await this.host.publishFireRing().catch(() => {});
      }
      await this.election.stop({ abdicateIfHost: true });
    }
    this._stopHost();
    if (this.allocator) {
      await this.allocator.vacate();
    }
    if (this.presence) {
      await this.presence.stop();
      this.presence = null;
    }
    this.stream?.stop();
    this.link?.stop();
    this.interpolator.clear();
  }
}
