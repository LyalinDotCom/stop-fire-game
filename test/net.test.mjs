import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEGA_BASIN_OP, OPERATIONS } from '../src/config/operations.js';
import { FireSim } from '../src/sim/FireSim.js';
import { generateTerrain } from '../src/sim/TerrainGen.js';

import { HostBroadcaster } from '../src/net/HostBroadcaster.js';
import { Link, STALL_KICK_SEC } from '../src/net/Link.js';
import { buildLobbyInviteUrl, listLiveLobbies, pickHostableShard } from '../src/net/LobbyDirectory.js';
import { createLoopbackSession } from '../src/net/LoopbackBots.js';
import { MockRtdbHub } from '../src/net/MockRtdbAdapter.js';
import { PlaneInterpolator, shortestAngleDeltaDeg } from '../src/net/PlaneInterpolator.js';
import { Presence } from '../src/net/Presence.js';
import { isPermissionDenied } from '../src/net/RtdbAdapter.js';
import { SlotAllocator, WORLD_TTL_MS } from '../src/net/SlotAllocator.js';
import { WorldSession } from '../src/net/WorldSession.js';
import { parseNetQuery, sanitizeCallsign } from '../src/net/config.js';
import {
  decodeFireDelta,
  decodeFireKey,
  decodeInput,
  decodeMeta,
  decodePlanes,
  encodeFireDelta,
  encodeFireDeltaWithOverflow,
  encodeFireKey,
  encodeInput,
  encodeMeta,
  encodePlanes,
} from '../src/net/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NET_DIR = path.resolve(__dirname, '../src/net');

const BUILD_HASH = 'a1b2c3d4e5f6';
const WORLD_ID = 'megabasin-01';

/** Helper: bootstrap a clean world with hostUid in slot 0 matching live deployed database.rules.json. */
async function bootstrapWorld(hub, hostUid = 'host-1', worldId = WORLD_ID) {
  const host = hub.createClient(hostUid);
  const conn = 'ConnHost0001';
  await host.set(`worlds/${worldId}/presence/${hostUid}`, {
    conn,
    at: host.serverTimestamp(),
  });
  await host.onDisconnect(`worlds/${worldId}/presence/${hostUid}`).set({
    conn,
    at: host.serverTimestamp(),
    away: true,
  });
  const now = hub.now();
  await host.update(`worlds/${worldId}`, {
    config: {
      mode: 'megabasin',
      mapId: 'cascadia',
      cap: 100,
      protocolVersion: 1,
      buildHash: BUILD_HASH,
      createdAt: host.serverTimestamp(),
      expiresAt: now + WORLD_TTL_MS,
    },
    authority: {
      uid: hostUid,
      epoch: 1,
      rev: 0,
      leaseUntil: now + 8000,
    },
    'slots/0': {
      uid: hostUid,
      conn,
      at: host.serverTimestamp(),
      leaseUntil: now + 40000,
    },
    [`uidToSlot/${hostUid}`]: 0,
    'roster/0': {
      uid: hostUid,
      name: 'EF-00',
      color: 0,
      at: host.serverTimestamp(),
    },
  });
  return { host, conn };
}

async function seatClient(hub, uid, slotNum, conn = 'ConnPeer0001', worldId = WORLD_ID) {
  const client = hub.createClient(uid);
  const slotStr = String(slotNum);
  await client.set(`worlds/${worldId}/presence/${uid}`, {
    conn,
    at: client.serverTimestamp(),
  });
  await client.onDisconnect(`worlds/${worldId}/presence/${uid}`).set({
    conn,
    at: client.serverTimestamp(),
    away: true,
  });
  const now = hub.now();
  await client.update(`worlds/${worldId}`, {
    [`slots/${slotStr}`]: {
      uid,
      conn,
      at: client.serverTimestamp(),
      leaseUntil: now + 40000,
    },
    [`uidToSlot/${uid}`]: slotNum,
    [`roster/${slotStr}`]: {
      uid,
      name: `EF-${slotStr.padStart(2, '0')}`,
      color: slotNum % 16,
      at: client.serverTimestamp(),
    },
  });
  return { client, conn };
}

