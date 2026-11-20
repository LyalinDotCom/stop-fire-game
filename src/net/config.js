// Multiplayer configuration, query-parameter parsers, protocol constants, and callsign sanitization.
import { DEFAULT_WORLD_ID, FIREBASE_CONFIG } from './firebaseConfig.js';

export const PROTOCOL_VERSION = 1;
export const RING_SIZE = 16;
export const MAX_SLOTS = 100;
export const CALLSIGN_MAX = 16;
export const EMULATOR_PORTS = Object.freeze({ auth: 9461, database: 9462 });

export const WORLD_ID_RE = /^megabasin-(0[1-9]|1[0-9]|20)$/;
export const SLOT_KEY_RE = /^([0-9]|[1-9][0-9])$/;
export const RING_KEY_RE = /^([0-9]|1[0-5])$/;
export const BUILD_HASH_RE = /^[0-9a-f]{12}$/;
export const CONN_ID_RE = /^[A-Za-z0-9]{12}$/;
export const CALLSIGN_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,15}$/;

export const PAYLOAD_CAPS = Object.freeze({
  input: 72,
  planes: 1650,
  fireRing: 2048,
  fireKey: 12288,
  meta: 1024,
});

export const PACING_MS = Object.freeze({
  input: 180,
  meta: 800,
  roster: 1000,
  presence: 1000,
  presenceRecover: 100,
  fireKey: 4000,
  worldsIndex: 5000,
  slotRenew: 10000,
});

const CALLSIGN_STORAGE_KEY = 'emberfront.callsign';

/** Sanitize user-provided callsign to match the RTDB CALLSIGN_RE rule. */
export function sanitizeCallsign(text, fallback = '') {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 _.'-]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, CALLSIGN_MAX)
    .trim();
  return CALLSIGN_RE.test(s) ? s : fallback;
}

export function defaultCallsign(slotId = 7) {
  const n = Number.isInteger(slotId) && slotId >= 0 && slotId < 100 ? slotId : 7;
  return `EF-${String(n).padStart(2, '0')}`;
}

export function loadSavedCallsign() {
  try {
    const raw = globalThis.localStorage?.getItem(CALLSIGN_STORAGE_KEY) ?? '';
    return sanitizeCallsign(raw, 'EF-07');
  } catch {
    return 'EF-07';
  }
}

export function saveCallsign(callsign) {
  const clean = sanitizeCallsign(callsign, '');
  if (!clean) return '';
  try {
    globalThis.localStorage?.setItem(CALLSIGN_STORAGE_KEY, clean);
  } catch {
    // Storage disabled/blocked.
  }
  return clean;
}

export function getBuildHash() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __BUILD_HASH__ === 'string' && BUILD_HASH_RE.test(__BUILD_HASH__)) {
      // eslint-disable-next-line no-undef
      return __BUILD_HASH__;
    }
  } catch {
    // Not replaced by Vite define (e.g. Node unit tests).
  }
  return '000000000000';
}

/** Parse ?emu, ?world=, ?tab, ?loopback=, ?bots=, ?mode= from a URL search string. */
export function parseNetQuery(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search || '');

  // ?emu or ?emu=1 or ?emu=9461,9462
  let emu = false;
  let emulatorPorts = null;
  if (params.has('emu')) {
    const raw = (params.get('emu') ?? '').trim();
    if (raw !== '0' && raw !== 'false') {
      emu = true;
      const parts = raw.split(',').map((n) => Number.parseInt(n, 10)).filter((n) => n > 0 && n < 65536);
      emulatorPorts = parts.length === 2
        ? { auth: parts[0], database: parts[1] }
        : { auth: EMULATOR_PORTS.auth, database: EMULATOR_PORTS.database };
    }
  }

  // ?world=megabasin-01..20
  const rawWorld = (params.get('world') ?? '').trim();
  const worldId = WORLD_ID_RE.test(rawWorld) ? rawWorld : DEFAULT_WORLD_ID;

  // ?tab -> browserSessionPersistence (distinct anonymous UID per tab)
  const tab = params.has('tab') && params.get('tab') !== '0' && params.get('tab') !== 'false';

  // ?loopback=100 or ?bots=100 (also ?loopback with empty value defaults to 100)
  let loopback = 0;
  const rawLoopback = params.has('loopback') ? params.get('loopback') : (params.has('bots') ? params.get('bots') : null);
  if (rawLoopback !== null) {
    const trimmed = rawLoopback.trim();
    if (trimmed === '' || trimmed === 'true') {
      loopback = MAX_SLOTS;
    } else {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isFinite(n) && n > 0) {
        loopback = Math.max(1, Math.min(MAX_SLOTS, n));
      }
    }
  }

  const mode = loopback > 0 ? 'loopback' : 'mp';

  return {
    emu,
    emulatorPorts,
    worldId,
    tab,
    loopback,
    mode,
  };
}

/** Build Firebase app options, pointing databaseURL at local emulator if enabled. */
export function buildFirebaseOptions(emulatorPorts = null, host = globalThis.location?.hostname || '127.0.0.1') {
  if (!emulatorPorts) return { ...FIREBASE_CONFIG };
  return {
    ...FIREBASE_CONFIG,
    apiKey: FIREBASE_CONFIG.apiKey || 'demo-ember-front-emulator-key',
    databaseURL: `http://${host}:${emulatorPorts.database}?ns=${FIREBASE_CONFIG.projectId}-default-rtdb`,
  };
}
