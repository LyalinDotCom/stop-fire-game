/**
 * EMBER FRONT — Main Application Wiring
 *
 * Strictly zero-Firebase in Solo mode: all src/net/* modules (and transitively
 * the Firebase SDK) are loaded ONLY via dynamic import() when entering
 * Multiplayer (?mode=mp / drawer switch) or 100-Bot Loopback (?loopback=100).
 */

import { OPERATIONS, MEGA_BASIN_OP, getOperationById } from './config/operations.js';
import { LIVERIES } from './config/liveries.js';
import { generateTerrain } from './sim/TerrainGen.js';
import { createAircraftState, stepFlight, predictDropImpact } from './sim/FlightModel.js';
import { Autopilot } from './sim/Autopilot.js';
import { FireSim } from './sim/FireSim.js';
import { SceneRenderer } from './render/SceneRenderer.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { HudController } from './ui/HudController.js';
import { InputManager } from './input/InputManager.js';

const FIXED_DT = 1 / 60;
const FIRE_DT = 0.1; // 10 Hz cellular wildfire tick
const WATER_PARCEL_INTERVAL = 0.1; // 100 ms ballistic water parcel cadence

const LS_KEYS = {
  callsign: 'emberfront.callsign',
  colorIdx: 'emberfront.colorIdx',
  invertPitch: 'emberfront.invertPitch',
  showDropReticle: 'emberfront.showDropReticle',
  mouseYoke: 'emberfront.mouseYoke',
};

const CALLSIGN_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,15}$/;

function sanitizeCallsign(raw) {
  if (typeof raw !== 'string') return 'EF-07';
  const cleaned = raw.trim().replace(/[^A-Za-z0-9 _.'-]/g, '').slice(0, 16).trim();
  if (!cleaned || !CALLSIGN_RE.test(cleaned)) return 'EF-07';
  return cleaned;
}

function readStorage(key, fallback) {
  try {
    const val = window.localStorage.getItem(key);
    return val === null ? fallback : val;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // ignore private browsing / quota errors
  }
}

function parseQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const modeParam = (params.get('mode') || '').toLowerCase();
  const worldParam = params.get('world') || '';
  const opParam = params.get('op') || '';
  const loopbackRaw = params.get('loopback') ?? params.get('bots');
  let loopbackTotal = 0;
  if (loopbackRaw !== null) {
    const n = parseInt(loopbackRaw, 10);
    loopbackTotal = Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(2, n)) : 100;
  }
  return {
    modeParam,
    worldParam,
    opParam,
    loopbackTotal,
    useEmulator: params.has('emu'),
    perTabAuth: params.has('tab'),
  };
}

function computeInitialSpawn(terrain, fireSnapshot, slotId = 7, colorIdx = 0, callsign = 'EF-07') {
  const scoop = terrain.scoopZones && terrain.scoopZones[0];
  const target = (fireSnapshot && (fireSnapshot.atRiskTarget || fireSnapshot.fireHead)) || { x: 200, z: 0 };

  let spawnX = scoop ? scoop.x - 55 : -280;
  let spawnZ = scoop ? scoop.z + 200 : 220;

  // Offset slightly away from the fire head along a scenic approach vector
  const dx = target.x - spawnX;
  const dz = target.z - spawnZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 220) {
    spawnX = target.x - 320;
    spawnZ = target.z + 240;
  }

  // Clamp inside basin margin
  const maxCoord = terrain.halfWorld * 0.72;
  spawnX = Math.max(-maxCoord, Math.min(maxCoord, spawnX));
  spawnZ = Math.max(-maxCoord, Math.min(maxCoord, spawnZ));

  const groundY = Math.max(terrain.waterLevel, terrain.getHeight(spawnX, spawnZ));
  const yawRad = Math.atan2(target.x - spawnX, -(target.z - spawnZ));
  const yawDeg = ((yawRad * 180) / Math.PI + 360) % 360;

  return createAircraftState({
    x: spawnX,
    y: groundY + 52,
    z: spawnZ,
    yawDeg,
    pitchDeg: 0,
    rollDeg: 0,
    speedKmh: 158,
    throttle: 0.47,
    tankPct: 100,
    autopilot: true,
    callsign,
    slotId,
    colorIdx,
  });
}

function computeStarRating(cabinsAlive, cabinsTotal) {
  if (cabinsTotal <= 0) return 3;
  const ratio = cabinsAlive / cabinsTotal;
  if (ratio >= 1.0) return 3;
  if (ratio >= 0.8) return 2;
  if (ratio >= 0.5) return 1;
  return 0;
}

function getBuildHash() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __BUILD_HASH__ === 'string' && __BUILD_HASH__.length === 12) {
      // eslint-disable-next-line no-undef
      return __BUILD_HASH__;
    }
  } catch {
    // ignore
  }
  return '000000000000';
}

class EmberFrontApp {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    if (!this.canvas) {
      throw new Error('Missing #game-canvas element in index.html');
    }

