# EMBER FRONT — Shared Module Interfaces & Data Contracts

All parallel workers MUST adhere strictly to these coordinates, exports, and data shapes so modules integrate cleanly on the first compile.

## 1. Coordinate System & Units
- Right-handed Y-up (`Three.js`): `+X` = East, `-X` = West, `-Z` = North, `+Z` = South, `+Y` = Up (meters).
- `yawDeg`: `0` = North (`-Z`), `90` = East (`+X`), `180` = South (`+Z`), `270` = West (`-X`).
  - Horizontal forward unit vector: `fx = Math.sin(yawRad)`, `fz = -Math.cos(yawRad)`.
  - Pitch `pitchDeg`: positive = nose UP (`+Y`), negative = nose DOWN (`-Y`).
  - Roll `rollDeg`: positive = bank RIGHT (right wing down -> turns right / increases `yawDeg`), negative = bank LEFT (left wing down -> turns left / decreases `yawDeg`).
- `WATER_LEVEL = 12.0` m MSL.
- Grid mapping for `gridSize` (`128` solo / `160` megabasin) and `cellSize` (`16` solo / `20` megabasin):
  - `worldSize = gridSize * cellSize`, `halfWorld = worldSize / 2`.
  - `cellIdx = gz * gridSize + gx` (`0 <= gx, gz < gridSize`).
  - `worldToGrid(x, z) -> { gx, gz, idx }` (`idx = -1` if out of bounds).
  - `gridToWorld(gx, gz) -> { x, z }` (cell center).

## 2. Config Exports (`src/config/`)
- `src/config/operations.js`:
  - `export const WATER_LEVEL = 12.0;`
  - `export const OPERATIONS = [ op01, op02, op03, op04, op05 ];`
  - `export const MEGA_BASIN_OP = { ... };`
  - `export function getOperationById(id) -> opConfig`
  - Each `opConfig` has: `{ id, index, total, name, subtitle, mode: 'solo'|'megabasin', seed, gridSize, cellSize, windDirDeg, windSpeedKt, windGustKt, cabinCount, towerCount, layoutType }`
- `src/config/liveries.js`:
  - `export const LIVERIES = [ ...16 items ];`
  - Item shape: `{ id: 0..15, name, primary, shaded, accent, stripe, pontoon, hudColor }` (index 0 = EF-07 `#f8ce64`/`#d08a2e`/`#e0542d`/`#f2f2f2`/`#8a929a`/`#f8ce64`).

## 3. Simulation Exports (`src/sim/`)
- `src/sim/TerrainGen.js`:
  - `export function generateTerrain(opConfig) -> TerrainData`
  - `TerrainData`:
    - `opConfig`, `gridSize`, `cellSize`, `worldSize`, `halfWorld`, `waterLevel` (`12.0`)
    - `heights`: `Float32Array((gridSize + 1) * (gridSize + 1))` (vertex heightmap)
    - `cellHeights`: `Float32Array(gridSize * gridSize)` (cell center height)
    - `waterMask`: `Uint8Array(gridSize * gridSize)` (`1` = lake/river scoopable water, `0` = land)
    - `fuelMask`: `Uint8Array(gridSize * gridSize)` (`1` = flammable forest/grass, `0` = water/rock/meadow-road/bare peak)
    - `biomeMask`: `Uint8Array(gridSize * gridSize)` (`0`=water, `1`=shore, `2`=meadow, `3`=forest, `4`=ridge, `5`=peak)
    - `scoopZones`: `Array<{ x, z, headingDeg, length, width, name }>`
    - `settlements`: `Array<{ name, x, z, cabins: Array<{ id, x, z, y, yawRad }> }>`
    - `cabins`: `Array<{ id, settlementIdx, x, z, y, yawRad }>` (flat list indexed `0..N-1`)
    - `towers`: `Array<{ id, x, z, y }>`
    - `trees`: `Array<{ x, z, y, cellIdx, scale, tint }>`
    - `initialFireSeeds`: `Array<{ gx, gz, radius }>`
    - `getHeight(x, z) -> number` (bilinear interpolation)
    - `isWater(x, z) -> boolean`
    - `worldToGrid(x, z) -> { gx, gz, idx }`
    - `gridToWorld(gx, gz) -> { x, z }`
