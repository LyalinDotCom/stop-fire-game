# EMBER FRONT — Aerial Fire Response Unit
## Game Design & 100-Player Zero-Login Firebase RTDB Engineering Specification

> **Document Purpose:** Implementation-ready game design, visual/audio direction, static web architecture, and 100-player zero-login Firebase Realtime Database (RTDB) engineering specification for **EMBER FRONT — Aerial Fire Response Unit**.  
> **Reference Inputs:**
> - Reference gameplay footage: `-htdOO-4AFBbeZUV.mp4` (`1920×1080`, `60 fps`, `30.00 s`, stereo procedural audio)
> - Reference RTDB multiplayer architecture: zero-login Firebase RTDB protocol v4 pattern

---

## 1. Executive Summary & Design Pillars

**EMBER FRONT — Aerial Fire Response Unit** is a stylized 3D arcade aerial firefighting game set in twilight alpine wilderness basins. Players pilot a nimble, twin-pontoon amphibious single-engine water-bomber (`EF-07` in solo; `EF-00` through `EF-99` in multiplayer), skimming mountain lakes at `≤ 5 m AGL` to scoop water, climbing out over wind-driven wildfires, and releasing ballistic water curtains onto advancing fire heads before flames consume timber cabin settlements.

1. **Faithful Solo Arcade Core:** Recreates the exact visual aesthetic (`640×360` pixelated low-poly 3D upscaled nearest-neighbor under a razor-sharp native-resolution tactical HUD, ordered Bayer 4×4 dithered smoke plumes, dynamic orange fire lighting, procedural Web Audio synthesis) and exact flight/scoop/drop cadence, expanded into a complete 5-operation solo campaign (`Operations 01–05`).
2. **Instant Zero-Login 100-Player Shared-Basin Multiplayer:** Extends the core game into a massive cooperative **Mega-Basin** where up to **100 concurrent pilots** fly and extinguish fires together in the same shared play area with **zero account creation, zero login screens, and zero custom backend servers**, hosted purely as a static web app backed by **Firebase Realtime Database (RTDB)**.
3. **Pure Static Web Hosting & Zero-Asset Footprint:** Every 3D mesh, terrain heightmap, dither shader, HUD component, and Web Audio sound effect is generated procedurally in code. The built `dist/` bundle deploys to Firebase Hosting, Cloudflare Pages, Netlify, or GitHub Pages with zero custom servers; solo play never downloads or connects to Firebase.

### Explicitly Excluded External Video Artifacts & Reference Bug Fixes
1. **EXCLUDED:** Top-right `@loktar00` avatar/handle watermark and bottom-left `GPT-6.2 Astra · DeepSeek Harness · 62k tokens` overlay. **Must NOT be implemented.**
2. **FIXED:** Reference clip skybox vertical UV seam (~185–191° S) eliminated via a seamless procedural 3D `normalize(vWorldDir)` spherical sky shader.

---

## 2. Core Gameplay Loop, Controls & Arcade Flight Model

### Verified Reference Metrics
- **Cruise / Operating Airspeed:** `CRUISE_SPEED_KMH = 158`, manual throttle band `125–195 km/h` (dive max `210 km/h`, stall floor `115 km/h`).
- **Operating Altitude Band:** `MIN_DROP_AGL = 12 m`, ideal drop `35–55 m AGL`, soft ceiling `220 m AGL` (progressive pitch-down trim above `195 m AGL`).
- **Scoop Activation Height:** `SCOOP_ENTER_AGL = 5.0 m`, `SCOOP_EXIT_AGL = 6.5 m` (host validates `≤ 6.0 m`).
- **Scoop Refill Rate:** `SCOOP_RATE_PCT_PER_SEC = 52.0` (`~1.92 s` empty-to-full).
- **Scoop Hydrodynamic Drag:** `SCOOP_DRAG_DECEL_KMH_S = 3.5` (bleeds `~6–7 km/h` over 2 s skim).
- **Water Drop Drain Rate:** `DROP_RATE_PCT_PER_SEC = 80.0` (`1.25 s` full dump).
- **Ballistic Water Fall Delay:** `g_drop = 15.5 m/s²` (`t = sqrt(2 * 47 / 15.5) ≈ 2.46 s`) + wind drift `a_wind = 0.35 * W`.
- **Extinguish Score Cadence:** `SCORE_CELL_PRIMARY = 70`, `SCORE_CELL_ASSIST = 35`, `SCORE_CABIN_SAVED = 500`.

