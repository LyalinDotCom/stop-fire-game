import * as THREE from 'three';
import { createForestSystem } from './TreeMesh.js';

const COL_WATER_BED = new THREE.Color('#1d3d48');
const COL_SHORE = new THREE.Color('#94815a');
const COL_MEADOW = new THREE.Color('#94815a');
const COL_MEADOW_ALT = new THREE.Color('#867450');
const COL_FOREST = new THREE.Color('#3f5e4a');
const COL_RIDGE_LOW = new THREE.Color('#435451');
const COL_RIDGE_HIGH = new THREE.Color('#78637f');
const COL_PEAK_MID = new THREE.Color('#7f6585');
const COL_PEAK_HIGH = new THREE.Color('#9c788e');

const COL_CHARRED_GROUND = new THREE.Color('#1f1a18');
const COL_BURNING_GROUND = new THREE.Color('#78280e');
const COL_BURNING_HOT = new THREE.Color('#bf4814');
const COL_WET_TINT = new THREE.Color('#0f6a82');

// Bright neutral tint colors for textured cabins so cabin-wood.png keeps full weathered contrast
const COL_CABIN_WALL_TEX = new THREE.Color('#f4ece2');
const COL_CABIN_WALL_SHADE = new THREE.Color('#d2c8be');
const COL_CABIN_ROOF_TEX = new THREE.Color('#eef2f6');
const COL_CABIN_ROOF_SHADE = new THREE.Color('#c8ced6');
const COL_CABIN_LOG = new THREE.Color('#6d4c38');
const COL_CABIN_LOG_DARK = new THREE.Color('#543929');
const COL_CABIN_ROOF = new THREE.Color('#807e88');
const COL_CABIN_ROOF_DARK = new THREE.Color('#676570');
const COL_CABIN_CHIMNEY = new THREE.Color('#8f8d96');
const COL_CABIN_RUIN = new THREE.Color('#262324');
const COL_CABIN_EMBER = new THREE.Color('#3a251d');

function resolveAssetUrl(relPath) {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
      ? import.meta.env.BASE_URL
      : './';
  return `${base.replace(/\/?$/, '/')}${relPath.replace(/^\/+/, '')}`;
}

function makeSolidDataTexture(r, g, b) {
  const data = new Uint8Array([r, g, b, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const _sharedWorldTextures = {
  initialized: false,
  terrain: null,
  cabin: null,
  listeners: [],
};

function getSharedWorldTextures(onLoaded) {
  if (!_sharedWorldTextures.initialized) {
    _sharedWorldTextures.initialized = true;
    _sharedWorldTextures.terrain = makeSolidDataTexture(232, 232, 230);
    _sharedWorldTextures.cabin = makeSolidDataTexture(168, 138, 114);

    if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
      const loader = new THREE.TextureLoader();

      loader.load(
        resolveAssetUrl('textures/terrain-detail.png'),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedWorldTextures.terrain = tex;
          for (const cb of _sharedWorldTextures.listeners) cb('terrain', tex);
        },
        undefined,
        () => {}
      );

      loader.load(
        resolveAssetUrl('textures/cabin-wood.png'),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedWorldTextures.cabin = tex;
          for (const cb of _sharedWorldTextures.listeners) cb('cabin', tex);
        },
        undefined,
        () => {}
      );
    }
  }

  if (onLoaded) {
    _sharedWorldTextures.listeners.push(onLoaded);
  }
  return {
    terrain: _sharedWorldTextures.terrain,
    cabin: _sharedWorldTextures.cabin,
    unsubscribe() {
      if (!onLoaded) return;
      const idx = _sharedWorldTextures.listeners.indexOf(onLoaded);
      if (idx !== -1) _sharedWorldTextures.listeners.splice(idx, 1);
    },
  };
}

function hash2(x, z) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

/**
 * Helper for building vertex-colored flat-shaded non-indexed BufferGeometries.
 */
class ColoredPolyBuilder {
  constructor() {
    this.positions = [];
    this.colors = [];
    this.uvs = [];
  }

  addTri(ax, ay, az, bx, by, bz, cx, cy, cz, color, uvA = [0, 0], uvB = [1, 0], uvC = [0.5, 1]) {
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.colors.push(
      color.r, color.g, color.b,
      color.r, color.g, color.b,
      color.r, color.g, color.b
    );
    this.uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
  }