    this.query = parseQueryParams();
    this.settings = {
      callsign: sanitizeCallsign(readStorage(LS_KEYS.callsign, 'EF-07')),
      colorIdx: Math.max(0, Math.min(LIVERIES.length - 1, parseInt(readStorage(LS_KEYS.colorIdx, '0'), 10) || 0)),
      invertPitch: readStorage(LS_KEYS.invertPitch, 'false') === 'true',
      showDropReticle: readStorage(LS_KEYS.showDropReticle, 'true') !== 'false',
      mouseYoke: readStorage(LS_KEYS.mouseYoke, 'false') === 'true',
    };

    // Runtime state
    this.mode = 'solo'; // 'solo' | 'mp' | 'loopback'
    this.opConfig = OPERATIONS[0];
    this.terrain = null;
    this.fireSim = null;
    this.autopilot = null;
    this.aircraft = null;
    this.renderer = null;
    this.remotePlanes = [];
    this.lastNetState = this._makeSoloNetState();

    // Active multiplayer / loopback handles (lazily created)
    this._mpSession = null;
    this._loopbackHandle = null;
    this._mpClaimPending = false;
    this._modeSwitchSeq = 0;

    // Loop / simulation accumulators
    this._physAccum = 0;
    this._fireAccum = 0;
    this._parcelAccum = 0;
    this._dropSeq = 0;
    this._elapsed = 0;
    this._lastFrameMs = performance.now();
    this._fps = 60;
    this._fpsSmooth = 60;
    this._cameraShake = 0;
    this._pendingScoreEvents = [];
    this._comboCount = 0;
    this._lastScoreSoundMs = 0;
    this._lastCabinAlertMs = 0;
    this._prevAnyCabinAtRisk = false;
    this._lastOverlayStatus = null;
    this._lastIntermissionSec = null;
    this._rafId = 0;
    this._disposed = false;

    // Core subsystems
    this.audio = new AudioEngine();
    this.hud = new HudController({
      onToggleAudio: () => this._handleToggleAudio(),
      onOpenDrawer: (force) => this._handleToggleDrawer(force),
      onSelectOperation: (opId) => this.switchOperation(opId),
      onSwitchMode: (mode, opts) => this.switchMode(mode, opts),
      onSettingChange: (key, value) => this._handleSettingChange(key, value),
      onNextOperation: () => this._handleNextOperation(),
      onReplay: () => this._handleReplay(),
      onResumeLive: () => {
        if (this._mpSession && typeof this._mpSession.resumeLive === 'function') {
          this._mpSession.resumeLive();
          this.hud.showOverlay(null);
        } else {
          this.switchMode('mp');
        }
      },
    });
    this.hud.setAudioMuted(this.audio.isMuted());

    this.input = new InputManager({
      canvas: this.canvas,
      invertPitch: this.settings.invertPitch,
      mouseYoke: this.settings.mouseYoke,
      onFirstGesture: () => this.audio.unlock(),
      onFlightKey: () => this._handleFlightKeyPressed(),
      onToggleMute: () => this._handleToggleAudio(),
      onToggleDrawer: () => this._handleToggleDrawer(),
      onEscape: () => {
        if (this.hud.isDrawerOpen()) {
          this._handleToggleDrawer(false);
        }
      },
    });

    this._onResize = () => {
      if (this.renderer) this.renderer.resize();
    };
    window.addEventListener('resize', this._onResize);