- `src/sim/FlightModel.js`:
  - `export const FLIGHT_CONSTANTS = { CRUISE_SPEED_KMH: 158, MIN_SPEED_KMH: 115, MAX_SPEED_KMH: 210, THROTTLE_MIN_KMH: 125, THROTTLE_MAX_KMH: 195, SCOOP_ENTER_AGL: 5.0, SCOOP_EXIT_AGL: 6.5, SCOOP_RATE: 52.0, SCOOP_DRAG: 3.5, DROP_RATE: 80.0, DROP_GRAVITY: 15.5, WIND_DRIFT_FACTOR: 0.35 };`
  - `export function createAircraftState(opts = {}) -> AircraftState`
    - `{ x, y, z, yawDeg, pitchDeg, rollDeg, speedKmh, throttle, tankPct, agl, vx, vy, vz, scooping, releasing, dropBurstTimer, stallWarn, bounceTimer, outOfBounds, autopilot, callsign, slotId, colorIdx }`
  - `export function stepFlight(state, input, terrain, dt, options = {}) -> { events: { bounced, scoopStarted, scoopEnded, tankFull, dropStarted, dropEnded } }`
    - `input`: `{ pitch: -1..1 (+1 nose up, -1 nose down), roll: -1..1 (+1 right, -1 left), throttleDelta: -1..1, drop: boolean, dropJustPressed: boolean }`
    - `options`: `{ externalTankSync?: boolean }` (when MP replica, still allows local predictive VFX/tank smoothing while Host overrides authoritative tank)
  - `export function predictDropImpact(state, windVx, windVz, terrain) -> { x, z, y, tFall, radius }`
- `src/sim/Autopilot.js`:
  - `export class Autopilot { constructor(terrain); reset(); update(aircraft, fireSnapshot, dt) -> input }`
    - `fireSnapshot`: `{ fireHead: {x,z}|null, atRiskCabin: {x,z}|null, windVx, windVz }`
    - Returns `{ pitch, roll, throttleDelta, drop, dropJustPressed, phase }`.
- `src/sim/FireSim.js`:
  - `export class FireSim`
    - `constructor(terrain, { isMegaBasin = false } = {})`
    - `reset(wave = 1)`
    - `spawnWaterParcel(slotId, x, y, z, vx, vy, vz, releaseAgl)`
    - `step(dt, activeManualPilots = 1) -> StepDelta`
      - `StepDelta`: `{ changedCells: Array<{ idx, state, phase }>, cabinChanges: Array<{ id, hp }>, scoreEvents: Array<{ slotId, pts, kind: 'cell'|'assist'|'cabin', x, z }>, impactEvents: Array<{ x, y, z, extinguished: boolean }>, missionScore, burningPct, burningCount, emberCount, cabinsAlive, cabinsTotal, windDirDeg, windSpeedKt, windVx, windVz, status: 'active'|'victory'|'defeat'|'intermission', intermissionTimer, wave }`
    - `getSnapshot() -> { cells: Uint8Array, phases: Uint8Array, cabinHp: Uint8Array, cabinAtRisk: Uint8Array, windDirDeg, windSpeedKt, windVx, windVz, missionScore, burningPct, burningCount, cabinsAlive, cabinsTotal, wave, status, intermissionTimer, fireHead: {x,z}|null, atRiskTarget: {x,z,name}|null, settlementTarget: {x,z,name}|null, hotClusters: Array<{x,z,y,intensity}> }`
    - `applyExternalKey(keyState)` (for MP replicas hydrating from `fireKey`)
    - `applyExternalDelta(delta)` (for MP replicas applying `fireRing` deltas)
    - `encodeFullState() -> object` / `getSlotScores() -> Map<slotId, score>`
- `src/sim/BackgroundWorker.js`:
  - `export function createBackgroundTicker(intervalMs, onTick) -> { start(), stop(), isHidden() }` (Blob Web Worker fallback-safe in Node/browser).

