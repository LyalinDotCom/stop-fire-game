// In-memory MockRtdbHub + per-client MockRtdbAdapter strictly enforcing EVERY rule in the
// deployed live database.rules.json (exact keys, types, parent serverTimestamp(), pacing,
// O(1) integer uidToSlot bijection, monotonic in/$uid.s, connId fencing, $other: false).
// Powers both Tier 1 deterministic offline tests and Tier 3 `?loopback=100` browser mode.

import {
  BUILD_HASH_RE,
  CALLSIGN_RE,
  CONN_ID_RE,
  PACING_MS,
  PAYLOAD_CAPS,
  PROTOCOL_VERSION,
  RING_KEY_RE,
  SLOT_KEY_RE,
  WORLD_ID_RE,
} from './config.js';
import {
  RtdbAdapter,
  RtdbError,
  isServerTimestamp,
  normalizePath,
  splitPath,
} from './RtdbAdapter.js';

const MAP_ID_RE = /^[a-z0-9_-]{2,24}$/;
const PUBLIC_WORLD_ID_RE = /^megabasin-(0[1-9]|1[0-8])$/;
const MIN_EXPIRES_MS = 3_600_000;
const MAX_EXPIRES_MS = 86_400_000;
const MAX_Q_STEP = 64;

const ALLOWED_KEYS = {
  worldsIndexEntry: new Set(['name', 'mode', 'players', 'cap', 'buildHash', 'protocolVersion', 'updatedAt', 'expiresAt']),
  world: new Set(['config', 'authority', 'slots', 'uidToSlot', 'roster', 'presence', 'in', 'planes', 'fireRing', 'fireKey', 'meta']),
  config: new Set(['mode', 'mapId', 'cap', 'protocolVersion', 'buildHash', 'createdAt', 'expiresAt']),
  authority: new Set(['uid', 'epoch', 'rev', 'leaseUntil']),
  slot: new Set(['uid', 'conn', 'at', 'leaseUntil']),
  roster: new Set(['uid', 'name', 'color', 'at']),
  presence: new Set(['conn', 'at', 'away']),
  input: new Set(['s', 't', 'c', 'd']),
  planes: new Set(['e', 'q', 't', 'p']),
  fireRingSlot: new Set(['e', 'q', 't', 'd']),
  fireKey: new Set(['e', 'q', 't', 'd']),
  meta: new Set(['e', 't', 'd']),
};

function deepClone(val) {
  if (val === null || val === undefined || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(deepClone);
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) out[k] = deepClone(v);
  }
  return out;
}

function getAt(root, parts) {
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = cur[parts[i]];
  }
  return cur === undefined ? null : cur;
}

function setAtCow(root, parts, value) {
  if (parts.length === 0) return value;
  const copy = root && typeof root === 'object' ? { ...root } : {};
  const key = parts[0];
  if (parts.length === 1) {
    if (value === null || value === undefined) {
      delete copy[key];
    } else {
      copy[key] = value;
    }
    return Object.keys(copy).length === 0 ? null : copy;
  }
  const child = setAtCow(copy[key], parts.slice(1), value);
  if (child === null || child === undefined) {
    delete copy[key];
  } else {
    copy[key] = child;
  }
  return Object.keys(copy).length === 0 ? null : copy;
}

function resolveSentinels(value, now, sentinelPaths, prefix) {
  if (isServerTimestamp(value)) {
    sentinelPaths.add(prefix);
    return now;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v, i) => resolveSentinels(v, now, sentinelPaths, `${prefix}/${i}`));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const childPath = prefix ? `${prefix}/${k}` : k;
    out[k] = resolveSentinels(v, now, sentinelPaths, childPath);
  }
  return out;
}

function hasOnlyAllowedKeys(obj, allowedSet) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) return false;
  }
  return true;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deny(reason) {
  return new RtdbError('PERMISSION_DENIED', `PERMISSION_DENIED: ${reason}`, reason);
}

function isLiveHost(world, uid, now) {
  const auth = world?.authority;
  return !!(auth && auth.uid === uid && typeof auth.leaseUntil === 'number' && auth.leaseUntil > now);
}

function isAuthorityUid(world, uid) {
  return !!(world?.authority && world.authority.uid === uid);
}

