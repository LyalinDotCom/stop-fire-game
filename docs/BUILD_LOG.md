# EMBER FRONT — Build Log & Architecture Record

This document records the team structure, module boundaries, technical decisions, and verification workflow used to build **EMBER FRONT — Aerial Fire Response Unit** so the project can be understood, audited, or recreated cleanly from scratch.

---

## 1. Swarm Team Structure & Exclusive File Ownership

Built in parallel by six specialized agents communicating over a shared coordination board against a single locked contract (`docs/INTERFACES.md`, `docs/gamespec.md`, `docs/firebase-handoff.md`):

| Agent | Domain | Owned Files |
| :--- | :--- | :--- |
| **`scaffold`** | Build tooling, static hosting, Firebase rules/CLI, game configs, build log | `package.json`, `vite.config.js`, `.gitignore`, `.firebaserc`, `firebase.json`, `public/_headers`, `tools/lib/buildHash.mjs`, `tools/net/rules.mjs`, `database.rules.json`, `tools/net/admin.mjs`, `src/config/operations.js`, `src/config/liveries.js`, `docs/BUILD_LOG.md` |
| **`sim-world`** | Deterministic terrain, 60 Hz arcade floatplane physics, autopilot, 10 Hz cellular wildfire sim, unit tests | `src/sim/TerrainGen.js`, `src/sim/FlightModel.js`, `src/sim/Autopilot.js`, `src/sim/FireSim.js`, `src/sim/BackgroundWorker.js`, `test/sim.test.mjs` |
| **`renderer`** | `640×360` retro pixelated Three.js pipeline, custom GLSL shaders, procedural meshes, instanced VFX | `src/render/SkyboxShader.js`, `src/render/WaterShader.js`, `src/render/SmokeBayerShader.js`, `src/render/PlaneMesh.js`, `src/render/WorldMeshes.js`, `src/render/VfxSystem.js`, `src/render/SceneRenderer.js` |
| **`ui-audio`** | Native-res tactical HUD, minimap, 3D callouts, settings drawer, 100% procedural Web Audio synth | `index.html`, `src/styles/hud.css`, `src/audio/AudioEngine.js`, `src/ui/TacticalMap.js`, `src/ui/WorldCallouts.js`, `src/ui/SettingsDrawer.js`, `src/ui/HudController.js` |
| **`netcode`** | 100-player zero-login Firebase RTDB stack, `MockRtdbAdapter`, `?loopback=100` bot runner, Tier 1 net tests | `src/net/firebaseConfig.js`, `src/net/config.js`, `src/net/protocol.js`, `src/net/RtdbAdapter.js`, `src/net/LiveRtdbAdapter.js`, `src/net/MockRtdbAdapter.js`, `src/net/FirebaseClient.js`, `src/net/Link.js`, `src/net/Presence.js`, `src/net/SlotAllocator.js`, `src/net/AuthorityElection.js`, `src/net/HostBroadcaster.js`, `src/net/StreamClient.js`, `src/net/PlaneInterpolator.js`, `src/net/WorldSession.js`, `src/net/LoopbackBots.js`, `test/net.test.mjs` |
| **`integrator`** | Input handling, app wiring, lazy MP import, production build & headless Chrome visual/runtime QA | `src/input/InputManager.js`, `src/main.js`, `tools/qa/verify.mjs` |
| **`auditor`** *(read-only)* | Technical bug hunting, live RTDB contract audit, playtesting, leak & edge-case checks | Read-only across entire repository (routed findings to coordinator) |
| **`monitor`** | Swarm stall monitor | Board health only |

---

## 1.1 Technical Audit & Resolution Ledger

After the initial integrated build passed 27/27 tests and headless Chrome QA, the read-only `auditor` identified 15 concrete technical defects (3 P0, 6 P1, 6 P2). Every finding was verified against source and fixed by its owning worker:

