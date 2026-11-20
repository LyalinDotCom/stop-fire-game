// Opt-in Tier 2 live staging smoke test targeting ONLY megabasin-20 (STAGING_WORLD_IDS).
// Run manually: node test/live-smoke.mjs
// Strictly idempotent (handles both fresh world creation and existing expired authority takeover)
// with full `finally` teardown (abdicate + conditional leaf delete + deleteUser).

import assert from 'node:assert/strict';
import { connectFirebase } from '../src/net/FirebaseClient.js';
import { STAGING_WORLD_IDS } from '../src/net/firebaseConfig.js';
import { Presence } from '../src/net/Presence.js';
import { SlotAllocator } from '../src/net/SlotAllocator.js';
import { AuthorityElection } from '../src/net/AuthorityElection.js';
import { getBuildHash } from '../src/net/config.js';
import { encodeFireDelta, encodeFireKey, encodeInput, encodeMeta, encodePlanes } from '../src/net/protocol.js';

const WORLD_ID = STAGING_WORLD_IDS[1]; // 'megabasin-20' ONLY

async function main() {
  console.log(`[live-smoke] Connecting anonymously to ${WORLD_ID}...`);
  const adapter = await connectFirebase({ tab: true, appName: 'ember-front-smoke' });
  const presence = new Presence(adapter, WORLD_ID, null, { autoStart: false });
  const allocator = new SlotAllocator(adapter, WORLD_ID);
  const election = new AuthorityElection(adapter, WORLD_ID, {
    disablePageHooks: true,
    canBeHost: () => allocator.isSeated,
  });

  try {
    // 1. Bounded worldsIndex discovery query
    const worldsIndex = await adapter.queryWorldsIndex({ limit: 20 });
    assert.equal(typeof worldsIndex, 'object');
    console.log('[live-smoke] worldsIndex bounded query OK');

    // 2. Attach authority listener BEFORE any transaction
    election.start();

    // 3. Presence sequential write -> onDisconnect arm (commit connId only after ack)
    const ok = await presence.mark();
    assert.equal(ok, true, 'presence mark failed');
    assert.ok(presence.connId, 'expected acked connId');
    console.log(`[live-smoke] presence OK (uid=${adapter.uid.slice(0, 8)}, conn=${presence.connId})`);

    // 4. Claim O(1) slot atomically with exact deployed schema
    const claim = await allocator.claim({
      callsign: 'SMOKE-20',
      colorIdx: 0,
      connId: presence.connId,
      buildHash: getBuildHash(),
    });
    assert.equal(claim.seated, true, 'failed to claim slot on staging shard');
    console.log(`[live-smoke] claimed slot ${claim.slotId} (createdWorld=${claim.createdWorld})`);

    if (claim.createdWorld) {
      election.notifyInitialHost({
        uid: adapter.uid,
        epoch: 1,
        rev: 0,
        leaseUntil: adapter.now() + 8000,
      });
    } else {
      await new Promise((r) => setTimeout(r, 250));
      if (!election.isHost) {
        await election.attemptTakeover();
      }
    }

    // 5. Write valid monotonic input tuple { s, t, c, d }
    const d = encodeInput({ x: 0, y: 60, z: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0, speedKmh: 158 }, 1);
    await adapter.set(`worlds/${WORLD_ID}/in/${adapter.uid}`, {
      s: 1,
      t: adapter.serverTimestamp(),
      c: presence.connId,
      d,
    });
    allocator.markInputWritten();
    console.log('[live-smoke] in/$uid write OK');

    // 6. If we hold live Host authority, verify planes, fireRing, fireKey, meta, and worldsIndex!
    if (election.isHost) {
      const ep = election.epoch;
      const cfg = await adapter.get(`worlds/${WORLD_ID}/config`);
      const pStr = encodePlanes([{
        slotId: claim.slotId, x: 0, y: 60, z: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0, speedKmh: 158, tankPct: 100,
      }]);
      await adapter.set(`worlds/${WORLD_ID}/planes`, { e: ep, q: 1, t: adapter.serverTimestamp(), p: pStr });
      await adapter.set(`worlds/${WORLD_ID}/fireRing/1`, {
        e: ep, q: 1, t: adapter.serverTimestamp(),
        d: encodeFireDelta({ windDirDeg: 90, windSpeedKt: 12, missionScore: 0, wave: 1 }),
      });

      const oldKey = await adapter.get(`worlds/${WORLD_ID}/fireKey`).catch(() => null);
      if (!oldKey || adapter.now() - (oldKey.t || 0) >= 4500) {
        await adapter.set(`worlds/${WORLD_ID}/fireKey`, {
          e: ep, q: 1, t: adapter.serverTimestamp(),
          d: encodeFireKey({ gridSize: 4, cells: new Uint8Array(16), cabinHp: new Uint8Array(1), windDirDeg: 90, windSpeedKt: 12, wave: 1, missionScore: 0 }),
        });
      }

      const oldMeta = await adapter.get(`worlds/${WORLD_ID}/meta`).catch(() => null);
      if (!oldMeta || adapter.now() - (oldMeta.t || 0) >= 1000) {
        await adapter.set(`worlds/${WORLD_ID}/meta`, {
          e: ep, t: adapter.serverTimestamp(),
          d: encodeMeta({ wave: 1, missionScore: 0, burningPct: 0, cabinsAlive: 1, cabinsTotal: 1, status: 'active', pilotsCount: 1, top10: [] }),
        });
      }

      const oldIdx = await adapter.get(`worldsIndex/${WORLD_ID}`).catch(() => null);
      if (cfg && (!oldIdx || adapter.now() - (oldIdx.updatedAt || 0) >= 5500)) {
        await adapter.set(`worldsIndex/${WORLD_ID}`, {
          name: 'Cascadia Mega-Basin',
          mode: 'megabasin',
          players: 1,
          cap: cfg.cap,
          buildHash: cfg.buildHash,
          protocolVersion: 1,
          updatedAt: adapter.serverTimestamp(),
          expiresAt: cfg.expiresAt,
        });
      }
      console.log(`[live-smoke] host streams (epoch=${ep}: planes, fireRing, fireKey, meta, worldsIndex) OK`);
    }

    console.log('[live-smoke] PASS');
  } finally {
    console.log('[live-smoke] Cleaning up (abdicate + conditional leaf delete + deleteUser)...');
    await election.stop({ abdicateIfHost: true }).catch(() => {});
    await allocator.vacate().catch(() => {});
    await presence.stop().catch(() => {});
    await adapter.deleteAnonymousUser().catch(() => {});
    await adapter.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[live-smoke] FAILED:', err);
  process.exit(1);
});
