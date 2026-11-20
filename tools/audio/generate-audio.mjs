#!/usr/bin/env node
// Generates EMBER FRONT VHF aviation radio MP3 clips via `gemini-api tts` + `ffmpeg`.
// Usage: node tools/audio/generate-audio.mjs [--concurrency 6] [--force]

import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR = join(REPO_ROOT, 'public', 'audio', 'radio');
const MANIFEST_PATH = join(REPO_ROOT, 'src', 'audio', 'radioManifest.js');

export const SPEAKERS = {
  AIR_ATTACK: {
    speaker: 'AIR ATTACK 1',
    freq: '122.925',
    voice: 'Charon',
    defaultTag: 'calm, authoritative, brisk aviation radio',
  },
  HOTSHOT: {
    speaker: 'HOTSHOT ALPHA',
    freq: '168.200',
    voice: 'Fenrir',
    defaultTag: 'urgent, gritty, intense ground crew radio',
  },
  LOOKOUT: {
    speaker: 'LOOKOUT 04',
    freq: '168.650',
    voice: 'Kore',
    defaultTag: 'crisp, sharp, alert spotter radio',
  },
  DISPATCH: {
    speaker: 'DISPATCH',
    freq: '122.925',
    voice: 'Zephyr',
    defaultTag: 'clear, crisp, professional air dispatch',
  },
};

