// Minimal, Streamlined Native-Resolution Tactical HUD Orchestrator for EMBER FRONT
// Strictly uses DOM APIs and textContent (zero innerHTML, zero inline scripts).
// Corner widgets + atmosphere vignettes + altitude JIT coaching + auto-hiding VHF radio + sleek Launch Overlay.

import { LIVERIES } from '../config/liveries.js';
import { OPERATIONS } from '../config/operations.js';
import { TacticalMap } from './TacticalMap.js';
import { WorldCallouts } from './WorldCallouts.js';
import { SettingsDrawer, sanitizeCallsign } from './SettingsDrawer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CARDINALS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];
const COMPASS_CARDINALS = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

const COMPASS_SPAN_DEG = 120; // ±60°
const COMPASS_BASE_WIDTH = 280;
const PX_PER_DEG = COMPASS_BASE_WIDTH / COMPASS_SPAN_DEG;
const MAX_ACTIVE_TOASTS = 5;
const BAR_SEGMENTS = 16;
const MANUAL_HINT_DURATION_MS = 8200;
const OUTCOME_DISPLAY_MS = 3200;
const RADIO_LINGER_MS = 2500;
const RADIO_SAFETY_END_MS = 5600;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function createWindArrowSvg() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.appendChild(
    svgEl('path', {
      d: 'M12 2L18 13.5L13.5 12.2V21H10.5V12.2L6 13.5L12 2Z',
    })
  );
  return svg;
}

function createSpeakerSvg(muted) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'ef-icon-svg', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d: 'M3 9v6h4l5 4V5L7 9H3z' }));
  if (muted) {
    svg.appendChild(
      svgEl('path', {
        d: 'M16.5 9.5L21 14m0-4.5L16.5 14',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        fill: 'none',
      })
    );
  } else {
    svg.appendChild(
      svgEl('path', {
        d: 'M15.5 8.5a5 5 0 0 1 0 7M18.2 5.8a8.5 8.5 0 0 1 0 12.4',
        stroke: 'currentColor',
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
        fill: 'none',
      })
    );
  }
  return svg;
}

function createGearSvg() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'ef-icon-svg', 'aria-hidden': 'true' });
  svg.appendChild(
    svgEl('path', {
      d: 'M19.4 13a7.9 7.9 0 0 0 .06-1 7.9 7.9 0 0 0-.06-1l2.1-1.64a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.48 1a7.4 7.4 0 0 0-1.72-1l-.38-2.64a.5.5 0 0 0-.5-.42h-4a.5.5 0 0 0-.5.42l-.38 2.64a7.4 7.4 0 0 0-1.72 1l-2.48-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64L4.6 11a7.9 7.9 0 0 0-.06 1 7.9 7.9 0 0 0 .06 1l-2.1 1.64a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.48-1a7.4 7.4 0 0 0 1.72 1l.38 2.64a.5.5 0 0 0 .5.42h4a.5.5 0 0 0 .5-.42l.38-2.64a7.4 7.4 0 0 0 1.72-1l2.48 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z',
    })
  );
  return svg;
}

function degToCardinal16(deg) {
  const norm = ((deg % 360) + 360) % 360;
  return CARDINALS_16[Math.round(norm / 22.5) % 16];
}

function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

function shortestAngleStep(current, target) {
  let diff = ((target - current + 540) % 360) - 180;
  if (diff < -180) diff += 360;
  return current + diff;
}

function clamp01(v) {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function resolveAppVersion(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  // eslint-disable-next-line no-undef
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
    // eslint-disable-next-line no-undef
    return String(__APP_VERSION__).trim();
  }
  return 'dev';
}

function resolveBuildHash(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  // eslint-disable-next-line no-undef
  if (typeof __BUILD_HASH__ !== 'undefined' && __BUILD_HASH__) {
    // eslint-disable-next-line no-undef
    return String(__BUILD_HASH__).trim();
  }
  return 'local';
}

function formatVersionLabel(ver) {
  if (!ver || ver === 'dev') return 'dev';
  return /^v/i.test(ver) ? ver : `v${ver}`;
}

function resolveRadioAccent(urgency, category) {
  const u = String(urgency || '').toLowerCase();
  const c = String(category || '').toLowerCase();
  if (
    u === 'urgent' ||
    u === 'critical' ||
    u === 'high' ||
    u === 'help_cabin' ||
    c === 'help_cabin' ||
    c === 'cabin_at_risk' ||
    c === 'damage_hit' ||
    c === 'crash_respawn' ||
    c === 'heat_warning' ||
    c === 'thermal_heat'
  ) {
    return 'is-urgent';
  }
  if (u === 'success' || u === 'hit_direct' || c === 'hit_direct' || c === 'fire_contained') {
    return 'is-direct';
  }
  if (
    u === 'warn' ||
    u === 'warning' ||
    u.startsWith('miss') ||
    c.startsWith('miss') ||
    c === 'hit_partial' ||
    c === 'drop_too_high' ||
    c === 'misted_high' ||
    c === 'scoop_rough'
  ) {
    return 'is-warn';
  }
  if (
    u === 'info' ||
    u === 'mp_join' ||
    c === 'mp_join' ||
    c === 'scoop_full' ||
    c === 'operation_advance'
  ) {
    return 'is-info';
  }
  return 'is-neutral';
}

function formatFreq(freq) {
  if (!freq) return '122.925 MHz';
  const s = String(freq).trim();
  return /mhz/i.test(s) ? s : `${s} MHz`;
}

function resolveConnStatus(netState) {
  if (!netState) return 'connecting';
  if (
    netState.connStatus === 'solo' ||
    netState.connStatus === 'host' ||
    netState.connStatus === 'online' ||
    netState.connStatus === 'connecting' ||
    netState.connStatus === 'offline_full' ||
    netState.connStatus === 'offline_error'
  ) {
    if (netState.connStatus === 'online' && netState.status === 'host') return 'host';
    return netState.connStatus;
  }
  if (netState.mode === 'solo' || netState.status === 'solo') return 'solo';
  if (netState.status === 'syncing') return 'connecting';
  if (netState.status === 'offline' || netState.offlineFallback) {
    const reason = String(netState.offlineReason || '').toLowerCase();
    return reason.includes('full') || reason.includes('100') ? 'offline_full' : 'offline_error';
  }
  if (netState.status === 'host') return 'host';
  if (netState.status === 'live') return 'online';
  return 'connecting';
}

export class HudController {
  constructor({
    onToggleAudio,
    onOpenDrawer,
    onSettingChange,
    onNextOperation,
    onReplay,
    onResumeLive,
    onLaunchSolo,
    onHostLobby,
    onJoinLobby,
    onRefreshLobbies,
    onCopyInviteLink,
    onCloseLaunch,
    appVersion,
    buildHash,
  } = {}) {
    this._callbacks = {
      onToggleAudio,
      onOpenDrawer,
      onSettingChange,
      onNextOperation,
      onReplay,
      onResumeLive,
      onLaunchSolo,
      onHostLobby,
      onJoinLobby,
      onRefreshLobbies,
      onCopyInviteLink,
      onCloseLaunch,
    };
    this._appVersion = resolveAppVersion(appVersion);
    this._buildHash = resolveBuildHash(buildHash);

    this._root =
      (typeof document !== 'undefined' && document.getElementById('hud-root')) ||
      this._createFallbackRoot();
    this._root.replaceChildren();

    this._audioMuted = false;
    this._windVisualAngle = 0;
    this._windAngleInit = false;
    this._overlayType = null;
    this._overlayCountdownEl = null;
    this._overlayContained = true;
    this._overlayNextOpName = '';
    this._toastTimers = new Set();

    // JIT hint & atmosphere vignette state
    this._wasAutopilot = true;
    this._manualHintUntilMs = 0;
    this._roughScoopUntilMs = 0;
    this._lastHullHp = 100;
    this._lastConnStatus = null;
    this._smokeVis = 0;
    this._heatVis = 0;

    // Launch / Lobby browser overlay state
    this._launchOpen = false;
    this._launchCanDismiss = false;
    this._launchBusy = false;
    this._lobbies = [];
    this._lobbiesLoading = false;
    this._lobbiesError = null;
    this._hasLoadedLobbies = false;
    this._lastLobbiesUpdatedAt = 0;

    // Outcome toast & peripheral flash timers
    this._outcomeHideTimer = null;
    this._flashTimer = null;

    // Auto-hiding VHF radio state
    this._radioEntries = [];
    this._radioHideTimer = null;
    this._radioSafetyTimer = null;

    // 1. 3D-Projected World Callouts Layer (behind HUD widgets)
    this._callouts = new WorldCallouts();
    this._root.appendChild(this._callouts.el);

    // 1b. Dynamic Cockpit Smoke Plume Haze & Thermal Heat Caution Vignettes
    this._smokeVignetteEl = el('div', 'ef-smoke-vignette');
    this._smokeVignetteEl.style.opacity = '0';
    this._root.appendChild(this._smokeVignetteEl);

    this._heatVignetteEl = el('div', 'ef-heat-vignette');
    this._heatVignetteEl.style.opacity = '0';
    this._root.appendChild(this._heatVignetteEl);

    // 2. Peripheral Edge Flash Layer (direct hit emerald glow / damage red flash)
    this._flashEl = el('div', 'ef-hud-flash');
    this._root.appendChild(this._flashEl);

    // 3. Top-Left Stack: Compact Mission/Airspace Pill + Auto-Hiding VHF Radio Comms Toast
    this._buildLeftTopStack();

    // 4. Top-Center Slim Compass Ribbon + Post-Drop Outcome Banner below it
    this._buildCompass();
    this._buildOutcomeBanner();

    // 5. Top-Right Compact Wind Chip + Audio Mute Icon + Settings Gear Icon
    this._buildTopRightCluster();

    // 6. Bottom-Left Compact Flight Telemetry Card (SPD, ALT, TANK, HULL)
    this._buildTelemetryCard();

    // 7. Bottom-Center Single Just-in-Time (JIT) Contextual Hint Pill
    this._buildJitHint();

    // 8. Bottom-Right North-Up Tactical Map (with drop preview & 6.5s impact ripples)
    this._tacticalMap = new TacticalMap();
    this._root.appendChild(this._tacticalMap.el);

    // 9. Sleek Minimal Launch Overlay (Solo / Host Lobby / Join Live Lobby over DEMO FLIGHT)
    this._buildLaunchOverlay();

    // 10. Non-blocking Crash Respawn Banner Overlay
    this._buildCrashOverlay();

    // 11. Slide-Over Settings, Audio Mixer, Controls & Live Squadron Drawer
    this._drawer = new SettingsDrawer({
      appVersion: this._appVersion,
      buildHash: this._buildHash,
      onSettingChange: (key, val) => {
        if (key === 'audioMuted') {
          this.setAudioMuted(Boolean(val));
        }
        if (this._callbacks.onSettingChange) {
          this._callbacks.onSettingChange(key, val);
          return;
        }
        // Fallback when SettingsDrawer actions are wired via direct callbacks without onSettingChange
        if (key === 'copyInviteLink' && this._callbacks.onCopyInviteLink) {
          this._callbacks.onCopyInviteLink(val);
        } else if (key === 'hostLobby' && this._callbacks.onHostLobby) {
          this._callbacks.onHostLobby();
        } else if (key === 'openLaunch') {
          this.showLaunchOverlay(true, { canDismiss: true });
          if (this._callbacks.onRefreshLobbies) this._callbacks.onRefreshLobbies();
        }
      },
      onClose: () => {
        this._settingsBtn.classList.remove('is-active');
      },
    });
    this._root.appendChild(this._drawer.backdropEl);
    this._root.appendChild(this._drawer.drawerEl);

    // 12. Full Mission Overlay container (Victory / Defeat / Intermission / Offline)
    this._overlayEl = el('div', 'ef-overlay ef-hidden');
    this._root.appendChild(this._overlayEl);
  }

