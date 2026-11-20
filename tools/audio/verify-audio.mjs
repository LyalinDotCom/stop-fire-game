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
