import * as THREE from 'three';

const COL_WATER_BED = new THREE.Color('#1d3d48');
const COL_SHORE = new THREE.Color('#94815a');
const COL_MEADOW = new THREE.Color('#94815a');
const COL_MEADOW_ALT = new THREE.Color('#867450');
const COL_FOREST = new THREE.Color('#3f5e4a');
const COL_RIDGE_LOW = new THREE.Color('#435451');
const COL_RIDGE_HIGH = new THREE.Color('#78637f');
const COL_PEAK_MID = new THREE.Color('#7f6585');
const COL_PEAK_HIGH = new THREE.Color('#9c788e');

const COL_CHARRED_GROUND = new THREE.Color('#2b2421');
const COL_BURNING_GROUND = new THREE.Color('#4a2417');
const COL_WET_TINT = new THREE.Color('#23505f');

const COL_PINE_LIGHT = new THREE.Color('#4d684f');
const COL_PINE_DARK = new THREE.Color('#2b433d');
const COL_PINE_CHARRED = new THREE.Color('#262324');
const COL_PINE_BURNING = new THREE.Color('#4b3022');
const COL_PINE_WET = new THREE.Color('#284c4c');

const COL_CABIN_LOG = new THREE.Color('#6d4c38');
const COL_CABIN_LOG_DARK = new THREE.Color('#543929');
const COL_CABIN_ROOF = new THREE.Color('#807e88');
const COL_CABIN_ROOF_DARK = new THREE.Color('#676570');
const COL_CABIN_CHIMNEY = new THREE.Color('#5a5862');
const COL_CABIN_RUIN = new THREE.Color('#262324');
const COL_CABIN_EMBER = new THREE.Color('#3a251d');

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
  }

  addTri(ax, ay, az, bx, by, bz, cx, cy, cz, color) {
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.colors.push(
      color.r, color.g, color.b,
      color.r, color.g, color.b,
      color.r, color.g, color.b
    );
  }

  addQuad(a, b, c, d, color) {
    this.addTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color);
    this.addTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color);
  }

  addBox(cx, cy, cz, sx, sy, sz, color, topColor = color, sideDark = color) {
    const x0 = cx - sx * 0.5;
    const x1 = cx + sx * 0.5;
    const y0 = cy - sy * 0.5;
    const y1 = cy + sy * 0.5;
    const z0 = cz - sz * 0.5;
    const z1 = cz + sz * 0.5;

    // Top (+Y)
    this.addQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], topColor);
    // Bottom (-Y)
    this.addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], sideDark);
    // Front (-Z)
    this.addQuad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], color);
    // Back (+Z)
    this.addQuad([x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [x1, y0, z1], color);
    // Right (+X)
    this.addQuad([x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [x1, y0, z0], sideDark);
    // Left (-X)
    this.addQuad([x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], sideDark);
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
    geom.computeVertexNormals();
    return geom;
  }
}

/**
 * Builds 3-tier conical low-poly pine tree geometry with neutral vertex shades
 * so InstancedMesh instanceColor cleanly tints intact/burning/charred/wet states.
 */
function buildPineGeometry() {
  const b = new ColoredPolyBuilder();
  const trunkCol = new THREE.Color(0.50, 0.36, 0.28);
  const tier1Col = new THREE.Color(0.76, 0.78, 0.76);
  const tier2Col = new THREE.Color(0.90, 0.92, 0.90);
  const tier3Col = new THREE.Color(1.00, 1.00, 1.00);

  // Trunk
  b.addCylinder(0, -0.4, 0, 0.45, 0.30, 3.0, 5, trunkCol);
  // 3 stacked conical foliage tiers
  b.addCone(0, 2.2, 0, 3.15, 4.6, 6, tier1Col);
  b.addCone(0, 5.2, 0, 2.45, 4.3, 6, tier2Col);
  b.addCone(0, 8.0, 0, 1.65, 3.8, 6, tier3Col);

  return b.build();
}

