// Public Firebase Web App configuration for EMBER FRONT (project: ember-front-rtdb, Spark plan).
// This web config is public by design — every browser receives it to locate the project and RTDB
// instance. It contains NO private keys, tokens, or service-account secrets; all access control is
// enforced by Firebase Anonymous Auth and the deployed Realtime Database rules (database.rules.json).

export const FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyDH7FIJW3nTyS_4L1A_v3glo42vt6sCkEk',
  authDomain: 'ember-front-rtdb.firebaseapp.com',
  databaseURL: 'https://ember-front-rtdb-default-rtdb.firebaseio.com',
  projectId: 'ember-front-rtdb',
  storageBucket: 'ember-front-rtdb.firebasestorage.app',
  messagingSenderId: '93945009664',
  appId: '1:93945009664:web:ddec5c22b955083b94aae5',
});

// Shared Mega-Basin RTDB shard IDs (database.rules.json bounds shards to megabasin-01..20).
export const DEFAULT_WORLD_ID = 'megabasin-01';
export const STAGING_WORLD_IDS = Object.freeze(['megabasin-19', 'megabasin-20']);

// Conservative active-pilot soft cap on Spark (100 simultaneous connection hard limit),
// reserving 15 connections for reconnect overlap and DEMO FLIGHT read-only spectators.
export const WORLD_SOFT_CAP = 85;

export default FIREBASE_CONFIG;
