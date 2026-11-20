// Compact binary and JSON wire codecs for EMBER FRONT 100-player RTDB multiplayer.
// Strictly satisfies every payload size budget in database.rules.json:
// - in/$uid.d:      <= 72 chars   (9-int JSON tuple)
// - planes.p:       <= 1650 chars (12 B/plane Base64 -> 100 planes = 1,200 B = 1,600 B64 chars)
// - fireRing/$s.d:  <= 2048 chars (3 B/cell Base64 + wind/cabins/scoreHits/missionScore JSON)
// - fireKey.d:      <= 12288 chars (4-bit nibble RLE + cabins/wind/wave/scores JSON)
// - meta.d:         <= 1024 chars (wave/score/stats/top10 JSON)

import { PAYLOAD_CAPS } from './config.js';

export const PLANE_FLAG_RELEASING = 1 << 0;
export const PLANE_FLAG_SCOOPING = 1 << 1;
export const PLANE_FLAG_AUTOPILOT = 1 << 2;
export const PLANE_FLAG_STALL_OR_BOUNCE = 1 << 3;
export const PLANE_FLAG_OUT_OF_BOUNDS = 1 << 4;

export const PLANE_STRIDE_BYTES = 12;
export const FIRE_CELL_STRIDE_BYTES = 3;

const STATUS_TO_CODE = { active: 0, victory: 1, defeat: 2, intermission: 3 };
const CODE_TO_STATUS = ['active', 'victory', 'defeat', 'intermission'];

const KIND_TO_CODE = { cell: 0, assist: 1, cabin: 2 };
const CODE_TO_KIND = ['cell', 'assist', 'cabin'];

const OUTCOME_TO_CODE = { direct: 0, partial: 1, miss: 2 };
const CODE_TO_OUTCOME = ['direct', 'partial', 'miss'];

const MISS_TO_CODE = { none: 0, overshot: 1, short: 2, wide: 3 };
const CODE_TO_MISS = ['none', 'overshot', 'short', 'wide'];