// ============================================================================
// 1. ZERO STATIC FIREBASE IMPORTS & CONFIG TESTS
// ============================================================================
test('Zero static firebase/* imports across all src/net/*.js (Solo downloads 0 bytes)', () => {
  const files = fs.readdirSync(NET_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 14, `expected >= 14 net files, got ${files.length}`);
  for (const file of files) {
    const src = fs.readFileSync(path.join(NET_DIR, file), 'utf8');
    const staticFirebaseImport = /^\s*import\s+[^('"]*from\s+['"]firebase\//m;
    assert.equal(
      staticFirebaseImport.test(src),
      false,
      `${file} must NOT have a static import from firebase/*`
    );
  }
});

test('config parsers: query params and callsign sanitizer', () => {
  assert.equal(sanitizeCallsign('  !!EF-07__Ace  '), 'EF-07__Ace');
  assert.equal(sanitizeCallsign('VeryLongCallsignBeyondSixteen'), 'VeryLongCallsign');
  assert.equal(sanitizeCallsign('***', 'EF-07'), 'EF-07');

  const q1 = parseNetQuery('?emu&world=megabasin-19&tab&loopback=100');
  assert.equal(q1.emu, true);
  assert.deepEqual(q1.emulatorPorts, { auth: 9461, database: 9462 });
  assert.equal(q1.worldId, 'megabasin-19');
  assert.equal(q1.tab, true);
  assert.equal(q1.loopback, 100);
  assert.equal(q1.mode, 'loopback');

  const q2 = parseNetQuery('?bots=42&world=invalid-99');
  assert.equal(q2.loopback, 42);
  assert.equal(q2.worldId, 'megabasin-01');
});

// ============================================================================
// 2. BINARY & WIRE CODEC ROUND-TRIP TESTS
// ============================================================================
test('encodeInput/decodeInput: 9-int JSON tuple <= 72 chars round-trip', () => {
  const sample = {
    x: -1584.3,
    y: 147.6,
    z: 1499.8,
    yawDeg: 358.4,
    pitchDeg: -24.5,
    rollDeg: 48.2,
    speedKmh: 192,
    releasing: true,
    scooping: false,
    autopilot: false,
    outOfBounds: true,
  };
  const wire = encodeInput(sample, 42019);
  assert.ok(wire.length <= 72, `input length ${wire.length} > 72`);
  const dec = decodeInput(wire);
  assert.ok(dec);
  assert.ok(Math.abs(dec.x - sample.x) <= 0.11);
  assert.ok(Math.abs(dec.y - sample.y) <= 0.11);
  assert.ok(Math.abs(dec.z - sample.z) <= 0.11);
  assert.ok(Math.abs(dec.yawDeg - sample.yawDeg) <= 0.11);
  assert.ok(Math.abs(dec.pitchDeg - sample.pitchDeg) <= 0.11);
  assert.ok(Math.abs(dec.rollDeg - sample.rollDeg) <= 0.11);
  assert.equal(dec.speedKmh, 192);
  assert.equal(dec.releasing, true);
  assert.equal(dec.scooping, false);
  assert.equal(dec.outOfBounds, true);
  assert.equal(dec.dropSeq, 42019);
});

test('encodePlanes/decodePlanes: 100 planes = 1,200 B = 1,600 B64 chars (<= 1650)', () => {
  const planes = [];
  for (let i = 0; i < 100; i++) {
    planes.push({
      slotId: i,
      x: -1500 + i * 30.2,
      y: 15.5 + (i % 20) * 9.3,
      z: 1400 - i * 28.4,
      yawDeg: (i * 3.7) % 360,
      pitchDeg: -35 + (i % 70),
      rollDeg: -55 + (i % 110),
      speedKmh: 116 + (i % 90),
      tankPct: i,
      releasing: i % 3 === 0,
      scooping: i % 5 === 0,
      autopilot: i % 2 === 0,
    });
  }
  const b64 = encodePlanes(planes);
  assert.equal(b64.length, 1600, `expected 1600 B64 chars for 100 planes, got ${b64.length}`);
  assert.ok(b64.length <= 1650);

  const decoded = decodePlanes(b64);
  assert.equal(decoded.length, 100);
  for (let i = 0; i < 100; i++) {
    const a = planes[i];
    const b = decoded[i];
    assert.equal(b.slotId, a.slotId);
    assert.ok(Math.abs(b.x - a.x) <= 0.11);
    assert.ok(Math.abs(b.y - a.y) <= 0.11);
    assert.ok(Math.abs(b.z - a.z) <= 0.11);
    assert.ok(Math.abs(shortestAngleDeltaDeg(a.yawDeg, b.yawDeg)) <= 0.4);
    assert.ok(Math.abs(b.pitchDeg - a.pitchDeg) <= 1.1);
    assert.ok(Math.abs(b.rollDeg - a.rollDeg) <= 1.1);
    assert.ok(Math.abs(b.speedKmh - a.speedKmh) <= 2.1);
    assert.ok(Math.abs(b.tankPct - a.tankPct) <= 3.3);
    assert.equal(b.releasing, a.releasing);
    assert.equal(b.scooping, a.scooping);
    assert.equal(b.autopilot, a.autopilot);
  }
});

test('encodeFireDelta/decodeFireDelta: 3 B/cell + overflow chunking <= 2048 chars', () => {
  const changedCells = [];
  for (let i = 0; i < 80; i++) {
    changedCells.push({ idx: i * 251, state: i % 16, phase: i % 32 });
  }
  const delta = {
    windDirDeg: 115,
    windSpeedKt: 18.5,
    changedCells,
    cabinChanges: [{ id: 3, hp: 82 }, { id: 12, hp: 0 }],
    scoreEvents: [{ slotId: 7, pts: 70, kind: 'cell' }, { slotId: 4, pts: 35, kind: 'assist' }],
    missionScore: 12450,
    wave: 2,
    status: 'active',
  };
  const wire = encodeFireDelta(delta);
  assert.ok(wire.length <= 2048, `delta length ${wire.length} > 2048`);
  const dec = decodeFireDelta(wire);
  assert.equal(dec.changedCells.length, 80);
  assert.deepEqual(dec.changedCells[17], changedCells[17]);
  assert.deepEqual(dec.cabinChanges, delta.cabinChanges);
  assert.equal(dec.scoreHits.length, 2);
  assert.equal(dec.scoreHits[1].kind, 'assist');
  assert.equal(dec.missionScore, 12450);
  assert.ok(Math.abs(dec.windDirDeg - 115) <= 1.5);
  assert.ok(Math.abs(dec.windSpeedKt - 18.5) <= 0.25);

  const hugeCells = [];
  for (let i = 0; i < 900; i++) {
    hugeCells.push({ idx: i * 20, state: i < 20 ? 13 : 6, phase: 4 });
  }
  const { str, overflow } = encodeFireDeltaWithOverflow({
    windDirDeg: 90,
    windSpeedKt: 14,
    changedCells: hugeCells,
    missionScore: 99999,
  });
  assert.ok(str.length <= 2048, `chunked delta length ${str.length} > 2048`);
  assert.ok(overflow.length > 0, 'expected overflow cells when exceeding 2048-char cap');
  const decChunk = decodeFireDelta(str);
  const wetInFirstChunk = decChunk.changedCells.filter((c) => c.state === 13).length;
  assert.equal(wetInFirstChunk, 20, 'high-priority extinguished/wet cells must be packed first');
});

test('encodeFireKey/decodeFireKey: 4-bit nibble RLE of 160x160 grid <= 12288 chars', () => {
  const gridSize = 160;
  const cells = new Uint8Array(gridSize * gridSize);
  for (let gz = 20; gz < 90; gz++) {
    for (let gx = 40; gx < 65; gx++) {
      const idx = gz * gridSize + gx;
      if (gx < 46) cells[idx] = 14;
      else if (gx < 54) cells[idx] = 1 + ((gx + gz) % 12);
      else if (gx === 55) cells[idx] = 13;
      else if (gx === 62 && gz % 5 === 0) cells[idx] = 15;
    }
  }
  const cabinHp = new Uint8Array(44).fill(100);
  cabinHp[5] = 64;
  cabinHp[19] = 0;
  const slotScores = new Map();
  for (let s = 0; s < 100; s++) slotScores.set(s, s * 70);

  const wire = encodeFireKey({
    gridSize,
    cells,
    cabinHp,
    windDirDeg: 210,
    windSpeedKt: 16.5,
    wave: 3,
    missionScore: 48200,
    status: 'active',
    intermissionTimer: 0,
    slotScores,
  });
  assert.ok(wire.length <= 12288, `fireKey length ${wire.length} > 12288`);

  const dec = decodeFireKey(wire);
  assert.equal(dec.gridSize, 160);
  assert.equal(dec.cells.length, 25600);
  assert.deepEqual(dec.cells, cells);
  assert.deepEqual(dec.cabinHp, cabinHp);
  assert.equal(dec.wave, 3);
  assert.equal(dec.missionScore, 48200);
  assert.equal(dec.slotScores.get(99), 99 * 70);

  const metaWire = encodeMeta({
    wave: 3,
    missionScore: 48200,
    burningPct: 8.4,
    cabinsAlive: 42,
    cabinsTotal: 44,
    status: 'active',
    intermissionTimer: 0,
    pilotsCount: 100,
    top10: [{ slotId: 99, score: 6930 }],
  });
  assert.ok(metaWire.length <= 1024);
  const metaDec = decodeMeta(metaWire);
  assert.equal(metaDec.wave, 3);
  assert.equal(metaDec.burningPct, 8.4);
  assert.equal(metaDec.top10[0].slotId, 99);
});

test('PlaneInterpolator: Hermite monotonicity, wrap-around yaw, and <= 250 ms bank-curved dead reckoning', () => {
  const interp = new PlaneInterpolator();
  interp.pushSnapshot([{ slotId: 3, x: 0, y: 60, z: 0, yawDeg: 355, pitchDeg: 0, rollDeg: 30, speedKmh: 158, tankPct: 80 }], 1000);
  interp.pushSnapshot([{ slotId: 3, x: 1, y: 60, z: -11, yawDeg: 5, pitchDeg: 0, rollDeg: 30, speedKmh: 158, tankPct: 80 }], 1250);
  interp.pushSnapshot([{ slotId: 3, x: 4, y: 60, z: -22, yawDeg: 15, pitchDeg: 0, rollDeg: 30, speedKmh: 158, tankPct: 80 }], 1500);

  const mid = interp.sample(1575)[0];
  assert.ok(mid, 'expected interpolated plane');
  assert.ok(mid.yawDeg >= 0 && mid.yawDeg <= 20, `shortest-arc yaw expected near 10°, got ${mid.yawDeg}`);

  const dr1 = interp.sample(1800)[0];
  const dr2 = interp.sample(2200)[0];
  assert.ok(dr1.yawDeg > 15, `expected rightward bank-curved yaw > 15°, got ${dr1.yawDeg}`);
  assert.ok(Math.abs(dr2.x - dr1.x) < 15, 'dead reckoning must cap strictly at <= 250 ms');
});

// ============================================================================
// 3. ADVERSARIAL MockRtdbAdapter RULE INVARIANT TESTS
// ============================================================================
test('Adversarial RTDB rules: all deployed live database.rules.json invariants enforced', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host, conn: hostConn } = await bootstrapWorld(hub, 'host-1');
  const { client: p1, conn: p1Conn } = await seatClient(hub, 'pilot-1', 5, 'ConnPilot001');
  const { client: p2 } = await seatClient(hub, 'pilot-2', 12, 'ConnPilot002');

  const expectDenied = async (promise, label) => {
    let denied = false;
    try {
      await promise;
    } catch (err) {
      denied = isPermissionDenied(err);
    }
    assert.equal(denied, true, `Expected PERMISSION_DENIED for: ${label}`);
  };

  // (1) 2 slots / UID denied
  await expectDenied(
    p1.update(`worlds/${WORLD_ID}`, {
      'slots/6': { uid: 'pilot-1', conn: p1Conn, at: p1.serverTimestamp(), leaseUntil: hub.now() + 40000 },
      'uidToSlot/pilot-1': 6,
      'roster/6': { uid: 'pilot-1', name: 'EF-06', color: 1, at: p1.serverTimestamp() },
    }),
    '2 slots per UID'
  );

  // (2) Slot '100' and '01' denied, string uidToSlot denied, parent uidToSlot read denied
  const p3 = hub.createClient('pilot-3');
  const p3Conn = 'ConnPilot003';
  await p3.set(`worlds/${WORLD_ID}/presence/pilot-3`, { conn: p3Conn, at: p3.serverTimestamp() });
  await expectDenied(p3.get(`worlds/${WORLD_ID}/uidToSlot`), 'parent uidToSlot read denied');
  await expectDenied(
    p3.update(`worlds/${WORLD_ID}`, {
      'slots/100': { uid: 'pilot-3', conn: p3Conn, at: p3.serverTimestamp(), leaseUntil: hub.now() + 40000 },
      'uidToSlot/pilot-3': 100,
      'roster/100': { uid: 'pilot-3', name: 'EF-99', color: 0, at: p3.serverTimestamp() },
    }),
    'slot 100'
  );
  await expectDenied(
    p3.update(`worlds/${WORLD_ID}`, {
      'slots/01': { uid: 'pilot-3', conn: p3Conn, at: p3.serverTimestamp(), leaseUntil: hub.now() + 40000 },
      'uidToSlot/pilot-3': '01',
      'roster/01': { uid: 'pilot-3', name: 'EF-01', color: 0, at: p3.serverTimestamp() },
    }),
    'slot 01 (leading zero)'
  );

  // (3) Live slot overwrite denied
  await expectDenied(
    p3.update(`worlds/${WORLD_ID}`, {
      'slots/5': { uid: 'pilot-3', conn: p3Conn, at: p3.serverTimestamp(), leaseUntil: hub.now() + 40000 },
      'uidToSlot/pilot-3': 5,
      'roster/5': { uid: 'pilot-3', name: 'THIEF', color: 2, at: p3.serverTimestamp() },
    }),
    'overwriting live slot 5'
  );

  // (4) Stale connId onDisconnect away-mark denied
  await expectDenied(
    p1.set(`worlds/${WORLD_ID}/presence/pilot-1`, {
      conn: 'StaleConn999',
      at: p1.serverTimestamp(),
      away: true,
    }),
    'stale connId away mark'
  );

  // (5) Invalid shard denied
  await expectDenied(
    p1.set('worlds/megabasin-00/presence/pilot-1', { conn: p1Conn, at: p1.serverTimestamp() }),
    'invalid shard megabasin-00'
  );
  await expectDenied(
    p1.set('worlds/megabasin-21/presence/pilot-1', { conn: p1Conn, at: p1.serverTimestamp() }),
    'invalid shard megabasin-21'
  );

  // (6) Unbounded worldsIndex read denied; bounded <= 20 allowed
  await expectDenied(p1.get('worldsIndex'), 'unbounded worldsIndex get');
  await expectDenied(p1.queryWorldsIndex({ limit: 21 }), 'worldsIndex limitToLast 21');
  const idx = await p1.queryWorldsIndex({ limit: 20 });
  assert.deepEqual(idx, {});

  // (7) Valid in/$uid write succeeds, non-monotonic s denied, < 180 ms flood denied, partial-child pacing bypass denied!
  const validIn = encodeInput({ x: 10, y: 50, z: -20, yawDeg: 90, pitchDeg: 0, rollDeg: 0, speedKmh: 158 }, 1);
  await p1.set(`worlds/${WORLD_ID}/in/pilot-1`, { s: 1, t: p1.serverTimestamp(), c: p1Conn, d: validIn });

  hub.advanceTime(100);
  await expectDenied(
    p1.set(`worlds/${WORLD_ID}/in/pilot-1`, { s: 2, t: p1.serverTimestamp(), c: p1Conn, d: validIn }),
    '< 180 ms input flood'
  );

  hub.advanceTime(200);
  await expectDenied(
    p1.set(`worlds/${WORLD_ID}/in/pilot-1`, { s: 1, t: p1.serverTimestamp(), c: p1Conn, d: validIn }),
    'non-monotonic in/$uid.s'
  );

  await expectDenied(
    p1.set(`worlds/${WORLD_ID}/in/pilot-1/d`, validIn),
    'partial-child pacing bypass on in/$uid/d'
  );

  // (8) away: true input denied
  await p1.set(`worlds/${WORLD_ID}/presence/pilot-1`, {
    conn: p1Conn,
    at: p1.serverTimestamp(),
    away: true,
  });
  hub.advanceTime(300);
  await expectDenied(
    p1.set(`worlds/${WORLD_ID}/in/pilot-1`, { s: 2, t: p1.serverTimestamp(), c: p1Conn, d: validIn }),
    'in/$uid write while presence.away === true'
  );

  // (9) Wrong epoch denied
  await expectDenied(
    host.set(`worlds/${WORLD_ID}/planes`, { e: 2, q: 1, t: host.serverTimestamp(), p: '' }),
    'planes with wrong epoch 2'
  );

  // (10) Wrong q % 16 ring slot denied
  await expectDenied(
    host.set(`worlds/${WORLD_ID}/fireRing/5`, { e: 1, q: 6, t: host.serverTimestamp(), d: '{"w":[0,0],"ms":0}' }),
    'fireRing slot 5 with q=6'
  );
  await host.set(`worlds/${WORLD_ID}/fireRing/1`, { e: 1, q: 1, t: host.serverTimestamp(), d: '{"w":[0,0],"ms":0}' });

  // (11) $other extra keys denied
  await expectDenied(
    host.set(`worlds/${WORLD_ID}/planes`, { e: 1, q: 1, t: host.serverTimestamp(), p: '', extraKey: 123 }),
    '$other extraKey on planes'
  );
  await expectDenied(
    host.set(`worlds/${WORLD_ID}/meta`, { e: 1, t: host.serverTimestamp(), d: '{"wv":1}', bogus: true }),
    '$other bogus key on meta'
  );

  // (12) Stream deletes denied
  await host.set(`worlds/${WORLD_ID}/planes`, { e: 1, q: 1, t: host.serverTimestamp(), p: '' });
  await host.set(`worlds/${WORLD_ID}/fireKey`, { e: 1, q: 1, t: host.serverTimestamp(), d: '{"g":160,"r":""}' });
  await host.set(`worlds/${WORLD_ID}/meta`, { e: 1, t: host.serverTimestamp(), d: '{"wv":1}' });
  await expectDenied(host.remove(`worlds/${WORLD_ID}/planes`), 'delete planes');
  await expectDenied(host.remove(`worlds/${WORLD_ID}/fireRing/1`), 'delete fireRing/1');
  await expectDenied(host.remove(`worlds/${WORLD_ID}/fireKey`), 'delete fireKey');
  await expectDenied(host.remove(`worlds/${WORLD_ID}/meta`), 'delete meta');
  await expectDenied(host.remove(`worlds/${WORLD_ID}/authority`), 'delete authority');
  await expectDenied(host.remove(`worlds/${WORLD_ID}/config`), 'delete config');

  // (13) Non-host reading presence/ or in/ denied; own leaf allowed; live host allowed
  await expectDenied(p2.get(`worlds/${WORLD_ID}/presence`), 'non-host reading entire presence map');
  await expectDenied(p2.get(`worlds/${WORLD_ID}/in`), 'non-host reading entire in map');
  await expectDenied(p2.get(`worlds/${WORLD_ID}/presence/pilot-1`), 'non-host reading other user presence');
  await expectDenied(p2.get(`worlds/${WORLD_ID}/in/pilot-1`), 'non-host reading other user in');
  assert.ok(await p2.get(`worlds/${WORLD_ID}/presence/pilot-2`), 'self presence read must succeed');
  assert.ok(await host.get(`worlds/${WORLD_ID}/presence`), 'live host presence read must succeed');
  assert.ok(await host.get(`worlds/${WORLD_ID}/in`), 'live host in read must succeed');

  // (14) Conditional delete of missing leaf denied
  await expectDenied(
    p2.remove(`worlds/${WORLD_ID}/in/pilot-2`),
    'conditional delete of missing in/pilot-2 leaf'
  );
  await expectDenied(
    p2.update(`worlds/${WORLD_ID}`, {
      'slots/12': null,
      'uidToSlot/pilot-2': null,
      'roster/12': null,
      'in/pilot-2': null,
    }),
    'atomic vacate including missing in/$uid leaf'
  );
  assert.ok(hub.inspect(`worlds/${WORLD_ID}/slots/12`), 'atomic update rollback must preserve slot 12');

  // (15) Expired host lease denied on stream write
  hub.advanceTime(9000);
  await expectDenied(
    host.set(`worlds/${WORLD_ID}/planes`, { e: 1, q: 2, t: host.serverTimestamp(), p: '' }),
    'expired host lease writing planes'
  );
  assert.equal(hostConn, 'ConnHost0001');
});