### Controls & Input Accessibility
- `W` / `S`: Pitch nose down / pitch nose up (toggleable Invert-Y in `[?]` drawer).
- `A` / `D`: Bank left / bank right (coordinated roll-to-turn; releasing auto-levels wings toward `0°`).
- `Q` / `E`: Throttle decrease / throttle increase (`125–195 km/h`).
- `SPACE`: Drop water (hold to release at `80%/s`; brief tap triggers min `0.25 s` / `20%` tactical burst).
- Any flight key (`W`, `A`, `S`, `D`, `Q`, `E`, `SPACE`): Immediately exits `DEMO FLIGHT` and grants manual control (and claims a slot in MP).
- `M`: Mute/unmute audio.
- `H` or `?`: Toggle Help / Controls / Squadron & Settings drawer.
- Optional: Gamepad API (left stick bank/pitch, LT/RT throttle, A/RB drop), opt-in Mouse-Yoke mode inside `[?]`.

### Arcade Flight Physics (Fixed 60 Hz, `dt = 1/60`)
- Roll $\phi \in [-55^\circ, +55^\circ]$: accelerates at `140°/s`, self-centers at `65°/s`.
- Pitch $\theta \in [-35^\circ, +35^\circ]$: responds at `85°/s`, damps toward `0°` at `18°/s`.
- Heading rate: $\dot{\psi} = \text{clamp}((14.5 \cdot \tan(\phi)) / v, -1.15, +1.15)$ rad/s (`v` in m/s).
- Speed: $v_{\text{target}} = 125 + 70 T$ km/h; dive/climb energy exchange `-42 * sin(theta)` km/h/s; scoop drag `-3.5` km/h/s; relax toward `v_target` with `tau = 2.2 s`; clamp `[115, 210]` km/h.
- Stall guard (`< 120 km/h`): soft nose-down assist `-12°/s` until `> 128 km/h`.
- Basin perimeter fence: banked auto-turnback (`RETURNING TO BASIN`) guiding inward.
- Water surface protection (`y - waterLevel <= 3.5 m`): pontoon hydroplane cushion levels pitch `>= +2°`, floor `>= 3.5 m AGL`.
- Terrain deflect bounce (`y - terrainHeight <= 5.0 m`): pitches nose up `+15°`, `0.4 s` shake + scrape sound, sheds `15%` airspeed, lifts clear (never instant death).
- Optional manual drop-lead reticle: disabled in `DEMO FLIGHT`, default ON in manual mode (toggleable in `[?]`).

### DEMO FLIGHT Autopilot State Machine
1. `APPROACH_FIRE`: Steers toward highest-priority `CABIN AT RISK` or `FIRE HEAD` centroid at `47 m AGL`, `162 km/h`, wind+ballistic lead compensated.
2. `RELEASE`: When projected impact crosses active fire cells, drops until `tank == 0%` (`~1.25 s`), badge `RELEASING`.
3. `TURN_TO_LAKE`: Sweeping counter-clockwise left bank (`-38°` roll) toward nearest scoop lane entry aligned with lake axis.
4. `DESCEND_AND_SCOOP`: Descends smoothly to `4.5 m AGL` along lake axis (`SCOOP ACTIVE`) until `tank == 100%` (`~1.95 s`).
5. `CLIMB_OUT`: Pitches to `+12°`, climbs to `50 m AGL`, loops back to `APPROACH_FIRE`.