const DIR_TO_CODE = { '': 0, N: 1, NE: 2, E: 3, SE: 4, S: 5, SW: 6, W: 7, NW: 8 };
const CODE_TO_DIR = ['', 'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const QUALITY_TO_CODE = { optimal: 0, misted_high: 1, low_risk: 2 };
const CODE_TO_QUALITY = ['optimal', 'misted_high', 'low_risk'];

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function wrap360(deg) {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/** Fast Base64 encoder working identically in browsers and Node.js. */
export function bytesToBase64(bytes) {
  if (bytes.length === 0) return '';
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(bin);
}

/** Fast Base64 decoder working identically in browsers and Node.js. */
export function base64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function packPlaneFlags(state) {
  let fl = 0;
  if (state.releasing) fl |= PLANE_FLAG_RELEASING;
  if (state.scooping) fl |= PLANE_FLAG_SCOOPING;
  if (state.autopilot) fl |= PLANE_FLAG_AUTOPILOT;
  if (state.stallWarn || (state.bounceTimer > 0) || state.crashed) fl |= PLANE_FLAG_STALL_OR_BOUNCE;
  if (state.outOfBounds) fl |= PLANE_FLAG_OUT_OF_BOUNDS;
  return fl;
}

export function encodeWind(windDirDeg = 90, windSpeedKt = 12) {
  const dirByte = Math.round((wrap360(windDirDeg) / 360) * 255) & 0xff;
  const ktByte = Math.round(clamp(windSpeedKt, 0, 63.75) * 4) & 0xff;
  return [dirByte, ktByte];
}

export function decodeWind(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return { windDirDeg: 90, windSpeedKt: 12 };
  const dirByte = clamp(Number(pair[0]) || 0, 0, 255);
  const ktByte = clamp(Number(pair[1]) || 0, 0, 255);
  return {
    windDirDeg: (dirByte / 255) * 360,
    windSpeedKt: ktByte / 4,
  };
}

/**
 * Encode local pilot state to a 9-int JSON tuple string (<= 72 chars):
 * "[x,y,z,yaw,pitch,roll,spd,fl,dropSeq]"
 */
export function encodeInput(state, dropSeq = 0) {
  const x = Math.round(clamp(state.x ?? 0, -3276, 3276) * 10);
  const y = Math.round(clamp(state.y ?? 0, 0, 6553) * 10);
  const z = Math.round(clamp(state.z ?? 0, -3276, 3276) * 10);
  const yaw = Math.round(wrap360(state.yawDeg ?? 0) * 10) % 3600;
  const pitch = Math.round(clamp(state.pitchDeg ?? 0, -90, 90) * 10);
  const roll = Math.round(clamp(state.rollDeg ?? 0, -90, 90) * 10);
  const spd = Math.round(clamp(state.speedKmh ?? 158, 0, 300));
  const fl = typeof state.flags === 'number' ? (state.flags & 0x1f) : packPlaneFlags(state);
  const ds = Math.max(0, Math.floor(dropSeq)) & 0xffff;
  const str = `[${x},${y},${z},${yaw},${pitch},${roll},${spd},${fl},${ds}]`;
  if (str.length > PAYLOAD_CAPS.input) {
    throw new Error(`encodeInput exceeded ${PAYLOAD_CAPS.input} chars (${str.length})`);
  }
  return str;
}

/** Decode 9-int JSON tuple string from `in/$uid.d`. */
export function decodeInput(str) {
  if (typeof str !== 'string' || str.length > PAYLOAD_CAPS.input) return null;
  let arr;
  try {
    arr = JSON.parse(str);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length !== 9) return null;
  for (let i = 0; i < 9; i++) {
    if (typeof arr[i] !== 'number' || !Number.isFinite(arr[i])) return null;
  }
  const fl = arr[7] | 0;
  return {
    x: arr[0] / 10,
    y: arr[1] / 10,
    z: arr[2] / 10,
    yawDeg: wrap360(arr[3] / 10),
    pitchDeg: clamp(arr[4] / 10, -90, 90),
    rollDeg: clamp(arr[5] / 10, -90, 90),
    speedKmh: clamp(arr[6], 0, 300),
    flags: fl & 0x1f,
    releasing: (fl & PLANE_FLAG_RELEASING) !== 0,
    scooping: (fl & PLANE_FLAG_SCOOPING) !== 0,
    autopilot: (fl & PLANE_FLAG_AUTOPILOT) !== 0,
    stallWarn: (fl & PLANE_FLAG_STALL_OR_BOUNCE) !== 0,
    outOfBounds: (fl & PLANE_FLAG_OUT_OF_BOUNDS) !== 0,
    dropSeq: Math.max(0, arr[8] | 0) & 0xffff,
  };
}

/**
 * Pack up to 100 planes into 12 bytes/plane Base64 (100 planes = 1,200 B = 1,600 B64 chars <= 1650).
 * Layout per plane (12 bytes):
 *   0:     slotId:u8 (0..99)
 *   1..2:  x:i16LE (0.1 m)
 *   3..4:  z:i16LE (0.1 m)
 *   5..6:  y:u16LE (0.1 m)
 *   7..9:  yaw10 | (pitch7 << 10) | (roll7 << 17) (24-bit LE)
 *   10..11: spd6 | (tank5 << 6) | (flags5 << 11) (16-bit LE)
 */
export function encodePlanes(planes) {
  const list = Array.isArray(planes) ? planes : [];
  const count = Math.min(list.length, 100);
  const bytes = new Uint8Array(count * PLANE_STRIDE_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < count; i++) {
    const p = list[i];
    const o = i * PLANE_STRIDE_BYTES;

    const slotId = clamp(Math.floor(p.slotId ?? 0), 0, 99);
    const x10 = Math.round(clamp(p.x ?? 0, -3276.7, 3276.7) * 10);
    const z10 = Math.round(clamp(p.z ?? 0, -3276.7, 3276.7) * 10);
    const y10 = Math.round(clamp(p.y ?? 0, 0, 6553.5) * 10);

    const yaw10 = Math.round((wrap360(p.yawDeg ?? 0) / 360) * 1024) & 0x3ff;
    const pitch7 = Math.round(((clamp(p.pitchDeg ?? 0, -60, 60) + 60) / 120) * 127) & 0x7f;
    const roll7 = Math.round(((clamp(p.rollDeg ?? 0, -64, 64) + 64) / 128) * 127) & 0x7f;
    const rot24 = yaw10 | (pitch7 << 10) | (roll7 << 17);

    const rawSpd = p.speedKmh ?? 158;
    const isCrashed = Boolean(p.crashed) || rawSpd < 40;
    const spd6 = isCrashed
      ? 0
      : (Math.round((clamp(rawSpd, 92, 216) - 92) / 2) + 1) & 0x3f;
    const tank5 = Math.round((clamp(p.tankPct ?? 100, 0, 100) / 100) * 31) & 0x1f;
    const flags5 = (typeof p.flags === 'number' ? p.flags : packPlaneFlags(p)) & 0x1f;
    const aux16 = spd6 | (tank5 << 6) | (flags5 << 11);

    bytes[o] = slotId;
    view.setInt16(o + 1, x10, true);
    view.setInt16(o + 3, z10, true);
    view.setUint16(o + 5, y10, true);
    bytes[o + 7] = rot24 & 0xff;
    bytes[o + 8] = (rot24 >>> 8) & 0xff;
    bytes[o + 9] = (rot24 >>> 16) & 0xff;
    view.setUint16(o + 10, aux16, true);
  }

  return bytesToBase64(bytes);
}

/** Decode packed 12 B/plane Base64 string back into plane pose objects. */
export function decodePlanes(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return [];
  const bytes = base64ToBytes(b64);
  if (bytes.length % PLANE_STRIDE_BYTES !== 0) {
    throw new Error(`decodePlanes invalid byte length ${bytes.length}`);
  }
  const count = bytes.length / PLANE_STRIDE_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array(count);

  for (let i = 0; i < count; i++) {
    const o = i * PLANE_STRIDE_BYTES;
    const slotId = bytes[o];
    const x = view.getInt16(o + 1, true) / 10;
    const z = view.getInt16(o + 3, true) / 10;
    const y = view.getUint16(o + 5, true) / 10;

    const rot24 = bytes[o + 7] | (bytes[o + 8] << 8) | (bytes[o + 9] << 16);
    const yaw10 = rot24 & 0x3ff;
    const pitch7 = (rot24 >>> 10) & 0x7f;
    const roll7 = (rot24 >>> 17) & 0x7f;

    const aux16 = view.getUint16(o + 10, true);
    const spd6 = aux16 & 0x3f;
    const tank5 = (aux16 >>> 6) & 0x1f;
    const flags5 = (aux16 >>> 11) & 0x1f;

    out[i] = {
      slotId,
      x,
      y,
      z,
      yawDeg: (yaw10 / 1024) * 360,
      pitchDeg: (pitch7 / 127) * 120 - 60,
      rollDeg: (roll7 / 127) * 128 - 64,
      speedKmh: spd6 === 0 ? 0 : 92 + (spd6 - 1) * 2,
      crashed: spd6 === 0,
      tankPct: (tank5 / 31) * 100,
      flags: flags5,
      releasing: (flags5 & PLANE_FLAG_RELEASING) !== 0,
      scooping: (flags5 & PLANE_FLAG_SCOOPING) !== 0,
      autopilot: (flags5 & PLANE_FLAG_AUTOPILOT) !== 0,
      stallWarn: (flags5 & PLANE_FLAG_STALL_OR_BOUNCE) !== 0,
      outOfBounds: (flags5 & PLANE_FLAG_OUT_OF_BOUNDS) !== 0,
    };
  }
  return out;
}

/** Prioritize high-visibility fire cell transitions (extinguish, char, ember spot, ignition) before intensity ticks. */
function cellPriority(state) {
  if (state === 13 || state === 14 || state === 15) return 0; // extinguish, char, ember warning
  if (state === 0) return 1; // cooled back to intact
  if (state <= 4) return 2; // fresh ignition
  return 3; // ongoing intensity ramp
}

function packFireCells(cells) {
  const bytes = new Uint8Array(cells.length * FIRE_CELL_STRIDE_BYTES);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const idx = c.idx & 0x7fff;
    const state = c.state & 0x0f;
    const phase = Math.min(31, Math.max(0, Math.round(c.phase ?? 0))) & 0x1f;
    const packed = idx | (state << 15) | (phase << 19);
    const o = i * FIRE_CELL_STRIDE_BYTES;
    bytes[o] = packed & 0xff;
    bytes[o + 1] = (packed >>> 8) & 0xff;
    bytes[o + 2] = (packed >>> 16) & 0xff;
  }
  return bytesToBase64(bytes);
}

function unpackFireCells(b64) {
  if (!b64) return [];
  const bytes = base64ToBytes(b64);
  if (bytes.length % FIRE_CELL_STRIDE_BYTES !== 0) {
    throw new Error(`decodeFireDelta invalid cell bytes ${bytes.length}`);
  }
  const count = bytes.length / FIRE_CELL_STRIDE_BYTES;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * FIRE_CELL_STRIDE_BYTES;
    const packed = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    out[i] = {
      idx: packed & 0x7fff,
      state: (packed >>> 15) & 0x0f,
      phase: (packed >>> 19) & 0x1f,
    };
  }
  return out;
}

