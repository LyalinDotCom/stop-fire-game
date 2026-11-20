// Slide-over Settings, Audio Mixer, Controls, Pilot Profile & Live Squadron Drawer
// Strictly uses DOM APIs and textContent (zero innerHTML).
// Single-player mode removed: EMBER FRONT is always one live shared cooperative mission.

import { LIVERIES } from '../config/liveries.js';
import { OPERATIONS } from '../config/operations.js';

export const CALLSIGN_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,15}$/;
const CALLSIGN_STORAGE_KEY = 'emberfront.callsign';
const COLOR_STORAGE_KEY = 'emberfront.colorIdx';

export function sanitizeCallsign(raw, fallback = 'EF-07') {
  if (typeof raw !== 'string') return fallback;
  let cleaned = raw.replace(/[^A-Za-z0-9 _.'-]/g, '');
  cleaned = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  cleaned = cleaned.slice(0, 16).trimEnd();
  return CALLSIGN_RE.test(cleaned) ? cleaned : fallback;
}

function readStoredCallsign() {
  try {
    if (typeof localStorage === 'undefined') return 'EF-07';
    const raw = localStorage.getItem(CALLSIGN_STORAGE_KEY);
    return sanitizeCallsign(raw || 'EF-07', 'EF-07');
  } catch {
    return 'EF-07';
  }
}

function writeStoredCallsign(val) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CALLSIGN_STORAGE_KEY, val);
  } catch {
    // Ignore storage errors.
  }
}

function readStoredColorIdx() {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const n = Number.parseInt(localStorage.getItem(COLOR_STORAGE_KEY) || '0', 10);
    return Number.isInteger(n) && n >= 0 && n < LIVERIES.length ? n : 0;
  } catch {
    return 0;
  }
}

function writeStoredColorIdx(idx) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COLOR_STORAGE_KEY, String(idx));
  } catch {
    // Ignore storage errors.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function resolveConnStatus(netState) {
  if (!netState) return 'connecting';
  if (
    netState.connStatus === 'online' ||
    netState.connStatus === 'connecting' ||
    netState.connStatus === 'offline_full' ||
    netState.connStatus === 'offline_error'
  ) {
    return netState.connStatus;
  }
  if (netState.status === 'syncing') return 'connecting';
  if (netState.status === 'offline' || netState.offlineFallback) {
    const reason = String(netState.offlineReason || '').toLowerCase();
    return reason.includes('full') || reason.includes('100') ? 'offline_full' : 'offline_error';
  }
  if (netState.status === 'host' || netState.status === 'live') return 'online';
  return 'connecting';
}