  addQuad(a, b, c, d, color, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    // Standard upright quad UVs: a=top-left (u0,v1), b=top-right (u1,v1), c=bot-right (u1,v0), d=bot-left (u0,v0)
    this.addTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color, [u0, v1], [u1, v1], [u1, v0]);
    this.addTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color, [u0, v1], [u1, v0], [u0, v0]);
  }

  addBox(cx, cy, cz, sx, sy, sz, color, topColor = color, sideDark = color, u0 = 0, v0 = 0, u1 = 1, v1 = 1) {
    const x0 = cx - sx * 0.5;
    const x1 = cx + sx * 0.5;
    const y0 = cy - sy * 0.5;
    const y1 = cy + sy * 0.5;
    const z0 = cz - sz * 0.5;
    const z1 = cz + sz * 0.5;

    // Top (+Y)
    this.addQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], topColor, u0, v0, u1, v1);
    // Bottom (-Y)
    this.addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], sideDark, u0, v0, u1, v1);
    // Front (-Z)
    this.addQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], color, u0, v0, u1, v1);
    // Back (+Z)
    this.addQuad([x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [x1, y0, z1], color, u0, v0, u1, v1);
    // Right (+X)
    this.addQuad([x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0], sideDark, u0, v0, u1, v1);
    // Left (-X)
    this.addQuad([x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], sideDark, u0, v0, u1, v1);
  }

  addCone(cx, yBase, cz, radius, height, segs, color) {
    const tip = [cx, yBase + height, cz];
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * radius, yBase, cz + Math.sin(a0) * radius];
      const p1 = [cx + Math.cos(a1) * radius, yBase, cz + Math.sin(a1) * radius];
      // Outward winding for +Y cone: (p1, p0, tip)
      this.addTri(p1[0], p1[1], p1[2], p0[0], p0[1], p0[2], tip[0], tip[1], tip[2], color);
    }
  }

  addCylinder(cx, yBase, cz, rBot, rTop, height, segs, color, capTopColor = null) {
    const yTop = yBase + height;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);

      const b0 = [cx + c0 * rBot, yBase, cz + s0 * rBot];
      const b1 = [cx + c1 * rBot, yBase, cz + s1 * rBot];
      const t0 = [cx + c0 * rTop, yTop, cz + s0 * rTop];
      const t1 = [cx + c1 * rTop, yTop, cz + s1 * rTop];
      this.addQuad(t1, t0, b0, b1, color);

      if (capTopColor) {
        this.addTri(cx, yTop, cz, t1[0], t1[1], t1[2], t0[0], t0[1], t0[2], capTopColor);
      }
    }
  }

  addBeam(p0, p1, thickness, color) {
    const a = new THREE.Vector3(...p0);
    const b = new THREE.Vector3(...p1);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);
    const ref = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(dir, ref).normalize().multiplyScalar(thickness * 0.5);
    const v = new THREE.Vector3().crossVectors(dir, u).normalize().multiplyScalar(thickness * 0.5);

    const a0 = [a.x - u.x - v.x, a.y - u.y - v.y, a.z - u.z - v.z];
    const a1 = [a.x + u.x - v.x, a.y + u.y - v.y, a.z + u.z - v.z];
    const a2 = [a.x + u.x + v.x, a.y + u.y + v.y, a.z + u.z + v.z];
    const a3 = [a.x - u.x + v.x, a.y - u.y + v.y, a.z - u.z + v.z];

    const b0 = [b.x - u.x - v.x, b.y - u.y - v.y, b.z - u.z - v.z];
    const b1 = [b.x + u.x - v.x, b.y + u.y - v.y, b.z + u.z - v.z];
    const b2 = [b.x + u.x + v.x, b.y + u.y + v.y, b.z + u.z + v.z];
    const b3 = [b.x - u.x + v.x, b.y - u.y + v.y, b.z - u.z + v.z];

    this.addQuad(a0, a1, b1, b0, color);
    this.addQuad(a1, a2, b2, b1, color);
    this.addQuad(a2, a3, b3, b2, color);
    this.addQuad(a3, a0, b0, b3, color);
  }

  build() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geom.computeVertexNormals();
    return geom;
  }
}

/**
 * Builds an intact weathered timber cabin mapped cleanly onto cabin-wood.png:
 * - Bottom half (v = 0.04..0.46): horizontal hand-hewn timber logs (walls + gables)
 * - Top half (v = 0.54..0.96): weathered corrugated slate-tin roof & stone chimney
 */
function buildCabinGeometry() {
  const b = new ColoredPolyBuilder();
  const w = 9.0;
  const d = 6.6;
  const h = 4.2;
  const ridgeH = 2.9;

  // Foundation plinth + weathered log walls (mapped to lower log atlas band v = 0.04..0.46)
  b.addBox(
    0, h * 0.5 - 0.3, 0, w, h + 0.6, d,
    COL_CABIN_WALL_TEX, COL_CABIN_WALL_SHADE, COL_CABIN_WALL_SHADE,
    0, 0.04, 1.4, 0.46
  );

  // Gable triangles on left (-X) and right (+X) ends (horizontal log band)
  const hx = w * 0.5;
  const hz = d * 0.5;
  b.addTri(hx, h, -hz, hx, h, hz, hx, h + ridgeH, 0, COL_CABIN_WALL_SHADE, [0, 0.06], [1.0, 0.06], [0.5, 0.42]);
  b.addTri(-hx, h, hz, -hx, h, -hz, -hx, h + ridgeH, 0, COL_CABIN_WALL_SHADE, [0, 0.06], [1.0, 0.06], [0.5, 0.42]);

  // Overhanging gabled corrugated roof panels (mapped to upper slate-tin atlas band v = 0.54..0.96)
  const rx = hx + 0.65;
  const rz = hz + 0.75;
  const eaveY = h - 0.35;
  const peakY = h + ridgeH + 0.2;

  // North slope (-Z)
  b.addQuad([-rx, peakY, 0], [rx, peakY, 0], [rx, eaveY, -rz], [-rx, eaveY, -rz], COL_CABIN_ROOF_TEX, 0, 0.54, 1.6, 0.96);
  // South slope (+Z)
  b.addQuad([rx, peakY, 0], [-rx, peakY, 0], [-rx, eaveY, rz], [rx, eaveY, rz], COL_CABIN_ROOF_SHADE, 0, 0.54, 1.6, 0.96);
  // Roof underside / soffit caps so viewing from below stays solid
  b.addQuad([rx, peakY, 0], [-rx, peakY, 0], [-rx, eaveY, -rz], [rx, eaveY, -rz], COL_CABIN_ROOF_SHADE, 0, 0.54, 1.0, 0.72);
  b.addQuad([-rx, peakY, 0], [rx, peakY, 0], [rx, eaveY, rz], [-rx, eaveY, rz], COL_CABIN_ROOF_SHADE, 0, 0.54, 1.0, 0.72);

  // Stone/slate chimney rising through roof
  b.addBox(
    2.2, h + ridgeH * 0.65, -1.2, 1.35, 3.6, 1.35,
    COL_CABIN_CHIMNEY, COL_CABIN_ROOF_SHADE, COL_CABIN_CHIMNEY,
    0.1, 0.56, 0.45, 0.92
  );

  return b.build();
}