/**
 * Encode a 2 Hz fire delta into a JSON string strictly <= maxChars (2048),
 * returning both the wire string and any overflow cells deferred to the next tick.
 */
export function encodeFireDeltaWithOverflow(delta, maxChars = PAYLOAD_CAPS.fireRing) {
  const payload = {
    w: encodeWind(delta.windDirDeg ?? 90, delta.windSpeedKt ?? 12),
    ms: Math.max(0, Math.round(delta.missionScore ?? 0)),
  };
  if (delta.wave != null) payload.wv = Math.max(1, Math.floor(delta.wave));
  if (delta.opIndex != null) payload.oi = clamp(Math.floor(delta.opIndex), 0, 4);
  if (delta.status && delta.status !== 'active') payload.st = STATUS_TO_CODE[delta.status] ?? 0;
  if (delta.intermissionTimer > 0) payload.it = Math.round(delta.intermissionTimer * 10);

  if (Array.isArray(delta.cabinChanges) && delta.cabinChanges.length > 0) {
    payload.c = delta.cabinChanges.map((cc) => [cc.id | 0, Math.max(0, Math.min(100, Math.round(cc.hp)))]);
  }
  if (Array.isArray(delta.scoreHits) && delta.scoreHits.length > 0) {
    payload.h = delta.scoreHits.slice(0, 48).map((ev) => [
      ev.slotId | 0,
      Math.round(ev.pts),
      KIND_TO_CODE[ev.kind] ?? 0,
    ]);
  } else if (Array.isArray(delta.scoreEvents) && delta.scoreEvents.length > 0) {
    payload.h = delta.scoreEvents.slice(0, 48).map((ev) => [
      ev.slotId | 0,
      Math.round(ev.pts),
      KIND_TO_CODE[ev.kind] ?? 0,
    ]);
  }
  if (Array.isArray(delta.dropOutcomes) && delta.dropOutcomes.length > 0) {
    payload.o = delta.dropOutcomes.slice(0, 12).map((o) => [
      o.slotId | 0,
      Math.round(o.impactX ?? 0),
      Math.round(o.impactZ ?? 0),
      Math.max(0, Math.round(o.cellsExtinguished ?? 0)),
      Math.max(0, Math.round(o.cellsCooled ?? 0)),
      Math.max(0, Math.round(o.pointsAwarded ?? 0)),
      OUTCOME_TO_CODE[o.outcome] ?? 2,
      MISS_TO_CODE[o.missType] ?? 0,
      DIR_TO_CODE[o.missDirCompass || ''] ?? 0,
      Math.max(0, Math.round(o.missDistM ?? 0)),
      o.cabinSaved ? 1 : 0,
      QUALITY_TO_CODE[o.dropQuality] ?? 0,
    ]);
  }

  // Deduplicate changedCells by idx (latest wins)
  const rawCells = Array.isArray(delta.changedCells) ? delta.changedCells : [];
  const byIdx = new Map();
  for (let i = 0; i < rawCells.length; i++) {
    byIdx.set(rawCells[i].idx, rawCells[i]);
  }
  const uniqueCells = Array.from(byIdx.values());

  // Measure base envelope overhead with empty "f":""
  payload.f = '';
  let baseStr = JSON.stringify(payload);
  // If scoreHits or dropOutcomes alone blew the budget, trim scoreHits first, then dropOutcomes.
  while (baseStr.length > maxChars && payload.h && payload.h.length > 0) {
    payload.h.pop();
    baseStr = JSON.stringify(payload);
  }
  while (baseStr.length > maxChars && payload.o && payload.o.length > 0) {
    payload.o.pop();
    baseStr = JSON.stringify(payload);
  }
  const availB64Chars = Math.max(0, maxChars - baseStr.length);
  // Each 3-byte cell produces exactly 4 Base64 chars.
  const maxCells = Math.floor(availB64Chars / 4);

  let selected = uniqueCells;
  let overflow = [];
  if (uniqueCells.length > maxCells) {
    uniqueCells.sort((a, b) => cellPriority(a.state) - cellPriority(b.state));
    selected = uniqueCells.slice(0, maxCells);
    overflow = uniqueCells.slice(maxCells);
  }

  if (selected.length > 0) {
    payload.f = packFireCells(selected);
  } else {
    delete payload.f;
  }

  const str = JSON.stringify(payload);
  return { str, overflow };
}

