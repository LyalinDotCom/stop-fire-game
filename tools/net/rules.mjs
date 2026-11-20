// Programmatic Firebase Realtime Database rules generator for EMBER FRONT.
// Usage:
//   npm run net:rules        -> writes database.rules.json
//   npm run net:rules:check  -> exits 0 iff database.rules.json matches this generator
//
// Matches the exact deployed live rules contract on `ember-front-rtdb`
// (docs/gamespec.md §8.5 & docs/firebase-handoff.md):
// - Root .read/.write = false
// - Strict shard IDs /^megabasin-(0[1-9]|1[0-9]|20)$/
// - Bounded worldsIndex discovery (orderByChild('updatedAt'), limitToLast <= 20)
// - 8 parent-validated serverTimestamp() nodes
// - Server-clock write pacing on all hot/warm nodes
// - O(1) bijective integer uidToSlot/$uid (0..99) <-> slots/{0..99} + roster/{0..99}
// - connId-fenced presence & onDisconnect
// - Monotonic sequence-numbered in/$uid ({ s, t, c, d })
// - Authority lease renewal, voluntary abdication, and epoch+1 takeover
// - Strict "$other": { ".validate": false } key allowlists & payload caps
// - Clean conditional deletion (!newData.exists() && data.exists())

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../../database.rules.json', import.meta.url));

// ── Parenthesizing RTDB rule expression builders ──
const all = (xs) => `(${xs.join(' && ')})`;
const any = (xs) => `(${xs.join(' || ')})`;
const re = (p) => p.toString();
const int = (v, lo, hi) => all([`${v}.isNumber()`, `${v}.val() % 1 === 0`, `${v}.val() >= ${lo}`, `${v}.val() <= ${hi}`]);
const str = (lo, hi) => all(['newData.isString()', `newData.val().length >= ${lo}`, `newData.val().length <= ${hi}`]);
const val = (rule) => ({ '.validate': rule });
const closed = { $other: val(false) };

// ── Protocol constants (kept in sync with src/net/config.js) ──
const WORLD_ID_RE = /^megabasin-(0[1-9]|1[0-9]|20)$/;
const MAP_ID_RE = /^[a-z0-9_-]{2,24}$/;
const SLOT_KEY_RE = /^([0-9]|[1-9][0-9])$/;
const RING_KEY_RE = /^([0-9]|1[0-5])$/;
const BUILD_HASH_RE = /^[0-9a-f]{12}$/;
const CONN_ID_RE = /^[A-Za-z0-9]{12}$/;
const CALLSIGN_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,15}$/;

const PROTOCOL_VERSION = 1;
const RING_SIZE = 16;
const MAX_WORLD_TTL_MS = 86_400_000;

// ── Common path helpers ──
const W = "root.child('worlds').child($w)";
const AUTH = `${W}.child('authority')`;
const CFG = `${W}.child('config')`;
const isHostUid = `auth.uid === ${AUTH}.child('uid').val()`;
const isLiveHost = all([isHostUid, `${AUTH}.child('leaseUntil').val() > now`]);
const hostEpochMatches = `newData.child('e').val() === ${AUTH}.child('epoch').val()`;

// ── worldsIndex/$w ──
const worldsIndex = {
  '.read': all(['auth !== null', "query.orderByChild === 'updatedAt'", 'query.limitToLast <= 20']),
  '.indexOn': ['updatedAt'],
  $w: {
    '.write': all([
      'auth !== null',
      `$w.matches(${re(WORLD_ID_RE)})`,
      'newData.exists()',
      isLiveHost,
      any(['!data.exists()', "now - data.child('updatedAt').val() >= 5000"]),
    ]),
    '.validate': all([
      `$w.matches(${re(WORLD_ID_RE)})`,
      "newData.hasChildren(['name', 'mode', 'players', 'cap', 'buildHash', 'protocolVersion', 'updatedAt', 'expiresAt'])",
      "newData.child('updatedAt').val() === now",
    ]),
    name: val(str(1, 48)),
    mode: val("newData.val() === 'megabasin'"),
    players: val(int('newData', 0, 100)),
    cap: val(all([int('newData', 1, 100), `newData.val() === ${CFG}.child('cap').val()`])),
    buildHash: val(all([
      'newData.isString()',
      `newData.val().matches(${re(BUILD_HASH_RE)})`,
      `newData.val() === ${CFG}.child('buildHash').val()`,
    ])),
    protocolVersion: val(`newData.val() === ${PROTOCOL_VERSION}`),
    updatedAt: val('newData.val() === now'),
    expiresAt: val(all([
      'newData.isNumber()',
      'newData.val() > now',
      `newData.val() <= now + ${MAX_WORLD_TTL_MS}`,
      `newData.val() === ${CFG}.child('expiresAt').val()`,
    ])),
    ...closed,
  },
};