/**
 * Builds an intact timber cabin (log walls #6d4c38, gabled gray roof #807e88, chimney).
 */
function buildCabinGeometry() {
  const b = new ColoredPolyBuilder();
  const w = 9.0;
  const d = 6.6;
  const h = 4.2;
  const ridgeH = 2.9;

  // Foundation plinth + log walls
  b.addBox(0, h * 0.5 - 0.3, 0, w, h + 0.6, d, COL_CABIN_LOG, COL_CABIN_LOG, COL_CABIN_LOG_DARK);

  // Gable triangles on left (-X) and right (+X) ends
  const hx = w * 0.5;
  const hz = d * 0.5;
  b.addTri(hx, h, -hz, hx, h, hz, hx, h + ridgeH, 0, COL_CABIN_LOG_DARK);
  b.addTri(-hx, h, hz, -hx, h, -hz, -hx, h + ridgeH, 0, COL_CABIN_LOG_DARK);

  // Overhanging gabled gray roof panels (#807e88)
  const rx = hx + 0.65;
  const rz = hz + 0.75;
  const eaveY = h - 0.35;
  const peakY = h + ridgeH + 0.2;

  // North slope (-Z)
  b.addQuad([-rx, peakY, 0], [rx, peakY, 0], [rx, eaveY, -rz], [-rx, eaveY, -rz], COL_CABIN_ROOF);
  // South slope (+Z)
  b.addQuad([rx, peakY, 0], [-rx, peakY, 0], [-rx, eaveY, rz], [rx, eaveY, rz], COL_CABIN_ROOF_DARK);
  // Roof underside / soffit caps so viewing from below stays solid
  b.addQuad([rx, peakY, 0], [-rx, peakY, 0], [-rx, eaveY, -rz], [rx, eaveY, -rz], COL_CABIN_ROOF_DARK);
  b.addQuad([-rx, peakY, 0], [rx, peakY, 0], [rx, eaveY, rz], [-rx, eaveY, rz], COL_CABIN_ROOF_DARK);

  // Stone chimney rising through roof
  b.addBox(2.2, h + ridgeH * 0.65, -1.2, 1.35, 3.6, 1.35, COL_CABIN_CHIMNEY, COL_CABIN_ROOF_DARK, COL_CABIN_CHIMNEY);

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

    this._cellCount = cellCount;
    this._cellBaseColors = new Float32Array(cellCount * 3);
    this._cellStates = new Uint8Array(cellCount);

    const positions = [];
    const colors = [];
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

        // Alternate quad diagonal for organic alpine low-poly triangulation
        // Outward (+Y) winding:
        if (((gx + gz) & 1) === 0) {
          positions.push(
            x0, h00, z0, x0, h01, z1, x1, h10, z0,
            x1, h10, z0, x0, h01, z1, x1, h11, z1
          );
        } else {
          positions.push(
            x0, h00, z0, x0, h01, z1, x1, h11, z1,
            x0, h00, z0, x1, h11, z1, x1, h10, z0
          );
        }

        for (let v = 0; v < 6; v++) {
          colors.push(tmpCol.r, tmpCol.g, tmpCol.b);
        }
      }
    }

    // Stitch dramatic outer alpine mountain ring into same single-draw-call geometry
    appendOuterMountainRing(terrain, positions, colors);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this._terrainColorAttr = new THREE.Float32BufferAttribute(colors, 3);
    geom.setAttribute('color', this._terrainColorAttr);
    geom.computeVertexNormals();

    this._terrainGeo = geom;
    this._terrainMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      vertexColors: true,
    });
    this.terrainMesh = new THREE.Mesh(geom, this._terrainMat);
    this.terrainMesh.name = 'AlpineTerrain';
    this.group.add(this.terrainMesh);
  }

  _buildPines(terrain) {
    const trees = terrain.trees || [];
    this._trees = trees;
    const count = trees.length;
    this._treeCount = count;

    // Fast linked-list lookup: cellIdx -> trees in that cell
    this._cellTreeHead = new Int32Array(this._cellCount);
    this._cellTreeHead.fill(-1);
    this._treeNext = new Int32Array(count);
    this._treeBaseColors = new Float32Array(count * 3);
    this._treeBaseScales = new Float32Array(count);
    this._treeYaws = new Float32Array(count);
    this._treeCharred = new Uint8Array(count);

    this._pineGeo = buildPineGeometry();
    this._pineMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      vertexColors: true,
    });

    if (count === 0) {
      this.pineMesh = null;
      return;
    }

    this.pineMesh = new THREE.InstancedMesh(this._pineGeo, this._pineMat, count);
    this.pineMesh.name = 'AlpinePines';
    this.pineMesh.frustumCulled = false;

    const tmpCol = this._tmpColor;
    for (let i = 0; i < count; i++) {
      const t = trees[i];
      const cellIdx = t.cellIdx;
      if (cellIdx >= 0 && cellIdx < this._cellCount) {
        this._treeNext[i] = this._cellTreeHead[cellIdx];
        this._cellTreeHead[cellIdx] = i;
      } else {
        this._treeNext[i] = -1;
      }

      const scale = t.scale || 1.0;
      const yaw = hash2(t.x * 0.13, t.z * 0.17) * Math.PI * 2;
      this._treeBaseScales[i] = scale;
      this._treeYaws[i] = yaw;

      this._tmpPos.set(t.x, t.y - 0.15, t.z);
      this._tmpQuat.setFromAxisAngle(this._upAxis, yaw);
      this._tmpScale.set(scale, scale, scale);
      this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
      this.pineMesh.setMatrixAt(i, this._tmpMat);

      const tint = t.tint !== undefined ? t.tint : hash2(t.x, t.z);
      tmpCol.copy(COL_PINE_DARK).lerp(COL_PINE_LIGHT, tint);
      this._treeBaseColors[i * 3] = tmpCol.r;
      this._treeBaseColors[i * 3 + 1] = tmpCol.g;
      this._treeBaseColors[i * 3 + 2] = tmpCol.b;
      this.pineMesh.setColorAt(i, tmpCol);
    }

    this.pineMesh.instanceMatrix.needsUpdate = true;
    if (this.pineMesh.instanceColor) {
      this.pineMesh.instanceColor.needsUpdate = true;
    }
    this.group.add(this.pineMesh);
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
    this._cabinMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      vertexColors: true,
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
   * Fast partial update of terrain vertex colors, pine charring, and cabin states
   * driven by FireSim dirtyIndices (or full pass when dirtyIndices is null).
   */
  syncFireState(cells, dirtyIndices, cabinHp, cabinAtRisk, elapsed = 0) {
    let terrainDirty = false;
    let pineColorDirty = false;
    let pineMatDirty = false;

    const colorArr = this._terrainColorAttr.array;
    const baseColors = this._cellBaseColors;
    const tmpCol = this._tmpColor;

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
        // Charred earth (#2b2421)
        r = COL_CHARRED_GROUND.r;
        g = COL_CHARRED_GROUND.g;
        b = COL_CHARRED_GROUND.b;
      } else if (st >= 1 && st <= 12) {
        // Active burn scorches terrain under fire
        const t = Math.min(1, 0.35 + (st / 12) * 0.65);
        r = br + (COL_BURNING_GROUND.r - br) * t;
        g = bg + (COL_BURNING_GROUND.g - bg) * t;
        b = bb + (COL_BURNING_GROUND.b - bb) * t;
      } else if (st === 13) {
        // Wet / steam cooldown dampened tint
        r = br * 0.68 + COL_WET_TINT.r * 0.32;
        g = bg * 0.68 + COL_WET_TINT.g * 0.32;
        b = bb * 0.68 + COL_WET_TINT.b * 0.32;
      } else if (st === 15) {
        // Ember warning slight warm glow on ground
        r = Math.min(1, br * 1.12 + 0.08);
        g = br * 0.55 + bg * 0.45;
        b = bb * 0.72;
      }

      const vOffset = idx * 18; // 6 vertices * 3 floats
      for (let k = 0; k < 6; k++) {
        const o = vOffset + k * 3;
        colorArr[o] = r;
        colorArr[o + 1] = g;
        colorArr[o + 2] = b;
      }
      terrainDirty = true;

      // Update pines standing on this cell
      if (this.pineMesh) {
        let ti = this._cellTreeHead[idx];
        while (ti !== -1) {
          const tb3 = ti * 3;
          const wasCharred = this._treeCharred[ti];
          let isCharred = 0;

          if (st === 14) {
            tmpCol.copy(COL_PINE_CHARRED);
            isCharred = 1;
          } else if (st >= 1 && st <= 12) {
            const bt = Math.min(1, 0.25 + (st / 12) * 0.75);
            tmpCol.setRGB(
              this._treeBaseColors[tb3] + (COL_PINE_BURNING.r - this._treeBaseColors[tb3]) * bt,
              this._treeBaseColors[tb3 + 1] + (COL_PINE_BURNING.g - this._treeBaseColors[tb3 + 1]) * bt,
              this._treeBaseColors[tb3 + 2] + (COL_PINE_BURNING.b - this._treeBaseColors[tb3 + 2]) * bt
            );
          } else if (st === 13) {
            tmpCol.setRGB(
              this._treeBaseColors[tb3] * 0.65 + COL_PINE_WET.r * 0.35,
              this._treeBaseColors[tb3 + 1] * 0.65 + COL_PINE_WET.g * 0.35,
              this._treeBaseColors[tb3 + 2] * 0.65 + COL_PINE_WET.b * 0.35
            );
          } else {
            tmpCol.setRGB(
              this._treeBaseColors[tb3],
              this._treeBaseColors[tb3 + 1],
              this._treeBaseColors[tb3 + 2]
            );
          }

          this.pineMesh.setColorAt(ti, tmpCol);
          pineColorDirty = true;

          // Shrink charred pines into narrow dark burned skeletons (or restore on wave reset)
          if (isCharred !== wasCharred) {
            this._treeCharred[ti] = isCharred;
            const tr = this._trees[ti];
            const sc = this._treeBaseScales[ti];
            this._tmpPos.set(tr.x, tr.y - 0.15, tr.z);
            this._tmpQuat.setFromAxisAngle(this._upAxis, this._treeYaws[ti]);
            if (isCharred) {
              this._tmpScale.set(sc * 0.56, sc * 0.88, sc * 0.56);
            } else {
              this._tmpScale.set(sc, sc, sc);
            }
            this._tmpMat.compose(this._tmpPos, this._tmpQuat, this._tmpScale);
            this.pineMesh.setMatrixAt(ti, this._tmpMat);
            pineMatDirty = true;
          }

          ti = this._treeNext[ti];
        }
      }
    };

    if (cells) {
      if (dirtyIndices && dirtyIndices.length > 0) {
        for (let i = 0; i < dirtyIndices.length; i++) {
          updateCell(dirtyIndices[i]);
        }
      } else if (dirtyIndices === null) {
        for (let idx = 0; idx < this._cellCount; idx++) {
          updateCell(idx);
        }
      }
    }

    if (terrainDirty) {
      this._terrainColorAttr.needsUpdate = true;
    }
    if (pineColorDirty && this.pineMesh && this.pineMesh.instanceColor) {
      this.pineMesh.instanceColor.needsUpdate = true;
    }
    if (pineMatDirty && this.pineMesh) {
      this.pineMesh.instanceMatrix.needsUpdate = true;
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
    if (this.pineMesh) this.pineMesh.dispose();
    if (this.cabinMesh) this.cabinMesh.dispose();
    if (this.windowMesh) this.windowMesh.dispose();
    if (this.ruinMesh) this.ruinMesh.dispose();
    if (this.towerMesh) this.towerMesh.dispose();
    this._terrainGeo.dispose();
    this._terrainMat.dispose();
    this._pineGeo.dispose();
    this._pineMat.dispose();
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