/** Encode a fire delta into a JSON string strictly <= 2048 chars. */
export function encodeFireDelta(delta, maxChars = PAYLOAD_CAPS.fireRing) {
  return encodeFireDeltaWithOverflow(delta, maxChars).str;
}

/** Decode a fire delta JSON string from `fireRing/$slot.d`. */
export function decodeFireDelta(str) {
  if (typeof str !== 'string') throw new Error('decodeFireDelta expects string');
  const obj = JSON.parse(str);
  const { windDirDeg, windSpeedKt } = decodeWind(obj.w);
  const changedCells = obj.f ? unpackFireCells(obj.f) : [];
  const cabinChanges = Array.isArray(obj.c)
    ? obj.c.map((pair) => ({ id: pair[0] | 0, hp: Number(pair[1]) || 0 }))
    : [];
  const scoreHits = Array.isArray(obj.h)
    ? obj.h.map((t) => ({ slotId: t[0] | 0, pts: Number(t[1]) || 0, kind: CODE_TO_KIND[t[2] | 0] || 'cell' }))
    : [];
  const dropOutcomes = Array.isArray(obj.o)
    ? obj.o.map((t) => ({
        slotId: t[0] | 0,
        impactX: Number(t[1]) || 0,
        impactZ: Number(t[2]) || 0,
        cellsExtinguished: Math.max(0, t[3] | 0),
        cellsCooled: Math.max(0, t[4] | 0),
        pointsAwarded: Math.max(0, Number(t[5]) || 0),
        outcome: CODE_TO_OUTCOME[t[6] | 0] || 'miss',
        missType: CODE_TO_MISS[t[7] | 0] || 'none',
        missDirCompass: CODE_TO_DIR[t[8] | 0] || '',
        missDistM: Math.max(0, Number(t[9]) || 0),
        cabinSaved: Boolean(t[10]),
        dropQuality: CODE_TO_QUALITY[t[11] | 0] || 'optimal',
      }))
    : [];
  return {
    windDirDeg,
    windSpeedKt,
    changedCells,
    cabinChanges,
    scoreHits,
    scoreEvents: scoreHits,
    dropOutcomes,
    missionScore: Number(obj.ms) || 0,
    wave: obj.wv != null ? (obj.wv | 0) : undefined,
    opIndex: obj.oi != null ? clamp(obj.oi | 0, 0, 4) : undefined,
    status: obj.st != null ? (CODE_TO_STATUS[obj.st | 0] || 'active') : 'active',
    intermissionTimer: obj.it != null ? (Number(obj.it) / 10) : 0,
  };
}