/**
 * Builds glowing emissive window quads for a timber cabin (rendered with MeshBasicMaterial #ffd978).
 */
function buildCabinWindowsGeometry() {
  const positions = [];
  const addQuad = (a, b, c, d) => {
    positions.push(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]
    );
  };

  const wy0 = 1.55;
  const wy1 = 3.05;
  const zFront = -3.36;
  const zBack = 3.36;
  const xEnd = 4.56;

  // Front (-Z) two windows
  addQuad([-2.8, wy1, zFront], [-1.2, wy1, zFront], [-1.2, wy0, zFront], [-2.8, wy0, zFront]);
  addQuad([1.2, wy1, zFront], [2.8, wy1, zFront], [2.8, wy0, zFront], [1.2, wy0, zFront]);
  // Back (+Z) two windows
  addQuad([2.8, wy1, zBack], [1.2, wy1, zBack], [1.2, wy0, zBack], [2.8, wy0, zBack]);
  addQuad([-1.2, wy1, zBack], [-2.8, wy1, zBack], [-2.8, wy0, zBack], [-1.2, wy0, zBack]);
  // Gable side windows (+X and -X)
  addQuad([xEnd, wy1, -0.8], [xEnd, wy1, 0.8], [xEnd, wy0, 0.8], [xEnd, wy0, -0.8]);
  addQuad([-xEnd, wy1, 0.8], [-xEnd, wy1, -0.8], [-xEnd, wy0, -0.8], [-xEnd, wy0, 0.8]);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

/**
 * Builds collapsed dark charred ruin rubble when a cabin reaches hp <= 0.
 */
function buildCabinRuinGeometry() {
  const b = new ColoredPolyBuilder();
  b.addBox(0, 0.45, 0, 8.8, 1.1, 6.4, COL_CABIN_RUIN, COL_CABIN_EMBER, COL_CABIN_RUIN);
  b.addBox(-1.8, 1.15, 0.4, 3.6, 0.9, 2.8, COL_CABIN_RUIN, COL_CABIN_RUIN, COL_CABIN_EMBER);
  b.addBox(2.2, 1.4, -1.2, 1.4, 2.8, 1.4, COL_CABIN_CHIMNEY, COL_CABIN_RUIN, COL_CABIN_RUIN);
  // Fallen charred roof rafters
  b.addBeam([-3.6, 0.8, -2.5], [1.2, 1.8, 1.6], 0.42, COL_CABIN_RUIN);
  b.addBeam([3.2, 0.7, 2.2], [-1.0, 1.5, -1.8], 0.38, COL_CABIN_RUIN);
  return b.build();
}

/**
 * Builds a stilted wooden alpine water tower (cylinder on 4 angled cross-braced stilts).
 */
function buildWaterTowerGeometry() {
  const b = new ColoredPolyBuilder();
  const tankY = 10.5;
  const legSpreadBot = 3.2;
  const legSpreadTop = 2.0;

  // 4 angled support stilts + cross braces
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < 4; i++) {
    const [sx, sz] = corners[i];
    const [nx, nz] = corners[(i + 1) % 4];
    b.addBeam(
      [sx * legSpreadBot, -0.6, sz * legSpreadBot],
      [sx * legSpreadTop, tankY + 0.2, sz * legSpreadTop],
      0.42,
      COL_CABIN_LOG_DARK
    );
    // Mid horizontal collar
    const midSpread = (legSpreadBot + legSpreadTop) * 0.5;
    b.addBeam(
      [sx * midSpread, tankY * 0.5, sz * midSpread],
      [nx * midSpread, tankY * 0.5, nz * midSpread],
      0.28,
      COL_CABIN_LOG
    );
    // Diagonal X-brace
    b.addBeam(
      [sx * legSpreadBot * 0.95, 0.5, sz * legSpreadBot * 0.95],
      [nx * midSpread, tankY * 0.5, nz * midSpread],
      0.20,
      COL_CABIN_LOG_DARK
    );
    b.addBeam(
      [sx * midSpread, tankY * 0.5, sz * midSpread],
      [nx * legSpreadTop, tankY, nz * legSpreadTop],
      0.20,
      COL_CABIN_LOG_DARK
    );
  }

  // Timber platform deck
  b.addBox(0, tankY, 0, 5.4, 0.55, 5.4, COL_CABIN_LOG_DARK, COL_CABIN_LOG, COL_CABIN_LOG_DARK);
  // Wooden cylindrical water barrel
  b.addCylinder(0, tankY + 0.25, 0, 2.55, 2.55, 5.4, 10, COL_CABIN_LOG);
  // Dark iron hoops around barrel
  const hoopCol = new THREE.Color('#2d2e34');
  b.addCylinder(0, tankY + 1.3, 0, 2.63, 2.63, 0.26, 10, hoopCol);
  b.addCylinder(0, tankY + 3.0, 0, 2.63, 2.63, 0.26, 10, hoopCol);
  b.addCylinder(0, tankY + 4.7, 0, 2.63, 2.63, 0.26, 10, hoopCol);
  // Conical gray shingled roof (#807e88)
  b.addCone(0, tankY + 5.6, 0, 3.05, 2.4, 10, COL_CABIN_ROOF);

  return b.build();
}