// ============================================================================
// 4. LINK BLACK-HOLE STALL_KICK TEST
// ============================================================================
test('Link drops black-holed socket after STALL_KICK (6 s)', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const client = hub.createClient('blackhole-pilot');
  const link = new Link(client, { nowFn: () => hub.now(), disableTicker: true });

  let reconnects = 0;
  const origOff = client.goOffline.bind(client);
  client.goOffline = () => { reconnects++; origOff(); };

  hub.advanceTime(4000);
  hub.simulateBlackHole('blackhole-pilot', true);
  link.step(3500);
  assert.equal(reconnects, 0);

  hub.advanceTime(STALL_KICK_SEC * 1000);
  link.step(STALL_KICK_SEC * 1000 + 3500);
  link.beat();
  assert.ok(reconnects >= 1, 'Link must kick black-holed socket after STALL_KICK (6 s)');
  link.stop();
});

// ============================================================================
// 5. HOST FAILOVER CHAOS TESTS (VOLUNTARY ABDICATION < 1.5s & TAB CRASH <= 8s)
// ============================================================================
test('Host failover: voluntary abdication (< 1.5 s) and abrupt tab crash (<= 8 s) with 0% state reset + zombie fencing', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });

  const simA = new FireSim(terrain, { isMegaBasin: true });
  const simB = new FireSim(terrain, { isMegaBasin: true });
  const simC = new FireSim(terrain, { isMegaBasin: true });

  const adapterA = hub.createClient('pilot-A');
  const adapterB = hub.createClient('pilot-B');
  const adapterC = hub.createClient('pilot-C');

  const sessA = new WorldSession({
    adapter: adapterA, terrain, fireSim: simA, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'ALPHA', colorIdx: 0,
    disableRealTimers: true, electionBackoffRangeMs: [100, 150],
  });
  const sessB = new WorldSession({
    adapter: adapterB, terrain, fireSim: simB, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'BRAVO', colorIdx: 1,
    disableRealTimers: true, electionBackoffRangeMs: [100, 150],
  });
  const sessC = new WorldSession({
    adapter: adapterC, terrain, fireSim: simC, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'CHARLIE', colorIdx: 2,
    disableRealTimers: true, electionBackoffRangeMs: [100, 150],
  });

  await sessA.start();
  await sessB.start();
  await sessC.start();

  const resA = await sessA.requestManualControl();
  assert.equal(resA.seated, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sessA.isHost, true);
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/authority/epoch`), 1);

  await sessB.requestManualControl();
  await sessC.requestManualControl();

  simA.missionScore = 14700;
  simA.slotScores.set(resA.slotId, 4900);
  simA.cabinHp[0] = 63;
  simA.cabinHpF[0] = 63;
  for (let i = 0; i < 60; i++) {
    hub.advanceTime(100);
    sessA.step(0.1, hub.now());
    sessB.step(0.1, hub.now());
    sessC.step(0.1, hub.now());
  }
  await new Promise((r) => setTimeout(r, 10));

  const preAbdicateScore = simA.missionScore;
  const preAbdicateCabin0 = simA.cabinHp[0];
  const preAbdicateBurning = simA.getSnapshot().burningCount;
  assert.ok(preAbdicateScore >= 14700);
  assert.equal(preAbdicateCabin0, 63);
  assert.ok(preAbdicateBurning > 0);

  // Voluntary abdication by Host A -> Host B takes over in < 1.5 s
  const abdicateStart = hub.now();
  await sessA.returnToDemoFlight();
  assert.equal(sessA.isHost, false);

  for (let i = 0; i < 6 && !sessB.isHost; i++) {
    hub.advanceTime(200);
    sessB.step(0.2, hub.now());
    await new Promise((r) => setTimeout(r, 5));
  }
  const abdicateTakeoverMs = hub.now() - abdicateStart;
  assert.equal(sessB.isHost, true, 'Pilot B must take over after Host A voluntary abdication');
  assert.ok(abdicateTakeoverMs < 1500, `Voluntary failover took ${abdicateTakeoverMs} ms (>= 1500 ms)`);
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/authority/epoch`), 2);

  assert.equal(simB.missionScore, preAbdicateScore, 'missionScore preserved across voluntary failover');
  assert.equal(simB.cabinHp[0], preAbdicateCabin0, 'cabin HP preserved across voluntary failover');
  assert.equal(simB.getSnapshot().burningCount, preAbdicateBurning, 'burning cell count preserved');

  simB.missionScore += 2100;
  simB.cabinHp[1] = 44;
  simB.cabinHpF[1] = 44;
  for (let i = 0; i < 55; i++) {
    hub.advanceTime(100);
    sessB.step(0.1, hub.now());
    sessC.step(0.1, hub.now());
  }
  await new Promise((r) => setTimeout(r, 10));

  const preCrashScore = simB.missionScore;
  const preCrashCabin1 = simB.cabinHp[1];
  const preCrashBurning = simB.getSnapshot().burningCount;

  // Abrupt simulateTabCrash on Host B -> Host C takes over in <= 8 s
  const crashStart = hub.now();
  hub.simulateTabCrash('pilot-B');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/presence/pilot-B/away`), true);

  for (let i = 0; i < 40 && !sessC.isHost; i++) {
    hub.advanceTime(200);
    sessC.step(0.2, hub.now());
    await new Promise((r) => setTimeout(r, 5));
  }
  const crashTakeoverMs = hub.now() - crashStart;
  assert.equal(sessC.isHost, true, 'Pilot C must take over after Host B abrupt crash');
  assert.ok(crashTakeoverMs <= 8200, `Abrupt crash failover took ${crashTakeoverMs} ms (> 8.2 s)`);
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/authority/epoch`), 3);

  assert.equal(simC.missionScore, preCrashScore, 'missionScore preserved across crash failover');
  assert.equal(simC.cabinHp[1], preCrashCabin1, 'cabin HP preserved across crash failover');
  assert.equal(simC.getSnapshot().burningCount, preCrashBurning, 'burning cells preserved across crash failover');

  // Returning zombie Host B (epoch 2) is fenced & rejected
  adapterB.goOnline();
  let zombieDenied = false;
  try {
    await adapterB.set(`worlds/${WORLD_ID}/planes`, { e: 2, q: 999, t: adapterB.serverTimestamp(), p: '' });
  } catch (err) {
    zombieDenied = isPermissionDenied(err);
  }
  assert.equal(zombieDenied, true, 'Returning zombie host writing stale epoch 2 MUST be rejected');

  await sessA.stop();
  await sessC.stop();
  await adapterB.close();
});

// ============================================================================
// 6. FULL 100-BOT SCALE TEST (WRITE RATE <= 450 w/s, PAYLOAD CAPS, TICK < 2ms)
// ============================================================================
test('100-bot Mega-Basin scale test: <= 450 w/s, payload budgets, FireSim tick < 2.0 ms', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const localFireSim = new FireSim(terrain, { isMegaBasin: true });

  const loopback = createLoopbackSession({
    botCount: 99,
    terrain,
    fireSim: localFireSim,
    opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID,
    callsign: 'EF-99',
    colorIdx: 0,
    useRealClock: false,
  });

  await loopback.session.start();
  const seatRes = await loopback.session.requestManualControl();
  assert.equal(seatRes.seated, true, 'local player should claim the 100th slot alongside 99 bots');

  const { hub, session, hostFireSim } = loopback;
  const localAircraft = {
    ...seatRes.spawnPose,
    releasing: true,
    scooping: false,
    autopilot: false,
  };

  hub.resetStats();

  const origStep = hostFireSim.step.bind(hostFireSim);
  const tickDurationsMs = [];
  hostFireSim.step = (...args) => {
    const t0 = performance.now();
    const res = origStep(...args);
    tickDurationsMs.push(performance.now() - t0);
    return res;
  };

  let maxPlanesLen = 0;
  let maxFireRingLen = 0;
  let maxFireKeyLen = 0;
  let maxMetaLen = 0;
  let lastRemoteCount = 0;

  for (let stepIdx = 0; stepIdx < 100; stepIdx++) {
    hub.advanceTime(100);
    localAircraft.z -= 4.2;
    session.sendLocalState(localAircraft, stepIdx);
    const out = session.step(0.1, hub.now());
    lastRemoteCount = out.remotePlanes.length;

    const planesNode = hub.inspect(`worlds/${WORLD_ID}/planes`);
    if (planesNode?.p) maxPlanesLen = Math.max(maxPlanesLen, planesNode.p.length);
    const ringNode = hub.inspect(`worlds/${WORLD_ID}/fireRing`);
    if (ringNode) {
      for (const slot of Object.values(ringNode)) {
        if (slot?.d) maxFireRingLen = Math.max(maxFireRingLen, slot.d.length);
      }
    }
    const keyNode = hub.inspect(`worlds/${WORLD_ID}/fireKey`);
    if (keyNode?.d) maxFireKeyLen = Math.max(maxFireKeyLen, keyNode.d.length);
    const metaNode = hub.inspect(`worlds/${WORLD_ID}/meta`);
    if (metaNode?.d) maxMetaLen = Math.max(maxMetaLen, metaNode.d.length);
  }

  const writeRate = hub.getWriteRate(10000);
  const sortedTicks = [...tickDurationsMs].sort((a, b) => a - b);
  const p95Tick = sortedTicks[Math.floor(sortedTicks.length * 0.95)] || 0;
  const avgTick = tickDurationsMs.reduce((a, b) => a + b, 0) / Math.max(1, tickDurationsMs.length);

  assert.equal(hub.stats.rejectedWrites, 0, `Expected 0 rejected writes in 100-bot run, got ${hub.stats.rejectedWrites}`);
  assert.ok(writeRate > 300 && writeRate <= 450, `Expected steady-state write rate <= 450 w/s (got ${writeRate.toFixed(1)} w/s)`);
  assert.ok(maxPlanesLen === 1600 && maxPlanesLen <= 1650, `planes.p max len ${maxPlanesLen} (expected 1600 <= 1650)`);
  assert.ok(maxFireRingLen > 0 && maxFireRingLen <= 2048, `fireRing.d max len ${maxFireRingLen} > 2048`);
  assert.ok(maxFireKeyLen > 0 && maxFireKeyLen <= 12288, `fireKey.d max len ${maxFireKeyLen} > 12288`);
  assert.ok(maxMetaLen > 0 && maxMetaLen <= 1024, `meta.d max len ${maxMetaLen} > 1024`);
  assert.equal(lastRemoteCount, 99, `Expected 99 interpolated remote planes, got ${lastRemoteCount}`);
  assert.ok(avgTick < 2.0, `FireSim avg tick ${avgTick.toFixed(3)} ms >= 2.0 ms (p95=${p95Tick.toFixed(3)} ms)`);
  assert.ok(p95Tick < 2.0, `FireSim p95 tick ${p95Tick.toFixed(3)} ms >= 2.0 ms`);

  await loopback.stop();
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/uidToSlot/local-pilot`), null, 'clean teardown removes local uidToSlot');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/presence/local-pilot`), null, 'clean teardown removes local presence');
});