    // Expose read-only + QA debug hook
    this._exposeDebugHook();
  }

  _makeSoloNetState() {
    return {
      mode: 'solo',
      status: 'solo',
      pilotsCount: 1,
      pilotsCap: 1,
      localSlotId: 7,
      personalScore: 0,
      top10: [],
      queueBanner: null,
      idleCountdown: null,
      offlineFallback: false,
    };
  }

  async init() {
    if (this.query.loopbackTotal > 0) {
      await this.switchMode('loopback', { totalPlanes: this.query.loopbackTotal });
    } else if (this.query.modeParam === 'mp' || this.query.worldParam) {
      await this.switchMode('mp', { worldId: this.query.worldParam || undefined });
    } else {
      const initialOp = this.query.opParam ? getOperationById(this.query.opParam) : OPERATIONS[0];
      this._loadSoloOperation(initialOp || OPERATIONS[0]);
    }

    this._lastFrameMs = performance.now();
    this._loop = this._loop.bind(this);
    this._rafId = requestAnimationFrame(this._loop);
  }

  async _teardownNetwork() {
    this._mpClaimPending = false;
    this.remotePlanes = [];

    if (this._loopbackHandle) {
      try {
        await this._loopbackHandle.stop();
      } catch (err) {
        console.warn('[EmberFront] Loopback stop error:', err);
      }
      this._loopbackHandle = null;
      this._mpSession = null;
    } else if (this._mpSession) {
      try {
        await this._mpSession.stop();
      } catch (err) {
        console.warn('[EmberFront] WorldSession stop error:', err);
      }
      this._mpSession = null;
    }
  }

  _buildWorld(opConfig, isMegaBasin) {
    this.opConfig = opConfig;
    this.terrain = generateTerrain(opConfig);
    this.fireSim = new FireSim(this.terrain, { isMegaBasin });
    this.fireSim.reset(1);
    this.autopilot = new Autopilot(this.terrain);
    this.autopilot.reset();

    const snap = this.fireSim.getSnapshot();
    const callsign = isMegaBasin ? this.settings.callsign : 'EF-07';
    const slotId = isMegaBasin ? null : 7;
    this.aircraft = computeInitialSpawn(this.terrain, snap, slotId, this.settings.colorIdx, callsign);

    if (!this.renderer) {
      this.renderer = new SceneRenderer(this.canvas, this.terrain);
    } else {
      this.renderer.rebuildWorld(this.terrain);
    }

    // Initial full fire/terrain/cabin sync
    this._syncAllFireCells(snap);

    this._physAccum = 0;
    this._fireAccum = 0;
    this._parcelAccum = 0;
    this._cameraShake = 0;
    this._pendingScoreEvents = [];
    this._prevAnyCabinAtRisk = false;
    this._lastOverlayStatus = null;
    this.hud.showOverlay(null);
  }

  _syncAllFireCells(snap) {
    if (!this.renderer || !snap || !snap.cells) return;
    this.renderer.syncFireGrid(snap.cells, snap.phases, null, snap.cabinHp, snap.cabinAtRisk);
  }

  _loadSoloOperation(opConfig) {
    this.mode = 'solo';
    this.lastNetState = this._makeSoloNetState();
    this._buildWorld(opConfig, false);
  }

  async switchOperation(opId) {
    const seq = ++this._modeSwitchSeq;
    await this._teardownNetwork();
    if (seq !== this._modeSwitchSeq) return;
    const op = getOperationById(opId) || OPERATIONS[0];
    this._loadSoloOperation(op);
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }
  }

  async switchMode(targetMode, opts = {}) {
    const seq = ++this._modeSwitchSeq;
    await this._teardownNetwork();
    if (seq !== this._modeSwitchSeq) return;

    if (targetMode === 'solo') {
      const op = opts.opId ? getOperationById(opts.opId) : OPERATIONS[0];
      this._loadSoloOperation(op || OPERATIONS[0]);
      return;
    }

    if (targetMode === 'loopback') {
      this.mode = 'loopback';
      this._buildWorld(MEGA_BASIN_OP, true);
      const totalPlanes = Math.max(2, Math.min(100, opts.totalPlanes || 100));
      const botCount = Math.min(99, totalPlanes - 1);

      // Strictly lazy dynamic import — Solo never touches src/net/*
      const { createLoopbackSession } = await import('./net/LoopbackBots.js');
      if (seq !== this._modeSwitchSeq) return;

      const handle = createLoopbackSession({
        botCount,
        terrain: this.terrain,
        fireSim: this.fireSim,
        opConfig: MEGA_BASIN_OP,
        callsign: this.settings.callsign,
        colorIdx: this.settings.colorIdx,
        onStatusChange: (_status, netState) => {
          if (netState) this.lastNetState = { ...this.lastNetState, ...netState, mode: 'loopback' };
        },
        onScoreEvents: (events) => this._ingestScoreEvents(events),
        onFireSync: ({ full, dirtyIndices } = {}) => {
          if (!this.renderer || !this.fireSim) return;
          const s = this.fireSim.getSnapshot();
          if (full) {
            this._syncAllFireCells(s);
          } else {
            this.renderer.syncFireGrid(s.cells, s.phases, dirtyIndices, s.cabinHp, s.cabinAtRisk);
          }
        },
      });

      this._loopbackHandle = handle;
      this._mpSession = handle.session;
      await this._mpSession.start();
      if (seq !== this._modeSwitchSeq) {
        await handle.stop();
        return;
      }

      // Re-sync hydrated fire grid after session start
      this._syncAllFireCells(this.fireSim.getSnapshot());
      return;
    }

    if (targetMode === 'mp') {
      this.mode = 'mp';
      this._buildWorld(MEGA_BASIN_OP, true);
      this.lastNetState = {
        mode: 'mp',
        status: 'syncing',
        pilotsCount: 0,
        pilotsCap: 100,
        localSlotId: null,
        personalScore: 0,
        top10: [],
        queueBanner: null,
        idleCountdown: null,
        offlineFallback: false,
      };

      try {
        // Strictly lazy dynamic imports — zero Firebase bytes downloaded in Solo mode!
        const [
          { FIREBASE_CONFIG, DEFAULT_WORLD_ID },
          { parseNetQuery },
          { connectFirebase },
          { WorldSession },
        ] = await Promise.all([
          import('./net/firebaseConfig.js'),
          import('./net/config.js'),
          import('./net/FirebaseClient.js'),
          import('./net/WorldSession.js'),
        ]);
        if (seq !== this._modeSwitchSeq) return;

        const netCfg = parseNetQuery ? parseNetQuery(window.location.search) : {};
        const worldId = opts.worldId || netCfg.worldId || DEFAULT_WORLD_ID;

        if (!FIREBASE_CONFIG.apiKey && !netCfg.emu && !this.query.useEmulator) {
          throw new Error('Firebase API key not configured (set VITE_FIREBASE_API_KEY in .env.local or use ?emu)');
        }

        const adapter = await connectFirebase({
          search: window.location.search,
          emulatorPorts: netCfg.emulatorPorts || (this.query.useEmulator ? undefined : null),
          tab: Boolean(netCfg.tab || this.query.perTabAuth),
        });
        if (seq !== this._modeSwitchSeq) {
          await adapter.close().catch(() => {});
          return;
        }

        const session = new WorldSession({
          adapter,
          terrain: this.terrain,
          fireSim: this.fireSim,
          opConfig: MEGA_BASIN_OP,
          worldId,
          buildHash: getBuildHash(),
          callsign: this.settings.callsign,
          colorIdx: this.settings.colorIdx,
          mode: 'mp',
          onStatusChange: (_status, netState) => {
            if (netState) this.lastNetState = { ...this.lastNetState, ...netState, mode: 'mp' };
          },
          onScoreEvents: (events) => this._ingestScoreEvents(events),
          onImpactEvents: (impacts) => {
            if (!this.renderer || !impacts) return;
            for (let i = 0; i < impacts.length; i++) {
              const imp = impacts[i];
              this.renderer.spawnImpactSteam(imp.x, imp.y, imp.z, imp.extinguished);
            }
          },
          onFireSync: ({ full, dirtyIndices } = {}) => {
            if (!this.renderer || !this.fireSim) return;
            const s = this.fireSim.getSnapshot();
            if (full) {
              this._syncAllFireCells(s);
            } else {
              this.renderer.syncFireGrid(s.cells, s.phases, dirtyIndices, s.cabinHp, s.cabinAtRisk);
            }
          },
          onIdleOffline: () => {
            const msg = 'Disconnected after 5 minutes idle to save socket bandwidth.';
            this.hud.showOverlay('offline', { message: msg, reason: msg });
          },
        });

        this._mpSession = session;
        await session.start();
        if (seq !== this._modeSwitchSeq) {
          await session.stop();
          return;
        }
        this._syncAllFireCells(this.fireSim.getSnapshot());
      } catch (err) {
        console.warn('[EmberFront] Multiplayer connection unavailable; offering offline solo fallback:', err);
        if (seq !== this._modeSwitchSeq) return;
        this.lastNetState = {
          mode: 'mp',
          status: 'offline',
          pilotsCount: 1,
          pilotsCap: 100,
          localSlotId: null,
          personalScore: 0,
          top10: [],
          queueBanner: null,
          idleCountdown: null,
          offlineFallback: true,
        };
        const msg = err?.message || 'Unable to reach Shared Mega-Basin';
        this.hud.showOverlay('offline', { message: msg, reason: msg });
      }
    }
  }

  async takeControl() {
    this.audio.unlock();
    if (!this.aircraft) return;
    if (!this.aircraft.autopilot) return;

    if (this.mode === 'solo') {
      this.aircraft.autopilot = false;
      this.audio.playAlertPing(false);
      return;
    }

    if (this._mpSession && !this._mpClaimPending) {
      this._mpClaimPending = true;
      try {
        const res = await this._mpSession.requestManualControl();
        if (res && res.seated) {
          this.aircraft.autopilot = false;
          this.aircraft.slotId = res.slotId;
          const customCallsign = this.settings.callsign && this.settings.callsign !== 'EF-07';
          this.aircraft.callsign = customCallsign
            ? this.settings.callsign
            : `EF-${String(res.slotId).padStart(2, '0')}`;
          if (res.spawnPose) {
            this.aircraft.x = res.spawnPose.x ?? this.aircraft.x;
            this.aircraft.y = res.spawnPose.y ?? this.aircraft.y;
            this.aircraft.z = res.spawnPose.z ?? this.aircraft.z;
            if (typeof res.spawnPose.yawDeg === 'number') this.aircraft.yawDeg = res.spawnPose.yawDeg;
            if (typeof res.spawnPose.tankPct === 'number') this.aircraft.tankPct = res.spawnPose.tankPct;
            this.aircraft.pitchDeg = 0;
            this.aircraft.rollDeg = 0;
            this.aircraft.speedKmh = typeof res.spawnPose.speedKmh === 'number' ? res.spawnPose.speedKmh : 158;
            this.aircraft.scooping = false;
            this.aircraft.releasing = false;
            this.aircraft.dropBurstTimer = 0;
            this.aircraft.bounceTimer = 0;
            this.aircraft.stallWarn = false;
            this.aircraft.outOfBounds = false;
            const yawRad = (this.aircraft.yawDeg * Math.PI) / 180;
            const spdMs = this.aircraft.speedKmh / 3.6;
            this.aircraft.vx = Math.sin(yawRad) * spdMs;
            this.aircraft.vy = 0;
            this.aircraft.vz = -Math.cos(yawRad) * spdMs;
            if (this.terrain) {
              const ground = Math.max(this.terrain.waterLevel, this.terrain.getHeight(this.aircraft.x, this.aircraft.z));
              this.aircraft.agl = Math.max(0, this.aircraft.y - ground);
            }
          }
          this.audio.playAlertPing(false);
        }
      } catch (err) {
        console.warn('[EmberFront] Slot claim failed:', err);
      } finally {
        this._mpClaimPending = false;
      }
    }
  }

  async returnToDemo() {
    if (!this.aircraft) return;
    this.aircraft.autopilot = true;
    if (this.autopilot) this.autopilot.reset();
    if (this._mpSession) {
      try {
        await this._mpSession.returnToDemoFlight();
      } catch (err) {
        console.warn('[EmberFront] Return to demo flight error:', err);
      }
    }
  }

  _handleFlightKeyPressed() {
    if (this.aircraft && this.aircraft.autopilot) {
      this.takeControl();
    }
  }

  _handleToggleAudio() {
    this.audio.unlock();
    const muted = this.audio.toggleMute();
    this.hud.setAudioMuted(muted);
    if (!muted) {
      this.audio.playAlertPing(false);
    }
  }

  _handleToggleDrawer(force) {
    this.audio.unlock();
    this.hud.toggleDrawer(force);
    const open = this.hud.isDrawerOpen();
    this.input.setOptions({ drawerOpen: open });
  }

  _handleSettingChange(key, value) {
    if (key === 'callsign') {
      const clean = sanitizeCallsign(value);
      this.settings.callsign = clean;
      writeStorage(LS_KEYS.callsign, clean);
      if (this.aircraft && this.mode !== 'solo') {
        this.aircraft.callsign = clean;
      }
      if (this._mpSession) {
        this._mpSession.updateProfile(this.settings.callsign, this.settings.colorIdx);
      }
    } else if (key === 'colorIdx') {
      const idx = Math.max(0, Math.min(LIVERIES.length - 1, Number(value) || 0));
      this.settings.colorIdx = idx;
      writeStorage(LS_KEYS.colorIdx, idx);
      if (this.aircraft) this.aircraft.colorIdx = idx;
      if (this._mpSession) {
        this._mpSession.updateProfile(this.settings.callsign, this.settings.colorIdx);
      }
    } else if (key === 'invertPitch') {
      this.settings.invertPitch = Boolean(value);
      writeStorage(LS_KEYS.invertPitch, this.settings.invertPitch);
      this.input.setOptions({ invertPitch: this.settings.invertPitch });
    } else if (key === 'showDropReticle') {
      this.settings.showDropReticle = Boolean(value);
      writeStorage(LS_KEYS.showDropReticle, this.settings.showDropReticle);
    } else if (key === 'mouseYoke') {
      this.settings.mouseYoke = Boolean(value);
      writeStorage(LS_KEYS.mouseYoke, this.settings.mouseYoke);
      this.input.setOptions({ mouseYoke: this.settings.mouseYoke });
    }
  }

  _handleNextOperation() {
    const idx = OPERATIONS.findIndex((o) => o.id === this.opConfig.id);
    const next = idx >= 0 && idx + 1 < OPERATIONS.length ? OPERATIONS[idx + 1] : OPERATIONS[0];
    this.switchOperation(next.id);
  }

  _handleReplay() {
    if (this.mode === 'solo') {
      this._loadSoloOperation(this.opConfig);
    } else {
      this.hud.showOverlay(null);
    }
  }

  _ingestScoreEvents(events) {
    if (!events || events.length === 0) return;
    const now = performance.now();
    const localSlot = this.mode === 'solo'
      ? (this.aircraft ? this.aircraft.slotId : 7)
      : this.lastNetState.localSlotId;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      this._pendingScoreEvents.push(ev);

      // Play score chimes for local pilot (or solo demo flight)
      const isLocal = this.mode === 'solo' || ev.slotId === localSlot;
      if (!isLocal) continue;

      if (ev.kind === 'cabin') {
        this.audio.playCabinSavedChord();
      } else {
        if (now - this._lastScoreSoundMs > 1500) {
          this._comboCount = 0;
        }
        this.audio.playScoreChime(this._comboCount);
        this._comboCount = Math.min(8, this._comboCount + 1);
        this._lastScoreSoundMs = now;
      }
    }
  }

  _stepPhysics(dt) {
    const snap = this.fireSim.getSnapshot();
    let input;

    if (this.aircraft.autopilot) {
      // Sample input anyway to keep gamepad / transient states fresh
      this.input.sample(dt);
      const apSnap = {
        fireHead: snap.fireHead,
        atRiskCabin: snap.atRiskTarget,
        windVx: snap.windVx,
        windVz: snap.windVz,
      };
      input = this.autopilot.update(this.aircraft, apSnap, dt);
    } else {
      input = this.input.sample(dt);
    }

    const isReplica = this._mpSession && !this._isHosting;
    const result = stepFlight(this.aircraft, input, this.terrain, dt, {
      externalTankSync: Boolean(isReplica),
    });
    const events = (result && result.events) || {};

    if (events.dropStarted) {
      this._dropSeq = (this._dropSeq + 1) & 0xffff;
      this._parcelAccum = WATER_PARCEL_INTERVAL; // spawn immediately on burst start
    }
    if (events.tankFull) {
      this.audio.playTankFullPing();
    }
    if (events.bounced) {
      this._cameraShake = Math.max(this._cameraShake, 0.85);
    }
    if (this.aircraft.releasing) {
      this._cameraShake = Math.max(this._cameraShake, 0.16);
      this._parcelAccum += dt;
      while (this._parcelAccum >= WATER_PARCEL_INTERVAL) {
        this._parcelAccum -= WATER_PARCEL_INTERVAL;
        // Spawn visual water curtain inside 640x360 WebGL pass
        this.renderer.spawnDropVisual(
          this.aircraft.x,
          this.aircraft.y - 1.4,
          this.aircraft.z,
          this.aircraft.vx,
          this.aircraft.vy,
          this.aircraft.vz,
          snap.windVx,
          snap.windVz
        );
        // Spawn physics water parcel locally ONLY in Solo (in MP/Loopback, HostBroadcaster owns FireSim parcels)
        if (this.mode === 'solo') {
          const slotId = this.aircraft.slotId != null ? this.aircraft.slotId : 0;
          this.fireSim.spawnWaterParcel(
            slotId,
            this.aircraft.x,
            this.aircraft.y - 1.4,
            this.aircraft.z,
            this.aircraft.vx,
            this.aircraft.vy,
            this.aircraft.vz,
            this.aircraft.agl
          );
        }
      }
    } else {
      this._parcelAccum = 0;
    }

    if (this.aircraft.scooping) {
      this._cameraShake = Math.max(this._cameraShake, 0.12);
    }

    return events;
  }

  _stepSoloFire() {
    const delta = this.fireSim.step(FIRE_DT, 1);
    const snap = this.fireSim.getSnapshot();

    if (delta.fullReset) {
      this._syncAllFireCells(snap);
    } else if (delta.changedCells && delta.changedCells.length > 0) {
      const dirty = delta.changedCells.map((c) => c.idx);
      this.renderer.syncFireGrid(snap.cells, snap.phases, dirty, snap.cabinHp, snap.cabinAtRisk);
    } else if (delta.cabinChanges && delta.cabinChanges.length > 0) {
      this.renderer.syncFireGrid(snap.cells, snap.phases, [], snap.cabinHp, snap.cabinAtRisk);
    }

    if (delta.impactEvents && delta.impactEvents.length > 0) {
      for (let i = 0; i < delta.impactEvents.length; i++) {
        const imp = delta.impactEvents[i];
        this.renderer.spawnImpactSteam(imp.x, imp.y, imp.z, imp.extinguished);
      }
    }

    if (delta.scoreEvents && delta.scoreEvents.length > 0) {
      this._ingestScoreEvents(delta.scoreEvents);
    }

    // Update Solo score in netState
    this.lastNetState.personalScore = snap.missionScore;
  }

  _computeNearestFireDist(snap) {
    if (!snap || !snap.hotClusters || snap.hotClusters.length === 0) return 9999;
    let best = 9999;
    for (let i = 0; i < snap.hotClusters.length; i++) {
      const c = snap.hotClusters[i];
      const d = Math.hypot(c.x - this.aircraft.x, c.z - this.aircraft.z);
      if (d < best) best = d;
    }
    return best;
  }

  _updateOverlays(snap) {
    if (!snap) return;
    if (this.mode === 'solo') {
      if ((snap.status === 'victory' || snap.status === 'defeat') && this._lastOverlayStatus !== snap.status) {
        this._lastOverlayStatus = snap.status;
        const idx = OPERATIONS.findIndex((o) => o.id === this.opConfig.id);
        this.hud.showOverlay(snap.status, {
          opConfig: this.opConfig,
          opName: this.opConfig.name,
          missionScore: snap.missionScore,
          cabinsAlive: snap.cabinsAlive,
          cabinsTotal: snap.cabinsTotal,
          burningPct: snap.burningPct,
          stars: computeStarRating(snap.cabinsAlive, snap.cabinsTotal),
          hasNext: idx >= 0 && idx + 1 < OPERATIONS.length,
        });
      }
    } else {
      if (snap.status === 'intermission') {
        const sec = Math.max(0, Math.ceil(snap.intermissionTimer || 0));
        if (this._lastOverlayStatus !== 'intermission' || this._lastIntermissionSec !== sec) {
          this._lastOverlayStatus = 'intermission';
          this._lastIntermissionSec = sec;
          this.hud.showOverlay('intermission', {
            contained: (snap.cabinsAlive || 0) > 0,
            wave: snap.wave,
            intermissionTimer: snap.intermissionTimer,
            missionScore: snap.missionScore,
            cabinsAlive: snap.cabinsAlive,
            cabinsTotal: snap.cabinsTotal,
            localSlotId: this.lastNetState.localSlotId,
            top10: this.lastNetState.top10 || [],
          });
        }
      } else if (this._lastOverlayStatus === 'intermission' && snap.status === 'active') {
        this._lastOverlayStatus = null;
        this._lastIntermissionSec = null;
        this.hud.showOverlay(null);
      }
    }
  }

  _loop(nowMs) {
    if (this._disposed) return;
    this._rafId = requestAnimationFrame(this._loop);

    const rawDt = (nowMs - this._lastFrameMs) / 1000;
    this._lastFrameMs = nowMs;
    const dt = Math.max(0.001, Math.min(0.1, rawDt));
    this._elapsed += dt;

    if (rawDt > 0.0005) {
      const instFps = 1 / rawDt;
      this._fpsSmooth = this._fpsSmooth * 0.9 + instFps * 0.1;
      this._fps = Math.round(this._fpsSmooth);
    }

    if (!this.terrain || !this.fireSim || !this.aircraft || !this.renderer) return;

    // Keep InputManager drawer state in sync even if closed via backdrop or × button
    this.input.setOptions({ drawerOpen: this.hud.isDrawerOpen() });

    // 1. Fixed 60 Hz flight physics accumulator
    this._physAccum += dt;
    let bouncedThisFrame = false;
    let steps = 0;
    while (this._physAccum >= FIXED_DT && steps < 6) {
      this._physAccum -= FIXED_DT;
      const ev = this._stepPhysics(FIXED_DT);
      if (ev.bounced) bouncedThisFrame = true;
      steps++;
    }

    // 2. FireSim (Solo at 10 Hz) OR Network Session step (MP / Loopback)
    if (this.mode === 'solo') {
      this._fireAccum += dt;
      while (this._fireAccum >= FIRE_DT) {
        this._fireAccum -= FIRE_DT;
        this._stepSoloFire();
      }
      this._isHosting = false;
      this.remotePlanes = [];
    } else if (this._mpSession) {
      if (!this.aircraft.autopilot && this.aircraft.slotId != null) {
        this._mpSession.sendLocalState(this.aircraft, this._dropSeq);
      }
      const mpStep = this._mpSession.step(dt, nowMs);
      if (mpStep) {
        this._isHosting = Boolean(mpStep.isHost);
        this.remotePlanes = mpStep.remotePlanes || [];
        if (typeof mpStep.localAuthTank === 'number' && !this._isHosting && !this.aircraft.autopilot) {
          // Smoothly reconcile authoritative tank from Host
          this.aircraft.tankPct += (mpStep.localAuthTank - this.aircraft.tankPct) * Math.min(1, dt * 8);
        }
        if (mpStep.netState) {
          this.lastNetState = { ...this.lastNetState, ...mpStep.netState, mode: this.mode };
          // If server reclaimed our idle slot, return gracefully to DEMO FLIGHT
          if (mpStep.netState.localSlotId == null && !this.aircraft.autopilot && !this._mpClaimPending) {
            this.aircraft.autopilot = true;
            this.autopilot.reset();
          }
        }
        // Fire/cabin visual updates in MP/Loopback are driven by onFireSync callbacks.
      }
    }

    const fireSnapshot = this.fireSim.getSnapshot();

    // 3. Cabin at risk alert edge
    const anyAtRisk = Boolean(fireSnapshot.atRiskTarget);
    if (anyAtRisk && !this._prevAnyCabinAtRisk && nowMs - this._lastCabinAlertMs > 12000) {
      this._lastCabinAlertMs = nowMs;
      this.audio.playAlertPing(true);
    }
    this._prevAnyCabinAtRisk = anyAtRisk;

    // 4. Nearest fire distance + camera shake decay + AudioEngine update
    const nearestFireDist = this._computeNearestFireDist(fireSnapshot);
    if (nearestFireDist < 70 && this.aircraft.agl < 65) {
      this._cameraShake = Math.max(this._cameraShake, 0.1 * (1 - nearestFireDist / 70));
    }

    this.audio.update({
      dt,
      airspeedKmh: this.aircraft.speedKmh,
      throttle: this.aircraft.throttle,
      windSpeedKt: fireSnapshot.windSpeedKt,
      scooping: this.aircraft.scooping,
      releasing: this.aircraft.releasing,
      nearestFireDist,
      bounced: bouncedThisFrame,
    });

    // 5. Render 640x360 retro WebGL scene
    const showDropReticle = !this.aircraft.autopilot && this.settings.showDropReticle;
    const dropPreview = showDropReticle
      ? predictDropImpact(this.aircraft, fireSnapshot.windVx, fireSnapshot.windVz, this.terrain)
      : null;

    this.renderer.update({
      dt,
      elapsed: this._elapsed,
      localAircraft: this.aircraft,
      remotePlanes: this.remotePlanes,
      fireSnapshot,
      showDropReticle,
      dropPreview,
      cameraShake: this._cameraShake,
    });
    this._cameraShake = Math.max(0, this._cameraShake - dt * 2.4);

    // 6. Update crisp native-res Tactical HUD
    const scoreBatch = this._pendingScoreEvents.length > 0 ? this._pendingScoreEvents : [];
    this._pendingScoreEvents = [];

    this.hud.update({
      aircraft: this.aircraft,
      fireSnapshot,
      opConfig: this.opConfig,
      netState: this.lastNetState,
      scoreEvents: scoreBatch,
      terrain: this.terrain,
      projectFn: (pos) => this.renderer.projectToScreen(pos),
      remotePlanes: this.remotePlanes,
      settings: this.settings,
    });

    this._updateOverlays(fireSnapshot);
  }

  _exposeDebugHook() {
    const app = this;
    const api = {
      getState() {
        const stats = app.renderer ? app.renderer.getStats() : null;
        const snap = app.fireSim ? app.fireSim.getSnapshot() : null;
        const ac = app.aircraft;
        return {
          fps: app._fps,
          drawCalls: stats ? stats.drawCalls : 0,
          triangles: stats ? stats.triangles : 0,
          renderWidth: stats ? stats.renderWidth : 0,
          renderHeight: stats ? stats.renderHeight : 0,
          remoteCount: stats ? stats.remoteCount : app.remotePlanes.length,
          mode: app.mode,
          opId: app.opConfig ? app.opConfig.id : null,
          opName: app.opConfig ? app.opConfig.name : null,
          drawerOpen: app.hud ? app.hud.isDrawerOpen() : false,
          audioMuted: app.audio ? app.audio.isMuted() : true,
          aircraft: ac
            ? {
                x: Number(ac.x.toFixed(2)),
                y: Number(ac.y.toFixed(2)),
                z: Number(ac.z.toFixed(2)),
                yawDeg: Number(ac.yawDeg.toFixed(2)),
                pitchDeg: Number(ac.pitchDeg.toFixed(2)),
                rollDeg: Number(ac.rollDeg.toFixed(2)),
                speedKmh: Number(ac.speedKmh.toFixed(1)),
                agl: Number(ac.agl.toFixed(1)),
                tankPct: Number(ac.tankPct.toFixed(1)),
                scooping: Boolean(ac.scooping),
                releasing: Boolean(ac.releasing),
                autopilot: Boolean(ac.autopilot),
                callsign: ac.callsign,
                slotId: ac.slotId,
                colorIdx: ac.colorIdx,
              }
            : null,
          fireSummary: snap
            ? {
                burningPct: Number((snap.burningPct || 0).toFixed(2)),
                burningCount: snap.burningCount || 0,
                cabinsAlive: snap.cabinsAlive || 0,
                cabinsTotal: snap.cabinsTotal || 0,
                missionScore: snap.missionScore || 0,
                status: snap.status,
                wave: snap.wave,
                windDirDeg: Math.round(snap.windDirDeg || 0),
                windSpeedKt: Math.round(snap.windSpeedKt || 0),
              }
            : null,
          netState: { ...app.lastNetState },
        };
      },
      getStats() {
        return {
          fps: app._fps,
          ...(app.renderer ? app.renderer.getStats() : {}),
        };
      },
      takeControl() {
        return app.takeControl();
      },
      returnToDemo() {
        return app.returnToDemo();
      },
      switchOperation(id) {
        return app.switchOperation(id);
      },
      switchMode(mode, opts) {
        return app.switchMode(mode, opts);
      },
      toggleDrawer(force) {
        app._handleToggleDrawer(force);
      },
      triggerDrop(durationMs = 900) {
        if (app.aircraft && app.aircraft.autopilot) {
          app.aircraft.autopilot = false;
        }
        if (app.aircraft && app.aircraft.tankPct < 30) {
          app.aircraft.tankPct = 100;
        }
        app.input.triggerDropPulse(durationMs);
      },
      setCameraYaw(deg, pitchDeg = 10) {
        if (!app.aircraft || !app.terrain) return;
        app.aircraft.autopilot = false;
        app.aircraft.yawDeg = ((deg % 360) + 360) % 360;
        app.aircraft.pitchDeg = pitchDeg;
        app.aircraft.rollDeg = 0;
        // Position high enough so the twilight sky band and horizon are unobstructed
        const ground = Math.max(app.terrain.waterLevel, app.terrain.getHeight(app.aircraft.x, app.aircraft.z));
        if (app.aircraft.y < ground + 95) {
          app.aircraft.y = ground + 95;
          app.aircraft.agl = 95;
        }
        // Force immediate camera sync on next frames
        if (app.renderer && app.fireSim) {
          const snap = app.fireSim.getSnapshot();
          for (let i = 0; i < 8; i++) {
            app.renderer.update({
              dt: 0.05,
              elapsed: app._elapsed,
              localAircraft: app.aircraft,
              remotePlanes: app.remotePlanes,
              fireSnapshot: snap,
              showDropReticle: false,
              dropPreview: null,
              cameraShake: 0,
            });
          }
        }
      },
    };
    Object.defineProperty(window, '__EMBER_FRONT__', {
      value: Object.freeze(api),
      writable: false,
      configurable: true,
    });
  }

  dispose() {
    this._disposed = true;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    this._teardownNetwork();
    this.input.dispose();
    this.hud.dispose();
    this.audio.dispose();
    if (this.renderer) this.renderer.dispose();
  }
}

const app = new EmberFrontApp();
app.init().catch((err) => {
  console.error('[EmberFront] Fatal startup error:', err);
});