function pathsOverlap(a, b) {
  if (a === '' || b === '' || a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function byteSizeOf(val) {
  if (val === null || val === undefined) return 4;
  try {
    return JSON.stringify(val).length;
  } catch {
    return 0;
  }
}

export class MockRtdbHub {
  constructor({ initialTime = 1_700_000_000_000, useRealClock = false } = {}) {
    this._root = {};
    this._useRealClock = useRealClock;
    this._virtualNow = initialTime;
    this._clients = new Map();
    this._listeners = new Set();
    this.stats = this._freshStats();
  }

  _freshStats() {
    return {
      writes: 0,
      reads: 0,
      bytesWritten: 0,
      bytesRead: 0,
      rejectedWrites: 0,
      rejectedReads: 0,
      transactions: 0,
      onDisconnectFired: 0,
      writeTimestamps: [],
    };
  }

  resetStats() {
    this.stats = this._freshStats();
  }

  now() {
    return this._useRealClock ? Date.now() : this._virtualNow;
  }

  advanceTime(ms) {
    if (ms < 0) throw new Error('advanceTime requires non-negative ms');
    this._virtualNow += ms;
    return this._virtualNow;
  }

  setTime(ms) {
    this._virtualNow = ms;
    return this._virtualNow;
  }

  getWriteRate(windowMs = 10000) {
    const cutoff = this.now() - windowMs;
    let count = 0;
    for (let i = this.stats.writeTimestamps.length - 1; i >= 0; i--) {
      if (this.stats.writeTimestamps[i] > cutoff) count++;
      else break;
    }
    return count / (windowMs / 1000);
  }

  inspect(path = '') {
    const parts = splitPath(path);
    return deepClone(parts.length ? getAt(this._root, parts) : this._root);
  }

  createClient(uid) {
    if (!uid || typeof uid !== 'string') throw new Error('uid must be a non-empty string');
    const state = {
      uid,
      connected: true,
      blackHoled: false,
      closed: false,
      connectedCbs: new Set(),
      onDisconnects: new Map(),
      pendingBlackHoleResolvers: [],
    };
    this._clients.set(uid, state);
    return new MockRtdbAdapter(this, state);
  }

  simulateTabCrash(uid) {
    const client = this._clients.get(uid);
    if (!client) return;
    client.connected = false;
    client.blackHoled = false;
    for (const p of client.pendingBlackHoleResolvers.splice(0)) {
      p.reject(new RtdbError('offline', 'tab crashed'));
    }
    for (const l of [...this._listeners]) {
      if (l.uid === uid) this._listeners.delete(l);
    }
    const queued = [...client.onDisconnects.entries()];
    client.onDisconnects.clear();
    for (const [path, action] of queued) {
      this.stats.onDisconnectFired++;
      try {
        this._commitSync(uid, { [path]: action.op === 'remove' ? null : action.value });
      } catch {
        // Rejected by RTDB rules (e.g. stale connId onDisconnect).
      }
    }
    for (const cb of [...client.connectedCbs]) {
      try { cb(false); } catch { /* ignore */ }
    }
  }

  simulateBlackHole(uid, active = true) {
    const client = this._clients.get(uid);
    if (!client) return;
    client.blackHoled = !!active;
    if (!active) {
      for (const p of client.pendingBlackHoleResolvers.splice(0)) {
        p.reject(new RtdbError('offline', 'blackhole cleared'));
      }
    }
  }

  _setClientOnline(client, online) {
    if (client.closed) return;
    const wasConnected = client.connected;
    client.blackHoled = false;
    client.connected = online;
    if (!online) {
      for (const p of client.pendingBlackHoleResolvers.splice(0)) {
        p.reject(new RtdbError('offline', 'client went offline'));
      }
      const queued = [...client.onDisconnects.entries()];
      client.onDisconnects.clear();
      for (const [path, action] of queued) {
        this.stats.onDisconnectFired++;
        try {
          this._commitSync(client.uid, { [path]: action.op === 'remove' ? null : action.value });
        } catch {
          // Rule rejection on stale onDisconnect.
        }
      }
    }
    if (wasConnected !== online) {
      for (const cb of [...client.connectedCbs]) {
        try { cb(online); } catch { /* ignore */ }
      }
    }
    if (online) {
      for (const l of [...this._listeners]) {
        if (l.uid === client.uid) this._deliverListener(l, true);
      }
    }
  }

  _checkReadPermission(uid, path, queryOpts = null) {
    if (!uid) throw deny('unauthenticated read');
    const parts = splitPath(path);
    if (parts.length === 0) throw deny('root .read is false');

    const now = this.now();
    const top = parts[0];

    if (top === 'worldsIndex') {
      if (parts.length === 1) {
        if (
          !queryOpts ||
          queryOpts.orderByChild !== 'updatedAt' ||
          !Number.isInteger(queryOpts.limitToLast) ||
          queryOpts.limitToLast < 1 ||
          queryOpts.limitToLast > 20
        ) {
          throw deny('worldsIndex requires orderByChild("updatedAt") and limitToLast(<= 20)');
        }
        return;
      }
      if (!WORLD_ID_RE.test(parts[1])) throw deny(`invalid shard id "${parts[1]}"`);
      return;
    }

    if (top === 'worlds') {
      if (parts.length < 2) throw deny('cannot read /worlds root');
      const worldId = parts[1];
      if (!WORLD_ID_RE.test(worldId)) throw deny(`invalid shard id "${worldId}"`);
      if (parts.length === 2) throw deny('cannot read entire world node');

      const section = parts[2];
      if (!ALLOWED_KEYS.world.has(section)) throw deny(`unknown world section "${section}"`);
      const world = this._root.worlds?.[worldId] || null;

      if (section === 'uidToSlot') {
        // Parent uidToSlot has NO .read rule in deployed live rules! Only $uid is readable by self or host.
        if (parts.length === 3) {
          throw deny(`parent worlds/${worldId}/uidToSlot is not readable`);
        }
        const targetUid = parts[3];
        if (targetUid !== uid && !isAuthorityUid(world, uid)) {
          throw deny(`non-host cannot read other user's uidToSlot/${targetUid}`);
        }
        return;
      }

      if (section === 'presence' || section === 'in') {
        if (parts.length === 3) {
          if (!isLiveHost(world, uid, now)) {
            throw deny(`only live host can read worlds/${worldId}/${section}`);
          }
          return;
        }
        const targetUid = parts[3];
        if (targetUid !== uid && !isLiveHost(world, uid, now)) {
          throw deny(`non-host cannot read other user's ${section}/${targetUid}`);
        }
        return;
      }
      return;
    }

    throw deny(`unknown path "${path}"`);
  }

  _commitSync(uid, rawUpdates) {
    if (!uid) throw deny('unauthenticated write');
    const now = this.now();

    const normalizedEntries = [];
    const sentinelPaths = new Set();
    const touchedRawPaths = [];

    for (const [rawPath, rawVal] of Object.entries(rawUpdates)) {
      const norm = normalizePath(rawPath);
      if (!norm) throw deny('root .write is false');
      touchedRawPaths.push(norm);
      const resolved = rawVal === null || rawVal === undefined
        ? null
        : resolveSentinels(deepClone(rawVal), now, sentinelPaths, norm);
      normalizedEntries.push([norm, resolved]);
    }

    if (normalizedEntries.length === 0) return;

    const oldRoot = this._root;
    let newRoot = oldRoot;
    let totalBytes = 0;

    for (const [norm, val] of normalizedEntries) {
      totalBytes += byteSizeOf(val);
      newRoot = setAtCow(newRoot, splitPath(norm), val) || {};
    }

    const entities = new Map();
    const registerEntity = (kind, worldId, key, entityPath, rawPath) => {
      let entry = entities.get(entityPath);
      if (!entry) {
        entry = { kind, worldId, key, entityPath, rawPaths: [] };
        entities.set(entityPath, entry);
      }
      entry.rawPaths.push(rawPath);
    };

    for (const norm of touchedRawPaths) {
      const parts = splitPath(norm);
      const top = parts[0];

      if (top === 'worldsIndex') {
        if (parts.length < 2) throw deny('cannot write /worldsIndex root');
        const worldId = parts[1];
        if (!WORLD_ID_RE.test(worldId)) throw deny(`invalid shard id "${worldId}"`);
        registerEntity('worldsIndexEntry', worldId, worldId, `worldsIndex/${worldId}`, norm);
        continue;
      }

      if (top === 'worlds') {
        if (parts.length < 3) throw deny('cannot overwrite /worlds or /worlds/$w root');
        const worldId = parts[1];
        if (!WORLD_ID_RE.test(worldId)) throw deny(`invalid shard id "${worldId}"`);
        const section = parts[2];
        if (!ALLOWED_KEYS.world.has(section)) throw deny(`$other disallowed under worlds/${worldId}: "${section}"`);

        if (section === 'config' || section === 'authority' || section === 'planes' || section === 'fireKey' || section === 'meta') {
          registerEntity(section, worldId, null, `worlds/${worldId}/${section}`, norm);
        } else {
          if (parts.length < 4) throw deny(`cannot overwrite entire worlds/${worldId}/${section} map`);
          const key = parts[3];
          registerEntity(section, worldId, key, `worlds/${worldId}/${section}/${key}`, norm);
        }
        continue;
      }

      throw deny(`root $other disallowed: "${top}"`);
    }

    for (const entity of entities.values()) {
      this._validateEntity(entity, oldRoot, newRoot, uid, now, sentinelPaths);
    }

    this._root = newRoot;
    this.stats.writes++;
    this.stats.bytesWritten += totalBytes;
    this.stats.writeTimestamps.push(now);
    if (this.stats.writeTimestamps.length > 25000) {
      const cutoff = now - 30000;
      let idx = 0;
      while (idx < this.stats.writeTimestamps.length && this.stats.writeTimestamps[idx] <= cutoff) idx++;
      if (idx > 0) this.stats.writeTimestamps.splice(0, idx);
    }

    for (const l of [...this._listeners]) {
      const client = this._clients.get(l.uid);
      if (!client || !client.connected || client.blackHoled || client.closed) continue;
      let relevant = false;
      for (const norm of touchedRawPaths) {
        if (pathsOverlap(l.path, norm)) { relevant = true; break; }
      }
      if (relevant) this._deliverListener(l, false);
    }
  }

  _requireParentServerTimestamp(entity, tsField, sentinelPaths, newVal, now) {
    const tsPath = `${entity.entityPath}/${tsField}`;
    if (!sentinelPaths.has(tsPath)) {
      throw deny(`${entity.entityPath}.${tsField} must be written with serverTimestamp() (no partial child bypass)`);
    }
    if (newVal[tsField] !== now) {
      throw deny(`${entity.entityPath}.${tsField} !== now`);
    }
  }

  _validateEntity(entity, oldRoot, newRoot, uid, now, sentinelPaths) {
    const { kind, worldId, key, entityPath } = entity;
    const oldWorld = oldRoot.worlds?.[worldId] || null;
    const newWorld = newRoot.worlds?.[worldId] || null;
    const oldVal = getAt(oldRoot, splitPath(entityPath));
    const newVal = getAt(newRoot, splitPath(entityPath));
    const isDelete = newVal === null || newVal === undefined;

    switch (kind) {
      case 'worldsIndexEntry': {
        if (isDelete) throw deny('worldsIndex entry cannot be deleted by client');
        if (!isLiveHost(oldWorld, uid, now)) {
          throw deny('only live host can write worldsIndex');
        }
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.worldsIndexEntry)) {
          throw deny('worldsIndex has disallowed $other keys');
        }
        if (typeof newVal.name !== 'string' || newVal.name.length < 1 || newVal.name.length > 48) {
          throw deny('worldsIndex.name must be 1..48 char string');
        }
        if (newVal.mode !== 'megabasin') throw deny('worldsIndex.mode must be "megabasin"');
        if (!Number.isInteger(newVal.players) || newVal.players < 0 || newVal.players > 100) {
          throw deny('worldsIndex.players must be int 0..100');
        }
        if (!Number.isInteger(newVal.cap) || newVal.cap < 1 || newVal.cap > 100) {
          throw deny('worldsIndex.cap must be int 1..100');
        }
        if (newVal.protocolVersion !== PROTOCOL_VERSION) throw deny('worldsIndex.protocolVersion invalid');
        if (typeof newVal.buildHash !== 'string' || !BUILD_HASH_RE.test(newVal.buildHash)) {
          throw deny('worldsIndex.buildHash invalid');
        }
        const cfg = oldWorld?.config;
        if (!cfg || newVal.cap !== cfg.cap) {
          throw deny('worldsIndex.cap must match config.cap');
        }
        if (newVal.buildHash !== cfg.buildHash) {
          throw deny('worldsIndex.buildHash must match config.buildHash');
        }
        if (typeof newVal.expiresAt !== 'number' || newVal.expiresAt !== cfg.expiresAt) {
          throw deny('worldsIndex.expiresAt must match config.expiresAt');
        }
        if (!(newVal.expiresAt > now && newVal.expiresAt <= now + MAX_EXPIRES_MS)) {
          throw deny('worldsIndex.expiresAt outside (now, now+86400000]');
        }
        this._requireParentServerTimestamp(entity, 'updatedAt', sentinelPaths, newVal, now);
        if (oldVal && now - oldVal.updatedAt < PACING_MS.worldsIndex) {
          throw deny(`worldsIndex write pacing violation (${now - oldVal.updatedAt}ms < ${PACING_MS.worldsIndex}ms)`);
        }
        return;
      }

      case 'config': {
        if (isDelete) throw deny('config cannot be deleted');
        if (oldVal === null) {
          if (newWorld?.authority?.uid !== uid || newWorld?.authority?.epoch !== 1) {
            throw deny('config creation requires authority.uid === auth.uid and authority.epoch === 1');
          }
        } else {
          const canRefresh =
            (oldVal.expiresAt ?? 0) <= now + MIN_EXPIRES_MS ||
            (oldWorld?.authority?.leaseUntil ?? 0) <= now ||
            (PUBLIC_WORLD_ID_RE.test(worldId) && oldVal.cap !== 100);
          const hasAuth =
            isLiveHost(oldWorld, uid, now) ||
            (newWorld?.authority?.uid === uid && (newWorld?.authority?.leaseUntil ?? 0) > now);
          if (!canRefresh || !hasAuth) {
            throw deny('config is immutable while live and unexpired');
          }
        }
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.config)) throw deny('config has disallowed $other keys');
        if (newVal.mode !== 'megabasin') throw deny('config.mode must be "megabasin"');
        if (typeof newVal.mapId !== 'string' || !MAP_ID_RE.test(newVal.mapId)) {
          throw deny('config.mapId invalid');
        }
        if (PUBLIC_WORLD_ID_RE.test(worldId)) {
          if (newVal.cap !== 100) throw deny('public shard config.cap must be 100');
        } else if (!Number.isInteger(newVal.cap) || newVal.cap < 1 || newVal.cap > 100) {
          throw deny('config.cap must be int 1..100');
        }
        if (newVal.protocolVersion !== PROTOCOL_VERSION) throw deny('config.protocolVersion invalid');
        if (typeof newVal.buildHash !== 'string' || !BUILD_HASH_RE.test(newVal.buildHash)) {
          throw deny('config.buildHash invalid');
        }
        if (
          typeof newVal.expiresAt !== 'number' ||
          !(newVal.expiresAt >= now + MIN_EXPIRES_MS && newVal.expiresAt <= now + MAX_EXPIRES_MS)
        ) {
          throw deny('config.expiresAt outside [now+3600000, now+86400000]');
        }
        this._requireParentServerTimestamp(entity, 'createdAt', sentinelPaths, newVal, now);
        return;
      }

      case 'authority': {
        if (isDelete) throw deny('authority cannot be deleted');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.authority)) throw deny('authority has disallowed $other keys');
        if (typeof newVal.uid !== 'string' || newVal.uid.length < 1 || newVal.uid.length > 128) {
          throw deny('authority.uid invalid');
        }
        if (newVal.uid !== uid) throw deny('authority.uid must match auth.uid');
        if (!Number.isInteger(newVal.epoch) || newVal.epoch < 1 || newVal.epoch > 1e9) throw deny('authority.epoch invalid');
        if (!Number.isInteger(newVal.rev) || newVal.rev < 0 || newVal.rev > 1e9) throw deny('authority.rev invalid');
        if (typeof newVal.leaseUntil !== 'number' || !Number.isFinite(newVal.leaseUntil)) {
          throw deny('authority.leaseUntil invalid');
        }

        // Deployed rules require caller to hold a valid slot in newWorld (both create & renew/takeover).
        const seatNum = newWorld?.uidToSlot?.[uid];
        if (!Number.isInteger(seatNum) || newWorld?.slots?.[String(seatNum)]?.uid !== uid) {
          throw deny('authority write requires seated uidToSlot/$uid pointing to owned slots/$s');
        }

        if (!oldVal) {
          if (!newWorld?.config) throw deny('initial authority requires config');
          if (newVal.epoch !== 1 || newVal.rev !== 0) {
            throw deny('initial authority must have epoch === 1 and rev === 0');
          }
          if (!(newVal.leaseUntil > now + 4000 && newVal.leaseUntil <= now + 10000)) {
            throw deny('authority.leaseUntil outside (now+4000, now+10000]');
          }
          return;
        }

        if (newVal.rev !== oldVal.rev + 1) {
          throw deny(`authority.rev must increment (${oldVal.rev} -> ${newVal.rev})`);
        }

        if (oldVal.uid === uid && oldVal.leaseUntil > now) {
          if (newVal.epoch !== oldVal.epoch) throw deny('host renewal must preserve epoch');
          const isAbdication = sentinelPaths.has(`${entityPath}/leaseUntil`) && newVal.leaseUntil === now;
          const isRenewal = newVal.leaseUntil > now + 4000 && newVal.leaseUntil <= now + 10000;
          if (!isAbdication && !isRenewal) {
            throw deny('authority renewal leaseUntil must be in (now+4000, now+10000] or serverTimestamp() abdication');
          }
          return;
        }

        if (oldVal.leaseUntil <= now) {
          if (newVal.epoch !== oldVal.epoch + 1) {
            throw deny(`authority takeover must increment epoch (${oldVal.epoch} -> ${newVal.epoch})`);
          }
          if (!(newVal.leaseUntil > now + 4000 && newVal.leaseUntil <= now + 10000)) {
            throw deny('takeover leaseUntil outside (now+4000, now+10000]');
          }
          return;
        }

        throw deny('cannot steal live authority lease from another host');
      }

      case 'slots': {
        if (!SLOT_KEY_RE.test(key)) throw deny(`invalid slot key "${key}"`);
        const slotNum = Number(key);
        if (isDelete) {
          if (!oldVal) throw deny(`conditional delete failed: ${entityPath} does not exist`);
          if (newWorld?.roster?.[key] != null) {
            throw deny(`slot delete requires removing roster/${key} atomically`);
          }
          const isSelf = oldVal.uid === uid && newWorld?.uidToSlot?.[uid] == null;
          const pres = oldWorld?.presence?.[oldVal.uid];
          const isHostEvict = isLiveHost(oldWorld, uid, now) && (
            oldVal.leaseUntil <= now ||
            !pres ||
            (pres.away === true && now - pres.at >= 15000)
          );
          if (!isSelf && !isHostEvict) {
            throw deny('only slot owner (clearing uidToSlot) or live host (for expired/missing/away>=15s slot) can delete slot');
          }
          return;
        }

        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.slot)) throw deny('slot has disallowed $other keys');
        if (newVal.uid !== uid) throw deny('slots/$s.uid must match auth.uid');
        if (typeof newVal.conn !== 'string' || !CONN_ID_RE.test(newVal.conn)) {
          throw deny('slots/$s.conn must match /^[A-Za-z0-9]{12}$/');
        }
        const callerPres = oldWorld?.presence?.[uid];
        if (!callerPres || callerPres.away === true || callerPres.conn !== newVal.conn) {
          throw deny('slot write requires live non-away presence/$uid matching conn');
        }
        this._requireParentServerTimestamp(entity, 'at', sentinelPaths, newVal, now);
        if (!(newVal.leaseUntil > now + 15000 && newVal.leaseUntil <= now + 45000)) {
          throw deny('slots/$s.leaseUntil outside (now+15000, now+45000]');
        }
        if (String(newWorld?.uidToSlot?.[uid]) !== key) {
          throw deny(`slot write requires uidToSlot/${uid} === ${slotNum}`);
        }

        const isSelfRenew = oldVal && oldVal.uid === uid && oldVal.leaseUntil > now;
        if (isSelfRenew) {
          if (now - oldVal.at < PACING_MS.slotRenew) {
            throw deny(`slot self-renew pacing violation (${now - oldVal.at}ms < ${PACING_MS.slotRenew}ms)`);
          }
          return;
        }

        // Fresh claim or re-claiming an expired slot
        if (oldVal && oldVal.leaseUntil > now) {
          throw deny(`cannot overwrite live slot ${key} owned by ${oldVal.uid}`);
        }
        // Anti-2-slots-per-UID check: cannot hold a DIFFERENT live slot simultaneously
        const prevSlotNum = oldWorld?.uidToSlot?.[uid];
        if (prevSlotNum !== undefined && prevSlotNum !== null && prevSlotNum !== slotNum) {
          const prevSlot = oldWorld?.slots?.[String(prevSlotNum)];
          if (prevSlot && prevSlot.uid === uid) {
            throw deny(`uid ${uid} already owns slot ${prevSlotNum} (2 slots/UID denied)`);
          }
        }
        if (!newWorld?.config) throw deny('slot claim requires config to exist');
        if (!newWorld?.roster?.[key] || newWorld.roster[key].uid !== uid) {
          throw deny(`slot claim requires roster/${key} owned by auth.uid`);
        }
        return;
      }

      case 'uidToSlot': {
        const targetUid = key;
        if (isDelete) {
          if (oldVal === null) throw deny(`conditional delete failed: ${entityPath} does not exist`);
          if (targetUid === uid && !newWorld?.slots?.[String(oldVal)]) return;
          if (isLiveHost(oldWorld, uid, now)) {
            const remaining = newWorld?.slots?.[String(oldVal)];
            if (!remaining || remaining.uid !== targetUid) return;
          }
          throw deny('cannot delete uidToSlot while slot still exists for this uid');
        }
        if (targetUid !== uid) throw deny('cannot write another user uidToSlot');
        if (!Number.isInteger(newVal) || newVal < 0 || newVal > 99) {
          throw deny(`uidToSlot value must be integer 0..99, got ${JSON.stringify(newVal)}`);
        }
        // Live rule: !data.exists() || data.val() === newData.val() || slots[data.val()].uid !== auth.uid
        if (oldVal !== null && oldVal !== newVal) {
          const oldSlot = newWorld?.slots?.[String(oldVal)];
          if (oldSlot && oldSlot.uid === uid) {
            throw deny(`uidToSlot already points to owned slot ${oldVal} (2 slots/UID denied)`);
          }
        }
        if (newWorld?.slots?.[String(newVal)]?.uid !== uid) {
          throw deny('uidToSlot must point to slots/$s owned by auth.uid');
        }
        if (!newWorld?.roster?.[String(newVal)] || newWorld.roster[String(newVal)].uid !== uid) {
          throw deny('uidToSlot requires matching roster/$s');
        }
        return;
      }

      case 'roster': {
        if (!SLOT_KEY_RE.test(key)) throw deny(`invalid roster slot key "${key}"`);
        if (isDelete) {
          if (!oldVal) throw deny(`conditional delete failed: ${entityPath} does not exist`);
          const isSelf = oldVal.uid === uid && !newWorld?.slots?.[key];
          const isHostEvict = isLiveHost(oldWorld, uid, now) && !newWorld?.slots?.[key];
          if (!isSelf && !isHostEvict) {
            throw deny('only owner or live host (with slot removed) can delete roster');
          }
          return;
        }
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.roster)) throw deny('roster has disallowed $other keys');
        if (newVal.uid !== uid) throw deny('roster.uid must match auth.uid');
        if (newWorld?.slots?.[key]?.uid !== uid) throw deny('roster write requires owning slots/$s');
        if (typeof newVal.name !== 'string' || !CALLSIGN_RE.test(newVal.name)) {
          throw deny(`invalid roster.name "${newVal.name}"`);
        }
        if (!Number.isInteger(newVal.color) || newVal.color < 0 || newVal.color > 15) {
          throw deny('roster.color must be integer 0..15');
        }
        this._requireParentServerTimestamp(entity, 'at', sentinelPaths, newVal, now);
        if (oldVal && oldVal.uid === uid && now - oldVal.at < PACING_MS.roster) {
          throw deny(`roster pacing violation (${now - oldVal.at}ms < ${PACING_MS.roster}ms)`);
        }
        return;
      }

      case 'presence': {
        const targetUid = key;
        if (isDelete) {
          if (!oldVal) throw deny(`conditional delete failed: ${entityPath} does not exist`);
          if (targetUid === uid) return;
          if (isLiveHost(oldWorld, uid, now)) {
            const isDead = oldVal.away === true || (now - oldVal.at >= 15000);
            const stillSeated = newWorld?.uidToSlot?.[targetUid] != null;
            if (!isDead || stillSeated) {
              throw deny('host can only delete dead/away presence after uidToSlot is cleared');
            }
            return;
          }
          throw deny('only owner or live host (for dead presence) can delete presence');
        }

        if (targetUid !== uid) throw deny('cannot write another user presence');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.presence)) throw deny('presence has disallowed $other keys');
        if (typeof newVal.conn !== 'string' || !CONN_ID_RE.test(newVal.conn)) {
          throw deny('presence.conn must match /^[A-Za-z0-9]{12}$/');
        }
        if (newVal.away !== undefined && newVal.away !== true) {
          throw deny('presence.away must be true if present');
        }
        this._requireParentServerTimestamp(entity, 'at', sentinelPaths, newVal, now);

        if (newVal.away === true) {
          if (!oldVal || oldVal.conn !== newVal.conn || oldVal.away === true) {
            throw deny('stale connId onDisconnect away mark rejected');
          }
          return;
        }

        if (oldVal) {
          const minPace = oldVal.away === true ? PACING_MS.presenceRecover : PACING_MS.presence;
          if (now - oldVal.at < minPace) {
            throw deny(`presence pacing violation (${now - oldVal.at}ms < ${minPace}ms)`);
          }
        }
        return;
      }

      case 'in': {
        const targetUid = key;
        if (isDelete) {
          if (!oldVal) throw deny(`conditional delete failed: ${entityPath} does not exist`);
          if (targetUid === uid) return;
          if (isLiveHost(oldWorld, uid, now) && newWorld?.uidToSlot?.[targetUid] == null) return;
          throw deny('only owner or live host (after slot cleared) can delete in/$uid');
        }
        if (targetUid !== uid) throw deny('cannot write another user in/$uid');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.input)) throw deny('in/$uid has disallowed $other keys');
        if (oldWorld?.uidToSlot?.[uid] == null) {
          throw deny('in/$uid requires existing uidToSlot/$uid');
        }
        const pres = oldWorld?.presence?.[uid];
        if (!pres || pres.away === true) {
          throw deny('in/$uid rejected while presence is missing or away: true');
        }
        if (typeof newVal.c !== 'string' || !CONN_ID_RE.test(newVal.c) || newVal.c !== pres.conn) {
          throw deny('in/$uid.c must match live presence/$uid.conn');
        }
        if (!Number.isInteger(newVal.s) || newVal.s < 1 || newVal.s > 1e9) {
          throw deny('in/$uid.s must be integer 1..1e9');
        }
        if (oldVal) {
          const advanced = newVal.s > oldVal.s;
          const resetOnNewConn = newVal.c !== oldVal.c && newVal.s === 1;
          if (!advanced && !resetOnNewConn) {
            throw deny(`in/$uid.s must advance monotonically (${oldVal.s} -> ${newVal.s})`);
          }
          if (now - oldVal.t < PACING_MS.input) {
            throw deny(`in/$uid flood denied (${now - oldVal.t}ms < ${PACING_MS.input}ms)`);
          }
        }
        this._requireParentServerTimestamp(entity, 't', sentinelPaths, newVal, now);
        if (typeof newVal.d !== 'string' || newVal.d.length < 1 || newVal.d.length > PAYLOAD_CAPS.input) {
          throw deny(`in/$uid.d must be string 1..${PAYLOAD_CAPS.input} chars`);
        }
        return;
      }

      case 'planes': {
        if (isDelete) throw deny('stream node planes cannot be deleted');
        if (!isLiveHost(oldWorld, uid, now)) throw deny('only live host can write planes');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.planes)) throw deny('planes has disallowed $other keys');
        const auth = oldWorld.authority;
        if (newVal.e !== auth.epoch) throw deny(`planes epoch mismatch (${newVal.e} !== ${auth.epoch})`);
        if (!Number.isInteger(newVal.q) || newVal.q < 0 || newVal.q > 1e9) throw deny('planes.q invalid');
        this._requireParentServerTimestamp(entity, 't', sentinelPaths, newVal, now);
        if (!oldVal) {
          if (newVal.q > MAX_Q_STEP) throw deny(`initial planes.q exceeds max step ${MAX_Q_STEP}`);
        } else if (newVal.e > oldVal.e) {
          const validReset = newVal.q <= MAX_Q_STEP;
          const validCont = newVal.q > oldVal.q && newVal.q <= oldVal.q + MAX_Q_STEP;
          if (!validReset && !validCont) throw deny('planes.q jump exceeds max step on epoch bump');
        } else if (newVal.e === oldVal.e) {
          if (!(newVal.q > oldVal.q && newVal.q <= oldVal.q + MAX_Q_STEP)) {
            throw deny('planes.q must advance within +64');
          }
        } else {
          throw deny('planes (e, q) must strictly advance');
        }
        if (typeof newVal.p !== 'string' || newVal.p.length > PAYLOAD_CAPS.planes) {
          throw deny(`planes.p must be string <= ${PAYLOAD_CAPS.planes} chars`);
        }
        return;
      }

      case 'fireRing': {
        if (!RING_KEY_RE.test(key)) throw deny(`invalid fireRing slot key "${key}"`);
        if (isDelete) throw deny('stream node fireRing cannot be deleted');
        if (!isLiveHost(oldWorld, uid, now)) throw deny('only live host can write fireRing');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.fireRingSlot)) throw deny('fireRing slot has disallowed $other keys');
        const auth = oldWorld.authority;
        if (newVal.e !== auth.epoch) throw deny(`fireRing epoch mismatch (${newVal.e} !== ${auth.epoch})`);
        if (!Number.isInteger(newVal.q) || newVal.q < 1 || newVal.q > 1e9) throw deny('fireRing.q must be int >= 1');
        this._requireParentServerTimestamp(entity, 't', sentinelPaths, newVal, now);
        if (String(newVal.q % 16) !== key) {
          throw deny(`fireRing slot mismatch: q (${newVal.q}) % 16 !== ${key}`);
        }
        const keyQ = oldWorld?.fireKey?.q;
        if (!oldVal) {
          const validInit = newVal.q <= MAX_Q_STEP || (typeof keyQ === 'number' && newVal.q <= keyQ + MAX_Q_STEP);
          if (!validInit) throw deny(`initial fireRing.q exceeds max step ${MAX_Q_STEP}`);
        } else if (newVal.e > oldVal.e) {
          const validReset = newVal.q <= MAX_Q_STEP;
          const validCont = newVal.q > oldVal.q && newVal.q <= oldVal.q + MAX_Q_STEP;
          const validFromKey = typeof keyQ === 'number' && newVal.q <= keyQ + MAX_Q_STEP;
          if (!validReset && !validCont && !validFromKey) {
            throw deny('fireRing.q jump exceeds max step on epoch bump');
          }
        } else if (newVal.e === oldVal.e) {
          if (!(newVal.q > oldVal.q && newVal.q <= oldVal.q + MAX_Q_STEP)) {
            throw deny('fireRing.q must advance within +64');
          }
        } else {
          throw deny('fireRing (e, q) must strictly advance');
        }
        if (typeof newVal.d !== 'string' || newVal.d.length < 1 || newVal.d.length > PAYLOAD_CAPS.fireRing) {
          throw deny(`fireRing.d must be string 1..${PAYLOAD_CAPS.fireRing} chars`);
        }
        return;
      }

      case 'fireKey': {
        if (isDelete) throw deny('stream node fireKey cannot be deleted');
        if (!isLiveHost(oldWorld, uid, now)) throw deny('only live host can write fireKey');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.fireKey)) throw deny('fireKey has disallowed $other keys');
        const auth = oldWorld.authority;
        if (newVal.e !== auth.epoch) throw deny(`fireKey epoch mismatch (${newVal.e} !== ${auth.epoch})`);
        if (!Number.isInteger(newVal.q) || newVal.q < 0 || newVal.q > 1e9) throw deny('fireKey.q invalid');
        this._requireParentServerTimestamp(entity, 't', sentinelPaths, newVal, now);
        if (oldVal && newVal.e <= oldVal.e && now - oldVal.t < PACING_MS.fireKey) {
          throw deny(`fireKey pacing violation (${now - oldVal.t}ms < ${PACING_MS.fireKey}ms)`);
        }
        if (typeof newVal.d !== 'string' || newVal.d.length < 1 || newVal.d.length > PAYLOAD_CAPS.fireKey) {
          throw deny(`fireKey.d must be string 1..${PAYLOAD_CAPS.fireKey} chars`);
        }
        return;
      }

      case 'meta': {
        if (isDelete) throw deny('stream node meta cannot be deleted');
        if (!isLiveHost(oldWorld, uid, now)) throw deny('only live host can write meta');
        if (!hasOnlyAllowedKeys(newVal, ALLOWED_KEYS.meta)) throw deny('meta has disallowed $other keys');
        const auth = oldWorld.authority;
        if (newVal.e !== auth.epoch) throw deny(`meta epoch mismatch (${newVal.e} !== ${auth.epoch})`);
        this._requireParentServerTimestamp(entity, 't', sentinelPaths, newVal, now);
        if (oldVal && newVal.e <= oldVal.e && now - oldVal.t < PACING_MS.meta) {
          throw deny(`meta pacing violation (${now - oldVal.t}ms < ${PACING_MS.meta}ms)`);
        }
        if (typeof newVal.d !== 'string' || newVal.d.length < 1 || newVal.d.length > PAYLOAD_CAPS.meta) {
          throw deny(`meta.d must be string 1..${PAYLOAD_CAPS.meta} chars`);
        }
        return;
      }

      default:
        throw deny(`unhandled entity kind "${kind}"`);
    }
  }

  _deliverListener(l, force) {
    const client = this._clients.get(l.uid);
    if (!client || !client.connected || client.blackHoled || client.closed) return;
    try {
      this._checkReadPermission(l.uid, l.path, null);
    } catch (err) {
      this.stats.rejectedReads++;
      this._listeners.delete(l);
      try { l.onError?.(err); } catch { /* ignore */ }
      return;
    }
    const rawVal = getAt(this._root, l.parts);
    if (!force && rawVal === l.lastRef) return;
    l.lastRef = rawVal;
    const val = deepClone(rawVal);
    this.stats.reads++;
    this.stats.bytesRead += byteSizeOf(rawVal);
    try {
      l.cb(val);
    } catch {
      // Isolate listener errors.
    }
  }
}