1. **Live RTDB rules schema alignment (P0):** Aligned `tools/net/rules.mjs`, `database.rules.json`, `MockRtdbAdapter.js`, `SlotAllocator.js`, `HostBroadcaster.js`, and `WorldSession.js` to the exact deployed `ember-front-rtdb` contract (`slots/$s.conn`, integer `uidToSlot/$uid` with `$uid`-only read, `roster/$s.uid`, `config.{mapId,cap,expiresAt}`, `in/$uid.s` monotonic sequence, `planes.t`, `fireRing/$slot.t`, `worldsIndex/$w`). Verified live end-to-end against `megabasin-20` via `test/live-smoke.mjs` with zero `PERMISSION_DENIED`.
2. **Mega-Basin Wave 2+ rollover sync (P0):** Added `fullReset: true` on `FireSim.step()` wave rollover, immediate paced `fireKey` republish in `HostBroadcaster`, wave-jump `get(fireKey)` hydration in `StreamClient`, and full 3D terrain/cabin redraw on Host (`_syncAllFireCells`).
3. **`Presence.js` double-write race, un-acked `connId`, & `stop()` hang (P0):** Deferred `this.connId` assignment until after `adapter.set()` ack and resolved `this.ready` with `null` in `stop()`.
4. **Expired `uidToSlot` reload lockout (P1):** `SlotAllocator.claim()` re-claims the user's own expired slot index (`data.val() === newData.val()`) instead of colliding on a new slot.
5. **Safe slot eviction & client reconciliation (P1):** `HostBroadcaster.evictDeadSlots()` guards `in/$uid`/`presence/$uid` deletion when a pilot re-seated in another slot; `SlotAllocator` / `WorldSession` unseat locally on eviction instead of spamming `in/$uid`.
6. **Brief `SPACE` tap burst preservation (P1):** `HostBroadcaster` triggers a minimum `0.25 s` host-side drop burst whenever `dropSeq` advances.
7. **Duplicate remote drop-curtain VFX (P1):** Removed duplicate `_updateRemoteDropVfx()` in `src/main.js` so `VfxSystem.update()` is the sole emitter.
8. **`InstancedMesh` GPU buffer disposal (P1):** Added explicit `.dispose()` calls on every `InstancedMesh` across `WorldMeshes`, `RemotePlaneFleet`, and `VfxSystem`.
9. **`LoopbackBots.js` mid-boot `stop()` leak (P1):** Guarded every `await` in `bootBots()` with `if (stopped) break` and clean teardown.
10. **Replica `cabinAtRisk` hydration (P2):** `FireSim.applyExternalKey()` now calls `_updateReplicaCabinRisk()`.
11. **Phantom slot `7` cabin-saved bonus (P2):** Suppressed `+500 CABIN SAVED` when fire burns out naturally without pilot suppression (`cabinLastHelperSlot[c] < 0`).
12. **`takeControl()` callsign & attitude reset (P2):** Preserved custom callsigns and cleanly reset pitch/roll/velocity/scoop/drop state on `spawnPose` handoff.
13. **Intermission overlay DOM thrash & `localSlotId` (P2):** Updated intermission overlay only on entry or whole-second countdown tick and passed `localSlotId`.
14. **Offline overlay message key (P2):** Passed both `{ message, reason }` to `hud.showOverlay('offline', ...)`.
15. **Active pilot count consistency (P2):** Filtered expired leases in `HostBroadcaster.publishMeta()` to match `publishWorldsIndex()`.

### Final Verified Metrics
- `npm run net:rules:check`: **PASS** (`database.rules.json` zero drift)
- `npm test`: **35/35 PASS** (16 sim + 19 net; 100-pilot `FireSim` tick `p50=0.169 ms`, `p99=0.312 ms`)
- `node test/live-smoke.mjs`: **PASS** live against `ember-front-rtdb` (`megabasin-20`, full write/read/failover + clean `finally` teardown)
- `npm run build`: **PASS** — Solo initial payload **185.6 kB gzip** (`0` Firebase bytes); total dist **313.5 kB gzip**
- `node tools/qa/verify.mjs` (headless Chrome `1280×720`, SwiftShader WebGL): **0 console/page errors**, `640×360` pixelated WebGL, **14–17 draw calls** (`< 25` budget) including 100 active instanced planes in `?loopback=100`

---

## 2. Architecture & Key Engineering Decisions

### 2.1 Pure Static Hosting & Zero-Asset Footprint
- **Zero external media assets:** All 3D geometry (terrain, jagged mountain ring, 3-tier pines, timber cabins, stilted water towers, EF-07 twin-pontoon floatplane), GLSL shaders, and Web Audio synthesis buffers are generated procedurally in code.
- **Lazy Firebase code-splitting:** `vite.config.js` isolates `three` and `firebase` into separate vendor chunks via `manualChunks`. Solo mode boots and plays with **0 bytes of Firebase downloaded** and **0 Firebase network connections**; `src/net/*` and the Firebase SDK are dynamically `import()`ed only when entering Shared Mega-Basin (`?mode=mp` or drawer) or `?loopback=100`.
- **Deterministic Build Identity (`__BUILD_HASH__`):** `tools/lib/buildHash.mjs` computes a locale-independent 12-hex SHA-1 digest over `src/`, `index.html`, `package.json`, and `vite.config.js`, injected at build time so incompatible clients never mix on the same Mega-Basin shard.