export const RADIO_LINES = [
  // mission_start (5)
  {
    id: 'mission_start_01',
    category: 'mission_start',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, authoritative, brisk',
    text: 'Air Attack One on station. Fire head is pushing north — hit the lake and scoop.',
  },
  {
    id: 'mission_start_02',
    category: 'mission_start',
    persona: 'DISPATCH',
    urgency: 'normal',
    tag: 'clear, crisp, professional',
    text: 'Basin Dispatch to inbound tanker, airspace is active. Skim the lake, then work the active flank.',
  },
  {
    id: 'mission_start_03',
    category: 'mission_start',
    persona: 'LOOKOUT',
    urgency: 'normal',
    tag: 'crisp, alert, brisk',
    text: 'Lookout Zero Four confirms heavy flame along the ridge. Visibility clear for low passes.',
  },
  {
    id: 'mission_start_04',
    category: 'mission_start',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, commanding, brisk',
    text: 'Tanker, welcome to the fireline. Fill your tank on the lake and knock down that main head.',
  },
  {
    id: 'mission_start_05',
    category: 'mission_start',
    persona: 'HOTSHOT',
    urgency: 'normal',
    tag: 'gritty, earnest, brisk',
    text: 'Hotshot Alpha on the ground — glad to hear props overhead! We need water on the lead edge.',
  },

  // hit_direct (7)
  {
    id: 'hit_direct_01',
    category: 'hit_direct',
    persona: 'AIR_ATTACK',
    urgency: 'success',
    tag: 'excited, authoritative, brisk',
    text: 'Direct hit right on the fire head! Flames are dropping fast!',
  },
  {
    id: 'hit_direct_02',
    category: 'hit_direct',
    persona: 'AIR_ATTACK',
    urgency: 'success',
    tag: 'enthusiastic, commanding',
    text: 'Beautiful curtain, Tanker! You just punched a solid break across the ridge!',
  },
  {
    id: 'hit_direct_03',
    category: 'hit_direct',
    persona: 'HOTSHOT',
    urgency: 'success',
    tag: 'relieved, pumped, gritty',
    text: "Right on top of it! Steam's billowing — that knocked the whole front down!",
  },
  {
    id: 'hit_direct_04',
    category: 'hit_direct',
    persona: 'LOOKOUT',
    urgency: 'success',
    tag: 'crisp, excited, sharp',
    text: 'Lookout confirms dead-center impact! Fire intensity just plunged in that sector!',
  },
  {
    id: 'hit_direct_05',
    category: 'hit_direct',
    persona: 'HOTSHOT',
    urgency: 'success',
    tag: 'grateful, gritty, energetic',
    text: 'Textbook drop, Tanker! You cooled the line right in front of our crew!',
  },
  {
    id: 'hit_direct_06',
    category: 'hit_direct',
    persona: 'AIR_ATTACK',
    urgency: 'success',
    tag: 'sharp, approving, brisk',
    text: 'Bullseye drop! That wet line is holding the spread — keep hammering it!',
  },
  {
    id: 'hit_direct_07',
    category: 'hit_direct',
    persona: 'DISPATCH',
    urgency: 'success',
    tag: 'crisp, upbeat, professional',
    text: 'Solid direct strike logged on the main front. Outstanding airmanship, Tanker!',
  },

  // hit_partial (5)
  {
    id: 'hit_partial_01',
    category: 'hit_partial',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, coaching, brisk',
    text: 'Clipped the edge of the front — good knock, adjust slightly closer to the core next run.',
  },
  {
    id: 'hit_partial_02',
    category: 'hit_partial',
    persona: 'LOOKOUT',
    urgency: 'normal',
    tag: 'crisp, focused, brisk',
    text: 'Partial hit on the flank! You slowed the corner, tighten your line on the next pass.',
  },
  {
    id: 'hit_partial_03',
    category: 'hit_partial',
    persona: 'HOTSHOT',
    urgency: 'normal',
    tag: 'gritty, encouraging, brisk',
    text: 'Got part of it! Edge is steaming, push a little deeper into the bright flames next drop.',
  },
  {
    id: 'hit_partial_04',
    category: 'hit_partial',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, steady, brisk',
    text: 'Nice graze along the perimeter — center your green reticle over the head next time.',
  },
  {
    id: 'hit_partial_05',
    category: 'hit_partial',
    persona: 'LOOKOUT',
    urgency: 'normal',
    tag: 'sharp, alert, brisk',
    text: 'Good partial knock on the ridge smoke. One more centered pass should break it.',
  },

  // miss_overshoot (4)
  {
    id: 'miss_overshoot_01',
    category: 'miss_overshoot',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'firm, instructive, brisk',
    text: 'Water landed long past the fire head — release a second earlier on your next pass!',
  },
  {
    id: 'miss_overshoot_02',
    category: 'miss_overshoot',
    persona: 'LOOKOUT',
    urgency: 'warn',
    tag: 'sharp, direct, brisk',
    text: 'That drop overshot into green timber. Pull the trigger earlier before you cross the flames.',
  },
  {
    id: 'miss_overshoot_03',
    category: 'miss_overshoot',
    persona: 'HOTSHOT',
    urgency: 'warn',
    tag: 'urgent, gritty, brisk',
    text: 'Went long behind the front, Tanker! Drop a beat sooner to catch the active edge.',
  },
  {
    id: 'miss_overshoot_04',
    category: 'miss_overshoot',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'calm, tactical, brisk',
    text: 'Slightly long on that release — watch your ground ring and hit Space as it turns green.',
  },

  // miss_short (4)
  {
    id: 'miss_short_01',
    category: 'miss_short',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'firm, instructive, brisk',
    text: 'Drop came up short of the line — hold release a beat longer over the flames!',
  },
  {
    id: 'miss_short_02',
    category: 'miss_short',
    persona: 'LOOKOUT',
    urgency: 'warn',
    tag: 'sharp, alert, brisk',
    text: 'Water splashed short of the fire head. Carry it a little deeper before you open the doors.',
  },
  {
    id: 'miss_short_03',
    category: 'miss_short',
    persona: 'HOTSHOT',
    urgency: 'warn',
    tag: 'urgent, gritty, brisk',
    text: 'Came up short on our side! Hold a moment longer and lay it right across the embers.',
  },
  {
    id: 'miss_short_04',
    category: 'miss_short',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'calm, tactical, brisk',
    text: 'Early release, Tanker — wait until your drop marker locks onto the flames.',
  },

  // miss_wide (4)
  {
    id: 'miss_wide_01',
    category: 'miss_wide',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'firm, instructive, brisk',
    text: 'Crosswind pushed that drop wide of the front — lead upwind next pass!',
  },
  {
    id: 'miss_wide_02',
    category: 'miss_wide',
    persona: 'LOOKOUT',
    urgency: 'warn',
    tag: 'crisp, urgent, brisk',
    text: 'Water drifted off the flank! Compensate for the basin wind and line up tighter.',
  },
  {
    id: 'miss_wide_03',
    category: 'miss_wide',
    persona: 'HOTSHOT',
    urgency: 'warn',
    tag: 'gritty, urgent, brisk',
    text: 'Missed wide to the side, Tanker — check the wind drift and swing back around.',
  },
  {
    id: 'miss_wide_04',
    category: 'miss_wide',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    tag: 'calm, tactical, brisk',
    text: 'Off centerline on that run — bank onto the fire head and watch for the green lock.',
  },

  // help_cabin (7)
  {
    id: 'help_cabin_01',
    category: 'help_cabin',
    persona: 'HOTSHOT',
    urgency: 'urgent',
    tag: 'urgent, intense, fast-paced',
    text: 'Air Attack, cabins on the north clearing are taking heavy embers — need water NOW!',
  },
  {
    id: 'help_cabin_02',
    category: 'help_cabin',
    persona: 'HOTSHOT',
    urgency: 'urgent',
    tag: 'urgent, desperate, fast-paced',
    text: 'Hotshot Alpha here, flame front pushing right into the settlement — drop on our smoke!',
  },
  {
    id: 'help_cabin_03',
    category: 'help_cabin',
    persona: 'LOOKOUT',
    urgency: 'urgent',
    tag: 'urgent, sharp, fast-paced',
    text: 'Priority alert! Fire is crowning fifty meters from the timber cabins — divert immediately!',
  },
  {
    id: 'help_cabin_04',
    category: 'help_cabin',
    persona: 'DISPATCH',
    urgency: 'urgent',
    tag: 'urgent, crisp, commanding',
    text: 'All tankers, structure threat active! Protect the threatened cabins before the roof line catches!',
  },
  {
    id: 'help_cabin_05',
    category: 'help_cabin',
    persona: 'HOTSHOT',
    urgency: 'urgent',
    tag: 'urgent, stressed, gritty',
    text: 'Embers showering the cabin roofs! Any loaded tanker, lay a wet line right across the clearing!',
  },
  {
    id: 'help_cabin_06',
    category: 'help_cabin',
    persona: 'AIR_ATTACK',
    urgency: 'urgent',
    tag: 'urgent, commanding, brisk',
    text: 'Break off the ridge, Tanker! Cabins are in danger — box them off with water ASAP!',
  },
  {
    id: 'help_cabin_07',
    category: 'help_cabin',
    persona: 'LOOKOUT',
    urgency: 'urgent',
    tag: 'urgent, sharp, alert',
    text: 'Urgent from Lookout Four — spotting right beside the cabin cluster, we need a drop fast!',
  },

  // scoop_full (4)
  {
    id: 'scoop_full_01',
    category: 'scoop_full',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, brisk, encouraging',
    text: 'Clean skim on the lake, tank is full — climb out and hit the head!',
  },
  {
    id: 'scoop_full_02',
    category: 'scoop_full',
    persona: 'DISPATCH',
    urgency: 'normal',
    tag: 'clear, crisp, professional',
    text: "Full load confirmed from the basin lake. You're cleared straight back to the fireline.",
  },
  {
    id: 'scoop_full_03',
    category: 'scoop_full',
    persona: 'LOOKOUT',
    urgency: 'normal',
    tag: 'crisp, upbeat, brisk',
    text: "Nice water pickup, Tanker! Smoke's building on the ridge whenever you're ready.",
  },
  {
    id: 'scoop_full_04',
    category: 'scoop_full',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    tag: 'calm, authoritative, brisk',
    text: 'Doors sealed, tanks topped off — bring that load straight to the orange line.',
  },

  // mp_join (4)
  {
    id: 'mp_join_01',
    category: 'mp_join',
    persona: 'DISPATCH',
    urgency: 'info',
    tag: 'clear, welcoming, professional',
    text: 'New tanker entering basin airspace — welcome to the fireline, wingman!',
  },
  {
    id: 'mp_join_02',
    category: 'mp_join',
    persona: 'AIR_ATTACK',
    urgency: 'info',
    tag: 'authoritative, brisk',
    text: 'Additional air tanker on station — coordinate drops on the active head!',
  },
  {
    id: 'mp_join_03',
    category: 'mp_join',
    persona: 'LOOKOUT',
    urgency: 'info',
    tag: 'crisp, upbeat, alert',
    text: 'Visual on inbound reinforcement tanker! Great to have another set of wings up there.',
  },
  {
    id: 'mp_join_04',
    category: 'mp_join',
    persona: 'DISPATCH',
    urgency: 'info',
    tag: 'crisp, professional, brisk',
    text: 'Squadron update — another water bomber just joined the frequency. Keep spacing safe.',
  },

  // chatter_misc (7)
  {
    id: 'chatter_misc_01',
    category: 'chatter_misc',
    persona: 'LOOKOUT',
    urgency: 'low',
    tag: 'crisp, steady, matter-of-fact',
    text: 'Lookout Four weather check — upper winds gusting twelve knots across the valley.',
  },
  {
    id: 'chatter_misc_02',
    category: 'chatter_misc',
    persona: 'AIR_ATTACK',
    urgency: 'low',
    tag: 'calm, steady, authoritative',
    text: 'Air Attack holding high orbit at two thousand feet. Smoke column leaning east.',
  },
  {
    id: 'chatter_misc_03',
    category: 'chatter_misc',
    persona: 'HOTSHOT',
    urgency: 'low',
    tag: 'gritty, determined, steady',
    text: 'Hotshot Alpha cutting handline along the south creek. Keep those drops coming, tankers.',
  },
  {
    id: 'chatter_misc_04',
    category: 'chatter_misc',
    persona: 'DISPATCH',
    urgency: 'low',
    tag: 'clear, professional, calm',
    text: 'Basin Dispatch reminds all crews to maintain lake scoop separation on final approach.',
  },
  {
    id: 'chatter_misc_05',
    category: 'chatter_misc',
    persona: 'LOOKOUT',
    urgency: 'low',
    tag: 'crisp, observant, calm',
    text: 'Thermal inversion is lifting — visibility over the lower timber just improved.',
  },
  {
    id: 'chatter_misc_06',
    category: 'chatter_misc',
    persona: 'AIR_ATTACK',
    urgency: 'low',
    tag: 'calm, advisory, brisk',
    text: 'Watch for rising smoke turbulence over the hot core. Keep airspeed up in your turns.',
  },
  {
    id: 'chatter_misc_07',
    category: 'chatter_misc',
    persona: 'HOTSHOT',
    urgency: 'low',
    tag: 'gritty, steady, focused',
    text: 'Ground crews holding steady on the wet line. That last barrier is slowing the crawl.',
  },

  // fire_contained (2)
  {
    id: 'fire_contained_01',
    category: 'fire_contained',
    persona: 'AIR_ATTACK',
    urgency: 'success',
    tag: 'triumphant, authoritative, warm',
    text: 'Fire contained! Outstanding work, squadron — the basin is safe!',
  },
  {
    id: 'fire_contained_02',
    category: 'fire_contained',
    persona: 'DISPATCH',
    urgency: 'success',
    tag: 'crisp, celebratory, professional',
    text: 'All hot spots knocked down! Dispatch confirms full containment across the sector!',
  },

  // operation_advance (2)
  {
    id: 'operation_advance_01',
    category: 'operation_advance',
    persona: 'DISPATCH',
    urgency: 'info',
    text: 'New wildfire outbreak detected in the next sector — rolling squadron to the next operation!',
  },
  {
    id: 'operation_advance_02',
    category: 'operation_advance',
    persona: 'AIR_ATTACK',
    urgency: 'info',
    text: 'Air Attack moving on station for the next operation. Top off your tanks and stay sharp!',
  },

  // damage_hit (3) — tree/canopy hull strike warnings
  {
    id: 'damage_hit_01',
    category: 'damage_hit',
    persona: 'AIR_ATTACK',
    urgency: 'urgent',
    text: 'Watch your altitude, Tanker! You clipped the treetops — pull up immediately!',
  },
  {
    id: 'damage_hit_02',
    category: 'damage_hit',
    persona: 'LOOKOUT',
    urgency: 'urgent',
    text: 'Tree strike confirmed on the ridge! Check hull integrity and climb clear of the canopy!',
  },
  {
    id: 'damage_hit_03',
    category: 'damage_hit',
    persona: 'DISPATCH',
    urgency: 'urgent',
    text: 'Tanker, we see wing impact through the pines! Keep nose up over the timberline!',
  },

  // crash_respawn (3) — airframe lost / reserve tanker inbound
  {
    id: 'crash_respawn_01',
    category: 'crash_respawn',
    persona: 'DISPATCH',
    urgency: 'urgent',
    text: 'Mayday, airframe down in the basin! Scrambling reserve tanker to the perimeter corridor!',
  },
  {
    id: 'crash_respawn_02',
    category: 'crash_respawn',
    persona: 'AIR_ATTACK',
    urgency: 'urgent',
    text: 'Tanker down on the slope! Reserve aircraft inbound — watch your clearance on re-entry!',
  },
  {
    id: 'crash_respawn_03',
    category: 'crash_respawn',
    persona: 'HOTSHOT',
    urgency: 'urgent',
    text: 'We saw that bird go down! Reserve tanker launching now — get back up here, pilot!',
  },

  // drop_too_high (3) — altitude envelope coaching when water mists from high drop
  {
    id: 'drop_too_high_01',
    category: 'drop_too_high',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    text: 'Way too high, Tanker! Wind sheared that load into mist — drop down to thirty meters!',
  },
  {
    id: 'drop_too_high_02',
    category: 'drop_too_high',
    persona: 'LOOKOUT',
    urgency: 'warn',
    text: 'Water evaporated before hitting the crown! Descend into the twenty-five to fifty meter window!',
  },
  {
    id: 'drop_too_high_03',
    category: 'drop_too_high',
    persona: 'HOTSHOT',
    urgency: 'warn',
    text: 'We barely felt mist down here! Come in lower over the ridge so that curtain punches through!',
  },

  // turbulence_smoke (3) — convective smoke plume turbulence & thermal shear advisories
  {
    id: 'turbulence_smoke_01',
    category: 'turbulence_smoke',
    persona: 'AIR_ATTACK',
    urgency: 'warn',
    text: 'Heavy convective turbulence in the smoke column! Watch for updrafts and hold your wings level!',
  },
  {
    id: 'turbulence_smoke_02',
    category: 'turbulence_smoke',
    persona: 'LOOKOUT',
    urgency: 'warn',
    text: 'Dense smoke plume across the head — keep airspeed up and watch for thermal shear!',
  },
  {
    id: 'turbulence_smoke_03',
    category: 'turbulence_smoke',
    persona: 'DISPATCH',
    urgency: 'warn',
    text: 'Advisory for all tankers: severe thermal lift over the active core. Avoid skimming inside the flames!',
  },

  // scoop_rough (2) — rough/choppy banked or overspeed lake scoop coaching
  {
    id: 'scoop_rough_01',
    category: 'scoop_rough',
    persona: 'AIR_ATTACK',
    urgency: 'normal',
    text: 'Choppy scoop, Tanker! Level your wings and ease the throttle for a faster lake pickup.',
  },
  {
    id: 'scoop_rough_02',
    category: 'scoop_rough',
    persona: 'DISPATCH',
    urgency: 'normal',
    text: 'Rough water contact on the skim — keep wings level and steady speed for maximum intake!',
  },
];