export class MockRtdbAdapter extends RtdbAdapter {
  constructor(hub, clientState) {
    super();
    this._hub = hub;
    this._state = clientState;
  }

  get uid() { return this._state.uid; }
  get connected() { return this._state.connected; }
  get hub() { return this._hub; }

  now() {
    return this._hub.now();
  }

  _guardNetwork() {
    if (this._state.closed || !this._state.connected) {
      return Promise.reject(new RtdbError('offline', 'client is offline'));
    }
    if (this._state.blackHoled) {
      return new Promise((resolve, reject) => {
        this._state.pendingBlackHoleResolvers.push({ resolve, reject });
      });
    }
    return null;
  }

  async get(path) {
    const blocked = this._guardNetwork();
    if (blocked) return blocked;
    const norm = normalizePath(path);
    try {
      this._hub._checkReadPermission(this._state.uid, norm, null);
    } catch (err) {
      this._hub.stats.rejectedReads++;
      throw err;
    }
    const val = deepClone(getAt(this._hub._root, splitPath(norm)));
    this._hub.stats.reads++;
    this._hub.stats.bytesRead += byteSizeOf(val);
    return val;
  }

  async set(path, value) {
    const blocked = this._guardNetwork();
    if (blocked) return blocked;
    const norm = normalizePath(path);
    try {
      this._hub._commitSync(this._state.uid, { [norm]: value });
    } catch (err) {
      this._hub.stats.rejectedWrites++;
      throw err;
    }
  }