  get tacticalMap() {
    return this._tacticalMap;
  }

  _createFallbackRoot() {
    const div = document.createElement('div');
    div.id = 'hud-root';
    document.body.appendChild(div);
    return div;
  }

  _buildLeftTopStack() {
    const stack = el('div', 'ef-left-top-stack');

    // Compact Operation, Fire, Cabin, Score & Live Pilots Pill
    const card = el('section', 'ef-card ef-op-card');
    card.setAttribute('aria-label', 'Active Operation and Live Airspace');

    const topRow = el('div', 'ef-op-toprow');
    this._opCodeEl = el('span', 'ef-op-code', 'OP 01/05');
    topRow.appendChild(this._opCodeEl);

    this._airspacePill = el('span', 'ef-airspace-chip status-connecting');
    this._airspacePill.setAttribute('data-conn-status', 'connecting');
    this._airspaceDot = el('span', 'ef-status-dot');
    this._airspaceText = el('span', null, 'CONNECTING');
    this._airspacePill.appendChild(this._airspaceDot);
    this._airspacePill.appendChild(this._airspaceText);
    topRow.appendChild(this._airspacePill);
    card.appendChild(topRow);

    this._opTitleEl = el('div', 'ef-op-title', 'Cinderpine Basin');
    card.appendChild(this._opTitleEl);

    const stats = el('div', 'ef-op-stats');

    const cabinStat = el('div', 'ef-op-stat');
    cabinStat.appendChild(el('span', 'ef-op-stat-label', 'CABINS'));
    this._opCabinsEl = el('span', 'ef-op-stat-val', '10/10');
    cabinStat.appendChild(this._opCabinsEl);
    stats.appendChild(cabinStat);

    const fireStat = el('div', 'ef-op-stat');
    fireStat.appendChild(el('span', 'ef-op-stat-label', 'FIRE'));
    this._opBurningEl = el('span', 'ef-op-stat-val is-fire', '3.5%');
    fireStat.appendChild(this._opBurningEl);
    stats.appendChild(fireStat);

    const scoreStat = el('div', 'ef-op-stat ef-op-stat-score');
    scoreStat.appendChild(el('span', 'ef-op-stat-label', 'SCORE'));
    this._missionScoreValEl = el('span', 'ef-op-stat-val is-score', '000000');
    scoreStat.appendChild(this._missionScoreValEl);
    stats.appendChild(scoreStat);

    card.appendChild(stats);

    // Floating score micro-toasts anchored cleanly to the compact mission pill
    this._toastAnchor = el('div', 'ef-toast-anchor');
    card.appendChild(this._toastAnchor);

    stack.appendChild(card);

    // Auto-hiding VHF Aviation Radio Comms Toast Strip (hidden when silent!)
    const radio = el('section', 'ef-card ef-radio-toast is-hidden');
    radio.setAttribute('aria-label', 'VHF Radio Comms');
    radio.setAttribute('aria-live', 'polite');

    const radioHead = el('div', 'ef-radio-head');
    const leftMeta = el('div', 'ef-radio-meta');
    leftMeta.appendChild(el('span', 'ef-radio-tag', 'VHF'));
    this._radioFreqEl = el('span', 'ef-radio-freq', '122.925 MHz');
    leftMeta.appendChild(this._radioFreqEl);
    radioHead.appendChild(leftMeta);

    const txBadge = el('div', 'ef-radio-tx');
    txBadge.appendChild(el('span', 'ef-radio-led'));
    const wave = el('span', 'ef-radio-wave');
    for (let i = 0; i < 4; i++) {
      wave.appendChild(el('span', `ef-radio-bar b${i + 1}`));
    }
    txBadge.appendChild(wave);
    this._radioTxLabel = el('span', 'ef-radio-tx-text', 'TX');
    txBadge.appendChild(this._radioTxLabel);
    this._radioTxEl = txBadge;
    radioHead.appendChild(txBadge);

    radio.appendChild(radioHead);

    this._radioFeedEl = el('div', 'ef-radio-feed');
    radio.appendChild(this._radioFeedEl);

    this._radioEl = radio;
    stack.appendChild(radio);

    this._root.appendChild(stack);
  }

  _buildCompass() {
    const wrap = el('div', 'ef-compass-wrap');
    wrap.setAttribute('aria-label', 'Heading Compass');

    const win = el('div', 'ef-compass-window');
    win.appendChild(el('div', 'ef-compass-pointer'));

    const tape = el('div', 'ef-compass-tape');
    for (let deg = -180; deg <= 540; deg += 5) {
      const norm = normalizeDeg(deg);
      const isCardinal = Object.prototype.hasOwnProperty.call(COMPASS_CARDINALS, norm);
      const isMajor = norm % 15 === 0;
      const showNumeric = !isCardinal && norm % 30 === 0;

      const tick = el(
        'div',
        `ef-compass-tick${isCardinal ? ' is-cardinal' : isMajor ? ' is-major' : ''}`
      );
      tick.style.left = `${(deg + 180) * PX_PER_DEG}px`;
      tick.appendChild(el('div', 'ef-compass-tick-mark'));

      if (isCardinal) {
        tick.appendChild(el('span', 'ef-compass-tick-label', COMPASS_CARDINALS[norm]));
      } else if (showNumeric) {
        tick.appendChild(el('span', 'ef-compass-tick-label', String(norm).padStart(3, '0')));
      }
      tape.appendChild(tick);
    }

    win.appendChild(tape);
    wrap.appendChild(win);

    this._compassWindow = win;
    this._compassTape = tape;
    this._compassReadout = el('div', 'ef-compass-readout', '000°');
    wrap.appendChild(this._compassReadout);

    this._root.appendChild(wrap);
  }

  _buildOutcomeBanner() {
    this._outcomeBannerEl = el('div', 'ef-outcome-banner is-hidden');
    this._outcomeBannerEl.setAttribute('aria-live', 'assertive');
    this._outcomeMainEl = el('div', 'ef-outcome-main', '');
    this._outcomeSubEl = el('div', 'ef-outcome-sub ef-hidden', '');
    this._outcomeBannerEl.appendChild(this._outcomeMainEl);
    this._outcomeBannerEl.appendChild(this._outcomeSubEl);
    this._root.appendChild(this._outcomeBannerEl);
  }

  _buildTopRightCluster() {
    const cluster = el('div', 'ef-topright-cluster');

    // Compact Wind Chip
    const wind = el('section', 'ef-card ef-wind-chip');
    wind.setAttribute('aria-label', 'Wind Vector');

    const dial = el('div', 'ef-wind-dial');
    this._windArrowEl = el('div', 'ef-wind-arrow');
    this._windArrowEl.appendChild(createWindArrowSvg());
    dial.appendChild(this._windArrowEl);
    wind.appendChild(dial);

    const meta = el('div', 'ef-wind-meta');
    meta.appendChild(el('div', 'ef-wind-label', 'WIND'));
    this._windValEl = el('div', 'ef-wind-val', 'E 12 KT');
    meta.appendChild(this._windValEl);
    wind.appendChild(meta);
    cluster.appendChild(wind);

    // Quick Audio Mute Icon Button
    this._audioBtn = el('button', 'ef-card ef-icon-btn');
    this._audioBtn.type = 'button';
    this._audioBtn.title = 'Toggle Audio (M)';
    this._audioBtn.setAttribute('aria-label', 'Toggle Audio');
    this._audioIconWrap = el('span', 'ef-icon-wrap');
    this._audioIconWrap.appendChild(createSpeakerSvg(false));
    this._audioBtn.appendChild(this._audioIconWrap);
    this._audioBtn.addEventListener('click', () => {
      if (this._callbacks.onToggleAudio) this._callbacks.onToggleAudio();
    });
    cluster.appendChild(this._audioBtn);

    // Quick Settings Gear Button
    this._settingsBtn = el('button', 'ef-card ef-icon-btn');
    this._settingsBtn.type = 'button';
    this._settingsBtn.title = 'Settings, Audio & Controls (ESC / ?)';
    this._settingsBtn.setAttribute('aria-label', 'Settings, Audio and Controls');
    const gearWrap = el('span', 'ef-icon-wrap');
    gearWrap.appendChild(createGearSvg());
    this._settingsBtn.appendChild(gearWrap);
    this._settingsBtn.addEventListener('click', () => {
      const open = this.toggleDrawer();
      if (this._callbacks.onOpenDrawer) this._callbacks.onOpenDrawer(open);
    });
    cluster.appendChild(this._settingsBtn);

    this._root.appendChild(cluster);
  }