async function fileExistsNonEmpty(p) {
  try {
    const s = await stat(p);
    return s.size > 1000;
  } catch {
    return false;
  }
}

async function probeDurationMs(mp3Path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_name',
    '-of', 'json',
    mp3Path,
  ]);
  const parsed = JSON.parse(stdout);
  const codec = parsed?.streams?.[0]?.codec_name;
  const durationSec = Number(parsed?.format?.duration || 0);
  if (codec !== 'mp3' || !(durationSec > 0.4)) {
    throw new Error(`Invalid MP3 ${mp3Path}: codec=${codec} duration=${durationSec}`);
  }
  return Math.round(durationSec * 1000);
}

async function processVhfMp3(rawWavPath, outMp3Path) {
  // Aviation VHF chain:
  // 1. Trim leading/trailing silence cleanly
  // 2. Band-limit 320 Hz – 2900 Hz + aviation mic midrange presence (+3.5 dB @ 1500 Hz)
  // 3. Punchy voice compression + soft limiter
  // 4. Subtle pink RF carrier hiss bed mixed behind speech
  // 5. Crisp PTT key-up click (45 ms) + authentic VHF squelch burst tail (110 ms)
  // 6. Mono 24 kHz 40 kbps MP3 (~12–22 KB/clip)
  const filterComplex = [
    '[0:a]aresample=24000,aformat=channel_layouts=mono,' +
      'silenceremove=start_periods=1:start_duration=0.02:start_threshold=-40dB:detection=peak,' +
      'areverse,' +
      'silenceremove=start_periods=1:start_duration=0.02:start_threshold=-40dB:detection=peak,' +
      'areverse,' +
      'highpass=f=320:poles=2,lowpass=f=2900:poles=2,' +
      'equalizer=f=1500:t=q:w=1.2:g=3.5,' +
      'equalizer=f=700:t=q:w=1.1:g=1.2,' +
      'acompressor=threshold=-20dB:ratio=4.5:attack=4:release=65:makeup=4.5dB,' +
      'alimiter=limit=0.86:attack=2:release=25[voice]',
    'anoisesrc=c=pink:r=24000:a=0.017:d=20,highpass=f=450,lowpass=f=3100[rf]',
    '[voice][rf]amix=inputs=2:duration=shortest:normalize=0[tx]',
    'anoisesrc=c=white:r=24000:a=0.14:d=0.045,highpass=f=850,lowpass=f=3200,afade=t=out:st=0.008:d=0.037[ptt]',
    'anoisesrc=c=white:r=24000:a=0.15:d=0.105,highpass=f=1100,lowpass=f=3500,afade=t=in:st=0:d=0.004,afade=t=out:st=0.022:d=0.083[sq]',
    '[ptt][tx][sq]concat=n=3:v=0:a=1,alimiter=limit=0.90[out]',
  ].join(';');

  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', rawWavPath,
    '-filter_complex', filterComplex,
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-ac', '1',
    '-ar', '24000',
    '-b:a', '40k',
    outMp3Path,
  ]);
}

