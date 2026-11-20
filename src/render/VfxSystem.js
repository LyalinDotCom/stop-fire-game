import * as THREE from 'three';
import { createSmokeBayerMaterial } from './SmokeBayerShader.js';

const G_DROP = -15.5;
const WIND_DRIFT_FACTOR = 0.35;

const MAX_FLAMES = 2400;
const MAX_EMBERS = 900;
const MAX_SMOKE = 420;
const MAX_WATER_PUFFS = 480;
const MAX_STEAM_PUFFS = 320;
const MAX_WAKE_PUFFS = 220;

const COL_FLAME_YELLOW = new THREE.Color('#fff275');
const COL_FLAME_ORANGE = new THREE.Color('#ff6f00');
const COL_FLAME_RED = new THREE.Color('#e0542d');
const COL_EMBER_WARN = new THREE.Color('#ffb84d');
const COL_WATER_A = new THREE.Color('#d7cab3');
const COL_WATER_B = new THREE.Color('#d8e6e6');
const COL_STEAM = new THREE.Color('#d8e6e6');
const COL_WAKE_WHITE = new THREE.Color('#d8e6e6');
const COL_WAKE_CYAN = new THREE.Color('#9ecad0');

/**
 * Builds a layered jagged 3-spire canopy flame cluster geometry (vertex colored:
 * outer #e0542d -> mid #ff6f00 -> incandescent core #fff275).
 */
function buildFlameGeometry() {
  const positions = [];
  const colors = [];

  const pushTri = (a, b, c, ca, cb, cc) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    colors.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
  };

  // Helper to add a jagged 4-sided flame spire
  const addSpire = (ox, oz, baseR, height, tiltX, tiltZ, botCol, tipCol) => {
    const tip = [ox + tiltX, height, oz + tiltZ];
    const pts = [
      [ox - baseR, 0, oz],
      [ox, 0, oz - baseR],
      [ox + baseR, 0, oz],
      [ox, 0, oz + baseR],
    ];
    for (let i = 0; i < 4; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % 4];
      pushTri(p0, p1, tip, botCol, botCol, tipCol);
      // Backface so flames are readable from every camera angle
      pushTri(p1, p0, tip, botCol, botCol, tipCol);
    }
  };

  // Outer vermilion-red jagged tongues
  addSpire(-1.1, 0.4, 1.85, 6.2, -0.45, 0.25, COL_FLAME_RED, COL_FLAME_ORANGE);
  addSpire(1.0, -0.5, 1.70, 5.6, 0.40, -0.30, COL_FLAME_RED, COL_FLAME_ORANGE);
  // Middle bright orange canopy flame
  addSpire(0.0, 0.0, 2.10, 8.4, 0.15, 0.10, COL_FLAME_ORANGE, COL_FLAME_YELLOW);
  // Inner incandescent yellow core
  addSpire(0.15, -0.1, 1.15, 5.2, -0.10, 0.05, COL_FLAME_YELLOW, COL_FLAME_YELLOW);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geom;
}

/**
 * Builds a crisp non-indexed flat-shaded low-poly icosahedron for retro puffs.
 */
function buildPuffGeometry() {
  const geo = new THREE.IcosahedronGeometry(1.0, 0);
  const nonIndexed = geo.index ? geo.toNonIndexed() : geo;
  if (nonIndexed !== geo) geo.dispose();
  nonIndexed.computeVertexNormals();
  return nonIndexed;
}

/**
 * Builds the translucent cyan-white oval DROP ZONE reticle texture.
 */
function createDropReticleTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Soft cyan fill
  const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 58);
  grad.addColorStop(0, 'rgba(92, 225, 230, 0.22)');
  grad.addColorStop(0.72, 'rgba(92, 225, 230, 0.10)');
  grad.addColorStop(1, 'rgba(92, 225, 230, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.fill();

  // Crisp dashed outer ring
  ctx.strokeStyle = 'rgba(216, 230, 230, 0.88)';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 8]);
  ctx.beginPath();
  ctx.arc(cx, cy, 54, 0, Math.PI * 2);
  ctx.stroke();

  // Inner cyan ring
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(92, 225, 230, 0.85)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.stroke();

  // Cardinal tick marks
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 3;
  const ticks = [
    [cx, 4, cx, 18],
    [cx, size - 18, cx, size - 4],
    [4, cy, 18, cy],
    [size - 18, cy, size - 4, cy],
  ];
  for (const [x0, y0, x1, y1] of ticks) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Pooled retro-3D VFX system rendered strictly inside the 640x360 WebGL pass.
 * Zero per-frame allocations in all update/spawn loops.
 */