### 100-Plane Aerial Ergonomics
- 100% pass-through aircraft ghosting (no mid-air collisions).
- Camera proximity alpha-fade `< 15 m` (`1.0` at `15 m` down to `0.12` at `<= 4 m`).
- Staggered basin-perimeter entry spawns (`radius = 0.82 * halfWorld`, altitudes `60–110 m AGL` by `slotId % 5`, inward heading, `100%` tank).
- Wide multi-lane scoop zones in Mega-Basin.

---

## 3. World Design, Fire Simulation & Campaign / Mega-Basin Modes

### Solo Campaign (`Operations 01–05`, `128×128` grid @ `16 m` = `2,048×2,048 m`)
1. `01 / 05` **Cinderpine Basin**: Long N–S alpine lake on west, burning pine slope on east shore + southern pocket, tan meadow clearing on E-NE with **10 timber cabins + 1 stilted water tower**, mountain ring. Subtitle: `Scoop the lake. Drop on the fire head.` `~8%` burning, Wind `E 12 KT -> ENE 14 KT`.
2. `02 / 05` **Redridge Narrows**: Twin crescent lakes split by central pine peninsula; two opposing fire fronts converging on **12 cabins** + 1 water tower. `~10%` burning, Wind `NE 16 KT -> E 18 KT`.
3. `03 / 05` **Ashen Caldera**: Circular crater lake in center, steep concentric forested ridges, 3 radial settlements (**15 cabins** + 1 water tower). `~11%` burning, Wind `SW -> NW 18–22 KT`.
4. `04 / 05` **Timberline Gorge**: Winding S-curve alpine river flanking canyon valley with **14 cabins** + 1 water tower on terraced plateaus. `~12%` burning, Wind `ESE 22 KT` + spot fires.
5. `05 / 05` **Ember Crown Peak**: Highland basin with western glacial lake, dual ridgeline mega-fronts, **18 cabins** + 2 water towers across upper/lower stations. `~14%` burning, Wind `20–26 KT` gusts.
- Victory: `burningCells === 0` & zero ember warnings (`state === 15`). Star rating: 3★ 100% cabins, 2★ >=80%, 1★ >=50%.
- Defeat: `cabinsAlive === 0`.

### Mega-Basin Mode (`1–100` Pilots, `160×160` grid @ `20 m` = `3,200×3,200 m`)
- 3 wide scoop bodies: West Glacial Lake (`950 m` N–S), Central River Channel (`850 m` NW–SE), South Mirror Tarn (`700 m` E–W).
- 4 settlements (`44` cabins + `4` stilted water towers): North Pinewatch (12), East Cinderpoint (12), South Millcreek (10), Central Ridgepost (10).
- Rolling endless waves: `15 s` Celebration Intermission (`BASIN CONTAINED`, `+1,000` bonus, restore cabins, rotate wind, next wave) or `15 s` Reset Intermission (`BASIN OVERRUN — REGROUPING`).
- Dynamic pilot scaling: $S(N_a) = 1.0 + 0.55 \cdot \ln(1 + N_a)$, active fronts `min(6, 1 + floor(sqrt(N_a) / 2))`, ember spotting `0.02 * S(N_a)` /s when wind >= 14 KT.

### Cellular Fire Simulation (`src/sim/FireSim.js`, 10 Hz `dt_sim = 0.1 s`)
- 4-bit cell state `Uint8Array`:
  - `0`: Intact fuel (`fuelMask[i] === 0` for water/rock/road)
  - `1..12`: Active fire intensity (ramps `+0.8/s` while fuel remains; `~120–180 s` burn duration -> `14`)
  - `13`: Wet / Steam Cooldown (`15–20 s` immunity to re-ignition; returns to `0` if fuel remains else `14`)
  - `14`: Charred / Burned Out
  - `15`: Ember-Spot Warning (`4.0 s` flicker before igniting to `3`; hitting with water -> `13` for `+70`)
