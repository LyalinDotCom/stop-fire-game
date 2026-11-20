# EMBER FRONT — Aerial Fire Response Unit

Stylized retro-3D arcade aerial firefighting game built with Three.js, Vite, procedural Web Audio synthesis, and zero-login 100-player Firebase Realtime Database (RTDB) multiplayer. Every 3D mesh, terrain heightmap, GLSL shader, HUD element, and sound effect is generated procedurally in code with zero external media assets.

## Play Online

- **Solo Campaign (Operations 01–05):** https://ember-front-rtdb.web.app
- **100-Player Shared Mega-Basin:** https://ember-front-rtdb.web.app/?mode=mp
- **Offline 100-Plane Loopback Mode:** https://ember-front-rtdb.web.app/?loopback=100

Solo mode downloads zero Firebase bytes and opens zero network connections; multiplayer modules and Firebase SDK chunks are lazy-loaded only when entering Shared Mega-Basin or `?loopback=100`.

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
