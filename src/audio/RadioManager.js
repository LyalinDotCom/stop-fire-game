// VHF Aviation Radio Manager for EMBER FRONT
// Handles categorized clip selection with anti-repeat memory, per-category cooldowns,
// priority queuing & preemption of low-priority chatter, music ducking via AudioEngine,
// ambient airspace chatter scheduler, and synchronized HUD transcript notifications
// (even when audio is muted or radio voice playback is toggled off).

import { RADIO_CLIPS_BY_CATEGORY } from './radioManifest.js';

const RADIO_ENABLED_KEY = 'emberfront.radioEnabled';

// Category aliases so callers using slightly different event keys work seamlessly
const CATEGORY_ALIASES = Object.freeze({
  cabin_at_risk: 'help_cabin',
  cabin_threat: 'help_cabin',
  tree_hit: 'damage_hit',
  plane_crash: 'crash_respawn',
  crash: 'crash_respawn',
  hit: 'hit_direct',
  direct: 'hit_direct',
  partial: 'hit_partial',
  miss: 'miss_wide',
  miss_overshot: 'miss_overshoot',
  overshot: 'miss_overshoot',
  overshoot: 'miss_overshoot',
  short: 'miss_short',
  wide: 'miss_wide',
  misted_high: 'drop_too_high',
  too_high: 'drop_too_high',
  smoke_turbulence: 'turbulence_smoke',
  turbulence: 'turbulence_smoke',
  rough_scoop: 'scoop_rough',
  wind_shift: 'chatter_misc',
  ambient: 'chatter_misc',
});

// Default priority rank (higher preempts lower when urgent)
const CATEGORY_PRIORITY = Object.freeze({
  crash_respawn: 4,
  help_cabin: 4,
  damage_hit: 3,
  fire_contained: 3,
  operation_advance: 3,
  drop_too_high: 3,
  hit_direct: 3,
  hit_partial: 2,
  miss_overshoot: 2,
  miss_short: 2,
  miss_wide: 2,
  mission_start: 2,
  turbulence_smoke: 1,
  scoop_full: 1,
  scoop_rough: 1,
  mp_join: 1,
  chatter_misc: 0,
});

// Per-category anti-spam cooldowns (ms) unless opts.priority === 'high' or opts.force === true
const CATEGORY_COOLDOWN_MS = Object.freeze({
  mission_start: 18000,
  hit_direct: 4500,
  hit_partial: 5500,
  drop_too_high: 9000,
  turbulence_smoke: 18000,
  miss_overshoot: 6000,
  miss_short: 6000,
  miss_wide: 6000,
  help_cabin: 16000,
  scoop_full: 12000,
  scoop_rough: 14000,
  mp_join: 10000,
  chatter_misc: 20000,
  fire_contained: 10000,
  operation_advance: 10000,
  damage_hit: 6500,
  crash_respawn: 6000,
});

const AMBIENT_MIN_MS = 22000;
const AMBIENT_MAX_MS = 38000;
const AMBIENT_QUIET_GAP_MS = 11000;
const MAX_QUEUE_LENGTH = 3;

function readStoredEnabled() {
  try {
    if (typeof localStorage === 'undefined') return true;
    const raw = localStorage.getItem(RADIO_ENABLED_KEY);
    if (raw === null) return true;
    return raw === '1' || raw === 'true';
  } catch {
    return true;
  }
}

function writeStoredEnabled(enabled) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(RADIO_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage errors.
  }
}

function priorityScore(category, optsPriority) {
  if (optsPriority === 'high') return 4;
  if (optsPriority === 'low') return 0;
  return CATEGORY_PRIORITY[category] ?? 1;
}

export class RadioManager {
  constructor(audioEngine = null) {
    this._audio = audioEngine;
    this._enabled = readStoredEnabled();
    this._disposed = false;

    this._listeners = new Set();
    this._queue = [];
    this._active = null; // { clip, priority, token, timerId }
    this._playToken = 0;
    this._drainTimer = null;

    this._lastCategoryMs = new Map();
    this._recentIdsByCategory = new Map();
    this._lastTransmissionEndMs = 0;

    // Ambient chatter scheduler
    this._ambientRunning = false;
    this._ambientTimer = null;
  }

