/**
 * EMBER FRONT — Deterministic Seeded Terrain Generator
 * Generates all 5 Solo Operations (128x128 @ 16m) and Cascadia Mega-Basin (160x160 @ 20m).
 * Pure simulation module — zero DOM / Three.js dependencies.
 */

export const WATER_LEVEL = 12.0;

// Biome enum matching docs/INTERFACES.md
export const BIOME = {
  WATER: 0,
  SHORE: 1,
  MEADOW: 2,
  FOREST: 3,
  RIDGE: 4,
  PEAK: 5,
};

/**
 * Deterministic Mulberry32 PRNG.
 * @param {number} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  let a = (seed >>> 0) || 0x6d2b79f5;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2D(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed | 0, 1442695041);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hash2D(ix, iz, seed);
  const b = hash2D(ix + 1, iz, seed);
  const c = hash2D(ix, iz + 1, seed);
  const d = hash2D(ix + 1, iz + 1, seed);

  const ab = a + (b - a) * ux;
  const cd = c + (d - c) * ux;
  return ab + (cd - ab) * uz;
}

function fbm2D(x, z, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise2D(x * freq, z * freq, seed + i * 1013) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function ridgedNoise2D(x, z, seed, octaves = 3) {
  let sum = 0;
  let amp = 0.55;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1.0 - Math.abs(valueNoise2D(x * freq, z * freq, seed + i * 2029) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

/**
 * Signed distance to a line segment (2D).
 */
function distToSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq > 1e-6 ? Math.max(0, Math.min(1, (apx * abx + apz * abz) / lenSq)) : 0;
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return Math.hypot(px - cx, pz - cz);
}

/**
 * Normalize layout key from opConfig.id or opConfig.layoutType.
 */
function resolveLayoutKey(opConfig) {
  const raw = String(opConfig.layoutType || opConfig.id || 'op01').toLowerCase();
  if (opConfig.mode === 'megabasin' || raw.includes('mega') || raw.includes('cascadia')) {
    return 'megabasin';
  }
  if (raw.includes('02') || raw.includes('redridge') || raw.includes('narrow') || raw.includes('twin')) {
    return 'op02';
  }
  if (raw.includes('03') || raw.includes('caldera') || raw.includes('ashen') || raw.includes('crater')) {
    return 'op03';
  }
  if (raw.includes('04') || raw.includes('gorge') || raw.includes('timberline') || raw.includes('river')) {
    return 'op04';
  }
  if (raw.includes('05') || raw.includes('crown') || raw.includes('peak') || raw.includes('highland')) {
    return 'op05';
  }
  return 'op01';
}

/**
 * Returns layout specification: water SDF, terrain elevation modifier, scoop zones,
 * settlement definitions, and initial fire seed world positions.
 */
