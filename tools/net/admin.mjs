// Firebase administration CLI for EMBER FRONT (ember-front-rtdb).
// Uses the signed-in Firebase CLI account (never prints credentials; never touches billing).
// Usage:
//   node tools/net/admin.mjs status
//   node tools/net/admin.mjs setup
//   node tools/net/admin.mjs cleanup [--apply] [--stale-ms=1800000]
//   node tools/net/admin.mjs config

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT = 'ember-front-rtdb';
const DB = `${PROJECT}-default-rtdb`;
const DEFAULT_STALE_MS = 30 * 60 * 1000; // 30 min idle/expired world threshold

async function loadFirebaseToken() {
  const require = createRequire(import.meta.url);
  const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const auth = require(path.join(globalRoot, 'firebase-tools/lib/auth.js'));
  const account = auth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    throw new Error('No signed-in Firebase CLI account found. Run `firebase login` first.');
  }
  const { access_token: token } = await auth.getAccessToken(account.tokens.refresh_token, [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/firebase',
  ]);
  return token;
}

function makeRestClient(token) {
  async function call(url, { method = 'GET', body } = {}) {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: j };
  }
  async function must(what, p) {
    const r = await p;
    if (!r.ok) {
      throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`);
    }
    return r.body;
  }
  return { call, must };
}

function firebaseCli(...args) {
  return execFileSync('npx', ['firebase', ...args, '--project', PROJECT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

async function status(rest) {
  const billing = await rest.call(`https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`);
  const cfg = await rest.call(`https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`);
  const db = await rest.call(`https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT}/locations/-/instances`);
  const apps = await rest.call(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`);
  return {
    project: PROJECT,
    billingEnabled: billing.body?.billingEnabled ?? null,
    billingAccountAttached: !!billing.body?.billingAccountName,
    anonymousAuth: cfg.body?.signIn?.anonymous?.enabled ?? (cfg.body?.error?.message ?? null),
    databases: (db.body?.instances ?? []).map((i) => `${i.name.split('/').pop()} ${i.type} ${i.state}`),
    webApps: (apps.body?.apps ?? []).map((a) => `${a.displayName} ${a.appId}`),
  };
}

async function setup(rest) {
  await rest.must(
    'enable identitytoolkit',
    rest.call(`https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/identitytoolkit.googleapis.com:enable`, {
      method: 'POST',
      body: {},
    }),
  );
  execFileSync('npx', ['firebase', 'deploy', '--only', 'auth,database', '--project', PROJECT, '--non-interactive'], {
    stdio: 'inherit',
  });
  const s = await status(rest);
  if (!s.databases.length) {
    await rest.must(
      'create RTDB',
      rest.call(`https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT}/locations/us-central1/instances?databaseId=${DB}`, {
        method: 'POST',
        body: { type: 'DEFAULT_DATABASE' },
      }),
    );
  }
  if (!s.webApps.length) {
    await rest.must(
      'register web app',
      rest.call(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`, {
        method: 'POST',
        body: { displayName: 'EMBER FRONT' },
      }),
    );
  }
}

function isWorldExpired(world, indexEntry, now, staleMs) {
  if (!world || typeof world !== 'object') return true;
  const authLease = Number(world.authority?.leaseUntil ?? 0);
  const lastIndex = Number(indexEntry?.updatedAt ?? 0);
  const slots = world.slots && typeof world.slots === 'object' ? Object.values(world.slots) : [];
  const hasLiveSlot = slots.some((s) => Number(s?.leaseUntil ?? 0) > now);
  if (hasLiveSlot || authLease > now) return false;
  const lastActivity = Math.max(authLease, lastIndex, Number(world.config?.createdAt ?? 0));
  return now - lastActivity >= staleMs;
}

async function cleanup(apply, staleMs = DEFAULT_STALE_MS) {
  const get = (p) => JSON.parse(firebaseCli('database:get', `/${p}`) || 'null') ?? {};
  const worlds = get('worlds');
  const worldsIndex = get('worldsIndex');
  const now = Date.now();

  const deadWorlds = Object.entries(worlds)
    .filter(([id, w]) => isWorldExpired(w, worldsIndex[id], now, staleMs))
    .map(([id]) => id);
  const deadWorldSet = new Set(deadWorlds);
  const deadIndexEntries = Object.keys(worldsIndex).filter(
    (id) => !worlds[id] || deadWorldSet.has(id),
  );

  if (apply) {
    for (const id of deadWorlds) firebaseCli('database:remove', `/worlds/${id}`, '--force');
    for (const id of deadIndexEntries) firebaseCli('database:remove', `/worldsIndex/${id}`, '--force');
  }

  return {
    mode: apply ? 'deleted' : 'preview',
    staleMs,
    deadWorlds,
    liveWorlds: Object.keys(worlds).length - deadWorlds.length,
    deadIndexEntries,
  };
}

async function writeWebConfig(rest) {
  const apps = await rest.must('web apps', rest.call(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps`));
  const app = apps.apps?.[0];
  if (!app) throw new Error('No web app registered on project — run `node tools/net/admin.mjs setup` first.');
  const c = await rest.must('web config', rest.call(`https://firebase.googleapis.com/v1beta1/projects/${PROJECT}/webApps/${app.appId}/config`));
  const cfg = {
    apiKey: c.apiKey,
    authDomain: c.authDomain ?? `${PROJECT}.firebaseapp.com`,
    databaseURL: c.databaseURL ?? `https://${DB}.firebaseio.com`,
    projectId: c.projectId ?? PROJECT,
    storageBucket: c.storageBucket ?? `${PROJECT}.firebasestorage.app`,
    messagingSenderId: c.messagingSenderId ?? '93945009664',
    appId: c.appId ?? app.appId,
  };
  const outPath = new URL('../../src/net/firebaseConfig.js', import.meta.url);
  const source = `// Firebase web app public config for EMBER FRONT (written by \`node tools/net/admin.mjs config\`).
// Public project identifier only — security is enforced by Anonymous Auth and database.rules.json.

export const FIREBASE_CONFIG = Object.freeze(${JSON.stringify(cfg, null, 2)});

export const DEFAULT_WORLD_ID = 'megabasin-01';
export const STAGING_WORLD_IDS = Object.freeze(['megabasin-19', 'megabasin-20']);
export const WORLD_SOFT_CAP = 85;

export default FIREBASE_CONFIG;
`;
  fs.writeFileSync(outPath, source);
  return { written: 'src/net/firebaseConfig.js', projectId: cfg.projectId, appId: cfg.appId };
}

function parseStaleMs(argv) {
  const flag = argv.find((a) => a.startsWith('--stale-ms='));
  if (!flag) return DEFAULT_STALE_MS;
  const n = Number.parseInt(flag.split('=')[1], 10);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_STALE_MS;
}

const cmd = process.argv[2] ?? 'status';
if (cmd === 'cleanup') {
  const apply = process.argv.includes('--apply');
  console.log(JSON.stringify(await cleanup(apply, parseStaleMs(process.argv)), null, 2));
} else {
  const token = await loadFirebaseToken();
  const rest = makeRestClient(token);
  if (cmd === 'setup') {
    await setup(rest);
    console.log(JSON.stringify(await status(rest), null, 2));
  } else if (cmd === 'config') {
    console.log(JSON.stringify(await writeWebConfig(rest), null, 2));
  } else {
    console.log(JSON.stringify(await status(rest), null, 2));
  }
}