### 2.2 Dual-Layer Hybrid Retro-3D Renderer + Native HUD
- **Layer 1 (WebGL):** Locked to `360` vertical rows (`640×360` at 16:9), `antialias: false`, `setPixelRatio(1)`, `SRGBColorSpace`, upscaled nearest-neighbor via CSS `image-rendering: pixelated`.
- **Seamless Skybox:** Procedural `normalize(vWorldDir)` spherical shader eliminates the reference clip's south-horizon UV seam (~185–191° S) while rendering the twilight gradient, hashed 1-px stars, and NNE moon.
- **Branchless Bayer 4×4 Dithered Smoke:** GLSL ES 1.00 / WebGL2-compatible screen-door dithered smoke plumes with warm `#ff6f00` fire under-lighting.
- **100-Plane Draw-Call Budget (`< 25` draw calls):** Dedicated hero plane mesh plus single `InstancedMesh` fleet (body + prop disk) supporting up to 99 remote aircraft across 16 forestry liveries (`src/config/liveries.js`) with `< 15 m` camera proximity alpha-fade so no remote aircraft ever blinds the pilot.
- **Layer 2 (Native-Res HUD):** Crisp `tabular-nums` aviation HUD, fixed North-Up 2D Canvas tactical map with multiplayer density capping (20 nearest chevrons + 2×2 px dots), 3D-projected world callout pins, and `[?]` squadron/settings drawer. All user-supplied callsigns are strictly regex-sanitized and rendered via `textContent` under a strict `script-src 'self'` CSP.

### 2.3 Simulation Core
- **5 Solo Operations (`128×128 @ 16 m`) + Cascadia Mega-Basin (`160×160 @ 20 m`):** Defined in `src/config/operations.js` (`WATER_LEVEL = 12.0 m`).
- **Fixed-Timestep 60 Hz Arcade Floatplane (`FlightModel.js`):** 158 km/h cruise, 5.0 m AGL scoop enter / 6.5 m exit (52%/s refill, -3.5 km/h/s drag, hydroplane cushion), 80%/s water drop with 0.25 s tap burst, forgiving terrain bounce-deflect, perimeter turnback.
- **10 Hz Cellular Wildfire (`FireSim.js`):** 4-bit states (`0` intact, `1..12` burning, `13` wet/steam 15–20 s immunity, `14` charred, `15` 4 s ember warning), 8-way wind + uphill spread, ballistic water parcels (`g = -15.5`, `a_wind = 0.35 * W`), conflict-free `Float32Array` `wetDelta` accumulation with 3 s per-slot attribution (`+70` primary, `+35` co-bomber assist, `+500` cabin saved), and logarithmic pilot count scaling in Mega-Basin.

### 2.4 100-Player Zero-Login Firebase RTDB Protocol
- **Pre-provisioned Project:** `ember-front-rtdb` (`https://ember-front-rtdb-default-rtdb.firebaseio.com`, Anonymous Auth, Spark free tier).
- **Programmatic Rules & Drift Guard:** `tools/net/rules.mjs` generates `database.rules.json` using strictly parenthesized `all()`/`any()` expression builders. `npm run net:rules:check` verifies zero drift before deploy.
- **Rule Invariants Enforced Server-Side and in `MockRtdbAdapter`:**
  - Strict shard allowlist `/^megabasin-(0[1-9]|1[0-9]|20)$/` and bounded `worldsIndex` discovery (`orderByChild('updatedAt')`, `limitToLast <= 20`).
  - 8 parent-validated `serverTimestamp()` nodes and server-clock write pacing (`in` >= 180 ms, `meta` >= 800 ms, `roster` >= 1 s, `presence` >= 1 s / 100 ms away recovery, `fireKey` >= 4 s, `worldsIndex` >= 5 s, `slots` self-renew >= 10 s).
  - `O(1)` bijective slots `0..99` (`slots/$s` <-> `uidToSlot/$uid` + `roster/$s`), `connId`-fenced sequential presence -> `onDisconnect`, single-host elected authority lease with voluntary abdication and `epoch + 1` failover, strict `$other: false` key allowlists, and conditional leaf deletion (`!newData.exists() && data.exists()`).
- **Compact Binary Codecs:** `in/$uid` <= 72 chars; `planes` 12 B/plane Base64 (100 planes = 1,600 chars <= 1650); `fireRing/{0..15}` 3 B/cell <= 2048 chars; `fireKey` 4-bit nibble RLE <= 12288 chars.

---

## 3. Commands & Verification Workflow

```bash
# Install dependencies
npm install

# Regenerate & verify Firebase RTDB security rules
npm run net:rules
npm run net:rules:check

# Run offline deterministic unit & scale tests (Tier 1)
npm run test:sim
npm run test:net
npm test

# Development server (http://localhost:5180)
npm run dev

# Production static build (outputs dist/ for Firebase Hosting / Cloudflare Pages / Netlify)
npm run build
npm run preview

# Firebase project inspection & expired-world cleanup
npm run net:admin -- status
npm run net:admin -- cleanup          # dry-run preview
npm run net:admin -- cleanup --apply  # delete expired worlds
```