// ============================================================================
// 7. ZERO-WRITE DEMO FLIGHT, IDLE RECLAMATION & HOST EVICTION TESTS
// ============================================================================
test('Zero-write DEMO FLIGHT entry, idle reclamation (90s/120s/300s), and host dead-slot eviction (>= 60s)', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const simHost = new FireSim(terrain, { isMegaBasin: true });
  const simGuest = new FireSim(terrain, { isMegaBasin: true });

  const hostAdapter = hub.createClient('evict-host');
  const guestAdapter = hub.createClient('idle-guest');

  const hostSess = new WorldSession({
    adapter: hostAdapter, terrain, fireSim: simHost, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'HOST-01', colorIdx: 0,
    disableRealTimers: true,
  });
  await hostSess.start();
  await hostSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 10));

  const writesBeforeSpectator = hub.stats.writes;
  let idleVacated = false;
  let idleOfflined = false;
  const guestSess = new WorldSession({
    adapter: guestAdapter, terrain, fireSim: simGuest, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'GUEST-02', colorIdx: 2,
    disableRealTimers: true,
    onIdleVacate: () => { idleVacated = true; },
    onIdleOffline: () => { idleOfflined = true; },
  });
  await guestSess.start();
  assert.equal(hub.stats.writes, writesBeforeSpectator, 'DEMO FLIGHT spectator entry must perform 0 RTDB writes');

  const gSeat = await guestSess.requestManualControl();
  assert.equal(gSeat.seated, true);

  hub.advanceTime(95000);
  const warnStep = guestSess.step(0.1, hub.now());
  assert.ok(warnStep.netState.idleCountdown > 0 && warnStep.netState.idleCountdown <= 30, 'expected 90 s idle warning countdown');

  hub.advanceTime(30000);
  guestSess.step(0.1, hub.now());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(idleVacated, true, 'expected 120 s idle auto-vacate');
  assert.equal(guestSess.localSlotId, null, 'slot must be vacated on 120 s idle');

  hub.advanceTime(185000);
  guestSess.step(0.1, hub.now());
  assert.equal(idleOfflined, true, 'expected 300 s idle goOffline');
  assert.equal(guestAdapter.connected, false);

  guestSess.resumeLive();
  assert.equal(guestAdapter.connected, true);

  // Re-establish live host after 300 s idle jump
  await hostSess.allocator.renewIfDue(true, hostSess.presence.connId);
  await hostSess.election.tick();
  await hostSess.election.attemptTakeover();
  await new Promise((r) => setTimeout(r, 10));

  const deadPeer = hub.createClient('crashed-peer');
  const deadPres = new Presence(deadPeer, WORLD_ID, null, { autoStart: false, nowFn: () => hub.now() });
  await deadPres.mark();
  const deadNow = hub.now();
  await deadPeer.update(`worlds/${WORLD_ID}`, {
    'slots/77': { uid: 'crashed-peer', conn: deadPres.connId, at: deadPeer.serverTimestamp(), leaseUntil: deadNow + 40000 },
    'uidToSlot/crashed-peer': 77,
    'roster/77': { uid: 'crashed-peer', name: 'CRASH-77', color: 5, at: deadPeer.serverTimestamp() },
  });
  hub.simulateTabCrash('crashed-peer');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/presence/crashed-peer/away`), true);

  const rejBefore = hub.stats.rejectedWrites;
  for (let i = 0; i < 13; i++) {
    hub.advanceTime(5000);
    await hostSess.election.renewLease();
    await hostSess.host.evictDeadSlots();
  }
  assert.equal(hub.stats.rejectedWrites, rejBefore, 'host eviction must use conditional deletes with 0 rejected writes');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/slots/77`), null, 'dead slot 77 must be evicted');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/uidToSlot/crashed-peer`), null, 'dead uidToSlot must be evicted');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/presence/crashed-peer`), null, 'dead away presence must be pruned');

  await guestSess.stop();
  await hostSess.stop();
});

test('LoopbackBots with useRealClock: true boots 99 bots with 0 rejected writes and live remotePlanes', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const localFireSim = new FireSim(terrain, { isMegaBasin: true });
  const loopback = createLoopbackSession({
    botCount: 99,
    terrain,
    fireSim: localFireSim,
    opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID,
    callsign: 'EF-99',
    colorIdx: 0,
    useRealClock: true,
  });

  await loopback.session.start();
  await new Promise((r) => setTimeout(r, 30));
  const out = loopback.session.step(0.05, performance.now());

  assert.equal(loopback.hub.stats.rejectedWrites, 0, 'useRealClock: true boot must have 0 rejected writes');
  assert.equal(loopback.hub.inspect(`worlds/${WORLD_ID}/authority/uid`), 'bot-00');
  assert.equal(out.remotePlanes.length, 99, `expected 99 remote planes immediately, got ${out.remotePlanes.length}`);

  await loopback.stop();
});

// ============================================================================
// 8. AUDIT #19 REGRESSION TESTS (Findings #2, #3, #4, #5, #6, #9, #15)
// ============================================================================
test('Audit #3: Presence async onValue(null) triggers 0 double-writes, delays connId until ack, and stop() resolves ready', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const client = hub.createClient('pres-race-pilot');

  // Delay set() by 5 ms so initial async onValue(null) arrives mid-first-write (exact WSS race!).
  const origSet = client.set.bind(client);
  let setCalls = 0;
  client.set = async (...args) => {
    setCalls++;
    await new Promise((r) => setTimeout(r, 5));
    return origSet(...args);
  };

  const pres = new Presence(client, WORLD_ID, null, { autoStart: true, nowFn: () => hub.now() });
  // While set() is still in flight, connId MUST stay null so in/$uid never sends un-acked connId!
  assert.equal(pres.connId, null, 'connId must stay null before server ack');
  const ackedId = await pres.ready;
  await new Promise((r) => setTimeout(r, 15));

  assert.ok(ackedId && pres.connId === ackedId, 'connId committed after ack');
  assert.equal(setCalls, 1, 'initial onValue(null) mid-write must NOT trigger second mark()');
  assert.equal(hub.stats.rejectedWrites, 0, 'zero <1000ms double-write rejections');
  await pres.stop();

  // Verify stop() mid-connect resolves ready(null) instead of hanging!
  const client2 = hub.createClient('pres-hang-pilot');
  hub.simulateBlackHole('pres-hang-pilot', true);
  const pres2 = new Presence(client2, WORLD_ID, null, { autoStart: true, nowFn: () => hub.now() });
  setTimeout(() => pres2.stop(), 5);
  const res2 = await pres2.ready;
  assert.equal(res2, null, 'Presence.stop() must resolve ready with null instead of hanging');
});

test('Audit #4: Expired uidToSlot reload re-claims same slot index with 0 rejected writes', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  await bootstrapWorld(hub, 'host-1');
  const { client } = await seatClient(hub, 'reloader-1', 23, 'ConnReload01');

  // Advance past 40 s slot lease expiry BEFORE Host evicts uidToSlot/reloader-1
  hub.advanceTime(50000);
  const rejBefore = hub.stats.rejectedWrites;

  // Simulate tab reload with same browserLocalPersistence UID and fresh connId
  const alloc = new SlotAllocator(client, WORLD_ID, { nowFn: () => hub.now() });
  const res = await alloc.claim({ callsign: 'RELOAD-23', colorIdx: 3, connId: 'ConnReload02', buildHash: BUILD_HASH });
  assert.equal(res.seated, true, 'reload after expired slot must re-seat cleanly');
  assert.equal(res.slotId, 23, 'must re-claim same slot index 23 matching uidToSlot');
  assert.equal(hub.stats.rejectedWrites, rejBefore, 'zero PERMISSION_DENIED retries on expired reload');
});

test('Audit #2: Mega-Basin Wave 2+ rollover triggers fireKey full sync across Host + Replica', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const simHost = new FireSim(terrain, { isMegaBasin: true });
  const simRep = new FireSim(terrain, { isMegaBasin: true });

  const hostAdapter = hub.createClient('wave-host');
  const repAdapter = hub.createClient('wave-rep');

  let hostFullSyncCount = 0;
  let repFullSyncCount = 0;
  const hostSess = new WorldSession({
    adapter: hostAdapter, terrain, fireSim: simHost, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'WHOST', colorIdx: 0,
    disableRealTimers: true,
    onFireSync: (e) => { if (e.full) hostFullSyncCount++; },
  });
  const repSess = new WorldSession({
    adapter: repAdapter, terrain, fireSim: simRep, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'WREP', colorIdx: 1,
    disableRealTimers: true,
    onFireSync: (e) => { if (e.full) repFullSyncCount++; },
  });

  await hostSess.start();
  await hostSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 10));
  await repSess.start();
  await new Promise((r) => setTimeout(r, 10));

  // Damage cabin 0 to 0 HP, put Host into final 0.5 s of Wave 1 intermission
  simHost.cabinHp[0] = 0;
  simHost.cabinHpF[0] = 0;
  simHost.status = 'intermission';
  simHost.intermissionTimer = 0.5;
  simRep.cabinHp[0] = 0;
  simRep.cabinHpF[0] = 0;

  // Advance 6 s so Wave 1 intermission expires -> Wave 2 fullReset -> fireKey publishes & Replica hydrates!
  for (let i = 0; i < 60; i++) {
    hub.advanceTime(100);
    hostSess.step(0.1, hub.now());
    repSess.step(0.1, hub.now());
    await Promise.resolve();
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 15));
  repSess.step(0.1, hub.now());
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(simHost.wave, 2, 'Host must advance to Wave 2');
  assert.equal(simRep.wave, 2, 'Replica must advance to Wave 2');
  assert.equal(simHost.cabinHp[0], 100, 'Host cabin 0 restored in Wave 2');
  assert.equal(simRep.cabinHp[0], 100, 'Replica cabin 0 restored in Wave 2 (no stale Wave 1 ruin!)');
  assert.ok(hostFullSyncCount >= 1, 'Host must emit onFireSync({ full: true }) on Wave 2 reset');
  assert.ok(repFullSyncCount >= 2, 'Replica must re-hydrate full fireKey on Wave 2 rollover');
  assert.equal(simRep.getSnapshot().burningCount, simHost.getSnapshot().burningCount, 'Wave 2 burning count matches exactly');

  await repSess.stop();
  await hostSess.stop();
});

