/**
 * EMBER FRONT — Main Application Wiring
 *
 * Supports clean Solo (`FLY SOLO`), Host Lobby (`HOST LOBBY`), and Join Live Lobby
 * (`JOIN LOBBY` / `/?lobby=megabasin-XX`) over a live scenic `DEMO FLIGHT` launch screen,
 * with automatic Solo fallback when a lobby is full (100/100) or unreachable.
 *
 * Full realism integration: altitude drop envelope (`optimal`/`too_high`/`too_low`),
 * convective smoke turbulence & thermal updrafts, heavy-tank inertia & drop buoyancy surge,
 * optimal vs rough lake scooping, tree damage & ground crash/respawn, 69 VHF radio clips,
 * Lyria ambient soundtrack, minimal corner HUD, and portrait/landscape mobile touch UI.
 *
 * Test query params preserved: ?loopback=100 / ?bots=N, ?lobby=megabasin-XX, ?world=megabasin-20,
 * ?tab=1, ?emu, ?touch=1, ?simFull=1, ?simOffline=1, ?op=op01..op05.
 */

import './styles/touch.css';

import {
  OPERATIONS,
  MEGA_BASIN_OP,
  DEFAULT_OPERATION,
  getOperationById,
  getOperationByIndex,
} from './config/operations.js';
import { LIVERIES } from './config/liveries.js';
import { generateTerrain } from './sim/TerrainGen.js';
import { createAircraftState, stepFlight, predictDropImpact, FLIGHT_CONSTANTS } from './sim/FlightModel.js';
import { Autopilot } from './sim/Autopilot.js';
import { FireSim } from './sim/FireSim.js';
import { SceneRenderer } from './render/SceneRenderer.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { RadioManager } from './audio/RadioManager.js';
import { HudController } from './ui/HudController.js';
import { TouchControls } from './ui/TouchControls.js';
import { InputManager } from './input/InputManager.js';

const FIXED_DT = 1 / 60;
const FIRE_DT = 0.1; // 10 Hz cellular wildfire tick
const WATER_PARCEL_INTERVAL = 0.1; // 100 ms ballistic water parcel cadence

const ZERO_ATMOSPHERE = Object.freeze({
  smokeDensity: 0,
  thermalLift: 0,
  turbulence: 0,
  heatDanger: 0,
});

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
  const lobbyParam = params.get('lobby') || '';
  const worldParam = params.get('world') || '';
  const opParam = params.get('op') || '';
  const modeParam = (params.get('mode') || '').toLowerCase();
  const loopbackRaw = params.get('loopback') ?? params.get('bots');
  let loopbackTotal = 0;
  if (loopbackRaw !== null) {
    const n = parseInt(loopbackRaw, 10);
    loopbackTotal = Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(2, n)) : 100;
  }
  return {
    lobbyParam,
    worldParam,
    opParam,
    modeParam,
    loopbackTotal,
    useEmulator: params.has('emu'),
    perTabAuth: params.has('tab'),
    forceTouch: params.get('touch') === '1' || params.get('touch') === 'true',
    simFull: params.get('simFull') === '1' || params.get('simFull') === 'true',
    simOffline: params.get('simOffline') === '1' || params.get('simOffline') === 'true',
  };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildInviteUrlLocal(worldId) {
  if (!worldId) return '';
  try {
    const base = `${window.location.origin}${window.location.pathname || '/'}`;
    return `${base}?lobby=${encodeURIComponent(worldId)}`;
  } catch {
    return `?lobby=${encodeURIComponent(worldId)}`;
  }
}

function computeInitialSpawn(terrain, fireSnapshot, slotId = null, colorIdx = 0, callsign = 'EF-07', autopilot = true) {
  const scoop = terrain.scoopZones && terrain.scoopZones[0];
  const target = (fireSnapshot && (fireSnapshot.atRiskTarget || fireSnapshot.fireHead)) || { x: 200, z: 0 };

  let spawnX = scoop ? scoop.x - 55 : -280;
  let spawnZ = scoop ? scoop.z + 200 : 220;

  const dx = target.x - spawnX;
  const dz = target.z - spawnZ;
  const dist = Math.hypot(dx, dz);
  if (dist < 220) {
    spawnX = target.x - 320;
    spawnZ = target.z + 240;
  }

  const maxCoord = terrain.halfWorld * 0.72;
  spawnX = Math.max(-maxCoord, Math.min(maxCoord, spawnX));
  spawnZ = Math.max(-maxCoord, Math.min(maxCoord, spawnZ));

  const groundY = Math.max(terrain.waterLevel, terrain.getHeight(spawnX, spawnZ));
  const yawRad = Math.atan2(target.x - spawnX, -(target.z - spawnZ));
  const yawDeg = ((yawRad * 180) / Math.PI + 360) % 360;

  return createAircraftState({
    x: spawnX,
    y: groundY + 46,
    z: spawnZ,
    yawDeg,
    pitchDeg: 0,
    rollDeg: 0,
    speedKmh: 158,
    throttle: 0.47,
    tankPct: 100,
    hp: 100,
    maxHp: 100,
    autopilot,
    callsign,
    slotId,
    colorIdx,
  });
}