- 8-way Moore spread with wind alignment `1 + 1.8 * max(0, d_hat . W_hat) * (|W|/14)` and uphill boost `1 + 1.2 * max(0, slope)`.
- Ballistic water parcel every `100 ms` while releasing: `p(t) = p0 + v0*t + 0.5*(g_drop + 0.35*W)*t^2`, `g_drop = -15.5 m/s^2`.
- Altitude-dependent splash: `R = clamp(14 + 0.22 * h_rel, 16, 42) m`, knockdown `K = K0 * (24 / R)^1.35`.
- Conflict-free `Float32Array` `wetDelta` accumulation + 3.0 s per-slot attribution ring.
- Cabins: `hp` `0..100`; `CABIN AT RISK` if any active fire within `48 m`; damage `0.9 * (intensity / 12) HP/s` per fire cell within `24 m`.
- Scoring: `+70` primary sprayer, `+35` co-bomber assist (`>= 15%` share), `+500` Cabin Saved (`>= 3 s` threatened -> safe, `30 s` cooldown).

---

## 4. Visual Direction, Rendering Pipeline & Asset Inventory

- **Dual-Layer Hybrid Renderer:**
  - Layer 1: Three.js `WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })`, `setPixelRatio(1)`, height locked to `360` (`width = round(360 * aspect)`, `640×360` at 16:9), `SRGBColorSpace`, CSS `image-rendering: pixelated; image-rendering: crisp-edges;`.
  - Layer 2: Native-resolution HTML/CSS + 2D Canvas HUD (`fixed; inset: 0`).
- **Shading & Shaders:**
  - Flat-shaded vertex-colored low-poly (`MeshLambertMaterial({ flatShading: true, vertexColors: true })`).
  - Branchless ordered Bayer 4×4 screen-door dither shader for smoke plumes (`#6d6b77`/`#626270` + `#ff6f00` under-light).
  - Warm sunset `DirectionalLight` (`#ffbe8a`, `0.9`) + `HemisphereLight` (`#5c5270` / `#2b3d38`, `0.65`) + **6 dynamic flickering `PointLight`s** (`#ff6f00`, decay `2`, distance `140–220 m`, `±14%` flicker) tracking hottest nearby fire centroids.
  - Linear `THREE.Fog('#7f6585', 450, 2400)`.
  - Seamless procedural 3D `normalize(vWorldDir)` twilight sky dome: `#e59462` (horizon) -> `#6e5053` (mid `0.25`) -> `#2c2d42` (zenith `>= 0.65`), 1-px hashed stars above `dir.y > 0.12`, hard-edged cream-yellow moon (`#ffdd99`, `~1.8°`) at NNE (`az 22°`, `el 18°`).
  - Lake shader: flat `#23505f` with scrolling horizontal `#9ecad0` shimmer dashes.
- **Verified Hex Palette:**
  - Sky: `#2c2d42`, `#6e5053`, `#e59462`; Moon `#ffdd99`, Stars `#f0ece4`
  - Peaks: `#9c788e`, `#7f6585`; Ridges: `#78637f` -> `#435451`
  - Water: `#23505f`, Shimmer `#9ecad0`
  - Terrain: `#3f5e4a` (forest), `#94815a` (meadow/shore), `#2b2421` (charred)
  - Pines: `#4d684f`, `#2b433d`, `#262324` (charred)
  - Hero Plane (`EF-07`): `#f8ce64`, `#d08a2e`, `#e0542d`, `#f2f2f2`, `#222222`, `#8a929a`
  - Cabins/Tower: `#6d4c38`, `#807e88`, `#ffd978` (windows)
  - Flames/Embers: `#fff275`, `#ff6f00`, `#e0542d`, `#ffb84d`
  - Smoke/Water/Steam: `#6d6b77`, `#626270`, `#d7cab3`, `#d8e6e6`
  - HUD: `#0f191f` (bars), `#1b1d21` @ 85% (cards), `#f37233`/`#fb9564` (orange), `#c5d4ba` (mint dot), `#5ce1e6` (cyan)
