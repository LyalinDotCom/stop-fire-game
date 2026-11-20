# EMBER FRONT — Aerial Fire Response Unit (`v0.5.0`)

Stylized retro-3D arcade aerial firefighting game built with Three.js, Vite, Web Audio + VHF radio comms, and zero-login 100-player Firebase Realtime Database (RTDB) multiplayer.

## Play Online

- **Launch & Live Lobbies (Solo / Host / Join):** https://ember-front-rtdb.web.app
- **Direct Solo Mode (`0` Firebase sockets):** https://ember-front-rtdb.web.app/?mode=solo
- **Direct Lobby Invite Link:** `https://ember-front-rtdb.web.app/?lobby=megabasin-01`
- **Offline 100-Plane Loopback Stress Test:** https://ember-front-rtdb.web.app/?loopback=100

Clicking **FLY SOLO** (or launching with `?mode=solo`) tears down Firebase connections so Solo gameplay holds zero network sockets. Clicking **HOST LOBBY** claims a fresh Operation 01 room with a 1-click invite link and up to 100 concurrent pilots.

## Release Versioning

Every production release bumps semantic `"version"` in `package.json` (injected at build time via `__APP_VERSION__` into the Launch Overlay badge, Settings Drawer footer, and `window.__EMBER_FRONT__.version`), deploys to Firebase Hosting (`ember-front-rtdb.web.app`), and pushes a matching annotated/lightweight `vX.Y.Z` tag on `main`.

## Controls

| Input | Action |
| :--- | :--- |
| `W` / `S` | Pitch nose down / up (Invert-Y toggle in `[?]`) |
| `A` / `D` | Bank left / right |
| `Q` / `E` | Throttle down / up (`125–195 km/h`) |
| `SPACE` | Drop water (`80%/s` hold; brief tap triggers `0.25 s` burst) |
| `M` | Mute / unmute procedural Web Audio |
| `H` or `?` | Toggle Help, Squadron & Settings drawer |

Skim lakes or rivers at `<= 5 m AGL` to scoop water (`~1.9 s` empty-to-full), climb out over advancing wildfires, and drop ballistic water curtains onto fire heads to save timber cabin settlements. Pressing any flight key exits `DEMO FLIGHT` autopilot into manual control.

## Local Development

Requires Node.js 20+.

```bash
# Install dependencies
npm install

# Start local dev server (http://localhost:5180)
npm run dev

# Verify Firebase RTDB rules match tools/net/rules.mjs
npm run net:rules:check

# Run offline deterministic simulation & 100-player netcode unit tests
npm test

# Build static production bundle into dist/
npm run build

# Preview production build locally (http://localhost:4180)
npm run preview
```

## Architecture & Documentation

- [Game Design & 100-Player RTDB Specification](docs/gamespec.md)
- [Shared Module Interfaces & Data Contracts](docs/INTERFACES.md)
- [Firebase RTDB Rules & Testing Playbook](docs/firebase-handoff.md)
- [Build Log & Architecture Record](docs/BUILD_LOG.md)