function getAppVersion() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0) {
      // eslint-disable-next-line no-undef
      return __APP_VERSION__;
    }
  } catch {
    // ignore
  }
  return 'dev';
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

    // Core Audio + VHF Radio subsystems (initialized early so settings mirror live prefs)
    this.audio = new AudioEngine();
    this.radio = new RadioManager(this.audio);

    this.settings = {
      callsign: sanitizeCallsign(readStorage(LS_KEYS.callsign, 'EF-07')),
      colorIdx: Math.max(0, Math.min(LIVERIES.length - 1, parseInt(readStorage(LS_KEYS.colorIdx, '0'), 10) || 0)),
      invertPitch: readStorage(LS_KEYS.invertPitch, 'false') === 'true',
      showDropReticle: readStorage(LS_KEYS.showDropReticle, 'true') !== 'false',
      mouseYoke: readStorage(LS_KEYS.mouseYoke, 'false') === 'true',
      audioMuted: this.audio.isMuted(),
      musicEnabled: this.audio.isMusicEnabled(),
      musicVolume: this.audio.getMusicVolume(),
      radioEnabled: this.radio.isEnabled(),
      radioVolume: this.radio.getVolume(),
      sfxEnabled: this.audio.isSfxEnabled(),
      sfxVolume: this.audio.getSfxVolume(),
    };

    // Runtime state: 'solo' | 'mp' | 'loopback'
    this.mode = 'solo';
    this.opConfig = DEFAULT_OPERATION || OPERATIONS[0];
    this.opIndex = this.opConfig.opIndex ?? 0;
    this.terrain = null;
    this.fireSim = null;
    this.autopilot = null;
    this.aircraft = null;
    this.renderer = null;
    this.remotePlanes = [];
    this.lastNetState = this._makeSoloNetState();

    // Active multiplayer / loopback / lobby-directory handles (lazily loaded)
    this._mpSession = null;
    this._mpAdapter = null;
    this._dirAdapter = null;
    this._dirConnectPromise = null;
    this._lobbyRefreshInFlight = null;
    this._lobbyAutoRefreshTimer = null;
    this._loopbackHandle = null;
    this._mpClaimPending = false;
    this._modeSwitchSeq = 0;
    this._lobbyListSeq = 0;
    this._isHosting = false;
    this._hasHydratedRemoteFire = false;
    this._lastJoinedWorldId = null;

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
    this._recentOutcomeKeys = new Map();
    this._comboCount = 0;
    this._lastScoreSoundMs = 0;
    this._lastCabinAlertMs = 0;
    this._prevAnyCabinAtRisk = false;
    this._lastOverlayStatus = null;
    this._lastIntermissionSec = null;
    this._atmosphereStarted = false;
    this._lastDropPreview = null;
    this._lastAtmosphere = { ...ZERO_ATMOSPHERE };
    this._rafId = 0;
    this._disposed = false;

    // HUD Orchestrator (with Solo / Host Lobby / Join Lobby callbacks + release version)
    this.hud = new HudController({
      appVersion: getAppVersion(),
      buildHash: getBuildHash(),
      onToggleAudio: () => this._handleToggleAudio(),
      onOpenDrawer: (force) => this._handleToggleDrawer(force),
      onSettingChange: (key, value) => this._handleSettingChange(key, value),
      onNextOperation: () => this._handleManualAdvanceRequest(),
      onReplay: () => this.hud.showOverlay(null),
      onResumeLive: () => this.retryLive(),
      onLaunchSolo: () => this.launchSolo(),
      onHostLobby: () => this.hostLobby(),
      onJoinLobby: (worldId) => this.joinLobby(worldId, { autoSeat: true }),
      onRefreshLobbies: () => this.refreshLobbies(),
      onCopyInviteLink: (url) => this._copyInviteLink(url),
    });
    this.hud.setAudioMuted(this.audio.isMuted());

    // Wire VHF Radio Manager transcripts directly into auto-hiding HUD comms strip
    this._offRadioTx = this.radio.onTransmission((tx) => {
      this.hud.pushRadioTranscript(tx);
    });

    // Input Manager (keyboard + gamepad + optional mouse-yoke + multi-touch bridge)
    this.input = new InputManager({
      canvas: this.canvas,
      invertPitch: this.settings.invertPitch,
      mouseYoke: this.settings.mouseYoke,
      onFirstGesture: () => this._unlockAndStartAtmosphere(),
      onFlightKey: () => this._handleFlightKeyPressed(),
      onToggleMute: () => this._handleToggleAudio(),
      onToggleDrawer: () => this._handleToggleDrawer(),
      onEscape: () => {
        if (this.hud.isDrawerOpen()) {
          this._handleToggleDrawer(false);
        }
      },
    });

    // Mobile Multi-Touch Controls (mounted AFTER HudController so #hud-root isn't cleared)
    const hudRoot = document.getElementById('hud-root') || document.body;
    this.touchControls = new TouchControls(hudRoot, this.input, {
      onInteract: () => this._unlockAndStartAtmosphere(),
    });
    if (this.query.forceTouch && typeof this.touchControls.setForcedVisible === 'function') {
      this.touchControls.setForcedVisible(true);
    }

    this._onResize = () => {
      if (this.renderer) this.renderer.resize();
    };
    window.addEventListener('resize', this._onResize);

    this._onVisibilityChange = () => {
      if (this._disposed || document.hidden) return;
      if (this.hud && this.hud.isLaunchOverlayOpen()) {
        this.refreshLobbies({ silent: true });
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    // Expose read-only + QA debug hook
    this._exposeDebugHook();
  }

  _makeSoloNetState({ connStatus = 'solo', offlineReason = null, offlineFallback = false } = {}) {
    return {
      mode: 'solo',
      status: offlineFallback ? 'offline' : 'solo',
      connStatus,
      isHost: false,
      worldId: null,
      inviteUrl: '',
      offlineReason,
      opIndex: this.opIndex,
      pilotsCount: 1,
      pilotsCap: offlineFallback ? 100 : 1,
      localSlotId: 0,
      personalScore: this.fireSim ? this.fireSim.missionScore : 0,
      top10: [],
      queueBanner: null,
      idleCountdown: null,
      offlineFallback,
    };
  }

  _makeInitialMpNetState(mode = 'mp', worldId = null) {
    return {
      mode,
      status: mode === 'loopback' ? 'live' : 'syncing',
      connStatus: mode === 'loopback' ? 'online' : 'connecting',
      isHost: false,
      worldId,
      inviteUrl: worldId ? buildInviteUrlLocal(worldId) : '',
      offlineReason: null,
      opIndex: this.opIndex,
      pilotsCount: 0,
      pilotsCap: 100,
      localSlotId: null,
      personalScore: 0,
      top10: [],
      queueBanner: null,
      idleCountdown: null,
      offlineFallback: false,
    };
  }

  _applyNetState(partial, mode = this.mode) {
    const merged = { ...this.lastNetState, ...partial, mode };
    if (merged.worldId && !merged.inviteUrl) {
      merged.inviteUrl = buildInviteUrlLocal(merged.worldId);
    }
    this.lastNetState = merged;
  }

  _copyInviteLink(explicitUrl) {
    const url = explicitUrl || this.lastNetState?.inviteUrl || buildInviteUrlLocal(this.lastNetState?.worldId);
    if (!url) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(url).catch(() => {});
        return true;
      }
    } catch {
      // ignore clipboard errors
    }
    return false;
  }

  _unlockAndStartAtmosphere() {
    this.audio.unlock();
    if (this._atmosphereStarted) return;
    this._atmosphereStarted = true;

    if (this.audio.isMusicEnabled()) {
      this.audio.startMusic();
    }
    this.radio.preloadCoreClips();
    this.radio.startAmbientChatter();

    setTimeout(() => {
      if (!this._disposed) {
        this.radio.trigger('mission_start');
      }
    }, 350);
  }

  async init() {
    const requestedOp = this.query.opParam ? getOperationById(this.query.opParam) : null;
    const initialOp = requestedOp || DEFAULT_OPERATION || OPERATIONS[0];

    // Always build the scenic Operation 01 world immediately so frame 1 is live 3D DEMO FLIGHT!
    this._buildWorld(initialOp, { preservePilot: false });

    // Start animation loop right away so launch overlay floats over live 60 FPS alpine flight
    this._lastFrameMs = performance.now();
    this._loop = this._loop.bind(this);
    this._rafId = requestAnimationFrame(this._loop);

    if (this.query.loopbackTotal > 0) {
      await this.switchMode('loopback', {
        totalPlanes: this.query.loopbackTotal,
        opConfig: requestedOp || MEGA_BASIN_OP,
      });
      return;
    }

    if (this.query.simFull) {
      this._enterOfflineLocalMission('offline_full', 'Airspace full (100/100)');
      return;
    }

    if (this.query.simOffline) {
      this._enterOfflineLocalMission('offline_error', 'Live airspace unavailable');
      return;
    }

    if (this.query.lobbyParam || this.query.worldParam || this.query.modeParam === 'mp') {
      const targetWorld = this.query.lobbyParam || this.query.worldParam || undefined;
      await this.joinLobby(targetWorld, { autoSeat: false, opConfig: initialOp });
      return;
    }

    if (this.query.modeParam === 'solo') {
      await this.launchSolo({ autoControl: false });
      return;
    }

    // Default clean launch choice over live scenic DEMO FLIGHT:
    // FLY SOLO | HOST LOBBY | Auto-Refreshing Live Hosted Lobbies (5 s)
    this.mode = 'solo';
    this.lastNetState = this._makeSoloNetState({ connStatus: 'solo' });
    this.hud.showLaunchOverlay(true, {
      lobbies: [],
      loading: true,
      canDismiss: false,
      autoRefreshSec: 5,
      statusText: 'Select Solo, Host Lobby, or Join a live squadron',
    });
    this.refreshLobbies();
    this._startLobbyAutoRefresh();
  }

  _startLobbyAutoRefresh() {
    this._stopLobbyAutoRefresh();
    this._lobbyAutoRefreshTimer = setInterval(() => {
      if (this._disposed) {
        this._stopLobbyAutoRefresh();
        return;
      }
      if (!this.hud || !this.hud.isLaunchOverlayOpen()) {
        this._stopLobbyAutoRefresh();
        // If user dismissed launch overlay back into Solo, release directory socket cleanly.
        if (this.mode === 'solo' && !this._mpAdapter) {
          this._closeDirectoryAdapter().catch(() => {});
        }
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      this.refreshLobbies({ silent: true });
    }, 5000);
  }

  _stopLobbyAutoRefresh() {
    if (this._lobbyAutoRefreshTimer) {
      clearInterval(this._lobbyAutoRefreshTimer);
      this._lobbyAutoRefreshTimer = null;
    }
  }

  async _closeDirectoryAdapter() {
    const dir = this._dirAdapter;
    this._dirAdapter = null;
    if (dir) {
      try { dir.goOffline(); } catch { /* ignore */ }
      await dir.close().catch(() => {});
    }
  }

  /**
   * Lazily connect or reuse a single shared directory RTDB adapter.
   * Deduplicates concurrent connectFirebase() calls so rapid ↻ REFRESH clicks
   * and 5 s auto-refreshes never call goOffline() on the shared ember-front-net Database singleton.
   */
  async _ensureDirectoryAdapter() {
    if (this._mpAdapter && !this._mpAdapter._closed) return this._mpAdapter;
    if (this._dirAdapter && !this._dirAdapter._closed) return this._dirAdapter;
    if (!this._dirConnectPromise) {
      const startModeSeq = this._modeSwitchSeq;
      this._dirConnectPromise = (async () => {
        const [
          { FIREBASE_CONFIG },
          { parseNetQuery },
          { connectFirebase },
        ] = await Promise.all([
          import('./net/firebaseConfig.js'),
          import('./net/config.js'),
          import('./net/FirebaseClient.js'),
        ]);
        const netCfg = parseNetQuery ? parseNetQuery(window.location.search) : {};
        if (!FIREBASE_CONFIG.apiKey && !netCfg.emu && !this.query.useEmulator) {
          return null;
        }
        const adapter = await withTimeout(
          connectFirebase({
            search: window.location.search,
            emulatorPorts: netCfg.emulatorPorts || (this.query.useEmulator ? undefined : null),
            tab: Boolean(netCfg.tab || this.query.perTabAuth),
            appName: 'ember-front-net',
          }),
          5500,
          'Lobby lookup timed out'
        );
        if (this._disposed || (this.mode === 'solo' && this._modeSwitchSeq !== startModeSeq && !this.hud.isLaunchOverlayOpen())) {
          if (!this._mpAdapter) {
            try { adapter.goOffline(); } catch { /* ignore */ }
            await adapter.close().catch(() => {});
          }
          return null;
        }
        if (!this._mpAdapter) {
          this._dirAdapter = adapter;
        }
        return this._mpAdapter || this._dirAdapter;
      })().finally(() => {
        this._dirConnectPromise = null;
      });
    }
    return this._dirConnectPromise;
  }

  /** Fetch live hosted lobbies from bounded RTDB `worldsIndex` without claiming a slot (deduplicated). */
  async refreshLobbies({ silent = false } = {}) {
    if (this._lobbyRefreshInFlight) {
      return this._lobbyRefreshInFlight;
    }
    const reqSeq = ++this._lobbyListSeq;
    if (this.hud.isLaunchOverlayOpen()) {
      this.hud.setLobbies(silent ? undefined : [], {
        loading: true,
        error: null,
        autoRefreshSec: 5,
      });
    }

    const run = (async () => {
      try {
        const [{ listLiveLobbies }, adapter] = await Promise.all([
          import('./net/LobbyDirectory.js'),
          this._ensureDirectoryAdapter(),
        ]);
        if (reqSeq !== this._lobbyListSeq || this._disposed) return [];
        if (!adapter || adapter._closed) {
          if (this.hud.isLaunchOverlayOpen()) {
            this.hud.setLobbies([], { loading: false, error: null, autoRefreshSec: 5, updatedAt: Date.now() });
          }
          return [];
        }

        const lobbies = await withTimeout(listLiveLobbies(adapter), 4500, 'Lobby list timed out');
        if (reqSeq !== this._lobbyListSeq || this._disposed) return lobbies;
        if (this.hud.isLaunchOverlayOpen()) {
          this.hud.setLobbies(lobbies, { loading: false, error: null, autoRefreshSec: 5, updatedAt: Date.now() });
        }
        return lobbies;
      } catch (err) {
        if (reqSeq !== this._lobbyListSeq || this._disposed) return [];
        if (this.hud.isLaunchOverlayOpen()) {
          this.hud.setLobbies(silent ? undefined : [], {
            loading: false,
            error: 'Live lobby lookup unavailable — Solo works offline.',
            autoRefreshSec: 5,
          });
        }
        return [];
      } finally {
        if (this._lobbyRefreshInFlight === run) {
          this._lobbyRefreshInFlight = null;
        }
      }
    })();

    this._lobbyRefreshInFlight = run;
    return run;
  }

  async _teardownNetwork() {
    this._mpClaimPending = false;
    this._isHosting = false;
    this._hasHydratedRemoteFire = false;
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

    if (this._mpAdapter) {
      const adapter = this._mpAdapter;
      this._mpAdapter = null;
      try { adapter.goOffline(); } catch { /* ignore */ }
      await adapter.close().catch(() => {});
    }
    await this._closeDirectoryAdapter();
  }

  /**
   * Enter 100% local Single-Player mission (Operation 01 -> 05) with ZERO Firebase sockets held.
   */
  async launchSolo({ autoControl = true, opConfig = null } = {}) {
    const seq = ++this._modeSwitchSeq;
    ++this._lobbyListSeq;
    this._stopLobbyAutoRefresh();
    this._unlockAndStartAtmosphere();
    this.hud.setLaunchBusy(null);
    this.hud.showLaunchOverlay(false);
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }

    if (this._dirConnectPromise) {
      await this._dirConnectPromise.catch(() => null);
    }
    await this._teardownNetwork();
    if (seq !== this._modeSwitchSeq) return;

    this.mode = 'solo';
    const targetOp = opConfig || this.opConfig || DEFAULT_OPERATION || OPERATIONS[0];
    if (!this.terrain || !this.fireSim || this.opConfig?.id !== targetOp.id) {
      this._buildWorld(targetOp, { preservePilot: false });
    }

    if (this.aircraft) {
      this.aircraft.slotId = 0;
      this.aircraft.callsign = this.settings.callsign || 'EF-07';
      this.aircraft.colorIdx = this.settings.colorIdx;
      this.aircraft.autopilot = !autoControl;
    }

    this.lastNetState = this._makeSoloNetState({ connStatus: 'solo' });
    this.hud.showOverlay(null);
    if (autoControl) {
      this.audio.playAlertPing(false);
    }
  }

  /**
   * Cleanly disconnect from Firebase (releasing Spark RTDB sockets immediately)
   * and transition seamlessly into a fully playable local single-player mission.
   * NEVER persisted to localStorage — reloading the page always retries live!
   */
  _enterOfflineLocalMission(kind = 'offline_error', reason = 'Live airspace unavailable', { keepManual = false } = {}) {
    this._stopLobbyAutoRefresh();
    const resolvedKind = kind === 'offline_full' ? 'offline_full' : 'offline_error';
    const session = this._mpSession;
    const adapter = this._mpAdapter;
    const dirAdapter = this._dirAdapter;
    this._mpSession = null;
    this._mpAdapter = null;
    this._dirAdapter = null;
    this._isHosting = false;
    this._mpClaimPending = false;
    this.remotePlanes = [];
    this.mode = 'solo';

    Promise.resolve().then(async () => {
      if (session) await session.stop().catch(() => {});
      if (adapter) {
        try { adapter.goOffline(); } catch { /* ignore */ }
        await adapter.close().catch(() => {});
      }
      if (dirAdapter && dirAdapter !== adapter) {
        try { dirAdapter.goOffline(); } catch { /* ignore */ }
        await dirAdapter.close().catch(() => {});
      }
    });

    if (this.aircraft) {
      this.aircraft.slotId = 0;
      if (keepManual) {
        this.aircraft.autopilot = false;
      }
    }

    this.lastNetState = this._makeSoloNetState({
      connStatus: resolvedKind,
      offlineReason: reason,
      offlineFallback: true,
    });

    this.hud.setLaunchBusy(null);
    this.hud.showLaunchOverlay(false);
    this.hud.showOverlay(null);
  }

  /**
   * Host a brand-new live co-op lobby:
   * picks an unused/stale shard (megabasin-01..18), resets fresh Operation 01,
   * claims slot + authoritative Host immediately, publishes fireKey & worldsIndex,
   * and hands control over as ● HOST · 1/100 with a shareable ?lobby= invite link!
   */
  async hostLobby({ preferredWorldId = null } = {}) {
    const seq = ++this._modeSwitchSeq;
    ++this._lobbyListSeq;
    this._stopLobbyAutoRefresh();
    this._unlockAndStartAtmosphere();
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }
    this.hud.setLaunchBusy('Starting hosted lobby...');

    // Tear down any prior live session cleanly first (await & reuse dirAdapter if open/connecting).
    if (this._dirConnectPromise) {
      await this._dirConnectPromise.catch(() => null);
    }
    const existingDir = this._dirAdapter;
    this._dirAdapter = null;
    await this._teardownNetwork();
    if (seq !== this._modeSwitchSeq) {
      if (existingDir) {
        try { existingDir.goOffline(); } catch { /* ignore */ }
        await existingDir.close().catch(() => {});
      }
      return { ok: false };
    }

    const freshOp = DEFAULT_OPERATION || OPERATIONS[0];
    this.mode = 'mp';
    this._buildWorld(freshOp, { preservePilot: false });
    this.lastNetState = this._makeInitialMpNetState('mp', preferredWorldId);

    let adapter = existingDir && !existingDir._closed ? existingDir : null;
    try {
      const [
        { FIREBASE_CONFIG },
        { parseNetQuery },
        { connectFirebase },
        { WorldSession },
        { pickHostableShard, buildLobbyInviteUrl },
      ] = await Promise.all([
        import('./net/firebaseConfig.js'),
        import('./net/config.js'),
        import('./net/FirebaseClient.js'),
        import('./net/WorldSession.js'),
        import('./net/LobbyDirectory.js'),
      ]);
      if (seq !== this._modeSwitchSeq) return { ok: false };

      const netCfg = parseNetQuery ? parseNetQuery(window.location.search) : {};
      if (!FIREBASE_CONFIG.apiKey && !netCfg.emu && !this.query.useEmulator) {
        throw new Error('Firebase API key not configured');
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false && !netCfg.emu && !this.query.useEmulator) {
        throw new Error('Browser is offline');
      }

      if (!adapter) {
        adapter = await withTimeout(
          connectFirebase({
            search: window.location.search,
            emulatorPorts: netCfg.emulatorPorts || (this.query.useEmulator ? undefined : null),
            tab: Boolean(netCfg.tab || this.query.perTabAuth),
          }),
          6000,
          'Live airspace connection timed out'
        );
      }
      if (seq !== this._modeSwitchSeq) {
        try { adapter.goOffline(); } catch { /* ignore */ }
        await adapter.close().catch(() => {});
        return { ok: false };
      }
      this._mpAdapter = adapter;

      const picked = await withTimeout(
        pickHostableShard(adapter, { preferredWorldId }),
        5000,
        'Shard selection timed out'
      );
      if (seq !== this._modeSwitchSeq) return { ok: false };

      const worldId = picked.worldId;
      this._lastJoinedWorldId = worldId;
      this._applyNetState({ worldId, inviteUrl: buildLobbyInviteUrl(worldId) }, 'mp');

      const session = this._createWorldSession(WorldSession, {
        adapter,
        worldId,
        forceFreshMission: !picked.allBusy,
      });

      this._mpSession = session;
      session.setLocalAircraft(this.aircraft, this._dropSeq);
      await withTimeout(session.start(), 6000, 'Live lobby sync timed out');
      if (seq !== this._modeSwitchSeq || this._mpSession !== session) return { ok: false };
      if (session.offlineFallback) return { ok: false };

      // Immediately seat Host & await hydrated HostBroadcaster (fresh fireKey + worldsIndex published!)
      const claim = await withTimeout(session.requestManualControl(), 6000, 'Host slot claim timed out');
      if (seq !== this._modeSwitchSeq || this._mpSession !== session) return { ok: false };
      if (!claim || !claim.seated) {
        this._enterOfflineLocalMission('offline_full', 'Airspace full (100/100)', { keepManual: true });
        return { ok: false };
      }

      this._applySeatToLocalAircraft(claim);
      session.setLocalAircraft(this.aircraft, this._dropSeq);

      if (!picked.allBusy) {
        await session.waitUntilHostReady(5000);
      }
      if (seq !== this._modeSwitchSeq || this._mpSession !== session) return { ok: false };

      this._isHosting = Boolean(session.isHost);
      const net = session.getNetState();
      this._applyNetState({
        ...net,
        worldId,
        inviteUrl: buildLobbyInviteUrl(worldId),
      }, 'mp');

      this.hud.setLaunchBusy(null);
      this.hud.showLaunchOverlay(false);
      this._syncAllFireCells(this.fireSim.getSnapshot());
      this.audio.playAlertPing(false);
      return { ok: true, worldId, isHost: this._isHosting, inviteUrl: this.lastNetState.inviteUrl };
    } catch (err) {
      console.warn('[EmberFront] Host lobby failed; starting playable local single-player mission:', err);
      if (seq !== this._modeSwitchSeq) return { ok: false };
      if (adapter && !this._mpAdapter) {
        try { adapter.goOffline(); } catch { /* ignore */ }
        await adapter.close().catch(() => {});
      }
      const msg = err?.message || 'Unable to start live lobby';
      const isFullErr = /capacity|full|100/i.test(msg);
      this._enterOfflineLocalMission(isFullErr ? 'offline_full' : 'offline_error', msg, { keepManual: true });
      return { ok: false };
    }
  }

  /**
   * Join an existing hosted lobby (via Live Lobbies list OR `/?lobby=megabasin-XX` invite link).
   * Auto-falls back cleanly to playable Solo if full (100/100) or unreachable.
   */
  async joinLobby(worldId, { autoSeat = true, opConfig = null, ignoreSimFull = false } = {}) {
    const seq = ++this._modeSwitchSeq;
    ++this._lobbyListSeq;
    this._stopLobbyAutoRefresh();
    if (autoSeat) {
      this._unlockAndStartAtmosphere();
    }
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }
    if (this.hud.isLaunchOverlayOpen()) {
      this.hud.setLaunchBusy('Joining live lobby...');
    }

    if (this._dirConnectPromise) {
      await this._dirConnectPromise.catch(() => null);
    }
    const existingDir = this._dirAdapter;
    this._dirAdapter = null;
    await this._teardownNetwork();
    if (seq !== this._modeSwitchSeq) {
      if (existingDir) {
        try { existingDir.goOffline(); } catch { /* ignore */ }
        await existingDir.close().catch(() => {});
      }
      return { ok: false };
    }

    const initialOp = opConfig || DEFAULT_OPERATION || OPERATIONS[0];
    this.mode = 'mp';
    this._buildWorld(initialOp, { preservePilot: false });
    this.lastNetState = this._makeInitialMpNetState('mp', worldId || null);

    if (this.query.simFull && !ignoreSimFull) {
      this._enterOfflineLocalMission('offline_full', 'Airspace full (100/100)', { keepManual: autoSeat });
      return { ok: false };
    }
    if (this.query.simOffline && !ignoreSimFull) {
      this._enterOfflineLocalMission('offline_error', 'Live airspace unavailable', { keepManual: autoSeat });
      return { ok: false };
    }

    let adapter = existingDir && !existingDir._closed ? existingDir : null;
    try {
      const [
        { FIREBASE_CONFIG, DEFAULT_WORLD_ID },
        { parseNetQuery },
        { connectFirebase },
        { WorldSession },
        { buildLobbyInviteUrl },
      ] = await Promise.all([
        import('./net/firebaseConfig.js'),
        import('./net/config.js'),
        import('./net/FirebaseClient.js'),
        import('./net/WorldSession.js'),
        import('./net/LobbyDirectory.js'),
      ]);
      if (seq !== this._modeSwitchSeq) return { ok: false };

      const netCfg = parseNetQuery ? parseNetQuery(window.location.search) : {};
      const resolvedWorldId = worldId || netCfg.lobbyId || netCfg.worldId || DEFAULT_WORLD_ID;
      this._lastJoinedWorldId = resolvedWorldId;

      if (!FIREBASE_CONFIG.apiKey && !netCfg.emu && !this.query.useEmulator) {
        throw new Error('Firebase API key not configured');
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false && !netCfg.emu && !this.query.useEmulator) {
        throw new Error('Browser is offline');
      }

      if (!adapter) {
        adapter = await withTimeout(
          connectFirebase({
            search: window.location.search,
            emulatorPorts: netCfg.emulatorPorts || (this.query.useEmulator ? undefined : null),
            tab: Boolean(netCfg.tab || this.query.perTabAuth),
          }),
          6000,
          'Live airspace connection timed out'
        );
      }
      if (seq !== this._modeSwitchSeq) {
        try { adapter.goOffline(); } catch { /* ignore */ }
        await adapter.close().catch(() => {});
        return { ok: false };
      }
      this._mpAdapter = adapter;

      const session = this._createWorldSession(WorldSession, {
        adapter,
        worldId: resolvedWorldId,
        forceFreshMission: false,
      });

      this._mpSession = session;
      session.setLocalAircraft(this.aircraft, this._dropSeq);
      await withTimeout(session.start(), 6000, 'Live airspace sync timed out');
      if (seq !== this._modeSwitchSeq || this._mpSession !== session) return { ok: false };
      if (session.offlineFallback) return { ok: false };

      if (autoSeat) {
        const claim = await withTimeout(session.requestManualControl(), 6000, 'Slot claim timed out');
        if (seq !== this._modeSwitchSeq || this._mpSession !== session) return { ok: false };
        if (claim && claim.seated) {
          this._applySeatToLocalAircraft(claim);
          session.setLocalAircraft(this.aircraft, this._dropSeq);
          this.audio.playAlertPing(false);
        } else if (claim && claim.full) {
          return { ok: false };
        }
      }

      this._isHosting = Boolean(session.isHost);
      this._applyNetState({
        ...session.getNetState(),
        worldId: resolvedWorldId,
        inviteUrl: buildLobbyInviteUrl(resolvedWorldId),
      }, 'mp');

      this.hud.setLaunchBusy(null);
      this.hud.showLaunchOverlay(false);
      this._syncAllFireCells(this.fireSim.getSnapshot());
      return { ok: true, worldId: resolvedWorldId };
    } catch (err) {
      console.warn('[EmberFront] Live lobby unreachable; starting playable local single-player mission:', err);
      if (seq !== this._modeSwitchSeq) return { ok: false };
      if (adapter && !this._mpAdapter) {
        try { adapter.goOffline(); } catch { /* ignore */ }
        await adapter.close().catch(() => {});
      }
      const msg = err?.message || 'Unable to reach Live Shared Airspace';
      const isFullErr = /capacity|full|100/i.test(msg);
      this._enterOfflineLocalMission(isFullErr ? 'offline_full' : 'offline_error', msg, { keepManual: autoSeat });
      return { ok: false };
    }
  }

  _createWorldSession(WorldSession, { adapter, worldId, forceFreshMission = false }) {
    const session = new WorldSession({
      adapter,
      terrain: this.terrain,
      fireSim: this.fireSim,
      opConfig: this.opConfig,
      opIndex: this.opIndex,
      worldId,
      buildHash: getBuildHash(),
      callsign: this.settings.callsign,
      colorIdx: this.settings.colorIdx,
      mode: 'mp',
      fallbackOnFull: true,
      forceFreshMission,
      connectTimeoutMs: 5500,
      onStatusChange: (_status, netState) => {
        if (netState && this._mpSession === session) {
          this._applyNetState(netState, 'mp');
        }
      },
      onScoreEvents: (events) => this._ingestScoreEvents(events),
      onDropOutcomes: (outcomes) => this._handleDropOutcomes(outcomes),
      onWorldEvents: (events) => this._handleWorldEvents(events),
      onOperationChange: (nextIdx) => this._handleRemoteOperationChange(nextIdx),
      onOperationAdvance: (info) => this._handleHostOperationAdvance(info),
      onPilotJoined: (pilot) => this._handlePilotJoined(pilot),
      onImpactEvents: (impacts) => {
        if (!this.renderer || !impacts) return;
        for (let i = 0; i < impacts.length; i++) {
          const imp = impacts[i];
          this.renderer.spawnImpactSteam(imp.x, imp.y, imp.z, imp.extinguished);
        }
      },
      onFireSync: ({ full, dirtyIndices } = {}) => {
        if (!this.renderer || !this.fireSim) return;
        this._hasHydratedRemoteFire = true;
        const s = this.fireSim.getSnapshot();
        if (full) {
          this._syncAllFireCells(s);
        } else {
          this.renderer.syncFireGrid(s.cells, s.phases, dirtyIndices, s.cabinHp, s.cabinAtRisk);
        }
      },
      onCapacityFull: ({ reason } = {}) => {
        if (this._mpSession !== session) return;
        this._enterOfflineLocalMission('offline_full', reason || 'Airspace full (100/100)', {
          keepManual: this._mpClaimPending || Boolean(this.aircraft && !this.aircraft.autopilot),
        });
      },
      onConnectionError: ({ reason } = {}) => {
        if (this._mpSession !== session) return;
        this._enterOfflineLocalMission('offline_error', reason || 'Live airspace unavailable', {
          keepManual: this._mpClaimPending || Boolean(this.aircraft && !this.aircraft.autopilot),
        });
      },
      onIdleOffline: () => {
        if (this._mpSession !== session) return;
        this._enterOfflineLocalMission('offline_error', 'Disconnected after 5 min idle — reload or retry live');
      },
    });
    return session;
  }

  _applySeatToLocalAircraft(res) {
    if (!this.aircraft || !res || !res.seated) return;
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
      this.aircraft.crashed = false;
      this.aircraft.crashTimer = 0;
      this.aircraft.hp = this.aircraft.maxHp || 100;
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
  }

  async retryLive() {
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }
    this.hud.showOverlay(null);
    await this.joinLobby(this._lastJoinedWorldId || this.query.lobbyParam || this.query.worldParam || undefined, {
      autoSeat: false,
      opConfig: this.opConfig || DEFAULT_OPERATION || OPERATIONS[0],
      ignoreSimFull: true,
    });
  }

  async openLaunchMenu() {
    if (this.hud.isDrawerOpen()) {
      this._handleToggleDrawer(false);
    }
    this.hud.showLaunchOverlay(true, {
      lobbies: [],
      loading: true,
      canDismiss: true,
      autoRefreshSec: 5,
      statusText: 'Switch between Solo, Host Lobby, or Join a live squadron',
    });
    this.refreshLobbies();
    this._startLobbyAutoRefresh();
  }

  _buildWorld(opConfig, { preservePilot = false } = {}) {
    const prevAircraft = preservePilot ? this.aircraft : null;
    const keepManual = Boolean(prevAircraft && !prevAircraft.autopilot);
    const keepSlotId = prevAircraft ? prevAircraft.slotId : (this.mode === 'solo' ? 0 : null);
    const keepCallsign = prevAircraft?.callsign || this.settings.callsign;
    const keepColorIdx = typeof prevAircraft?.colorIdx === 'number' ? prevAircraft.colorIdx : this.settings.colorIdx;

    this.opConfig = opConfig;
    this.opIndex = typeof opConfig?.opIndex === 'number' ? opConfig.opIndex : 0;
    this.terrain = generateTerrain(opConfig);
    this.fireSim = new FireSim(this.terrain, { isMegaBasin: true });
    this.fireSim.reset(1);
    this.autopilot = new Autopilot(this.terrain);
    this.autopilot.reset();

    const snap = this.fireSim.getSnapshot();
    this.aircraft = computeInitialSpawn(
      this.terrain,
      snap,
      keepSlotId,
      keepColorIdx,
      keepCallsign,
      !keepManual
    );

    if (!this.renderer) {
      this.renderer = new SceneRenderer(this.canvas, this.terrain);
    } else {
      this.renderer.rebuildWorld(this.terrain);
    }

    this._syncAllFireCells(snap);

    this._physAccum = 0;
    this._fireAccum = 0;
    this._parcelAccum = 0;
    this._cameraShake = 0;
    this._pendingScoreEvents = [];
    this._prevAnyCabinAtRisk = false;
    this._lastOverlayStatus = null;
    this._lastIntermissionSec = null;
    this._lastAtmosphere = { ...ZERO_ATMOSPHERE };
    this.hud.showOverlay(null);
  }

  _syncAllFireCells(snap) {
    if (!this.renderer || !snap || !snap.cells) return;
    this.renderer.syncFireGrid(snap.cells, snap.phases, null, snap.cabinHp, snap.cabinAtRisk);
  }

  _handleRemoteOperationChange(nextOpIndex) {
    const nextOp = getOperationByIndex(nextOpIndex) || DEFAULT_OPERATION || OPERATIONS[0];
    const wasRollover = this._hasHydratedRemoteFire && nextOp.opIndex !== this.opIndex;
    this._buildWorld(nextOp, { preservePilot: true });
    if (this._mpSession) {
      this._mpSession.setWorld({
        terrain: this.terrain,
        fireSim: this.fireSim,
        opConfig: nextOp,
        opIndex: nextOp.opIndex,
        publishNow: false,
      });
    }
    if (wasRollover) {
      this.radio.trigger('operation_advance', { priority: 'high' });
    }
  }

  _handleHostOperationAdvance({ nextOpIndex } = {}) {
    const nextOp = getOperationByIndex(nextOpIndex) || DEFAULT_OPERATION || OPERATIONS[0];
    this._buildWorld(nextOp, { preservePilot: true });
    if (this._mpSession) {
      this._mpSession.setWorld({
        terrain: this.terrain,
        fireSim: this.fireSim,
        opConfig: nextOp,
        opIndex: nextOp.opIndex,
        publishNow: true,
      });
    }
    this._syncAllFireCells(this.fireSim.getSnapshot());
    this.radio.trigger('operation_advance', { priority: 'high' });
    return true;
  }

  _handleManualAdvanceRequest() {
    if (this.mode === 'solo' || this.lastNetState.offlineFallback) {
      const nextOp = getOperationByIndex((this.opIndex + 1) % OPERATIONS.length) || OPERATIONS[0];
      this._buildWorld(nextOp, { preservePilot: true });
      this.radio.trigger('operation_advance', { priority: 'high' });
    } else if (this._isHosting && this._mpSession) {
      const nextOpIndex = (this.opIndex + 1) % OPERATIONS.length;
      this._handleHostOperationAdvance({ nextOpIndex });
    } else {
      this.hud.showOverlay(null);
    }
  }

  async switchMode(targetMode, opts = {}) {
    if (targetMode === 'solo') {
      await this.launchSolo({ autoControl: Boolean(opts.autoControl), opConfig: opts.opConfig || null });
      return;
    }

    if (targetMode === 'loopback') {
      const seq = ++this._modeSwitchSeq;
      await this._teardownNetwork();
      if (seq !== this._modeSwitchSeq) return;

      const op = opts.opConfig || MEGA_BASIN_OP;
      this.mode = 'loopback';
      this._buildWorld(op, { preservePilot: false });
      this.lastNetState = this._makeInitialMpNetState('loopback', 'loopback');
      this.hud.showLaunchOverlay(false);

      const totalPlanes = Math.max(2, Math.min(100, opts.totalPlanes || 100));
      const botCount = Math.min(99, totalPlanes - 1);

      const { createLoopbackSession } = await import('./net/LoopbackBots.js');
      if (seq !== this._modeSwitchSeq) return;

      const handle = createLoopbackSession({
        botCount,
        terrain: this.terrain,
        fireSim: this.fireSim,
        opConfig: op,
        opIndex: this.opIndex,
        callsign: this.settings.callsign,
        colorIdx: this.settings.colorIdx,
        onStatusChange: (_status, netState) => {
          if (netState) this._applyNetState(netState, 'loopback');
        },
        onScoreEvents: (events) => this._ingestScoreEvents(events),
        onDropOutcomes: (outcomes) => this._handleDropOutcomes(outcomes),
        onWorldEvents: (events) => this._handleWorldEvents(events),
        onOperationChange: (nextIdx) => this._handleRemoteOperationChange(nextIdx),
        onOperationAdvance: (info) => this._handleHostOperationAdvance(info),
        onPilotJoined: (pilot) => this._handlePilotJoined(pilot),
        onFireSync: ({ full, dirtyIndices } = {}) => {
          if (!this.renderer || !this.fireSim) return;
          this._hasHydratedRemoteFire = true;
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
      this._mpSession.setLocalAircraft(this.aircraft, this._dropSeq);
      await this._mpSession.start();
      if (seq !== this._modeSwitchSeq) {
        await handle.stop();
        return;
      }

      this._syncAllFireCells(this.fireSim.getSnapshot());
      return;
    }

    // Default 'mp' -> join specified/default live lobby
    await this.joinLobby(opts.worldId || undefined, {
      autoSeat: Boolean(opts.autoSeat),
      opConfig: opts.opConfig || null,
      ignoreSimFull: Boolean(opts.ignoreSimFull),
    });
  }

  async takeControl() {
    this._unlockAndStartAtmosphere();
    if (!this.aircraft) return;
    if (this.hud.isLaunchOverlayOpen()) {
      this.hud.showLaunchOverlay(false);
    }
    if (!this.aircraft.autopilot) return;

    // Solo or offline fallback: immediate 0 ms local flight!
    if (this.mode === 'solo' || !this._mpSession || this.lastNetState.offlineFallback) {
      this.aircraft.autopilot = false;
      if (this.aircraft.slotId == null) this.aircraft.slotId = 0;
      this.audio.playAlertPing(false);
      return;
    }

    if (this._mpSession && !this._mpClaimPending) {
      this._mpClaimPending = true;
      try {
        this._mpSession.setLocalAircraft(this.aircraft, this._dropSeq);
        const res = await this._mpSession.requestManualControl();
        if (res && res.seated) {
          this._applySeatToLocalAircraft(res);
          this._mpSession.setLocalAircraft(this.aircraft, this._dropSeq);
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
    if (this.hud.isLaunchOverlayOpen()) return;
    this._unlockAndStartAtmosphere();
    if (this.aircraft && this.aircraft.autopilot) {
      this.takeControl();
    }
  }

  _handleToggleAudio() {
    this._unlockAndStartAtmosphere();
    const muted = this.audio.toggleMute();
    this.settings.audioMuted = muted;
    this.hud.setAudioMuted(muted);
    if (!muted) {
      this.audio.playAlertPing(false);
    }
  }

  _handleToggleDrawer(force) {
    this._unlockAndStartAtmosphere();
    this.hud.toggleDrawer(force);
    const open = this.hud.isDrawerOpen();
    this.input.setOptions({ drawerOpen: open || this.hud.isLaunchOverlayOpen() });
  }

  _handleSettingChange(key, value) {
    if (key === 'callsign') {
      const clean = sanitizeCallsign(value);
      this.settings.callsign = clean;
      writeStorage(LS_KEYS.callsign, clean);
      if (this.aircraft) {
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
    } else if (key === 'audioMuted') {
      this._unlockAndStartAtmosphere();
      this.audio.setMuted(Boolean(value));
      this.settings.audioMuted = this.audio.isMuted();
      this.hud.setAudioMuted(this.settings.audioMuted);
    } else if (key === 'musicEnabled') {
      this._unlockAndStartAtmosphere();
      this.audio.setMusicEnabled(Boolean(value));
      this.settings.musicEnabled = this.audio.isMusicEnabled();
      if (this.settings.musicEnabled) this.audio.startMusic();
    } else if (key === 'musicVolume') {
      this.audio.setMusicVolume(Number(value));
      this.settings.musicVolume = this.audio.getMusicVolume();
    } else if (key === 'radioEnabled') {
      this.radio.setEnabled(Boolean(value));
      this.settings.radioEnabled = this.radio.isEnabled();
    } else if (key === 'radioVolume') {
      this.radio.setVolume(Number(value));
      this.settings.radioVolume = this.radio.getVolume();
    } else if (key === 'sfxEnabled') {
      this._unlockAndStartAtmosphere();
      this.audio.setSfxEnabled(Boolean(value));
      this.settings.sfxEnabled = this.audio.isSfxEnabled();
    } else if (key === 'sfxVolume') {
      this.audio.setSfxVolume(Number(value));
      this.settings.sfxVolume = this.audio.getSfxVolume();
    } else if (key === 'retryLive' && value) {
      this.retryLive();
    } else if (key === 'hostLobby' && value) {
      this.hostLobby();
    } else if (key === 'openLaunch' && value) {
      this.openLaunchMenu();
    } else if (key === 'copyInviteLink') {
      this._copyInviteLink(typeof value === 'string' ? value : undefined);
    }
  }

  _ingestScoreEvents(events) {
    if (!events || events.length === 0) return;
    const now = performance.now();
    const localSlot = this.mode === 'solo'
      ? 0
      : (this.lastNetState.localSlotId ?? this.aircraft?.slotId ?? null);

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      this._pendingScoreEvents.push(ev);

      const isLocal = localSlot !== null && ev.slotId === localSlot;
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

  _handleDropOutcomes(outcomes) {
    if (!outcomes || outcomes.length === 0 || !this.terrain) return;
    const now = performance.now();
    const localSlot = this.mode === 'solo' || this.lastNetState.offlineFallback
      ? (this.aircraft?.slotId ?? 0)
      : (this.lastNetState.localSlotId ?? this.aircraft?.slotId ?? null);

    for (const [k, ts] of this._recentOutcomeKeys.entries()) {
      if (now - ts > 1200) this._recentOutcomeKeys.delete(k);
    }

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      if (!o) continue;
      const key = `${o.slotId}|${Math.round(o.impactX / 4)}|${Math.round(o.impactZ / 4)}|${o.outcome}|${o.cellsExtinguished}`;
      if (this._recentOutcomeKeys.has(key)) continue;
      this._recentOutcomeKeys.set(key, now);

      const impactY = Math.max(this.terrain.waterLevel, this.terrain.getHeight(o.impactX, o.impactZ));
      if (this.renderer && typeof this.renderer.spawnDropImpactEffect === 'function') {
        this.renderer.spawnDropImpactEffect(o.impactX, impactY, o.impactZ, o.outcome, o.cellsExtinguished || 0);
      }
      if (this.hud && typeof this.hud.recordDropImpact === 'function') {
        this.hud.recordDropImpact(o.impactX, o.impactZ, o.outcome, o.cellsExtinguished || 0);
      }

      const isLocal = localSlot !== null && o.slotId === localSlot && !this.aircraft?.autopilot;
      if (!isLocal) continue;

      if (this.hud && typeof this.hud.showDropOutcome === 'function') {
        this.hud.showDropOutcome(o);
      }
      this.audio.playDropOutcome(o.outcome, o.cellsExtinguished || 0);
      if (o.cabinSaved) {
        this.audio.playCabinSavedChord();
      }

      // Altitude drop quality coaching on VHF radio (native priority 3 preempts turbulence_smoke)
      if (o.dropQuality === 'misted_high') {
        this.radio.trigger('drop_too_high');
      } else if (o.outcome === 'direct') {
        this.radio.trigger('hit_direct');
      } else if (o.outcome === 'partial') {
        this.radio.trigger('hit_partial');
      } else {
        const missCat =
          o.missType === 'overshot'
            ? 'miss_overshoot'
            : o.missType === 'short'
              ? 'miss_short'
              : 'miss_wide';
        this.radio.trigger(missCat);
      }
    }
  }

  _handleWorldEvents(events) {
    if (!events || events.length === 0) return;
    const now = performance.now();

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || !ev.type) continue;

      if (ev.type === 'cabin_at_risk') {
        if (now - this._lastCabinAlertMs > 10000) {
          this._lastCabinAlertMs = now;
          this.audio.playAlertPing(true);
        }
        this.radio.trigger('help_cabin', { priority: 'high' });
      } else if (ev.type === 'fire_contained') {
        this.audio.playCabinSavedChord();
        this.radio.trigger('fire_contained', { priority: 'high' });
      } else if (ev.type === 'wind_shift') {
        this.radio.trigger('wind_shift');
      }
    }
  }

  _handlePilotJoined(pilot) {
    if (!pilot) return;
    this.radio.trigger('mp_join');
  }

  _stepPhysics(dt) {
    const snap = this.fireSim.getSnapshot();
    const atmosphere = typeof this.fireSim.sampleFireAtmosphere === 'function'
      ? this.fireSim.sampleFireAtmosphere(this.aircraft.x, this.aircraft.y, this.aircraft.z)
      : ZERO_ATMOSPHERE;
    this._lastAtmosphere = atmosphere;

    let input;
    if (this.aircraft.autopilot) {
      this.input.sample(dt);
      const apSnap = {
        fireHead: snap.fireHead,
        atRiskCabin: snap.atRiskTarget,
        windVx: snap.windVx,
        windVz: snap.windVz,
        windDirDeg: snap.windDirDeg,
        windSpeedKt: snap.windSpeedKt,
      };
      input = this.autopilot.update(this.aircraft, apSnap, dt, this.fireSim);
    } else {
      input = this.input.sample(dt);
    }

    const isReplica = Boolean(
      this.mode !== 'solo' &&
      this._mpSession &&
      !this._isHosting &&
      !this.lastNetState.offlineFallback
    );
    const result = stepFlight(this.aircraft, input, this.terrain, dt, {
      externalTankSync: isReplica,
      fireCells: snap.cells,
      fireSim: this.fireSim,
      atmosphere,
    });
    const events = (result && result.events) || {};

    if (events.dropStarted) {
      this._dropSeq = (this._dropSeq + 1) & 0xffff;
      this._parcelAccum = WATER_PARCEL_INTERVAL;
    }
    if (events.tankFull) {
      this.audio.playTankFullPing();
      if (!this.aircraft.autopilot) {
        this.radio.trigger('scoop_full');
      }
    }
    if (events.scoopRoughStarted) {
      this._cameraShake = Math.max(this._cameraShake, 0.28);
      if (this.hud && typeof this.hud.showScoopRoughHint === 'function') {
        this.hud.showScoopRoughHint(2400);
      }
      if (typeof this.audio.playScoopRoughSlap === 'function') {
        this.audio.playScoopRoughSlap();
      }
      if (!this.aircraft.autopilot) {
        this.radio.trigger('scoop_rough');
      }
    }
    if (events.bounced) {
      this._cameraShake = Math.max(this._cameraShake, 0.7);
    }
    if (events.treeHit) {
      this._cameraShake = Math.max(this._cameraShake, 0.95);
      if (this.renderer && typeof this.renderer.spawnTreeHitEffect === 'function') {
        this.renderer.spawnTreeHitEffect(events.treeHit.x, events.treeHit.y, events.treeHit.z);
      }
      if (this.hud && typeof this.hud.showDamageFlash === 'function') {
        this.hud.showDamageFlash(events.treeHit.damage, events.treeHit.hp, 'tree');
      }
      this.audio.playTreeHit();
      if (!this.aircraft.autopilot) {
        this.radio.trigger('damage_hit');
      }
    }
    if (events.heatDamage) {
      this._cameraShake = Math.max(this._cameraShake, 0.72);
      if (this.hud && typeof this.hud.showDamageFlash === 'function') {
        this.hud.showDamageFlash(events.heatDamage.damage, events.heatDamage.hp, 'heat');
      }
      if (typeof this.audio.playThermalWarningPip === 'function') {
        this.audio.playThermalWarningPip(Math.max(0.5, events.heatDamage.heatDanger || 0.8));
      }
      if (!this.aircraft.autopilot) {
        this.radio.trigger('turbulence_smoke');
      }
    }
    if (events.planeCrash) {
      this._cameraShake = Math.max(this._cameraShake, 1.45);
      if (this.renderer && typeof this.renderer.spawnCrashExplosion === 'function') {
        this.renderer.spawnCrashExplosion(events.planeCrash.x, events.planeCrash.y, events.planeCrash.z);
      }
      if (this.hud && typeof this.hud.showCrashOverlay === 'function') {
        this.hud.showCrashOverlay({
          reason: events.planeCrash.reason,
          crashTimer: this.aircraft.crashTimer || FLIGHT_CONSTANTS.CRASH_RESPAWN_S || 3.5,
          maxTimer: FLIGHT_CONSTANTS.CRASH_RESPAWN_S || 3.5,
        });
      }
      this.audio.playCrash();
      if (!this.aircraft.autopilot) {
        this.radio.trigger('crash_respawn', { priority: 'high' });
      }
    }
    if (events.respawned) {
      this._parcelAccum = 0;
      this.audio.playAlertPing(false);
    }

    // Smoke turbulence VHF coaching (non-spammy 18 s cooldown inside RadioManager)
    if (
      !this.aircraft.autopilot &&
      !this.aircraft.crashed &&
      (atmosphere.turbulence > 0.45 || atmosphere.smokeDensity > 0.5)
    ) {
      this.radio.trigger('turbulence_smoke');
    }

    if (this.aircraft.releasing && !this.aircraft.crashed) {
      this._cameraShake = Math.max(this._cameraShake, 0.16);
      this._parcelAccum += dt;
      while (this._parcelAccum >= WATER_PARCEL_INTERVAL) {
        this._parcelAccum -= WATER_PARCEL_INTERVAL;
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
        // Spawn physics water parcel locally in Solo / offline fallback.
        // (In live hosted/joined MP, HostBroadcaster spawns parcels authoritatively for Host + Replicas!)
        if (this.mode === 'solo' || !this._mpSession || this.lastNetState.offlineFallback) {
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

    if (this.aircraft.scooping && !this.aircraft.crashed) {
      this._cameraShake = Math.max(this._cameraShake, this.aircraft.scoopQuality === 'rough' ? 0.24 : 0.11);
    }

    return events;
  }

  _stepLocalFire() {
    const delta = this.fireSim.step(FIRE_DT, 1);
    const snap = this.fireSim.getSnapshot();

    if (delta.advanceOperation) {
      const nextOp = getOperationByIndex((this.opIndex + 1) % OPERATIONS.length) || OPERATIONS[0];
      this._buildWorld(nextOp, { preservePilot: true });
      this.radio.trigger('operation_advance', { priority: 'high' });
      return;
    }

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

    const outcomes = typeof this.fireSim.drainDropOutcomes === 'function' ? this.fireSim.drainDropOutcomes() : [];
    if (outcomes.length > 0) this._handleDropOutcomes(outcomes);

    const worldEvents = typeof this.fireSim.drainWorldEvents === 'function' ? this.fireSim.drainWorldEvents() : [];
    if (worldEvents.length > 0) this._handleWorldEvents(worldEvents);

    if (delta.scoreEvents && delta.scoreEvents.length > 0) {
      this._ingestScoreEvents(delta.scoreEvents);
    }
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
    if (snap.status === 'intermission') {
      const sec = Math.max(0, Math.ceil(snap.intermissionTimer || 0));
      if (this._lastOverlayStatus !== 'intermission' || this._lastIntermissionSec !== sec) {
        this._lastOverlayStatus = 'intermission';
        this._lastIntermissionSec = sec;
        const nextOp = getOperationByIndex((this.opIndex + 1) % OPERATIONS.length);
        this.hud.showOverlay('intermission', {
          contained: (snap.cabinsAlive || 0) > 0,
          wave: snap.wave,
          opName: this.opConfig?.name,
          nextOpName: nextOp?.name,
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

    this.input.setOptions({ drawerOpen: this.hud.isDrawerOpen() || this.hud.isLaunchOverlayOpen() });

    // 1. Fixed 60 Hz flight physics accumulator (0 ms local input lag always)
    this._physAccum += dt;
    let bouncedThisFrame = false;
    let steps = 0;
    while (this._physAccum >= FIXED_DT && steps < 6) {
      this._physAccum -= FIXED_DT;
      const ev = this._stepPhysics(FIXED_DT);
      if (ev.bounced) bouncedThisFrame = true;
      steps++;
    }

    // 2. Local Solo FireSim OR Live Network Session step
    let runLocalFire = false;
    if (this.mode !== 'solo' && this._mpSession && !this.lastNetState.offlineFallback) {
      // Always keep HostBroadcaster's localAircraft reference fresh (even during seating/crash!)
      this._mpSession.setLocalAircraft(this.aircraft, this._dropSeq);
      if (!this.aircraft.autopilot && this.aircraft.slotId != null) {
        this._mpSession.sendLocalState(this.aircraft, this._dropSeq);
      }
      const mpStep = this._mpSession.step(dt, nowMs);
      if (mpStep) {
        this._isHosting = Boolean(mpStep.isHost);
        this.remotePlanes = mpStep.remotePlanes || [];
        if (
          typeof mpStep.localAuthTank === 'number' &&
          !this._isHosting &&
          !this.aircraft.autopilot &&
          !this.aircraft.crashed
        ) {
          this.aircraft.tankPct += (mpStep.localAuthTank - this.aircraft.tankPct) * Math.min(1, dt * 8);
        }
        if (mpStep.netState) {
          this._applyNetState(mpStep.netState, this.mode);
          if (mpStep.netState.localSlotId == null && !this.aircraft.autopilot && !this._mpClaimPending) {
            this.aircraft.autopilot = true;
            this.autopilot.reset();
          }
        }
      }
      // If sitting in zero-write DEMO FLIGHT on an empty shard (no Host yet), animate local preview visually
      if (
        this.aircraft.autopilot &&
        !this._isHosting &&
        !this._hasHydratedRemoteFire &&
        (this._mpSession.stream?.lastFireQ ?? -1) < 0
      ) {
        runLocalFire = true;
      }
    } else {
      this._isHosting = false;
      this.remotePlanes = [];
      runLocalFire = true;
    }

    if (runLocalFire) {
      this._fireAccum += dt;
      while (this._fireAccum >= FIRE_DT) {
        this._fireAccum -= FIRE_DT;
        this._stepLocalFire();
      }
    }

    const fireSnapshot = this.fireSim.getSnapshot();
    const atmosphere = typeof this.fireSim.sampleFireAtmosphere === 'function'
      ? this.fireSim.sampleFireAtmosphere(this.aircraft.x, this.aircraft.y, this.aircraft.z)
      : this._lastAtmosphere;
    this._lastAtmosphere = atmosphere;

    // 3. Fallback cabin-at-risk alert edge
    const anyAtRisk = Boolean(fireSnapshot.atRiskTarget);
    if (anyAtRisk && !this._prevAnyCabinAtRisk && nowMs - this._lastCabinAlertMs > 12000) {
      this._lastCabinAlertMs = nowMs;
      this.audio.playAlertPing(true);
    }
    this._prevAnyCabinAtRisk = anyAtRisk;

    // 4. Nearest fire distance + turbulence camera shake + AudioEngine update
    const nearestFireDist = this._computeNearestFireDist(fireSnapshot);
    if (!this.aircraft.crashed) {
      if (nearestFireDist < 70 && this.aircraft.agl < 65) {
        this._cameraShake = Math.max(this._cameraShake, 0.1 * (1 - nearestFireDist / 70));
      }
      if (atmosphere.turbulence > 0.05) {
        this._cameraShake = Math.max(this._cameraShake, atmosphere.turbulence * 0.24);
      }
    }

    this.audio.update({
      dt,
      airspeedKmh: this.aircraft.crashed ? 0 : this.aircraft.speedKmh,
      throttle: this.aircraft.crashed ? 0 : this.aircraft.throttle,
      windSpeedKt: fireSnapshot.windSpeedKt,
      scooping: !this.aircraft.crashed && this.aircraft.scooping,
      releasing: !this.aircraft.crashed && this.aircraft.releasing,
      nearestFireDist,
      bounced: bouncedThisFrame,
      turbulence: this.aircraft.crashed ? 0 : atmosphere.turbulence,
      smokeDensity: this.aircraft.crashed ? 0 : atmosphere.smokeDensity,
      heatDanger: this.aircraft.crashed ? 0 : atmosphere.heatDanger,
      scoopRough: !this.aircraft.crashed && this.aircraft.scoopQuality === 'rough',
    });

    // 5. Ballistic Drop Prediction + Altitude Envelope + Cockpit Target-Lock Pip
    const showDropReticle = !this.aircraft.autopilot && !this.aircraft.crashed && this.settings.showDropReticle;
    const dropPreview = !this.aircraft.crashed
      ? predictDropImpact(this.aircraft, fireSnapshot, this.terrain, this.fireSim)
      : null;
    this._lastDropPreview = dropPreview;

    const onTargetLocked = Boolean(
      !this.aircraft.autopilot &&
      !this.aircraft.crashed &&
      this.aircraft.tankPct > 0 &&
      dropPreview &&
      (dropPreview.onTarget || dropPreview.fireCellsInTarget > 0)
    );
    this.audio.playTargetLockPip(onTargetLocked);

    // 6. Render retro WebGL scene (landscape & portrait responsive, smoke fog + turbulence)
    this.renderer.update({
      dt,
      elapsed: this._elapsed,
      localAircraft: this.aircraft,
      remotePlanes: this.remotePlanes,
      fireSnapshot,
      showDropReticle,
      dropPreview,
      atmosphere,
      cameraShake: this._cameraShake,
    });
    this._cameraShake = Math.max(0, this._cameraShake - dt * 2.4);

    // 7. Update Minimal HUD + Tactical Map + Mobile Touch Controls
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
      dropPreview,
      atmosphere,
    });

    if (this.touchControls) {
      this.touchControls.update({
        tankPct: this.aircraft.tankPct,
        onTarget: onTargetLocked,
        scooping: Boolean(this.aircraft.scooping),
        releasing: Boolean(this.aircraft.releasing),
        demoFlight: Boolean(this.aircraft.autopilot),
        crashed: Boolean(this.aircraft.crashed),
      });
    }

    this._updateOverlays(fireSnapshot);
  }

  _exposeDebugHook() {
    const app = this;
    const api = {
      version: getAppVersion(),
      buildHash: getBuildHash(),
      getState() {
        const stats = app.renderer ? app.renderer.getStats() : null;
        const snap = app.fireSim ? app.fireSim.getSnapshot() : null;
        const ac = app.aircraft;
        return {
          version: getAppVersion(),
          buildHash: getBuildHash(),
          fps: app._fps,
          drawCalls: stats ? stats.drawCalls : 0,
          triangles: stats ? stats.triangles : 0,
          renderWidth: stats ? stats.renderWidth : 0,
          renderHeight: stats ? stats.renderHeight : 0,
          remoteCount: stats ? stats.remoteCount : app.remotePlanes.length,
          mode: app.mode,
          isHost: Boolean(app._isHosting),
          worldId: app.lastNetState?.worldId || null,
          inviteUrl: app.lastNetState?.inviteUrl || '',
          connStatus: app.lastNetState?.connStatus || 'solo',
          offlineReason: app.lastNetState?.offlineReason || null,
          opIndex: app.opIndex,
          opId: app.opConfig ? app.opConfig.id : null,
          opName: app.opConfig ? app.opConfig.name : null,
          drawerOpen: app.hud ? app.hud.isDrawerOpen() : false,
          launchOverlayOpen: app.hud ? app.hud.isLaunchOverlayOpen() : false,
          touchMode: app.touchControls ? app.touchControls.isTouchMode() : false,
          audioMuted: app.audio ? app.audio.isMuted() : true,
          musicEnabled: app.audio ? app.audio.isMusicEnabled() : false,
          radioEnabled: app.radio ? app.radio.isEnabled() : false,
          sfxEnabled: app.audio ? app.audio.isSfxEnabled() : false,
          atmosphere: { ...app._lastAtmosphere },
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
                hp: Math.round(ac.hp ?? 100),
                maxHp: Math.round(ac.maxHp ?? 100),
                crashed: Boolean(ac.crashed),
                crashTimer: Number((ac.crashTimer || 0).toFixed(2)),
                crashReason: ac.crashReason || '',
                scooping: Boolean(ac.scooping),
                scoopQuality: ac.scoopQuality || 'none',
                releasing: Boolean(ac.releasing),
                autopilot: Boolean(ac.autopilot),
                callsign: ac.callsign,
                slotId: ac.slotId,
                colorIdx: ac.colorIdx,
              }
            : null,
          dropPreview: app._lastDropPreview
            ? {
                impactX: Number(app._lastDropPreview.impactX?.toFixed?.(1) ?? 0),
                impactZ: Number(app._lastDropPreview.impactZ?.toFixed?.(1) ?? 0),
                onTarget: Boolean(app._lastDropPreview.onTarget),
                altZone: app._lastDropPreview.altZone || 'optimal',
                dropQuality: app._lastDropPreview.dropQuality || 'optimal',
                releaseAgl: Math.round(app._lastDropPreview.releaseAgl ?? 0),
                coolingMult: Number((app._lastDropPreview.coolingMult ?? 1).toFixed(2)),
                fireCellsInTarget: app._lastDropPreview.fireCellsInTarget || 0,
                nearFireDistM: Math.round(app._lastDropPreview.nearFireDistM ?? 9999),
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
                fireHead: snap.fireHead ? { x: Math.round(snap.fireHead.x), z: Math.round(snap.fireHead.z) } : null,
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
      launchSolo(opts) {
        return app.launchSolo(opts);
      },
      hostLobby(opts) {
        return app.hostLobby(opts);
      },
      joinLobby(worldId, opts) {
        return app.joinLobby(worldId, opts);
      },
      refreshLobbies(opts) {
        return app.refreshLobbies(opts);
      },
      openLaunchMenu() {
        return app.openLaunchMenu();
      },
      getRemotePlaneRenderPositions() {
        const list = app.remotePlanes || [];
        const fleet = app.renderer?._remoteFleet;
        const matArr = fleet?.bodyMesh?.instanceMatrix?.array || null;
        const activeCount = fleet?.activeCount ?? 0;
        return list.map((p, i) => {
          let renderX = p.x;
          let renderY = p.y;
          let renderZ = p.z;
          if (matArr && i < activeCount) {
            const base = i * 16;
            renderX = matArr[base + 12];
            renderY = matArr[base + 13];
            renderZ = matArr[base + 14];
          }
          return {
            slotId: p.slotId,
            callsign: p.callsign || `EF-${String(p.slotId ?? i).padStart(2, '0')}`,
            x: p.x,
            y: p.y,
            z: p.z,
            renderX,
            renderY,
            renderZ,
            yawDeg: p.yawDeg,
            pitchDeg: p.pitchDeg,
            rollDeg: p.rollDeg,
            speedKmh: p.speedKmh,
          };
        });
      },
      getSessionInfo() {
        const pb = app._mpSession?.interpolator?.playback;
        return {
          mode: app.mode,
          isHost: Boolean(app._isHosting),
          worldId: app.lastNetState?.worldId || null,
          planesIntervalMs: app._mpSession?.host?.getPlanesIntervalMs?.() ?? null,
          playbackDelayMs: pb ? Math.round(pb.targetDelayMs) : null,
          ewmaIntervalMs: pb ? Math.round(pb.ewmaIntervalMs) : null,
          ewmaJitterMs: pb ? Math.round(pb.ewmaJitterMs) : null,
          lobbyAutoRefreshActive: Boolean(app._lobbyAutoRefreshTimer),
          dirAdapterConnected: Boolean(app._dirAdapter && !app._dirAdapter._closed && app._dirAdapter.connected),
          mpAdapterConnected: Boolean(app._mpAdapter && !app._mpAdapter._closed && app._mpAdapter.connected),
        };
      },
      takeControl() {
        return app.takeControl();
      },
      returnToDemo() {
        return app.returnToDemo();
      },
      switchMode(mode, opts) {
        return app.switchMode(mode, opts);
      },
      retryLive() {
        return app.retryLive();
      },
      toggleDrawer(force) {
        app._handleToggleDrawer(force);
      },
      triggerDrop(durationMs = 900) {
        if (app.aircraft && app.aircraft.autopilot) {
          app.takeControl();
        }
        if (app.aircraft && app.aircraft.tankPct < 30) {
          app.aircraft.tankPct = 100;
        }
        app.input.triggerDropPulse(durationMs);
      },
      positionForDrop(agl = 34) {
        // QA helper: align aircraft cleanly on an optimal/high approach vector over active fireHead
        if (!app.aircraft || !app.terrain || !app.fireSim) return null;
        const snap = app.fireSim.getSnapshot();
        const head = snap.fireHead;
        if (!head) return null;
        const ground = Math.max(app.terrain.waterLevel, app.terrain.getHeight(head.x, head.z));
        const spdKmh = 158;
        const spdMs = spdKmh / 3.6;
        const tFall = Math.sqrt((2 * Math.max(8, agl)) / (FLIGHT_CONSTANTS.DROP_GRAVITY || 40));
        const leadDist = spdMs * tFall;
        app.aircraft.x = head.x - (snap.windVx || 0) * (FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR || 0.35) * tFall;
        app.aircraft.z = head.z + leadDist - (snap.windVz || 0) * (FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR || 0.35) * tFall;
        app.aircraft.y = ground + agl;
        app.aircraft.agl = agl;
        app.aircraft.yawDeg = 0;
        app.aircraft.pitchDeg = 0;
        app.aircraft.rollDeg = 0;
        app.aircraft.speedKmh = spdKmh;
        app.aircraft.vx = 0;
        app.aircraft.vy = 0;
        app.aircraft.vz = -spdMs;
        app.aircraft.tankPct = 100;
        app.aircraft.crashed = false;
        return { head, agl, leadDist };
      },
      triggerRadio(category) {
        app._unlockAndStartAtmosphere();
        return app.radio.trigger(category || 'chatter_misc', { force: true });
      },
      setCameraYaw(deg, pitchDeg = 10) {
        if (!app.aircraft || !app.terrain) return;
        app.aircraft.autopilot = false;
        app.aircraft.yawDeg = ((deg % 360) + 360) % 360;
        app.aircraft.pitchDeg = pitchDeg;
        app.aircraft.rollDeg = 0;
        const ground = Math.max(app.terrain.waterLevel, app.terrain.getHeight(app.aircraft.x, app.aircraft.z));
        if (app.aircraft.y < ground + 95) {
          app.aircraft.y = ground + 95;
          app.aircraft.agl = 95;
        }
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
              atmosphere: app._lastAtmosphere,
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
    this._stopLobbyAutoRefresh();
    if (this._rafId) cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    if (typeof document !== 'undefined' && this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._offRadioTx?.();
    this._teardownNetwork();
    this.touchControls?.dispose?.();
    this.input.dispose();
    this.hud.dispose();
    this.radio.dispose();
    this.audio.dispose();
    if (this.renderer) this.renderer.dispose();
  }
}

const app = new EmberFrontApp();
app.init().catch((err) => {
  console.error('[EmberFront] Fatal startup error:', err);
});