// ── worlds/$w/config (immutable world genesis metadata) ──
const config = {
  '.read': 'auth !== null',
  '.write': all([
    'auth !== null',
    '!data.exists()',
    'newData.exists()',
    "newData.parent().child('authority/uid').val() === auth.uid",
    "newData.parent().child('authority/epoch').val() === 1",
  ]),
  '.validate': all([
    "newData.hasChildren(['mode', 'mapId', 'cap', 'protocolVersion', 'buildHash', 'createdAt', 'expiresAt'])",
    "newData.child('createdAt').val() === now",
  ]),
  mode: val("newData.val() === 'megabasin'"),
  mapId: val(all(['newData.isString()', `newData.val().matches(${re(MAP_ID_RE)})`])),
  cap: val(int('newData', 1, 100)),
  protocolVersion: val(`newData.val() === ${PROTOCOL_VERSION}`),
  buildHash: val(all(['newData.isString()', `newData.val().matches(${re(BUILD_HASH_RE)})`])),
  createdAt: val('newData.val() === now'),
  expiresAt: val(all(['newData.isNumber()', 'newData.val() > now', `newData.val() <= now + ${MAX_WORLD_TTL_MS}`])),
  ...closed,
};

// ── worlds/$w/authority (single-host lease election, renewal, abdication, takeover) ──
const leaseWindow = all([
  "newData.child('leaseUntil').val() > now + 4000",
  "newData.child('leaseUntil').val() <= now + 10000",
]);
const callerHoldsSlotInNewWorld = all([
  "newData.parent().child('uidToSlot').child(auth.uid).exists()",
  "newData.parent().child('slots').child(newData.parent().child('uidToSlot').child(auth.uid).val() + '').child('uid').val() === auth.uid",
]);
const authorityCreate = all([
  '!data.exists()',
  "newData.parent().child('config').exists()",
  "newData.child('uid').val() === auth.uid",
  "newData.child('epoch').val() === 1",
  "newData.child('rev').val() === 0",
  leaseWindow,
]);
const authorityRenew = all([
  "data.child('uid').val() === auth.uid",
  "data.child('leaseUntil').val() > now",
  "newData.child('uid').val() === auth.uid",
  "newData.child('epoch').val() === data.child('epoch').val()",
  leaseWindow,
]);
const authorityAbdicate = all([
  "data.child('uid').val() === auth.uid",
  "data.child('leaseUntil').val() > now",
  "newData.child('uid').val() === auth.uid",
  "newData.child('epoch').val() === data.child('epoch').val()",
  "newData.child('leaseUntil').val() === now",
]);
const authorityTakeover = all([
  "data.child('leaseUntil').val() <= now",
  "newData.child('uid').val() === auth.uid",
  "newData.child('epoch').val() === data.child('epoch').val() + 1",
  leaseWindow,
]);
const authority = {
  '.read': 'auth !== null',
  '.write': all([
    'auth !== null',
    'newData.exists()',
    callerHoldsSlotInNewWorld,
    any([
      authorityCreate,
      all([
        'data.exists()',
        "newData.child('rev').val() === data.child('rev').val() + 1",
        any([authorityRenew, authorityAbdicate, authorityTakeover]),
      ]),
    ]),
  ]),
  '.validate': "newData.hasChildren(['uid', 'epoch', 'rev', 'leaseUntil'])",
  uid: val(str(1, 128)),
  epoch: val(int('newData', 1, 1e9)),
  rev: val(int('newData', 0, 1e9)),
  leaseUntil: val('newData.isNumber()'),
  ...closed,
};