  _buildTelemetryCard() {
    const card = el('section', 'ef-card ef-telemetry-card');
    card.setAttribute('aria-label', 'Flight Telemetry');

    const header = el('div', 'ef-telem-header');
    this._telemBadgeEl = el('span', 'ef-telem-badge', 'EF-07');
    header.appendChild(this._telemBadgeEl);

    const nums = el('div', 'ef-telem-nums');
    const spdWrap = el('span', 'ef-telem-inline');
    spdWrap.appendChild(el('span', 'ef-metric-label', 'SPD'));
    this._airspeedValEl = el('span', 'ef-metric-val', '158');
    spdWrap.appendChild(this._airspeedValEl);
    nums.appendChild(spdWrap);

    const altWrap = el('span', 'ef-telem-inline');
    altWrap.appendChild(el('span', 'ef-metric-label', 'ALT'));
    this._altitudeValEl = el('span', 'ef-metric-val', '047');
    altWrap.appendChild(this._altitudeValEl);
    altWrap.appendChild(el('span', 'ef-metric-unit', 'm'));
    nums.appendChild(altWrap);

    header.appendChild(nums);
    card.appendChild(header);

    // Water Tank Bar
    const tankRow = el('div', 'ef-bar-block');
    const tankHead = el('div', 'ef-bar-head');
    tankHead.appendChild(el('span', 'ef-bar-label', 'WATER TANK'));
    this._tankPctEl = el('span', 'ef-bar-pct is-tank', '100%');
    tankHead.appendChild(this._tankPctEl);
    tankRow.appendChild(tankHead);

    this._tankBarEl = el('div', 'ef-seg-bar is-tank');
    this._tankSegments = [];
    for (let i = 0; i < BAR_SEGMENTS; i++) {
      const seg = el('div', 'ef-seg is-filled');
      this._tankBarEl.appendChild(seg);
      this._tankSegments.push(seg);
    }
    tankRow.appendChild(this._tankBarEl);
    card.appendChild(tankRow);

    // Hull Integrity Bar (emerald -> amber <60% -> flashing red <30%)
    const hullRow = el('div', 'ef-bar-block');
    const hullHead = el('div', 'ef-bar-head');
    hullHead.appendChild(el('span', 'ef-bar-label', 'HULL'));
    this._hullPctEl = el('span', 'ef-bar-pct is-hull-ok', '100%');
    hullHead.appendChild(this._hullPctEl);
    hullRow.appendChild(hullHead);

    this._hullBarEl = el('div', 'ef-seg-bar is-hull-ok');
    this._hullSegments = [];
    for (let i = 0; i < BAR_SEGMENTS; i++) {
      const seg = el('div', 'ef-seg is-filled');
      this._hullBarEl.appendChild(seg);
      this._hullSegments.push(seg);
    }
    hullRow.appendChild(this._hullBarEl);
    card.appendChild(hullRow);

    this._root.appendChild(card);
  }

  _buildJitHint() {
    this._jitWrapEl = el('div', 'ef-jit-wrap');
    this._jitPillEl = el('div', 'ef-jit-pill is-hidden');
    this._jitDotEl = el('span', 'ef-jit-dot ef-hidden');
    this._jitTextEl = el('span', 'ef-jit-text', '');
    this._jitPillEl.appendChild(this._jitDotEl);
    this._jitPillEl.appendChild(this._jitTextEl);
    this._jitWrapEl.appendChild(this._jitPillEl);
    this._root.appendChild(this._jitWrapEl);
  }

  _buildLaunchOverlay() {
    const overlay = el('div', 'ef-launch-overlay ef-hidden');
    overlay.setAttribute('data-launch-overlay', 'true');
    overlay.setAttribute('aria-hidden', 'true');

    const card = el('section', 'ef-launch-card');
    card.setAttribute('aria-label', 'Ember Front Launch and Live Lobbies');

    // Header
    const head = el('div', 'ef-launch-head');
    const brand = el('div', 'ef-launch-brand');
    brand.appendChild(el('div', 'ef-launch-kicker', 'AERIAL FIRE RESPONSE UNIT'));
    const titleRow = el('div', 'ef-launch-title-row');
    titleRow.appendChild(el('h1', 'ef-launch-title', 'EMBER FRONT'));
    const verBadge = el('span', 'ef-launch-version', formatVersionLabel(this._appVersion));
    verBadge.setAttribute('data-app-version', this._appVersion);
    verBadge.title = `Release ${formatVersionLabel(this._appVersion)} (build ${String(this._buildHash).slice(0, 12)})`;
    this._launchVersionEl = verBadge;
    titleRow.appendChild(verBadge);
    brand.appendChild(titleRow);
    brand.appendChild(
      el('div', 'ef-launch-sub', 'Skim lakes to scoop · Drop at 25–50 m AGL · Protect cabins')
    );
    head.appendChild(brand);

    const closeBtn = el('button', 'ef-launch-close ef-hidden', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Resume flight');
    closeBtn.setAttribute('data-action', 'close-launch');
    closeBtn.addEventListener('click', () => {
      if (this._launchCanDismiss && !this._launchBusy) {
        this.showLaunchOverlay(false);
        if (this._callbacks.onCloseLaunch) this._callbacks.onCloseLaunch();
      }
    });
    this._launchCloseBtn = closeBtn;
    head.appendChild(closeBtn);
    card.appendChild(head);

    // Primary Mode Buttons: FLY SOLO & HOST LOBBY
    const primaryGrid = el('div', 'ef-launch-primary-grid');

    const soloBtn = el('button', 'ef-launch-btn is-solo');
    soloBtn.type = 'button';
    soloBtn.setAttribute('data-action', 'launch-solo');
    soloBtn.appendChild(el('span', 'ef-launch-btn-title', 'FLY SOLO'));
    soloBtn.appendChild(el('span', 'ef-launch-btn-sub', 'Instant local mission (offline)'));
    soloBtn.addEventListener('click', () => {
      if (this._launchBusy) return;
      if (this._callbacks.onLaunchSolo) {
        this._callbacks.onLaunchSolo();
      } else {
        this.showLaunchOverlay(false);
      }
    });
    this._launchSoloBtn = soloBtn;
    primaryGrid.appendChild(soloBtn);

    const hostBtn = el('button', 'ef-launch-btn is-host');
    hostBtn.type = 'button';
    hostBtn.setAttribute('data-action', 'launch-host');
    hostBtn.appendChild(el('span', 'ef-launch-btn-title', 'HOST LOBBY'));
    hostBtn.appendChild(el('span', 'ef-launch-btn-sub', 'Start live room · up to 100 pilots'));
    hostBtn.addEventListener('click', () => {
      if (this._launchBusy) return;
      if (this._callbacks.onHostLobby) {
        this._callbacks.onHostLobby();
      } else {
        this.showLaunchOverlay(false);
      }
    });
    this._launchHostBtn = hostBtn;
    primaryGrid.appendChild(hostBtn);

    card.appendChild(primaryGrid);

    // Live Lobbies Directory Section (high-contrast inset box + auto-refresh indicator)
    const lobbiesWrap = el('div', 'ef-launch-lobbies');
    const lobbiesHead = el('div', 'ef-launch-lobbies-head');

    const lobbiesMeta = el('div', 'ef-launch-lobbies-meta');
    lobbiesMeta.appendChild(el('span', 'ef-launch-lobbies-label', 'LIVE LOBBIES'));
    this._lobbiesCountEl = el('span', 'ef-launch-lobbies-count', '0');
    lobbiesMeta.appendChild(this._lobbiesCountEl);
    lobbiesHead.appendChild(lobbiesMeta);

    const lobbiesControls = el('div', 'ef-launch-lobbies-controls');
    const autoBadge = el('span', 'ef-launch-auto-badge');
    autoBadge.setAttribute('data-auto-refresh', '5s');
    autoBadge.appendChild(el('span', 'ef-live-dot'));
    this._lobbiesAutoTextEl = el('span', 'ef-launch-auto-text', 'AUTO-REFRESHING · 5s');
    autoBadge.appendChild(this._lobbiesAutoTextEl);
    this._lobbiesAutoEl = autoBadge;
    lobbiesControls.appendChild(autoBadge);

    this._lobbiesUpdatedEl = el('span', 'ef-launch-updated ef-hidden', '');
    lobbiesControls.appendChild(this._lobbiesUpdatedEl);

    const refreshBtn = el('button', 'ef-launch-refresh-btn', '↻');
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh live lobbies now';
    refreshBtn.setAttribute('data-action', 'refresh-lobbies');
    refreshBtn.setAttribute('aria-label', 'Refresh live lobbies');
    refreshBtn.addEventListener('click', () => {
      if (this._launchBusy) return;
      if (this._callbacks.onRefreshLobbies) this._callbacks.onRefreshLobbies();
    });
    this._launchRefreshBtn = refreshBtn;
    lobbiesControls.appendChild(refreshBtn);

    lobbiesHead.appendChild(lobbiesControls);
    lobbiesWrap.appendChild(lobbiesHead);

    this._lobbiesListEl = el('div', 'ef-launch-lobbies-list');
    lobbiesWrap.appendChild(this._lobbiesListEl);
    card.appendChild(lobbiesWrap);

    this._launchFooterEl = el('div', 'ef-launch-footer', 'Live DEMO FLIGHT active in background');
    card.appendChild(this._launchFooterEl);

    overlay.appendChild(card);
    this._launchEl = overlay;
    this._root.appendChild(overlay);
    this._renderLobbiesList();
  }

  /**
   * Shows or hides the sleek translucent launch & live lobby browser card over live DEMO FLIGHT.
   */
  showLaunchOverlay(visible, { lobbies, loading, error, canDismiss, statusText, autoRefreshSec } = {}) {
    const show = Boolean(visible);
    this._launchOpen = show;
    if (typeof canDismiss === 'boolean') {
      this._launchCanDismiss = canDismiss;
    }
    this._launchCloseBtn.classList.toggle('ef-hidden', !this._launchCanDismiss);

    if (lobbies !== undefined || loading !== undefined || error !== undefined || autoRefreshSec !== undefined) {
      this.setLobbies(lobbies !== undefined ? lobbies : this._lobbies, {
        loading: loading !== undefined ? Boolean(loading) : this._lobbiesLoading,
        error: error !== undefined ? error : this._lobbiesError,
        autoRefreshSec,
      });
    }
    if (typeof statusText === 'string') {
      this._launchFooterEl.textContent = statusText;
    } else if (!this._launchBusy) {
      this._launchFooterEl.textContent = this._launchCanDismiss
        ? 'Select a mode or press × to return to current flight'
        : 'Live DEMO FLIGHT active in background';
    }

    this._launchEl.classList.toggle('ef-hidden', !show);
    this._launchEl.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
      this._setJitHint(null, '');
    }
  }