test('Audit #5 & #15: evictDeadSlots safe when deadUid re-seated elsewhere, evicted client unseats, publishMeta counts live slots only', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host } = await bootstrapWorld(hub, 'host-1');
  const { client: mover, conn: moverConn } = await seatClient(hub, 'mover-1', 5, 'ConnMover001');
  const { client: victim } = await seatClient(hub, 'victim-1', 9, 'ConnVictim01');

  const sim = new FireSim(terrain, { isMegaBasin: true });
  const hb = new HostBroadcaster(host, WORLD_ID, {
    terrain, fireSim: sim, epoch: 1, buildHash: BUILD_HASH, localSlotId: 0, enableBackgroundTicker: false,
  });
  await hb.start();

  // Expire mover-1's slot 5 & victim-1's slot 9, then re-take host lease cleanly at epoch + 1
  hub.advanceTime(45000);
  await host.set(`worlds/${WORLD_ID}/slots/0`, { uid: 'host-1', conn: 'ConnHost0001', at: host.serverTimestamp(), leaseUntil: hub.now() + 40000 });
  const r1 = await host.runTransaction(`worlds/${WORLD_ID}/authority`, (c) => ({ uid: 'host-1', epoch: c.epoch + 1, rev: c.rev + 1, leaseUntil: hub.now() + 8000 }));
  hb.setEpoch(r1.value.epoch);
  await new Promise((r) => setTimeout(r, 5));

  // Verify publishMeta counts only live slots (1: host-1), NOT expired slots 5 and 9!
  await hb.publishMeta();
  const metaDecoded = decodeMeta(hub.inspect(`worlds/${WORLD_ID}/meta/d`));
  assert.equal(metaDecoded.pilotsCount, 1, 'publishMeta must count only non-expired slots');

  // Re-seat mover-1 in slot 8 while old expired slot 5 still lingers (via direct hub state to reproduce Finding #5)
  const now = hub.now();
  await mover.update(`worlds/${WORLD_ID}`, {
    'slots/5': null,
    'uidToSlot/mover-1': null,
    'roster/5': null,
  });
  await mover.update(`worlds/${WORLD_ID}`, {
    'slots/8': { uid: 'mover-1', conn: moverConn, at: mover.serverTimestamp(), leaseUntil: now + 40000 },
    'uidToSlot/mover-1': 8,
    'roster/8': { uid: 'mover-1', name: 'MOVER', color: 2, at: mover.serverTimestamp() },
  });
  // Inject lingering expired slot 5 belonging to mover-1 while uidToSlot/mover-1 === 8
  hub._root.worlds[WORLD_ID].slots['5'] = { uid: 'mover-1', conn: moverConn, at: now - 50000, leaseUntil: now - 10000 };
  hb._slots = hub.inspect(`worlds/${WORLD_ID}/slots`);

  const rejBefore = hub.stats.rejectedWrites;
  await hb.evictDeadSlots();
  assert.equal(hub.stats.rejectedWrites, rejBefore, 'evictDeadSlots must not reject when deadUid re-seated elsewhere');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/slots/5`), null, 'expired slot 5 removed');
  assert.ok(hub.inspect(`worlds/${WORLD_ID}/slots/8`), 'live re-seated slot 8 preserved');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/uidToSlot/mover-1`), 8, 'live uidToSlot preserved');
  assert.ok(hub.inspect(`worlds/${WORLD_ID}/presence/mover-1`), 'live presence preserved');
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/slots/9`), null, 'expired victim-1 slot 9 evicted');

  // Verify victim-1 WorldSession reconciles eviction cleanly when StreamClient sees slot missing!
  const victimSim = new FireSim(terrain, { isMegaBasin: true });
  let evictedFired = false;
  const victimSess = new WorldSession({
    adapter: victim, terrain, fireSim: victimSim, opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID, buildHash: BUILD_HASH, disableRealTimers: true,
    onEvicted: () => { evictedFired = true; },
  });
  await victimSess.start();
  // Re-seat victim then let Host evict
  await victimSess.requestManualControl();
  const vSlot = victimSess.localSlotId;
  assert.ok(vSlot !== null);
  hub.advanceTime(45000);
  await host.set(`worlds/${WORLD_ID}/slots/0`, { uid: 'host-1', conn: 'ConnHost0001', at: host.serverTimestamp(), leaseUntil: hub.now() + 40000 });
  const r2 = await host.runTransaction(`worlds/${WORLD_ID}/authority`, (c) => ({ uid: 'host-1', epoch: c.epoch + 1, rev: c.rev + 1, leaseUntil: hub.now() + 8000 }));
  hb.setEpoch(r2.value.epoch);
  await hb.evictDeadSlots();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(evictedFired, true, 'evicted client must unseat cleanly via StreamClient.onSlots');
  assert.equal(victimSess.localSlotId, null);

  await victimSess.stop();
  hb.stop();
});

test('Audit #6: Brief SPACE tap dropSeq increment triggers 0.25 s host-side burst even if releasing is false on sample', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host } = await bootstrapWorld(hub, 'host-1');
  const { client: p1, conn: p1Conn } = await seatClient(hub, 'tap-pilot', 3, 'ConnTap00001');

  const sim = new FireSim(terrain, { isMegaBasin: true });
  const hb = new HostBroadcaster(host, WORLD_ID, {
    terrain, fireSim: sim, epoch: 1, buildHash: BUILD_HASH, localSlotId: 0, enableBackgroundTicker: false,
  });
  await hb.start();

  // Sample 1: dropSeq 0, not releasing
  await p1.set(`worlds/${WORLD_ID}/in/tap-pilot`, {
    s: 1, t: p1.serverTimestamp(), c: p1Conn,
    d: encodeInput({ x: 0, y: 80, z: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0, speedKmh: 158, releasing: false }, 0),
  });
  hb.step(0.1);
  assert.equal(hb.getPilotTank(3), 100);

  // Sample 2: brief tap happened between samples -> releasing already false, but dropSeq incremented to 1!
  hub.advanceTime(250);
  await p1.set(`worlds/${WORLD_ID}/in/tap-pilot`, {
    s: 2, t: p1.serverTimestamp(), c: p1Conn,
    d: encodeInput({ x: 0, y: 80, z: -10, yawDeg: 0, pitchDeg: 0, rollDeg: 0, speedKmh: 158, releasing: false }, 1),
  });

  // Step 0.3 s -> host drains >= 20% (0.25 s * 80%/s = 20%, quantized in 0.1 s steps -> 3 ticks = 24% or 2-3 ticks)
  hb.step(0.3);
  const tankAfter = hb.getPilotTank(3);
  assert.ok(tankAfter <= 85 && tankAfter >= 70, `Expected brief tap burst tank drain to ~76-80%, got ${tankAfter}`);
  hb.stop();
});

test('Audit #9: LoopbackBots rapid stop() during async boot leaks 0 bots and 0 hub listeners', async () => {
  const terrain = generateTerrain(MEGA_BASIN_OP);
  const localFireSim = new FireSim(terrain, { isMegaBasin: true });
  const loopback = createLoopbackSession({
    botCount: 40,
    terrain,
    fireSim: localFireSim,
    opConfig: MEGA_BASIN_OP,
    worldId: WORLD_ID,
    useRealClock: true,
  });

  const startPromise = loopback.session.start();
  // Stop immediately mid-boot!
  await loopback.stop();
  await startPromise;

  assert.equal(loopback.bots.length, 0, 'rapid stop() mid-boot must leak 0 bots');
  assert.equal(loopback.hub._listeners.size, 0, 'rapid stop() mid-boot must leak 0 hub listeners');
});

// ============================================================================
// 8. LIVE OPERATION ROLLOVER, DROP OUTCOME SYNC, CRASH RESPAWN & FAILOVER RULES
// ============================================================================
test('Live MP wire codecs: dropOutcomes + opIndex round-trip strictly within RTDB caps', () => {
  const outcomes = [
    {
      slotId: 7,
      impactX: 342,
      impactZ: -128,
      cellsExtinguished: 14,
      cellsCooled: 6,
      pointsAwarded: 980,
      outcome: 'direct',
      missType: 'none',
      missDirCompass: '',
      missDistM: 0,
      cabinSaved: true,
      dropQuality: 'optimal',
    },
    {
      slotId: 12,
      impactX: -210,
      impactZ: 88,
      cellsExtinguished: 2,
      cellsCooled: 4,
      pointsAwarded: 140,
      outcome: 'partial',
      missType: 'short',
      missDirCompass: 'NE',
      missDistM: 42,
      cabinSaved: false,
      dropQuality: 'optimal',
    },
    {
      slotId: 33,
      impactX: 500,
      impactZ: 220,
      cellsExtinguished: 0,
      cellsCooled: 0,
      pointsAwarded: 0,
      outcome: 'miss',
      missType: 'overshot',
      missDirCompass: 'SW',
      missDistM: 118,
      cabinSaved: false,
      dropQuality: 'optimal',
    },
  ];

  const deltaWire = encodeFireDelta({
    windDirDeg: 90,
    windSpeedKt: 12,
    changedCells: [{ idx: 420, state: 13, phase: 4 }],
    dropOutcomes: outcomes,
    missionScore: 5400,
    wave: 1,
    opIndex: 3,
    status: 'active',
  });
  assert.ok(deltaWire.length <= 2048);
  const decDelta = decodeFireDelta(deltaWire);
  assert.equal(decDelta.opIndex, 3);
  assert.equal(decDelta.dropOutcomes.length, 3);
  assert.deepEqual(decDelta.dropOutcomes[0], outcomes[0]);
  assert.deepEqual(decDelta.dropOutcomes[1], outcomes[1]);
  assert.deepEqual(decDelta.dropOutcomes[2], outcomes[2]);

  const keyWire = encodeFireKey({
    gridSize: 128,
    cells: new Uint8Array(128 * 128),
    cabinHp: new Uint8Array(10).fill(100),
    windDirDeg: 45,
    windSpeedKt: 14,
    wave: 1,
    opIndex: 2,
    missionScore: 1200,
    status: 'active',
    intermissionTimer: 0,
    slotScores: new Map([[7, 1200]]),
  });
  assert.ok(keyWire.length <= 12288);
  const decKey = decodeFireKey(keyWire);
  assert.equal(decKey.opIndex, 2);
  assert.equal(decKey.gridSize, 128);

  const metaWire = encodeMeta({
    wave: 1,
    opIndex: 4,
    missionScore: 9900,
    burningPct: 3.4,
    cabinsAlive: 9,
    cabinsTotal: 10,
    status: 'active',
    intermissionTimer: 0,
    pilotsCount: 4,
    top10: [{ slotId: 7, score: 9900 }],
  });
  assert.ok(metaWire.length <= 1024);
  const decMeta = decodeMeta(metaWire);
  assert.equal(decMeta.opIndex, 4);
  assert.equal(decMeta.pilotsCount, 4);
});

test('Live shared Operation 01->02 rollover, dropOutcome sync, and new-joiner detection', async () => {
  const op0 = OPERATIONS[0];
  const op1 = OPERATIONS[1];
  let hostTerrain = generateTerrain(op0);
  let hostSim = new FireSim(hostTerrain, { isMegaBasin: false });
  let repTerrain = generateTerrain(op0);
  let repSim = new FireSim(repTerrain, { isMegaBasin: false });

  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const hostAdapter = hub.createClient('op-host');
  const repAdapter = hub.createClient('op-rep');
  const lateAdapter = hub.createClient('op-late');

  const repOutcomes = [];
  const repJoinedPilots = [];
  const repEventsOrder = [];

  const hostSess = new WorldSession({
    adapter: hostAdapter,
    terrain: hostTerrain,
    fireSim: hostSim,
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    callsign: 'HOST-01',
    colorIdx: 0,
    disableRealTimers: true,
  });

  const repSess = new WorldSession({
    adapter: repAdapter,
    terrain: repTerrain,
    fireSim: repSim,
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    callsign: 'REP-02',
    colorIdx: 1,
    disableRealTimers: true,
    onDropOutcomes: (list) => repOutcomes.push(...list),
    onPilotJoined: (p) => repJoinedPilots.push(p),
    onOperationChange: (nextIdx) => {
      repEventsOrder.push(`opChange:${nextIdx}`);
      const nextOp = OPERATIONS[nextIdx];
      repTerrain = generateTerrain(nextOp);
      repSim = new FireSim(repTerrain, { isMegaBasin: false });
      repSess.setWorld({ terrain: repTerrain, fireSim: repSim, opConfig: nextOp, opIndex: nextIdx, publishNow: false });
    },
    onFireSync: ({ full }) => {
      if (full) repEventsOrder.push(`fireKey:${repSess.opIndex}`);
    },
  });

  await hostSess.start();
  await hostSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 10));
  await repSess.start();
  await repSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 10));

  // Initial roster already had HOST-01; REP-02 joining itself must NOT fire onPilotJoined.
  assert.equal(repJoinedPilots.length, 0, 'initial roster and self must not trigger mp_join');

  // Latecomer joins -> triggers onPilotJoined on replica!
  const lateSess = new WorldSession({
    adapter: lateAdapter,
    terrain: generateTerrain(op0),
    fireSim: new FireSim(generateTerrain(op0), { isMegaBasin: false }),
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    callsign: 'WING-03',
    colorIdx: 5,
    disableRealTimers: true,
  });
  await lateSess.start();
  await lateSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(repJoinedPilots.length, 1, 'new joiner must trigger onPilotJoined once');
  assert.equal(repJoinedPilots[0].name, 'WING-03');

  // Inject a drop outcome on Host and step so fireRing publishes it -> Replica receives it!
  hostSess.host._pendingDropOutcomes.push({
    slotId: repSess.localSlotId,
    impactX: 120,
    impactZ: -45,
    cellsExtinguished: 9,
    cellsCooled: 3,
    pointsAwarded: 630,
    outcome: 'direct',
    missType: 'none',
    missDirCompass: '',
    missDistM: 0,
    cabinSaved: false,
  });
  hub.advanceTime(600);
  hostSess.step(0.1, hub.now());
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(repOutcomes.length, 1, 'Replica must receive synced dropOutcomes from fireRing');
  assert.equal(repOutcomes[0].outcome, 'direct');
  assert.equal(repOutcomes[0].cellsExtinguished, 9);

  // Host rolls Operation 0 -> Operation 1 via setWorld!
  hub.advanceTime(5000);
  hostTerrain = generateTerrain(op1);
  hostSim = new FireSim(hostTerrain, { isMegaBasin: false });
  hostSess.setWorld({ terrain: hostTerrain, fireSim: hostSim, opConfig: op1, opIndex: 1 });
  for (let i = 0; i < 15; i++) {
    hub.advanceTime(200);
    hostSess.step(0.1, hub.now());
    repSess.step(0.1, hub.now());
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(repSess.opIndex, 1, 'Replica must sync to Operation 02 (opIndex 1)');
  const opChangeIdx = repEventsOrder.indexOf('opChange:1');
  const fireKeyIdx = repEventsOrder.indexOf('fireKey:1');
  assert.ok(opChangeIdx >= 0 && fireKeyIdx > opChangeIdx, `onOperationChange must fire before onFireKey (${repEventsOrder.join(', ')})`);

  await lateSess.stop();
  await repSess.stop();
  await hostSess.stop();
});

test('Remote pilot crash/respawn preserves slot, zeroes tank while crashed, and snaps on respawn', async () => {
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host } = await bootstrapWorld(hub, 'host-1');
  const { client: p1, conn: p1Conn } = await seatClient(hub, 'crash-pilot', 4, 'ConnCrash001');

  const sim = new FireSim(terrain, { isMegaBasin: false });
  const hb = new HostBroadcaster(host, WORLD_ID, {
    terrain, fireSim: sim, epoch: 1, opIndex: 0, buildHash: BUILD_HASH, localSlotId: 0, enableBackgroundTicker: false,
  });
  await hb.start();

  // Normal flight at (0, 60, 0)
  await p1.set(`worlds/${WORLD_ID}/in/crash-pilot`, {
    s: 1, t: p1.serverTimestamp(), c: p1Conn,
    d: encodeInput({ x: 0, y: 60, z: 0, yawDeg: 90, pitchDeg: 0, rollDeg: 0, speedKmh: 158, releasing: false }, 0),
  });
  hb.step(0.1);
  assert.equal(hb.getPilotTank(4), 100);

  // Pilot crashes -> WorldSession sends speedKmh = 0 heartbeat
  hub.advanceTime(250);
  await p1.set(`worlds/${WORLD_ID}/in/crash-pilot`, {
    s: 2, t: p1.serverTimestamp(), c: p1Conn,
    d: encodeInput({ x: 5, y: 20, z: 0, yawDeg: 90, pitchDeg: -20, rollDeg: 0, speedKmh: 0, releasing: false, crashed: true }, 0),
  });
  hb.step(0.1);
  assert.equal(hb.getPilotTank(4), 0, 'crashed pilot tank must drop to 0');

  // 3.5 s later pilot respawns 700 m away on perimeter corridor -> must snap immediately!
  hub.advanceTime(3500);
  await p1.set(`worlds/${WORLD_ID}/in/crash-pilot`, {
    s: 3, t: p1.serverTimestamp(), c: p1Conn,
    d: encodeInput({ x: -700, y: 80, z: 400, yawDeg: 45, pitchDeg: 0, rollDeg: 0, speedKmh: 158, releasing: false }, 0),
  });
  hb.step(0.1);
  const p = hb._pilots.get(4);
  assert.ok(p, 'crashed pilot slot must remain active through respawn');
  assert.ok(Math.abs(p.x - (-700)) < 1 && Math.abs(p.z - 400) < 1, `respawn must snap without teleport drag (got ${p.x}, ${p.z})`);
  assert.equal(p.tankPct, 0, 'respawned pilot starts with 0% tank');
  hb.stop();
});

test('Reconciled RTDB rules: fireKey/meta allow immediate failover on epoch bump while pacing same-epoch spam', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host: h1 } = await bootstrapWorld(hub, 'host-1');
  const { client: h2 } = await seatClient(hub, 'host-2', 1, 'ConnHost0002');

  const keyStr = encodeFireKey({
    gridSize: 128,
    cells: new Uint8Array(128 * 128),
    cabinHp: new Uint8Array(10).fill(100),
    windDirDeg: 90,
    windSpeedKt: 12,
    wave: 1,
    opIndex: 0,
    missionScore: 0,
    status: 'active',
    intermissionTimer: 0,
    slotScores: new Map(),
  });
  const metaStr = encodeMeta({
    wave: 1, opIndex: 0, missionScore: 0, burningPct: 1.0, cabinsAlive: 10, cabinsTotal: 10,
    status: 'active', intermissionTimer: 0, pilotsCount: 2, top10: [],
  });

  // Epoch 1 Host writes fireKey & meta
  await h1.set(`worlds/${WORLD_ID}/fireKey`, { e: 1, q: 1, t: h1.serverTimestamp(), d: keyStr });
  await h1.set(`worlds/${WORLD_ID}/meta`, { e: 1, t: h1.serverTimestamp(), d: metaStr });

  // Same-epoch rapid spam (< 4 s / < 0.8 s) MUST still be rejected!
  hub.advanceTime(200);
  await assert.rejects(
    h1.set(`worlds/${WORLD_ID}/fireKey`, { e: 1, q: 2, t: h1.serverTimestamp(), d: keyStr }),
    /PERMISSION_DENIED/
  );
  await assert.rejects(
    h1.set(`worlds/${WORLD_ID}/meta`, { e: 1, t: h1.serverTimestamp(), d: metaStr }),
    /PERMISSION_DENIED/
  );

  // Epoch 2 Host takes over after voluntary abdication -> immediate fireKey & meta publish MUST succeed!
  await h1.set(`worlds/${WORLD_ID}/authority`, { uid: 'host-1', epoch: 1, rev: 1, leaseUntil: h1.serverTimestamp() });
  hub.advanceTime(1);
  const tx = await h2.runTransaction(`worlds/${WORLD_ID}/authority`, (cur) => ({
    uid: 'host-2',
    epoch: cur.epoch + 1,
    rev: cur.rev + 1,
    leaseUntil: hub.now() + 8000,
  }));
  assert.equal(tx.committed, true);
  assert.equal(tx.value.epoch, 2);

  await h2.set(`worlds/${WORLD_ID}/fireKey`, { e: 2, q: 2, t: h2.serverTimestamp(), d: keyStr });
  await h2.set(`worlds/${WORLD_ID}/meta`, { e: 2, t: h2.serverTimestamp(), d: metaStr });
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/fireKey/e`), 2);
  assert.equal(hub.inspect(`worlds/${WORLD_ID}/meta/e`), 2);
});