async function generateOne(line, scratchDir, force) {
  const persona = SPEAKERS[line.persona];
  const outMp3Path = join(OUT_DIR, `${line.id}.mp3`);

  if (!force && (await fileExistsNonEmpty(outMp3Path))) {
    const durationMs = await probeDurationMs(outMp3Path);
    const { size } = await stat(outMp3Path);
    return { ...line, speaker: persona.speaker, freq: persona.freq, durationMs, bytes: size, cached: true };
  }

  const rawWavPath = join(scratchDir, `${line.id}.wav`);
  const promptText = line.text;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync('gemini-api', [
        'tts',
        promptText,
        '-v', persona.voice,
        '--language', 'en-US',
        '--out', rawWavPath,
      ], { maxBuffer: 10 * 1024 * 1024 });

      await processVhfMp3(rawWavPath, outMp3Path);
      const durationMs = await probeDurationMs(outMp3Path);
      const { size } = await stat(outMp3Path);
      await rm(rawWavPath, { force: true });
      return { ...line, speaker: persona.speaker, freq: persona.freq, durationMs, bytes: size, cached: false };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
  }
  throw new Error(`Failed ${line.id} after 3 attempts: ${lastErr?.message || lastErr}`);
}

function buildManifestSource(results) {
  const lines = results.map((r) => ({
    id: r.id,
    category: r.category,
    speaker: r.speaker,
    freq: r.freq,
    urgency: r.urgency,
    text: r.text,
    url: `./audio/radio/${r.id}.mp3`,
    durationMs: r.durationMs,
  }));

  return `// Auto-generated VHF aviation radio clip catalog for EMBER FRONT.
// Regenerate clips with: node tools/audio/generate-audio.mjs

export const MUSIC_TRACK_URL = './audio/music/ember-front-theme.mp3';

export const RADIO_CHANNELS = Object.freeze({
  AIR_TACTICAL: '122.925',
  GROUND_CREW: '168.200',
  LOOKOUT_NET: '168.650',
});

export const RADIO_CLIPS = Object.freeze(${JSON.stringify(lines, null, 2)});

export const RADIO_CLIPS_BY_CATEGORY = Object.freeze(
  RADIO_CLIPS.reduce((acc, clip) => {
    if (!acc[clip.category]) acc[clip.category] = [];
    acc[clip.category].push(clip);
    return acc;
  }, {}),
);

export const RADIO_CLIPS_BY_ID = Object.freeze(
  RADIO_CLIPS.reduce((acc, clip) => {
    acc[clip.id] = clip;
    return acc;
  }, {}),
);
`;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const concIdx = args.indexOf('--concurrency');
  const concurrency = concIdx >= 0 ? Math.max(1, Number(args[concIdx + 1]) || 6) : 6;

  await mkdir(OUT_DIR, { recursive: true });
  const scratchDir = join(tmpdir(), `ember-front-tts-${Date.now()}`);
  await mkdir(scratchDir, { recursive: true });

  console.log(`Generating ${RADIO_LINES.length} VHF radio clips (concurrency=${concurrency}, force=${force})...`);

  const results = new Array(RADIO_LINES.length);
  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (nextIdx < RADIO_LINES.length) {
      const idx = nextIdx++;
      const line = RADIO_LINES[idx];
      const res = await generateOne(line, scratchDir, force);
      results[idx] = res;
      completed++;
      const kb = (res.bytes / 1024).toFixed(1);
      const sec = (res.durationMs / 1000).toFixed(2);
      console.log(`[${completed}/${RADIO_LINES.length}] ${res.id} (${res.speaker} ${res.freq}) ${sec}s ${kb}KB${res.cached ? ' [cached]' : ''}`);
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await writeFile(MANIFEST_PATH, buildManifestSource(results), 'utf8');
    const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
    console.log(`\nDone! ${results.length} clips written to public/audio/radio/ (total ${(totalBytes / 1024).toFixed(1)} KB).`);
    console.log(`Manifest updated: src/audio/radioManifest.js`);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
