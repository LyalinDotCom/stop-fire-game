// Lazy-loaded Firebase client for EMBER FRONT multiplayer.
// CRITICAL: Zero static imports of firebase/* — Solo mode downloads 0 bytes of Firebase!
// Dynamically imports firebase/app, firebase/auth, firebase/database ONLY when connectFirebase() is called.

import { buildFirebaseOptions, parseNetQuery } from './config.js';
import { LiveRtdbAdapter } from './LiveRtdbAdapter.js';
import { RtdbError } from './RtdbAdapter.js';

const APP_NAME = 'ember-front-net';
const CONNECT_TIMEOUT_MS = 12000;

let socketsForced = false;
const emulatorsWired = new WeakSet();

/**
 * Dynamically load Firebase SDK, sign in anonymously, wait for RTDB connection,
 * and return a LiveRtdbAdapter ready for WorldSession.
 */
export async function connectFirebase(opts = {}) {
  const query = parseNetQuery(opts.search);
  const emulatorPorts = opts.emulatorPorts !== undefined ? opts.emulatorPorts : query.emulatorPorts;
  const useTabPersistence = opts.tab !== undefined ? !!opts.tab : query.tab;
  const appName = opts.appName || APP_NAME;
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const host = opts.emulatorHost || globalThis.location?.hostname || '127.0.0.1';

  const options = buildFirebaseOptions(emulatorPorts, host);

  let appSdk;
  let authSdk;
  let dbSdk;
  try {
    [appSdk, authSdk, dbSdk] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/database'),
    ]);
  } catch (err) {
    throw new RtdbError('offline', `Failed to load Firebase SDK: ${err?.message || err}`);
  }

  // Reuse existing named app instance across reconnects/mode switches.
  let app = appSdk.getApps().find((a) => a.name === appName);
  if (!app) {
    app = appSdk.initializeApp(options, appName);
  }

  // Configure auth persistence: browserLocalPersistence by default, browserSessionPersistence for ?tab.
  let auth;
  try {
    const persistence = useTabPersistence
      ? authSdk.browserSessionPersistence
      : authSdk.browserLocalPersistence;
    auth = persistence
      ? authSdk.initializeAuth(app, { persistence })
      : authSdk.getAuth(app);
  } catch {
    // Already initialized on this reused app.
    auth = authSdk.getAuth(app);
  }

  // Force WebSockets once per page to prevent JSONP long-polling fallback.
  if (!socketsForced) {
    try {
      dbSdk.forceWebSockets?.();
    } catch {
      // Ignore if already initialized.
    }
    socketsForced = true;
  }

  const database = dbSdk.getDatabase(app);
  dbSdk.goOnline(database);

  if (emulatorPorts && !emulatorsWired.has(app)) {
    emulatorsWired.add(app);
    try {
      authSdk.connectAuthEmulator(auth, `http://${host}:${emulatorPorts.auth}`, { disableWarnings: true });
    } catch {
      // Ignore duplicate emulator connect.
    }
    try {
      dbSdk.connectDatabaseEmulator(database, host, emulatorPorts.database);
    } catch {
      // Ignore duplicate emulator connect.
    }
  }

  // Silent anonymous authentication (zero login UI).
  let user;
  try {
    if (typeof auth.authStateReady === 'function') {
      await auth.authStateReady();
    }
    user = auth.currentUser ?? (await authSdk.signInAnonymously(auth)).user;
  } catch (err) {
    throw new RtdbError(err?.code || 'auth/failed', err?.message || 'Anonymous sign-in failed');
  }

  // Wait for RTDB connection (.info/connected === true).
  const connected = await new Promise((resolve) => {
    let done = false;
    let off = () => {};
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      resolve(false);
    }, timeoutMs);
    off = dbSdk.onValue(dbSdk.ref(database, '.info/connected'), (snap) => {
      if (!done && snap.val()) {
        done = true;
        clearTimeout(timer);
        off();
        resolve(true);
      }
    });
  });

  if (!connected) {
    dbSdk.goOffline(database);
    throw new RtdbError('offline', 'Timed out connecting to Firebase RTDB');
  }

  return new LiveRtdbAdapter({
    appSdk,
    authSdk,
    dbSdk,
    app,
    auth,
    database,
    user,
    emulator: !!emulatorPorts,
  });
}