  isLaunchOverlayOpen() {
    return this._launchOpen;
  }

  /**
   * Updates the Live Lobbies list shown inside the Launch Overlay (strictly DOM textContent).
   * Preserves existing rows during background auto-refreshes to prevent list flicker.
   */
  setLobbies(lobbies, { loading = false, error = null, autoRefreshSec = 5, updatedAt = null } = {}) {
    const isLoading = Boolean(loading);
    const hasIncoming = Array.isArray(lobbies);
    if (!isLoading) {
      this._lobbies = hasIncoming ? lobbies.slice(0, 20) : [];
      this._hasLoadedLobbies = true;
    } else if (hasIncoming && (lobbies.length > 0 || !this._hasLoadedLobbies)) {
      this._lobbies = lobbies.slice(0, 20);
    }

    this._lobbiesLoading = isLoading;
    this._lobbiesError = error ? String(error) : null;

    if (this._lobbiesAutoEl && this._lobbiesAutoTextEl) {
      const sec = Math.max(1, Math.round(Number(autoRefreshSec) || 5));
      this._lobbiesAutoEl.setAttribute('data-auto-refresh', `${sec}s`);
      this._lobbiesAutoEl.classList.toggle('is-syncing', isLoading);
      this._lobbiesAutoEl.classList.toggle('is-warn', Boolean(this._lobbiesError) && !isLoading);
      this._lobbiesAutoTextEl.textContent = isLoading
        ? 'SCANNING LIVE...'
        : this._lobbiesError
          ? `RETRYING · ${sec}s`
          : `AUTO-REFRESHING · ${sec}s`;
    }

    if (this._launchRefreshBtn) {
      this._launchRefreshBtn.classList.toggle('is-syncing', isLoading);
    }

    if (!isLoading && !this._lobbiesError && this._lobbiesUpdatedEl) {
      const ts = Number.isFinite(updatedAt) ? updatedAt : Date.now();
      this._lastLobbiesUpdatedAt = ts;
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      this._lobbiesUpdatedEl.textContent = `${hh}:${mm}:${ss}`;
      this._lobbiesUpdatedEl.classList.remove('ef-hidden');
    }

    this._renderLobbiesList();
  }

  /**
   * Disables/re-enables Launch Overlay action buttons during lobby create/join transitions.
   */
  setLaunchBusy(busyText = null) {
    const busy = Boolean(busyText);
    this._launchBusy = busy;
    this._launchSoloBtn.disabled = busy;
    this._launchHostBtn.disabled = busy;
    this._launchRefreshBtn.disabled = busy;
    if (busyText) {
      this._launchFooterEl.textContent = String(busyText);
    } else {
      this._launchFooterEl.textContent = this._launchCanDismiss
        ? 'Select a mode or press × to return to current flight'
        : 'Live DEMO FLIGHT active in background';
    }
    this._renderLobbiesList();
  }

  _renderLobbiesList() {
    if (!this._lobbiesListEl) return;
    this._lobbiesListEl.replaceChildren();
    this._lobbiesCountEl.textContent = String(this._lobbies.length);

    if (this._lobbiesLoading && this._lobbies.length === 0) {
      this._lobbiesListEl.appendChild(
        el('div', 'ef-lobby-empty', 'Scanning live airspace frequencies...')
      );
      return;
    }

    if (this._lobbiesError && this._lobbies.length === 0) {
      this._lobbiesListEl.appendChild(
        el('div', 'ef-lobby-empty is-error', this._lobbiesError)
      );
      return;
    }

    if (this._lobbies.length === 0) {
      this._lobbiesListEl.appendChild(
        el('div', 'ef-lobby-empty', 'No active lobbies yet — click HOST LOBBY to start one!')
      );
      return;
    }

    for (let i = 0; i < this._lobbies.length; i++) {
      const item = this._lobbies[i];
      if (!item) continue;
      const worldId = String(item.worldId || item.id || item.lobbyId || `lobby-${i + 1}`);
      const opIdx = Number.isInteger(item.opIndex) ? item.opIndex : null;
      const opFallback = opIdx !== null && OPERATIONS[opIdx] ? OPERATIONS[opIdx].name : 'Cinderpine Basin';
      const title = String(item.opName || item.title || item.name || opFallback);
      const hostRaw = item.hostCallsign || item.hostName || item.host || '';
      const hostText = hostRaw ? sanitizeCallsign(String(hostRaw), '') : '';
      const pilots = Math.max(0, Math.floor(item.pilotsCount ?? item.pilots ?? item.players ?? 1));
      const cap = Math.max(1, Math.floor(item.pilotsCap ?? item.cap ?? item.maxPilots ?? 100));
      const isFull = Boolean(item.full) || pilots >= cap;
      const codeLabel = String(item.code || item.shortId || worldId).slice(0, 18);

      const row = el('div', 'ef-lobby-row');
      const info = el('div', 'ef-lobby-info');
      info.appendChild(el('div', 'ef-lobby-name', title));

      const metaParts = [];
      if (hostText) metaParts.push(`HOST ${hostText}`);
      else metaParts.push(codeLabel);
      if (Number.isFinite(item.burningPct)) {
        metaParts.push(`FIRE ${item.burningPct.toFixed(0)}%`);
      }
      info.appendChild(el('div', 'ef-lobby-meta', metaParts.join(' · ')));
      row.appendChild(info);

      const right = el('div', 'ef-lobby-right');
      const pilotsChip = el('span', `ef-lobby-pilots${isFull ? ' is-full' : ''}`, `${pilots} / ${cap}`);
      right.appendChild(pilotsChip);

      const joinBtn = el('button', 'ef-lobby-join-btn', isFull ? 'FULL' : 'JOIN');
      joinBtn.type = 'button';
      joinBtn.disabled = isFull || this._launchBusy;
      joinBtn.setAttribute('data-action', 'join-lobby');
      joinBtn.setAttribute('data-world-id', worldId);
      joinBtn.addEventListener('click', () => {
        if (isFull || this._launchBusy) return;
        if (this._callbacks.onJoinLobby) {
          this._callbacks.onJoinLobby(worldId, item);
        } else {
          this.showLaunchOverlay(false);
        }
      });
      right.appendChild(joinBtn);

      row.appendChild(right);
      this._lobbiesListEl.appendChild(row);
    }
  }

  _buildCrashOverlay() {
    this._crashEl = el('div', 'ef-crash-banner ef-hidden');
    this._crashEl.setAttribute('aria-live', 'assertive');
    this._crashKickerEl = el('div', 'ef-crash-kicker', 'MAYDAY · EMERGENCY RESPAWN');
    this._crashTitleEl = el('div', 'ef-crash-title', 'AIRFRAME LOST — TERRAIN IMPACT');
    this._crashSubEl = el('div', 'ef-crash-sub', 'RESERVE TANKER INBOUND IN 3.5S');
    const barTrack = el('div', 'ef-crash-track');
    this._crashFillEl = el('div', 'ef-crash-fill');
    barTrack.appendChild(this._crashFillEl);

    this._crashEl.appendChild(this._crashKickerEl);
    this._crashEl.appendChild(this._crashTitleEl);
    this._crashEl.appendChild(this._crashSubEl);
    this._crashEl.appendChild(barTrack);
    this._root.appendChild(this._crashEl);
  }

  _triggerEdgeFlash(cls, durationMs = 700) {
    if (!this._flashEl) return;
    if (this._flashTimer) {
      clearTimeout(this._flashTimer);
      this._flashTimer = null;
    }
    this._flashEl.classList.remove('is-direct', 'is-partial', 'is-miss', 'is-damage', 'is-active');
    // Force clean restart if repeated rapidly
    void this._flashEl.offsetWidth;
    this._flashEl.classList.add(cls, 'is-active');
    this._flashTimer = setTimeout(() => {
      this._flashTimer = null;
      this._flashEl.classList.remove('is-active', 'is-direct', 'is-partial', 'is-miss', 'is-damage');
    }, durationMs);
  }

  _showCenterBanner(kindClass, mainText, subText = '', durationMs = OUTCOME_DISPLAY_MS) {
    if (this._outcomeHideTimer) {
      clearTimeout(this._outcomeHideTimer);
      this._outcomeHideTimer = null;
    }
    this._outcomeBannerEl.classList.remove(
      'is-hidden',
      'is-direct',
      'is-partial',
      'is-miss',
      'is-damage',
      'is-offline-notice'
    );
    this._outcomeBannerEl.classList.add(kindClass);
    if (kindClass === 'is-offline-notice') {
      this._outcomeBannerEl.setAttribute('data-fallback-notice', 'true');
    } else {
      this._outcomeBannerEl.removeAttribute('data-fallback-notice');
    }
    this._outcomeMainEl.textContent = mainText;
    if (subText) {
      this._outcomeSubEl.textContent = subText;
      this._outcomeSubEl.classList.remove('ef-hidden');
    } else {
      this._outcomeSubEl.textContent = '';
      this._outcomeSubEl.classList.add('ef-hidden');
    }

    this._outcomeHideTimer = setTimeout(() => {
      this._outcomeHideTimer = null;
      this._outcomeBannerEl.classList.add('is-hidden');
      this._outcomeBannerEl.removeAttribute('data-fallback-notice');
    }, durationMs);
  }