/**
 * Computes base vertex color for a playable terrain cell based on biomeMask and height.
 */
function computeCellBaseColor(biome, h, waterLevel, gx, gz, outColor) {
  const n = (hash2(gx, gz) - 0.5) * 0.08;
  if (biome === 0 || h <= waterLevel + 0.15) {
    outColor.copy(COL_WATER_BED);
  } else if (biome === 1) {
    outColor.copy(COL_SHORE);
  } else if (biome === 2) {
    outColor.copy(n > 0 ? COL_MEADOW : COL_MEADOW_ALT);
  } else if (biome === 3) {
    const t = Math.max(0, Math.min(1, (h - (waterLevel + 35)) / 55));
    outColor.copy(COL_FOREST).lerp(COL_RIDGE_LOW, t * 0.65);
  } else if (biome === 4) {
    const t = Math.max(0, Math.min(1, (h - (waterLevel + 50)) / 75));
    outColor.copy(COL_RIDGE_LOW).lerp(COL_RIDGE_HIGH, t);
  } else {
    const t = Math.max(0, Math.min(1, (h - (waterLevel + 90)) / 90));
    outColor.copy(COL_PEAK_MID).lerp(COL_PEAK_HIGH, t);
  }
  // Subtle per-cell luminance jitter for handcrafted faceted retro feel
  const mult = 1.0 + n;
  outColor.r = Math.min(1, Math.max(0, outColor.r * mult));
  outColor.g = Math.min(1, Math.max(0, outColor.g * mult));
  outColor.b = Math.min(1, Math.max(0, outColor.b * mult));
}

/**
 * Appends a dramatic jagged lavender-mauve alpine mountain ring outside the playable grid
 * seamlessly stitched to the outer perimeter vertices of terrain.heights.
 */
function appendOuterMountainRing(terrain, positions, colors) {
  const gs = terrain.gridSize;
  const cs = terrain.cellSize;
  const half = terrain.halfWorld;
  const heights = terrain.heights;
  const stride = gs + 1;

  // Build 4 rings radiating outward from the square perimeter
  const ringStep = 4; // sample every 4th edge vertex for crisp bold low-poly mountain facets
  const segsPerSide = Math.max(8, Math.floor(gs / ringStep));
  const perimPts = [];

  // Perimeter clockwise: North (-Z), East (+X), South (+Z), West (-X)
  for (let i = 0; i < segsPerSide; i++) {
    const gx = Math.min(gs, i * ringStep);
    perimPts.push([gx * cs - half, heights[0 * stride + gx], -half]);
  }
  for (let i = 0; i < segsPerSide; i++) {
    const gz = Math.min(gs, i * ringStep);
    perimPts.push([half, heights[gz * stride + gs], gz * cs - half]);
  }
  for (let i = 0; i < segsPerSide; i++) {
    const gx = Math.max(0, gs - i * ringStep);
    perimPts.push([gx * cs - half, heights[gs * stride + gx], half]);
  }
  for (let i = 0; i < segsPerSide; i++) {
    const gz = Math.max(0, gs - i * ringStep);
    perimPts.push([-half, heights[gz * stride + 0], gz * cs - half]);
  }

  const N = perimPts.length;
  const rings = [perimPts];
  const ringConfigs = [
    { dist: 210, baseH: 135, varH: 95, seed: 11.3 },
    { dist: 520, baseH: 245, varH: 135, seed: 29.7 },
    { dist: 920, baseH: 165, varH: 110, seed: 53.1 },
  ];

  for (let r = 0; r < ringConfigs.length; r++) {
    const cfg = ringConfigs[r];
    const pts = [];
    for (let i = 0; i < N; i++) {
      const p0 = perimPts[i];
      const angle = Math.atan2(p0[2], p0[0]);
      const dirX = Math.cos(angle);
      const dirZ = Math.sin(angle);
      const jitter = (hash2(i * 1.7 + cfg.seed, r * 13.1) - 0.5) * 75;
      const dist = cfg.dist + jitter;
      const ridgeWave =
        Math.sin(angle * 7.0 + r * 1.4) * 0.5 +
        Math.cos(angle * 13.0 - r * 2.1) * 0.35 +
        (hash2(i + cfg.seed, r * 3.7) - 0.5) * 0.6;
      const y = Math.max(
        terrain.waterLevel + 35,
        cfg.baseH + ridgeWave * cfg.varH
      );
      pts.push([p0[0] + dirX * dist, y, p0[2] + dirZ * dist]);
    }
    rings.push(pts);
  }

  const tmpCol = new THREE.Color();
  const pushTri = (a, b, c) => {
    const avgY = (a[1] + b[1] + c[1]) / 3;
    const t = Math.max(0, Math.min(1, (avgY - 75) / 195));
    if (t < 0.45) {
      tmpCol.copy(COL_RIDGE_HIGH).lerp(COL_PEAK_MID, t / 0.45);
    } else {
      tmpCol.copy(COL_PEAK_MID).lerp(COL_PEAK_HIGH, (t - 0.45) / 0.55);
    }
    const facetVar = 0.94 + hash2(a[0] * 0.01, c[2] * 0.01) * 0.12;
    const r = Math.min(1, tmpCol.r * facetVar);
    const g = Math.min(1, tmpCol.g * facetVar);
    const bl = Math.min(1, tmpCol.b * facetVar);

    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    colors.push(r, g, bl, r, g, bl, r, g, bl);
  };

  for (let r = 0; r < rings.length - 1; r++) {
    const inner = rings[r];
    const outer = rings[r + 1];
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      // Outward/upward (+Y) winding for clockwise perimeter
      pushTri(inner[i], outer[j], outer[i]);
      pushTri(inner[i], inner[j], outer[j]);
    }
  }
}

