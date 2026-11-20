// Hybrid Procedural Web Audio SFX + Background Music + VHF Aviation Radio Audio Engine for EMBER FRONT
// Preserves all existing procedural layers & API while adding drop impact cues,
// target-lock pip, tree-hit & crash SFX, loopable background music with smooth ducking,
// and an audio-buffer-cached VHF radio voice bus.

import { MUSIC_TRACK_URL } from './radioManifest.js';

const MUTE_STORAGE_KEY = 'emberfront.audioMuted';
const MUSIC_ENABLED_KEY = 'emberfront.musicEnabled';
const MUSIC_VOLUME_KEY = 'emberfront.musicVolume';
const RADIO_VOLUME_KEY = 'emberfront.radioVolume';
const SFX_ENABLED_KEY = 'emberfront.sfxEnabled';
const SFX_VOLUME_KEY = 'emberfront.sfxVolume';

const PENTATONIC_HZ = [880, 988, 1175, 1319, 1568];

const DEFAULT_MASTER_GAIN = 0.85;
const DEFAULT_MUSIC_VOL = 0.38;
const DEFAULT_RADIO_VOL = 0.95;
const DEFAULT_SFX_VOL = 0.92;
// -9.5 dB smooth ducking during active VHF radio transmissions
const MUSIC_DUCK_GAIN = 0.33;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readStoredBool(key, fallback) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function writeStoredBool(key, val) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, val ? '1' : '0');
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

function readStoredFloat(key, fallback, lo = 0, hi = 1) {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, lo, hi);
  } catch {
    return fallback;
  }
}

function writeStoredFloat(key, val) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, String(Number(val.toFixed(3))));
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

export class AudioEngine {
  constructor() {
    this._ctx = null;
    this._initialized = false;
    this._disposed = false;

    this._muted = readStoredBool(MUTE_STORAGE_KEY, false);
    this._musicEnabled = readStoredBool(MUSIC_ENABLED_KEY, true);
    this._musicVolume = readStoredFloat(MUSIC_VOLUME_KEY, DEFAULT_MUSIC_VOL, 0, 1);
    this._radioVolume = readStoredFloat(RADIO_VOLUME_KEY, DEFAULT_RADIO_VOL, 0, 1);
    this._sfxEnabled = readStoredBool(SFX_ENABLED_KEY, true);
    this._sfxVolume = readStoredFloat(SFX_VOLUME_KEY, DEFAULT_SFX_VOL, 0, 1);

    // Master & bus nodes
    this._compressor = null;
    this._sfxBusGain = null;
    this._masterGain = null;
    this._musicGain = null;
    this._musicDuckGain = null;
    this._radioGain = null;

    // Shared 2-second noise buffers
    this._whiteBuf = null;
    this._pinkBuf = null;

    // Continuous procedural layer nodes
    this._sources = [];
    this._windFilter = null;
    this._windGain = null;

    this._engineSaw = null;
    this._engineSquare = null;
    this._engineFilter = null;
    this._engineGain = null;
    this._propWashFilter = null;
    this._propWashGain = null;

    this._fireRoarFilter = null;
    this._fireRoarGain = null;
    this._fireCrackleLfo = null;
    this._fireCrackleGain = null;

    this._dropFilter = null;
    this._dropGain = null;
    this._dropElapsed = 0;

    this._scoopGain = null;

    // Music playback state
    this._musicRequested = false;
    this._musicUrl = MUSIC_TRACK_URL;
    this._musicBuffer = null;
    this._musicLoading = null;
    this._musicSource = null;
    this._musicHtmlAudio = null;
    this._musicDucked = false;

    // Radio playback state & AudioBuffer cache
    this._radioBuffers = new Map();
    this._radioInflight = new Map();
    this._activeRadioStop = null;

    // Edge-detection & debounce state
    this._wasReleasing = false;
    this._wasBounced = false;
    this._wasTargetLocked = false;
    this._lastChimeMs = 0;
    this._lastTargetPipMs = 0;
    this._lastTreeHitMs = 0;
    this._lastCrashMs = 0;
  }