  /**
   * Displays the crisp post-drop Hit / Partial / Miss tactical feedback toast below the compass
   * for ~3.2s with subtle peripheral HUD glow.
   */
  showDropOutcome(outcomeObj) {
    if (!outcomeObj) return;
    const norm = String(outcomeObj.outcome || 'miss').toLowerCase();
    const cells = Math.max(0, Math.round(outcomeObj.cellsExtinguished ?? outcomeObj.cells ?? 0));
    const cooled = Math.max(0, Math.round(outcomeObj.cellsCooled ?? 0));
    const pts = Math.max(0, Math.round(outcomeObj.pointsAwarded ?? outcomeObj.pts ?? 0));
    const dropQuality = String(outcomeObj.dropQuality || 'optimal').toLowerCase();
    const isMistedHigh = dropQuality === 'misted_high';
    const releaseAgl = Number.isFinite(outcomeObj.releaseAgl) ? Math.round(outcomeObj.releaseAgl) : null;

    if (isMistedHigh) {
      const aglNote = releaseAgl ? `${releaseAgl}m AGL` : '> 58m AGL';
      if (norm === 'direct' || norm === 'hit' || norm === 'partial') {
        const cellWord = cells === 1 ? 'CELL' : 'CELLS';
        const impactText = cells > 0 ? `−${cells} ${cellWord}` : cooled > 0 ? `${cooled} COOLED` : 'WEAK MIST';
        const main = `◐ MISTED (TOO HIGH — FLY LOWER)  ${impactText}  •  +${pts} PTS`;
        this._showCenterBanner(
          'is-partial',
          main,
          `Released at ${aglNote} — descend to 25–50m AGL for full knockdown`,
          OUTCOME_DISPLAY_MS
        );
        this._triggerEdgeFlash('is-partial', 560);
      } else {
        this._showCenterBanner(
          'is-miss',
          '✕ MISTED (TOO HIGH — FLY LOWER)',
          `Water evaporated at ${aglNote} — descend to 25–50m AGL before dropping`,
          OUTCOME_DISPLAY_MS
        );
        this._triggerEdgeFlash('is-miss', 520);
      }
      return;
    }

    if (norm === 'direct' || norm === 'hit') {
      const cellWord = cells === 1 ? 'FIRE CELL' : 'FIRE CELLS';
      const impactText = cells > 0 ? `−${cells} ${cellWord}` : cooled > 0 ? `${cooled} COOLED` : 'TARGET HIT';
      const cabinSuffix = outcomeObj.cabinSaved ? '  •  CABIN SAVED' : '';
      const main = `✓ DIRECT HIT!  ${impactText}  •  +${pts} PTS${cabinSuffix}`;
      this._showCenterBanner('is-direct', main, '', OUTCOME_DISPLAY_MS);
      this._triggerEdgeFlash('is-direct', 780);
    } else if (norm === 'partial') {
      const cellWord = cells === 1 ? 'CELL' : 'CELLS';
      const impactText = cells > 0 ? `−${cells} ${cellWord}` : cooled > 0 ? `${cooled} COOLED` : 'EDGE HIT';
      const main = `◐ PARTIAL HIT  ${impactText}  •  +${pts} PTS`;
      this._showCenterBanner('is-partial', main, 'Adjust closer to the active fire head next pass', OUTCOME_DISPLAY_MS);
      this._triggerEdgeFlash('is-partial', 560);
    } else {
      const missType = String(outcomeObj.missType || 'none').toLowerCase();
      const distM = Number.isFinite(outcomeObj.missDistM) ? Math.round(outcomeObj.missDistM) : 0;
      const dir = outcomeObj.missDirCompass ? String(outcomeObj.missDirCompass).toUpperCase() : '';
      const loc = distM > 0 && dir
        ? ` (${distM}m ${dir})`
        : distM > 0
          ? ` (${distM}m)`
          : '';

      let headline = `✕ DROP MISSED — OFF TARGET${loc}`;
      let hint = 'Wait for green ON TARGET ground lock at 25–50m AGL';
      if (missType === 'overshot' || missType === 'overshoot') {
        headline = `✕ DROP MISSED — OVERSHOT FIRE HEAD${loc}`;
        hint = 'Release a beat earlier on your next pass';
      } else if (missType === 'short') {
        headline = `✕ DROP MISSED — SHORT OF FIRE HEAD${loc}`;
        hint = 'Hold release a beat longer over the flames';
      } else if (missType === 'wide') {
        headline = `✕ DROP MISSED — WIDE OF FIRE HEAD${loc}`;
        hint = 'Lead slightly upwind to compensate for drift';
      }
      this._showCenterBanner('is-miss', headline, hint, OUTCOME_DISPLAY_MS);
      this._triggerEdgeFlash('is-miss', 520);
    }
  }

  /**
   * Convenience passthrough to plot a lingering 6.5s Hit/Partial/Miss marker on the Tactical Map.
   */
  recordDropImpact(x, z, outcome, cellsExtinguished = 0) {
    if (this._tacticalMap) {
      this._tacticalMap.recordDropImpact(x, z, outcome, cellsExtinguished);
    }
  }