/**
 * 4-bit nibble RLE encoder for cellular fire grid:
 *   header byte = (state << 4) | code
 *   code 1..14:  run of `code` cells (1 byte)
 *   code 15:     next 1 byte b1 -> run of 15 + b1 cells (15..270, 2 bytes)
 *   code 0:      next 2 bytes u16LE -> run of len cells (1..65535, 3 bytes)
 */
export function encodeCellsRle(cells) {
  const n = cells.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const state = cells[i] & 0x0f;
    let run = 1;
    while (i + run < n && (cells[i + run] & 0x0f) === state && run < 65535) {
      run++;
    }
    if (run <= 14) {
      out.push((state << 4) | run);
    } else if (run <= 270) {
      out.push((state << 4) | 15, run - 15);
    } else {
      out.push((state << 4) | 0, run & 0xff, (run >>> 8) & 0xff);
    }
    i += run;
  }
  return new Uint8Array(out);
}

export function decodeCellsRle(bytes, expectedLen) {
  const out = new Uint8Array(expectedLen);
  let pos = 0;
  let i = 0;
  while (i < bytes.length && pos < expectedLen) {
    const hdr = bytes[i++];
    const state = (hdr >>> 4) & 0x0f;
    const code = hdr & 0x0f;
    let run;
    if (code >= 1 && code <= 14) {
      run = code;
    } else if (code === 15) {
      if (i >= bytes.length) throw new Error('decodeCellsRle truncated medium run');
      run = 15 + bytes[i++];
    } else {
      if (i + 1 >= bytes.length) throw new Error('decodeCellsRle truncated long run');
      run = bytes[i] | (bytes[i + 1] << 8);
      i += 2;
    }
    const end = Math.min(expectedLen, pos + run);
    out.fill(state, pos, end);
    pos = end;
  }
  if (pos !== expectedLen) {
    throw new Error(`decodeCellsRle length mismatch: got ${pos}, expected ${expectedLen}`);
  }
  return out;
}

