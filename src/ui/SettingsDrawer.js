// Slide-over [?] Operations, Pilot Settings, Controls & Squadron Top-10 Drawer
// All user-supplied & dynamic strings rendered strictly via textContent (never innerHTML).

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

export class SettingsDrawer {
  constructor({ onSelectOperation, onSwitchMode, onSettingChange, onClose } = {}) {
    this._onSelectOperation = onSelectOperation;
    this._onSwitchMode = onSwitchMode;
    this._onSettingChange = onSettingChange;
    this._onClose = onClose;

    this._open = false;
    this._activeTab = 'mission';
    this._lastLeaderboardKey = '';

    this._callsign = readStoredCallsign();
    this._colorIdx = readStoredColorIdx();

    // Backdrop
    this.backdropEl = el('div', 'ef-drawer-backdrop');
    this.backdropEl.addEventListener('click', () => this.toggle(false));

    // Drawer shell
    this.drawerEl = el('aside', 'ef-drawer');
    this.drawerEl.setAttribute('aria-label', 'Operations, Controls and Squadron Settings');
    this.drawerEl.setAttribute('aria-hidden', 'true');

    // Header
    const head = el('div', 'ef-drawer-head');
    head.appendChild(el('div', 'ef-drawer-title', 'OPERATIONS & SQUADRON'));
    const closeBtn = el('button', 'ef-drawer-close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close drawer');
    closeBtn.addEventListener('click', () => this.toggle(false));
    head.appendChild(closeBtn);
    this.drawerEl.appendChild(head);

    // Tabs
    const tabsBar = el('div', 'ef-drawer-tabs');
    tabsBar.setAttribute('role', 'tablist');
    this._tabButtons = {};
    this._tabPanels = {};

    const tabDefs = [
      ['mission', 'MISSION & PILOT'],
      ['controls', 'CONTROLS'],
      ['squadron', 'TOP 10'],
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
    this._buildMissionTab(body);
    this._buildControlsTab(body);
    this._buildSquadronTab(body);
    this.drawerEl.appendChild(body);

    this._onKeyDown = (ev) => {
      if (ev.key === 'Escape' && this._open) {
        ev.preventDefault();
        this.toggle(false);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKeyDown);
    }
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

  _buildMissionTab(parent) {
    const panel = el('div', 'ef-drawer-section');
    this._tabPanels.mission = panel;

    // 1. Mode Switcher
    panel.appendChild(el('div', 'ef-section-heading', 'DEPLOYMENT MODE'));
    const modeGrid = el('div', 'ef-mode-grid');
    this._modeButtons = {};

    const modes = [
      {
        id: 'solo',
        name: 'SOLO CAMPAIGN (OPS 01–05)',
        desc: 'Offline 5-operation alpine firefighting campaign.',
        tag: 'OFFLINE',
      },
      {
        id: 'mp',
        name: 'SHARED MEGA-BASIN (100P)',
        desc: 'Zero-login 100-pilot cooperative Cascadia basin.',
        tag: 'LIVE RTDB',
      },
      {
        id: 'loopback',
        name: '100-BOT LOOPBACK DEMO',
        desc: 'Local 100-aircraft squadron stress simulation.',
        tag: '100 BOTS',
      },
    ];

    for (const m of modes) {
      const btn = el('button', 'ef-mode-btn');
      btn.type = 'button';
      const left = el('div');
      left.appendChild(el('div', 'ef-mode-name', m.name));
      left.appendChild(el('div', 'ef-mode-desc', m.desc));
      btn.appendChild(left);
      btn.appendChild(el('span', 'ef-mode-tag', m.tag));
      btn.addEventListener('click', () => {
        if (this._onSwitchMode) this._onSwitchMode(m.id);
      });
      modeGrid.appendChild(btn);
      this._modeButtons[m.id] = btn;
    }
    panel.appendChild(modeGrid);

    // 2. Solo Operations 01-05 selector
    panel.appendChild(el('div', 'ef-section-heading', 'SOLO OPERATIONS (01–05)'));
    const opsList = el('div', 'ef-ops-list');
    this._opButtons = {};
    for (const op of OPERATIONS) {
      const btn = el('button', 'ef-op-btn');
      btn.type = 'button';
      const left = el('span');
      left.appendChild(el('span', 'ef-op-btn-num', `0${op.index}`));
      left.appendChild(el('span', null, op.name));
      btn.appendChild(left);
      btn.appendChild(el('span', 'ef-op-btn-meta', `${op.cabinCount} CABINS · ${op.windSpeedKt} KT`));
      btn.addEventListener('click', () => {
        if (this._onSelectOperation) this._onSelectOperation(op.id);
      });
      opsList.appendChild(btn);
      this._opButtons[op.id] = btn;
    }
    panel.appendChild(opsList);

    // 3. Callsign Input
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

    // Prevent flight key listeners from capturing while editing callsign
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

    // 4. 16-Swatch Forestry Livery Selector
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

    // 5. Flight Assistance Toggles
    panel.appendChild(el('div', 'ef-section-heading', 'FLIGHT SETTINGS'));
    const toggleList = el('div', 'ef-toggle-list');
    this._toggles = {};

    const toggleDefs = [
      ['invertPitch', 'Invert Pitch (W = Nose Up / S = Nose Down)'],
      ['showDropReticle', 'Show Ground Drop-Lead Reticle'],
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

    parent.appendChild(panel);
  }

  _buildControlsTab(parent) {
    const panel = el('div', 'ef-drawer-section ef-hidden');
    this._tabPanels.controls = panel;

    panel.appendChild(el('div', 'ef-section-heading', 'KEYBOARD CONTROLS'));
    const kbTable = el('div', 'ef-controls-table');
    const kbItems = [
      ['Pitch Nose Down / Up', 'W / S'],
      ['Bank Left / Right', 'A / D'],
      ['Throttle Down / Up', 'Q / E'],
      ['Release Water Curtain', 'SPACE'],
      ['Take Control from Demo', 'ANY FLIGHT KEY'],
      ['Toggle Audio Mute', 'M'],
      ['Toggle Operations Drawer', 'H or ?'],
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
      'Skim alpine lakes at <= 5 m AGL to activate SCOOP ACTIVE (~1.9 s empty-to-full). Climb to 35–55 m AGL and lead the wind before holding SPACE over active fire heads. Protect timber cabins to earn +500 CABIN SAVED bonuses.'
    );
    panel.appendChild(tips);

    parent.appendChild(panel);
  }

  _buildSquadronTab(parent) {
    const panel = el('div', 'ef-drawer-section ef-hidden');
    this._tabPanels.squadron = panel;

    panel.appendChild(el('div', 'ef-section-heading', 'SQUADRON TOP-10 LEADERBOARD'));
    this._lbList = el('div', 'ef-lb-list');
    this._lbList.appendChild(
      el('div', 'ef-lb-empty', 'Join Shared Mega-Basin (100P) or 100-Bot Loopback to see live squadron rankings.')
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

  update({ opConfig, netState, settings } = {}) {
    // Sync active mode button
    const mode = (netState && netState.mode) || 'solo';
    for (const [id, btn] of Object.entries(this._modeButtons)) {
      btn.classList.toggle('is-active', id === mode);
    }

    // Sync active operation button
    if (opConfig) {
      for (const [id, btn] of Object.entries(this._opButtons)) {
        btn.classList.toggle('is-active', mode === 'solo' && id === opConfig.id);
      }
    }

    // Sync settings controls without clobbering focused text input
    if (settings) {
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

    // Update Top-10 Squadron Leaderboard only when contents change
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
        el('div', 'ef-lb-empty', 'Join Shared Mega-Basin (100P) or 100-Bot Loopback to see live squadron rankings.')
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
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
    }
    this.backdropEl.remove();
    this.drawerEl.remove();
  }
}