// ── worlds/$w/slots/{0..99} (O(1) bijective slot lease) ──
const slotLeaseWindow = all([
  "newData.child('leaseUntil').val() > now + 15000",
  "newData.child('leaseUntil').val() <= now + 45000",
]);
const slotOccupantPresence = `${W}.child('presence').child(data.child('uid').val())`;
const slotDelete = all([
  '!newData.exists()',
  'data.exists()',
  any([
    all([
      "data.child('uid').val() === auth.uid",
      "!newData.parent().parent().child('uidToSlot').child(auth.uid).exists()",
    ]),
    all([
      isLiveHost,
      any([
        "data.child('leaseUntil').val() <= now",
        all([
          `${slotOccupantPresence}.child('away').val() === true`,
          `now - ${slotOccupantPresence}.child('at').val() >= 15000`,
        ]),
      ]),
    ]),
  ]),
]);
const slotClaim = all([
  any(['!data.exists()', "data.child('leaseUntil').val() <= now"]),
  "newData.parent().parent().child('config').exists()",
  "newData.parent().parent().child('roster').child($slot).exists()",
]);
const slotSelfRenew = all([
  'data.exists()',
  "data.child('uid').val() === auth.uid",
  "now - data.child('at').val() >= 10000",
]);
const slots = {
  '.read': 'auth !== null',
  $slot: {
    '.write': all([
      'auth !== null',
      `$slot.matches(${re(SLOT_KEY_RE)})`,
      any([
        slotDelete,
        all([
          'newData.exists()',
          "newData.child('uid').val() === auth.uid",
          "newData.child('at').val() === now",
          slotLeaseWindow,
          "newData.parent().parent().child('uidToSlot').child(auth.uid).val() + '' === $slot",
          any([slotClaim, slotSelfRenew]),
        ]),
      ]),
    ]),
    '.validate': all([
      `$slot.matches(${re(SLOT_KEY_RE)})`,
      "newData.hasChildren(['uid', 'conn', 'at', 'leaseUntil'])",
      "newData.child('at').val() === now",
    ]),
    uid: val(all(['newData.isString()', 'newData.val() === auth.uid'])),
    conn: val(all(['newData.isString()', `newData.val().matches(${re(CONN_ID_RE)})`])),
    at: val('newData.val() === now'),
    leaseUntil: val(all(['newData.isNumber()', 'newData.val() > now + 15000', 'newData.val() <= now + 45000'])),
    ...closed,
  },
};

