#!/usr/bin/env node
// Verifies all generated MP3 audio assets (radio + music) with ffprobe,
// validates radioManifest.js coverage, and smoke-tests RadioManager + AudioEngine.

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  MUSIC_TRACK_URL,
  RADIO_CLIPS,
  RADIO_CLIPS_BY_CATEGORY,
} from '../../src/audio/radioManifest.js';
import { AudioEngine } from '../../src/audio/AudioEngine.js';
import { RadioManager } from '../../src/audio/RadioManager.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const PUBLIC_DIR = join(REPO_ROOT, 'public');

function urlToPublicPath(url) {
  const clean = url.replace(/^\.\//, '');
  return join(PUBLIC_DIR, clean);
}

async function probeMp3(filePath) {
  const info = await stat(filePath);
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate:stream=codec_name,sample_rate,channels',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed?.streams?.[0];
  const duration = Number(parsed?.format?.duration || 0);
  if (!stream || stream.codec_name !== 'mp3' || !(duration > 0.5)) {
    throw new Error(`Invalid MP3 stream for ${filePath}: ${stdout}`);
  }
  return {
    bytes: info.size,
    duration,
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
  };
}

async function verifyAssets() {
  const musicPath = urlToPublicPath(MUSIC_TRACK_URL);
  const music = await probeMp3(musicPath);
  if (music.bytes > 1.5 * 1024 * 1024) {
    throw new Error(`Music track exceeds 1.5 MB: ${(music.bytes / 1024).toFixed(1)} KB`);
  }

  let totalRadioBytes = 0;
  let minDur = Infinity;
  let maxDur = 0;
  const categories = {};

  for (const clip of RADIO_CLIPS) {
    const mp3Path = urlToPublicPath(clip.url);
    const meta = await probeMp3(mp3Path);
    totalRadioBytes += meta.bytes;
    if (meta.duration < minDur) minDur = meta.duration;
    if (meta.duration > maxDur) maxDur = meta.duration;
    categories[clip.category] = (categories[clip.category] || 0) + 1;
  }

  const requiredCategories = [
    'mission_start',
    'hit_direct',
    'hit_partial',
    'miss_overshoot',
    'miss_short',
    'miss_wide',
    'help_cabin',
    'scoop_full',
    'mp_join',
    'chatter_misc',
    'fire_contained',
    'operation_advance',
    'damage_hit',
    'crash_respawn',
    'drop_too_high',
    'turbulence_smoke',
    'scoop_rough',
  ];
  for (const cat of requiredCategories) {
    if (!RADIO_CLIPS_BY_CATEGORY[cat] || RADIO_CLIPS_BY_CATEGORY[cat].length === 0) {
      throw new Error(`Missing required radio category: ${cat}`);
    }
  }

  return {
    music,
    clipCount: RADIO_CLIPS.length,
    totalRadioBytes,
    minDur,
    maxDur,
    categories,
  };
}

async function smokeTestRuntime() {
  const engine = new AudioEngine();
  engine.setMuted(true);
  engine.setMusicEnabled(true);
  engine.setMusicVolume(0.45);
  engine.setRadioVolume(0.9);
  engine.setSfxVolume(0.85);
  engine.duckMusic(true);
  engine.duckMusic(false);
  // Safe no-op calls without browser AudioContext
  engine.playDropOutcome('direct', 12);
  engine.playDropOutcome('partial', 4);
  engine.playDropOutcome('miss', 0);
  engine.playTargetLockPip(true);
  engine.playTargetLockPip(false);
  engine.playTreeHit();
  engine.playCrash();
  engine.playThermalWarningPip(0.8);
  engine.playScoopRoughSlap();
  engine.update({
    dt: 1 / 60,
    airspeedKmh: 165,
    throttle: 0.7,
    windSpeedKt: 16,
    scooping: true,
    scoopRough: true,
    turbulence: 0.75,
    smokeDensity: 0.8,
    heatDanger: 0.6,
  });

  const events = [];
  const radio = new RadioManager(engine);
  const unsub = radio.onTransmission((ev) => events.push(ev));

  // Low-priority ambient chatter should be preempted by urgent cabin call
  const lowClip = radio.trigger('chatter_misc', { priority: 'low' });
  if (!lowClip) throw new Error('Expected chatter_misc clip to start');
  const urgentClip = radio.trigger('cabin_at_risk', { priority: 'high' });
  if (!urgentClip || urgentClip.category !== 'help_cabin') {
    throw new Error('Expected cabin_at_risk alias to map to help_cabin');
  }
  const treeClip = radio.trigger('tree_hit');
  if (!treeClip || treeClip.category !== 'damage_hit') {
    throw new Error('Expected tree_hit alias to map to damage_hit');
  }
  const crashClip = radio.trigger('plane_crash', { priority: 'high' });
  if (!crashClip || crashClip.category !== 'crash_respawn') {
    throw new Error('Expected plane_crash alias to map to crash_respawn');
  }
  const highDropClip = radio.trigger('misted_high');
  if (!highDropClip || highDropClip.category !== 'drop_too_high') {
    throw new Error('Expected misted_high alias to map to drop_too_high');
  }
  const turbClip = radio.trigger('turbulence_smoke');
  if (!turbClip || turbClip.category !== 'turbulence_smoke') {
    throw new Error('Expected turbulence_smoke clip to trigger');
  }
  const turbRepeat = radio.trigger('turbulence_smoke');
  if (turbRepeat !== null) {
    throw new Error('Expected immediate repeat of turbulence_smoke to be suppressed by cooldown');
  }
  const roughClip = radio.trigger('scoop_rough');
  if (!roughClip || roughClip.category !== 'scoop_rough') {
    throw new Error('Expected scoop_rough clip to trigger');
  }

  // Verify drop_too_high immediately preempts an active turbulence_smoke advisory
  const preemptEvents = [];
  const radio2 = new RadioManager(engine);
  radio2.onTransmission((ev) => preemptEvents.push(ev));
  radio2.trigger('turbulence_smoke');
  radio2.trigger('drop_too_high');
  if (
    preemptEvents.length < 3 ||
    preemptEvents[0].category !== 'turbulence_smoke' ||
    preemptEvents[0].active !== true ||
    preemptEvents[1].category !== 'turbulence_smoke' ||
    preemptEvents[1].active !== false ||
    preemptEvents[2].category !== 'drop_too_high' ||
    preemptEvents[2].active !== true
  ) {
    throw new Error(`Expected drop_too_high to preempt turbulence_smoke immediately: ${JSON.stringify(preemptEvents)}`);
  }
  radio2.dispose();

  // Regression (#89 #5): _drainQueue() 280 ms gap race & full stale pruning
  {
    const gapEvents = [];
    const rGap = new RadioManager(engine);
    rGap.onTransmission((ev) => gapEvents.push(ev));

    // Queue a fresh high-priority alert AND a stale low-priority entry, then trigger _drainQueue()
    const now = Date.now();
    rGap._queue.push(
      { clip: RADIO_CLIPS_BY_CATEGORY.help_cabin[0], priority: 4, queuedAt: now },
      { clip: RADIO_CLIPS_BY_CATEGORY.scoop_full[0], priority: 1, queuedAt: now - 15000 },
    );
    rGap._drainQueue();
    // Stale entry behind index 0 must be pruned immediately
    if (rGap._queue.length !== 1 || rGap._queue[0].clip.category !== 'help_cabin') {
      throw new Error(`Expected full stale queue pruning, got ${rGap._queue.length} entries`);
    }
    if (rGap._drainTimer === null) {
      throw new Error('Expected _drainTimer to be scheduled during 280 ms gap');
    }
    // Priority-0 chatter arriving during the 280 ms gap must NOT drop or preempt queued help_cabin
    const ignored = rGap.trigger('chatter_misc', { priority: 'low' });
    if (ignored !== null) {
      throw new Error('Expected priority-0 chatter during drain gap to be ignored');
    }
    if (rGap._queue.length !== 1 || rGap._queue[0].clip.category !== 'help_cabin') {
      throw new Error('Expected help_cabin to remain intact in queue during drain gap');
    }
    // Wait for the 280 ms drain timer to fire
    await new Promise((r) => setTimeout(r, 340));
    if (!gapEvents.some((e) => e.category === 'help_cabin' && e.active === true)) {
      throw new Error(`Expected help_cabin to start after 280 ms drain gap: ${JSON.stringify(gapEvents)}`);
    }

    // Also verify higher-priority arrival during drain gap cancels _drainTimer and preserves lower item
    rGap._abortActive();
    rGap._queue.push({ clip: RADIO_CLIPS_BY_CATEGORY.scoop_full[0], priority: 1, queuedAt: Date.now() });
    rGap._drainQueue();
    rGap.trigger('crash_respawn', { priority: 'high' });
    if (rGap._drainTimer !== null) {
      throw new Error('Expected _drainTimer to be cancelled when urgent clip starts in gap');
    }
    if (!rGap._active || rGap._active.clip.category !== 'crash_respawn') {
      throw new Error('Expected crash_respawn to start immediately in drain gap');
    }
    if (rGap._queue.length !== 1 || rGap._queue[0].clip.category !== 'scoop_full') {
      throw new Error('Expected scoop_full to stay queued behind crash_respawn');
    }

    rGap.clearQueue();
    rGap.dispose();
  }

  // Regression (#89 #8): AudioEngine crashed engine cut, iOS 'interrupted' unlock, HTMLAudio radio mute/volume sync
  {
    const mockParam = () => ({
      value: 0,
      lastTarget: null,
      setTargetAtTime(v) {
        this.lastTarget = v;
        this.value = v;
      },
      setValueAtTime(v) {
        this.value = v;
      },
      cancelScheduledValues() {},
      linearRampToValueAtTime(v) {
        this.value = v;
      },
    });

    const e2 = new AudioEngine();
    let resumed = 0;
    const mockCtx = {
      state: 'interrupted',
      currentTime: 1.0,
      resume() {
        resumed++;
        this.state = 'running';
        return Promise.resolve();
      },
      close() {},
    };
    e2._ctx = mockCtx;
    e2._initialized = true;
    e2._masterGain = { gain: mockParam() };
    e2._sfxBusGain = { gain: mockParam() };
    e2._musicGain = { gain: mockParam() };
    e2._musicDuckGain = { gain: mockParam() };
    e2._radioGain = { gain: mockParam() };
    e2._windFilter = { frequency: mockParam() };
    e2._windGain = { gain: mockParam() };
    e2._engineSaw = { frequency: mockParam() };
    e2._engineSquare = { frequency: mockParam() };
    e2._engineFilter = { frequency: mockParam() };
    e2._engineGain = { gain: mockParam() };
    e2._propWashFilter = { frequency: mockParam() };
    e2._propWashGain = { gain: mockParam() };
    e2._fireRoarGain = { gain: mockParam() };
    e2._fireCrackleGain = { gain: mockParam() };
    e2._fireCrackleLfo = { frequency: mockParam() };
    e2._dropFilter = { frequency: mockParam() };
    e2._dropGain = { gain: mockParam() };
    e2._scoopGain = { gain: mockParam() };
    e2._scoopRoughGain = { gain: mockParam() };
    e2._scoopRoughLfo = { frequency: mockParam() };
    e2._turbBuffetFilter = { frequency: mockParam() };
    e2._turbBuffetLfo = { frequency: mockParam() };
    e2._turbBuffetGain = { gain: mockParam() };
    e2._turbRattleFilter = { frequency: mockParam() };
    e2._turbRattleLfo = { frequency: mockParam() };
    e2._turbRattleGain = { gain: mockParam() };
    e2._smokeWhooshFilter = { frequency: mockParam() };
    e2._smokeWhooshGain = { gain: mockParam() };

    const origWindow = globalThis.window;
    const origAudio = globalThis.Audio;
    try {
      globalThis.window = {};
      e2.unlock();
      if (resumed !== 1) {
        throw new Error(`Expected unlock() to resume iOS 'interrupted' AudioContext, resumed=${resumed}`);
      }

      // Crashed plane cuts engine & prop-wash gain cleanly to 0, then restores on respawn
      e2.update({ dt: 1 / 60, airspeedKmh: 160, throttle: 0.7, crashed: true });
      if (e2._engineGain.gain.lastTarget !== 0 || e2._propWashGain.gain.lastTarget !== 0) {
        throw new Error(
          `Expected crashed update() to silence engine/propWash, got ${e2._engineGain.gain.lastTarget}/${e2._propWashGain.gain.lastTarget}`,
        );
      }
      e2.update({ dt: 1 / 60, airspeedKmh: 160, throttle: 0.7, crashed: false });
      if (!(e2._engineGain.gain.lastTarget > 0) || !(e2._propWashGain.gain.lastTarget > 0)) {
        throw new Error('Expected non-crashed update() to restore engine/propWash gain');
      }

      // HTMLAudio radio fallback tracks _radioHtmlAudio and responds immediately to mute & volume changes
      let lastEl = null;
      globalThis.Audio = class FakeAudio {
        constructor(url) {
          this.url = url;
          this.volume = 1;
          this.paused = false;
          this.onended = null;
          this.onerror = null;
          lastEl = this;
        }
        play() {
          return Promise.resolve();
        }
        pause() {
          this.paused = true;
        }
      };

      e2.setMuted(false);
      e2.setRadioVolume(0.8);
      e2._ctx.state = 'suspended'; // force HTMLAudio fallback path
      const playPromise = e2.playRadioClip('./audio/radio/hit_direct_01.mp3');
      if (!lastEl || e2._radioHtmlAudio !== lastEl) {
        throw new Error('Expected _playRadioHtmlFallback to store this._radioHtmlAudio');
      }
      e2.setMuted(true);
      if (lastEl.volume !== 0) {
        throw new Error(`Expected setMuted(true) to zero fallback radio volume, got ${lastEl.volume}`);
      }
      e2.setMuted(false);
      e2.setRadioVolume(0.4);
      if (Math.abs(lastEl.volume - 0.4 * 0.85) > 0.005) {
        throw new Error(`Expected setRadioVolume(0.4) to sync fallback volume, got ${lastEl.volume}`);
      }
      lastEl.onended();
      await playPromise;
      if (e2._radioHtmlAudio !== null) {
        throw new Error('Expected _radioHtmlAudio to clear on clip end');
      }
    } finally {
      globalThis.window = origWindow;
      globalThis.Audio = origAudio;
      e2.dispose();
    }
  }

  // Cooldown suppression check (normal priority immediate repeat of help_cabin)
  const suppressed = radio.trigger('help_cabin');
  if (suppressed !== null) {
    throw new Error('Expected immediate repeat of help_cabin without high priority to be suppressed');
  }

  // Verify active:true and preemption active:false events fired
  const activeCount = events.filter((e) => e.active === true).length;
  const inactiveCount = events.filter((e) => e.active === false).length;
  if (activeCount < 2 || inactiveCount < 1) {
    throw new Error(`Unexpected transcript lifecycle events: active=${activeCount} inactive=${inactiveCount}`);
  }

  unsub();
  radio.dispose();
  engine.dispose();
}

const summary = await verifyAssets();
await smokeTestRuntime();

console.log('Audio asset verification PASSED!');
console.log(
  `Music: ${MUSIC_TRACK_URL} (${summary.music.duration.toFixed(2)}s, ${summary.music.sampleRate}Hz ${summary.music.channels}ch, ${(summary.music.bytes / 1024).toFixed(1)} KB)`,
);
console.log(
  `Radio: ${summary.clipCount} MP3 clips (${summary.minDur.toFixed(2)}s–${summary.maxDur.toFixed(2)}s, total ${(summary.totalRadioBytes / 1024).toFixed(1)} KB)`,
);
console.log('Category counts:', JSON.stringify(summary.categories));