- **Camera Rig:** `18 m` behind, `6.5 m` above tail, `FOV 52°`, looking `12 m` ahead of nose, `28%` damped roll lag, subtle impulse shake during drop/fire-flyover/scoop/deflect.
- **VFX Catalog (inside 640×360 pass):** Instanced canopy flames, 1-px rising downwind embers (`THREE.Points`), Bayer-dithered billowing smoke puffs, ballistic water drop curtain puffs, impact steam bursts, twin pontoon foam wakes, lake shimmer dashes.
- **Optimization Budget:** `< 25` draw calls total, locked `60 FPS`, hero plane dedicated mesh + up to 99 remote planes in 1 `InstancedMesh` (plus prop blur) across 16 liveries with `< 15 m` camera proximity alpha-fade.

---

## 5. Procedural Web Audio Specification (`src/audio/AudioEngine.js`)

100% Web Audio API procedural synthesis (zero external audio files, no music, no voice):
- Master `DynamicsCompressorNode` -> master `GainNode` (40 ms ramp) -> `destination`.
- Shared 2 s white/pink noise buffers.
1. **Ambient Wind Bed:** Looping bandpass noise (`420–780 Hz`, `Q = 1.4`, `-28 dB`), scales with airspeed & wind knots.
2. **Engine / Propeller Drone:** Dual detuned oscillators (`sawtooth` `68–92 Hz` + `square` `136–184 Hz` -> lowpass `260 Hz`) + filtered prop wash, subtle `±12%` RPM modulation from throttle/airspeed and `-4%` dip during scoop drag.
3. **Proximity Wildfire Roar:** Brown/pink noise -> lowpass `380 Hz` + LFO crackle AM (`12–30 Hz`), fades in within `280 m` of nearest fire cluster.
4. **Water Drop Whoosh:** Sweeping bandpass noise (`1400 -> 320 Hz` over `1.25 s`, `Q = 1.8`) while releasing.
5. **Rising Score Chimes:** Polyphonic pure sine oscillators (`80 ms` decay, `4 ms` attack) stepping up pentatonic scale (`880, 988, 1175, 1319, 1568 Hz`) on `+70` hits + warm fifth chord (`659 + 988 Hz`) on `+500` Cabin Saved.
6. **Lake Scoop Skim Burst:** Bandpass (`950 Hz`, `Q = 0.9`) + highpass (`1800 Hz`) white-noise wash while `SCOOP ACTIVE`, soft `1046 Hz` ping at `100%` tank.
7. **UI & Alert Pings:** Short pure sine blips (`740 / 1100 Hz`, `55 ms`) on `CABIN AT RISK`, takeover, `AUDIO ON`.
- Unlocks cleanly on first `keydown`/`pointerdown`; mute persisted in `localStorage` (`emberfront.audioMuted`).

---

## 6. UI / HUD & Onboarding Specification

