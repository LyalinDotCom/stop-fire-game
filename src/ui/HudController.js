// Main Native-Resolution Tactical HUD Orchestrator for EMBER FRONT
// Strictly uses DOM APIs and textContent (zero innerHTML, zero inline scripts).

import { LIVERIES } from '../config/liveries.js';
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
const COMPASS_BASE_WIDTH = 320;
const PX_PER_DEG = COMPASS_BASE_WIDTH / COMPASS_SPAN_DEG;
const MAX_ACTIVE_TOASTS = 6;

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

function createAircraftIconSvg() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.appendChild(
    svgEl('path', {
      d: 'M12 2L13.7 8.4L21 11.2V13.2L13.7 11.8L13.3 17.8L16.4 19.8V21.3L12 20.1L7.6 21.3V19.8L10.7 17.8L10.3 11.8L3 13.2V11.2L10.3 8.4L12 2Z',
    })
  );
  return svg;
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
  const svg = svgEl('svg', { viewBox: '0 0 24 24', class: 'ef-top-btn-icon', 'aria-hidden': 'true' });
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

export class HudController {
  constructor({
    onToggleAudio,
    onOpenDrawer,
    onSelectOperation,
    onSwitchMode,
    onSettingChange,
    onNextOperation,
    onReplay,
    onResumeLive,
  } = {}) {
    this._callbacks = {
      onToggleAudio,
      onOpenDrawer,
      onSelectOperation,
      onSwitchMode,
      onSettingChange,
      onNextOperation,
      onReplay,
      onResumeLive,
    };

    this._root =
      (typeof document !== 'undefined' && document.getElementById('hud-root')) ||
      this._createFallbackRoot();
    this._root.replaceChildren();

    this._audioMuted = false;
    this._windVisualAngle = 0;
    this._windAngleInit = false;
    this._overlayType = null;
    this._overlayCountdownEl = null;
    this._toastTimers = new Set();

    // 1. 3D-Projected World Callouts Layer (behind cards)
    this._callouts = new WorldCallouts();
    this._root.appendChild(this._callouts.el);

    // 2. Top Header Bar
    this._buildTopBar();

    // 3. Operation Briefing Card (top-left)
    this._buildOpCard();

    // 4. Scrolling Top-Center Compass Ribbon
    this._buildCompass();

    // 5. Top-Right Wind Vector Card
    this._buildWindCard();

    // 6. Bottom-Left Flight Telemetry Card
    this._buildTelemetryCard();

    // 7. Bottom-Center Demo Flight & Status Stack
    this._buildCenterStack();

    // 8. Bottom-Right Tactical Map
    this._tacticalMap = new TacticalMap();
    this._root.appendChild(this._tacticalMap.el);

    // 9. Bottom Controls & Mission Score Strip
    this._buildBottomBar();

    // 10. Slide-Over [?] Settings & Squadron Drawer
    this._drawer = new SettingsDrawer({
      onSelectOperation: (opId) => {
        if (this._callbacks.onSelectOperation) this._callbacks.onSelectOperation(opId);
      },
      onSwitchMode: (mode) => {
        if (this._callbacks.onSwitchMode) this._callbacks.onSwitchMode(mode);
      },
      onSettingChange: (key, val) => {
        if (this._callbacks.onSettingChange) this._callbacks.onSettingChange(key, val);
      },
      onClose: () => {
        this._helpBtn.classList.remove('is-active');
      },
    });
    this._root.appendChild(this._drawer.backdropEl);
    this._root.appendChild(this._drawer.drawerEl);

    // 11. Mission Overlay container (Victory / Defeat / Intermission / Offline)
    this._overlayEl = el('div', 'ef-overlay ef-hidden');
    this._root.appendChild(this._overlayEl);
  }

  _createFallbackRoot() {
    const div = document.createElement('div');
    div.id = 'hud-root';
    document.body.appendChild(div);
    return div;
  }