export class VfxSystem {
  constructor(terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'VfxSystem';

    // Scratch math objects
    this._mat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._scale = new THREE.Vector3();
    this._col = new THREE.Color();

    // Active cell lists synced from FireSim
    this._maxCells = terrain.gridSize * terrain.gridSize;
    this._burnCells = new Int32Array(this._maxCells);
    this._burnIntensity = new Uint8Array(this._maxCells);
    this._burnCount = 0;

    this._emberWarnCells = new Int32Array(this._maxCells);
    this._emberWarnCount = 0;

    this._wetCells = new Int32Array(this._maxCells);
    this._wetCount = 0;

    // Timers for continuous emission
    this._smokeAccum = 0;
    this._emberAccum = 0;
    this._wetMistAccum = 0;
    this._wakeAccum = 0;
    this._remoteDropAccum = 0;
    this._rngState = 1337;

    this._initFlames();
    this._initEmbers();
    this._initSmoke();
    this._initWaterPuffs();
    this._initSteamPuffs();
    this._initWakes();
    this._initDropReticle();
  }

  _rand() {
    let x = this._rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this._rngState = x;
    return ((x >>> 0) % 10000) * 0.0001;
  }

  _initFlames() {
    this._flameGeo = buildFlameGeometry();
    this._flameMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: true,
    });
    this.flameMesh = new THREE.InstancedMesh(this._flameGeo, this._flameMat, MAX_FLAMES);
    this.flameMesh.name = 'CanopyFlames';
    this.flameMesh.frustumCulled = false;
    this.flameMesh.setColorAt(0, this._col.setHex(0xffffff));
    this.flameMesh.count = 0;
    this.group.add(this.flameMesh);
  }

  _initEmbers() {
    this._emberPos = new Float32Array(MAX_EMBERS * 3);
    this._emberVel = new Float32Array(MAX_EMBERS * 3);
    this._emberLife = new Float32Array(MAX_EMBERS);
    this._emberMaxLife = new Float32Array(MAX_EMBERS);
    this._emberCursor = 0;

    // Move inactive embers below ground
    for (let i = 0; i < MAX_EMBERS; i++) {
      this._emberPos[i * 3 + 1] = -9999;
    }

    this._emberGeo = new THREE.BufferGeometry();
    this._emberPosAttr = new THREE.BufferAttribute(this._emberPos, 3);
    this._emberGeo.setAttribute('position', this._emberPosAttr);

    this._emberMat = new THREE.PointsMaterial({
      color: new THREE.Color('#ffb84d'),
      size: 1.6,
      sizeAttenuation: false,
      fog: true,
      depthWrite: false,
    });
    this.emberPoints = new THREE.Points(this._emberGeo, this._emberMat);
    this.emberPoints.name = 'GlowingEmbers';
    this.emberPoints.frustumCulled = false;
    this.group.add(this.emberPoints);
  }

  _initSmoke() {
    this._smokeGeo = buildPuffGeometry();
    this._smokeOpacityArr = new Float32Array(MAX_SMOKE);
    this._smokeGlowArr = new Float32Array(MAX_SMOKE);
    this._smokeOpacityAttr = new THREE.InstancedBufferAttribute(this._smokeOpacityArr, 1);
    this._smokeGlowAttr = new THREE.InstancedBufferAttribute(this._smokeGlowArr, 1);
    this._smokeGeo.setAttribute('aOpacity', this._smokeOpacityAttr);
    this._smokeGeo.setAttribute('aFireGlow', this._smokeGlowAttr);

    this._smokeMat = createSmokeBayerMaterial();
    this.smokeMesh = new THREE.InstancedMesh(this._smokeGeo, this._smokeMat, MAX_SMOKE);
    this.smokeMesh.name = 'BayerSmokePlumes';
    this.smokeMesh.frustumCulled = false;
    this.smokeMesh.count = 0;
    this.group.add(this.smokeMesh);

    this._smokePos = new Float32Array(MAX_SMOKE * 3);
    this._smokeVel = new Float32Array(MAX_SMOKE * 3);
    this._smokeAge = new Float32Array(MAX_SMOKE);
    this._smokeLife = new Float32Array(MAX_SMOKE);
    this._smokeBaseScale = new Float32Array(MAX_SMOKE);
    this._smokeRot = new Float32Array(MAX_SMOKE * 2);
    this._smokeCursor = 0;
  }

  _initWaterPuffs() {
    this._waterGeo = buildPuffGeometry();
    this._waterMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      color: 0xffffff,
      emissive: new THREE.Color('#8cb5be'),
      emissiveIntensity: 0.48,
    });
    this.waterMesh = new THREE.InstancedMesh(this._waterGeo, this._waterMat, MAX_WATER_PUFFS);
    this.waterMesh.name = 'WaterDropCurtain';
    this.waterMesh.frustumCulled = false;
    this.waterMesh.setColorAt(0, COL_WATER_B);
    this.waterMesh.count = 0;
    this.group.add(this.waterMesh);

    this._waterPos = new Float32Array(MAX_WATER_PUFFS * 3);
    this._waterVel = new Float32Array(MAX_WATER_PUFFS * 3);
    this._waterWind = new Float32Array(MAX_WATER_PUFFS * 2);
    this._waterAge = new Float32Array(MAX_WATER_PUFFS);
    this._waterLife = new Float32Array(MAX_WATER_PUFFS);
    this._waterScale = new Float32Array(MAX_WATER_PUFFS);
    this._waterColorMix = new Float32Array(MAX_WATER_PUFFS);
    this._waterCursor = 0;
  }

  _initSteamPuffs() {
    this._steamGeo = buildPuffGeometry();
    this._steamMat = new THREE.MeshLambertMaterial({
      flatShading: true,
      color: 0xffffff,
      transparent: true,
      opacity: 0.70,
      depthWrite: false,
    });
    this.steamMesh = new THREE.InstancedMesh(this._steamGeo, this._steamMat, MAX_STEAM_PUFFS);
    this.steamMesh.name = 'ImpactSteamMist';
    this.steamMesh.frustumCulled = false;
    this.steamMesh.setColorAt(0, COL_STEAM);
    this.steamMesh.count = 0;
    this.group.add(this.steamMesh);

    this._steamPos = new Float32Array(MAX_STEAM_PUFFS * 3);
    this._steamVel = new Float32Array(MAX_STEAM_PUFFS * 3);
    this._steamAge = new Float32Array(MAX_STEAM_PUFFS);
    this._steamLife = new Float32Array(MAX_STEAM_PUFFS);
    this._steamBaseScale = new Float32Array(MAX_STEAM_PUFFS);
    this._steamTint = new Float32Array(MAX_STEAM_PUFFS);
    this._steamCursor = 0;
  }

  _initWakes() {
    this._wakeGeo = new THREE.PlaneGeometry(1.0, 1.0);
    this._wakeGeo.rotateX(-Math.PI / 2);
    this._wakeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.wakeMesh = new THREE.InstancedMesh(this._wakeGeo, this._wakeMat, MAX_WAKE_PUFFS);
    this.wakeMesh.name = 'PontoonFoamWakes';
    this.wakeMesh.frustumCulled = false;
    this.wakeMesh.setColorAt(0, COL_WAKE_WHITE);
    this.wakeMesh.count = 0;
    this.group.add(this.wakeMesh);

    this._wakePos = new Float32Array(MAX_WAKE_PUFFS * 3);
    this._wakeYaw = new Float32Array(MAX_WAKE_PUFFS);
    this._wakeAge = new Float32Array(MAX_WAKE_PUFFS);
    this._wakeLife = new Float32Array(MAX_WAKE_PUFFS);
    this._wakeCursor = 0;
  }

  _initDropReticle() {
    this._reticleTex = createDropReticleTexture();
    this._reticleGeo = new THREE.PlaneGeometry(2.0, 2.0);
    this._reticleGeo.rotateX(-Math.PI / 2);
    this._reticleMat = new THREE.MeshBasicMaterial({
      map: this._reticleTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.78,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.reticleMesh = new THREE.Mesh(this._reticleGeo, this._reticleMat);
    this.reticleMesh.name = 'DropZoneReticle';
    this.reticleMesh.visible = false;
    this.group.add(this.reticleMesh);
  }

  /**
   * Resets all pools and binds to a new TerrainData when switching operations/modes.
   */
  resetForTerrain(terrain) {
    this.terrain = terrain;
    const cellCount = terrain.gridSize * terrain.gridSize;
    if (cellCount !== this._maxCells) {
      this._maxCells = cellCount;
      this._burnCells = new Int32Array(cellCount);
      this._burnIntensity = new Uint8Array(cellCount);
      this._emberWarnCells = new Int32Array(cellCount);
      this._wetCells = new Int32Array(cellCount);
    }
    this._burnCount = 0;
    this._emberWarnCount = 0;
    this._wetCount = 0;

    this._emberLife.fill(0);
    for (let i = 0; i < MAX_EMBERS; i++) this._emberPos[i * 3 + 1] = -9999;
    this._emberPosAttr.needsUpdate = true;

    this._smokeLife.fill(0);
    this._waterLife.fill(0);
    this._steamLife.fill(0);
    this._wakeLife.fill(0);

    this.flameMesh.count = 0;
    this.smokeMesh.count = 0;
    this.waterMesh.count = 0;
    this.steamMesh.count = 0;
    this.wakeMesh.count = 0;
    this.reticleMesh.visible = false;
  }

  /**
   * Rebuilds compact active burning / ember-warning / wet cell lists from FireSim grid.
   */
  syncFireCells(cells) {
    if (!cells) return;
    let bCount = 0;
    let eCount = 0;
    let wCount = 0;
    const len = Math.min(cells.length, this._maxCells);
    for (let i = 0; i < len; i++) {
      const s = cells[i];
      if (s >= 1 && s <= 12) {
        this._burnCells[bCount] = i;
        this._burnIntensity[bCount] = s;
        bCount++;
      } else if (s === 15) {
        this._emberWarnCells[eCount++] = i;
      } else if (s === 13) {
        this._wetCells[wCount++] = i;
      }
    }
    this._burnCount = bCount;
    this._emberWarnCount = eCount;
    this._wetCount = wCount;
  }

  /**
   * Spawns ballistic billowing water drop curtain puffs following exact g_drop=-15.5, a_wind=0.35*W.
   */
  spawnDropVisual(x, y, z, vx, vy, vz, windVx, windVz) {
    const burstCount = 5;
    for (let k = 0; k < burstCount; k++) {
      const i = this._waterCursor;
      this._waterCursor = (i + 1) % MAX_WATER_PUFFS;
      const o3 = i * 3;
      const o2 = i * 2;

      const spreadX = (this._rand() - 0.5) * 1.25;
      const spreadY = (this._rand() - 0.5) * 0.7 - 1.65;
      const spreadZ = (this._rand() - 0.5) * 1.25;

      this._waterPos[o3] = x + spreadX;
      this._waterPos[o3 + 1] = y + spreadY;
      this._waterPos[o3 + 2] = z + spreadZ;

      this._waterVel[o3] = vx * 0.84 + (this._rand() - 0.5) * 3.2;
      this._waterVel[o3 + 1] = vy - 4.2 - this._rand() * 2.2;
      this._waterVel[o3 + 2] = vz * 0.84 + (this._rand() - 0.5) * 3.2;

      this._waterWind[o2] = windVx || 0;
      this._waterWind[o2 + 1] = windVz || 0;

      this._waterAge[i] = 0;
      this._waterLife[i] = 3.2 + this._rand() * 1.0;
      this._waterScale[i] = 0.85 + this._rand() * 0.55;
      this._waterColorMix[i] = this._rand();
    }
  }

  /**
   * Spawns billowing steam bursts on water impact (stronger when fire is extinguished).
   */
  spawnImpactSteam(x, y, z, extinguished = true) {
    const count = extinguished ? 10 : 5;
    for (let k = 0; k < count; k++) {
      const i = this._steamCursor;
      this._steamCursor = (i + 1) % MAX_STEAM_PUFFS;
      const o3 = i * 3;

      const ang = this._rand() * Math.PI * 2;
      const rad = this._rand() * (extinguished ? 10.0 : 5.5);
      this._steamPos[o3] = x + Math.cos(ang) * rad;
      this._steamPos[o3 + 1] = y + 1.2 + this._rand() * 2.5;
      this._steamPos[o3 + 2] = z + Math.sin(ang) * rad;

      this._steamVel[o3] = Math.cos(ang) * (2.5 + this._rand() * 5.0);
      this._steamVel[o3 + 1] = (extinguished ? 8.5 : 4.5) + this._rand() * 5.5;
      this._steamVel[o3 + 2] = Math.sin(ang) * (2.5 + this._rand() * 5.0);

      this._steamAge[i] = 0;
      this._steamLife[i] = (extinguished ? 2.4 : 1.3) + this._rand() * 1.2;
      this._steamBaseScale[i] = (extinguished ? 3.2 : 1.9) + this._rand() * 1.8;
      this._steamTint[i] = extinguished ? 1.0 : 0.65;
    }
  }

  _spawnSmokePuff(x, y, z, windVx, windVz, intensityNorm) {
    const i = this._smokeCursor;
    this._smokeCursor = (i + 1) % MAX_SMOKE;
    const o3 = i * 3;
    const o2 = i * 2;

    this._smokePos[o3] = x + (this._rand() - 0.5) * 9.0;
    this._smokePos[o3 + 1] = y + 5.5 + this._rand() * 4.5;
    this._smokePos[o3 + 2] = z + (this._rand() - 0.5) * 9.0;

    this._smokeVel[o3] = windVx * (0.75 + this._rand() * 0.45) + (this._rand() - 0.5) * 2.5;
    this._smokeVel[o3 + 1] = 10.5 + intensityNorm * 7.5 + this._rand() * 4.0;
    this._smokeVel[o3 + 2] = windVz * (0.75 + this._rand() * 0.45) + (this._rand() - 0.5) * 2.5;

    this._smokeAge[i] = 0;
    this._smokeLife[i] = 4.5 + this._rand() * 3.8;
    this._smokeBaseScale[i] = 4.2 + intensityNorm * 3.6 + this._rand() * 2.2;
    this._smokeRot[o2] = this._rand() * Math.PI * 2;
    this._smokeRot[o2 + 1] = (this._rand() - 0.5) * 0.9;
  }

  _spawnEmberSpark(x, y, z, windVx, windVz) {
    const i = this._emberCursor;
    this._emberCursor = (i + 1) % MAX_EMBERS;
    const o3 = i * 3;

    this._emberPos[o3] = x + (this._rand() - 0.5) * 11.0;
    this._emberPos[o3 + 1] = y + 3.0 + this._rand() * 6.0;
    this._emberPos[o3 + 2] = z + (this._rand() - 0.5) * 11.0;

    this._emberVel[o3] = windVx * (0.9 + this._rand() * 0.6) + (this._rand() - 0.5) * 6.0;
    this._emberVel[o3 + 1] = 9.0 + this._rand() * 14.0;
    this._emberVel[o3 + 2] = windVz * (0.9 + this._rand() * 0.6) + (this._rand() - 0.5) * 6.0;

    const life = 2.0 + this._rand() * 2.8;
    this._emberLife[i] = life;
    this._emberMaxLife[i] = life;
  }

  _spawnWakePair(x, z, yawDeg, waterLevel) {
    const yawRad = (yawDeg || 0) * (Math.PI / 180);
    // Forward = (sin(yaw), -cos(yaw)); Right = (cos(yaw), sin(yaw))
    const fx = Math.sin(yawRad);
    const fz = -Math.cos(yawRad);
    const rx = Math.cos(yawRad);
    const rz = Math.sin(yawRad);

    for (let s = -1; s <= 1; s += 2) {
      const i = this._wakeCursor;
      this._wakeCursor = (i + 1) % MAX_WAKE_PUFFS;
      const o3 = i * 3;

      this._wakePos[o3] = x + rx * (s * 1.55) - fx * 2.4;
      this._wakePos[o3 + 1] = waterLevel + 0.16;
      this._wakePos[o3 + 2] = z + rz * (s * 1.55) - fz * 2.4;
      this._wakeYaw[i] = -yawRad;
      this._wakeAge[i] = 0;
      this._wakeLife[i] = 1.65;
    }
  }

  /**
   * Advances all VFX pools and updates GPU buffers for the current frame.
   */
  update({ dt, elapsed, localAircraft, remotePlanes, fireSnapshot, showDropReticle, dropPreview }) {
    const safeDt = Math.min(dt || 0.016, 0.05);
    const terrain = this.terrain;
    const gs = terrain.gridSize;
    const cs = terrain.cellSize;
    const half = terrain.halfWorld;
    const cellHeights = terrain.cellHeights;
    const windVx = fireSnapshot ? (fireSnapshot.windVx || 0) : 0;
    const windVz = fireSnapshot ? (fireSnapshot.windVz || 0) : 0;

    // 1. Update layered animated canopy flames + ember-spot warnings
    this._updateFlames(elapsed, gs, cs, half, cellHeights, windVx, windVz);

    // 2. Emit smoke plumes & glowing embers from active burn cells
    if (this._burnCount > 0) {
      const smokeRate = Math.min(72, 12 + this._burnCount * 0.24);
      this._smokeAccum += safeDt * smokeRate;
      while (this._smokeAccum >= 1.0) {
        this._smokeAccum -= 1.0;
        const pick = Math.floor(this._rand() * this._burnCount);
        const idx = this._burnCells[pick];
        const gx = idx % gs;
        const gz = (idx / gs) | 0;
        const wx = (gx + 0.5) * cs - half;
        const wz = (gz + 0.5) * cs - half;
        const wy = cellHeights[idx];
        this._spawnSmokePuff(wx, wy, wz, windVx, windVz, this._burnIntensity[pick] / 12.0);
      }

      const emberRate = Math.min(210, 30 + this._burnCount * 0.75);
      this._emberAccum += safeDt * emberRate;
      while (this._emberAccum >= 1.0) {
        this._emberAccum -= 1.0;
        const pick = Math.floor(this._rand() * this._burnCount);
        const idx = this._burnCells[pick];
        const gx = idx % gs;
        const gz = (idx / gs) | 0;
        const wx = (gx + 0.5) * cs - half;
        const wz = (gz + 0.5) * cs - half;
        const wy = cellHeights[idx];
        this._spawnEmberSpark(wx, wy, wz, windVx, windVz);
      }
    }

    // 3. Emit lingering wet-cell mist (state 13)
    if (this._wetCount > 0) {
      const mistRate = Math.min(28, 3 + this._wetCount * 0.14);
      this._wetMistAccum += safeDt * mistRate;
      while (this._wetMistAccum >= 1.0) {
        this._wetMistAccum -= 1.0;
        const pick = Math.floor(this._rand() * this._wetCount);
        const idx = this._wetCells[pick];
        const gx = idx % gs;
        const gz = (idx / gs) | 0;
        const wx = (gx + 0.5) * cs - half + (this._rand() - 0.5) * cs * 0.7;
        const wz = (gz + 0.5) * cs - half + (this._rand() - 0.5) * cs * 0.7;
        const wy = cellHeights[idx];

        const si = this._steamCursor;
        this._steamCursor = (si + 1) % MAX_STEAM_PUFFS;
        const o3 = si * 3;
        this._steamPos[o3] = wx;
        this._steamPos[o3 + 1] = wy + 1.5;
        this._steamPos[o3 + 2] = wz;
        this._steamVel[o3] = windVx * 0.28;
        this._steamVel[o3 + 1] = 2.6 + this._rand() * 2.2;
        this._steamVel[o3 + 2] = windVz * 0.28;
        this._steamAge[si] = 0;
        this._steamLife[si] = 2.6 + this._rand() * 1.4;
        this._steamBaseScale[si] = 2.0 + this._rand() * 1.4;
        this._steamTint[si] = 0.82;
      }
    }

    // 4. Emit twin pontoon foam wakes for hero + scooping remote planes, plus remote water curtains
    this._wakeAccum += safeDt;
    if (this._wakeAccum >= 0.045) {
      this._wakeAccum = 0;
      if (localAircraft && localAircraft.scooping) {
        this._spawnWakePair(localAircraft.x, localAircraft.z, localAircraft.yawDeg, terrain.waterLevel);
      }
      if (remotePlanes && remotePlanes.length > 0) {
        for (let i = 0; i < remotePlanes.length; i++) {
          const rp = remotePlanes[i];
          if (rp.scooping) {
            this._spawnWakePair(rp.x, rp.z, rp.yawDeg, terrain.waterLevel);
          }
        }
      }
    }

    this._remoteDropAccum += safeDt;
    if (this._remoteDropAccum >= 0.09 && remotePlanes && remotePlanes.length > 0) {
      this._remoteDropAccum = 0;
      for (let i = 0; i < remotePlanes.length; i++) {
        const rp = remotePlanes[i];
        if (rp.releasing) {
          const yawRad = (rp.yawDeg || 0) * (Math.PI / 180);
          const vMs = (rp.speedKmh || 158) / 3.6;
          this.spawnDropVisual(
            rp.x, rp.y - 1.2, rp.z,
            Math.sin(yawRad) * vMs, 0, -Math.cos(yawRad) * vMs,
            windVx, windVz
          );
        }
      }
    }

    // 5. Step & upload particle/instanced pools
    this._updateEmbers(safeDt, elapsed);
    this._updateSmoke(safeDt);
    this._updateWaterPuffs(safeDt);
    this._updateSteamPuffs(safeDt);
    this._updateWakes(safeDt);

    // 6. Drop-zone ground-projected oval reticle
    if (showDropReticle && dropPreview) {
      const groundY = Math.max(terrain.waterLevel + 0.35, dropPreview.y + 0.65);
      const r = Math.max(12, Math.min(48, dropPreview.radius || 22));
      this.reticleMesh.visible = true;
      this.reticleMesh.position.set(dropPreview.x, groundY, dropPreview.z);
      // Slight oval elongation along aircraft heading
      const headingYaw = localAircraft ? -(localAircraft.yawDeg || 0) * (Math.PI / 180) : 0;
      this.reticleMesh.rotation.set(0, headingYaw, 0);
      this.reticleMesh.scale.set(r * 0.92, 1.0, r * 1.18);
      this._reticleMat.opacity = 0.62 + 0.16 * Math.sin(elapsed * 5.0);
    } else {
      this.reticleMesh.visible = false;
    }
  }

  _updateFlames(elapsed, gs, cs, half, cellHeights, windVx, windVz) {
    const burnCount = this._burnCount;
    const emberCount = this._emberWarnCount;
    if (burnCount === 0 && emberCount === 0) {
      this.flameMesh.count = 0;
      return;
    }

    const leanX = Math.max(-0.28, Math.min(0.28, windVx * 0.025));
    const leanZ = Math.max(-0.28, Math.min(0.28, windVz * 0.025));
    const stride = burnCount > MAX_FLAMES - 120 ? Math.ceil(burnCount / (MAX_FLAMES - 120)) : 1;

    let outIdx = 0;
    for (let i = 0; i < burnCount && outIdx < MAX_FLAMES; i += stride) {
      const cellIdx = this._burnCells[i];
      const intensity = this._burnIntensity[i];
      const gx = cellIdx % gs;
      const gz = (cellIdx / gs) | 0;
      const seed = (cellIdx * 0.6180339) % 1;
      const jx = (Math.sin(cellIdx * 12.9898) * 0.5) * cs * 0.45;
      const jz = (Math.cos(cellIdx * 78.233) * 0.5) * cs * 0.45;

      const wx = (gx + 0.5) * cs - half + jx;
      const wz = (gz + 0.5) * cs - half + jz;
      const wy = cellHeights[cellIdx];

      const flicker = 0.78 + 0.30 * Math.sin(elapsed * 11.5 + cellIdx * 1.73) * Math.cos(elapsed * 7.1 + seed * 12.0);
      const normI = 0.35 + (intensity / 12.0) * 0.85;
      const sx = (1.15 + normI * 1.25) * (0.92 + 0.14 * Math.sin(elapsed * 9.0 + cellIdx));
      const sy = normI * 1.85 * flicker;

      this._pos.set(wx, wy - 0.3, wz);
      this._euler.set(leanZ, elapsed * 0.8 + seed * 6.28, -leanX, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(sx, sy, sx);
      this._mat.compose(this._pos, this._quat, this._scale);
      this.flameMesh.setMatrixAt(outIdx, this._mat);

      // Keep true vibrant colors (slight warm boost for intense flames)
      this._col.setRGB(1.0, 0.90 + 0.10 * (intensity / 12.0), 0.85 + 0.15 * (intensity / 12.0));
      this.flameMesh.setColorAt(outIdx, this._col);
      outIdx++;
    }

    // Pulsing amber ground glow for ember-spot warning cells (state 15)
    for (let i = 0; i < emberCount && outIdx < MAX_FLAMES; i++) {
      const cellIdx = this._emberWarnCells[i];
      const gx = cellIdx % gs;
      const gz = (cellIdx / gs) | 0;
      const wx = (gx + 0.5) * cs - half;
      const wz = (gz + 0.5) * cs - half;
      const wy = cellHeights[cellIdx];

      const pulse = 0.45 + 0.45 * Math.sin(elapsed * 14.0 + cellIdx);
      this._pos.set(wx, wy - 0.1, wz);
      this._euler.set(0, elapsed * 2.5 + cellIdx, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(0.95 + pulse * 0.45, 0.45 + pulse * 0.55, 0.95 + pulse * 0.45);
      this._mat.compose(this._pos, this._quat, this._scale);
      this.flameMesh.setMatrixAt(outIdx, this._mat);
      this.flameMesh.setColorAt(outIdx, COL_EMBER_WARN);
      outIdx++;
    }

    this.flameMesh.count = outIdx;
    this.flameMesh.instanceMatrix.needsUpdate = true;
    if (this.flameMesh.instanceColor) {
      this.flameMesh.instanceColor.needsUpdate = true;
    }
  }

  _updateEmbers(dt, elapsed) {
    let anyActive = false;
    for (let i = 0; i < MAX_EMBERS; i++) {
      const life = this._emberLife[i];
      if (life <= 0) continue;
      const rem = life - dt;
      const o3 = i * 3;
      if (rem <= 0) {
        this._emberLife[i] = 0;
        this._emberPos[o3 + 1] = -9999;
      } else {
        this._emberLife[i] = rem;
        const swirl = Math.sin(elapsed * 4.5 + i * 0.7) * 3.2;
        this._emberPos[o3] += (this._emberVel[o3] + swirl) * dt;
        this._emberPos[o3 + 1] += this._emberVel[o3 + 1] * dt;
        this._emberPos[o3 + 2] += (this._emberVel[o3 + 2] - swirl * 0.6) * dt;
      }
      anyActive = true;
    }
    if (anyActive) {
      this._emberPosAttr.needsUpdate = true;
    }
  }

  _updateSmoke(dt) {
    let visibleCount = 0;
    for (let i = 0; i < MAX_SMOKE; i++) {
      const maxLife = this._smokeLife[i];
      if (maxLife <= 0) continue;
      const age = this._smokeAge[i] + dt;
      if (age >= maxLife) {
        this._smokeLife[i] = 0;
        continue;
      }
      this._smokeAge[i] = age;
      const t = age / maxLife;
      const o3 = i * 3;
      const o2 = i * 2;

      this._smokePos[o3] += this._smokeVel[o3] * dt;
      this._smokePos[o3 + 1] += this._smokeVel[o3 + 1] * (1.0 - t * 0.35) * dt;
      this._smokePos[o3 + 2] += this._smokeVel[o3 + 2] * dt;
      this._smokeRot[o2] += this._smokeRot[o2 + 1] * dt;

      const s = this._smokeBaseScale[i] * (0.75 + t * 2.45);
      // Smooth Bayer dither fade-in and fade-out
      const fadeIn = Math.min(1.0, t / 0.14);
      const fadeOut = 1.0 - Math.max(0.0, (t - 0.30) / 0.70);
      const opacity = fadeIn * fadeOut * 0.86;
      // Warm orange under-glow strongest low over the fire canopy
      const fireGlow = Math.max(0.0, 1.0 - t * 1.95) * 0.88;

      this._pos.set(this._smokePos[o3], this._smokePos[o3 + 1], this._smokePos[o3 + 2]);
      this._euler.set(this._smokeRot[o2] * 0.5, this._smokeRot[o2], 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(s * 1.15, s * 0.88, s * 1.15);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.smokeMesh.setMatrixAt(visibleCount, this._mat);
      this._smokeOpacityArr[visibleCount] = opacity;
      this._smokeGlowArr[visibleCount] = fireGlow;
      visibleCount++;
    }

    this.smokeMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.smokeMesh.instanceMatrix.needsUpdate = true;
      this._smokeOpacityAttr.needsUpdate = true;
      this._smokeGlowAttr.needsUpdate = true;
    }
  }

  _updateWaterPuffs(dt) {
    const terrain = this.terrain;
    let visibleCount = 0;

    for (let i = 0; i < MAX_WATER_PUFFS; i++) {
      const maxLife = this._waterLife[i];
      if (maxLife <= 0) continue;
      const age = this._waterAge[i] + dt;
      if (age >= maxLife) {
        this._waterLife[i] = 0;
        continue;
      }
      this._waterAge[i] = age;

      const o3 = i * 3;
      const o2 = i * 2;
      // Exact ballistic acceleration: g_drop = -15.5, a_wind = 0.35 * W
      this._waterVel[o3] += this._waterWind[o2] * WIND_DRIFT_FACTOR * dt;
      this._waterVel[o3 + 1] += G_DROP * dt;
      this._waterVel[o3 + 2] += this._waterWind[o2 + 1] * WIND_DRIFT_FACTOR * dt;

      const nx = this._waterPos[o3] + this._waterVel[o3] * dt;
      const ny = this._waterPos[o3 + 1] + this._waterVel[o3 + 1] * dt;
      const nz = this._waterPos[o3 + 2] + this._waterVel[o3 + 2] * dt;
      this._waterPos[o3] = nx;
      this._waterPos[o3 + 1] = ny;
      this._waterPos[o3 + 2] = nz;

      const groundY = Math.max(terrain.waterLevel, terrain.getHeight(nx, nz));
      if (ny <= groundY + 0.4) {
        this._waterLife[i] = 0;
        continue;
      }

      const t = age / maxLife;
      const s = this._waterScale[i] * (0.68 + age * 1.12);
      this._pos.set(nx, ny, nz);
      this._euler.set(age * 1.4, age * 2.1 + i, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      // Elongate slightly vertically into a cascading curtain sheet
      this._scale.set(s * 0.88, s * (1.25 + t * 0.65), s * 0.88);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.waterMesh.setMatrixAt(visibleCount, this._mat);
      // Crisp pale-cyan/white water spray (#d8e6e6) with subtle twilight highlight (#d7cab3)
      this._col.copy(COL_WATER_B).lerp(COL_WATER_A, this._waterColorMix[i] * 0.28);
      this.waterMesh.setColorAt(visibleCount, this._col);
      visibleCount++;
    }

    this.waterMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.waterMesh.instanceMatrix.needsUpdate = true;
      if (this.waterMesh.instanceColor) this.waterMesh.instanceColor.needsUpdate = true;
    }
  }

  _updateSteamPuffs(dt) {
    let visibleCount = 0;
    for (let i = 0; i < MAX_STEAM_PUFFS; i++) {
      const maxLife = this._steamLife[i];
      if (maxLife <= 0) continue;
      const age = this._steamAge[i] + dt;
      if (age >= maxLife) {
        this._steamLife[i] = 0;
        continue;
      }
      this._steamAge[i] = age;
      const t = age / maxLife;
      const o3 = i * 3;

      this._steamPos[o3] += this._steamVel[o3] * (1.0 - t * 0.5) * dt;
      this._steamPos[o3 + 1] += this._steamVel[o3 + 1] * (1.0 - t * 0.4) * dt;
      this._steamPos[o3 + 2] += this._steamVel[o3 + 2] * (1.0 - t * 0.5) * dt;

      // Expand then shrink cleanly to zero at end of life
      const env = t < 0.2 ? t / 0.2 : Math.max(0, 1.0 - (t - 0.2) / 0.8);
      const s = this._steamBaseScale[i] * (0.65 + t * 1.65) * env;
      if (s <= 0.05) continue;

      this._pos.set(this._steamPos[o3], this._steamPos[o3 + 1], this._steamPos[o3 + 2]);
      this._euler.set(age * 0.8, age * 1.1 + i, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(s, s * 0.85, s);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.steamMesh.setMatrixAt(visibleCount, this._mat);
      const shade = this._steamTint[i];
      this._col.setRGB(COL_STEAM.r * shade, COL_STEAM.g * shade, COL_STEAM.b * shade);
      this.steamMesh.setColorAt(visibleCount, this._col);
      visibleCount++;
    }

    this.steamMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.steamMesh.instanceMatrix.needsUpdate = true;
      if (this.steamMesh.instanceColor) this.steamMesh.instanceColor.needsUpdate = true;
    }
  }

  _updateWakes(dt) {
    let visibleCount = 0;
    for (let i = 0; i < MAX_WAKE_PUFFS; i++) {
      const maxLife = this._wakeLife[i];
      if (maxLife <= 0) continue;
      const age = this._wakeAge[i] + dt;
      if (age >= maxLife) {
        this._wakeLife[i] = 0;
        continue;
      }
      this._wakeAge[i] = age;
      const t = age / maxLife;
      const o3 = i * 3;

      const fade = 1.0 - t;
      const width = (1.1 + t * 3.8) * fade;
      const length = (2.8 + t * 2.2) * fade;
      if (width <= 0.05) continue;

      this._pos.set(this._wakePos[o3], this._wakePos[o3 + 1], this._wakePos[o3 + 2]);
      this._euler.set(0, this._wakeYaw[i], 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(width, 1.0, length);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.wakeMesh.setMatrixAt(visibleCount, this._mat);
      this._col.copy(COL_WAKE_WHITE).lerp(COL_WAKE_CYAN, t);
      this.wakeMesh.setColorAt(visibleCount, this._col);
      visibleCount++;
    }

    this.wakeMesh.count = visibleCount;
    if (visibleCount > 0) {
      this.wakeMesh.instanceMatrix.needsUpdate = true;
      if (this.wakeMesh.instanceColor) this.wakeMesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    if (this.flameMesh) this.flameMesh.dispose();
    if (this.smokeMesh) this.smokeMesh.dispose();
    if (this.waterMesh) this.waterMesh.dispose();
    if (this.steamMesh) this.steamMesh.dispose();
    if (this.wakeMesh) this.wakeMesh.dispose();
    this._flameGeo.dispose();
    this._flameMat.dispose();
    this._emberGeo.dispose();
    this._emberMat.dispose();
    this._smokeGeo.dispose();
    this._smokeMat.dispose();
    this._waterGeo.dispose();
    this._waterMat.dispose();
    this._steamGeo.dispose();
    this._steamMat.dispose();
    this._wakeGeo.dispose();
    this._wakeMat.dispose();
    this._reticleGeo.dispose();
    this._reticleMat.dispose();
    this._reticleTex.dispose();
  }
}