Native-resolution overlay (`tabular-nums`):
1. **Top Header Bar (`44 px`, `#0f191f`):** Chamfered `#f37233` aircraft icon badge + `EMBER` `FRONT` | `AERIAL FIRE / RESPONSE UNIT`; right: status dot + `LIVE SIMULATION` (or MP status + `PILOTS X/100` pill) | `AUDIO ON/OFF` button | `[?]` drawer button.
2. **Operation Briefing Card (top-left, `3 px` `#f37233` left bar):** 3 orange dots + `OPERATION 01 / 05` (or `MEGA-BASIN · WAVE 01`), title, subtitle, divider, `cabins` & `% burning` live stats.
3. **Top-Center Compass Ribbon:** Scrolling tick tape (`±60°`), ticks every `15°`, cardinals, `#f37233` center index triangle, boxed 3-digit heading (`000°..359°`).
4. **Wind Vector Card (top-right):** Aircraft-relative rotating cyan arrow (`windHeadingDeg - planeHeadingDeg`, UP = tailwind), `WIND VECTOR`, cardinal + KT readout.
5. **Flight Telemetry Card (bottom-left):** `FLIGHT TELEMETRY` | badge (`EF-07` / `EF-00..99` / `RELEASING` / `SCOOP ACTIVE`), `AIRSPEED` (`KM/H`) | `ALTITUDE` (`000 M AGL`), `WATER TANK` `%` + 20-segment discrete block bar.
6. **Demo Flight Banner (bottom-center):** `[#f37233 dot] DEMO FLIGHT` pill + `Press any key to take control` (also hosts MP queue/idle banners).
7. **Tactical Map (bottom-right, `240×150 px` 2D Canvas):** Fixed North-Up (`↑ N`), `8×5` grid, teal lakes, live fire bitmap, cabin squares (pulsing red when at risk, dim gray destroyed), local white outlined arrow + MP density capping (`20` nearest chevrons + `2×2` dots), legend `WATER / FIRE / CABIN`.
8. **Bottom Strip (`32 px`, `#0f191f`):** `[W][S] Pitch [A][D] Bank [Q][E] Throttle [SPACE] Drop water` | `MISSION SCORE 000000` (+ MP `YOU 000000` & floating hit micro-toasts).
9. **3D-Projected Floating World Callout Pins:** `≈ SCOOP ZONE`, `◇ FIRE HEAD`, `△ SETTLEMENT` -> `△ CABIN AT RISK`.
10. **`[?]` Drawer:** Mode switch (Solo Campaign Ops 01–05 vs Shared Mega-Basin 100P vs Loopback 100-Bot Demo), callsign input (ASCII regex + `textContent`), 16-swatch livery picker, Invert-Y, Drop-Lead Reticle toggle, Mouse-Yoke toggle, Controls reference, Squadron Top-10 Leaderboard.

---

## 7 & 8. Static Stack & 100-Player Zero-Login Firebase RTDB Architecture

- Vanilla ES modules, `three ^0.170.0`, `firebase ^11` (lazy dynamic `import()` ONLY for MP), `vite ^6.4.5` (`base: './'`, `__BUILD_HASH__`).
- Strict `RtdbAdapter` abstraction (`LiveRtdbAdapter` + in-memory `MockRtdbAdapter` enforcing every rule in `database.rules.json`) + `?loopback=100` / `?bots=100` offline 100-plane browser mode.
- RTDB schema (`worldsIndex/{megabasin-01..20}` + `worlds/{w}/{config, authority, slots/{0..99}, uidToSlot/{uid}, roster/{0..99}, presence/{uid}, in/{uid}, planes, fireRing/{0..15}, fireKey, meta}`).
- Binary wire formats:
  - `in/{uid}` (`4 Hz`, `<= 72 chars`): `"[x,y,z,yaw,pitch,roll,spd,fl,dropSeq]"`
  - `planes` (`3.33–4 Hz`, `12 B/plane`, `<= 1650 B64`): `[slotId:u8, x:i16LE, z:i16LE, y:u16LE, yaw10+pitch7+roll7:24b, spd6+tank5+flags5:16b]`
  - `fireRing/{0..15}` (`2 Hz`, `<= 2048` JSON): `{"w":[dirByte,ktByte],"f":"<B64 3B/cell>","c":[[id,hp]],"h":[[slotId,pts]],"ms":score}`
  - `fireKey` (`5 s`, one-shot `get()` only, `<= 12288`): 4-bit nibble RLE of all cells + cabin HPs + wind + wave + score + per-slot scores.
- Elected Authority Host (`2.5 s` lease renew `now+8s`, voluntary abdication on `pagehide`/hidden `>3s`, tiered backoff takeover, zero-reset `get(fireKey)` + `fireRing` resume, `BackgroundWorker` 10 Hz tick).
- Idle reclamation (`90 s` warn, `120 s` vacate slot -> `DEMO FLIGHT`, `300 s` `goOffline()`).
- Interpolation: Adaptive `Playback` delay (`150–280 ms`) + Fritsch-Carlson monotone cubic Hermite + bank-curved dead-reckoning (`<= 250 ms` cap).