// ============================================================================
// 9. #49 CAPACITY-FULL & OFFLINE FALLBACK + #50 LAG ISOLATION & JITTER SMOOTHNESS
// ============================================================================
test('#49: 100-player full airspace triggers offline_full fallback, releases RTDB, and fresh reload retries live', async () => {
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  await bootstrapWorld(hub, 'pilot-0');

  // Fill remaining 99 slots (slots 1..99) so airspace is strictly 100/100 full!
  const now = hub.now();
  const rootWorld = hub._root.worlds[WORLD_ID];
  for (let s = 1; s < 100; s++) {
    const uid = `pilot-${s}`;
    const conn = `ConnFull${String(s).padStart(4, '0')}`;
    rootWorld.presence[uid] = { conn, at: now };
    rootWorld.slots[String(s)] = { uid, conn, at: now, leaseUntil: now + 40000 };
    rootWorld.uidToSlot[uid] = s;
    rootWorld.roster[String(s)] = { uid, name: `P-${s}`, color: s % 16, at: now };
  }

  // Pilot 101 joins with fallbackOnFull: true -> detects 100/100 full immediately and goes offline!
  const overflowAdapter = hub.createClient('pilot-101');
  let capFullCalled = false;
  const overflowSess = new WorldSession({
    adapter: overflowAdapter,
    terrain,
    fireSim: new FireSim(terrain, { isMegaBasin: true }),
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    callsign: 'OVER-101',
    colorIdx: 2,
    fallbackOnFull: true,
    disableRealTimers: true,
    onCapacityFull: () => { capFullCalled = true; },
  });

  await overflowSess.start();
  assert.equal(capFullCalled, true, 'onCapacityFull must fire when 100/100 slots occupied');
  const net = overflowSess.getNetState();
  assert.equal(net.connStatus, 'offline_full', 'connStatus must report offline_full');
  assert.equal(net.offlineFallback, true, 'offlineFallback must be true');
  assert.equal(overflowAdapter.connected, false, 'RTDB socket must be released via goOffline() on fallback');
  await overflowSess.stop();

  // Mid-session takeover full test: vacate slot 99 on join, fill it before requestManualControl()!
  delete rootWorld.slots['99'];
  delete rootWorld.uidToSlot['pilot-99'];
  const lateAdapter = hub.createClient('pilot-102');
  let takeoverFull = false;
  const lateSess = new WorldSession({
    adapter: lateAdapter,
    terrain,
    fireSim: new FireSim(terrain, { isMegaBasin: true }),
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    fallbackOnFull: true,
    disableRealTimers: true,
    onCapacityFull: () => { takeoverFull = true; },
  });
  await lateSess.start();
  assert.equal(lateSess.getNetState().connStatus, 'online', 'joins online when 99/100 occupied');

  // Slot 99 fills right before pilot-102 takes manual control
  rootWorld.slots['99'] = { uid: 'pilot-99', conn: 'ConnFull0099', at: now, leaseUntil: now + 40000 };
  rootWorld.uidToSlot['pilot-99'] = 99;
  const claimRes = await lateSess.requestManualControl();
  assert.equal(claimRes.seated, false);
  assert.equal(claimRes.full, true);
  assert.equal(takeoverFull, true, 'full slot claim must trigger onCapacityFull');
  assert.equal(lateSess.getNetState().connStatus, 'offline_full');
  assert.equal(lateAdapter.connected, false, 'full takeover fallback must call goOffline()');
  await lateSess.stop();

  // Simulate fresh page reload after a slot opens -> connects online and claims slot cleanly!
  delete rootWorld.slots['99'];
  delete rootWorld.uidToSlot['pilot-99'];
  const reloadAdapter = hub.createClient('pilot-103');
  const reloadSess = new WorldSession({
    adapter: reloadAdapter,
    terrain,
    fireSim: new FireSim(terrain, { isMegaBasin: true }),
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    fallbackOnFull: true,
    disableRealTimers: true,
  });
  await reloadSess.start();
  assert.equal(reloadSess.getNetState().connStatus, 'online', 'fresh session retries live and connects online');
  const seatRes = await reloadSess.requestManualControl();
  assert.equal(seatRes.seated, true, 'reloaded pilot claims open slot');
  assert.equal(seatRes.slotId, 99);
  await reloadSess.stop();
});

