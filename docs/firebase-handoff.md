# EMBER FRONT — Firebase RTDB Remote Builder Handoff Playbook

> **Pre-Provisioned Live Environment:**
> - **Firebase Project ID:** `ember-front-rtdb` (project number `93945009664`, Spark free tier)
> - **Database URL:** `https://ember-front-rtdb-default-rtdb.firebaseio.com` (`us-central1`)
> - **Auth Domain:** `ember-front-rtdb.firebaseapp.com`
> - **Storage Bucket:** `ember-front-rtdb.firebasestorage.app`
> - **App ID:** `1:93945009664:web:ddec5c22b955083b94aae5`
> - **Auth Provider:** Plain Anonymous Auth enabled live (`firebase deploy --only auth`)
> - **Live RTDB Rules:** `database.rules.json` deployed live (`firebase deploy --only database`)
> - **API Key (Public Web App):** `AIzaSyDH7FIJW3nTyS_4L1A_v3glo42vt6sCkEk` (wired directly in `src/net/firebaseConfig.js`, public by design; access control enforced by Anonymous Auth + deployed `database.rules.json`)

## Deployed Immutable Rules Contract (`database.rules.json`)

All netcode in `src/net/` and `MockRtdbAdapter.js` MUST obey these exact deployed server invariants:

1. **Root & World IDs:** Root `.read`/`.write` are `false`. `$w` matches `/^megabasin-(0[1-9]|1[0-9]|20)$/`. `mode === 'megabasin'`, `protocolVersion === 1`, `buildHash` `/^[0-9a-f]{12}$/`.
2. **Bounded Discovery:** `worldsIndex` requires `orderByChild('updatedAt')` and `limitToLast(<= 20)`.
3. **8 Parent-Validated `serverTimestamp()` Nodes:** `worldsIndex/$w.updatedAt`, `config.createdAt`, `slots/$slot.at`, `roster/$slot.at`, `presence/$uid.at`, `in/$uid.t`, `fireKey.t`, `meta.t` MUST always be written as full objects with `serverTimestamp()` (never partial child updates!).
4. **Server-Clock Write Pacing:**
   - `in/$uid`: `>= 180 ms` (send at `250 ms` / 4 Hz nominal)
   - `meta`: `>= 800 ms` (send at `2000 ms` / 0.5 Hz)
   - `roster/$slot`: `>= 1000 ms`
   - `presence/$uid`: `>= 1000 ms` (`>= 100 ms` when recovering from `away: true`)
   - `fireKey`: `>= 4000 ms` (send every `5000 ms`)
   - `worldsIndex/$w`: `>= 5000 ms` (send every `10000 ms`)
   - `slots/$slot` self-renew: `>= 10000 ms` (renew every `20000 ms`)
5. **`O(1)` Bijective Slots (`0..99`):** `$slot` matches `/^([0-9]|[1-9][0-9])$/` (no leading zeros). Claiming a slot MUST atomically multi-path `update()` `slots/$s`, `uidToSlot/$uid`, and `roster/$s` together. `slots/$s/leaseUntil` in `(now + 15000, now + 45000]` (target `serverNow + 40000`).
6. **`connId`-Fenced Presence:** `conn` `/^[A-Za-z0-9]{12}$/`. Write `{ conn, at: serverTimestamp() }` and await ack FIRST, then sequentially arm `onDisconnect().set({ conn, at: serverTimestamp(), away: true })`. `in/$uid` requires `c === presence/$uid/conn` and `!presence/$uid/away.exists()`.
7. **World Creation & Authority Lease:**
   - Fresh world: (1) write `presence/$uid` and await ack; (2) atomic multi-path `update` on `worlds/$w` writing `config`, `authority` (`epoch: 1, rev: 0`), `slots/$s`, `uidToSlot/$uid`, `roster/$s`; (3) write `worldsIndex/$w`.
   - Attach `onValue` to `authority` BEFORE `runTransaction(authority)`.
   - Lease renewals/takeovers: `rev = oldRev + 1`, `leaseUntil` in `(now + 4000, now + 10000]` (target `serverNow + 8000`), or `leaseUntil: serverTimestamp()` for voluntary abdication.
8. **Strict Keys & Payload Caps:** `"$other": { ".validate": false }` everywhere. Caps: `in.d <= 72`, `planes.p <= 1650`, `fireRing/$slot.d <= 2048` (`q % 16 === $slot`), `fireKey.d <= 12288`, `meta.d <= 1024`, `roster.name` `/^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,15}$/`, `roster.color` `0..15`.
9. **Clean Deletion (No Leaks & No Missing-Leaf Rejections):**
   - Deletable leaves: `slots/$s`, `uidToSlot/$uid`, `roster/$s`, `in/$uid`, `presence/$uid` — all enforce `!newData.exists() && data.exists()`.
   - NEVER include `null` in a multi-path `update()` for a leaf that was never written (e.g. leaving before first `in/$uid` write) or the entire atomic update fails!
   - Remove `presence/$uid` BEFORE calling `onDisconnect().cancel()`.
   - Live Host only nulls `presence/$deadUid` when `away === true || now - at >= 15000` and their slot is already removed/reassigned.

## Three-Tier Testing Strategy
- **Tier 1 (Offline Deterministic):** `RtdbAdapter` + `MockRtdbAdapter` enforcing all live rules + virtual clock + crash/blackhole injection -> codec tests, adversarial rule tests, failover chaos tests, 100-bot scale test (`node --test`).
- **Tier 2 (Live Staging Shards):** Target ONLY `STAGING_WORLD_IDS` (`megabasin-19`, `megabasin-20`), max `5–10` clients, idempotent setup & clean abdication/leaf teardown.
- **Tier 3 (Offline 100-Plane Browser Mode):** `?loopback=100` (alias `?bots=100`) runs 1 local pilot + 99 autonomous autopilot bots through the real `MockRtdbAdapter` + `protocol.js` + `StreamClient` + `PlaneInterpolator` + `SceneRenderer` (`InstancedMesh`) + `TacticalMap`.