export class SettingsDrawer {
  constructor({ onSettingChange, onClose } = {}) {
    this._onSettingChange = onSettingChange;
    this._onClose = onClose;

    this._open = false;
    this._activeTab = 'audio';
    this._lastLeaderboardKey = '';

    this._callsign = readStoredCallsign();
    this._colorIdx = readStoredColorIdx();

    // Backdrop
    this.backdropEl = el('div', 'ef-drawer-backdrop');
    this.backdropEl.addEventListener('click', () => this.toggle(false));

    // Drawer shell
    this.drawerEl = el('aside', 'ef-drawer');
    this.drawerEl.setAttribute('aria-label', 'Settings, Audio, Controls and Live Squadron');
    this.drawerEl.setAttribute('aria-hidden', 'true');

    // Header
    const head = el('div', 'ef-drawer-head');
    head.appendChild(el('div', 'ef-drawer-title', 'SETTINGS & AIRSPACE'));
    const closeBtn = el('button', 'ef-drawer-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.addEventListener('click', () => this.toggle(false));
    head.appendChild(closeBtn);
    this.drawerEl.appendChild(head);

    // Tabs
    const tabsBar = el('div', 'ef-drawer-tabs');
    tabsBar.setAttribute('role', 'tablist');
    this._tabButtons = {};
    this._tabPanels = {};

    const tabDefs = [
      ['audio', 'AUDIO & LIVE'],
      ['controls', 'CONTROLS'],
      ['squadron', 'PILOT & TOP 10'],
    ];

    for (const [id, label] of tabDefs) {
      const btn = el('button', `ef-drawer-tab${id === this._activeTab ? ' is-active' : ''}`, label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', id === this._activeTab ? 'true' : 'false');
      btn.addEventListener('click', () => this._selectTab(id));
      tabsBar.appendChild(btn);
      this._tabButtons[id] = btn;
    }
    this.drawerEl.appendChild(tabsBar);

    // Scrollable body
    const body = el('div', 'ef-drawer-body');
    this._audioControls = {};
    this._toggles = {};
    this._buildAudioAirspaceTab(body);
    this._buildControlsTab(body);
    this._buildSquadronTab(body);
    this.drawerEl.appendChild(body);
  }

  _selectTab(id) {
    this._activeTab = id;
    for (const [key, btn] of Object.entries(this._tabButtons)) {
      const active = key === id;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const [key, panel] of Object.entries(this._tabPanels)) {
      panel.classList.toggle('ef-hidden', key !== id);
    }
  }

  _buildAudioAirspaceTab(parent) {
    const panel = el('div', 'ef-drawer-section');
    this._tabPanels.audio = panel;

    // 1. Live Shared Airspace Status Card (zero Solo/MP mode switcher!)
    panel.appendChild(el('div', 'ef-section-heading', 'AIRSPACE CONNECTION'));
    const statusCard = el('div', 'ef-airspace-card');

    const topRow = el('div', 'ef-airspace-row');
    const stateBadge = el('span', 'ef-airspace-state status-connecting');
    this._airspaceDot = el('span', 'ef-status-dot');
    this._airspaceStateText = el('span', null, 'CONNECTING');
    stateBadge.appendChild(this._airspaceDot);
    stateBadge.appendChild(this._airspaceStateText);
    this._airspaceStateBadge = stateBadge;
    topRow.appendChild(stateBadge);

    this._airspacePilotsEl = el('span', 'ef-airspace-pilots', '1 / 100 PILOTS');
    topRow.appendChild(this._airspacePilotsEl);
    statusCard.appendChild(topRow);

    this._airspaceConnLine = el('div', 'ef-airspace-conn-line', 'CONNECTING — Joining Live Shared Airspace...');
    statusCard.appendChild(this._airspaceConnLine);

    this._retryLiveBtn = el('button', 'ef-retry-live-btn ef-hidden', 'RETRY LIVE');
    this._retryLiveBtn.type = 'button';
    this._retryLiveBtn.setAttribute('data-action', 'retry-live');
    this._retryLiveBtn.addEventListener('click', () => {
      if (this._onSettingChange) this._onSettingChange('retryLive', true);
    });
    statusCard.appendChild(this._retryLiveBtn);

    this._airspaceOpTitle = el('div', 'ef-airspace-op-title', 'OPERATION 01 / 05 · Cinderpine Basin');
    statusCard.appendChild(this._airspaceOpTitle);

    // 5-Sector progression strip (read-only indicator)
    const sectorStrip = el('div', 'ef-sector-strip');
    this._sectorPips = [];
    for (const op of OPERATIONS) {
      const pip = el('div', 'ef-sector-pip');
      pip.appendChild(el('span', 'ef-sector-num', `0${op.index}`));
      pip.appendChild(el('span', 'ef-sector-name', op.name.split(' ')[0]));
      sectorStrip.appendChild(pip);
      this._sectorPips.push({ id: op.id, index: op.index, el: pip });
    }
    statusCard.appendChild(sectorStrip);
    panel.appendChild(statusCard);

    // 2. Audio Mixer Controls
    panel.appendChild(el('div', 'ef-section-heading', 'AUDIO MIXER'));
    const mixer = el('div', 'ef-audio-mixer');

    // Master Audio toggle
    const masterRow = el('label', 'ef-toggle-row ef-audio-master-row');
    masterRow.appendChild(el('span', null, 'Master Audio (M)'));
    const masterCb = document.createElement('input');
    masterCb.type = 'checkbox';
    masterCb.checked = true;
    masterCb.addEventListener('change', () => {
      if (this._onSettingChange) this._onSettingChange('audioMuted', !masterCb.checked);
    });
    masterRow.appendChild(masterCb);
    mixer.appendChild(masterRow);
    this._audioControls.masterCb = masterCb;

    // Channel rows with toggle + slider
    const channels = [
      {
        label: 'Background Music',
        toggleKey: 'musicEnabled',
        volKey: 'musicVolume',
        defaultEnabled: true,
        defaultVol: 0.45,
      },
      {
        label: 'VHF Radio Comms',
        toggleKey: 'radioEnabled',
        volKey: 'radioVolume',
        defaultEnabled: true,
        defaultVol: 0.9,
      },
      {
        label: 'SFX & Engine',
        toggleKey: 'sfxEnabled',
        volKey: 'sfxVolume',
        defaultEnabled: true,
        defaultVol: 0.85,
      },
    ];

    for (const ch of channels) {
      const card = el('div', 'ef-audio-channel');

      const chHead = el('label', 'ef-audio-ch-head');
      chHead.appendChild(el('span', 'ef-audio-ch-label', ch.label));
      const rightCtrl = el('span', 'ef-audio-ch-right');
      const pctEl = el('span', 'ef-audio-pct', `${Math.round(ch.defaultVol * 100)}%`);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ch.defaultEnabled;
      cb.addEventListener('change', () => {
        if (this._onSettingChange) this._onSettingChange(ch.toggleKey, cb.checked);
      });
      rightCtrl.appendChild(pctEl);
      rightCtrl.appendChild(cb);
      chHead.appendChild(rightCtrl);
      card.appendChild(chHead);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'ef-slider';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.value = String(Math.round(ch.defaultVol * 100));
      slider.setAttribute('aria-label', `${ch.label} Volume`);
      slider.addEventListener('input', () => {
        const val = Number(slider.value) / 100;
        pctEl.textContent = `${slider.value}%`;
        if (this._onSettingChange) this._onSettingChange(ch.volKey, val);
      });
      // Prevent flight keys from stealing arrow/range focus
      slider.addEventListener('keydown', (ev) => ev.stopPropagation());
      card.appendChild(slider);

      mixer.appendChild(card);
      this._audioControls[ch.toggleKey] = cb;
      this._audioControls[ch.volKey] = { slider, pctEl };
    }

    panel.appendChild(mixer);
    parent.appendChild(panel);
  }

  _buildControlsTab(parent) {
    const panel = el('div', 'ef-drawer-section ef-hidden');
    this._tabPanels.controls = panel;

    panel.appendChild(el('div', 'ef-section-heading', 'FLIGHT PREFERENCES'));
    const toggleList = el('div', 'ef-toggle-list');
    const toggleDefs = [
      ['invertPitch', 'Invert Pitch (W = Nose Up / S = Nose Down)'],
      ['showDropReticle', 'Show 3D Ground Drop Corridor & Target Lock'],
      ['mouseYoke', 'Mouse-Yoke Steering (Opt-In)'],
    ];

    for (const [key, label] of toggleDefs) {
      const row = el('label', 'ef-toggle-row');
      row.appendChild(el('span', null, label));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = key === 'showDropReticle';
      cb.addEventListener('change', () => {
        if (this._onSettingChange) this._onSettingChange(key, cb.checked);
      });
      row.appendChild(cb);
      toggleList.appendChild(row);
      this._toggles[key] = cb;
    }
    panel.appendChild(toggleList);

    panel.appendChild(el('div', 'ef-section-heading', 'KEYBOARD CONTROLS'));
    const kbTable = el('div', 'ef-controls-table');
    const kbItems = [
      ['Pitch Nose Down / Up', 'W / S'],
      ['Bank Left / Right', 'A / D'],
      ['Throttle Down / Up', 'Q / E'],
      ['Release Water Curtain', 'SPACE'],
      ['Take Control from Demo', 'ANY FLIGHT KEY'],
      ['Toggle Master Audio', 'M'],
      ['Open / Close Settings', 'ESC or ?'],
    ];
    for (const [desc, keys] of kbItems) {
      const row = el('div', 'ef-control-item');
      row.appendChild(el('span', null, desc));
      row.appendChild(el('span', 'ef-control-keys', keys));
      kbTable.appendChild(row);
    }
    panel.appendChild(kbTable);

    panel.appendChild(el('div', 'ef-section-heading', 'GAMEPAD CONTROLS'));
    const gpTable = el('div', 'ef-controls-table');
    const gpItems = [
      ['Bank & Pitch', 'LEFT STICK'],
      ['Throttle Down / Up', 'LT / RT'],
      ['Drop Water', 'A / RB'],
    ];
    for (const [desc, keys] of gpItems) {
      const row = el('div', 'ef-control-item');
      row.appendChild(el('span', null, desc));
      row.appendChild(el('span', 'ef-control-keys', keys));
      gpTable.appendChild(row);
    }
    panel.appendChild(gpTable);

    panel.appendChild(el('div', 'ef-section-heading', 'AERIAL FIREFIGHTING BRIEF'));
    const tips = el(
      'div',
      'ef-tip-box',
      'Skim alpine lakes below 9 m AGL to scoop water (~1.4 s refill; water skimming is forgiving). Keep clear of treetops (30% hull strike) and ground impact (airframe loss). Wait for the emerald ON TARGET ground ring, press SPACE to extinguish the fire head, and carve dark-teal wet firebreaks ahead of cabins.'
    );
    panel.appendChild(tips);

    parent.appendChild(panel);
  }

  _buildSquadronTab(parent) {
    const panel = el('div', 'ef-drawer-section ef-hidden');
    this._tabPanels.squadron = panel;

    // 1. Callsign Input
    panel.appendChild(el('div', 'ef-section-heading', 'PILOT CALLSIGN'));
    const inputRow = el('div', 'ef-input-row');
    const input = el('input', 'ef-text-input');
    input.type = 'text';
    input.maxLength = 16;
    input.value = this._callsign;
    input.placeholder = 'EF-07';
    input.setAttribute('aria-label', 'Pilot Callsign');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        input.blur();
        return;
      }
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        this._commitCallsign(input.value);
        input.blur();
      }
    });
    input.addEventListener('keyup', (ev) => ev.stopPropagation());
    input.addEventListener('change', () => this._commitCallsign(input.value));
    input.addEventListener('blur', () => this._commitCallsign(input.value));

    this._callsignInput = input;
    inputRow.appendChild(input);
    panel.appendChild(inputRow);
    panel.appendChild(
      el('div', 'ef-input-hint', '1–16 ASCII chars (letters, digits, space, _ . \' -). Starts with A–Z or 0–9.')
    );

    // 2. 16-Swatch Forestry Livery Selector
    panel.appendChild(el('div', 'ef-section-heading', 'SQUADRON LIVERY (16 PALETTES)'));
    const liveryGrid = el('div', 'ef-livery-grid');
    this._swatchButtons = [];

    for (let i = 0; i < LIVERIES.length; i++) {
      const liv = LIVERIES[i];
      const sw = el('button', `ef-swatch-btn${i === this._colorIdx ? ' is-active' : ''}`);
      sw.type = 'button';
      sw.style.backgroundColor = liv.primary;
      sw.title = liv.name;
      sw.setAttribute('aria-label', `Livery ${liv.name}`);

      const accent = el('span', 'ef-swatch-accent');
      accent.style.backgroundColor = liv.accent;
      sw.appendChild(accent);

      sw.addEventListener('click', () => {
        this._colorIdx = i;
        writeStoredColorIdx(i);
        this._refreshLiverySelection();
        if (this._onSettingChange) this._onSettingChange('colorIdx', i);
      });

      liveryGrid.appendChild(sw);
      this._swatchButtons.push(sw);
    }
    panel.appendChild(liveryGrid);

    this._liveryCaption = el('div', 'ef-livery-caption', this._getLiveryCaption(this._colorIdx));
    panel.appendChild(this._liveryCaption);

    // 3. Live Squadron Top-10 Leaderboard
    panel.appendChild(el('div', 'ef-section-heading', 'LIVE SQUADRON ROSTER · TOP 10'));
    this._lbList = el('div', 'ef-lb-list');
    this._lbList.appendChild(
      el('div', 'ef-lb-empty', 'Take manual flight (any flight key) and hit the fire head to post your squadron score.')
    );
    panel.appendChild(this._lbList);

    parent.appendChild(panel);
  }

  _getLiveryCaption(idx) {
    const liv = LIVERIES[idx] || LIVERIES[0];
    return liv ? `ACTIVE: ${liv.name.toUpperCase()}` : 'ACTIVE: EF-07';
  }

  _refreshLiverySelection() {
    for (let i = 0; i < this._swatchButtons.length; i++) {
      this._swatchButtons[i].classList.toggle('is-active', i === this._colorIdx);
    }
    this._liveryCaption.textContent = this._getLiveryCaption(this._colorIdx);
  }

  _commitCallsign(raw) {
    const clean = sanitizeCallsign(raw, 'EF-07');
    this._callsign = clean;
    this._callsignInput.value = clean;
    writeStoredCallsign(clean);
    if (this._onSettingChange) this._onSettingChange('callsign', clean);
  }

  isOpen() {
    return this._open;
  }

  toggle(force) {
    const next = typeof force === 'boolean' ? force : !this._open;
    if (next === this._open) return this._open;
    this._open = next;
    this.drawerEl.classList.toggle('is-open', next);
    this.backdropEl.classList.toggle('is-open', next);
    this.drawerEl.setAttribute('aria-hidden', next ? 'false' : 'true');
    if (!next && this._onClose) {
      this._onClose();
    }
    return this._open;
  }

  setAudioMuted(muted) {
    if (this._audioControls.masterCb) {
      this._audioControls.masterCb.checked = !muted;
    }
  }

  update({ opConfig, netState, settings } = {}) {
    // 1. Online / Offline Airspace Connection Status
    const status = (netState && netState.status) || 'live';
    const connStatus = resolveConnStatus(netState);
    const pilotsCount = Math.max(1, netState && typeof netState.pilotsCount === 'number' ? netState.pilotsCount : 1);
    const pilotsCap = (netState && netState.pilotsCap) || 100;
    const isOffline = connStatus === 'offline_full' || connStatus === 'offline_error';

    this._airspaceStateBadge.classList.remove(
      'status-online',
      'status-host',
      'status-connecting',
      'status-offline-full',
      'status-offline-error'
    );
    this._airspaceStateBadge.setAttribute('data-conn-status', connStatus);

    if (connStatus === 'online') {
      this._airspaceStateBadge.classList.add('status-online');
      if (status === 'host') this._airspaceStateBadge.classList.add('status-host');
      this._airspaceStateText.textContent = status === 'host' ? 'ONLINE · HOST' : 'ONLINE';
      this._airspacePilotsEl.textContent = `${pilotsCount} / ${pilotsCap} PILOTS`;
      this._airspaceConnLine.textContent =
        status === 'host'
          ? 'ONLINE — Live Shared Airspace (Command Host)'
          : 'ONLINE — Live Shared Airspace';
    } else if (connStatus === 'connecting') {
      this._airspaceStateBadge.classList.add('status-connecting');
      this._airspaceStateText.textContent = 'CONNECTING';
      this._airspacePilotsEl.textContent = `— / ${pilotsCap}`;
      this._airspaceConnLine.textContent = 'CONNECTING — Joining Live Shared Airspace...';
    } else if (connStatus === 'offline_full') {
      this._airspaceStateBadge.classList.add('status-offline-full');
      this._airspaceStateText.textContent = 'OFFLINE · FULL';
      this._airspacePilotsEl.textContent = '100 / 100 FULL';
      this._airspaceConnLine.textContent = 'OFFLINE — Local Mission (Airspace full · Reload to reconnect)';
    } else {
      this._airspaceStateBadge.classList.add('status-offline-error');
      this._airspaceStateText.textContent = 'OFFLINE · LOCAL';
      this._airspacePilotsEl.textContent = 'LOCAL';
      this._airspaceConnLine.textContent = 'OFFLINE — Local Mission (Reload to reconnect)';
    }

    this._retryLiveBtn.classList.toggle('ef-hidden', !isOffline);

    if (opConfig) {
      const idx = String(opConfig.index || 1).padStart(2, '0');
      const tot = String(opConfig.total || 5).padStart(2, '0');
      this._airspaceOpTitle.textContent = `OPERATION ${idx} / ${tot} · ${opConfig.name || 'Cinderpine Basin'}`;
      for (let i = 0; i < this._sectorPips.length; i++) {
        const pip = this._sectorPips[i];
        const isCurrent = pip.id === opConfig.id || pip.index === opConfig.index;
        pip.el.classList.toggle('is-active', isCurrent);
      }
    }

    // 2. Sync settings controls without clobbering focused inputs/sliders
    if (settings) {
      if (typeof settings.audioMuted === 'boolean' && this._audioControls.masterCb) {
        this._audioControls.masterCb.checked = !settings.audioMuted;
      }
      if (typeof settings.musicEnabled === 'boolean' && this._audioControls.musicEnabled) {
        this._audioControls.musicEnabled.checked = settings.musicEnabled;
      }
      if (typeof settings.radioEnabled === 'boolean' && this._audioControls.radioEnabled) {
        this._audioControls.radioEnabled.checked = settings.radioEnabled;
      }
      if (typeof settings.sfxEnabled === 'boolean' && this._audioControls.sfxEnabled) {
        this._audioControls.sfxEnabled.checked = settings.sfxEnabled;
      }

      const syncSlider = (key) => {
        const ctrl = this._audioControls[key];
        if (!ctrl || typeof settings[key] !== 'number') return;
        if (document.activeElement === ctrl.slider) return;
        const pct = Math.max(0, Math.min(100, Math.round(settings[key] * 100)));
        if (ctrl.slider.value !== String(pct)) {
          ctrl.slider.value = String(pct);
          ctrl.pctEl.textContent = `${pct}%`;
        }
      };
      syncSlider('musicVolume');
      syncSlider('radioVolume');
      syncSlider('sfxVolume');

      if (typeof settings.invertPitch === 'boolean') {
        this._toggles.invertPitch.checked = settings.invertPitch;
      }
      if (typeof settings.showDropReticle === 'boolean') {
        this._toggles.showDropReticle.checked = settings.showDropReticle;
      }
      if (typeof settings.mouseYoke === 'boolean') {
        this._toggles.mouseYoke.checked = settings.mouseYoke;
      }
      if (
        typeof settings.colorIdx === 'number' &&
        settings.colorIdx !== this._colorIdx &&
        settings.colorIdx >= 0 &&
        settings.colorIdx < LIVERIES.length
      ) {
        this._colorIdx = settings.colorIdx;
        this._refreshLiverySelection();
      }
      if (
        typeof settings.callsign === 'string' &&
        document.activeElement !== this._callsignInput &&
        settings.callsign !== this._callsign
      ) {
        this._callsign = sanitizeCallsign(settings.callsign, this._callsign);
        this._callsignInput.value = this._callsign;
      }
    }

    // 3. Live Squadron Top-10 Leaderboard
    const top10 = netState && Array.isArray(netState.top10) ? netState.top10 : null;
    const localSlotId = netState ? netState.localSlotId : null;
    const lbKey = top10
      ? `${localSlotId}|${top10.map((r) => `${r.slotId}:${r.name}:${r.score}:${r.colorIdx}`).join(',')}`
      : 'empty';

    if (lbKey !== this._lastLeaderboardKey) {
      this._lastLeaderboardKey = lbKey;
      this._renderLeaderboard(top10, localSlotId);
    }
  }

  _renderLeaderboard(top10, localSlotId) {
    this._lbList.replaceChildren();
    if (!top10 || top10.length === 0) {
      this._lbList.appendChild(
        el('div', 'ef-lb-empty', 'Take manual flight (any flight key) and hit the fire head to post your squadron score.')
      );
      return;
    }

    const count = Math.min(10, top10.length);
    for (let i = 0; i < count; i++) {
      const entry = top10[i];
      const isLocal = localSlotId !== null && localSlotId !== undefined && entry.slotId === localSlotId;
      const row = el('div', `ef-lb-row${isLocal ? ' is-local' : ''}`);

      row.appendChild(el('span', 'ef-lb-rank', `#${i + 1}`));

      const dot = el('span', 'ef-lb-dot');
      const liv = LIVERIES[(entry.colorIdx || 0) % LIVERIES.length] || LIVERIES[0];
      dot.style.backgroundColor = liv ? liv.hudColor : '#f8ce64';
      row.appendChild(dot);

      const safeName = sanitizeCallsign(entry.name || '', `EF-${String(entry.slotId ?? 0).padStart(2, '0')}`);
      row.appendChild(el('span', 'ef-lb-name', safeName));

      const slotLabel = `EF-${String(entry.slotId ?? 0).padStart(2, '0')}`;
      row.appendChild(el('span', 'ef-lb-slot', slotLabel));

      const scoreText = String(Math.max(0, Math.floor(entry.score || 0))).padStart(6, '0');
      row.appendChild(el('span', 'ef-lb-score', scoreText));

      this._lbList.appendChild(row);
    }
  }

  dispose() {
    this.backdropEl.remove();
    this.drawerEl.remove();
  }
}