  unlock() {
    if (this._disposed) return;
    if (typeof window === 'undefined') return;

    if (!this._initialized) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      try {
        this._ctx = new AudioCtx();
        this._buildGraph(this._ctx);
        this._initialized = true;
      } catch {
        return;
      }
    }

    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx
        .resume()
        .then(() => {
          if (this._musicRequested && this._musicEnabled) {
            this._ensureMusicPlaying();
          }
        })
        .catch(() => {});
    } else if (this._musicRequested && this._musicEnabled) {
      this._ensureMusicPlaying();
    }

    this._applyMasterGain();
    this._applySfxGain();
    this._applyMusicGain();
    this._applyRadioGain();
  }

  _createNoiseBuffers(ctx) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * 2.0));

    const whiteBuf = ctx.createBuffer(1, length, ctx.sampleRate);
    const whiteData = whiteBuf.getChannelData(0);
    for (let i = 0; i < length; i++) {
      whiteData[i] = Math.random() * 2 - 1;
    }

    // Paul Kellet 7-stage pink noise approximation
    const pinkBuf = ctx.createBuffer(1, length, ctx.sampleRate);
    const pinkData = pinkBuf.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    let peak = 0.001;
    for (let i = 0; i < length; i++) {
      const w = whiteData[i];
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      const sample = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      pinkData[i] = sample;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    const invPeak = 0.95 / peak;
    for (let i = 0; i < length; i++) {
      pinkData[i] *= invPeak;
    }

    this._whiteBuf = whiteBuf;
    this._pinkBuf = pinkBuf;
  }

  _createLoopingNoise(ctx, buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0);
    this._sources.push(src);
    return src;
  }

  _buildGraph(ctx) {
    this._createNoiseBuffers(ctx);

    // Master Gain (40ms ramp) -> Destination
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0.0 : DEFAULT_MASTER_GAIN;
    master.connect(ctx.destination);
    this._masterGain = master;

    // SFX Bus: Compressor -> SFX Bus Gain -> Master Gain
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;

    const sfxBus = ctx.createGain();
    sfxBus.gain.value = this._sfxEnabled ? this._sfxVolume : 0.0;
    comp.connect(sfxBus);
    sfxBus.connect(master);
    this._compressor = comp;
    this._sfxBusGain = sfxBus;

    // Music Bus: Music Gain -> Music Duck Gain -> Master Gain
    const musicGain = ctx.createGain();
    musicGain.gain.value = this._musicEnabled ? this._musicVolume : 0.0;
    const musicDuckGain = ctx.createGain();
    musicDuckGain.gain.value = this._musicDucked ? MUSIC_DUCK_GAIN : 1.0;
    musicGain.connect(musicDuckGain);
    musicDuckGain.connect(master);
    this._musicGain = musicGain;
    this._musicDuckGain = musicDuckGain;

    // Radio Bus: Radio Gain -> Master Gain (already compressed & VHF-filtered in MP3)
    const radioGain = ctx.createGain();
    radioGain.gain.value = this._radioVolume;
    radioGain.connect(master);
    this._radioGain = radioGain;

    // Layer 1: Ambient Wind Bed (bandpass 420-780 Hz, Q=1.4, -28 dB base)
    const windSrc = this._createLoopingNoise(ctx, this._whiteBuf);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 540;
    windFilter.Q.value = 1.4;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.04;
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(comp);
    this._windFilter = windFilter;
    this._windGain = windGain;

    // Layer 2: Engine / Propeller Drone
    const engSaw = ctx.createOscillator();
    engSaw.type = 'sawtooth';
    engSaw.frequency.value = 80;

    const engSquare = ctx.createOscillator();
    engSquare.type = 'square';
    engSquare.frequency.value = 160;
    engSquare.detune.value = 9;

    const sqMix = ctx.createGain();
    sqMix.gain.value = 0.42;

    const engFilter = ctx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 260;
    engFilter.Q.value = 1.1;

    const engGain = ctx.createGain();
    engGain.gain.value = 0.11;

    engSaw.connect(engFilter);
    engSquare.connect(sqMix);
    sqMix.connect(engFilter);
    engFilter.connect(engGain);
    engGain.connect(comp);
    engSaw.start(0);
    engSquare.start(0);
    this._sources.push(engSaw, engSquare);

    // Filtered prop wash
    const washSrc = this._createLoopingNoise(ctx, this._pinkBuf);
    const washFilter = ctx.createBiquadFilter();
    washFilter.type = 'bandpass';
    washFilter.frequency.value = 210;
    washFilter.Q.value = 1.1;
    const washGain = ctx.createGain();
    washGain.gain.value = 0.055;
    washSrc.connect(washFilter);
    washFilter.connect(washGain);
    washGain.connect(comp);

    this._engineSaw = engSaw;
    this._engineSquare = engSquare;
    this._engineFilter = engFilter;
    this._engineGain = engGain;
    this._propWashFilter = washFilter;
    this._propWashGain = washGain;

    // Layer 3: Proximity Wildfire Roar (lowpass 380 Hz + LFO crackle AM 12-30 Hz)
    const fireSrc = this._createLoopingNoise(ctx, this._pinkBuf);
    const fireFilter = ctx.createBiquadFilter();
    fireFilter.type = 'lowpass';
    fireFilter.frequency.value = 380;
    fireFilter.Q.value = 0.85;
    const fireRoarGain = ctx.createGain();
    fireRoarGain.gain.value = 0.0;
    fireSrc.connect(fireFilter);
    fireFilter.connect(fireRoarGain);
    fireRoarGain.connect(comp);

    const crackleSrc = this._createLoopingNoise(ctx, this._whiteBuf);
    const crackleBp = ctx.createBiquadFilter();
    crackleBp.type = 'bandpass';
    crackleBp.frequency.value = 2300;
    crackleBp.Q.value = 2.2;

    const crackleAm = ctx.createGain();
    crackleAm.gain.value = 0.5;
    const crackleLfo = ctx.createOscillator();
    crackleLfo.type = 'triangle';
    crackleLfo.frequency.value = 19;
    const crackleLfoDepth = ctx.createGain();
    crackleLfoDepth.gain.value = 0.45;
    crackleLfo.connect(crackleLfoDepth);
    crackleLfoDepth.connect(crackleAm.gain);
    crackleLfo.start(0);
    this._sources.push(crackleLfo);

    const crackleOut = ctx.createGain();
    crackleOut.gain.value = 0.0;
    crackleSrc.connect(crackleBp);
    crackleBp.connect(crackleAm);
    crackleAm.connect(crackleOut);
    crackleOut.connect(comp);

    this._fireRoarFilter = fireFilter;
    this._fireRoarGain = fireRoarGain;
    this._fireCrackleLfo = crackleLfo;
    this._fireCrackleGain = crackleOut;

    // Layer 4: Water Drop Whoosh (sweeping bandpass 1400 -> 320 Hz over 1.25s, Q=1.8)
    const dropSrc = this._createLoopingNoise(ctx, this._whiteBuf);
    const dropFilter = ctx.createBiquadFilter();
    dropFilter.type = 'bandpass';
    dropFilter.frequency.value = 1400;
    dropFilter.Q.value = 1.8;
    const dropGain = ctx.createGain();
    dropGain.gain.value = 0.0;
    dropSrc.connect(dropFilter);
    dropFilter.connect(dropGain);
    dropGain.connect(comp);
    this._dropFilter = dropFilter;
    this._dropGain = dropGain;

    // Layer 6: Lake Scoop Skim Burst (bandpass 950 Hz Q=0.9 + highpass 1800 Hz)
    const scoopSrc = this._createLoopingNoise(ctx, this._whiteBuf);
    const scoopBp = ctx.createBiquadFilter();
    scoopBp.type = 'bandpass';
    scoopBp.frequency.value = 950;
    scoopBp.Q.value = 0.9;

    const scoopHp = ctx.createBiquadFilter();
    scoopHp.type = 'highpass';
    scoopHp.frequency.value = 1800;
    scoopHp.Q.value = 0.7;

    const scoopHpMix = ctx.createGain();
    scoopHpMix.gain.value = 0.55;

    const scoopGain = ctx.createGain();
    scoopGain.gain.value = 0.0;

    scoopSrc.connect(scoopBp);
    scoopBp.connect(scoopGain);
    scoopSrc.connect(scoopHp);
    scoopHp.connect(scoopHpMix);
    scoopHpMix.connect(scoopGain);
    scoopGain.connect(comp);
    this._scoopGain = scoopGain;
  }

  _canPlaySfx() {
    return Boolean(
      this._initialized &&
        this._ctx &&
        !this._muted &&
        this._sfxEnabled &&
        !this._disposed &&
        this._ctx.state === 'running',
    );
  }

  _applyMasterGain() {
    if (this._musicHtmlAudio) {
      this._updateHtmlMusicVolume();
    }
    if (!this._ctx || !this._masterGain) return;
    const now = this._ctx.currentTime;
    const target = this._muted ? 0.0 : DEFAULT_MASTER_GAIN;
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(target, now + 0.04);
  }

  _applySfxGain() {
    if (!this._ctx || !this._sfxBusGain) return;
    const now = this._ctx.currentTime;
    const target = this._sfxEnabled ? this._sfxVolume : 0.0;
    this._sfxBusGain.gain.cancelScheduledValues(now);
    this._sfxBusGain.gain.setValueAtTime(this._sfxBusGain.gain.value, now);
    this._sfxBusGain.gain.linearRampToValueAtTime(target, now + 0.05);
  }

  _applyMusicGain() {
    if (this._musicHtmlAudio) {
      this._updateHtmlMusicVolume();
    }
    if (!this._ctx || !this._musicGain) return;
    const now = this._ctx.currentTime;
    const target = this._musicEnabled ? this._musicVolume : 0.0;
    this._musicGain.gain.cancelScheduledValues(now);
    this._musicGain.gain.setValueAtTime(this._musicGain.gain.value, now);
    this._musicGain.gain.linearRampToValueAtTime(target, now + 0.14);
  }

  _applyMusicDuck() {
    if (this._musicHtmlAudio) {
      this._updateHtmlMusicVolume();
    }
    if (!this._ctx || !this._musicDuckGain) return;
    const now = this._ctx.currentTime;
    const target = this._musicDucked ? MUSIC_DUCK_GAIN : 1.0;
    const rampSec = this._musicDucked ? 0.14 : 0.36;
    this._musicDuckGain.gain.cancelScheduledValues(now);
    this._musicDuckGain.gain.setValueAtTime(this._musicDuckGain.gain.value, now);
    this._musicDuckGain.gain.linearRampToValueAtTime(target, now + rampSec);
  }

  _applyRadioGain() {
    if (!this._ctx || !this._radioGain) return;
    const now = this._ctx.currentTime;
    this._radioGain.gain.cancelScheduledValues(now);
    this._radioGain.gain.setValueAtTime(this._radioGain.gain.value, now);
    this._radioGain.gain.linearRampToValueAtTime(this._radioVolume, now + 0.05);
  }

  _updateHtmlMusicVolume() {
    if (!this._musicHtmlAudio) return;
    const duck = this._musicDucked ? MUSIC_DUCK_GAIN : 1.0;
    const vol = this._muted || !this._musicEnabled ? 0 : this._musicVolume * DEFAULT_MASTER_GAIN * duck;
    this._musicHtmlAudio.volume = clamp(vol, 0, 1);
  }

  // ---- Master / Bus Volume Controls ----

  setMuted(muted) {
    const next = Boolean(muted);
    this._muted = next;
    writeStoredBool(MUTE_STORAGE_KEY, next);
    this._applyMasterGain();
  }

  isMuted() {
    return this._muted;
  }

  toggleMute() {
    const next = !this._muted;
    this.setMuted(next);
    if (!next) {
      this.unlock();
      this.playAlertPing(false);
    }
    return this._muted;
  }

  setSfxEnabled(enabled) {
    const next = Boolean(enabled);
    this._sfxEnabled = next;
    writeStoredBool(SFX_ENABLED_KEY, next);
    this._applySfxGain();
  }

  isSfxEnabled() {
    return this._sfxEnabled;
  }

  setSfxVolume(vol) {
    const v = clamp(Number(vol) || 0, 0, 1);
    this._sfxVolume = v;
    writeStoredFloat(SFX_VOLUME_KEY, v);
    this._applySfxGain();
  }

  getSfxVolume() {
    return this._sfxVolume;
  }

  setRadioVolume(vol) {
    const v = clamp(Number(vol) || 0, 0, 1);
    this._radioVolume = v;
    writeStoredFloat(RADIO_VOLUME_KEY, v);
    this._applyRadioGain();
  }

  getRadioVolume() {
    return this._radioVolume;
  }

  // ---- Background Music Loop + Smooth Ducking ----

  startMusic(url = MUSIC_TRACK_URL) {
    if (this._disposed) return;
    if (url && url !== this._musicUrl) {
      this._musicUrl = url;
      this._musicBuffer = null;
      this._musicLoading = null;
    }
    this._musicRequested = true;
    if (this._musicEnabled) {
      this._ensureMusicPlaying();
    }
  }

  stopMusic() {
    this._musicRequested = false;
    this._stopMusicNodes();
  }

  setMusicEnabled(enabled) {
    const next = Boolean(enabled);
    this._musicEnabled = next;
    writeStoredBool(MUSIC_ENABLED_KEY, next);
    this._applyMusicGain();
    if (next && this._musicRequested) {
      this._ensureMusicPlaying();
    } else if (!next) {
      this._stopMusicNodes();
    }
  }

  isMusicEnabled() {
    return this._musicEnabled;
  }

  setMusicVolume(vol) {
    const v = clamp(Number(vol) || 0, 0, 1);
    this._musicVolume = v;
    writeStoredFloat(MUSIC_VOLUME_KEY, v);
    this._applyMusicGain();
  }

  getMusicVolume() {
    return this._musicVolume;
  }

  duckMusic(ducked) {
    const next = Boolean(ducked);
    if (next === this._musicDucked) return;
    this._musicDucked = next;
    this._applyMusicDuck();
  }

  _stopMusicNodes() {
    if (this._musicSource) {
      try {
        this._musicSource.stop();
        this._musicSource.disconnect();
      } catch {
        // Ignore already-stopped source.
      }
      this._musicSource = null;
    }
    if (this._musicHtmlAudio) {
      try {
        this._musicHtmlAudio.pause();
        this._musicHtmlAudio.currentTime = 0;
      } catch {
        // Ignore media pause errors.
      }
      this._musicHtmlAudio = null;
    }
  }

  _ensureMusicPlaying() {
    if (this._disposed || !this._musicEnabled || !this._musicRequested) return;
    if (this._musicSource || this._musicHtmlAudio) return;
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    if (!this._initialized || !this._ctx || this._ctx.state !== 'running') return;

    if (this._musicBuffer) {
      this._startMusicBufferSource(this._musicBuffer);
      return;
    }
    if (this._musicLoading) return;

    const url = this._musicUrl;
    this._musicLoading = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Music HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((arr) => {
        if (this._disposed || !this._ctx) return null;
        return this._ctx.decodeAudioData(arr);
      })
      .then((buf) => {
        this._musicLoading = null;
        if (!buf || this._disposed) return;
        this._musicBuffer = buf;
        if (this._musicRequested && this._musicEnabled && !this._musicSource) {
          this._startMusicBufferSource(buf);
        }
      })
      .catch(() => {
        this._musicLoading = null;
        if (this._disposed || !this._musicRequested || !this._musicEnabled) return;
        this._startMusicHtmlFallback(url);
      });
  }

  _startMusicBufferSource(buffer) {
    if (!this._ctx || !this._musicGain || this._musicSource || this._disposed) return;
    try {
      const src = this._ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(this._musicGain);
      src.start(0);
      this._musicSource = src;
      this._applyMusicGain();
      this._applyMusicDuck();
    } catch {
      // Ignore start failures.
    }
  }

  _startMusicHtmlFallback(url) {
    if (typeof Audio === 'undefined' || this._musicHtmlAudio || this._disposed) return;
    try {
      const el = new Audio(url);
      el.loop = true;
      el.preload = 'auto';
      this._musicHtmlAudio = el;
      this._updateHtmlMusicVolume();
      el.play().catch(() => {
        if (this._musicHtmlAudio === el) this._musicHtmlAudio = null;
      });
    } catch {
      // Ignore fallback error.
    }
  }

  // ---- VHF Radio Playback Bus ----

  async _loadRadioBuffer(url) {
    if (this._radioBuffers.has(url)) return this._radioBuffers.get(url);
    if (this._radioInflight.has(url)) return this._radioInflight.get(url);
    if (!this._ctx || typeof fetch === 'undefined') return null;

    const promise = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Radio HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then((arr) => {
        if (this._disposed || !this._ctx) return null;
        return this._ctx.decodeAudioData(arr);
      })
      .then((buf) => {
        if (buf) this._radioBuffers.set(url, buf);
        this._radioInflight.delete(url);
        return buf;
      })
      .catch(() => {
        this._radioInflight.delete(url);
        return null;
      });

    this._radioInflight.set(url, promise);
    return promise;
  }

  preloadRadioClips(urls = []) {
    if (this._disposed || !this._ctx || !Array.isArray(urls)) return;
    for (const url of urls) {
      if (url && !this._radioBuffers.has(url) && !this._radioInflight.has(url)) {
        this._loadRadioBuffer(url).catch(() => {});
      }
    }
  }

  stopRadioClip() {
    if (this._activeRadioStop) {
      const stopFn = this._activeRadioStop;
      this._activeRadioStop = null;
      stopFn();
    }
  }

  playRadioClip(url) {
    if (this._disposed || !url || this._muted) {
      return Promise.resolve(false);
    }

    this.stopRadioClip();

    // Primary path: Web Audio BufferSource routed through master/radio bus
    if (this._initialized && this._ctx && this._radioGain && this._ctx.state === 'running') {
      return new Promise((resolve) => {
        let cancelled = false;
        let src = null;

        const finish = (completed) => {
          if (this._activeRadioStop === cancel) {
            this._activeRadioStop = null;
          }
          if (src) {
            try {
              src.onended = null;
              src.stop();
              src.disconnect();
            } catch {
              // Ignore already-stopped nodes.
            }
            src = null;
          }
          resolve(completed);
        };

        const cancel = () => {
          if (cancelled) return;
          cancelled = true;
          finish(false);
        };
        this._activeRadioStop = cancel;

        this._loadRadioBuffer(url)
          .then((buf) => {
            if (cancelled || this._disposed || !this._ctx || !this._radioGain) {
              finish(false);
              return;
            }
            if (!buf) {
              // Fallback to HTMLAudio if decode failed
              this._playRadioHtmlFallback(url, resolve, () => cancelled);
              return;
            }
            src = this._ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this._radioGain);
            src.onended = () => {
              if (!cancelled) {
                cancelled = true;
                finish(true);
              }
            };
            src.start(0);
          })
          .catch(() => {
            if (!cancelled) {
              cancelled = true;
              finish(false);
            }
          });
      });
    }

    // Fallback path: HTMLAudioElement when Web Audio isn't unlocked yet
    return new Promise((resolve) => {
      this._playRadioHtmlFallback(url, resolve, () => false);
    });
  }

  _playRadioHtmlFallback(url, resolve, isExternallyCancelled) {
    if (typeof Audio === 'undefined' || this._muted || this._disposed || isExternallyCancelled()) {
      resolve(false);
      return;
    }
    try {
      const el = new Audio(url);
      el.volume = clamp(this._radioVolume * DEFAULT_MASTER_GAIN, 0, 1);
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        if (this._activeRadioStop === cancel) this._activeRadioStop = null;
        el.onended = null;
        el.onerror = null;
        resolve(ok);
      };
      const cancel = () => {
        try {
          el.pause();
        } catch {
          // Ignore pause errors.
        }
        done(false);
      };
      this._activeRadioStop = cancel;
      el.onended = () => done(true);
      el.onerror = () => done(false);
      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => done(false));
      }
    } catch {
      resolve(false);
    }
  }

  // ---- Continuous Flight / Fire / Water Procedural Loop ----

  update({
    dt = 1 / 60,
    airspeedKmh = 158,
    throttle = 0.5,
    windSpeedKt = 12,
    scooping = false,
    releasing = false,
    nearestFireDist = 9999,
    bounced = false,
  } = {}) {
    if (!this._initialized || !this._ctx || this._disposed) return;
    if (this._ctx.state !== 'running') return;

    const now = this._ctx.currentTime;
    const smooth = 0.04;

    // Layer 1: Ambient wind bed (420 - 780 Hz)
    const speedNorm = clamp((airspeedKmh - 115) / 95, 0, 1);
    const windNorm = clamp(windSpeedKt / 28, 0, 1);
    const windFreq = 420 + 230 * speedNorm + 130 * windNorm;
    const windVol = 0.032 + 0.03 * speedNorm + 0.025 * windNorm;
    this._windFilter.frequency.setTargetAtTime(windFreq, now, 0.08);
    this._windGain.gain.setTargetAtTime(windVol, now, 0.08);

    // Layer 2: Engine / Propeller drone (±12% RPM modulation, -4% scoop dip)
    const rpmNorm = clamp(0.55 * throttle + 0.45 * speedNorm, 0, 1);
    const rpmMod = 0.88 + 0.24 * rpmNorm;
    const scoopFactor = scooping ? 0.96 : 1.0;
    const sawHz = clamp(80 * rpmMod * scoopFactor, 68, 92);
    const sqHz = clamp(sawHz * 2.0, 136, 184);
    this._engineSaw.frequency.setTargetAtTime(sawHz, now, smooth);
    this._engineSquare.frequency.setTargetAtTime(sqHz, now, smooth);
    this._engineFilter.frequency.setTargetAtTime(220 + 65 * rpmNorm, now, smooth);
    this._engineGain.gain.setTargetAtTime(0.095 + 0.035 * rpmNorm, now, smooth);
    this._propWashFilter.frequency.setTargetAtTime(175 + 75 * rpmNorm, now, smooth);
    this._propWashGain.gain.setTargetAtTime(0.042 + 0.028 * rpmNorm, now, smooth);

    // Layer 3: Proximity wildfire roar (< 280 m)
    const fireProx = nearestFireDist < 280 ? clamp(1 - nearestFireDist / 280, 0, 1) : 0;
    const fireEnergy = fireProx * fireProx;
    this._fireRoarGain.gain.setTargetAtTime(fireEnergy * 0.34, now, 0.09);
    this._fireCrackleGain.gain.setTargetAtTime(fireEnergy * 0.14, now, 0.09);
    this._fireCrackleLfo.frequency.setTargetAtTime(12 + 18 * fireProx, now, 0.15);

    // Layer 4: Water drop whoosh (1400 -> 320 Hz over 1.25 s)
    if (releasing) {
      if (!this._wasReleasing) {
        this._dropElapsed = 0;
        this._dropFilter.frequency.setValueAtTime(1400, now);
      } else {
        this._dropElapsed = Math.min(1.25, this._dropElapsed + dt);
      }
      const frac = clamp(this._dropElapsed / 1.25, 0, 1);
      const dropHz = 1400 - (1400 - 320) * frac;
      this._dropFilter.frequency.setTargetAtTime(dropHz, now, 0.035);
      this._dropGain.gain.setTargetAtTime(0.24, now, 0.03);
    } else {
      this._dropGain.gain.setTargetAtTime(0.0, now, 0.06);
    }
    this._wasReleasing = Boolean(releasing);

    // Layer 6: Lake scoop skim burst
    this._scoopGain.gain.setTargetAtTime(scooping ? 0.2 : 0.0, now, 0.035);

    // Terrain bounce scrape on rising edge (kept for backwards compatibility)
    if (bounced && !this._wasBounced) {
      this._playBounceScrape();
    }
    this._wasBounced = Boolean(bounced);
  }

  // ---- One-Shot Procedural Cues ----

  // Unmistakable Drop Outcome Cues: 'direct' | 'partial' | 'miss'
  playDropOutcome(outcome = 'miss', cellsExtinguished = 0) {
    if (!this._canPlaySfx()) return;
    const kind = String(outcome || 'miss').toLowerCase();
    const now = this._ctx.currentTime;
    const cells = Math.max(0, Number(cellsExtinguished) || 0);

    if (kind === 'direct' || kind === 'hit') {
      // 1. Heavy pressurized steam hiss burst
      const steamGainAmt = clamp(0.22 + cells * 0.008, 0.22, 0.34);
      const steamSrc = this._ctx.createBufferSource();
      steamSrc.buffer = this._whiteBuf;
      const steamBp = this._ctx.createBiquadFilter();
      steamBp.type = 'bandpass';
      steamBp.frequency.setValueAtTime(2200, now);
      steamBp.frequency.exponentialRampToValueAtTime(4200, now + 0.14);
      steamBp.frequency.exponentialRampToValueAtTime(1350, now + 0.85);
      steamBp.Q.value = 1.1;

      const steamGain = this._ctx.createGain();
      steamGain.gain.setValueAtTime(0.0001, now);
      steamGain.gain.linearRampToValueAtTime(steamGainAmt, now + 0.025);
      steamGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.88);

      steamSrc.connect(steamBp);
      steamBp.connect(steamGain);
      steamGain.connect(this._compressor);
      steamSrc.start(now);
      steamSrc.stop(now + 0.9);
      steamSrc.onended = () => {
        steamSrc.disconnect();
        steamBp.disconnect();
        steamGain.disconnect();
      };

      // 2. Bright ascending major triad chime (C6 -> E6 -> G6 [+ C7 shimmer on big hits])
      const notes = cells >= 10 ? [1046.5, 1318.5, 1568.0, 2093.0] : [1046.5, 1318.5, 1568.0];
      for (let i = 0; i < notes.length; i++) {
        const t = now + i * 0.055;
        const osc = this._ctx.createOscillator();
        const overtone = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(notes[i], t);
        overtone.type = 'triangle';
        overtone.frequency.setValueAtTime(notes[i] * 2, t);

        const ovGain = this._ctx.createGain();
        ovGain.gain.value = 0.14;

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.16, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);

        osc.connect(gain);
        overtone.connect(ovGain);
        ovGain.connect(gain);
        gain.connect(this._compressor);
        osc.start(t);
        overtone.start(t);
        osc.stop(t + 0.36);
        overtone.stop(t + 0.36);
        osc.onended = () => {
          osc.disconnect();
          overtone.disconnect();
          ovGain.disconnect();
          gain.disconnect();
        };
      }
      return;
    }

    if (kind === 'partial') {
      // Medium steam hiss + 2-note ascending chime
      const steamSrc = this._ctx.createBufferSource();
      steamSrc.buffer = this._whiteBuf;
      const steamBp = this._ctx.createBiquadFilter();
      steamBp.type = 'bandpass';
      steamBp.frequency.setValueAtTime(1900, now);
      steamBp.frequency.exponentialRampToValueAtTime(1050, now + 0.5);
      steamBp.Q.value = 1.3;

      const steamGain = this._ctx.createGain();
      steamGain.gain.setValueAtTime(0.0001, now);
      steamGain.gain.linearRampToValueAtTime(0.16, now + 0.02);
      steamGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);

      steamSrc.connect(steamBp);
      steamBp.connect(steamGain);
      steamGain.connect(this._compressor);
      steamSrc.start(now);
      steamSrc.stop(now + 0.54);
      steamSrc.onended = () => {
        steamSrc.disconnect();
        steamBp.disconnect();
        steamGain.disconnect();
      };

      const notes = [880.0, 1108.7];
      for (let i = 0; i < notes.length; i++) {
        const t = now + i * 0.065;
        const osc = this._ctx.createOscillator();
        const gain = this._ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(notes[i], t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(0.13, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        osc.connect(gain);
        gain.connect(this._compressor);
        osc.start(t);
        osc.stop(t + 0.26);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
      }
      return;
    }

    // 'miss': Muted wet splash + soft hollow thud
    const splashSrc = this._ctx.createBufferSource();
    splashSrc.buffer = this._pinkBuf;
    const lp = this._ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(580, now);
    lp.frequency.exponentialRampToValueAtTime(180, now + 0.36);

    const sGain = this._ctx.createGain();
    sGain.gain.setValueAtTime(0.0001, now);
    sGain.gain.linearRampToValueAtTime(0.18, now + 0.018);
    sGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

    splashSrc.connect(lp);
    lp.connect(sGain);
    sGain.connect(this._compressor);
    splashSrc.start(now);
    splashSrc.stop(now + 0.4);
    splashSrc.onended = () => {
      splashSrc.disconnect();
      lp.disconnect();
      sGain.disconnect();
    };

    const thud = this._ctx.createOscillator();
    const tGain = this._ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(155, now);
    thud.frequency.exponentialRampToValueAtTime(72, now + 0.22);
    tGain.gain.setValueAtTime(0.0001, now);
    tGain.gain.linearRampToValueAtTime(0.15, now + 0.012);
    tGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);

    thud.connect(tGain);
    tGain.connect(this._compressor);
    thud.start(now);
    thud.stop(now + 0.26);
    thud.onended = () => {
      thud.disconnect();
      tGain.disconnect();
    };
  }

  // Subtle cockpit target-lock pip (fires only on false -> true transition, debounced)
  playTargetLockPip(locked) {
    const isLocked = Boolean(locked);
    const wasLocked = this._wasTargetLocked;
    this._wasTargetLocked = isLocked;
    if (!isLocked || wasLocked) return;
    if (!this._canPlaySfx()) return;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this._lastTargetPipMs < 260) return;
    this._lastTargetPipMs = nowMs;

    const now = this._ctx.currentTime;
    const freqs = [1568, 2093];
    for (let i = 0; i < freqs.length; i++) {
      const t = now + i * 0.036;
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], t);

      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.068, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.034);

      osc.connect(gain);
      gain.connect(this._compressor);
      osc.start(t);
      osc.stop(t + 0.04);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  // Tree collision SFX: timber/fuselage crunch + cockpit master-caution double warning chime
  playTreeHit() {
    if (!this._canPlaySfx()) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this._lastTreeHitMs < 180) return;
    this._lastTreeHitMs = nowMs;

    const now = this._ctx.currentTime;

    // 1. Sharp wood-crack + aluminum fuselage crunch
    const crunchSrc = this._ctx.createBufferSource();
    crunchSrc.buffer = this._whiteBuf;
    const bp = this._ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1150, now);
    bp.frequency.exponentialRampToValueAtTime(240, now + 0.28);
    bp.Q.value = 1.6;

    const cGain = this._ctx.createGain();
    cGain.gain.setValueAtTime(0.0001, now);
    cGain.gain.linearRampToValueAtTime(0.32, now + 0.008);
    cGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);

    crunchSrc.connect(bp);
    bp.connect(cGain);
    cGain.connect(this._compressor);
    crunchSrc.start(now);
    crunchSrc.stop(now + 0.32);
    crunchSrc.onended = () => {
      crunchSrc.disconnect();
      bp.disconnect();
      cGain.disconnect();
    };

    // 2. Low structural thump
    const thump = this._ctx.createOscillator();
    const thumpGain = this._ctx.createGain();
    thump.type = 'sawtooth';
    thump.frequency.setValueAtTime(135, now);
    thump.frequency.exponentialRampToValueAtTime(44, now + 0.18);
    thumpGain.gain.setValueAtTime(0.24, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);

    const thumpLp = this._ctx.createBiquadFilter();
    thumpLp.type = 'lowpass';
    thumpLp.frequency.value = 260;

    thump.connect(thumpLp);
    thumpLp.connect(thumpGain);
    thumpGain.connect(this._compressor);
    thump.start(now);
    thump.stop(now + 0.22);
    thump.onended = () => {
      thump.disconnect();
      thumpLp.disconnect();
      thumpGain.disconnect();
    };

    // 3. Cockpit Master Caution warning chime (880 Hz -> 659 Hz)
    const warnFreqs = [880, 659];
    for (let i = 0; i < warnFreqs.length; i++) {
      const t = now + 0.08 + i * 0.11;
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(warnFreqs[i], t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.095);
      osc.connect(gain);
      gain.connect(this._compressor);
      osc.start(t);
      osc.stop(t + 0.105);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  // Terrain/fatal crash SFX: heavy low-frequency impact boom + debris + ELT emergency beacon sweep
  playCrash() {
    if (!this._canPlaySfx()) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this._lastCrashMs < 500) return;
    this._lastCrashMs = nowMs;

    const now = this._ctx.currentTime;

    // 1. Sub-bass impact shockwave
    const sub = this._ctx.createOscillator();
    const subGain = this._ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(105, now);
    sub.frequency.exponentialRampToValueAtTime(24, now + 0.72);
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime(0.45, now + 0.012);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.85);
    sub.connect(subGain);
    subGain.connect(this._compressor);
    sub.start(now);
    sub.stop(now + 0.88);
    sub.onended = () => {
      sub.disconnect();
      subGain.disconnect();
    };

    // 2. Heavy fiery explosion roar + metallic crunch
    const boomSrc = this._ctx.createBufferSource();
    boomSrc.buffer = this._pinkBuf;
    const boomLp = this._ctx.createBiquadFilter();
    boomLp.type = 'lowpass';
    boomLp.frequency.setValueAtTime(680, now);
    boomLp.frequency.exponentialRampToValueAtTime(110, now + 1.35);

    const boomGain = this._ctx.createGain();
    boomGain.gain.setValueAtTime(0.0001, now);
    boomGain.gain.linearRampToValueAtTime(0.42, now + 0.02);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);

    boomSrc.connect(boomLp);
    boomLp.connect(boomGain);
    boomGain.connect(this._compressor);
    boomSrc.start(now);
    boomSrc.stop(now + 1.45);
    boomSrc.onended = () => {
      boomSrc.disconnect();
      boomLp.disconnect();
      boomGain.disconnect();
    };

    // 3. Aviation ELT emergency locator distress sweep (2 crisp descending warbles)
    for (let i = 0; i < 2; i++) {
      const t = now + 0.48 + i * 0.34;
      const elt = this._ctx.createOscillator();
      const eGain = this._ctx.createGain();
      elt.type = 'sine';
      elt.frequency.setValueAtTime(1480, t);
      elt.frequency.exponentialRampToValueAtTime(720, t + 0.24);

      eGain.gain.setValueAtTime(0.0001, t);
      eGain.gain.linearRampToValueAtTime(0.11, t + 0.01);
      eGain.gain.setValueAtTime(0.1, t + 0.2);
      eGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

      elt.connect(eGain);
      eGain.connect(this._compressor);
      elt.start(t);
      elt.stop(t + 0.28);
      elt.onended = () => {
        elt.disconnect();
        eGain.disconnect();
      };
    }
  }

  // Layer 5a: Rising pentatonic score chime (+70 / +35)
  playScoreChime(comboIndex = 0) {
    if (!this._canPlaySfx()) return;

    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (nowMs - this._lastChimeMs < 42) return;
    this._lastChimeMs = nowMs;

    const idx = clamp(Math.floor(comboIndex), 0, PENTATONIC_HZ.length - 1);
    const freq = PENTATONIC_HZ[idx];
    const now = this._ctx.currentTime;

    const osc = this._ctx.createOscillator();
    const gain = this._ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.16, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.088);

    osc.connect(gain);
    gain.connect(this._compressor);
    osc.start(now);
    osc.stop(now + 0.095);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  // Layer 5b: Warm fifth chord (659 + 988 Hz) for +500 Cabin Saved
  playCabinSavedChord() {
    if (!this._canPlaySfx()) return;

    const now = this._ctx.currentTime;
    const freqs = [659, 988];
    for (let i = 0; i < freqs.length; i++) {
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], now + i * 0.025);

      gain.gain.setValueAtTime(0.0001, now + i * 0.025);
      gain.gain.linearRampToValueAtTime(0.15, now + i * 0.025 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.025 + 0.36);

      osc.connect(gain);
      gain.connect(this._compressor);
      osc.start(now + i * 0.025);
      osc.stop(now + i * 0.025 + 0.38);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  // Layer 6b: Soft 1046 Hz tank-full confirmation ping
  playTankFullPing() {
    if (!this._canPlaySfx()) return;

    const now = this._ctx.currentTime;
    const osc = this._ctx.createOscillator();
    const gain = this._ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.13, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);

    osc.connect(gain);
    gain.connect(this._compressor);
    osc.start(now);
    osc.stop(now + 0.21);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  // Layer 7: Short pure sine UI / Alert pings (740 / 1100 Hz, 55 ms)
  playAlertPing(urgent = false) {
    if (!this._canPlaySfx()) return;

    const now = this._ctx.currentTime;
    const pulses = urgent ? [1100, 1100] : [740];

    for (let i = 0; i < pulses.length; i++) {
      const start = now + i * 0.085;
      const osc = this._ctx.createOscillator();
      const gain = this._ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(pulses[i], start);

      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(urgent ? 0.14 : 0.11, start + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);

      osc.connect(gain);
      gain.connect(this._compressor);
      osc.start(start);
      osc.stop(start + 0.062);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    }
  }

  // Brief terrain deflection scrape + hull thud
  _playBounceScrape() {
    if (!this._canPlaySfx()) return;
    const now = this._ctx.currentTime;

    const src = this._ctx.createBufferSource();
    src.buffer = this._whiteBuf;
    const bp = this._ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(620, now);
    bp.frequency.exponentialRampToValueAtTime(220, now + 0.24);
    bp.Q.value = 2.4;

    const nGain = this._ctx.createGain();
    nGain.gain.setValueAtTime(0.0001, now);
    nGain.gain.linearRampToValueAtTime(0.24, now + 0.01);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    src.connect(bp);
    bp.connect(nGain);
    nGain.connect(this._compressor);
    src.start(now);
    src.stop(now + 0.28);
    src.onended = () => {
      src.disconnect();
      bp.disconnect();
      nGain.disconnect();
    };

    const thud = this._ctx.createOscillator();
    const tGain = this._ctx.createGain();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(115, now);
    thud.frequency.exponentialRampToValueAtTime(48, now + 0.14);
    tGain.gain.setValueAtTime(0.2, now);
    tGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    thud.connect(tGain);
    tGain.connect(this._compressor);
    thud.start(now);
    thud.stop(now + 0.18);
    thud.onended = () => {
      thud.disconnect();
      tGain.disconnect();
    };
  }

  dispose() {
    this._disposed = true;
    this.stopRadioClip();
    this.stopMusic();
    this._radioBuffers.clear();
    this._radioInflight.clear();

    for (const src of this._sources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped nodes.
      }
    }
    this._sources = [];
    if (this._ctx) {
      try {
        this._ctx.close();
      } catch {
        // Ignore close errors.
      }
      this._ctx = null;
    }
    this._initialized = false;
  }
}