  onTransmission(cb) {
    if (typeof cb !== 'function') return () => {};
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  _emit(payload) {
    for (const cb of this._listeners) {
      try {
        cb(payload);
      } catch {
        // Keep radio loop isolated from listener errors.
      }
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    this._enabled = next;
    writeStoredEnabled(next);
    if (!next && this._audio) {
      this._audio.stopRadioClip();
      this._audio.duckMusic(false);
    }
  }

  isEnabled() {
    return this._enabled;
  }

  setVolume(vol) {
    if (this._audio && typeof this._audio.setRadioVolume === 'function') {
      this._audio.setRadioVolume(vol);
    }
  }

  getVolume() {
    if (this._audio && typeof this._audio.getRadioVolume === 'function') {
      return this._audio.getRadioVolume();
    }
    return 0.95;
  }

  preloadCoreClips() {
    if (!this._audio || typeof this._audio.preloadRadioClips !== 'function') return;
    const sample = [];
    for (const cat of ['mission_start', 'hit_direct', 'help_cabin', 'scoop_full']) {
      const list = RADIO_CLIPS_BY_CATEGORY[cat];
      if (list && list.length > 0) {
        sample.push(list[0].url);
        if (list.length > 1) sample.push(list[1].url);
      }
    }
    this._audio.preloadRadioClips(sample);
  }

  _resolveCategory(rawCategory) {
    const key = String(rawCategory || '').trim().toLowerCase();
    return CATEGORY_ALIASES[key] || key;
  }

  _pickClip(category) {
    const pool = RADIO_CLIPS_BY_CATEGORY[category];
    if (!pool || pool.length === 0) return null;
    if (pool.length === 1) return pool[0];

    let recent = this._recentIdsByCategory.get(category);
    if (!recent) {
      recent = [];
      this._recentIdsByCategory.set(category, recent);
    }

    const maxHistory = Math.max(1, Math.min(pool.length - 1, Math.ceil(pool.length * 0.6)));
    const candidates = pool.filter((clip) => !recent.includes(clip.id));
    const source = candidates.length > 0 ? candidates : pool;
    const chosen = source[Math.floor(Math.random() * source.length)];

    recent.push(chosen.id);
    while (recent.length > maxHistory) recent.shift();
    return chosen;
  }

  _cancelDrainTimer() {
    if (this._drainTimer !== null) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
  }

  _pruneStaleQueue(now = Date.now()) {
    if (this._queue.length === 0) return;
    this._queue = this._queue.filter((q) => now - q.queuedAt <= 12000);
  }

  _enqueue(entry) {
    this._pruneStaleQueue(entry.queuedAt);
    const category = entry.clip.category;
    const existingIdx = this._queue.findIndex((q) => q.clip.category === category);
    if (existingIdx >= 0) {
      this._queue[existingIdx] = entry;
    } else {
      this._queue.push(entry);
    }
    // Keep queue sorted highest priority first, bounded to MAX_QUEUE_LENGTH
    this._queue.sort((a, b) => b.priority - a.priority || a.queuedAt - b.queuedAt);
    if (this._queue.length > MAX_QUEUE_LENGTH) {
      this._queue.length = MAX_QUEUE_LENGTH;
    }
  }

  /**
   * Trigger a VHF radio transmission from a category.
   * @param {string} rawCategory
   * @param {{ priority?: 'low'|'normal'|'high', force?: boolean, textOverride?: string }} [opts]
   * @returns {object|null} Selected clip metadata if accepted, or null if suppressed by cooldown.
   */
  trigger(rawCategory, opts = {}) {
    if (this._disposed) return null;
    const category = this._resolveCategory(rawCategory);
    const clipBase = this._pickClip(category);
    if (!clipBase) return null;

    const nowMs = Date.now();
    const highPriority = opts.priority === 'high' || opts.force === true;
    const cooldownMs = CATEGORY_COOLDOWN_MS[category] ?? 6000;
    const lastMs = this._lastCategoryMs.get(category) || 0;

    if (!highPriority && nowMs - lastMs < cooldownMs) {
      return null;
    }

    const clip = opts.textOverride
      ? { ...clipBase, text: String(opts.textOverride) }
      : clipBase;
    const priority = priorityScore(category, opts.priority);
    this._lastCategoryMs.set(category, nowMs);

    const entry = { clip, priority, queuedAt: nowMs };

    if (this._active) {
      // Preempt ambient chatter & routine advisories immediately for drop/urgent callouts
      const shouldPreempt =
        (this._active.priority === 0 && priority >= 2) ||
        (this._active.priority <= 1 && priority >= 3) ||
        (priority >= 4 && this._active.priority < 4);

      if (shouldPreempt) {
        this._cancelDrainTimer();
        this._abortActive();
        this._startTransmission(entry);
        return clip;
      }

      // Avoid queuing ambient chatter behind active comms
      if (priority === 0) return null;

      this._enqueue(entry);
      return clip;
    }

    // Handle arrival during the 280 ms inter-transmission drain gap
    this._pruneStaleQueue(nowMs);
    if (this._queue.length > 0) {
      // Priority-0 chatter must never preempt or cancel queued alerts waiting in the gap
      if (priority === 0) return null;
      this._cancelDrainTimer();
      this._enqueue(entry);
      const next = this._queue.shift();
      this._startTransmission(next);
      return clip;
    }

    this._cancelDrainTimer();
    this._startTransmission(entry);
    return clip;
  }

  _abortActive() {
    if (!this._active) return;
    const prev = this._active;
    this._active = null;
    if (prev.timerId !== null) {
      clearTimeout(prev.timerId);
    }
    if (this._audio) {
      this._audio.stopRadioClip();
      this._audio.duckMusic(false);
    }
    this._emit({
      id: prev.clip.id,
      category: prev.clip.category,
      speaker: prev.clip.speaker,
      freq: prev.clip.freq,
      text: prev.clip.text,
      urgency: prev.clip.urgency,
      durationMs: prev.clip.durationMs,
      active: false,
    });
  }

  _startTransmission(entry) {
    if (this._disposed) return;
    this._cancelDrainTimer();
    const { clip, priority } = entry;
    const token = ++this._playToken;

    const state = { clip, priority, token, timerId: null };
    this._active = state;

    const payloadStart = {
      id: clip.id,
      category: clip.category,
      speaker: clip.speaker,
      freq: clip.freq,
      text: clip.text,
      urgency: clip.urgency,
      durationMs: clip.durationMs,
      active: true,
    };
    this._emit(payloadStart);

    const finalize = () => {
      if (this._disposed) return;
      if (!this._active || this._active.token !== token) return;
      if (state.timerId !== null) {
        clearTimeout(state.timerId);
        state.timerId = null;
      }
      this._active = null;
      this._lastTransmissionEndMs = Date.now();
      if (this._audio) {
        this._audio.duckMusic(false);
      }
      this._emit({ ...payloadStart, active: false });
      this._drainQueue();
    };

    const wantsAudio = Boolean(
      this._enabled && this._audio && !this._audio.isMuted(),
    );

    if (wantsAudio) {
      this._audio.duckMusic(true);
      // Safety ceiling timer in case audio stalls or browser blocks playback
      const maxWaitMs = Math.max(2400, (clip.durationMs || 3500) + 1800);
      state.timerId = setTimeout(finalize, maxWaitMs);

      this._audio
        .playRadioClip(clip.url)
        .then((played) => {
          if (!this._active || this._active.token !== token) return;
          if (played) {
            finalize();
          } else {
            // Audio couldn't play (e.g., before user gesture unlock) — keep transcript visible for reading duration!
            if (this._audio) this._audio.duckMusic(false);
            if (state.timerId !== null) clearTimeout(state.timerId);
            const readMs = Math.max(2600, Math.min(5200, clip.durationMs || 3400));
            state.timerId = setTimeout(finalize, readMs);
          }
        })
        .catch(() => {
          if (!this._active || this._active.token !== token) return;
          if (this._audio) this._audio.duckMusic(false);
          if (state.timerId !== null) clearTimeout(state.timerId);
          const readMs = Math.max(2600, Math.min(5200, clip.durationMs || 3400));
          state.timerId = setTimeout(finalize, readMs);
        });
    } else {
      // Muted or radio voice disabled: still show synchronized transcript on HUD for natural reading time!
      const readMs = Math.max(2600, Math.min(5200, clip.durationMs || 3400));
      state.timerId = setTimeout(finalize, readMs);
    }
  }

  _drainQueue() {
    if (this._disposed || this._active) return;
    this._pruneStaleQueue();
    if (this._queue.length === 0) {
      this._cancelDrainTimer();
      return;
    }
    if (this._drainTimer !== null) return;
    // Brief natural radio gap between consecutive transmissions (280 ms).
    // Keep entries in _queue until the callback fires so urgent arrivals during the
    // gap stay ordered and never drop a queued alert.
    const token = this._playToken;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      if (this._disposed || this._active || this._playToken !== token) return;
      this._pruneStaleQueue();
      if (this._queue.length === 0) return;
      const next = this._queue.shift();
      this._startTransmission(next);
    }, 280);
  }

