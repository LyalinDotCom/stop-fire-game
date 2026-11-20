// Tier 3 offline 100-plane browser loopback runner (?loopback=100 / ?bots=100).
// Runs 1 local pilot + N (default 99) real Autopilot + FlightModel bot clients through
// MockRtdbAdapter -> protocol.js -> HostBroadcaster -> StreamClient -> PlaneInterpolator!
// Safe against rapid stop() mid-boot (zero leaked bots or hub listeners).

import { Autopilot } from '../sim/Autopilot.js';
import { FireSim } from '../sim/FireSim.js';
import { createAircraftState, stepFlight } from '../sim/FlightModel.js';
import { HostBroadcaster } from './HostBroadcaster.js';
import { MockRtdbHub } from './MockRtdbAdapter.js';
import { Presence } from './Presence.js';
import { SlotAllocator, computeEntrySpawnPose } from './SlotAllocator.js';
import { WorldSession } from './WorldSession.js';
import { DEFAULT_WORLD_ID } from './firebaseConfig.js';
import { MAX_SLOTS, getBuildHash } from './config.js';
import { encodeInput } from './protocol.js';

const BOT_CALLSIGN_PREFIXES = [
  'EMBER', 'PINE', 'RIDGE', 'SPARK', 'CREST', 'VALE', 'ASHEN', 'STORM',
  'HAWK', 'EAGLE', 'FLARE', 'CEDAR', 'MIST', 'BLAZE', 'SCOUT', 'APEX',
];

const BOT_INPUT_INTERVAL_MS = 250; // 4 Hz per bot
const BOT_PHYSICS_DT = 1 / 30;

function makeBotCallsign(idx) {
  const prefix = BOT_CALLSIGN_PREFIXES[idx % BOT_CALLSIGN_PREFIXES.length];
  return `${prefix}-${String(idx).padStart(2, '0')}`;
}