  /**
   * Triggers brief choppy scoop coaching hint when banking steeply on the water surface.
   */
  showScoopRoughHint(durationMs = 1800) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this._roughScoopUntilMs = Math.max(this._roughScoopUntilMs, nowMs + durationMs);
  }

  /**
   * Triggers brief red damage flash + caution toast when the plane takes hull damage
   * from a tree strike (`kind = 'tree'`) or low-altitude thermal heat (`kind = 'heat'`).
   */
  showDamageFlash(damage = 30, hp = 70, kind = 'tree') {
    const safeHp = Math.max(0, Math.round(hp));
    const dmg = Math.max(0, Math.round(damage));
    const k = String(kind || 'tree').toLowerCase();
    this._triggerEdgeFlash('is-damage', 680);
    if (safeHp > 0) {
      if (k === 'heat' || k === 'thermal') {
        this._showCenterBanner(
          'is-damage',
          `⚠ THERMAL HEAT  −${dmg}% HULL  •  INTEGRITY ${safeHp}%`,
          'Pull up — climb above 25m AGL out of the fire core!',
          1800
        );
      } else {
        this._showCenterBanner(
          'is-damage',
          `⚠ TREE STRIKE  −${dmg}% HULL  •  INTEGRITY ${safeHp}%`,
          'Pull up — clear the alpine treetops!',
          2000
        );
      }
    }
  }

  /**
   * Shows or updates the non-blocking crash respawn banner.
   */
  showCrashOverlay({ reason = 'terrain', crashTimer = 3.5, maxTimer = 3.5 } = {}) {
    const r = String(reason || 'terrain').toLowerCase();
    const label = r.includes('heat') || r.includes('thermal')
      ? 'THERMAL OVERLOAD'
      : r.includes('tree')
        ? 'TREE STRIKE'
        : 'TERRAIN IMPACT';
    const rem = Math.max(0, Number.isFinite(crashTimer) ? crashTimer : 0);
    const pct = Math.max(0, Math.min(100, (1 - rem / Math.max(0.1, maxTimer)) * 100));
    this._crashTitleEl.textContent = `AIRFRAME LOST — ${label}`;
    this._crashSubEl.textContent = `RESERVE TANKER INBOUND IN ${rem.toFixed(1)}S`;
    this._crashFillEl.style.width = `${pct.toFixed(1)}%`;
    this._crashEl.classList.remove('ef-hidden');
  }

  /**
   * Updates the auto-hiding VHF Aviation Radio Comms strip.
   * Shown ONLY while a transmission is active, then fades smoothly out ~2.5s after ending.
   */
  pushRadioTranscript({ speaker, freq, text, urgency, category, active = true, id, durationMs } = {}) {
    if (!this._radioEl) return;

    const accentClass = resolveRadioAccent(urgency, category);
    const isActive = active !== false;

    if (this._radioHideTimer) {
      clearTimeout(this._radioHideTimer);
      this._radioHideTimer = null;
    }
    if (this._radioSafetyTimer) {
      clearTimeout(this._radioSafetyTimer);
      this._radioSafetyTimer = null;
    }

    // Check if updating an existing active transmission by id (e.g. end event active: false)
    if (id && this._radioEntries.length > 0 && this._radioEntries[0].id === id) {
      this._radioEntries[0].active = isActive;
      if (text) this._radioEntries[0].text = String(text);
    } else if (text) {
      const entry = {
        id: id || `tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        speaker: speaker ? String(speaker).toUpperCase() : 'AIR ATTACK 1',
        freq: formatFreq(freq),
        text: String(text),
        accentClass,
        active: isActive,
      };
      this._radioEntries.unshift(entry);
      if (this._radioEntries.length > 2) {
        this._radioEntries.length = 2;
      }
    }

    if (freq) {
      this._radioFreqEl.textContent = formatFreq(freq);
    } else if (this._radioEntries[0]) {
      this._radioFreqEl.textContent = this._radioEntries[0].freq;
    }

    this._radioEl.classList.remove('is-hidden', 'is-urgent', 'is-direct', 'is-warn', 'is-info', 'is-neutral');
    const topAccent = this._radioEntries[0] ? this._radioEntries[0].accentClass : accentClass;
    this._radioEl.classList.add(topAccent);
    this._radioTxEl.classList.toggle('is-active', isActive);
    this._radioTxLabel.textContent = isActive ? 'TX' : 'END';

    this._renderRadioFeed();

    if (isActive) {
      // Safety auto-end in case caller sends only active:true without a closing event
      const maxWait = Math.max(3200, Math.min(9000, Number(durationMs) || RADIO_SAFETY_END_MS));
      this._radioSafetyTimer = setTimeout(() => {
        this._radioSafetyTimer = null;
        this._radioTxEl.classList.remove('is-active');
        this._radioTxLabel.textContent = 'END';
        this._scheduleRadioFadeOut();
      }, maxWait);
    } else {
      this._scheduleRadioFadeOut();
    }
  }

  _scheduleRadioFadeOut() {
    if (this._radioHideTimer) clearTimeout(this._radioHideTimer);
    this._radioHideTimer = setTimeout(() => {
      this._radioHideTimer = null;
      this._radioEl.classList.add('is-hidden');
      this._radioTxEl.classList.remove('is-active');
    }, RADIO_LINGER_MS);
  }

  _renderRadioFeed() {
    this._radioFeedEl.replaceChildren();
    for (let i = 0; i < this._radioEntries.length; i++) {
      const entry = this._radioEntries[i];
      const line = el('div', `ef-radio-line ${entry.accentClass}${i > 0 ? ' is-prev' : ''}`);
      line.appendChild(el('span', 'ef-radio-speaker', `[${entry.speaker}] `));
      line.appendChild(el('span', 'ef-radio-text', entry.text));
      this._radioFeedEl.appendChild(line);
    }
  }

  _spawnScoreToast(ev) {
    if (!ev || !ev.pts) return;
    while (this._toastAnchor.children.length >= MAX_ACTIVE_TOASTS) {
      this._toastAnchor.removeChild(this._toastAnchor.firstChild);
    }

    let cls = 'ef-score-toast';
    let text = `+${ev.pts}`;
    if (ev.kind === 'cabin') {
      cls += ' is-cabin';
      text = `+${ev.pts} CABIN SAVED`;
    } else if (ev.kind === 'assist') {
      cls += ' is-assist';
      text = `+${ev.pts} ASSIST`;
    }

    const toast = el('div', cls, text);
    this._toastAnchor.appendChild(toast);

    const timer = setTimeout(() => {
      this._toastTimers.delete(timer);
      toast.remove();
    }, 1280);
    this._toastTimers.add(timer);
  }

  _isTouchUiActive() {
    if (typeof document !== 'undefined' && document.body && document.body.classList.contains('touch-active')) {
      return true;
    }
    if (typeof window !== 'undefined') {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
      if (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) return true;
    }
    return false;
  }

  _setJitHint(variant, text, showDot = false) {
    this._jitPillEl.classList.remove(
      'is-hidden',
      'is-demo',
      'is-locked',
      'is-empty',
      'is-scoop',
      'is-warn',
      'is-controls',
      'is-danger'
    );
    if (!variant || !text) {
      this._jitPillEl.classList.add('is-hidden');
      return;
    }
    this._jitPillEl.classList.add(variant);
    this._jitDotEl.classList.toggle('ef-hidden', !showDot);
    this._jitTextEl.textContent = text;
  }

  update({
    aircraft,
    fireSnapshot,
    opConfig,
    netState,
    scoreEvents,
    terrain,
    projectFn,
    remotePlanes,
    settings,
    dropPreview,
    atmosphere,
  } = {}) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // 0. Cockpit Smoke Haze & Thermal Heat Vignettes
    const smokeDensity = clamp01(
      (atmosphere && typeof atmosphere.smokeDensity === 'number' ? atmosphere.smokeDensity : null) ??
        (aircraft && typeof aircraft.smokeDensity === 'number' ? aircraft.smokeDensity : 0)
    );
    const heatDanger = clamp01(
      (atmosphere && typeof atmosphere.heatDanger === 'number' ? atmosphere.heatDanger : null) ??
        (aircraft && typeof aircraft.heatDanger === 'number' ? aircraft.heatDanger : 0)
    );
    const turbulence = clamp01(
      (atmosphere && typeof atmosphere.turbulence === 'number' ? atmosphere.turbulence : null) ??
        (aircraft && typeof aircraft.turbulence === 'number' ? aircraft.turbulence : 0)
    );

    const targetSmokeOp = smokeDensity > 0.03 ? Math.min(0.78, Math.pow(smokeDensity, 0.85) * 0.78) : 0;
    const nextSmokeOp = this._smokeVis + (targetSmokeOp - this._smokeVis) * 0.22;
    if (Math.abs(nextSmokeOp - this._smokeVis) > 0.004 || (targetSmokeOp === 0 && this._smokeVis !== 0)) {
      this._smokeVis = targetSmokeOp === 0 && nextSmokeOp < 0.01 ? 0 : nextSmokeOp;
      this._smokeVignetteEl.style.opacity = this._smokeVis.toFixed(3);
    }
    this._smokeVignetteEl.classList.toggle('is-turbulent', turbulence > 0.25);

    const targetHeatOp = heatDanger > 0.05 ? Math.min(0.92, Math.pow(heatDanger, 0.78) * 0.92) : 0;
    const nextHeatOp = this._heatVis + (targetHeatOp - this._heatVis) * 0.26;
    if (Math.abs(nextHeatOp - this._heatVis) > 0.004 || (targetHeatOp === 0 && this._heatVis !== 0)) {
      this._heatVis = targetHeatOp === 0 && nextHeatOp < 0.01 ? 0 : nextHeatOp;
      this._heatVignetteEl.style.opacity = this._heatVis.toFixed(3);
    }
    this._heatVignetteEl.classList.toggle('is-active', heatDanger > 0.2);

    // 1. Compact Top-Left Operation & Solo / Host / Online / Offline Status Pill
    const status = (netState && netState.status) || 'live';
    const connStatus = resolveConnStatus(netState);
    const pilotsCount = Math.max(1, netState && typeof netState.pilotsCount === 'number' ? netState.pilotsCount : 1);
    const pilotsCap = (netState && netState.pilotsCap) || 100;
    const isHost = connStatus === 'host' || (connStatus === 'online' && status === 'host');

    this._airspacePill.classList.remove(
      'status-solo',
      'status-online',
      'status-host',
      'status-connecting',
      'status-offline-full',
      'status-offline-error'
    );
    this._airspacePill.setAttribute('data-conn-status', connStatus);

    if (connStatus === 'solo') {
      this._airspacePill.classList.add('status-solo');
      this._airspaceText.textContent = 'SOLO · LOCAL';
      this._airspacePill.title = 'Solo Local Mission — Open Settings to host a live co-op lobby';
    } else if (isHost) {
      this._airspacePill.classList.add('status-host');
      this._airspaceText.textContent = `HOST · ${pilotsCount}/${pilotsCap}`;
      this._airspacePill.title = `Hosting Live Lobby — ${pilotsCount}/${pilotsCap} pilots`;
    } else if (connStatus === 'online') {
      this._airspacePill.classList.add('status-online');
      this._airspaceText.textContent = `ONLINE · ${pilotsCount}/${pilotsCap}`;
      this._airspacePill.title = `Online — Live Shared Airspace (${pilotsCount}/${pilotsCap} pilots)`;
    } else if (connStatus === 'connecting') {
      this._airspacePill.classList.add('status-connecting');
      this._airspaceText.textContent = 'CONNECTING';
      this._airspacePill.title = 'Connecting to Live Shared Airspace...';
    } else if (connStatus === 'offline_full') {
      this._airspacePill.classList.add('status-offline-full');
      this._airspaceText.textContent = 'OFFLINE · FULL';
      this._airspacePill.title = 'Airspace Full (100/100) — Playing Offline Local Mission. Host a lobby or retry.';
    } else {
      this._airspacePill.classList.add('status-offline-error');
      this._airspaceText.textContent = 'OFFLINE · LOCAL';
      this._airspacePill.title = 'Live Airspace Unavailable — Playing Offline Local Mission.';
    }

    // One-shot ~5s JIT Fallback Notice whenever dropping into offline local fallback
    if (connStatus !== this._lastConnStatus) {
      if (connStatus === 'offline_full') {
        this._showCenterBanner(
          'is-offline-notice',
          'AIRSPACE FULL (100/100) — PLAYING OFFLINE • OPEN SETTINGS TO HOST OR RETRY',
          '',
          5200
        );
      } else if (connStatus === 'offline_error') {
        this._showCenterBanner(
          'is-offline-notice',
          'LIVE AIRSPACE UNAVAILABLE — PLAYING OFFLINE • OPEN SETTINGS TO RETRY',
          '',
          5200
        );
      }
      this._lastConnStatus = connStatus;
    }

    if (opConfig) {
      const idx = String(opConfig.index || 1).padStart(2, '0');
      const tot = String(opConfig.total || 5).padStart(2, '0');
      this._opCodeEl.textContent = `OP ${idx}/${tot}`;
      this._opTitleEl.textContent = opConfig.name || 'Cinderpine Basin';
    }

    if (fireSnapshot) {
      const alive = fireSnapshot.cabinsAlive ?? 0;
      const total = fireSnapshot.cabinsTotal ?? 0;
      const hasRisk = Boolean(fireSnapshot.atRiskTarget);
      this._opCabinsEl.textContent = `${alive}/${total}`;
      this._opCabinsEl.classList.toggle('is-risk', hasRisk);

      const burnPct = Number.isFinite(fireSnapshot.burningPct) ? fireSnapshot.burningPct : 0;
      this._opBurningEl.textContent = `${burnPct.toFixed(1)}%`;

      const scoreVal = Math.max(0, Math.floor(fireSnapshot.missionScore || 0));
      this._missionScoreValEl.textContent = String(scoreVal).padStart(6, '0');

      if (this._overlayType === 'intermission' && this._overlayCountdownEl) {
        const secs = Math.max(0, Math.ceil(fireSnapshot.intermissionTimer || 0));
        if (!this._overlayContained) {
          this._overlayCountdownEl.textContent = `REDEPLOYING SECTOR IN ${secs}S`;
        } else if (this._overlayNextOpName) {
          this._overlayCountdownEl.textContent = `NEXT: ${this._overlayNextOpName.toUpperCase()} IN ${secs}S`;
        } else {
          this._overlayCountdownEl.textContent = `NEXT OPERATION IN ${secs}S`;
        }
      }
    }

    // 2. Slim Compass Ribbon
    if (aircraft) {
      const hdg = normalizeDeg(aircraft.yawDeg || 0);
      const winHalf = (this._compassWindow.clientWidth || COMPASS_BASE_WIDTH) * 0.5;
      const tx = winHalf - (hdg + 180) * PX_PER_DEG;
      this._compassTape.style.transform = `translate3d(${tx.toFixed(1)}px, 0, 0)`;
      const displayHdg = Math.round(hdg) % 360;
      this._compassReadout.textContent = `${String(displayHdg).padStart(3, '0')}°`;
    }

    // 3. Compact Wind Vector Chip
    if (fireSnapshot) {
      const windDeg = fireSnapshot.windDirDeg ?? 90;
      const windKt = fireSnapshot.windSpeedKt ?? 12;
      const planeYaw = aircraft ? aircraft.yawDeg || 0 : 0;
      const relDeg = windDeg - planeYaw;
      if (!this._windAngleInit) {
        this._windVisualAngle = relDeg;
        this._windAngleInit = true;
      } else {
        this._windVisualAngle = shortestAngleStep(this._windVisualAngle, relDeg);
      }
      this._windArrowEl.style.transform = `rotate(${this._windVisualAngle.toFixed(1)}deg)`;
      this._windValEl.textContent = `${degToCardinal16(windDeg)} ${Math.round(windKt)} KT`;
    }

    // 4. Compact Flight Telemetry (SPD, ALT, TANK, HULL) + Crash Overlay + JIT Contextual Hint
    if (aircraft) {
      // Detect transition from Demo Flight -> Manual Flight to trigger brief 8s control hint
      const isAuto = Boolean(aircraft.autopilot);
      if (this._wasAutopilot && !isAuto) {
        this._manualHintUntilMs = nowMs + MANUAL_HINT_DURATION_MS;
      }
      this._wasAutopilot = isAuto;

      // Badge state
      this._telemBadgeEl.classList.remove('is-releasing', 'is-scoop', 'is-crashed');
      if (aircraft.crashed) {
        this._telemBadgeEl.textContent = 'DOWN';
        this._telemBadgeEl.classList.add('is-crashed');
      } else if (aircraft.scooping) {
        this._telemBadgeEl.textContent = 'SCOOPING';
        this._telemBadgeEl.classList.add('is-scoop');
      } else if (aircraft.releasing) {
        this._telemBadgeEl.textContent = 'DROPPING';
        this._telemBadgeEl.classList.add('is-releasing');
      } else {
        const isSoloMode = Boolean(
          netState && (netState.mode === 'solo' || netState.connStatus === 'solo' || netState.status === 'solo')
        );
        const rawCallsign =
          (aircraft && typeof aircraft.callsign === 'string' && aircraft.callsign.trim()) ||
          (settings && typeof settings.callsign === 'string' && settings.callsign.trim()) ||
          '';
        const slotId =
          typeof aircraft.slotId === 'number'
            ? aircraft.slotId
            : netState && typeof netState.localSlotId === 'number'
              ? netState.localSlotId
              : null;
        if (rawCallsign) {
          this._telemBadgeEl.textContent = sanitizeCallsign(rawCallsign, 'EF-07');
        } else if (!isSoloMode && slotId !== null) {
          this._telemBadgeEl.textContent = `EF-${String(slotId).padStart(2, '0')}`;
        } else {
          this._telemBadgeEl.textContent = 'EF-07';
        }
      }

      // Airspeed & AGL
      const spd = Math.max(0, Math.round(aircraft.speedKmh || 0));
      this._airspeedValEl.textContent = String(spd);
      this._airspeedValEl.classList.toggle('is-warn', Boolean(aircraft.stallWarn));

      const agl = Math.max(0, Math.round(aircraft.agl || 0));
      this._altitudeValEl.textContent = String(agl).padStart(3, '0');
      this._altitudeValEl.classList.toggle('is-scoop', Boolean(aircraft.scooping));
      this._altitudeValEl.classList.toggle('is-warn', agl < 14 && !aircraft.scooping && !aircraft.crashed);

      // Tank bar
      const tank = Math.max(0, Math.min(100, aircraft.tankPct ?? 0));
      this._tankPctEl.textContent = `${Math.round(tank)}%`;
      const tankFilled = Math.round((tank / 100) * BAR_SEGMENTS);
      this._tankBarEl.classList.toggle('is-releasing', Boolean(aircraft.releasing));
      this._tankBarEl.classList.toggle('is-scoop', Boolean(aircraft.scooping));
      this._tankBarEl.classList.toggle('is-empty', tank <= 0.5);
      for (let i = 0; i < BAR_SEGMENTS; i++) {
        this._tankSegments[i].classList.toggle('is-filled', i < tankFilled);
      }

      // Hull integrity bar (emerald >=60% -> amber <60% -> flashing red <30%)
      const maxHp = Math.max(1, aircraft.maxHp ?? 100);
      const hpRaw = aircraft.crashed ? 0 : (aircraft.hp ?? maxHp);
      const hullPct = Math.max(0, Math.min(100, (hpRaw / maxHp) * 100));

      // Auto-trigger brief red flash if HP dropped unexpectedly without explicit showDamageFlash call
      if (!aircraft.crashed && hullPct < this._lastHullHp - 5) {
        this._triggerEdgeFlash('is-damage', 600);
      }
      this._lastHullHp = hullPct;

      const hullState = hullPct < 30 ? 'is-hull-crit' : hullPct < 60 ? 'is-hull-warn' : 'is-hull-ok';
      this._hullPctEl.textContent = `${Math.round(hullPct)}%`;
      this._hullPctEl.classList.remove('is-hull-ok', 'is-hull-warn', 'is-hull-crit');
      this._hullPctEl.classList.add(hullState);
      this._hullBarEl.classList.remove('is-hull-ok', 'is-hull-warn', 'is-hull-crit');
      this._hullBarEl.classList.add(hullState);

      const hullFilled = Math.round((hullPct / 100) * BAR_SEGMENTS);
      for (let i = 0; i < BAR_SEGMENTS; i++) {
        this._hullSegments[i].classList.toggle('is-filled', i < hullFilled);
      }

      // Crash Respawn Overlay (auto-managed from aircraft.crashed)
      if (aircraft.crashed) {
        this.showCrashOverlay({
          reason: aircraft.crashReason || 'terrain',
          crashTimer: aircraft.crashTimer ?? 0,
          maxTimer: 3.5,
        });
      } else {
        this._crashEl.classList.add('ef-hidden');
      }

      // Single Prioritized Just-in-Time (JIT) Contextual Hint Pill
      const queueBanner = netState && netState.queueBanner ? netState.queueBanner : null;
      const idleCountdown = netState && netState.idleCountdown > 0 ? netState.idleCountdown : null;
      const onTarget = Boolean(dropPreview && (dropPreview.onTarget || (dropPreview.fireCellsInTarget > 0)));
      const nearDist = dropPreview && Number.isFinite(dropPreview.nearFireDistM) ? dropPreview.nearFireDistM : Infinity;
      const altZone = (dropPreview && dropPreview.altZone) || 'optimal';
      const aglDisplay = Math.max(0, Math.round((dropPreview && Number.isFinite(dropPreview.releaseAgl) ? dropPreview.releaseAgl : aircraft.agl) || 0));
      const isTouch = this._isTouchUiActive();
      const isRoughScoop = aircraft.scoopQuality === 'rough' || nowMs < this._roughScoopUntilMs;

      if (this._launchOpen || aircraft.crashed) {
        this._setJitHint(null, '');
      } else if (aircraft.outOfBounds) {
        this._setJitHint('is-warn', 'RETURNING TO BASIN AIRSPACE');
      } else if (queueBanner) {
        this._setJitHint('is-warn', queueBanner);
      } else if (idleCountdown !== null) {
        this._setJitHint('is-warn', `IDLE — RETURNING TO DEMO FLIGHT IN ${Math.ceil(idleCountdown)}S`);
      } else if (aircraft.autopilot) {
        this._setJitHint(
          'is-demo',
          isTouch ? 'DEMO FLIGHT — Tap to take control' : 'DEMO FLIGHT — Press any key to take control',
          true
        );
      } else if (heatDanger > 0.2 || (altZone === 'too_low' && (onTarget || nearDist < 95))) {
        this._setJitHint('is-danger', '▲ PULL UP — THERMAL HEAT');
      } else if (aircraft.scooping) {
        if (isRoughScoop) {
          this._setJitHint('is-warn', `〰 CHOPPY SCOOP (${Math.round(tank)}%) — LEVEL WINGS (< 16°)`);
        } else {
          this._setJitHint('is-scoop', `≈ SCOOPING LAKE — TANK ${Math.round(tank)}%`);
        }
      } else if (tank <= 0.5) {
        this._setJitHint('is-empty', '▼ TANK EMPTY — Skim the lake (< 9m AGL) to scoop water');
      } else if (tank > 0.5 && altZone === 'too_high' && (onTarget || nearDist < 135)) {
        this._setJitHint('is-warn', `▼ TOO HIGH (${aglDisplay}m) — DESCEND TO 25–50m`);
      } else if (tank > 0.5 && onTarget) {
        this._setJitHint(
          'is-locked',
          isTouch
            ? `◉ OPTIMAL DROP (${aglDisplay}m) — TAP DROP`
            : `◉ OPTIMAL DROP (${aglDisplay}m) — SPACE`
        );
      } else if (hullPct < 40) {
        this._setJitHint('is-danger', '⚠ HULL LOW — CLEAR TREETOPS');
      } else if (nowMs < this._manualHintUntilMs) {
        this._setJitHint(
          'is-controls',
          isTouch
            ? 'Left stick Steer · Right buttons Drop & Speed'
            : 'W/S Pitch · A/D Bank · Q/E Speed · SPACE Drop'
        );
      } else {
        this._setJitHint(null, '');
      }
    }

    // 5. Score Micro-Toasts (strictly local manual pilot; never spam unseated spectators)
    if (Array.isArray(scoreEvents) && scoreEvents.length > 0) {
      const localSlot =
        netState && (netState.mode === 'solo' || netState.connStatus === 'solo' || netState.status === 'solo')
          ? 0
          : netState && typeof netState.localSlotId === 'number'
            ? netState.localSlotId
            : null;
      if (localSlot !== null && !aircraft?.autopilot) {
        for (let i = 0; i < scoreEvents.length; i++) {
          const ev = scoreEvents[i];
          if (ev && ev.slotId === localSlot) {
            this._spawnScoreToast(ev);
          }
        }
      }
    }

    // 6. Tactical Map (with live drop footprint + lingering hit/miss ripples)
    if (terrain) {
      this._tacticalMap.update({ terrain, aircraft, fireSnapshot, remotePlanes, dropPreview });
    }

    // 7. World Callout Pins
    if (terrain && projectFn) {
      this._callouts.update({ terrain, aircraft, fireSnapshot, projectFn });
    }

    // 8. Drawer live state
    this._drawer.update({ opConfig, netState, settings });
  }

  showOverlay(type, data = {}) {
    this._overlayType = type || null;
    this._overlayCountdownEl = null;
    this._overlayEl.replaceChildren();

    if (!type) {
      this._overlayEl.classList.add('ef-hidden');
      return;
    }

    const card = el('div', `ef-overlay-card is-${type}`);

    if (type === 'victory') {
      const opName = data.opName || 'Operation';
      const cabinsAlive = data.cabinsAlive ?? 0;
      const cabinsTotal = data.cabinsTotal ?? 10;
      const ratio = cabinsTotal > 0 ? cabinsAlive / cabinsTotal : 1;
      const stars =
        typeof data.stars === 'number'
          ? data.stars
          : cabinsAlive === cabinsTotal
            ? 3
            : ratio >= 0.8
              ? 2
              : 1;
      const score = String(Math.max(0, Math.floor(data.missionScore || 0))).padStart(6, '0');

      card.appendChild(el('div', 'ef-overlay-kicker', 'FIRE CONTAINED · OPERATION COMPLETE'));
      card.appendChild(el('h2', 'ef-overlay-heading', opName));
      card.appendChild(el('p', 'ef-overlay-sub', 'All active fire fronts and ember spots extinguished.'));

      const starsRow = el('div', 'ef-stars-row');
      starsRow.setAttribute('aria-label', `${stars} out of 3 stars`);
      for (let i = 1; i <= 3; i++) {
        starsRow.appendChild(el('span', `ef-star${i <= stars ? ' is-earned' : ''}`, '★'));
      }
      card.appendChild(starsRow);

      const stats = el('div', 'ef-overlay-stats');
      this._appendOverlayStat(stats, 'SQUADRON SCORE', score);
      this._appendOverlayStat(stats, 'CABINS SAVED', `${cabinsAlive} / ${cabinsTotal}`);
      this._appendOverlayStat(stats, 'ACTIVE FIRE', '0.0%');
      card.appendChild(stats);

      const actions = el('div', 'ef-overlay-actions');
      const replayBtn = el('button', 'ef-btn-secondary', 'REPLAY');
      replayBtn.type = 'button';
      replayBtn.addEventListener('click', () => {
        if (this._callbacks.onReplay) this._callbacks.onReplay();
      });
      actions.appendChild(replayBtn);

      if (data.hasNext !== false) {
        const nextBtn = el('button', 'ef-btn-primary', 'NEXT OPERATION');
        nextBtn.type = 'button';
        nextBtn.addEventListener('click', () => {
          if (this._callbacks.onNextOperation) this._callbacks.onNextOperation();
        });
        actions.appendChild(nextBtn);
      }
      card.appendChild(actions);
    } else if (type === 'defeat') {
      const opName = data.opName || 'Operation';
      const score = String(Math.max(0, Math.floor(data.missionScore || 0))).padStart(6, '0');
      const burnPct = Number.isFinite(data.burningPct) ? `${data.burningPct.toFixed(1)}%` : '—';

      card.appendChild(el('div', 'ef-overlay-kicker', 'SECTOR LOST'));
      card.appendChild(el('h2', 'ef-overlay-heading', 'SETTLEMENT OVERRUN'));
      card.appendChild(el('p', 'ef-overlay-sub', `All timber cabins in ${opName} were lost to wildfire.`));

      const stats = el('div', 'ef-overlay-stats');
      this._appendOverlayStat(stats, 'SQUADRON SCORE', score);
      this._appendOverlayStat(stats, 'CABINS INTACT', `0 / ${data.cabinsTotal ?? 10}`);
      this._appendOverlayStat(stats, 'BURNING', burnPct);
      card.appendChild(stats);

      const actions = el('div', 'ef-overlay-actions');
      const retryBtn = el('button', 'ef-btn-primary', 'REDEPLOY');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => {
        if (this._callbacks.onReplay) this._callbacks.onReplay();
      });
      actions.appendChild(retryBtn);
      card.appendChild(actions);
    } else if (type === 'intermission') {
      const contained = data.contained !== false;
      const opName = data.opName || 'Active Sector';
      const nextOpName =
        typeof data.nextOpName === 'string' && data.nextOpName.trim() ? data.nextOpName.trim() : '';
      const countdown = Math.max(0, Math.ceil(data.intermissionTimer ?? 12));
      const score = String(Math.max(0, Math.floor(data.missionScore || 0))).padStart(6, '0');

      this._overlayContained = contained;
      this._overlayNextOpName = nextOpName;

      card.appendChild(
        el('div', 'ef-overlay-kicker', contained ? 'FIRE CONTAINED · ADVANCING SECTOR' : 'SECTOR OVERRUN · REDEPLOYING')
      );
      card.appendChild(el('h2', 'ef-overlay-heading', opName));
      const countdownText = !contained
        ? `REDEPLOYING SECTOR IN ${countdown}S`
        : nextOpName
          ? `NEXT: ${nextOpName.toUpperCase()} IN ${countdown}S`
          : `NEXT OPERATION IN ${countdown}S`;
      this._overlayCountdownEl = el('p', 'ef-overlay-sub', countdownText);
      card.appendChild(this._overlayCountdownEl);

      const stats = el('div', 'ef-overlay-stats');
      this._appendOverlayStat(stats, 'SQUADRON SCORE', score);
      this._appendOverlayStat(stats, 'BONUS', contained ? '+1000' : '+0');
      this._appendOverlayStat(stats, 'CABINS INTACT', `${data.cabinsAlive ?? 0} / ${data.cabinsTotal ?? 10}`);
      card.appendChild(stats);

      const top10 = Array.isArray(data.top10) ? data.top10 : [];
      if (top10.length > 0) {
        const contribWrap = el('div', 'ef-overlay-contrib');
        const list = el('div', 'ef-lb-list');
        const count = Math.min(10, top10.length);
        for (let i = 0; i < count; i++) {
          const entry = top10[i];
          const isLocal = data.localSlotId !== undefined && data.localSlotId !== null && entry.slotId === data.localSlotId;
          const row = el('div', `ef-lb-row${isLocal ? ' is-local' : ''}`);
          row.appendChild(el('span', 'ef-lb-rank', `#${i + 1}`));
          const dot = el('span', 'ef-lb-dot');
          const liv = LIVERIES[(entry.colorIdx || 0) % LIVERIES.length] || LIVERIES[0];
          dot.style.backgroundColor = liv ? liv.hudColor : '#f8ce64';
          row.appendChild(dot);
          const safeName = sanitizeCallsign(entry.name || '', `EF-${String(entry.slotId ?? 0).padStart(2, '0')}`);
          row.appendChild(el('span', 'ef-lb-name', safeName));
          row.appendChild(el('span', 'ef-lb-slot', `EF-${String(entry.slotId ?? 0).padStart(2, '0')}`));
          row.appendChild(el('span', 'ef-lb-score', String(Math.max(0, Math.floor(entry.score || 0))).padStart(6, '0')));
          list.appendChild(row);
        }
        contribWrap.appendChild(list);
        card.appendChild(contribWrap);
      }

      const canAdvance =
        typeof data.canAdvance === 'boolean'
          ? data.canAdvance
          : this._lastConnStatus === 'solo' ||
            this._lastConnStatus === 'host' ||
            this._lastConnStatus === 'offline_full' ||
            this._lastConnStatus === 'offline_error';
      if (contained && canAdvance && this._callbacks.onNextOperation) {
        const actions = el('div', 'ef-overlay-actions');
        const nextBtn = el(
          'button',
          'ef-btn-primary',
          nextOpName ? `NEXT: ${nextOpName.toUpperCase()}` : 'NEXT OPERATION'
        );
        nextBtn.type = 'button';
        nextBtn.setAttribute('data-action', 'next-operation');
        nextBtn.addEventListener('click', () => {
          if (this._callbacks.onNextOperation) this._callbacks.onNextOperation();
        });
        actions.appendChild(nextBtn);
        card.appendChild(actions);
      }
    } else if (type === 'offline') {
      card.appendChild(el('div', 'ef-overlay-kicker', 'AIRSPACE LINK PAUSED'));
      card.appendChild(el('h2', 'ef-overlay-heading', 'LIVE AIRSPACE DISCONNECTED'));
      card.appendChild(
        el(
          'p',
          'ef-overlay-sub',
          data.message || 'Your connection was paused after extended idle time or network interruption.'
        )
      );

      const actions = el('div', 'ef-overlay-actions');
      const resumeBtn = el('button', 'ef-btn-primary', 'RECONNECT AIRSPACE');
      resumeBtn.type = 'button';
      resumeBtn.addEventListener('click', () => {
        if (this._callbacks.onResumeLive) this._callbacks.onResumeLive();
      });
      actions.appendChild(resumeBtn);
      card.appendChild(actions);
    }

    this._overlayEl.appendChild(card);
    this._overlayEl.classList.remove('ef-hidden');
  }

  _appendOverlayStat(parent, label, value) {
    const box = el('div');
    box.appendChild(el('div', 'ef-overlay-stat-label', label));
    box.appendChild(el('div', 'ef-overlay-stat-val', value));
    parent.appendChild(box);
  }

  toggleDrawer(force) {
    const open = this._drawer.toggle(force);
    this._settingsBtn.classList.toggle('is-active', open);
    return open;
  }

  isDrawerOpen() {
    return this._drawer.isOpen();
  }

  setAudioMuted(muted) {
    this._audioMuted = Boolean(muted);
    this._audioBtn.classList.toggle('is-muted', this._audioMuted);
    this._audioBtn.setAttribute('aria-label', this._audioMuted ? 'Unmute Audio' : 'Mute Audio');
    this._audioIconWrap.replaceChildren(createSpeakerSvg(this._audioMuted));
    this._drawer.setAudioMuted(this._audioMuted);
  }

  dispose() {
    for (const timer of this._toastTimers) {
      clearTimeout(timer);
    }
    this._toastTimers.clear();
    if (this._outcomeHideTimer) clearTimeout(this._outcomeHideTimer);
    if (this._flashTimer) clearTimeout(this._flashTimer);
    if (this._radioHideTimer) clearTimeout(this._radioHideTimer);
    if (this._radioSafetyTimer) clearTimeout(this._radioSafetyTimer);
    this._tacticalMap.dispose();
    this._callouts.dispose();
    this._drawer.dispose();
    this._root.replaceChildren();
  }
}
