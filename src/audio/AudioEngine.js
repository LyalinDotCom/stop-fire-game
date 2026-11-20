// 100% Procedural Web Audio API Synthesizer for EMBER FRONT
// Zero external audio files, zero music, zero voice.

const MUTE_STORAGE_KEY = 'emberfront.audioMuted';
const PENTATONIC_HZ = [880, 988, 1175, 1319, 1568];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readStoredMute() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(MUTE_STORAGE_KEY);
    return raw === '1' || raw === 'true';
  } catch {
    return false;
  }
}

function writeStoredMute(muted) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

export class AudioEngine {
  constructor() {
    this._ctx = null;
    this._initialized = false;
    this._disposed = false;
    this._muted = readStoredMute();

    // Master chain
    this._compressor = null;
    this._masterGain = null;

    // Shared 2-second noise buffers
    this._whiteBuf = null;
    this._pinkBuf = null;

    // Continuous layer nodes
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

    // Edge-detection state
    this._wasReleasing = false;
    this._wasBounced = false;
    this._lastChimeMs = 0;
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
      this._ctx.resume().catch(() => {});
    }
    this._applyMasterGain();
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

    // Master Compressor -> Master Gain (40ms ramp) -> Destination
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 18;
    comp.ratio.value = 6;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;

    const master = ctx.createGain();
    master.gain.value = this._muted ? 0.0 : 0.85;

    comp.connect(master);
    master.connect(ctx.destination);
    this._compressor = comp;
    this._masterGain = master;

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
    // Detuned sawtooth (68-92 Hz) + square (136-184 Hz) -> lowpass 260 Hz + prop wash
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

  _applyMasterGain() {
    if (!this._ctx || !this._masterGain) return;
    const now = this._ctx.currentTime;
    const target = this._muted ? 0.0 : 0.85;
    this._masterGain.gain.cancelScheduledValues(now);
    this._masterGain.gain.setValueAtTime(this._masterGain.gain.value, now);
    this._masterGain.gain.linearRampToValueAtTime(target, now + 0.04);
  }

  setMuted(muted) {
    const next = Boolean(muted);
    this._muted = next;
    writeStoredMute(next);
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
    const rpmMod = 0.88 + 0.24 * rpmNorm; // 0.88..1.12
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

    // Terrain bounce scrape on rising edge
    if (bounced && !this._wasBounced) {
      this._playBounceScrape();
    }
    this._wasBounced = Boolean(bounced);
  }

  // Layer 5a: Rising pentatonic score chime (+70 / +35)
  playScoreChime(comboIndex = 0) {
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running') return;

    const nowMs = performance.now();
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
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running') return;

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
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running') return;

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
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running') return;

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
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    const now = this._ctx.currentTime;

    // Bandpass noise scrape
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

    // Low impact thud
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