  async update(pathOrUpdates, maybeUpdates) {
    const blocked = this._guardNetwork();
    if (blocked) return blocked;
    let prefix = '';
    let updates = pathOrUpdates;
    if (typeof pathOrUpdates === 'string') {
      prefix = normalizePath(pathOrUpdates);
      updates = maybeUpdates;
    }
    if (!isPlainObject(updates)) {
      throw new RtdbError('INVALID_ARGUMENT', 'update requires an object');
    }
    const expanded = {};
    for (const [k, v] of Object.entries(updates)) {
      const full = prefix ? `${prefix}/${normalizePath(k)}` : normalizePath(k);
      expanded[full] = v;
    }
    try {
      this._hub._commitSync(this._state.uid, expanded);
    } catch (err) {
      this._hub.stats.rejectedWrites++;
      throw err;
    }
  }

  async remove(path) {
    return this.set(path, null);
  }

  async runTransaction(path, updateFn) {
    const blocked = this._guardNetwork();
    if (blocked) return blocked;
    const norm = normalizePath(path);
    this._hub.stats.transactions++;
    try {
      this._hub._checkReadPermission(this._state.uid, norm, null);
    } catch (err) {
      this._hub.stats.rejectedReads++;
      throw err;
    }
    const parts = splitPath(norm);
    const current = deepClone(getAt(this._hub._root, parts));
    const next = updateFn(current);
    if (next === undefined) {
      return { committed: false, value: current };
    }
    try {
      this._hub._commitSync(this._state.uid, { [norm]: next });
    } catch (err) {
      this._hub.stats.rejectedWrites++;
      throw err;
    }
    const committedVal = deepClone(getAt(this._hub._root, parts));
    return { committed: true, value: committedVal };
  }