/**
 * Manages all world 3D meshes: terrain + outer mountain ring, instanced pines,
 * instanced cabins (+ glowing windows & charred ruins), and stilted water towers.
 */
export class WorldMeshes {
  constructor(terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'WorldMeshes';

    this._tmpColor = new THREE.Color();
    this._tmpMat = new THREE.Matrix4();
    this._tmpPos = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpScale = new THREE.Vector3();
    this._upAxis = new THREE.Vector3(0, 1, 0);
    this._zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

    this._texHandle = getSharedWorldTextures((kind, tex) => {
      if (kind === 'terrain' && this._terrainMat) {
        this._terrainMat.map = tex;
        this._terrainMat.needsUpdate = true;
      } else if (kind === 'cabin' && this._cabinMat) {
        this._cabinMat.map = tex;
        this._cabinMat.needsUpdate = true;
      }
    });

    this._buildTerrain(terrain);
    this._buildPines(terrain);
    this._buildCabins(terrain);
    this._buildTowers(terrain);
  }

  _buildTerrain(terrain) {
    const gs = terrain.gridSize;
    const cs = terrain.cellSize;
    const half = terrain.halfWorld;
    const heights = terrain.heights;
    const biomeMask = terrain.biomeMask;
    const stride = gs + 1;
    const cellCount = gs * gs;

    this._gridSize = gs;
    this._cellCount = cellCount;
    this._cellBaseColors = new Float32Array(cellCount * 3);
    this._cellCurrentColors = new Float32Array(cellCount * 3);
    this._cellStates = new Uint8Array(cellCount);
    this._dirtySmoothStamp = new Uint32Array(cellCount);
    this._smoothPassId = 0;

    const positions = [];
    const colors = [];
    const uvs = [];
    const uvScale = 0.035;
    const tmpCol = this._tmpColor;

    for (let gz = 0; gz < gs; gz++) {
      const z0 = gz * cs - half;
      const z1 = z0 + cs;
      for (let gx = 0; gx < gs; gx++) {
        const x0 = gx * cs - half;
        const x1 = x0 + cs;

        const h00 = heights[gz * stride + gx];
        const h10 = heights[gz * stride + gx + 1];
        const h01 = heights[(gz + 1) * stride + gx];
        const h11 = heights[(gz + 1) * stride + gx + 1];
        const hAvg = (h00 + h10 + h01 + h11) * 0.25;

        const idx = gz * gs + gx;
        computeCellBaseColor(biomeMask[idx], hAvg, terrain.waterLevel, gx, gz, tmpCol);
        this._cellBaseColors[idx * 3] = tmpCol.r;
        this._cellBaseColors[idx * 3 + 1] = tmpCol.g;
        this._cellBaseColors[idx * 3 + 2] = tmpCol.b;
        this._cellCurrentColors[idx * 3] = tmpCol.r;
        this._cellCurrentColors[idx * 3 + 1] = tmpCol.g;
        this._cellCurrentColors[idx * 3 + 2] = tmpCol.b;

        // Alternate quad diagonal for organic alpine low-poly triangulation
        // Outward (+Y) winding:
        if (((gx + gz) & 1) === 0) {
          positions.push(
            x0, h00, z0, x0, h01, z1, x1, h10, z0,
            x1, h10, z0, x0, h01, z1, x1, h11, z1
          );
          uvs.push(
            x0 * uvScale, z0 * uvScale, x0 * uvScale, z1 * uvScale, x1 * uvScale, z0 * uvScale,
            x1 * uvScale, z0 * uvScale, x0 * uvScale, z1 * uvScale, x1 * uvScale, z1 * uvScale
          );
        } else {
          positions.push(
            x0, h00, z0, x0, h01, z1, x1, h11, z1,
            x0, h00, z0, x1, h11, z1, x1, h10, z0
          );
          uvs.push(
            x0 * uvScale, z0 * uvScale, x0 * uvScale, z1 * uvScale, x1 * uvScale, z1 * uvScale,
            x0 * uvScale, z0 * uvScale, x1 * uvScale, z1 * uvScale, x1 * uvScale, z0 * uvScale
          );
        }

        for (let v = 0; v < 6; v++) {
          colors.push(tmpCol.r, tmpCol.g, tmpCol.b);
        }
      }
    }

    // Stitch dramatic outer alpine mountain ring into same single-draw-call geometry
    const outerStartPosIdx = positions.length;
    appendOuterMountainRing(terrain, positions, colors);
    for (let i = outerStartPosIdx; i < positions.length; i += 3) {
      uvs.push(positions[i] * uvScale * 0.5, positions[i + 2] * uvScale * 0.5);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    this._terrainColorAttr = new THREE.Float32BufferAttribute(colors, 3);
    geom.setAttribute('color', this._terrainColorAttr);
    geom.computeVertexNormals();

    this._terrainGeo = geom;
    this._terrainMat = new THREE.MeshStandardMaterial({
      flatShading: true,
      vertexColors: true,
      map: this._texHandle.terrain,
      roughness: 0.94,
      metalness: 0.0,
    });
    this.terrainMesh = new THREE.Mesh(geom, this._terrainMat);
    this.terrainMesh.name = 'AlpineTerrain';
    this.group.add(this.terrainMesh);
  }

  _buildPines(terrain) {
    this._forest = createForestSystem(terrain, this.group, {
      cellCount: this._cellCount,
    });
    this.pineMesh = this._forest && this._forest.meshes && this._forest.meshes[0]
      ? this._forest.meshes[0]
      : null;
  }

  _buildCabins(terrain) {
    const cabins = terrain.cabins || [];
    this._cabins = cabins;
    const count = cabins.length;
    this._cabinCount = count;
    this._cabinDestroyed = new Uint8Array(count);
    this._cabinLastHp = new Uint8Array(count);
    this._cabinLastHp.fill(100);

    this._cabinGeo = buildCabinGeometry();
    this._cabinMat = new THREE.MeshStandardMaterial({
      flatShading: true,
      vertexColors: true,
      map: this._texHandle.cabin,
      roughness: 0.90,
      metalness: 0.05,
    });

    this._windowGeo = buildCabinWindowsGeometry();
    this._windowMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
    });