/** Quantize active fire intensity (1..12) to 4 buckets as a compression fallback if RLE > budget. */
function quantizeCellsForBudget(cells) {
  const q = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const s = cells[i] & 0x0f;
    if (s >= 1 && s <= 12) {
      q[i] = s <= 3 ? 2 : (s <= 6 ? 5 : (s <= 9 ? 8 : 11));
    } else {
      q[i] = s;
    }
  }
  return q;
}

/** Smooth short fragmented runs (length <= maxRun) into previous neighbor state to guarantee RLE fits budget. */
function smoothFragmentedRuns(cells, maxRun = 1, coarseFire = false) {
  const out = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const s = cells[i] & 0x0f;
    if (coarseFire && s >= 1 && s <= 12) {
      out[i] = s <= 6 ? 4 : 10;
    } else {
      out[i] = s;
    }
  }
  let i = 0;
  while (i < out.length) {
    const state = out[i];
    let j = i + 1;
    while (j < out.length && out[j] === state) j++;
    const runLen = j - i;
    if (runLen <= maxRun && i > 0) {
      // Smooth isolated WET(13)/CHARRED(14)/INTACT(0)/EMBER(15) speckles (or all short runs when coarseFire)
      if (coarseFire || state === 0 || state === 13 || state === 14 || state === 15) {
        const fill = out[i - 1];
        for (let k = i; k < j; k++) out[k] = fill;
      }
    }
    i = j;
  }
  return out;
}

/**
 * Encode full FireSim keyframe into <= 12288 chars JSON.
 */
export function encodeFireKey(state, maxChars = PAYLOAD_CAPS.fireKey) {
  const cells = state.cells;
  const gridSize = state.gridSize || Math.round(Math.sqrt(cells.length));
  const cabinHp = Array.from(state.cabinHp ?? [], (v) => Math.max(0, Math.min(100, Math.round(v))));

  let slotPairs = [];
  if (state.slotScores instanceof Map) {
    for (const [slotId, score] of state.slotScores.entries()) {
      if (score > 0) slotPairs.push([slotId | 0, Math.round(score)]);
    }
  } else if (Array.isArray(state.slotScores)) {
    slotPairs = state.slotScores
      .filter((p) => p && p[1] > 0)
      .map((p) => [p[0] | 0, Math.round(p[1])]);
  } else if (state.slotScores && typeof state.slotScores === 'object') {
    for (const [k, v] of Object.entries(state.slotScores)) {
      if (v > 0) slotPairs.push([Number(k) | 0, Math.round(v)]);
    }
  }
  slotPairs.sort((a, b) => b[1] - a[1]);

  let rleB64 = bytesToBase64(encodeCellsRle(cells));
  const payload = {
    g: gridSize,
    r: rleB64,
    c: cabinHp,
    w: encodeWind(state.windDirDeg ?? 90, state.windSpeedKt ?? 12),
    wv: Math.max(1, Math.floor(state.wave ?? 1)),
    oi: clamp(Math.floor(state.opIndex ?? 0), 0, 4),
    ms: Math.max(0, Math.round(state.missionScore ?? 0)),
    st: STATUS_TO_CODE[state.status ?? 'active'] ?? 0,
    it: Math.round(Math.max(0, state.intermissionTimer ?? 0) * 10),
    s: slotPairs,
  };

  let str = JSON.stringify(payload);
  let qCells = null;
  if (str.length > maxChars) {
    // Fallback 1: quantize active fire intensities into 4 buckets to extend RLE runs.
    qCells = quantizeCellsForBudget(cells);
    payload.r = bytesToBase64(encodeCellsRle(qCells));
    str = JSON.stringify(payload);
  }
  if (str.length > maxChars && payload.s.length > 20) {
    // Fallback 2: keep top 20 slot scores.
    payload.s = payload.s.slice(0, 20);
    str = JSON.stringify(payload);
  }
  if (str.length > maxChars) {
    // Fallback 3: smooth isolated 1-cell WET/CHARRED/INTACT speckles + trim scores to top 10.
    payload.s = payload.s.slice(0, 10);
    qCells = smoothFragmentedRuns(qCells || quantizeCellsForBudget(cells), 1, false);
    payload.r = bytesToBase64(encodeCellsRle(qCells));
    str = JSON.stringify(payload);
  }
  for (let maxRun = 2; str.length > maxChars && maxRun <= 8; maxRun *= 2) {
    // Fallback 4: progressive run smoothing for adversarial checkerboard grids so encodeFireKey never throws.
    payload.s = payload.s.slice(0, 10);
    qCells = smoothFragmentedRuns(qCells, maxRun, true);
    payload.r = bytesToBase64(encodeCellsRle(qCells));
    str = JSON.stringify(payload);
  }
  if (str.length > maxChars) {
    throw new Error(`encodeFireKey exceeded ${maxChars} chars (${str.length})`);
  }
  return str;
}