  _buildTopBar() {
    const bar = el('header', 'ef-topbar');

    // Left brand cluster
    const brand = el('div', 'ef-brand');
    const badge = el('div', 'ef-brand-badge');
    badge.appendChild(createAircraftIconSvg());
    brand.appendChild(badge);

    const title = el('div', 'ef-brand-title');
    title.appendChild(el('span', 'ef-brand-ember', 'EMBER'));
    title.appendChild(el('span', 'ef-brand-front', 'FRONT'));
    brand.appendChild(title);

    brand.appendChild(el('div', 'ef-brand-divider'));

    const unit = el('div', 'ef-brand-unit');
    unit.appendChild(el('span', null, 'AERIAL FIRE'));
    unit.appendChild(el('span', null, 'RESPONSE UNIT'));
    brand.appendChild(unit);

    bar.appendChild(brand);

    // Right status & action cluster
    const right = el('div', 'ef-topbar-right');

    this._statusPill = el('div', 'ef-status-pill');
    this._statusDot = el('span', 'ef-status-dot');
    this._statusText = el('span', null, 'LIVE SIMULATION');
    this._statusPill.appendChild(this._statusDot);
    this._statusPill.appendChild(this._statusText);
    right.appendChild(this._statusPill);

    this._pilotsPill = el('div', 'ef-pilots-pill ef-hidden', 'PILOTS 1/100');
    right.appendChild(this._pilotsPill);

    this._audioBtn = el('button', 'ef-top-btn');
    this._audioBtn.type = 'button';
    this._audioBtn.setAttribute('aria-label', 'Toggle Audio');
    this._audioIconWrap = el('span');
    this._audioIconWrap.style.display = 'inline-flex';
    this._audioIconWrap.appendChild(createSpeakerSvg(false));
    this._audioLabel = el('span', null, 'AUDIO ON');
    this._audioBtn.appendChild(this._audioIconWrap);
    this._audioBtn.appendChild(this._audioLabel);
    this._audioBtn.addEventListener('click', () => {
      if (this._callbacks.onToggleAudio) this._callbacks.onToggleAudio();
    });
    right.appendChild(this._audioBtn);

    this._helpBtn = el('button', 'ef-top-btn ef-help-btn', '?');
    this._helpBtn.type = 'button';
    this._helpBtn.setAttribute('aria-label', 'Operations, Controls and Squadron Menu');
    this._helpBtn.addEventListener('click', () => {
      const open = this.toggleDrawer();
      if (this._callbacks.onOpenDrawer) this._callbacks.onOpenDrawer(open);
    });
    right.appendChild(this._helpBtn);

    bar.appendChild(right);
    this._root.appendChild(bar);
  }

  _buildOpCard() {
    const card = el('section', 'ef-card ef-op-card');
    card.setAttribute('aria-label', 'Operation Briefing');

    const kicker = el('div', 'ef-op-kicker');
    const dots = el('div', 'ef-op-dots');
    dots.appendChild(el('span'));
    dots.appendChild(el('span'));
    dots.appendChild(el('span'));
    kicker.appendChild(dots);

    this._opCodeEl = el('div', 'ef-op-code', 'OPERATION 01 / 05');
    kicker.appendChild(this._opCodeEl);
    card.appendChild(kicker);

    this._opTitleEl = el('div', 'ef-op-title', 'Cinderpine Basin');
    card.appendChild(this._opTitleEl);

    this._opSubtitleEl = el('div', 'ef-op-subtitle', 'Scoop the lake. Drop on the fire head.');
    card.appendChild(this._opSubtitleEl);

    card.appendChild(el('div', 'ef-op-divider'));

    const stats = el('div', 'ef-op-stats');

    const cabinStat = el('div', 'ef-op-stat');
    cabinStat.appendChild(el('span', 'ef-op-stat-label', 'CABINS'));
    this._opCabinsEl = el('span', 'ef-op-stat-val', '10 / 10');
    cabinStat.appendChild(this._opCabinsEl);
    stats.appendChild(cabinStat);

    const fireStat = el('div', 'ef-op-stat');
    fireStat.appendChild(el('span', 'ef-op-stat-label', 'BURNING'));
    this._opBurningEl = el('span', 'ef-op-stat-val is-fire', '8.0%');
    fireStat.appendChild(this._opBurningEl);
    stats.appendChild(fireStat);

    card.appendChild(stats);
    this._root.appendChild(card);
  }

