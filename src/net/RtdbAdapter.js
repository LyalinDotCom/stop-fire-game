// Transport-agnostic RTDB adapter contract and shared helpers.
// Every netcode module talks exclusively to an RtdbAdapter (LiveRtdbAdapter or MockRtdbAdapter),
// never importing firebase/database directly.

export const SERVER_TIMESTAMP_SENTINEL = Object.freeze({ '.sv': 'timestamp' });

export function isServerTimestamp(value) {
  return !!value && typeof value === 'object' && value['.sv'] === 'timestamp';
}

export function normalizePath(path) {
  if (!path) return '';
  return String(path).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

export function splitPath(path) {
  const norm = normalizePath(path);
  return norm ? norm.split('/') : [];
}

export function joinPath(...parts) {
  return normalizePath(parts.filter((p) => p !== '' && p !== null && p !== undefined).join('/'));
}

export class RtdbError extends Error {
  constructor(code, message, detail = '') {
    super(message || code);
    this.name = 'RtdbError';
    this.code = code;
    this.detail = detail || message || code;
  }
}

export function isPermissionDenied(err) {
  if (!err) return false;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toUpperCase();
  return code.includes('PERMISSION_DENIED') || msg.includes('PERMISSION_DENIED');
}

export function isOfflineError(err) {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  return code === 'offline' || code === 'network-request-failed';
}

/**
 * Base class documenting the required RtdbAdapter interface.
 * Concrete implementations: LiveRtdbAdapter, MockRtdbAdapter.
 */
export class RtdbAdapter {
  get uid() { throw new Error('RtdbAdapter.uid not implemented'); }
  now() { throw new Error('RtdbAdapter.now() not implemented'); }
  serverTimestamp() { return SERVER_TIMESTAMP_SENTINEL; }
  async get(_path) { throw new Error('RtdbAdapter.get() not implemented'); }
  async set(_path, _value) { throw new Error('RtdbAdapter.set() not implemented'); }
  async update(_pathOrUpdates, _maybeUpdates) { throw new Error('RtdbAdapter.update() not implemented'); }
  async remove(_path) { throw new Error('RtdbAdapter.remove() not implemented'); }
  async runTransaction(_path, _updateFn) { throw new Error('RtdbAdapter.runTransaction() not implemented'); }
  onValue(_path, _cb, _onError) { throw new Error('RtdbAdapter.onValue() not implemented'); }
  async queryWorldsIndex(_opts) { throw new Error('RtdbAdapter.queryWorldsIndex() not implemented'); }
  onDisconnect(_path) { throw new Error('RtdbAdapter.onDisconnect() not implemented'); }
  onConnected(_cb) { throw new Error('RtdbAdapter.onConnected() not implemented'); }
  goOffline() { throw new Error('RtdbAdapter.goOffline() not implemented'); }
  goOnline() { throw new Error('RtdbAdapter.goOnline() not implemented'); }
  async close() {}
}