/** Decode full FireSim keyframe from `fireKey.d`. */
export function decodeFireKey(str) {
  if (typeof str !== 'string') throw new Error('decodeFireKey expects string');
  const obj = JSON.parse(str);
  const gridSize = obj.g | 0;
  const expectedLen = gridSize * gridSize;
  const cells = decodeCellsRle(base64ToBytes(obj.r || ''), expectedLen);
  const cabinHp = Uint8Array.from(Array.isArray(obj.c) ? obj.c : []);
  const { windDirDeg, windSpeedKt } = decodeWind(obj.w);
  const slotScores = new Map();
  if (Array.isArray(obj.s)) {
    for (const pair of obj.s) {
      if (Array.isArray(pair) && pair.length >= 2) {
        slotScores.set(pair[0] | 0, Number(pair[1]) || 0);
      }
    }
  }
  return {
    gridSize,
    cells,
    cabinHp,
    windDirDeg,
    windSpeedKt,
    wave: Math.max(1, obj.wv | 0),
    opIndex: obj.oi != null ? clamp(obj.oi | 0, 0, 4) : 0,
    missionScore: Number(obj.ms) || 0,
    status: CODE_TO_STATUS[obj.st | 0] || 'active',
    intermissionTimer: (Number(obj.it) || 0) / 10,
    slotScores,
  };
}

/** Encode low-rate world metadata for `meta.d` (<= 1024 chars). */
export function encodeMeta(meta) {
  const top = Array.isArray(meta.top10)
    ? meta.top10.slice(0, 10).map((t) => [t.slotId | 0, Math.round(t.score || 0)])
    : [];
  const obj = {
    wv: Math.max(1, Math.floor(meta.wave ?? 1)),
    oi: clamp(Math.floor(meta.opIndex ?? 0), 0, 4),
    ms: Math.max(0, Math.round(meta.missionScore ?? 0)),
    bp: Math.round(clamp(meta.burningPct ?? 0, 0, 100) * 10),
    ca: Math.max(0, meta.cabinsAlive | 0),
    ct: Math.max(0, meta.cabinsTotal | 0),
    st: STATUS_TO_CODE[meta.status ?? 'active'] ?? 0,
    it: Math.round(Math.max(0, meta.intermissionTimer ?? 0) * 10),
    pc: Math.max(0, meta.pilotsCount | 0),
    top,
  };
  const str = JSON.stringify(obj);
  if (str.length > PAYLOAD_CAPS.meta) {
    throw new Error(`encodeMeta exceeded ${PAYLOAD_CAPS.meta} chars (${str.length})`);
  }
  return str;
}

/** Decode `meta.d`. */
export function decodeMeta(str) {
  if (typeof str !== 'string') return null;
  let obj;
  try {
    obj = JSON.parse(str);
  } catch {
    return null;
  }
  return {
    wave: Math.max(1, obj.wv | 0),
    opIndex: obj.oi != null ? clamp(obj.oi | 0, 0, 4) : 0,
    missionScore: Number(obj.ms) || 0,
    burningPct: (Number(obj.bp) || 0) / 10,
    cabinsAlive: obj.ca | 0,
    cabinsTotal: obj.ct | 0,
    status: CODE_TO_STATUS[obj.st | 0] || 'active',
    intermissionTimer: (Number(obj.it) || 0) / 10,
    pilotsCount: obj.pc | 0,
    top10: Array.isArray(obj.top)
      ? obj.top.map((t) => ({ slotId: t[0] | 0, score: Number(t[1]) || 0 }))
      : [],
  };
}