export function createLoopbackSession({
  botCount = 99,
  terrain,
  fireSim,
  opConfig,
  opIndex = null,
  worldId = DEFAULT_WORLD_ID,
  callsign = 'EF-07',
  colorIdx = 0,
  onStatusChange = null,
  onScoreEvents = null,
  onDropOutcomes = null,
  onWorldEvents = null,
  onOperationChange = null,
  onOperationAdvance = null,
  onPilotJoined = null,
  onMetaUpdate = null,
  onFireSync = null,
  useRealClock = true,
} = {}) {
  const count = Math.max(1, Math.min(MAX_SLOTS - 1, Math.floor(botCount)));
  const hub = new MockRtdbHub({ useRealClock });
  const buildHash = getBuildHash();
  const resolvedOpIndex = opIndex ?? opConfig?.opIndex ?? 0;

  const hostFireSim = new FireSim(terrain, { isMegaBasin: true });

  const localAdapter = hub.createClient('local-pilot');
  const session = new WorldSession({
    adapter: localAdapter,
    terrain,
    fireSim,
    opConfig,
    opIndex: resolvedOpIndex,
    worldId,
    buildHash,
    callsign,
    colorIdx,
    mode: 'loopback',
    onStatusChange,
    onScoreEvents,
    onDropOutcomes,
    onWorldEvents,
    onOperationChange,
    onOperationAdvance,
    onPilotJoined,
    onMetaUpdate,
    onFireSync,
    disableRealTimers: !useRealClock,
  });

  const bots = [];
  let hostBroadcaster = null;
  let booted = false;
  let stopped = false;
  let bootPromise = null;
  let physicsAccum = 0;

  const origStart = session.start.bind(session);
  session.start = async () => {
    if (stopped) return;
    if (!booted) {
      booted = true;
      bootPromise = bootBots();
      await bootPromise;
      bootPromise = null;
    }
    if (stopped) return;
    await origStart();
  };

  const origStep = session.step.bind(session);
  session.step = (dt, renderTimeMs) => {
    if (!stopped && booted && !bootPromise) {
      stepBotsAndHost(dt);
    }
    return origStep(dt, renderTimeMs);
  };

  async function cleanupBot(b) {
    await b.allocator?.vacate().catch(() => {});
    await b.presence?.stop().catch(() => {});
    await b.adapter?.close().catch(() => {});
  }

  async function bootBots() {
    for (let i = 0; i < count; i++) {
      if (stopped) break;
      const uid = `bot-${String(i).padStart(2, '0')}`;
      const adapter = hub.createClient(uid);
      const presence = new Presence(adapter, worldId, null, { autoStart: false, nowFn: () => hub.now() });
      const marked = await presence.mark();
      if (stopped || !marked || !presence.connId) {
        await presence.stop().catch(() => {});
        await adapter.close().catch(() => {});
        break;
      }

      const allocator = new SlotAllocator(adapter, worldId, { nowFn: () => hub.now() });
      const botName = makeBotCallsign(i);
      const botColor = i % 16;

      const claimRes = await allocator.claim({
        callsign: botName,
        colorIdx: botColor,
        connId: presence.connId,
        buildHash,
        mapId: opConfig?.id || 'op01',
      });
      if (stopped) {
        await allocator.vacate().catch(() => {});
        await presence.stop().catch(() => {});
        await adapter.close().catch(() => {});
        break;
      }

      const slotId = claimRes.slotId ?? i;
      const spawn = computeEntrySpawnPose(slotId, terrain);
      const patrolScale = 0.55 + ((i % 7) * 0.06);
      const aircraft = createAircraftState({
        x: spawn.x * patrolScale,
        y: spawn.y,
        z: spawn.z * patrolScale,
        yawDeg: spawn.yawDeg,
        speedKmh: 155 + (i % 10),
        tankPct: 40 + ((i * 17) % 61),
        autopilot: true,
        callsign: botName,
        slotId,
        colorIdx: botColor,
      });

      const botNow = hub.now();
      const autopilot = new Autopilot(terrain);
      const bot = {
        idx: i,
        uid,
        slotId,
        adapter,
        presence,
        allocator,
        aircraft,
        autopilot,
        dropSeq: 0,
        inputSeq: 0,
        lastInputAt: botNow + Math.floor((i / count) * BOT_INPUT_INTERVAL_MS),
        lastRenewAt: botNow,
        lastAuthRenewAt: botNow,
        isHostBot: i === 0,
      };
      bots.push(bot);

      if (i === 0) {
        hostBroadcaster = new HostBroadcaster(adapter, worldId, {
          terrain,
          fireSim: hostFireSim,
          epoch: 1,
          opIndex: resolvedOpIndex,
          buildHash,
          worldName: opConfig?.name || 'Cinderpine Basin',
          localSlotId: slotId,
          enableBackgroundTicker: false,
        });
        hostBroadcaster.setLocalAircraft(aircraft, 0);
        await hostBroadcaster.start({ isFailover: false });
        if (stopped) break;
      } else {
        const d = encodeInput(aircraft, 0);
        bot.inputSeq = 1;
        await adapter.set(`worlds/${worldId}/in/${uid}`, {
          s: bot.inputSeq,
          t: adapter.serverTimestamp(),
          c: presence.connId,
          d,
        }).catch(() => {});
        allocator.markInputWritten();
        if (stopped) break;
      }
    }

    if (stopped) {
      hostBroadcaster?.stop();
      hostBroadcaster = null;
      const toClean = bots.splice(0);
      for (const b of toClean) await cleanupBot(b);
      return;
    }

    if (hostBroadcaster) {
      hostBroadcaster.step(0.1);
      await hostBroadcaster.publishPlanes().catch(() => {});
    }
  }

  function stepBotsAndHost(dt) {
    const clampedDt = Math.min(0.1, Math.max(0, dt));
    physicsAccum += clampedDt;
    const fireSnap = hostFireSim.getSnapshot();
    const now = hub.now();

    const substeps = Math.min(3, Math.floor(physicsAccum / BOT_PHYSICS_DT));
    if (substeps > 0) {
      physicsAccum -= substeps * BOT_PHYSICS_DT;
      for (let s = 0; s < substeps; s++) {
        for (let i = 0; i < bots.length; i++) {
          const b = bots[i];
          const input = b.autopilot.update(b.aircraft, fireSnap, BOT_PHYSICS_DT);
          const { events } = stepFlight(b.aircraft, input, terrain, BOT_PHYSICS_DT);
          if (events?.dropStarted) b.dropSeq = (b.dropSeq + 1) & 0xffff;
        }
      }
    }

    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];

      if (b.isHostBot) {
        hostBroadcaster?.setLocalAircraft(b.aircraft, b.dropSeq);
        if (now - b.lastAuthRenewAt >= 2500) {
          b.lastAuthRenewAt = now;
          b.adapter.runTransaction(`worlds/${worldId}/authority`, (cur) => {
            if (!cur || cur.uid !== b.uid || cur.leaseUntil <= hub.now()) return undefined;
            return {
              uid: b.uid,
              epoch: cur.epoch,
              rev: cur.rev + 1,
              leaseUntil: hub.now() + 8000,
            };
          }).catch(() => {});
        }
      } else if (now - b.lastInputAt >= BOT_INPUT_INTERVAL_MS && b.presence.connId) {
        b.lastInputAt = now;
        const d = encodeInput(b.aircraft, b.dropSeq);
        b.adapter.set(`worlds/${worldId}/in/${b.uid}`, {
          s: ++b.inputSeq,
          t: b.adapter.serverTimestamp(),
          c: b.presence.connId,
          d,
        }).catch(() => {});
      }

      if (now - b.lastRenewAt >= 20000) {
        b.lastRenewAt = now;
        b.allocator.renewIfDue(false, b.presence.connId).catch(() => {});
      }
    }

    hostBroadcaster?.step(clampedDt);
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    // Wait for any in-flight bootBots() iteration to abort and clean up before final sweep.
    if (bootPromise) {
      await bootPromise.catch(() => {});
      bootPromise = null;
    }
    await session.stop().catch(() => {});
    hostBroadcaster?.stop();
    hostBroadcaster = null;
    const remaining = bots.splice(0);
    for (const b of remaining) {
      await cleanupBot(b);
    }
    await localAdapter.close().catch(() => {});
  }

  return {
    session,
    adapter: localAdapter,
    hub,
    hostFireSim,
    bots,
    stop,
  };
}