  // ---- Ambient Airspace Chatter Scheduler ----

  startAmbientChatter() {
    if (this._disposed || this._ambientRunning) return;
    this._ambientRunning = true;
    this._scheduleNextAmbient();
  }

  stopAmbientChatter() {
    this._ambientRunning = false;
    if (this._ambientTimer !== null) {
      clearTimeout(this._ambientTimer);
      this._ambientTimer = null;
    }
  }

  _scheduleNextAmbient() {
    if (!this._ambientRunning || this._disposed) return;
    if (this._ambientTimer !== null) {
      clearTimeout(this._ambientTimer);
    }
    const delayMs = AMBIENT_MIN_MS + Math.floor(Math.random() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS));
    this._ambientTimer = setTimeout(() => {
      this._ambientTimer = null;
      if (!this._ambientRunning || this._disposed) return;
      const now = Date.now();
      const quietEnough =
        !this._active &&
        this._drainTimer === null &&
        this._queue.length === 0 &&
        now - this._lastTransmissionEndMs >= AMBIENT_QUIET_GAP_MS;

      if (quietEnough) {
        this.trigger('chatter_misc', { priority: 'low' });
      }
      this._scheduleNextAmbient();
    }, delayMs);
  }

  clearQueue() {
    this._cancelDrainTimer();
    this._queue.length = 0;
  }

  dispose() {
    this._disposed = true;
    this.stopAmbientChatter();
    this._cancelDrainTimer();
    this._queue.length = 0;
    this._abortActive();
    this._listeners.clear();
  }
}
