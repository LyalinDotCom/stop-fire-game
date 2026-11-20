// Bounded RTDB lobby discovery and shard selection for EMBER FRONT Host / Join Lobby flows.
// Uses only bounded `queryWorldsIndex({ limit: 20 })` queries (strictly matching database.rules.json).
// Zero static firebase/* imports.

import { HOSTABLE_WORLD_IDS, LOBBY_FRESH_MS, MAX_SLOTS, WORLD_ID_RE } from './config.js';
import { STAGING_WORLD_IDS } from './firebaseConfig.js';

const STAGING_SET = new Set(STAGING_WORLD_IDS);

/**
 * List currently active hosted lobbies from `worldsIndex` (bounded query <= 20 entries).
 * Filters out staging shards (`megabasin-19`, `megabasin-20`), stale entries (> 30 s),
 * expired worlds, and empty (`players <= 0`) lobbies.
 */
export async function listLiveLobbies(adapter, {
  freshMs = LOBBY_FRESH_MS,
  includeStaging = false,
} = {}) {
  if (!adapter || typeof adapter.queryWorldsIndex !== 'function') return [];
  const raw = (await adapter.queryWorldsIndex({ limit: 20 }).catch(() => null)) || {};
  const now = adapter.now();
  const lobbies = [];

  for (const [worldId, entry] of Object.entries(raw)) {
    if (!WORLD_ID_RE.test(worldId)) continue;
    if (!includeStaging && STAGING_SET.has(worldId)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const players = Number(entry.players) || 0;
    const cap = Math.max(1, Math.min(MAX_SLOTS, Number(entry.cap) || MAX_SLOTS));
    const updatedAt = Number(entry.updatedAt) || 0;
    const expiresAt = Number(entry.expiresAt) || 0;
    if (players <= 0) continue;
    if (!updatedAt || now - updatedAt > freshMs) continue;
    if (expiresAt && expiresAt <= now) continue;

    lobbies.push({
      worldId,
      name: typeof entry.name === 'string' && entry.name ? entry.name : 'Cinderpine Basin',
      players,
      cap,
      full: players >= cap,
      updatedAt,
      ageMs: Math.max(0, now - updatedAt),
    });
  }

  lobbies.sort((a, b) => {
    if (a.full !== b.full) return a.full ? 1 : -1;
    if (b.players !== a.players) return b.players - a.players;
    return b.updatedAt - a.updatedAt;
  });

  return lobbies;
}

/**
 * Pick an empty or stale hostable shard (`megabasin-01..18`) so clicking HOST LOBBY
 * starts a fresh Operation 01 mission with the caller immediately as authoritative Host.
 * Prefers unused shards (zero existing `worldsIndex` entry), then stale/empty shards
 * whose `authority` lease has expired.
 */
export async function pickHostableShard(adapter, {
  preferredWorldId = null,
  freshMs = LOBBY_FRESH_MS,
} = {}) {
  const now = adapter.now();
  const rawIndex = (await adapter.queryWorldsIndex({ limit: 20 }).catch(() => null)) || {};

  const candidates = [];
  if (preferredWorldId && WORLD_ID_RE.test(preferredWorldId)) {
    candidates.push(preferredWorldId);
  }
  for (const wid of HOSTABLE_WORLD_IDS) {
    if (!candidates.includes(wid)) candidates.push(wid);
  }

  // Pass 1: completely unused shard (neither worldsIndex nor live authority).
  for (const wid of candidates) {
    if (rawIndex[wid]) continue;
    const auth = await adapter.get(`worlds/${wid}/authority`).catch(() => null);
    if (!auth || typeof auth.leaseUntil !== 'number' || auth.leaseUntil <= now) {
      return { worldId: wid, isFresh: !auth };
    }
  }

  // Pass 2: stale or empty shard whose authority lease has expired.
  for (const wid of candidates) {
    const entry = rawIndex[wid];
    const stale = !entry || !entry.updatedAt || (now - entry.updatedAt > freshMs) || (entry.players || 0) <= 0;
    if (!stale) continue;
    const auth = await adapter.get(`worlds/${wid}/authority`).catch(() => null);
    if (!auth || typeof auth.leaseUntil !== 'number' || auth.leaseUntil <= now) {
      return { worldId: wid, isFresh: false };
    }
  }

  // Fallback: all 18 public shards active — return the least-populated non-full shard or megabasin-01.
  let best = HOSTABLE_WORLD_IDS[0];
  let bestPlayers = Infinity;
  for (const wid of HOSTABLE_WORLD_IDS) {
    const p = Number(rawIndex[wid]?.players) || 0;
    if (p < bestPlayers) {
      bestPlayers = p;
      best = wid;
    }
  }
  return { worldId: best, isFresh: false, allBusy: true };
}

/** Build a clean shareable invite URL (`https://host/?lobby=megabasin-XX`). */
export function buildLobbyInviteUrl(worldId, loc = globalThis.location) {
  if (!worldId) return '';
  if (!loc || !loc.origin) return `?lobby=${encodeURIComponent(worldId)}`;
  const basePath = loc.pathname || '/';
  return `${loc.origin}${basePath}?lobby=${encodeURIComponent(worldId)}`;
}