  _buildCompass() {
    const wrap = el('div', 'ef-compass-wrap');
    wrap.setAttribute('aria-label', 'Heading Compass');

    const win = el('div', 'ef-compass-window');
    win.appendChild(el('div', 'ef-compass-pointer'));

    const tape = el('div', 'ef-compass-tape');
    // Cover -180 to +540 deg so 0..360 headings never run off tape edges
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

  _buildWindCard() {
    const card = el('section', 'ef-card ef-wind-card');
    card.setAttribute('aria-label', 'Wind Vector');

    const dial = el('div', 'ef-wind-dial');
    this._windArrowEl = el('div', 'ef-wind-arrow');
    this._windArrowEl.appendChild(createWindArrowSvg());
    dial.appendChild(this._windArrowEl);
    card.appendChild(dial);

    const meta = el('div', 'ef-wind-meta');
    meta.appendChild(el('div', 'ef-wind-label', 'WIND VECTOR'));
    this._windValEl = el('div', 'ef-wind-val', 'E 12 KT');
    meta.appendChild(this._windValEl);
    card.appendChild(meta);

    this._root.appendChild(card);
  }

  _buildTelemetryCard() {
    const card = el('section', 'ef-card ef-telemetry-card');
    card.setAttribute('aria-label', 'Flight Telemetry');

    const header = el('div', 'ef-telem-header');
    header.appendChild(el('span', 'ef-telem-title', 'FLIGHT TELEMETRY'));
    this._telemBadgeEl = el('span', 'ef-telem-badge', 'EF-07');
    header.appendChild(this._telemBadgeEl);
    card.appendChild(header);

    const grid = el('div', 'ef-telem-grid');

    const speedMetric = el('div', 'ef-metric');
    speedMetric.appendChild(el('span', 'ef-metric-label', 'AIRSPEED'));
    const speedRow = el('div', 'ef-metric-readout');
    this._airspeedValEl = el('span', 'ef-metric-val', '158');
    speedRow.appendChild(this._airspeedValEl);
    speedRow.appendChild(el('span', 'ef-metric-unit', 'KM/H'));
    speedMetric.appendChild(speedRow);
    grid.appendChild(speedMetric);

    const altMetric = el('div', 'ef-metric');
    altMetric.appendChild(el('span', 'ef-metric-label', 'ALTITUDE'));
    const altRow = el('div', 'ef-metric-readout');
    this._altitudeValEl = el('span', 'ef-metric-val', '047');
    altRow.appendChild(this._altitudeValEl);
    altRow.appendChild(el('span', 'ef-metric-unit', 'M AGL'));
    altMetric.appendChild(altRow);
    grid.appendChild(altMetric);

    card.appendChild(grid);

    const tankHeader = el('div', 'ef-tank-header');
    tankHeader.appendChild(el('span', 'ef-tank-label', 'WATER TANK'));
    this._tankPctEl = el('span', 'ef-tank-pct', '100%');
    tankHeader.appendChild(this._tankPctEl);
    card.appendChild(tankHeader);

    this._tankBarEl = el('div', 'ef-tank-bar');
    this._tankSegments = [];
    for (let i = 0; i < 20; i++) {
      const seg = el('div', 'ef-tank-seg is-filled');
      this._tankBarEl.appendChild(seg);
      this._tankSegments.push(seg);
    }
    card.appendChild(this._tankBarEl);

    this._root.appendChild(card);
  }

  _buildCenterStack() {
    const stack = el('div', 'ef-center-stack');

    this._boundaryNoticeEl = el('div', 'ef-notice-pill is-boundary ef-hidden', 'RETURNING TO BASIN');
    stack.appendChild(this._boundaryNoticeEl);

    this._queueNoticeEl = el('div', 'ef-notice-pill ef-hidden', '');
    stack.appendChild(this._queueNoticeEl);

    this._idleNoticeEl = el('div', 'ef-notice-pill ef-hidden', '');
    stack.appendChild(this._idleNoticeEl);

    this._demoBannerEl = el('div', 'ef-demo-banner');
    const pill = el('div', 'ef-demo-pill');
    pill.appendChild(el('span', 'ef-demo-dot'));
    pill.appendChild(el('span', null, 'DEMO FLIGHT'));
    this._demoBannerEl.appendChild(pill);
    this._demoBannerEl.appendChild(el('div', 'ef-demo-hint', 'Press any key to take control'));
    stack.appendChild(this._demoBannerEl);

    this._root.appendChild(stack);
  }

  _buildBottomBar() {
    const bar = el('footer', 'ef-bottombar');

    const controls = el('div', 'ef-controls-strip');
    const bindings = [
      [['W', 'S'], 'Pitch'],
      [['A', 'D'], 'Bank'],
      [['Q', 'E'], 'Throttle'],
      [['SPACE'], 'Drop water'],
    ];
    for (const [keys, label] of bindings) {
      const group = el('span', 'ef-ctrl-group');
      for (const k of keys) {
        group.appendChild(el('span', 'ef-key', k));
      }
      group.appendChild(el('span', null, label));
      controls.appendChild(group);
    }
    bar.appendChild(controls);

    const scoreCluster = el('div', 'ef-score-cluster');

    this._personalScoreBlock = el('div', 'ef-score-block ef-hidden');
    this._personalScoreBlock.appendChild(el('span', 'ef-score-label', 'YOU'));
    this._personalScoreValEl = el('span', 'ef-score-value is-personal', '000000');
    this._personalScoreBlock.appendChild(this._personalScoreValEl);
    scoreCluster.appendChild(this._personalScoreBlock);

    this._scoreDividerEl = el('div', 'ef-score-divider ef-hidden');
    scoreCluster.appendChild(this._scoreDividerEl);

    const missionBlock = el('div', 'ef-score-block');
    missionBlock.appendChild(el('span', 'ef-score-label', 'MISSION SCORE'));
    this._missionScoreValEl = el('span', 'ef-score-value', '000000');
    missionBlock.appendChild(this._missionScoreValEl);
    scoreCluster.appendChild(missionBlock);

    this._toastAnchor = el('div', 'ef-toast-anchor');
    scoreCluster.appendChild(this._toastAnchor);

    bar.appendChild(scoreCluster);
    this._root.appendChild(bar);
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
  } = {}) {
    // 1. Top Bar Status & Pilot Count
    const mode = (netState && netState.mode) || 'solo';
    const status = (netState && netState.status) || 'solo';
    const isMp = mode === 'mp' || mode === 'loopback';

    this._statusPill.classList.remove('status-host', 'status-syncing', 'status-offline');
    if (status === 'host') {
      this._statusPill.classList.add('status-host');
      this._statusText.textContent = 'COMMAND HOST';
    } else if (status === 'syncing') {
      this._statusPill.classList.add('status-syncing');
      this._statusText.textContent = 'SYNCING COMMAND...';
    } else if (status === 'offline') {
      this._statusPill.classList.add('status-offline');
      this._statusText.textContent = 'OFFLINE SOLO';
    } else {
      this._statusText.textContent = 'LIVE SIMULATION';
    }

    if (isMp) {
      this._pilotsPill.classList.remove('ef-hidden');
      const count = netState.pilotsCount ?? 1;
      const cap = netState.pilotsCap ?? 100;
      this._pilotsPill.textContent = `PILOTS ${count}/${cap}`;
    } else {
      this._pilotsPill.classList.add('ef-hidden');
    }

    // 2. Operation Briefing Card
    if (opConfig) {
      const wave = (fireSnapshot && fireSnapshot.wave) || 1;
      if (opConfig.mode === 'megabasin' || isMp) {
        this._opCodeEl.textContent = `MEGA-BASIN · WAVE ${String(wave).padStart(2, '0')}`;
      } else {
        const idx = String(opConfig.index || 1).padStart(2, '0');
        const tot = String(opConfig.total || 5).padStart(2, '0');
        this._opCodeEl.textContent = `OPERATION ${idx} / ${tot}`;
      }
      this._opTitleEl.textContent = opConfig.name || 'Cinderpine Basin';
      this._opSubtitleEl.textContent = opConfig.subtitle || '';
    }

    if (fireSnapshot) {
      const alive = fireSnapshot.cabinsAlive ?? 0;
      const total = fireSnapshot.cabinsTotal ?? 0;
      const hasRisk = Boolean(fireSnapshot.atRiskTarget);
      this._opCabinsEl.textContent = `${alive} / ${total}`;
      this._opCabinsEl.classList.toggle('is-risk', hasRisk);

      const burnPct = Number.isFinite(fireSnapshot.burningPct) ? fireSnapshot.burningPct : 0;
      this._opBurningEl.textContent = `${burnPct.toFixed(1)}%`;

      // Live countdown update if intermission overlay is currently shown
      if (this._overlayType === 'intermission' && this._overlayCountdownEl) {
        const secs = Math.max(0, Math.ceil(fireSnapshot.intermissionTimer || 0));
        this._overlayCountdownEl.textContent = `NEXT WAVE IN ${secs}S`;
      }
    }

    // 3. Compass Ribbon
    if (aircraft) {
      const hdg = normalizeDeg(aircraft.yawDeg || 0);
      const winHalf = (this._compassWindow.clientWidth || COMPASS_BASE_WIDTH) * 0.5;
      const tx = winHalf - (hdg + 180) * PX_PER_DEG;
      this._compassTape.style.transform = `translate3d(${tx.toFixed(1)}px, 0, 0)`;
      const displayHdg = Math.round(hdg) % 360;
      this._compassReadout.textContent = `${String(displayHdg).padStart(3, '0')}°`;
    }

    // 4. Wind Vector Card (aircraft-relative: windHeadingDeg - planeHeadingDeg, UP = tailwind)
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

    // 5. Flight Telemetry Card
    if (aircraft) {
      this._telemBadgeEl.classList.remove('is-releasing', 'is-scoop');
      if (aircraft.scooping) {
        this._telemBadgeEl.textContent = 'SCOOP ACTIVE';
        this._telemBadgeEl.classList.add('is-scoop');
      } else if (aircraft.releasing) {
        this._telemBadgeEl.textContent = 'RELEASING';
        this._telemBadgeEl.classList.add('is-releasing');
      } else {
        const slotId =
          typeof aircraft.slotId === 'number'
            ? aircraft.slotId
            : netState && typeof netState.localSlotId === 'number'
              ? netState.localSlotId
              : null;
        this._telemBadgeEl.textContent =
          slotId !== null ? `EF-${String(slotId).padStart(2, '0')}` : 'EF-07';
      }

      const spd = Math.max(0, Math.round(aircraft.speedKmh || 0));
      this._airspeedValEl.textContent = String(spd);
      this._airspeedValEl.classList.toggle('is-warn', Boolean(aircraft.stallWarn));

      const agl = Math.max(0, Math.round(aircraft.agl || 0));
      this._altitudeValEl.textContent = String(agl).padStart(3, '0');
      this._altitudeValEl.classList.toggle('is-scoop', Boolean(aircraft.scooping));
      this._altitudeValEl.classList.toggle('is-warn', (aircraft.bounceTimer || 0) > 0);

      const tank = Math.max(0, Math.min(100, aircraft.tankPct || 0));
      this._tankPctEl.textContent = `${Math.round(tank)}%`;
      const filled = Math.round(tank / 5);
      this._tankBarEl.classList.toggle('is-releasing', Boolean(aircraft.releasing));
      this._tankBarEl.classList.toggle('is-scoop', Boolean(aircraft.scooping));
      for (let i = 0; i < 20; i++) {
        this._tankSegments[i].classList.toggle('is-filled', i < filled);
      }

      // 6. Demo Flight & Center Notices
      this._demoBannerEl.classList.toggle('ef-hidden', !aircraft.autopilot);
      this._boundaryNoticeEl.classList.toggle('ef-hidden', !aircraft.outOfBounds);
    }

    const queueBanner = netState && netState.queueBanner ? netState.queueBanner : null;
    if (queueBanner) {
      this._queueNoticeEl.textContent = queueBanner;
      this._queueNoticeEl.classList.remove('ef-hidden');
    } else {
      this._queueNoticeEl.classList.add('ef-hidden');
    }

    const idleCountdown = netState && netState.idleCountdown > 0 ? netState.idleCountdown : null;
    if (idleCountdown !== null) {
      this._idleNoticeEl.textContent = `IDLE — RETURNING TO DEMO FLIGHT IN ${Math.ceil(idleCountdown)}S`;
      this._idleNoticeEl.classList.remove('ef-hidden');
    } else {
      this._idleNoticeEl.classList.add('ef-hidden');
    }

    // 7. Bottom Strip Scores & Micro-Toasts
    const missionScore = fireSnapshot ? Math.max(0, Math.floor(fireSnapshot.missionScore || 0)) : 0;
    this._missionScoreValEl.textContent = String(missionScore).padStart(6, '0');

    if (isMp) {
      this._personalScoreBlock.classList.remove('ef-hidden');
      this._scoreDividerEl.classList.remove('ef-hidden');
      const personal = Math.max(0, Math.floor(netState.personalScore || 0));
      this._personalScoreValEl.textContent = String(personal).padStart(6, '0');
    } else {
      this._personalScoreBlock.classList.add('ef-hidden');
      this._scoreDividerEl.classList.add('ef-hidden');
    }

    if (Array.isArray(scoreEvents) && scoreEvents.length > 0) {
      const localSlot = netState && typeof netState.localSlotId === 'number' ? netState.localSlotId : null;
      for (let i = 0; i < scoreEvents.length; i++) {
        const ev = scoreEvents[i];
        if (!isMp || localSlot === null || ev.slotId === localSlot) {
          this._spawnScoreToast(ev);
        }
      }
    }

    // 8. Tactical Map
    if (terrain) {
      this._tacticalMap.update({ terrain, aircraft, fireSnapshot, remotePlanes });
    }

    // 9. World Callout Pins
    if (terrain && projectFn) {
      this._callouts.update({ terrain, aircraft, fireSnapshot, projectFn });
    }

    // 10. Drawer live state
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
      this._appendOverlayStat(stats, 'MISSION SCORE', score);
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

      card.appendChild(el('div', 'ef-overlay-kicker', 'OPERATION FAILED'));
      card.appendChild(el('h2', 'ef-overlay-heading', 'SETTLEMENT LOST'));
      card.appendChild(el('p', 'ef-overlay-sub', `All timber cabins in ${opName} were consumed by wildfire.`));

      const stats = el('div', 'ef-overlay-stats');
      this._appendOverlayStat(stats, 'MISSION SCORE', score);
      this._appendOverlayStat(stats, 'CABINS INTACT', `0 / ${data.cabinsTotal ?? 10}`);
      this._appendOverlayStat(stats, 'BURNING', burnPct);
      card.appendChild(stats);

      const actions = el('div', 'ef-overlay-actions');
      const retryBtn = el('button', 'ef-btn-primary', 'RETRY OPERATION');
      retryBtn.type = 'button';
      retryBtn.addEventListener('click', () => {
        if (this._callbacks.onReplay) this._callbacks.onReplay();
      });
      actions.appendChild(retryBtn);
      card.appendChild(actions);
    } else if (type === 'intermission') {
      const contained = data.contained !== false;
      const wave = data.wave || 1;
      const countdown = Math.max(0, Math.ceil(data.intermissionTimer ?? 15));
      const score = String(Math.max(0, Math.floor(data.missionScore || 0))).padStart(6, '0');

      card.appendChild(el('div', 'ef-overlay-kicker', `CASCADIA MEGA-BASIN · WAVE ${String(wave).padStart(2, '0')}`));
      card.appendChild(
        el('h2', 'ef-overlay-heading', contained ? 'BASIN CONTAINED' : 'BASIN OVERRUN — REGROUPING')
      );
      this._overlayCountdownEl = el('p', 'ef-overlay-sub', `NEXT WAVE IN ${countdown}S`);
      card.appendChild(this._overlayCountdownEl);

      const stats = el('div', 'ef-overlay-stats');
      this._appendOverlayStat(stats, 'SQUADRON SCORE', score);
      this._appendOverlayStat(stats, 'WAVE BONUS', contained ? '+1000' : '+0');
      this._appendOverlayStat(stats, 'CABINS INTACT', `${data.cabinsAlive ?? 0} / ${data.cabinsTotal ?? 44}`);
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
    } else if (type === 'offline') {
      card.appendChild(el('div', 'ef-overlay-kicker', 'SOCKET-SAVE MODE · CONNECTION PAUSED'));
      card.appendChild(el('h2', 'ef-overlay-heading', 'LIVE BASIN DISCONNECTED'));
      card.appendChild(
        el(
          'p',
          'ef-overlay-sub',
          data.message || 'Your connection was paused after extended idle time or network interruption.'
        )
      );

      const actions = el('div', 'ef-overlay-actions');
      const resumeBtn = el('button', 'ef-btn-primary', 'RESUME LIVE BASIN');
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
    this._helpBtn.classList.toggle('is-active', open);
    return open;
  }

  isDrawerOpen() {
    return this._drawer.isOpen();
  }

  setAudioMuted(muted) {
    this._audioMuted = Boolean(muted);
    this._audioBtn.classList.toggle('is-muted', this._audioMuted);
    this._audioLabel.textContent = this._audioMuted ? 'AUDIO OFF' : 'AUDIO ON';
    this._audioIconWrap.replaceChildren(createSpeakerSvg(this._audioMuted));
  }

  dispose() {
    for (const timer of this._toastTimers) {
      clearTimeout(timer);
    }
    this._toastTimers.clear();
    this._tacticalMap.dispose();
    this._callouts.dispose();
    this._drawer.dispose();
    this._root.replaceChildren();
  }
}