test('#49: Prolonged connection failure sets connStatus offline_error and releases RTDB', async () => {
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  await bootstrapWorld(hub, 'host-1');

  const client = hub.createClient('net-drop-1');
  let errFired = null;
  const sess = new WorldSession({
    adapter: client,
    terrain,
    fireSim: new FireSim(terrain, { isMegaBasin: true }),
    opConfig: op0,
    worldId: WORLD_ID,
    buildHash: BUILD_HASH,
    fallbackOnFull: true,
    disableRealTimers: true,
    onConnectionError: (e) => { errFired = e; },
  });

  await sess.start();
  assert.equal(sess.getNetState().connStatus, 'online');

  // Drop link and hold offline > 12 s
  client.goOffline();
  assert.equal(sess.getNetState().connStatus, 'connecting');
  hub.advanceTime(13000);
  sess.step(0.1, hub.now());

  assert.ok(errFired, 'onConnectionError must fire after sustained outage');
  const net = sess.getNetState();
  assert.equal(net.connStatus, 'offline_error');
  assert.equal(net.offlineFallback, true);
  assert.ok(typeof net.offlineReason === 'string' && net.offlineReason.length > 0);
  await sess.stop();
});

test('#50: Strict lag isolation + Vanguard jitter smoothness (500-700 ms jitter + 40% drop on 1 peer)', async () => {
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const { host } = await bootstrapWorld(hub, 'host-1');
  const { client: healthyClient, conn: healthyConn } = await seatClient(hub, 'healthy-1', 1, 'ConnHlth0001');
  const { client: laggyClient, conn: laggyConn } = await seatClient(hub, 'laggy-2', 2, 'ConnLagy0002');

  const sim = new FireSim(terrain, { isMegaBasin: true });
  const hb = new HostBroadcaster(host, WORLD_ID, {
    terrain, fireSim: sim, epoch: 1, opIndex: 0, buildHash: BUILD_HASH, localSlotId: 0, enableBackgroundTicker: false,
  });
  await hb.start();

  const interp = new PlaneInterpolator();
  let healthySeq = 0;
  let laggySeq = 0;

  // Deterministic pseudo-random jitter/loss for laggy peer (slot 2)
  const laggyQueue = []; // { deliverAtMs, payload }
  let rngState = 1337;
  const nextRand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  let prevHealthyPose = null;
  let prevLaggyPose = null;
  let maxHealthyFrameStep = 0;
  let maxLaggyFrameStep = 0;
  let staleLaggyRoll = 999;

  const startMs = hub.now();
  const totalSteps = 80; // 8.0 seconds at 100 ms Host steps
  for (let tick = 0; tick < totalSteps; tick++) {
    const tSec = tick * 0.1;
    const now = startMs + tick * 100;

    // 4 Hz client input generation (every 250 ms -> ticks 0, 2, 5, 7, ...)
    if (tick === 0 || tick % 3 === 0) {
      // Slot 1: healthy smooth flight (~44 m/s along -Z with gentle curve)
      const hX = Math.sin(tSec * 0.3) * 80;
      const hZ = -tSec * 44;
      const hYaw = (Math.cos(tSec * 0.3) * 18 + 360) % 360;
      await healthyClient.set(`worlds/${WORLD_ID}/in/healthy-1`, {
        s: ++healthySeq,
        t: healthyClient.serverTimestamp(),
        c: healthyConn,
        d: encodeInput({
          x: hX, y: 80, z: hZ, yawDeg: hYaw, pitchDeg: 0, rollDeg: 15, speedKmh: 158, releasing: false,
        }, 0),
      });

      // Slot 2: laggy peer with 40% packet drop + 500-700 ms jitter + 2.0 s total Wi-Fi silence (t=4.5..6.5 s)
      const inSilenceWindow = tSec >= 4.5 && tSec <= 6.5;
      const dropped = inSilenceWindow || (tick > 0 && nextRand() < 0.4);
      if (!dropped) {
        const lX = 200 + tSec * 40;
        const lZ = -100 + Math.sin(tSec * 0.5) * 40;
        const jitterDelay = tick === 0 ? 0 : Math.round(500 + nextRand() * 200);
        laggyQueue.push({
          deliverAtMs: now + jitterDelay,
          payload: {
            x: lX, y: 85, z: lZ, yawDeg: 90, pitchDeg: 2, rollDeg: 38, speedKmh: 155, releasing: false,
          },
        });
      }
    }

    // Deliver delayed laggy packets whose jitter timer elapsed (respecting 180 ms server pacing rule)
    while (laggyQueue.length > 0 && laggyQueue[0].deliverAtMs <= now) {
      const pkt = laggyQueue.shift();
      await laggyClient.set(`worlds/${WORLD_ID}/in/laggy-2`, {
        s: ++laggySeq,
        t: laggyClient.serverTimestamp(),
        c: laggyConn,
        d: encodeInput(pkt.payload, 0),
      }).catch(() => {});
    }

    // Step Host deterministically at 10 Hz
    hb.step(0.1);

    // Every 250 ms (every ~3 ticks), push planes snapshot into PlaneInterpolator (with slight arrival jitter)
    if (tick > 0 && tick % 2 === 0 && hb.lastPublishedPlanes.length > 0) {
      const arrivalJitter = (tick % 4 === 0) ? 35 : 0;
      interp.pushSnapshot(hb.lastPublishedPlanes, now + arrivalJitter, 0, now);
    }

    // Sample rendered poses at 60 Hz across this 100 ms interval (6 frames @ 16.67 ms)
    for (let f = 0; f < 6; f++) {
      const frameMs = now + Math.round(f * 16.67);
      const sampled = interp.sample(frameMs, { excludeSlotId: 0 });
      const p1 = sampled.find((p) => p.slotId === 1);
      const p2 = sampled.find((p) => p.slotId === 2);

      if (p1) {
        if (prevHealthyPose) {
          const d = Math.hypot(p1.x - prevHealthyPose.x, p1.y - prevHealthyPose.y, p1.z - prevHealthyPose.z);
          if (d > maxHealthyFrameStep) maxHealthyFrameStep = d;
        }
        prevHealthyPose = p1;
      }
      if (p2) {
        if (prevLaggyPose) {
          const d = Math.hypot(p2.x - prevLaggyPose.x, p2.y - prevLaggyPose.y, p2.z - prevLaggyPose.z);
          if (d > maxLaggyFrameStep) maxLaggyFrameStep = d;
        }
        prevLaggyPose = p2;
        if (tSec >= 6.2 && tSec <= 6.4) {
          staleLaggyRoll = Math.abs(p2.rollDeg);
        }
      }
    }

    hub.advanceTime(100);
  }

  assert.ok(prevHealthyPose && prevLaggyPose, 'both healthy and laggy peers must render');
  assert.ok(
    maxHealthyFrameStep < 2.2,
    `healthy peer must remain silky & isolated from peer lag (max 60Hz frame step=${maxHealthyFrameStep.toFixed(2)} m)`
  );
  assert.ok(
    maxLaggyFrameStep < 5.0,
    `laggy peer must converge smoothly with zero teleport pops (max 60Hz frame step=${maxLaggyFrameStep.toFixed(2)} m)`
  );
  assert.ok(
    staleLaggyRoll < 12,
    `stale laggy peer (>1.5s silent) must smoothly level wings (roll=${staleLaggyRoll.toFixed(1)}°)`
  );

  hb.stop();
});

test('#50: Laggy Host tracks publish stall wait and self-abdicates when writes stall > 4.5 s with peers present', async () => {
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const hostAdapter = hub.createClient('stall-host');
  const peerAdapter = hub.createClient('healthy-peer');

  const hostSess = new WorldSession({
    adapter: hostAdapter, terrain, fireSim: new FireSim(terrain, { isMegaBasin: true }), opConfig: op0,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'SHOST', colorIdx: 0, disableRealTimers: true,
  });
  const peerSess = new WorldSession({
    adapter: peerAdapter, terrain, fireSim: new FireSim(terrain, { isMegaBasin: true }), opConfig: op0,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'HPEER', colorIdx: 1, disableRealTimers: true,
  });

  await hostSess.start();
  await hostSess.requestManualControl();
  await peerSess.start();
  await peerSess.requestManualControl();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(hostSess.isHost, true);

  // Black-hole host socket so planes publish hangs in-flight > 4.5 s
  hub.simulateBlackHole('stall-host', true);
  hub.advanceTime(300);
  hostSess.step(0.1, hub.now()); // triggers hanging publishPlanes()
  await Promise.resolve(); // allow microtask to arm stall timer on genuinely pending write
  hub.advanceTime(4700);
  assert.ok(hostSess.host.getPublishWaitMs(hub.now()) > 4500, 'Host must track stalled publish wait > 4500 ms');

  // Stepping hostSess triggers self-abdication so healthy peer isn't dragged down!
  hostSess.step(0.1, hub.now());
  assert.equal(hostSess.isHost, false, 'stalled Host with healthy peer present must voluntarily abdicate');

  hub.simulateBlackHole('stall-host', false);
  await peerSess.stop();
  await hostSess.stop();
});