    this._ruinGeo = buildCabinRuinGeometry();
    this._ruinMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      vertexColors: true,
    });

    if (count === 0) {
      this.cabinMesh = null;
      this.windowMesh = null;
      this.ruinMesh = null;
      return;
    }

    this.cabinMesh = new THREE.InstancedMesh(this._cabinGeo, this._cabinMat, count);
    this.cabinMesh.name = 'TimberCabins';
    this.cabinMesh.frustumCulled = false;

    this.windowMesh = new THREE.InstancedMesh(this._windowGeo, this._windowMat, count);
    this.windowMesh.name = 'CabinWindows';
    this.windowMesh.frustumCulled = false;

    this.ruinMesh = new THREE.InstancedMesh(this._ruinGeo, this._ruinMat, count);
    this.ruinMesh.name = 'CabinRuins';
    this.ruinMesh.frustumCulled = false;

    const white = new THREE.Color(1, 1, 1);
    const warmWin = new THREE.Color('#ffd978');
    this._cabinMatrices = [];

    for (let i = 0; i < count; i++) {
      const c = cabins[i];
      const mat = new THREE.Matrix4();
      this._tmpPos.set(c.x, c.y, c.z);
      this._tmpQuat.setFromAxisAngle(this._upAxis, c.yawRad || 0);
      this._tmpScale.set(1, 1, 1);
      mat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
      this._cabinMatrices.push(mat);

      this.cabinMesh.setMatrixAt(i, mat);
      this.cabinMesh.setColorAt(i, white);
      this.windowMesh.setMatrixAt(i, mat);
      this.windowMesh.setColorAt(i, warmWin);
      this.ruinMesh.setMatrixAt(i, this._zeroMatrix);
    }

    this.cabinMesh.instanceMatrix.needsUpdate = true;
    if (this.cabinMesh.instanceColor) this.cabinMesh.instanceColor.needsUpdate = true;
    this.windowMesh.instanceMatrix.needsUpdate = true;
    if (this.windowMesh.instanceColor) this.windowMesh.instanceColor.needsUpdate = true;
    this.ruinMesh.instanceMatrix.needsUpdate = true;
    this.ruinMesh.visible = false; // Zero draw calls until a cabin collapses!

    this.group.add(this.cabinMesh);
    this.group.add(this.windowMesh);
    this.group.add(this.ruinMesh);
  }

  _buildTowers(terrain) {
    const towers = terrain.towers || [];
    const count = towers.length;

    this._towerGeo = buildWaterTowerGeometry();
    this._towerMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      vertexColors: true,
    });

    if (count === 0) {
      this.towerMesh = null;
      return;
    }

    this.towerMesh = new THREE.InstancedMesh(this._towerGeo, this._towerMat, count);
    this.towerMesh.name = 'WaterTowers';
    this.towerMesh.frustumCulled = false;

    for (let i = 0; i < count; i++) {
      const tw = towers[i];
      this._tmpPos.set(tw.x, tw.y, tw.z);
      this._tmpQuat.setFromAxisAngle(this._upAxis, hash2(tw.x, tw.z) * Math.PI * 2);
      this._tmpScale.set(1, 1, 1);
      this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
      this.towerMesh.setMatrixAt(i, this._tmpMat);
    }
    this.towerMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.towerMesh);
  }

  /**
   * Computes smoothly blended corner RGB color at vertex corner (vx, vz)
   * by averaging the up to 4 neighboring cells around that vertex (eliminates blocky square cells),
   * weighting wet firebreaks higher so carved dark-teal trenches stay vividly legible next to flames.
   */
  _writeSmoothCellVertices(gx, gz) {
    const gs = this._gridSize;
    const curr = this._cellCurrentColors;
    const states = this._cellStates;
    const colorArr = this._terrainColorAttr.array;

    const sampleCorner = (vx, vz, outOffset) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let totalW = 0;
      for (let dz = -1; dz <= 0; dz++) {
        const cz = vz + dz;
        if (cz < 0 || cz >= gs) continue;
        const rowOff = cz * gs;
        for (let dx = -1; dx <= 0; dx++) {
          const cx = vx + dx;
          if (cx < 0 || cx >= gs) continue;
          const cIdx = rowOff + cx;
          const w = states[cIdx] === 13 ? 2.4 : 1.0;
          const o = cIdx * 3;
          r += curr[o] * w;
          g += curr[o + 1] * w;
          b += curr[o + 2] * w;
          totalW += w;
        }
      }
      const inv = totalW > 0 ? 1 / totalW : 1;
      colorArr[outOffset] = r * inv;
      colorArr[outOffset + 1] = g * inv;
      colorArr[outOffset + 2] = b * inv;
    };

    const idx = gz * gs + gx;
    const vOff = idx * 18;
    // Write 6 vertices matching _buildTerrain alternating diagonal triangulation
    if (((gx + gz) & 1) === 0) {
      // (x0,z0), (x0,z1), (x1,z0), (x1,z0), (x0,z1), (x1,z1)
      sampleCorner(gx, gz, vOff);
      sampleCorner(gx, gz + 1, vOff + 3);
      sampleCorner(gx + 1, gz, vOff + 6);
      colorArr[vOff + 9] = colorArr[vOff + 6];
      colorArr[vOff + 10] = colorArr[vOff + 7];
      colorArr[vOff + 11] = colorArr[vOff + 8];
      colorArr[vOff + 12] = colorArr[vOff + 3];
      colorArr[vOff + 13] = colorArr[vOff + 4];
      colorArr[vOff + 14] = colorArr[vOff + 5];
      sampleCorner(gx + 1, gz + 1, vOff + 15);
    } else {
      // (x0,z0), (x0,z1), (x1,z1), (x0,z0), (x1,z1), (x1,z0)
      sampleCorner(gx, gz, vOff);
      sampleCorner(gx, gz + 1, vOff + 3);
      sampleCorner(gx + 1, gz + 1, vOff + 6);
      colorArr[vOff + 9] = colorArr[vOff];
      colorArr[vOff + 10] = colorArr[vOff + 1];
      colorArr[vOff + 11] = colorArr[vOff + 2];
      colorArr[vOff + 12] = colorArr[vOff + 6];
      colorArr[vOff + 13] = colorArr[vOff + 7];
      colorArr[vOff + 14] = colorArr[vOff + 8];
      sampleCorner(gx + 1, gz, vOff + 15);
    }
  }

  /**
   * Advances time-based animations on world meshes (burning tree ember rims).
   */
  update(elapsed = 0) {
    if (this._forest && typeof this._forest.updateTime === 'function') {
      this._forest.updateTime(elapsed);
    }
  }

  /**
   * Fast partial update of smooth terrain vertex colors, organic conifer states, and cabin states
   * driven by FireSim dirtyIndices (or full pass when dirtyIndices is null).
   */
  syncFireState(cells, dirtyIndices, cabinHp, cabinAtRisk, elapsed = 0) {
    let terrainDirty = false;

    const baseColors = this._cellBaseColors;
    const currColors = this._cellCurrentColors;
    const gs = this._gridSize;
    const tmpCol = this._tmpColor;
    const changedCellList = [];

    const updateCell = (idx) => {
      if (idx < 0 || idx >= this._cellCount) return;
      const st = cells[idx];
      if (st === this._cellStates[idx] && dirtyIndices !== null) return;
      this._cellStates[idx] = st;

      const b3 = idx * 3;
      const br = baseColors[b3];
      const bg = baseColors[b3 + 1];
      const bb = baseColors[b3 + 2];

      let r = br;
      let g = bg;
      let b = bb;

      if (st === 14) {
        // Organic charred charcoal earth
        r = COL_CHARRED_GROUND.r;
        g = COL_CHARRED_GROUND.g;
        b = COL_CHARRED_GROUND.b;
      } else if (st >= 1 && st <= 12) {
        // Glowing warm scorched earth under active fire (brighter at high intensity)
        const norm = st / 12;
        const heatR = COL_BURNING_GROUND.r + (COL_BURNING_HOT.r - COL_BURNING_GROUND.r) * norm;
        const heatG = COL_BURNING_GROUND.g + (COL_BURNING_HOT.g - COL_BURNING_GROUND.g) * norm;
        const heatB = COL_BURNING_GROUND.b + (COL_BURNING_HOT.b - COL_BURNING_GROUND.b) * norm;
        const t = Math.min(1, 0.45 + norm * 0.55);
        r = br + (heatR - br) * t;
        g = bg + (heatG - bg) * t;
        b = bb + (heatB - bb) * t;
      } else if (st === 13) {
        // Unmistakable soaked dark-teal wet firebreak trench visible from high altitude
        r = br * 0.22 + COL_WET_TINT.r * 0.78;
        g = bg * 0.22 + COL_WET_TINT.g * 0.78;
        b = bb * 0.22 + COL_WET_TINT.b * 0.78;
      } else if (st === 15) {
        // Ember warning warm amber ground glow
        r = Math.min(1, br * 1.25 + 0.14);
        g = br * 0.45 + bg * 0.45 + 0.05;
        b = bb * 0.58;
      }

      currColors[b3] = r;
      currColors[b3 + 1] = g;
      currColors[b3 + 2] = b;
      changedCellList.push(idx);
      terrainDirty = true;
    };

    if (cells) {
      if (dirtyIndices && dirtyIndices.length > 0) {
        for (let i = 0; i < dirtyIndices.length; i++) {
          updateCell(dirtyIndices[i]);
        }
        // Smooth vertex color update for each changed cell and its 8 adjacent neighbors
        if (changedCellList.length > 0) {
          this._smoothPassId = (this._smoothPassId + 1) >>> 0;
          if (this._smoothPassId === 0) {
            this._dirtySmoothStamp.fill(0);
            this._smoothPassId = 1;
          }
          const passId = this._smoothPassId;
          for (let i = 0; i < changedCellList.length; i++) {
            const cIdx = changedCellList[i];
            const cgx = cIdx % gs;
            const cgz = (cIdx / gs) | 0;
            for (let dz = -1; dz <= 1; dz++) {
              const nz = cgz + dz;
              if (nz < 0 || nz >= gs) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = cgx + dx;
                if (nx < 0 || nx >= gs) continue;
                const nIdx = nz * gs + nx;
                if (this._dirtySmoothStamp[nIdx] !== passId) {
                  this._dirtySmoothStamp[nIdx] = passId;
                  this._writeSmoothCellVertices(nx, nz);
                }
              }
            }
          }
        }
      } else if (dirtyIndices === null) {
        for (let idx = 0; idx < this._cellCount; idx++) {
          updateCell(idx);
        }
        for (let gz = 0; gz < gs; gz++) {
          for (let gx = 0; gx < gs; gx++) {
            this._writeSmoothCellVertices(gx, gz);
          }
        }
      }

      if (this._forest && typeof this._forest.updateFromFireGrid === 'function') {
        this._forest.updateFromFireGrid(cells, dirtyIndices, elapsed);
      }
    }

    if (terrainDirty) {
      this._terrainColorAttr.needsUpdate = true;
    }

    // Update cabin HP / collapse ruins / at-risk window pulse
    if (this.cabinMesh && cabinHp) {
      let cabinMatDirty = false;
      let cabinColDirty = false;
      let winColDirty = false;
      let anyRuins = false;

      for (let i = 0; i < this._cabinCount; i++) {
        const hp = cabinHp[i];
        const destroyed = hp <= 0 ? 1 : 0;
        if (destroyed) anyRuins = true;

        if (destroyed !== this._cabinDestroyed[i]) {
          this._cabinDestroyed[i] = destroyed;
          if (destroyed) {
            this.cabinMesh.setMatrixAt(i, this._zeroMatrix);
            this.windowMesh.setMatrixAt(i, this._zeroMatrix);
            this.ruinMesh.setMatrixAt(i, this._cabinMatrices[i]);
          } else {
            this.cabinMesh.setMatrixAt(i, this._cabinMatrices[i]);
            this.windowMesh.setMatrixAt(i, this._cabinMatrices[i]);
            this.ruinMesh.setMatrixAt(i, this._zeroMatrix);
          }
          cabinMatDirty = true;
        }

        if (!destroyed && hp !== this._cabinLastHp[i]) {
          this._cabinLastHp[i] = hp;
          const dmg = 1.0 - Math.max(0, Math.min(1, hp / 100));
          // Darken timber slightly as cabin takes heat damage
          const shade = 1.0 - dmg * 0.45;
          tmpCol.setRGB(shade, shade * (1.0 - dmg * 0.15), shade * (1.0 - dmg * 0.25));
          this.cabinMesh.setColorAt(i, tmpCol);
          cabinColDirty = true;
        }

        if (!destroyed && cabinAtRisk && cabinAtRisk[i]) {
          const pulse = 0.72 + 0.28 * Math.sin(elapsed * 7.5 + i);
          tmpCol.setRGB(1.0, 0.55 + 0.30 * pulse, 0.22 * pulse);
          this.windowMesh.setColorAt(i, tmpCol);
          winColDirty = true;
        } else if (!destroyed) {
          tmpCol.set('#ffd978');
          this.windowMesh.setColorAt(i, tmpCol);
          winColDirty = true;
        }
      }

      if (cabinMatDirty) {
        this.cabinMesh.instanceMatrix.needsUpdate = true;
        this.windowMesh.instanceMatrix.needsUpdate = true;
        this.ruinMesh.instanceMatrix.needsUpdate = true;
      }
      if (cabinColDirty && this.cabinMesh.instanceColor) {
        this.cabinMesh.instanceColor.needsUpdate = true;
      }
      if (winColDirty && this.windowMesh.instanceColor) {
        this.windowMesh.instanceColor.needsUpdate = true;
      }
      this.ruinMesh.visible = anyRuins;
    }
  }

  dispose() {
    if (this._texHandle) this._texHandle.unsubscribe();
    if (this._forest) this._forest.dispose();
    if (this.cabinMesh) this.cabinMesh.dispose();
    if (this.windowMesh) this.windowMesh.dispose();
    if (this.ruinMesh) this.ruinMesh.dispose();
    if (this.towerMesh) this.towerMesh.dispose();
    this._terrainGeo.dispose();
    this._terrainMat.dispose();
    this._cabinGeo.dispose();
    this._cabinMat.dispose();
    this._windowGeo.dispose();
    this._windowMat.dispose();
    this._ruinGeo.dispose();
    this._ruinMat.dispose();
    this._towerGeo.dispose();
    this._towerMat.dispose();
  }
}