## 4. Renderer Exports (`src/render/`)
- `src/render/SceneRenderer.js`:
  - `export class SceneRenderer`
    - `constructor(canvas, terrain)`
    - `rebuildWorld(terrain)` (when switching Operations or Solo <-> Mega-Basin)
    - `syncFireGrid(cells, phases, dirtyIndices, cabinHp, cabinAtRisk)` (updates terrain scorch/wet colors, charred pines, cabin ruins, flames/smoke/embers)
    - `spawnDropVisual(x, y, z, vx, vy, vz, windVx, windVz)` (billowing water puffs)
    - `spawnImpactSteam(x, y, z, extinguished)`
    - `update({ dt, elapsed, localAircraft, remotePlanes, fireSnapshot, showDropReticle, dropPreview, cameraShake })`
      - `remotePlanes`: `Array<{ slotId, x, y, z, yawDeg, pitchDeg, rollDeg, speedKmh, tankPct, releasing, scooping, colorIdx, callsign }>`
    - `projectToScreen(worldPos) -> { x, y, visible, behind }` (normalized `0..1` screen coordinates for `WorldCallouts`)
    - `getCamera() -> THREE.PerspectiveCamera`
    - `getStats() -> { drawCalls, triangles, renderWidth, renderHeight, remoteCount }`
    - `resize()`
    - `dispose()`

## 5. Audio & UI Exports (`src/audio/`, `src/ui/`)
- `src/audio/AudioEngine.js`:
  - `export class AudioEngine`
    - `constructor()`
    - `unlock()` (safe to call on any keydown/pointerdown)
    - `setMuted(muted)` / `isMuted() -> boolean` / `toggleMute() -> boolean`
    - `update({ dt, airspeedKmh, throttle, windSpeedKt, scooping, releasing, nearestFireDist, bounced })`
    - `playScoreChime(comboIndex = 0)`
    - `playCabinSavedChord()`
    - `playTankFullPing()`
    - `playAlertPing(urgent = false)`
    - `dispose()`
- `src/ui/HudController.js`:
  - `export class HudController`
    - `constructor({ onToggleAudio, onOpenDrawer, onSelectOperation, onSwitchMode, onSettingChange, onNextOperation, onReplay, onResumeLive })`
    - `update({ aircraft, fireSnapshot, opConfig, netState, scoreEvents, terrain, projectFn, remotePlanes, settings })`
      - `netState`: `{ mode: 'solo'|'mp'|'loopback', status: 'solo'|'live'|'host'|'syncing'|'offline', pilotsCount, pilotsCap, localSlotId, personalScore, top10: Array<{slotId, name, score, colorIdx}>, queueBanner: string|null, idleCountdown: number|null, offlineFallback: boolean }`
    - `showOverlay(type, data)` (`'victory'|'defeat'|'intermission'|'offline'|null`)
    - `toggleDrawer(force?)` / `isDrawerOpen() -> boolean`
    - `setAudioMuted(muted)`
    - `dispose()`

## 6. Netcode Exports (`src/net/`)
- `src/net/WorldSession.js`:
  - `export class WorldSession`
    - `constructor({ adapter, terrain, fireSim, opConfig, worldId, buildHash, callsign, colorIdx, onStatusChange, onScoreEvents, onMetaUpdate })`
    - `async start()` (joins in zero-write `DEMO FLIGHT` spectator mode, fetches `fireKey`, watches `planes`/`fireRing`/`meta`/`authority`)
    - `async requestManualControl()` (claims vacant slot `0..99` or creates world if empty; returns `{ seated: boolean, slotId, spawnPose, queued: boolean }`)
    - `async returnToDemoFlight()` (cleanly vacates slot/presence/in)
    - `sendLocalState(aircraft, dropSeq)` (rate-limited 4 Hz to `in/{uid}` while seated)
    - `updateProfile(callsign, colorIdx)`
    - `step(dt, renderTimeMs) -> { remotePlanes, localAuthTank, isHost, netState }`
    - `async stop()`
- `src/net/LoopbackBots.js`:
  - `export function createLoopbackSession({ botCount, terrain, fireSim, opConfig, callsign, colorIdx, onStatusChange, onScoreEvents }) -> { session, adapter, stop }`
    - Runs `MockRtdbAdapter` in-browser with `botCount` (default 99) real `Autopilot` + `FlightModel` bot clients writing `in/$uid` and the local client acting as Host or Replica through real `protocol.js` + `StreamClient` + `PlaneInterpolator`!