// ============================================================================
// 10. #60 HOST & REPLICA WATER DROP EXTINGUISHMENT + LOBBY HOSTING/DISCOVERY
// ============================================================================
test('#60: Both Host AND remote Replica water drops extinguish fire cells and sync back to all clients', async () => {
  const op0 = OPERATIONS[0];
  const hostTerrain = generateTerrain(op0);
  const repTerrain = generateTerrain(op0);
  const hostSim = new FireSim(hostTerrain, { isMegaBasin: true });
  const repSim = new FireSim(repTerrain, { isMegaBasin: true });

  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const hostAdapter = hub.createClient('drop-host');
  const repAdapter = hub.createClient('drop-rep');

  const hostOutcomes = [];
  const repOutcomes = [];

  const hostSess = new WorldSession({
    adapter: hostAdapter, terrain: hostTerrain, fireSim: hostSim, opConfig: op0,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'DHOST', colorIdx: 0,
    disableRealTimers: true,
    onDropOutcomes: (list) => hostOutcomes.push(...list),
  });
  const repSess = new WorldSession({
    adapter: repAdapter, terrain: repTerrain, fireSim: repSim, opConfig: op0,
    worldId: WORLD_ID, buildHash: BUILD_HASH, callsign: 'DREP', colorIdx: 1,
    disableRealTimers: true,
    onDropOutcomes: (list) => repOutcomes.push(...list),
  });

  await hostSess.start();
  const hClaim = await hostSess.requestManualControl();
  assert.equal(hClaim.seated, true);
  assert.equal(await hostSess.waitUntilHostReady(2000), true, 'Host must hydrate cleanly');

  await repSess.start();
  const rClaim = await repSess.requestManualControl();
  assert.equal(rClaim.seated, true);
  assert.notEqual(rClaim.slotId, hClaim.slotId);
  await new Promise((r) => setTimeout(r, 15));

  // Phase 1: Host drops water directly over active fire head at optimal 32 m AGL!
  const head1 = hostSim.getSnapshot().fireHead;
  assert.ok(head1, 'expected initial fire head');
  const ground1 = Math.max(hostTerrain.waterLevel, hostTerrain.getHeight(head1.x, head1.z));
  const burningBefore = hostSim.getSnapshot().burningCount;

  // Position slightly south of fire head flying north so ballistic parcel lands dead-center on fireHead
  const hostAircraft = {
    x: head1.x,
    y: ground1 + 32,
    z: head1.z + 55,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    speedKmh: 158,
    vx: 0,
    vy: 0,
    vz: -158 / 3.6,
    tankPct: 100,
    releasing: true,
    scooping: false,
    autopilot: false,
    crashed: false,
  };

  for (let i = 0; i < 32; i++) {
    hub.advanceTime(100);
    // Keep plane advancing north along drop run for first 0.8 s, then stop releasing while parcels land
    hostAircraft.z -= (158 / 3.6) * 0.1;
    hostAircraft.releasing = i < 8;
    if (hostAircraft.releasing) hostAircraft.tankPct = Math.max(0, hostAircraft.tankPct - 8);
    hostSess.sendLocalState(hostAircraft, 1);
    hostSess.step(0.1, hub.now());
    repSess.step(0.1, hub.now());
    await Promise.resolve();
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 15));

  const hostBurnAfterP1 = hostSim.getSnapshot().burningCount;
  const repBurnAfterP1 = repSim.getSnapshot().burningCount;
  assert.ok(
    burningBefore - hostBurnAfterP1 >= 8,
    `Host water drop must extinguish >= 8 cells (before=${burningBefore}, after=${hostBurnAfterP1})`
  );
  assert.ok(hostSim.missionScore > 0, `Host missionScore must increase (got ${hostSim.missionScore})`);
  assert.ok(
    Math.abs(repBurnAfterP1 - hostBurnAfterP1) <= 3,
    `Replica must receive Host extinguishment via fireRing (host=${hostBurnAfterP1}, rep=${repBurnAfterP1})`
  );
  assert.ok(hostOutcomes.some((o) => o.slotId === hClaim.slotId && o.cellsExtinguished >= 5), 'Host dropOutcome emitted');
  assert.ok(repOutcomes.some((o) => o.slotId === hClaim.slotId && o.cellsExtinguished >= 5), 'Replica received Host dropOutcome');

  // Phase 2: Remote Replica drops water over active fire head via in/$uid -> HostBroadcaster -> FireSim -> fireRing!
  const head2 = hostSim.getSnapshot().fireHead;
  assert.ok(head2, 'expected remaining fire head for Replica pass');
  const ground2 = Math.max(hostTerrain.waterLevel, hostTerrain.getHeight(head2.x, head2.z));
  const burningMid = hostSim.getSnapshot().burningCount;
  const scoreMid = hostSim.missionScore;

  const repAircraft = {
    x: head2.x,
    y: ground2 + 32,
    z: head2.z + 55,
    yawDeg: 0,
    pitchDeg: 0,
    rollDeg: 0,
    speedKmh: 158,
    tankPct: 100,
    releasing: true,
    scooping: false,
    autopilot: false,
    crashed: false,
  };

  for (let i = 0; i < 36; i++) {
    hub.advanceTime(100);
    repAircraft.z -= (158 / 3.6) * 0.1;
    repAircraft.releasing = i < 10;
    repSess.sendLocalState(repAircraft, 1);
    hostSess.step(0.1, hub.now());
    repSess.step(0.1, hub.now());
    await Promise.resolve();
    await Promise.resolve();
  }
  await new Promise((r) => setTimeout(r, 15));

  const hostBurnAfterP2 = hostSim.getSnapshot().burningCount;
  const repBurnAfterP2 = repSim.getSnapshot().burningCount;
  assert.ok(
    burningMid - hostBurnAfterP2 >= 5,
    `Remote Replica water drop must extinguish >= 5 cells on Host (mid=${burningMid}, after=${hostBurnAfterP2})`
  );
  assert.ok(hostSim.missionScore > scoreMid, 'Remote Replica drop must award missionScore');
  assert.ok(
    Math.abs(repBurnAfterP2 - hostBurnAfterP2) <= 3,
    `Remote Replica fire grid must sync its own extinguishment (host=${hostBurnAfterP2}, rep=${repBurnAfterP2})`
  );
  assert.ok(
    repOutcomes.some((o) => o.slotId === rClaim.slotId && o.cellsExtinguished >= 5),
    'Remote Replica must receive its own synced dropOutcome back via fireRing'
  );

  await repSess.stop();
  await hostSess.stop();
});

test('#60: LobbyDirectory lists only live lobbies, picks unused/stale shard, and forceFreshMission resets stale shard', async () => {
  const hub = new MockRtdbHub({ initialTime: 1_700_000_000_000 });
  const now = hub.now();

  // Seed active lobby megabasin-01, stale dead lobby megabasin-02, and staging megabasin-20
  await bootstrapWorld(hub, 'active-host', 'megabasin-01');
  hub._root.worldsIndex = {
    'megabasin-01': {
      name: 'Cinderpine Basin', mode: 'megabasin', players: 3, cap: 100,
      buildHash: BUILD_HASH, protocolVersion: 1, updatedAt: now - 2000, expiresAt: now + WORLD_TTL_MS,
    },
    'megabasin-02': {
      name: 'Ashen Caldera', mode: 'megabasin', players: 1, cap: 100,
      buildHash: BUILD_HASH, protocolVersion: 1, updatedAt: now - 90000, expiresAt: now + WORLD_TTL_MS,
    },
    'megabasin-20': {
      name: 'Staging', mode: 'megabasin', players: 1, cap: 100,
      buildHash: BUILD_HASH, protocolVersion: 1, updatedAt: now - 1000, expiresAt: now + WORLD_TTL_MS,
    },
  };

  // Seed stale megabasin-02 with expired authority & old dead fireKey (cabin 0 destroyed = 0 HP)
  await bootstrapWorld(hub, 'old-host', 'megabasin-02');
  hub._root.worlds['megabasin-02'].authority.leaseUntil = now - 10000;
  hub._root.worlds['megabasin-02'].fireKey = {
    e: 1,
    q: 42,
    t: now - 90000,
    d: encodeFireKey({
      gridSize: 128,
      cells: new Uint8Array(128 * 128),
      cabinHp: Uint8Array.from([0, 0, 100, 100, 100, 100, 100, 100, 100, 100]),
      windDirDeg: 90, windSpeedKt: 12, wave: 1, opIndex: 2, missionScore: 9999,
      status: 'active', intermissionTimer: 0, slotScores: new Map(),
    }),
  };

  const client = hub.createClient('new-host');
  const live = await listLiveLobbies(client);
  assert.equal(live.length, 1, 'must list only fresh active non-staging lobbies');
  assert.equal(live[0].worldId, 'megabasin-01');
  assert.equal(live[0].players, 3);

  const picked = await pickHostableShard(client);
  assert.equal(picked.worldId, 'megabasin-03', 'must pick unused megabasin-03 without stealing active megabasin-01');
  assert.equal(picked.isFresh, true);
  assert.equal(
    buildLobbyInviteUrl('megabasin-03', { origin: 'https://ember-front-rtdb.web.app', pathname: '/' }),
    'https://ember-front-rtdb.web.app/?lobby=megabasin-03'
  );

  // Host a fresh mission on stale megabasin-02 -> must NOT resurrect dead opIndex=2 / cabinHp=0!
  const op0 = OPERATIONS[0];
  const terrain = generateTerrain(op0);
  const freshSim = new FireSim(terrain, { isMegaBasin: true });
  const freshHostSess = new WorldSession({
    adapter: client, terrain, fireSim: freshSim, opConfig: op0,
    worldId: 'megabasin-02', buildHash: BUILD_HASH, callsign: 'NEWHOST', colorIdx: 0,
    forceFreshMission: true, disableRealTimers: true,
  });
  await freshHostSess.start();
  await freshHostSess.requestManualControl();
  assert.equal(await freshHostSess.waitUntilHostReady(2000), true, 'new Host must take over stale shard cleanly');
  assert.equal(freshHostSess.opIndex, 0, 'forceFreshMission must stay on fresh Operation 01');
  assert.equal(freshSim.cabinHp[0], 100, 'forceFreshMission must NOT resurrect old destroyed cabins');
  const keyDecoded = decodeFireKey(hub.inspect('worlds/megabasin-02/fireKey/d'));
  assert.equal(keyDecoded.opIndex, 0);
  assert.equal(keyDecoded.cabinHp[0], 100);
  assert.equal(hub.inspect('worldsIndex/megabasin-02/players'), 1);

  await freshHostSess.stop();
});

test('#60: dropQuality (optimal / misted_high / low_risk) round-trips through fireRing wire codec', () => {
  const outcomes = [
    { slotId: 1, impactX: 10, impactZ: 20, cellsExtinguished: 18, cellsCooled: 4, pointsAwarded: 1260, outcome: 'direct', missType: 'none', missDirCompass: '', missDistM: 0, cabinSaved: false, dropQuality: 'optimal' },
    { slotId: 2, impactX: 30, impactZ: -40, cellsExtinguished: 1, cellsCooled: 3, pointsAwarded: 70, outcome: 'partial', missType: 'none', missDirCompass: '', missDistM: 0, cabinSaved: false, dropQuality: 'misted_high' },
    { slotId: 3, impactX: -50, impactZ: 60, cellsExtinguished: 7, cellsCooled: 2, pointsAwarded: 490, outcome: 'direct', missType: 'none', missDirCompass: '', missDistM: 0, cabinSaved: true, dropQuality: 'low_risk' },
  ];
  const wire = encodeFireDelta({ windDirDeg: 90, windSpeedKt: 12, dropOutcomes: outcomes, missionScore: 1820, wave: 1, opIndex: 0 });
  const dec = decodeFireDelta(wire);
  assert.equal(dec.dropOutcomes[0].dropQuality, 'optimal');
  assert.equal(dec.dropOutcomes[1].dropQuality, 'misted_high');
  assert.equal(dec.dropOutcomes[2].dropQuality, 'low_risk');
});