  onValue(path, cb, onError = () => {}) {
    const norm = normalizePath(path);
    const entry = {
      uid: this._state.uid,
      path: norm,
      parts: splitPath(norm),
      cb,
      onError,
      lastRef: Symbol('init'),
    };
    this._hub._listeners.add(entry);
    queueMicrotask(() => {
      if (this._hub._listeners.has(entry) && this._state.connected && !this._state.blackHoled && !this._state.closed) {
        this._hub._deliverListener(entry, true);
      }
    });
    return () => {
      this._hub._listeners.delete(entry);
    };
  }

  async queryWorldsIndex({ limit = 20, orderByChild = 'updatedAt' } = {}) {
    const blocked = this._guardNetwork();
    if (blocked) return blocked;
    const queryOpts = { orderByChild, limitToLast: limit };
    try {
      this._hub._checkReadPermission(this._state.uid, 'worldsIndex', queryOpts);
    } catch (err) {
      this._hub.stats.rejectedReads++;
      throw err;
    }
    const all = this._hub._root.worldsIndex || {};
    const entries = Object.entries(all)
      .sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0))
      .slice(-limit);
    const out = {};
    for (const [k, v] of entries) out[k] = deepClone(v);
    this._hub.stats.reads++;
    this._hub.stats.bytesRead += byteSizeOf(out);
    return out;
  }

  onDisconnect(path) {
    const norm = normalizePath(path);
    return {
      set: async (value) => {
        const blocked = this._guardNetwork();
        if (blocked) return blocked;
        this._state.onDisconnects.set(norm, { op: 'set', value: deepClone(value) });
      },
      remove: async () => {
        const blocked = this._guardNetwork();
        if (blocked) return blocked;
        this._state.onDisconnects.set(norm, { op: 'remove', value: null });
      },
      cancel: async () => {
        const blocked = this._guardNetwork();
        if (blocked) return blocked;
        this._state.onDisconnects.delete(norm);
      },
    };
  }

  onConnected(cb) {
    this._state.connectedCbs.add(cb);
    queueMicrotask(() => {
      if (!this._state.closed && this._state.connectedCbs.has(cb)) {
        cb(this._state.connected);
      }
    });
    return () => {
      this._state.connectedCbs.delete(cb);
    };
  }

  goOffline() {
    this._hub._setClientOnline(this._state, false);
  }

  goOnline() {
    this._hub._setClientOnline(this._state, true);
  }

  async close() {
    if (this._state.closed) return;
    this._hub._setClientOnline(this._state, false);
    this._state.closed = true;
    this._state.connectedCbs.clear();
    for (const l of [...this._hub._listeners]) {
      if (l.uid === this._state.uid) this._hub._listeners.delete(l);
    }
  }
}