function getLayoutSpec(layoutKey, halfWorld, seed) {
  switch (layoutKey) {
    case 'op02': // Redridge Narrows: twin crescent lakes + central pine peninsula (12 cabins + 1 tower)
      return {
        waterSdf(x, z) {
          // West crescent curving around central peninsula
          const wx = -390 - 75 * Math.cos((z / 440) * Math.PI * 0.5);
          const dWest = distToSegment(x, z, wx, -390, wx, 390) - (118 + 26 * fbm2D(x * 0.004, z * 0.004, seed + 11, 2));
          // East crescent
          const ex = 400 + 75 * Math.cos((z / 440) * Math.PI * 0.5);
          const dEast = distToSegment(x, z, ex, -380, ex, 380) - (116 + 26 * fbm2D(x * 0.004, z * 0.004, seed + 19, 2));
          return Math.min(dWest, dEast);
        },
        elevationMod(x, z) {
          // Central spine rises gently
          const pen = Math.exp(-((x / 230) ** 2)) * 22;
          const northSouthRidge = Math.max(0, (Math.abs(z) - 420) * 0.06);
          return 24 + pen + northSouthRidge;
        },
        scoopZones: [
          { x: -445, z: 0, headingDeg: 0, length: 760, width: 210, name: 'West Crescent Lake' },
          { x: 455, z: 0, headingDeg: 180, length: 740, width: 210, name: 'East Crescent Lake' },
        ],
        settlementDefs: [
          { name: 'Redridge Peninsula', x: 10, z: -130, cabinCount: 12, towerCount: 1, padRadius: 145, padHeight: 34 },
        ],
        fireWorldSeeds: [
          { x: -70, z: 230, radius: 5 },
          { x: 95, z: 180, radius: 5 },
          { x: -130, z: 45, radius: 4 },
          { x: 140, z: -380, radius: 4 },
        ],
        targetTrees: 4500,
      };

    case 'op03': // Ashen Caldera: circular central crater lake + 3 radial settlements (15 cabins + 1 tower)
      return {
        waterSdf(x, z) {
          const r = Math.hypot(x, z);
          const wobble = 32 * fbm2D(x * 0.0045, z * 0.0045, seed + 23, 2);
          return r - (275 + wobble);
        },
        elevationMod(x, z) {
          const r = Math.hypot(x, z);
          // Concentric caldera rim rising outward from crater lake
          const rim = smoothstep(260, 620, r) * 58;
          return 18 + rim;
        },
        scoopZones: [
          { x: 0, z: 0, headingDeg: 0, length: 500, width: 260, name: 'Caldera Crater Lake' },
          { x: 0, z: 0, headingDeg: 90, length: 500, width: 260, name: 'Crater Cross-Lane' },
        ],
        settlementDefs: [
          { name: 'North Rim Watch', x: -30, z: -500, cabinCount: 5, towerCount: 1, padRadius: 115, padHeight: 48 },
          { name: 'East Terrace', x: 495, z: 60, cabinCount: 5, towerCount: 0, padRadius: 110, padHeight: 46 },
          { name: 'Southwest Camp', x: -420, z: 340, cabinCount: 5, towerCount: 0, padRadius: 110, padHeight: 44 },
        ],
        fireWorldSeeds: [
          { x: -390, z: -260, radius: 5 },
          { x: 320, z: -340, radius: 5 },
          { x: 250, z: 390, radius: 5 },
          { x: -120, z: 460, radius: 4 },
        ],
        targetTrees: 4500,
      };

    case 'op04': // Timberline Gorge: winding S-curve river + terraced canyon plateaus (14 cabins + 1 tower)
      return {
        waterSdf(x, z) {
          // Winding S-curve river flowing N-S
          const centerX = 220 * Math.sin(z * 0.0042);
          const dx = Math.abs(x - centerX);
          const widthNoise = 18 * fbm2D(x * 0.005, z * 0.005, seed + 37, 2);
          const halfW = 92 + widthNoise;
          const endCap = Math.max(0, Math.abs(z) - 640);
          return Math.hypot(Math.max(0, dx - halfW), endCap) - (dx < halfW && endCap === 0 ? halfW - dx : 0);
        },
        elevationMod(x, z) {
          const centerX = 220 * Math.sin(z * 0.0042);
          const distRiver = Math.abs(x - centerX);
          // Canyon walls step up into terraced plateaus
          const terrace = smoothstep(110, 320, distRiver) * 34 + smoothstep(420, 680, distRiver) * 28;
          return 16 + terrace;
        },
        scoopZones: [
          { x: -165, z: -360, headingDeg: 25, length: 480, width: 170, name: 'Upper Gorge Bend' },
          { x: 165, z: 360, headingDeg: 25, length: 480, width: 170, name: 'Lower Gorge Reach' },
        ],
        settlementDefs: [
          { name: 'West Terrace', x: -450, z: 120, cabinCount: 7, towerCount: 1, padRadius: 125, padHeight: 46 },
          { name: 'East Overlook', x: 480, z: -180, cabinCount: 7, towerCount: 0, padRadius: 125, padHeight: 48 },
        ],
        fireWorldSeeds: [
          { x: 250, z: -430, radius: 5 },
          { x: -240, z: 410, radius: 5 },
          { x: 430, z: 190, radius: 5 },
          { x: -460, z: -260, radius: 4 },
          { x: -40, z: -110, radius: 3 },
        ],
        targetTrees: 4500,
      };

    case 'op05': // Ember Crown Peak: western glacial lake + highland ridges + 2 stations (18 cabins + 2 towers)
      return {
        waterSdf(x, z) {
          const sway = 48 * Math.sin(z * 0.0048 + 0.4);
          const d = distToSegment(x, z, -430 + sway, -430, -420 + sway, 430);
          const halfW = 128 + 24 * fbm2D(x * 0.004, z * 0.004, seed + 53, 2);
          return d - halfW;
        },
        elevationMod(x, z) {
          // Highland slopes ascending toward Ember Crown peak on NE
          const eastSlope = smoothstep(-240, 560, x) * 44;
          const crownPeak = Math.exp(-(((x - 560) ** 2 + (z + 440) ** 2) / (300 ** 2))) * 62;
          const southRidge = Math.exp(-(((x - 240) ** 2 + (z - 420) ** 2) / (320 ** 2))) * 36;
          return 20 + eastSlope + crownPeak + southRidge;
        },
        scoopZones: [
          { x: -415, z: 0, headingDeg: 0, length: 820, width: 220, name: 'Glacial Basin Lake' },
        ],
        settlementDefs: [
          { name: 'Lower Timber Station', x: 180, z: 250, cabinCount: 9, towerCount: 1, padRadius: 135, padHeight: 42 },
          { name: 'Upper Crown Station', x: 430, z: -140, cabinCount: 9, towerCount: 1, padRadius: 135, padHeight: 56 },
        ],
        fireWorldSeeds: [
          { x: -90, z: -240, radius: 6 },
          { x: 130, z: -310, radius: 5 },
          { x: -70, z: 140, radius: 5 },
          { x: 260, z: 40, radius: 5 },
          { x: 470, z: 220, radius: 5 },
        ],
        targetTrees: 4600,
      };

    case 'megabasin': // Cascadia Mega-Basin (160x160 @ 20m = 3200x3200m, 3 scoop bodies, 4 settlements = 44 cabins + 4 towers)
      return {
        waterSdf(x, z) {
          // 1. West Glacial Lake (950 m N-S)
          const dWest = distToSegment(x, z, -840, -520, -840, 420) - (165 + 32 * fbm2D(x * 0.003, z * 0.003, seed + 61, 2));
          // 2. Central River Channel (850 m NW-SE)
          const dCenter = distToSegment(x, z, -300, -220, 290, 370) - (118 + 26 * fbm2D(x * 0.003, z * 0.003, seed + 71, 2));
          // 3. South Mirror Tarn (700 m E-W)
          const dSouth = distToSegment(x, z, 190, 760, 880, 760) - (142 + 28 * fbm2D(x * 0.003, z * 0.003, seed + 83, 2));
          return Math.min(dWest, dCenter, dSouth);
        },
        elevationMod(x, z) {
          // Rolling interior basin ridges between lakes and settlements
          const ridgeN = Math.exp(-(((x - 320) ** 2 + (z + 680) ** 2) / (520 ** 2))) * 38;
          const ridgeW = Math.exp(-(((x + 420) ** 2 + (z - 220) ** 2) / (440 ** 2))) * 30;
          const ridgeE = smoothstep(200, 1150, x) * 30;
          return 22 + ridgeN + ridgeW + ridgeE;
        },
        scoopZones: [
          { x: -840, z: -50, headingDeg: 0, length: 920, width: 290, name: 'West Glacial Lake' },
          { x: -5, z: 75, headingDeg: 135, length: 820, width: 210, name: 'Central River Channel' },
          { x: 535, z: 760, headingDeg: 90, length: 680, width: 250, name: 'South Mirror Tarn' },
        ],
        settlementDefs: [
          { name: 'North Pinewatch', x: -160, z: -760, cabinCount: 12, towerCount: 1, padRadius: 170, padHeight: 38 },
          { name: 'East Cinderpoint', x: 840, z: -160, cabinCount: 12, towerCount: 1, padRadius: 170, padHeight: 46 },
          { name: 'South Millcreek', x: -480, z: 740, cabinCount: 10, towerCount: 1, padRadius: 155, padHeight: 36 },
          { name: 'Central Ridgepost', x: 290, z: -260, cabinCount: 10, towerCount: 1, padRadius: 155, padHeight: 40 },
        ],
        fireWorldSeeds: [
          { x: -470, z: -540, radius: 6 },
          { x: 460, z: -480, radius: 6 },
          { x: 560, z: 140, radius: 6 },
          { x: -240, z: 480, radius: 6 },
          { x: 90, z: -720, radius: 5 },
          { x: -640, z: 460, radius: 5 },
        ],
        targetTrees: 8500,
      };

    case 'op01': // Cinderpine Basin: long western N-S lake, east burning pine slope + southern pocket, E-NE meadow w/ 10 cabins + 1 tower
    default:
      return {
        waterSdf(x, z) {
          // Slight natural curve for the long western N-S alpine lake
          const curveX = -370 + 36 * Math.sin(z * 0.0042);
          const d = distToSegment(x, z, curveX, -480, curveX, 460);
          const halfW = 132 + 28 * fbm2D(x * 0.004, z * 0.004, seed + 7, 2);
          return d - halfW;
        },
        elevationMod(x, z) {
          // Gentle rise across eastern pine slope toward E-NE clearing and outer ridges
          const eastRise = smoothstep(-210, 520, x) * 30;
          const northKnoll = Math.exp(-(((x - 160) ** 2 + (z + 440) ** 2) / (300 ** 2))) * 20;
          const southSlope = Math.exp(-(((x - 120) ** 2 + (z - 360) ** 2) / (340 ** 2))) * 22;
          return 18 + eastRise + northKnoll + southSlope;
        },
        scoopZones: [
          { x: -370, z: -10, headingDeg: 0, length: 900, width: 240, name: 'Cinderpine Lake' },
        ],
        settlementDefs: [
          { name: 'Cinderpine Meadow', x: 410, z: -240, cabinCount: 10, towerCount: 1, padRadius: 155, padHeight: 36 },
        ],
        fireWorldSeeds: [
          { x: 55, z: -120, radius: 6 },  // Main east shore burning pine slope
          { x: 145, z: 10, radius: 5 },   // Central-east fire head advancing E/ENE
          { x: 10, z: 320, radius: 5 },   // Southern pine pocket
        ],
        targetTrees: 4500,
      };
  }
}