// ── worlds/$w/uidToSlot/$uid (private integer 0..99 inverse index enforcing 1 slot per UID) ──
const uidToSlot = {
  $uid: {
    '.read': all(['auth !== null', any(['auth.uid === $uid', isHostUid])]),
    '.write': all([
      'auth !== null',
      any([
        all([
          'auth.uid === $uid',
          'newData.exists()',
          int('newData', 0, 99),
          any([
            '!data.exists()',
            'data.val() === newData.val()',
            "newData.parent().parent().child('slots').child(data.val() + '').child('uid').val() !== auth.uid",
          ]),
          "newData.parent().parent().child('slots').child(newData.val() + '').child('uid').val() === auth.uid",
          "newData.parent().parent().child('roster').child(newData.val() + '').exists()",
        ]),
        all([
          '!newData.exists()',
          'data.exists()',
          any([
            all([
              'auth.uid === $uid',
              "!newData.parent().parent().child('slots').child(data.val() + '').exists()",
            ]),
            all([
              isLiveHost,
              any([
                "!newData.parent().parent().child('slots').child(data.val() + '').exists()",
                "newData.parent().parent().child('slots').child(data.val() + '').child('uid').val() !== $uid",
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
    '.validate': int('newData', 0, 99),
  },
};

// ── worlds/$w/roster/{0..99} (pilot callsign & livery color) ──
const roster = {
  '.read': 'auth !== null',
  $slot: {
    '.write': all([
      'auth !== null',
      `$slot.matches(${re(SLOT_KEY_RE)})`,
      any([
        all([
          '!newData.exists()',
          'data.exists()',
          any([
            all([
              `${W}.child('slots').child($slot).child('uid').val() === auth.uid`,
              "!newData.parent().parent().child('slots').child($slot).exists()",
            ]),
            all([
              isLiveHost,
              "!newData.parent().parent().child('slots').child($slot).exists()",
            ]),
          ]),
        ]),
        all([
          'newData.exists()',
          "newData.child('uid').val() === auth.uid",
          "newData.child('at').val() === now",
          "newData.parent().parent().child('slots').child($slot).child('uid').val() === auth.uid",
          any(['!data.exists()', "now - data.child('at').val() >= 1000"]),
        ]),
      ]),
    ]),
    '.validate': all([
      `$slot.matches(${re(SLOT_KEY_RE)})`,
      "newData.hasChildren(['uid', 'name', 'color', 'at'])",
      "newData.child('at').val() === now",
    ]),
    uid: val(all(['newData.isString()', 'newData.val() === auth.uid'])),
    name: val(all(['newData.isString()', `newData.val().matches(${re(CALLSIGN_RE)})`])),
    color: val(int('newData', 0, 15)),
    at: val('newData.val() === now'),
    ...closed,
  },
};

// ── worlds/$w/presence/$uid (connId-fenced presence & onDisconnect away marker) ──
const presencePresent = all([
  "!newData.child('away').exists()",
  any([
    '!data.exists()',
    "now - data.child('at').val() >= 1000",
    all(["data.child('away').val() === true", "now - data.child('at').val() >= 100"]),
  ]),
]);
const presenceAway = all([
  "newData.child('away').val() === true",
  'data.exists()',
  "data.child('conn').val() === newData.child('conn').val()",
  "!data.child('away').exists()",
]);
const presence = {
  '.read': all(['auth !== null', isHostUid]),
  $uid: {
    '.read': all(['auth !== null', 'auth.uid === $uid']),
    '.write': all([
      'auth !== null',
      any([
        all([
          '!newData.exists()',
          'data.exists()',
          any([
            'auth.uid === $uid',
            all([
              isLiveHost,
              "!newData.parent().parent().child('uidToSlot').child($uid).exists()",
              any(["data.child('away').val() === true", "now - data.child('at').val() >= 15000"]),
            ]),
          ]),
        ]),
        all([
          'auth.uid === $uid',
          'newData.exists()',
          "newData.child('at').val() === now",
          any([presencePresent, presenceAway]),
        ]),
      ]),
    ]),
    '.validate': all([
      "newData.hasChildren(['conn', 'at'])",
      "newData.child('at').val() === now",
    ]),
    conn: val(all(['newData.isString()', `newData.val().matches(${re(CONN_ID_RE)})`])),
    at: val('newData.val() === now'),
    away: val('newData.val() === true'),
    ...closed,
  },
};

// ── worlds/$w/in/$uid (4 Hz pilot telemetry input, connId-fenced, monotonic s, Host-readable) ──
const ownPresence = `${W}.child('presence').child($uid)`;
const inputs = {
  '.read': all(['auth !== null', isHostUid]),
  $uid: {
    '.read': all(['auth !== null', 'auth.uid === $uid']),
    '.write': all([
      'auth !== null',
      any([
        all([
          '!newData.exists()',
          'data.exists()',
          any([
            'auth.uid === $uid',
            all([isLiveHost, "!newData.parent().parent().child('uidToSlot').child($uid).exists()"]),
          ]),
        ]),
        all([
          'auth.uid === $uid',
          'newData.exists()',
          `${W}.child('uidToSlot').child($uid).exists()`,
          `${ownPresence}.child('conn').val() === newData.child('c').val()`,
          `!${ownPresence}.child('away').exists()`,
          "newData.child('t').val() === now",
          any([
            '!data.exists()',
            all([
              "now - data.child('t').val() >= 180",
              any([
                "newData.child('s').val() > data.child('s').val()",
                all([
                  "newData.child('c').val() !== data.child('c').val()",
                  "newData.child('s').val() === 1",
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
    '.validate': all([
      "newData.hasChildren(['s', 't', 'c', 'd'])",
      "newData.child('t').val() === now",
    ]),
    s: val(int('newData', 1, 1e9)),
    t: val('newData.val() === now'),
    c: val(all(['newData.isString()', `newData.val().matches(${re(CONN_ID_RE)})`])),
    d: val(str(1, 72)),
    ...closed,
  },
};

// ── worlds/$w/planes (Host-packed 12 B/plane Base64 fleet stream) ──
const planes = {
  '.read': 'auth !== null',
  '.write': all(['auth !== null', 'newData.exists()', isLiveHost, hostEpochMatches]),
  '.validate': all([
    "newData.hasChildren(['e', 'q', 't', 'p'])",
    "newData.child('t').val() === now",
    any([
      '!data.exists()',
      "newData.child('e').val() > data.child('e').val()",
      all([
        "newData.child('e').val() === data.child('e').val()",
        "newData.child('q').val() > data.child('q').val()",
      ]),
    ]),
  ]),
  e: val(int('newData', 1, 1e9)),
  q: val(int('newData', 0, 1e9)),
  t: val('newData.val() === now'),
  p: val(all(['newData.isString()', 'newData.val().length <= 1650'])),
  ...closed,
};

// ── worlds/$w/fireRing/{0..15} (2 Hz Host cellular fire delta ring buffer) ──
const fireRing = {
  '.read': 'auth !== null',
  $slot: {
    '.write': all(['auth !== null', 'newData.exists()', isLiveHost, hostEpochMatches]),
    '.validate': all([
      `$slot.matches(${re(RING_KEY_RE)})`,
      "newData.hasChildren(['e', 'q', 't', 'd'])",
      "newData.child('t').val() === now",
      `newData.child('q').val() % ${RING_SIZE} + '' === $slot`,
    ]),
    e: val(int('newData', 1, 1e9)),
    q: val(int('newData', 1, 1e9)),
    t: val('newData.val() === now'),
    d: val(str(1, 2048)),
    ...closed,
  },
};

// ── worlds/$w/fireKey (5 s Host full RLE keyframe, one-shot get() only) ──
const fireKey = {
  '.read': 'auth !== null',
  '.write': all([
    'auth !== null',
    'newData.exists()',
    isLiveHost,
    hostEpochMatches,
    any(['!data.exists()', "now - data.child('t').val() >= 4000"]),
  ]),
  '.validate': all([
    "newData.hasChildren(['e', 'q', 't', 'd'])",
    "newData.child('t').val() === now",
  ]),
  e: val(int('newData', 1, 1e9)),
  q: val(int('newData', 0, 1e9)),
  t: val('newData.val() === now'),
  d: val(str(1, 12288)),
  ...closed,
};

// ── worlds/$w/meta (0.5 Hz Host wave, score, and top-10 leaderboard summary) ──
const meta = {
  '.read': 'auth !== null',
  '.write': all([
    'auth !== null',
    'newData.exists()',
    isLiveHost,
    hostEpochMatches,
    any(['!data.exists()', "now - data.child('t').val() >= 800"]),
  ]),
  '.validate': all([
    "newData.hasChildren(['e', 't', 'd'])",
    "newData.child('t').val() === now",
  ]),
  e: val(int('newData', 1, 1e9)),
  t: val('newData.val() === now'),
  d: val(str(1, 1024)),
  ...closed,
};

const rules = {
  rules: {
    '.read': false,
    '.write': false,
    worldsIndex,
    worlds: {
      $w: {
        '.validate': `$w.matches(${re(WORLD_ID_RE)})`,
        config,
        authority,
        slots,
        uidToSlot,
        roster,
        presence,
        in: inputs,
        planes,
        fireRing,
        fireKey,
        meta,
        ...closed,
      },
    },
  },
};

export const RULES = `${JSON.stringify(rules, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== RULES) {
      console.error(`${OUT} does not match tools/net/rules.mjs — run \`npm run net:rules\` and commit it.`);
      process.exit(1);
    }
    console.log(`${OUT} matches tools/net/rules.mjs (${RULES.length} bytes)`);
  } else {
    fs.writeFileSync(OUT, RULES);
    console.log(`wrote ${OUT} (${RULES.length} bytes)`);
  }
}
