// Thin production RtdbAdapter wrapping firebase/database SDK functions passed from FirebaseClient.
// Zero static imports of firebase/* so Solo mode downloads 0 bytes of Firebase.
import { RtdbAdapter, RtdbError, isPermissionDenied, isServerTimestamp, normalizePath } from './RtdbAdapter.js';

const RELISTEN_MIN_MS = 1000;
const RELISTEN_MAX_MS = 15000;

function mapSentinels(value, serverTimeVal) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (isServerTimestamp(value)) return serverTimeVal;
  if (Array.isArray(value)) return value.map((v) => mapSentinels(v, serverTimeVal));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = mapSentinels(v, serverTimeVal);
  }
  return out;
}

function wrapError(err) {
  if (err instanceof RtdbError) return err;
  const code = String(err?.code || 'RTDB_ERROR');
  return new RtdbError(code, err?.message || code, err?.message || code);
}

export class LiveRtdbAdapter extends RtdbAdapter {
  constructor({ appSdk, authSdk, dbSdk, app, auth, database, user, emulator = false }) {
    super();
    this._appSdk = appSdk;
    this._authSdk = authSdk;
    this._dbSdk = dbSdk;
    this._app = app;
    this._auth = auth;
    this._db = database;
    this._user = user;
    this.emulator = emulator;
    this._uid = user.uid;
    this._offset = 0;
    this._connected = true;
    this._closed = false;
    this._connectedCbs = new Set();
    this._pendingOnDisconnect = new Set();

    const offsetRef = dbSdk.ref(database, '.info/serverTimeOffset');
    this._offOffset = dbSdk.onValue(offsetRef, (snap) => {
      const v = snap.val();
      if (typeof v === 'number' && Number.isFinite(v)) this._offset = v;
    });

    const connRef = dbSdk.ref(database, '.info/connected');
    this._offConnected = dbSdk.onValue(connRef, (snap) => {
      const up = !!snap.val();
      this._connected = up;
      if (!up) {
        for (const fail of [...this._pendingOnDisconnect]) fail();
      }
      for (const cb of [...this._connectedCbs]) {
        try { cb(up); } catch { /* ignore listener error */ }
      }
    });
  }

  get uid() { return this._uid; }
  get connected() { return this._connected; }

  now() {
    return Date.now() + this._offset;
  }

  _ref(path) {
    const norm = normalizePath(path);
    return norm ? this._dbSdk.ref(this._db, norm) : this._dbSdk.ref(this._db);
  }

  _assertOpen() {
    if (this._closed) throw new RtdbError('offline', 'RTDB connection closed');
  }

  async get(path) {
    this._assertOpen();
    try {
      const snap = await this._dbSdk.get(this._ref(path));
      return snap.val();
    } catch (e) {
      throw wrapError(e);
    }
  }

  async set(path, value) {
    this._assertOpen();
    try {
      const mapped = mapSentinels(value, this._dbSdk.serverTimestamp());
      await this._dbSdk.set(this._ref(path), mapped);
    } catch (e) {
      throw wrapError(e);
    }
  }

  async update(pathOrUpdates, maybeUpdates) {
    this._assertOpen();
    try {
      let targetPath = '';
      let updates = pathOrUpdates;
      if (typeof pathOrUpdates === 'string') {
        targetPath = pathOrUpdates;
        updates = maybeUpdates;
      }
      const mapped = mapSentinels(updates, this._dbSdk.serverTimestamp());
      await this._dbSdk.update(this._ref(targetPath), mapped);
    } catch (e) {
      throw wrapError(e);
    }
  }

  async remove(path) {
    this._assertOpen();
    try {
      await this._dbSdk.remove(this._ref(path));
    } catch (e) {
      throw wrapError(e);
    }
  }

  async runTransaction(path, updateFn) {
    this._assertOpen();
    try {
      const res = await this._dbSdk.runTransaction(
        this._ref(path),
        (current) => {
          const next = updateFn(current);
          if (next === undefined) return undefined;
          return mapSentinels(next, this._dbSdk.serverTimestamp());
        },
        { applyLocally: false }
      );
      return {
        committed: !!res.committed,
        value: res.snapshot ? res.snapshot.val() : null,
      };
    } catch (e) {
      throw wrapError(e);
    }
  }

  onValue(path, cb, onError = () => {}) {
    if (this._closed) return () => {};
    let off = null;
    let timer = null;
    let wait = RELISTEN_MIN_MS;
    let stopped = false;
    const ref = this._ref(path);

    const attach = () => {
      if (stopped || this._closed) return;
      off = this._dbSdk.onValue(
        ref,
        (snap) => {
          wait = RELISTEN_MIN_MS;
          cb(snap.val());
        },
        (err) => {
          const wrapped = wrapError(err);
          onError(wrapped);
          // Do NOT infinitely relisten on permanent PERMISSION_DENIED errors.
          if (stopped || this._closed || isPermissionDenied(wrapped)) {
            stopped = true;
            return;
          }
          timer = setTimeout(attach, wait);
          wait = Math.min(RELISTEN_MAX_MS, wait * 2);
        }
      );
    };

    attach();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      off?.();
    };
  }

  async queryWorldsIndex({ limit = 20 } = {}) {
    this._assertOpen();
    const bounded = Math.max(1, Math.min(20, Math.floor(limit)));
    try {
      const q = this._dbSdk.query(
        this._ref('worldsIndex'),
        this._dbSdk.orderByChild('updatedAt'),
        this._dbSdk.limitToLast(bounded)
      );
      const snap = await this._dbSdk.get(q);
      return snap.val() || {};
    } catch (e) {
      throw wrapError(e);
    }
  }

  onDisconnect(path) {
    const od = this._dbSdk.onDisconnect(this._ref(path));
    const guarded = (sendFn) => {
      if (this._closed || !this._connected) {
        return Promise.reject(new RtdbError('offline', 'connection is down'));
      }
      return new Promise((resolve, reject) => {
        const fail = () => {
          this._pendingOnDisconnect.delete(fail);
          reject(new RtdbError('offline', 'connection dropped before onDisconnect ack'));
        };
        this._pendingOnDisconnect.add(fail);
        sendFn()
          .then(resolve, (e) => reject(wrapError(e)))
          .finally(() => this._pendingOnDisconnect.delete(fail));
      });
    };

    return {
      set: (value) => guarded(() => od.set(mapSentinels(value, this._dbSdk.serverTimestamp()))),
      remove: () => guarded(() => od.remove()),
      cancel: () => guarded(() => od.cancel()),
    };
  }

  onConnected(cb) {
    this._connectedCbs.add(cb);
    queueMicrotask(() => {
      if (!this._closed && this._connectedCbs.has(cb)) cb(this._connected);
    });
    return () => { this._connectedCbs.delete(cb); };
  }

  goOffline() {
    if (this._closed) return;
    this._dbSdk.goOffline(this._db);
  }

  goOnline() {
    if (this._closed) return;
    this._dbSdk.goOnline(this._db);
  }

  async deleteAnonymousUser() {
    if (this._closed || !this._auth?.currentUser) return;
    try {
      await this._authSdk.deleteUser(this._auth.currentUser);
    } catch {
      // Best-effort cleanup for staging smoke tests.
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const fail of [...this._pendingOnDisconnect]) fail();
    this._pendingOnDisconnect.clear();
    this._connectedCbs.clear();
    this._offOffset?.();
    this._offConnected?.();
    try {
      this._dbSdk.goOffline(this._db);
    } catch {
      // Ignore already offline.
    }
  }
}