/**
 * Generates deterministic TerrainData for any Solo Operation or Cascadia Mega-Basin.
 * @param {object} opConfig
 */
export function generateTerrain(opConfig) {
  const gridSize = opConfig.gridSize || (opConfig.mode === 'megabasin' ? 160 : 128);
  const cellSize = opConfig.cellSize || (opConfig.mode === 'megabasin' ? 20 : 16);
  const worldSize = gridSize * cellSize;
  const halfWorld = worldSize * 0.5;
  const waterLevel = WATER_LEVEL;
  const seed = (opConfig.seed ?? 101) >>> 0;
  const rng = createRng(seed);
  const layoutKey = resolveLayoutKey(opConfig);
  const spec = getLayoutSpec(layoutKey, halfWorld, seed);

  const vertStride = gridSize + 1;
  const heights = new Float32Array(vertStride * vertStride);
  const cellCount = gridSize * gridSize;
  const cellHeights = new Float32Array(cellCount);
  const waterMask = new Uint8Array(cellCount);
  const fuelMask = new Uint8Array(cellCount);
  const biomeMask = new Uint8Array(cellCount);

  // Precompute mountain ring parameters
  const mountainInner = halfWorld * 0.66;
  const mountainOuter = halfWorld * 0.99;

  // 1. Evaluate vertex heightmap
  for (let vz = 0; vz < vertStride; vz++) {
    const wz = vz * cellSize - halfWorld;
    for (let vx = 0; vx < vertStride; vx++) {
      const wx = vx * cellSize - halfWorld;

      // Water signed distance (< 0 inside lake/river)
      const wDist = spec.waterSdf(wx, wz);

      // Base interior rolling hills
      const baseElev = spec.elevationMod(wx, wz);
      const hills = fbm2D(wx * 0.0022, wz * 0.0022, seed + 101, 4) * 18
        + fbm2D(wx * 0.0065, wz * 0.0065, seed + 211, 2) * 5;

      // Surrounding jagged alpine mountain ring (lavender-mauve peaks)
      // Use superellipse distance so corners and edges all form dramatic alpine skyline
      const nx = Math.abs(wx) / halfWorld;
      const nz = Math.abs(wz) / halfWorld;
      const ringMetric = Math.max(Math.hypot(nx, nz) * 0.88, Math.max(nx, nz));
      const ringT = smoothstep(0.65, 1.0, ringMetric);
      const jagged = ridgedNoise2D(wx * 0.0028, wz * 0.0028, seed + 307, 4);
      const mountainHeight = ringT * ringT * (95 + jagged * 145);

      let h = baseElev + hills + mountainHeight;

      // Smoothly terrace settlement meadow pads
      for (let s = 0; s < spec.settlementDefs.length; s++) {
        const sd = spec.settlementDefs[s];
        const dSet = Math.hypot(wx - sd.x, wz - sd.z);
        if (dSet < sd.padRadius * 1.45) {
          const blend = 1.0 - smoothstep(sd.padRadius * 0.68, sd.padRadius * 1.45, dSet);
          const gentleRipple = fbm2D(wx * 0.01, wz * 0.01, seed + 409, 2) * 1.4;
          h = h * (1 - blend) + (sd.padHeight + gentleRipple) * blend;
        }
      }

      // Carve water basin cleanly below WATER_LEVEL with crisp sloping shoreline
      if (wDist < 0) {
        const depth = smoothstep(0, -55, wDist) * 4.5 + 1.5;
        h = waterLevel - depth;
      } else if (wDist < 95) {
        const shoreT = smoothstep(0, 95, wDist);
        const shoreTarget = waterLevel + 1.4 + shoreT * Math.max(4, h - waterLevel);
        h = Math.min(h, shoreTarget);
        if (h < waterLevel + 0.8) h = waterLevel + 0.8;
      } else {
        if (h < waterLevel + 1.5) h = waterLevel + 1.5;
      }

      // Suppress water carving near outer mountain edge
      if (ringT > 0.75 && wDist < 0) {
        h = Math.max(h, waterLevel + (ringT - 0.75) * 200);
      }

      heights[vz * vertStride + vx] = h;
    }
  }

  // Helper coordinate transforms
  function worldToGrid(x, z) {
    const gx = Math.floor((x + halfWorld) / cellSize);
    const gz = Math.floor((z + halfWorld) / cellSize);
    if (gx < 0 || gx >= gridSize || gz < 0 || gz >= gridSize) {
      return { gx, gz, idx: -1 };
    }
    return { gx, gz, idx: gz * gridSize + gx };
  }

  function gridToWorld(gx, gz) {
    return {
      x: (gx + 0.5) * cellSize - halfWorld,
      z: (gz + 0.5) * cellSize - halfWorld,
    };
  }

  function getHeight(x, z) {
    const fx = (x + halfWorld) / cellSize;
    const fz = (z + halfWorld) / cellSize;
    const cx = Math.max(0, Math.min(gridSize - 1e-4, fx));
    const cz = Math.max(0, Math.min(gridSize - 1e-4, fz));
    const ix = Math.floor(cx);
    const iz = Math.floor(cz);
    const tx = cx - ix;
    const tz = cz - iz;

    const i00 = iz * vertStride + ix;
    const h00 = heights[i00];
    const h10 = heights[i00 + 1];
    const h01 = heights[i00 + vertStride];
    const h11 = heights[i00 + vertStride + 1];

    const h0 = h00 + (h10 - h00) * tx;
    const h1 = h01 + (h11 - h01) * tx;
    return h0 + (h1 - h0) * tz;
  }

  // 2. Populate cellHeights, waterMask, biomeMask, fuelMask
  for (let gz = 0; gz < gridSize; gz++) {
    const wz = (gz + 0.5) * cellSize - halfWorld;
    for (let gx = 0; gx < gridSize; gx++) {
      const wx = (gx + 0.5) * cellSize - halfWorld;
      const idx = gz * gridSize + gx;
      const ch = getHeight(wx, wz);
      cellHeights[idx] = ch;

      const wDist = spec.waterSdf(wx, wz);
      const nx = Math.abs(wx) / halfWorld;
      const nz = Math.abs(wz) / halfWorld;
      const ringMetric = Math.max(Math.hypot(nx, nz) * 0.88, Math.max(nx, nz));

      if (wDist < 0 && ch < waterLevel - 0.1 && ringMetric < 0.85) {
        waterMask[idx] = 1;
        biomeMask[idx] = BIOME.WATER;
        fuelMask[idx] = 0;
        continue;
      }

      // Check if inside settlement meadow clearing
      let inMeadow = false;
      for (let s = 0; s < spec.settlementDefs.length; s++) {
        const sd = spec.settlementDefs[s];
        const dSet = Math.hypot(wx - sd.x, wz - sd.z);
        const edgeJitter = fbm2D(wx * 0.015, wz * 0.015, seed + 521 + s * 17, 2) * 24;
        if (dSet < sd.padRadius * 0.92 + edgeJitter) {
          inMeadow = true;
          break;
        }
      }

      if (ch >= 115 || ringMetric > 0.84) {
        biomeMask[idx] = BIOME.PEAK;
        fuelMask[idx] = 0;
      } else if (ch >= 76 || ringMetric > 0.72) {
        biomeMask[idx] = BIOME.RIDGE;
        // Lower forested ridge slopes remain flammable up to 88m
        fuelMask[idx] = ch < 88 && ringMetric < 0.78 ? 1 : 0;
      } else if (inMeadow) {
        biomeMask[idx] = BIOME.MEADOW;
        // Meadow grass is flammable right up to cabin edges (individual cabin cells cleared below)
        fuelMask[idx] = 1;
      } else if (wDist < 28 || ch < waterLevel + 3.2) {
        biomeMask[idx] = BIOME.SHORE;
        fuelMask[idx] = 0;
      } else {
        biomeMask[idx] = BIOME.FOREST;
        fuelMask[idx] = 1;
      }
    }
  }

  function isWater(x, z) {
    const { idx } = worldToGrid(x, z);
    return idx >= 0 && waterMask[idx] === 1;
  }

  // Helper to check dry land clearance from water cells
  function isDryWithMargin(x, z, marginCells = 1) {
    const { gx, gz, idx } = worldToGrid(x, z);
    if (idx < 0 || waterMask[idx] === 1) return false;
    for (let dz = -marginCells; dz <= marginCells; dz++) {
      for (let dx = -marginCells; dx <= marginCells; dx++) {
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx < 1 || nx >= gridSize - 1 || nz < 1 || nz >= gridSize - 1) return false;
        if (waterMask[nz * gridSize + nx] === 1) return false;
      }
    }
    return true;
  }

  // 3. Place settlements, cabins, and stilted water towers
  const settlements = [];
  const cabins = [];
  const towers = [];
  let cabinIdCounter = 0;
  let towerIdCounter = 0;

  for (let sIdx = 0; sIdx < spec.settlementDefs.length; sIdx++) {
    const sd = spec.settlementDefs[sIdx];
    const settlementCabins = [];

    // Deterministic organic village layout using golden-angle rings + jitter
    const count = sd.cabinCount;
    let attempts = 0;
    let placed = 0;
    while (placed < count && attempts < count * 40) {
      attempts++;
      const ringIdx = placed;
      const angle = ringIdx * 2.3999632 + (rng() - 0.5) * 0.45 + attempts * 0.13;
      const baseR = 26 + Math.sqrt(ringIdx + 0.5) * 32 + (rng() - 0.5) * 12;
      const radius = Math.min(baseR, sd.padRadius * 0.85);
      const cx = sd.x + Math.cos(angle) * radius;
      const cz = sd.z + Math.sin(angle) * radius;

      if (!isDryWithMargin(cx, cz, 2)) continue;
      const cy = getHeight(cx, cz);
      if (cy < waterLevel + 4.0 || cy > 90) continue;

      // Minimum spacing between cabins
      let tooClose = false;
      for (let k = 0; k < cabins.length; k++) {
        if (Math.hypot(cx - cabins[k].x, cz - cabins[k].z) < 26) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;

      const cabin = {
        id: cabinIdCounter++,
        settlementIdx: sIdx,
        x: cx,
        z: cz,
        y: cy,
        yawRad: Math.atan2(sd.x - cx, sd.z - cz) + (rng() - 0.5) * 0.6,
      };
      cabins.push(cabin);
      settlementCabins.push({
        id: cabin.id,
        x: cabin.x,
        z: cabin.z,
        y: cabin.y,
        yawRad: cabin.yawRad,
      });

      // Clear fuel directly underneath cabin footprint (single cell) so trees don't spawn inside cabin,
      // while keeping neighboring cells flammable so fire can reach within 24m damage radius.
      const cg = worldToGrid(cx, cz);
      if (cg.idx >= 0) {
        fuelMask[cg.idx] = 0;
        biomeMask[cg.idx] = BIOME.MEADOW;
      }

      placed++;
    }

    // Place stilted water tower(s) for this settlement
    for (let t = 0; t < sd.towerCount; t++) {
      let tx = sd.x;
      let tz = sd.z;
      let found = false;
      for (let a = 0; a < 40; a++) {
        const ang = a * 1.1 + t * 2.1;
        const rad = a === 0 ? 0 : 18 + a * 2.5;
        const candX = sd.x + Math.cos(ang) * rad;
        const candZ = sd.z + Math.sin(ang) * rad;
        if (!isDryWithMargin(candX, candZ, 2)) continue;
        let overlap = false;
        for (let k = 0; k < cabins.length; k++) {
          if (Math.hypot(candX - cabins[k].x, candZ - cabins[k].z) < 20) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          tx = candX;
          tz = candZ;
          found = true;
          break;
        }
      }
      if (found || isDryWithMargin(tx, tz, 1)) {
        towers.push({
          id: towerIdCounter++,
          x: tx,
          z: tz,
          y: getHeight(tx, tz),
        });
      }
    }

    settlements.push({
      name: sd.name,
      x: sd.x,
      z: sd.z,
      cabins: settlementCabins,
    });
  }

  // 4. Validate and refine scoopZones so every scoopZone centerline is guaranteed over water
  const scoopZones = spec.scoopZones.map((sz) => {
    const out = { ...sz };
    // Ensure center point is water; if slightly off due to noise, nudge inward
    if (!isWater(out.x, out.z)) {
      let bestDist = Infinity;
      let bestX = out.x;
      let bestZ = out.z;
      for (let gz = 2; gz < gridSize - 2; gz++) {
        for (let gx = 2; gx < gridSize - 2; gx++) {
          if (waterMask[gz * gridSize + gx] === 1) {
            const p = gridToWorld(gx, gz);
            const d = Math.hypot(p.x - out.x, p.z - out.z);
            if (d < bestDist) {
              bestDist = d;
              bestX = p.x;
              bestZ = p.z;
            }
          }
        }
      }
      out.x = bestX;
      out.z = bestZ;
    }
    return out;
  });

  // 5. Place pine trees cleanly on forest cells (~4500 solo / ~8500 megabasin)
  const forestCells = [];
  for (let i = 0; i < cellCount; i++) {
    if (biomeMask[i] === BIOME.FOREST && fuelMask[i] === 1 && waterMask[i] === 0) {
      forestCells.push(i);
    }
  }

  const trees = [];
  const targetTrees = spec.targetTrees;
  if (forestCells.length > 0) {
    // Shuffle forest cell indices deterministically for uniform distribution
    const avgPerCell = targetTrees / forestCells.length;
    for (let f = 0; f < forestCells.length; f++) {
      const cellIdx = forestCells[f];
      const gx = cellIdx % gridSize;
      const gz = (cellIdx - gx) / gridSize;
      const { x: cx, z: cz } = gridToWorld(gx, gz);

      // Fractional tree count per cell with stochastic rounding
      const baseCount = Math.floor(avgPerCell);
      const countHere = baseCount + (rng() < (avgPerCell - baseCount) ? 1 : 0);

      for (let n = 0; n < countHere; n++) {
        const tx = cx + (rng() - 0.5) * cellSize * 0.88;
        const tz = cz + (rng() - 0.5) * cellSize * 0.88;
        const gCheck = worldToGrid(tx, tz);
        if (gCheck.idx < 0 || waterMask[gCheck.idx] === 1 || biomeMask[gCheck.idx] !== BIOME.FOREST) {
          continue;
        }

        // Never overlap cabins or towers
        let blocked = false;
        for (let c = 0; c < cabins.length; c++) {
          const dx = tx - cabins[c].x;
          const dz = tz - cabins[c].z;
          if (dx * dx + dz * dz < 18 * 18) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        for (let t = 0; t < towers.length; t++) {
          const dx = tx - towers[t].x;
          const dz = tz - towers[t].z;
          if (dx * dx + dz * dz < 16 * 16) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const ty = getHeight(tx, tz);
        if (ty < waterLevel + 2.0) continue;

        trees.push({
          x: tx,
          z: tz,
          y: ty,
          cellIdx: gCheck.idx,
          scale: 0.78 + rng() * 0.55,
          tint: rng(), // 0..1 shade blend between #4d684f and #2b433d
        });
      }
    }
  }

  // 6. Convert initial fire seeds to valid flammable grid cells (safe distance from cabins)
  const initialFireSeeds = [];
  for (let i = 0; i < spec.fireWorldSeeds.length; i++) {
    const fs = spec.fireWorldSeeds[i];
    let { gx, gz, idx } = worldToGrid(fs.x, fs.z);
    if (idx < 0 || fuelMask[idx] === 0 || waterMask[idx] === 1) {
      // Spiral search for nearest valid forest/fuel cell away from cabins
      let found = false;
      for (let rad = 1; rad <= 16 && !found; rad++) {
        for (let dz = -rad; dz <= rad && !found; dz++) {
          for (let dx = -rad; dx <= rad && !found; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 4 || nx >= gridSize - 4 || nz < 4 || nz >= gridSize - 4) continue;
            const nIdx = nz * gridSize + nx;
            if (fuelMask[nIdx] === 1 && waterMask[nIdx] === 0) {
              const p = gridToWorld(nx, nz);
              let safe = true;
              for (let c = 0; c < cabins.length; c++) {
                if (Math.hypot(p.x - cabins[c].x, p.z - cabins[c].z) < 95) {
                  safe = false;
                  break;
                }
              }
              if (safe) {
                gx = nx;
                gz = nz;
                idx = nIdx;
                found = true;
              }
            }
          }
        }
      }
    }
    if (idx >= 0 && fuelMask[idx] === 1) {
      initialFireSeeds.push({ gx, gz, radius: fs.radius });
    }
  }

  return {
    opConfig,
    gridSize,
    cellSize,
    worldSize,
    halfWorld,
    waterLevel,
    heights,
    cellHeights,
    waterMask,
    fuelMask,
    biomeMask,
    scoopZones,
    settlements,
    cabins,
    towers,
    trees,
    initialFireSeeds,
    getHeight,
    isWater,
    worldToGrid,
    gridToWorld,
  };
}
