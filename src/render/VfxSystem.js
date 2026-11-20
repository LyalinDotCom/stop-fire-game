import * as THREE from 'three';
import { FLIGHT_CONSTANTS } from '../sim/FlightModel.js';
import { createSmokeBayerMaterial } from './SmokeBayerShader.js';
import {
  createFlameGeometry,
  createFlameMaterial,
  createEmberBedMaterial,
} from './FireShader.js';

const MAX_FLAMES = 3200;
const MAX_EMBER_BEDS = 1400;
const MAX_EMBERS = 1200;
const MAX_SMOKE = 480;
const MAX_WATER_PUFFS = 520;
const MAX_STEAM_PUFFS = 540;
const MAX_WAKE_PUFFS = 220;
const MAX_IMPACT_RINGS = 24;

const RETICLE_SEGS = 8;
const CORRIDOR_SEGS_W = 4;
const CORRIDOR_SEGS_L = 10;

const COL_WATER_A = new THREE.Color('#d7cab3');
const COL_WATER_B = new THREE.Color('#dff2f4');
const COL_STEAM_WHITE = new THREE.Color('#ebffff');
const COL_STEAM_CYAN = new THREE.Color('#7ff4ff');
const COL_STEAM_EMERALD = new THREE.Color('#9effd8');
const COL_STEAM_MISS = new THREE.Color('#b89f8d');
const COL_STEAM_WET_MIST = new THREE.Color('#b8eef5');
const COL_SPLINTER_WOOD = new THREE.Color('#7a5534');
const COL_SPLINTER_PINE = new THREE.Color('#3c6343');
const COL_FIREBALL_HOT = new THREE.Color('#fff099');
const COL_FIREBALL_ORANGE = new THREE.Color('#ff5e12');
const COL_CRASH_SMOKE = new THREE.Color('#2c282b');

const COL_WAKE_WHITE = new THREE.Color('#e2f2f4');
const COL_WAKE_CYAN = new THREE.Color('#8ec8d2');

const COL_RETICLE_LOCK = new THREE.Color('#38f28b');
const COL_RETICLE_NEAR = new THREE.Color('#f6b73c');
const COL_RETICLE_CLEAR = new THREE.Color('#66d9ff');
const COL_RETICLE_DANGER = new THREE.Color('#ff4d45');

const COL_RING_DIRECT_A = new THREE.Color('#38f28b');
const COL_RING_DIRECT_B = new THREE.Color('#66f7ff');
const COL_RING_PARTIAL = new THREE.Color('#f6b73c');
const COL_RING_MISS = new THREE.Color('#ff5b40');
const COL_RING_CRASH = new THREE.Color('#ff6a18');

function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
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
 * Builds a high-contrast white/alpha CCIP Drop Target Ring texture
 * (tinted dynamically via material.color: emerald lock, amber near, cyan clear).
 */
function createDropReticleTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Translucent radial core fill
  const grad = ctx.createRadialGradient(cx, cy, 10, cx, cy, 114);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
  grad.addColorStop(0.55, 'rgba(255, 255, 255, 0.14)');
  grad.addColorStop(0.86, 'rgba(255, 255, 255, 0.24)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 114, 0, Math.PI * 2);
  ctx.fill();

  // Bold segmented outer ring (super legible at 640x360)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.lineWidth = 10;
  ctx.setLineDash([28, 14]);
  ctx.beginPath();
  ctx.arc(cx, cy, 106, 0, Math.PI * 2);
  ctx.stroke();

  // Solid inner tactical ring
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, 46, 0, Math.PI * 2);
  ctx.stroke();

  // Crisp center bullseye dot
  ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();

  // Four bold inward-pointing cardinal brackets/ticks
  ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
  ctx.lineWidth = 8;
  const ticks = [
    [cx, 6, cx, 36],
    [cx, size - 36, cx, size - 6],
    [6, cy, 36, cy],
    [size - 36, cy, size - 6, cy],
  ];
  for (const [x0, y0, x1, y1] of ticks) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a wide, airy dashed mist-dispersion reticle texture shown when flying TOO HIGH (> 58m AGL)
 * to visually communicate wind-sheared load misting.
 */
function createWideMistReticleTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  const grad = ctx.createRadialGradient(cx, cy, 24, cx, cy, 118);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.16)');
  grad.addColorStop(0.92, 'rgba(255, 255, 255, 0.22)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 118, 0, Math.PI * 2);
  ctx.fill();

  // Wide broken mist outer ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.90)';
  ctx.lineWidth = 7;
  ctx.setLineDash([14, 16]);
  ctx.beginPath();
  ctx.arc(cx, cy, 110, 0, Math.PI * 2);
  ctx.stroke();

  // Secondary scattered mist ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.lineWidth = 4;
  ctx.setLineDash([8, 14]);
  ctx.beginPath();
  ctx.arc(cx, cy, 74, 0, Math.PI * 2);
  ctx.stroke();

  // Hollow center crosshair (not concentrated!)
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 18, cy);
  ctx.lineTo(cx - 6, cy);
  ctx.moveTo(cx + 6, cy);
  ctx.lineTo(cx + 18, cy);
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx, cy - 6);
  ctx.moveTo(cx, cy + 6);
  ctx.lineTo(cx, cy + 18);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a repeating bold directional drop-corridor runway texture
 * (side rails + translucent forward chevrons).
 */
function createDropCorridorTexture() {
  const w = 128;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, w, h);

  // Soft interior runway wash
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.0)');
  grad.addColorStop(0.12, 'rgba(255, 255, 255, 0.24)');
  grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.14)');
  grad.addColorStop(0.88, 'rgba(255, 255, 255, 0.24)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Crisp dashed side boundary rails
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillRect(8, 6, 8, 48);
  ctx.fillRect(8, 70, 8, 48);
  ctx.fillRect(w - 16, 6, 8, 48);
  ctx.fillRect(w - 16, 70, 8, 48);

  // Forward-pointing tactical chevrons
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const cy of [34, 98]) {
    ctx.beginPath();
    ctx.moveTo(28, cy + 16);
    ctx.lineTo(w / 2, cy - 12);
    ctx.lineTo(w - 28, cy + 16);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds an expanding shockwave/splash ring texture for drop impacts & lock ripples.
 */
function createImpactRingTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  const grad = ctx.createRadialGradient(cx, cy, 34, cx, cy, 62);
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.0)');
  grad.addColorStop(0.45, 'rgba(255, 255, 255, 0.28)');
  grad.addColorStop(0.76, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.92, 'rgba(255, 255, 255, 0.65)');
  grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 62, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
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

    // Dirty flag so instanced flame/ember-bed matrices only rebuild when fire grid changes
    this._fireLayoutDirty = true;

    // Timers for continuous emission
    this._smokeAccum = 0;
    this._emberAccum = 0;
    this._wetMistAccum = 0;
    this._wakeAccum = 0;
    this._remoteDropAccum = 0;
    this._ashAccum = 0;
    this._rngState = 1337;

    this._initEmberBeds();
    this._initFlames();
    this._initEmbers();
    this._initSmoke();
    this._initWaterPuffs();
    this._initSteamPuffs();
    this._initWakes();
    this._initImpactRings();
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

  _initEmberBeds() {
    this._emberBedGeo = new THREE.PlaneGeometry(1.0, 1.0);
    this._emberBedGeo.rotateX(-Math.PI / 2);

    this._bedPhaseArr = new Float32Array(MAX_EMBER_BEDS);
    this._bedIntArr = new Float32Array(MAX_EMBER_BEDS);
    this._bedModeArr = new Float32Array(MAX_EMBER_BEDS);

    this._bedPhaseAttr = new THREE.InstancedBufferAttribute(this._bedPhaseArr, 1);
    this._bedIntAttr = new THREE.InstancedBufferAttribute(this._bedIntArr, 1);
    this._bedModeAttr = new THREE.InstancedBufferAttribute(this._bedModeArr, 1);

    this._emberBedGeo.setAttribute('aPhase', this._bedPhaseAttr);
    this._emberBedGeo.setAttribute('aIntensity', this._bedIntAttr);
    this._emberBedGeo.setAttribute('aMode', this._bedModeAttr);

    this._emberBedMat = createEmberBedMaterial();
    this.emberBedMesh = new THREE.InstancedMesh(this._emberBedGeo, this._emberBedMat, MAX_EMBER_BEDS);
    this.emberBedMesh.name = 'EmberBedGlows';
    this.emberBedMesh.frustumCulled = false;
    this.emberBedMesh.count = 0;
    this.emberBedMesh.renderOrder = 1;
    this.group.add(this.emberBedMesh);
  }

  _initFlames() {
    this._flameGeo = createFlameGeometry();
    this._flamePhaseArr = new Float32Array(MAX_FLAMES);
    this._flameIntArr = new Float32Array(MAX_FLAMES);
    this._flamePhaseAttr = new THREE.InstancedBufferAttribute(this._flamePhaseArr, 1);
    this._flameIntAttr = new THREE.InstancedBufferAttribute(this._flameIntArr, 1);
    this._flameGeo.setAttribute('aPhase', this._flamePhaseAttr);
    this._flameGeo.setAttribute('aIntensity', this._flameIntAttr);

    this._flameMat = createFlameMaterial();
    this.flameMesh = new THREE.InstancedMesh(this._flameGeo, this._flameMat, MAX_FLAMES);
    this.flameMesh.name = 'OrganicWildfireFlames';
    this.flameMesh.frustumCulled = false;
    this.flameMesh.count = 0;
    this.flameMesh.renderOrder = 2;
    this.group.add(this.flameMesh);
  }

  _initEmbers() {
    this._emberPos = new Float32Array(MAX_EMBERS * 3);
    this._emberVel = new Float32Array(MAX_EMBERS * 3);
    this._emberLife = new Float32Array(MAX_EMBERS);
    this._emberMaxLife = new Float32Array(MAX_EMBERS);
    this._emberCursor = 0;

    for (let i = 0; i < MAX_EMBERS; i++) {
      this._emberPos[i * 3 + 1] = -9999;
    }

    this._emberGeo = new THREE.BufferGeometry();
    this._emberPosAttr = new THREE.BufferAttribute(this._emberPos, 3);
    this._emberGeo.setAttribute('position', this._emberPosAttr);

    this._emberMat = new THREE.PointsMaterial({
      color: new THREE.Color('#ffbe52'),
      size: 1.85,
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
    this._smokeGlowBoost = new Float32Array(MAX_SMOKE);
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
      emissive: new THREE.Color('#3a5258'),
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.80,
      depthWrite: false,
    });
    this.steamMesh = new THREE.InstancedMesh(this._steamGeo, this._steamMat, MAX_STEAM_PUFFS);
    this.steamMesh.name = 'ImpactSteamMist';
    this.steamMesh.frustumCulled = false;
    this.steamMesh.setColorAt(0, COL_STEAM_WHITE);
    this.steamMesh.count = 0;
    this.steamMesh.renderOrder = 3;
    this.group.add(this.steamMesh);

    this._steamPos = new Float32Array(MAX_STEAM_PUFFS * 3);
    this._steamVel = new Float32Array(MAX_STEAM_PUFFS * 3);
    this._steamAge = new Float32Array(MAX_STEAM_PUFFS);
    this._steamLife = new Float32Array(MAX_STEAM_PUFFS);
    this._steamBaseScale = new Float32Array(MAX_STEAM_PUFFS);
    this._steamRGB = new Float32Array(MAX_STEAM_PUFFS * 3);
    this._steamDrag = new Float32Array(MAX_STEAM_PUFFS);
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

  _initImpactRings() {
    this._impactRingTex = createImpactRingTexture();
    this._impactRingGeo = new THREE.PlaneGeometry(2.0, 2.0);
    this._impactRingGeo.rotateX(-Math.PI / 2);

    this._impactRings = [];
    for (let i = 0; i < MAX_IMPACT_RINGS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this._impactRingTex,
        color: COL_RING_DIRECT_A.clone(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -5,
        polygonOffsetUnits: -5,
      });
      const mesh = new THREE.Mesh(this._impactRingGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this._impactRings.push({
        mesh,
        mat,
        active: false,
        age: 0,
        life: 1.5,
        delay: 0,
        startR: 6,
        endR: 38,
        peakOpacity: 0.9,
      });
    }
    this._impactRingCursor = 0;
  }

  _initDropReticle() {
    this._reticleTex = createDropReticleTexture();
    this._reticleMistTex = createWideMistReticleTexture();
    this._corridorTex = createDropCorridorTexture();

    this.reticleGroup = new THREE.Group();
    this.reticleGroup.name = 'DropAimingSystem';
    this.reticleGroup.visible = false;

    // 1. Terrain-conforming Drop Corridor ribbon (start -> end)
    this._corridorGeo = new THREE.PlaneGeometry(1.0, 1.0, CORRIDOR_SEGS_W, CORRIDOR_SEGS_L);
    this._corridorMat = new THREE.MeshBasicMaterial({
      map: this._corridorTex,
      color: COL_RETICLE_CLEAR.clone(),
      transparent: true,
      depthWrite: false,
      opacity: 0.65,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    });
    this.corridorMesh = new THREE.Mesh(this._corridorGeo, this._corridorMat);
    this.corridorMesh.name = 'DropZoneCorridor';
    this.corridorMesh.frustumCulled = false;
    this.corridorMesh.renderOrder = 4;
    this.reticleGroup.add(this.corridorMesh);

    // 2. Terrain-conforming Target Impact Ring (drapes over hills & ridges)
    this._reticleGeo = new THREE.PlaneGeometry(2.0, 2.0, RETICLE_SEGS, RETICLE_SEGS);
    this._reticleMat = new THREE.MeshBasicMaterial({
      map: this._reticleTex,
      color: COL_RETICLE_CLEAR.clone(),
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });
    this.reticleMesh = new THREE.Mesh(this._reticleGeo, this._reticleMat);
    this.reticleMesh.name = 'DropZoneReticle';
    this.reticleMesh.frustumCulled = false;
    this.reticleMesh.renderOrder = 5;
    this.reticleGroup.add(this.reticleMesh);

    // 3. Canopy-clearance target halo ring (stays visible above treetops!)
    this._haloGeo = new THREE.PlaneGeometry(2.0, 2.0);
    this._haloGeo.rotateX(-Math.PI / 2);
    this._haloMat = new THREE.MeshBasicMaterial({
      map: this._reticleTex,
      color: COL_RETICLE_CLEAR.clone(),
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.reticleHaloMesh = new THREE.Mesh(this._haloGeo, this._haloMat);
    this.reticleHaloMesh.name = 'DropZoneCanopyHalo';
    this.reticleHaloMesh.frustumCulled = false;
    this.reticleHaloMesh.renderOrder = 5;
    this.reticleGroup.add(this.reticleHaloMesh);

    // 4. Expanding lock-on pulse ring (fires continuously when onTarget === true)
    this._pulseRingMat = new THREE.MeshBasicMaterial({
      map: this._impactRingTex,
      color: COL_RETICLE_LOCK.clone(),
      transparent: true,
      depthWrite: false,
      opacity: 0.0,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.reticlePulseMesh = new THREE.Mesh(this._haloGeo, this._pulseRingMat);
    this.reticlePulseMesh.name = 'DropZoneLockPulse';
    this.reticlePulseMesh.frustumCulled = false;
    this.reticlePulseMesh.renderOrder = 5;
    this.reticleGroup.add(this.reticlePulseMesh);

    // 5. Thin vertical bullseye pipper beacon connecting ground impact to canopy halo
    this._beaconGeo = new THREE.CylinderGeometry(0.45, 1.15, 1.0, 6, 1, true);
    this._beaconGeo.translate(0, 0.5, 0);
    this._beaconMat = new THREE.MeshBasicMaterial({
      color: COL_RETICLE_CLEAR.clone(),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.reticleBeaconMesh = new THREE.Mesh(this._beaconGeo, this._beaconMat);
    this.reticleBeaconMesh.name = 'DropZoneBeacon';
    this.reticleBeaconMesh.frustumCulled = false;
    this.reticleBeaconMesh.renderOrder = 5;
    this.reticleGroup.add(this.reticleBeaconMesh);

    this.group.add(this.reticleGroup);
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
    this._fireLayoutDirty = true;

    this._emberLife.fill(0);
    for (let i = 0; i < MAX_EMBERS; i++) this._emberPos[i * 3 + 1] = -9999;
    this._emberPosAttr.needsUpdate = true;

    this._smokeLife.fill(0);
    this._waterLife.fill(0);
    this._steamLife.fill(0);
    this._wakeLife.fill(0);

    for (let i = 0; i < this._impactRings.length; i++) {
      this._impactRings[i].active = false;
      this._impactRings[i].mesh.visible = false;
    }

    this.flameMesh.count = 0;
    this.emberBedMesh.count = 0;
    this.smokeMesh.count = 0;
    this.waterMesh.count = 0;
    this.steamMesh.count = 0;
    this.wakeMesh.count = 0;
    this.reticleGroup.visible = false;
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
    this._fireLayoutDirty = true;
  }

  _spawnSteamParticle(x, y, z, vx, vy, vz, life, baseScale, color, drag = 0.45) {
    const i = this._steamCursor;
    this._steamCursor = (i + 1) % MAX_STEAM_PUFFS;
    const o3 = i * 3;

    this._steamPos[o3] = x;
    this._steamPos[o3 + 1] = y;
    this._steamPos[o3 + 2] = z;

    this._steamVel[o3] = vx;
    this._steamVel[o3 + 1] = vy;
    this._steamVel[o3 + 2] = vz;

    this._steamAge[i] = 0;
    this._steamLife[i] = life;
    this._steamBaseScale[i] = baseScale;
    this._steamRGB[o3] = color.r;
    this._steamRGB[o3 + 1] = color.g;
    this._steamRGB[o3 + 2] = color.b;
    this._steamDrag[i] = drag;
  }

  _spawnImpactRing(x, y, z, color, startR, endR, life, peakOpacity = 0.92, delay = 0) {
    const ring = this._impactRings[this._impactRingCursor];
    this._impactRingCursor = (this._impactRingCursor + 1) % MAX_IMPACT_RINGS;

    ring.active = true;
    ring.age = 0;
    ring.life = life;
    ring.delay = delay;
    ring.startR = startR;
    ring.endR = endR;
    ring.peakOpacity = peakOpacity;
    ring.mat.color.copy(color);
    ring.mat.opacity = 0;
    ring.mesh.position.set(x, y, z);
    ring.mesh.scale.set(startR, 1, startR);
    ring.mesh.visible = delay <= 0;
  }

  /**
   * Spawns ballistic billowing water drop curtain puffs following exact FlightModel/FireSim physics.
   */
  spawnDropVisual(x, y, z, vx, vy, vz, windVx, windVz) {
    const burstCount = 6;
    for (let k = 0; k < burstCount; k++) {
      const i = this._waterCursor;
      this._waterCursor = (i + 1) % MAX_WATER_PUFFS;
      const o3 = i * 3;
      const o2 = i * 2;

      const spreadX = (this._rand() - 0.5) * 1.45;
      const spreadY = (this._rand() - 0.5) * 0.7 - 1.65;
      const spreadZ = (this._rand() - 0.5) * 1.45;

      this._waterPos[o3] = x + spreadX;
      this._waterPos[o3 + 1] = y + spreadY;
      this._waterPos[o3 + 2] = z + spreadZ;

      this._waterVel[o3] = vx * 0.99 + (this._rand() - 0.5) * 2.4;
      this._waterVel[o3 + 1] = vy - 0.8 - this._rand() * 1.4;
      this._waterVel[o3 + 2] = vz * 0.99 + (this._rand() - 0.5) * 2.4;

      this._waterWind[o2] = windVx || 0;
      this._waterWind[o2 + 1] = windVz || 0;

      this._waterAge[i] = 0;
      this._waterLife[i] = 2.8 + this._rand() * 1.0;
      this._waterScale[i] = 0.95 + this._rand() * 0.6;
      this._waterColorMix[i] = this._rand();
    }
  }

  /**
   * Spawns billowing steam bursts on water parcel impact (legacy compatible).
   */
  spawnImpactSteam(x, y, z, extinguished = true) {
    const groundY = this.terrain
      ? Math.max(this.terrain.waterLevel, this.terrain.getHeight(x, z))
      : (y || 12);
    const baseY = Number.isFinite(y) ? Math.max(groundY, y) : groundY;
    const count = extinguished ? 12 : 5;
    for (let k = 0; k < count; k++) {
      const ang = this._rand() * Math.PI * 2;
      const rad = this._rand() * (extinguished ? 12.0 : 5.5);
      const col = extinguished
        ? (this._rand() > 0.4 ? COL_STEAM_WHITE : COL_STEAM_CYAN)
        : COL_STEAM_MISS;
      this._spawnSteamParticle(
        x + Math.cos(ang) * rad,
        baseY + 1.2 + this._rand() * 2.6,
        z + Math.sin(ang) * rad,
        Math.cos(ang) * (3.0 + this._rand() * 6.0),
        (extinguished ? 11.5 : 4.2) + this._rand() * 6.5,
        Math.sin(ang) * (3.0 + this._rand() * 6.0),
        (extinguished ? 2.8 : 1.3) + this._rand() * 1.2,
        (extinguished ? 3.8 : 1.9) + this._rand() * 2.0,
        col,
        0.42
      );
    }
  }

  /**
   * Unmistakable Drop Impact VFX (direct hit, partial hit, or miss) visible even when banking away.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {'direct'|'partial'|'miss'|string} outcome
   * @param {number} cellsExtinguished
   */
  spawnDropImpactEffect(x, y, z, outcome = 'direct', cellsExtinguished = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const groundY = this.terrain
      ? Math.max(this.terrain.waterLevel, this.terrain.getHeight(x, z))
      : (Number.isFinite(y) ? y : 12);
    const baseY = Number.isFinite(y) ? Math.max(groundY, y) : groundY;
    const norm = String(outcome || 'miss').toLowerCase();
    const isDirect = norm === 'direct' || norm === 'hit';
    const isPartial = norm === 'partial';

    if (isDirect) {
      const bonus = Math.min(20, Math.max(0, cellsExtinguished || 0));
      // Ground + canopy-height expanding emerald/cyan splash rings
      this._spawnImpactRing(x, groundY + 1.4, z, COL_RING_DIRECT_A, 8, 48 + bonus * 0.6, 2.2, 0.96, 0);
      this._spawnImpactRing(x, groundY + 8.0, z, COL_RING_DIRECT_B, 10, 56 + bonus * 0.7, 2.5, 0.85, 0.14);
      this._spawnImpactRing(x, groundY + 1.8, z, COL_RING_DIRECT_A, 6, 36, 1.5, 0.80, 0.34);

      // Towering bright white-cyan billowing steam plume column
      const plumeCount = 24 + Math.min(18, bonus);
      for (let k = 0; k < plumeCount; k++) {
        const ang = this._rand() * Math.PI * 2;
        const isCore = k < plumeCount * 0.55;
        const rad = this._rand() * (isCore ? 11.0 : 22.0);
        const col = this._rand() < 0.52
          ? COL_STEAM_WHITE
          : this._rand() < 0.78
            ? COL_STEAM_CYAN
            : COL_STEAM_EMERALD;
        this._spawnSteamParticle(
          x + Math.cos(ang) * rad,
          baseY + 1.8 + this._rand() * 4.5,
          z + Math.sin(ang) * rad,
          Math.cos(ang) * (isCore ? 2.4 + this._rand() * 4.5 : 8.5 + this._rand() * 9.0),
          (isCore ? 17.5 : 9.5) + this._rand() * 11.5,
          Math.sin(ang) * (isCore ? 2.4 + this._rand() * 4.5 : 8.5 + this._rand() * 9.0),
          (isCore ? 3.4 : 2.5) + this._rand() * 1.4,
          (isCore ? 4.8 : 3.8) + this._rand() * 3.0,
          col,
          0.35
        );
      }
    } else if (isPartial) {
      const bonus = Math.min(10, Math.max(0, cellsExtinguished || 0));
      this._spawnImpactRing(x, groundY + 1.4, z, COL_RING_PARTIAL, 7, 36 + bonus * 0.5, 1.85, 0.90, 0);
      this._spawnImpactRing(x, groundY + 7.0, z, COL_RING_DIRECT_B, 8, 40, 1.9, 0.65, 0.16);

      const plumeCount = 15 + bonus;
      for (let k = 0; k < plumeCount; k++) {
        const ang = this._rand() * Math.PI * 2;
        const rad = this._rand() * 14.0;
        const col = this._rand() < 0.65 ? COL_STEAM_WHITE : COL_STEAM_CYAN;
        this._spawnSteamParticle(
          x + Math.cos(ang) * rad,
          baseY + 1.5 + this._rand() * 3.0,
          z + Math.sin(ang) * rad,
          Math.cos(ang) * (4.0 + this._rand() * 6.5),
          12.0 + this._rand() * 8.5,
          Math.sin(ang) * (4.0 + this._rand() * 6.5),
          2.5 + this._rand() * 1.1,
          3.4 + this._rand() * 2.2,
          col,
          0.42
        );
      }
    } else {
      // Miss: muted dusty splash + brief amber-red impact ring
      this._spawnImpactRing(x, groundY + 1.4, z, COL_RING_MISS, 6, 26, 1.4, 0.82, 0);
      for (let k = 0; k < 10; k++) {
        const ang = this._rand() * Math.PI * 2;
        const rad = this._rand() * 9.0;
        this._spawnSteamParticle(
          x + Math.cos(ang) * rad,
          baseY + 0.8 + this._rand() * 1.8,
          z + Math.sin(ang) * rad,
          Math.cos(ang) * (4.0 + this._rand() * 5.5),
          4.2 + this._rand() * 4.5,
          Math.sin(ang) * (4.0 + this._rand() * 5.5),
          1.25 + this._rand() * 0.7,
          2.0 + this._rand() * 1.4,
          COL_STEAM_MISS,
          0.55
        );
      }
    }
  }

  /**
   * Debris, pine splinters & spark burst when the aircraft clips a tree.
   */
  spawnTreeHitEffect(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const py = Number.isFinite(y) ? y : 25;
    for (let k = 0; k < 14; k++) {
      const ang = this._rand() * Math.PI * 2;
      const spd = 8.0 + this._rand() * 14.0;
      const col = this._rand() < 0.55 ? COL_SPLINTER_PINE : COL_SPLINTER_WOOD;
      this._spawnSteamParticle(
        x + (this._rand() - 0.5) * 3.0,
        py + (this._rand() - 0.5) * 2.0,
        z + (this._rand() - 0.5) * 3.0,
        Math.cos(ang) * spd,
        4.0 + this._rand() * 9.0,
        Math.sin(ang) * spd,
        0.95 + this._rand() * 0.65,
        1.1 + this._rand() * 1.1,
        col,
        0.55
      );
    }
    for (let k = 0; k < 26; k++) {
      const ang = this._rand() * Math.PI * 2;
      const spd = 10.0 + this._rand() * 18.0;
      this._spawnEmberSpark(
        x, py, z,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd
      );
    }
  }

  /**
   * Fiery crash fireball + expanding shockwave + dark smoke plume + spark shower on plane_crash.
   */
  spawnCrashExplosion(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const groundY = this.terrain
      ? Math.max(this.terrain.waterLevel, this.terrain.getHeight(x, z))
      : (Number.isFinite(y) ? y : 14);
    const py = Number.isFinite(y) ? Math.max(groundY + 0.5, y) : groundY + 1.0;

    this._spawnImpactRing(x, groundY + 1.5, z, COL_RING_CRASH, 4, 42, 1.8, 0.98, 0);
    this._spawnImpactRing(x, groundY + 4.5, z, COL_FIREBALL_HOT, 3, 28, 1.2, 0.92, 0.1);

    // Core fireball puffs
    for (let k = 0; k < 26; k++) {
      const ang = this._rand() * Math.PI * 2;
      const rad = this._rand() * 8.0;
      const col = this._rand() < 0.42 ? COL_FIREBALL_HOT : COL_FIREBALL_ORANGE;
      this._spawnSteamParticle(
        x + Math.cos(ang) * rad,
        py + this._rand() * 3.0,
        z + Math.sin(ang) * rad,
        Math.cos(ang) * (5.0 + this._rand() * 12.0),
        10.0 + this._rand() * 14.0,
        Math.sin(ang) * (5.0 + this._rand() * 12.0),
        1.4 + this._rand() * 1.0,
        3.6 + this._rand() * 3.0,
        col,
        0.48
      );
    }

    // Thick rising crash smoke column
    for (let k = 0; k < 18; k++) {
      const ang = this._rand() * Math.PI * 2;
      const rad = this._rand() * 7.5;
      this._spawnSmokePuff(
        x + Math.cos(ang) * rad,
        py + 2.0 + this._rand() * 5.0,
        z + Math.sin(ang) * rad,
        (this._rand() - 0.5) * 6.0,
        (this._rand() - 0.5) * 6.0,
        1.15
      );
      this._spawnSteamParticle(
        x + Math.cos(ang) * rad,
        py + 3.0 + this._rand() * 4.0,
        z + Math.sin(ang) * rad,
        Math.cos(ang) * (2.5 + this._rand() * 5.0),
        9.0 + this._rand() * 9.0,
        Math.sin(ang) * (2.5 + this._rand() * 5.0),
        2.8 + this._rand() * 1.4,
        4.0 + this._rand() * 2.5,
        COL_CRASH_SMOKE,
        0.38
      );
    }

    // High-energy spark shower
    for (let k = 0; k < 65; k++) {
      const ang = this._rand() * Math.PI * 2;
      const spd = 8.0 + this._rand() * 24.0;
      this._spawnEmberSpark(x, py + 1.0, z, Math.cos(ang) * spd, Math.sin(ang) * spd);
    }
  }

  _spawnSmokePuff(x, y, z, windVx, windVz, intensityNorm) {
    const i = this._smokeCursor;
    this._smokeCursor = (i + 1) % MAX_SMOKE;
    const o3 = i * 3;
    const o2 = i * 2;

    this._smokePos[o3] = x + (this._rand() - 0.5) * 9.5;
    this._smokePos[o3 + 1] = y + 5.5 + this._rand() * 4.5;
    this._smokePos[o3 + 2] = z + (this._rand() - 0.5) * 9.5;

    this._smokeVel[o3] = windVx * (0.75 + this._rand() * 0.45) + (this._rand() - 0.5) * 2.5;
    this._smokeVel[o3 + 1] = 10.5 + intensityNorm * 7.5 + this._rand() * 4.0;
    this._smokeVel[o3 + 2] = windVz * (0.75 + this._rand() * 0.45) + (this._rand() - 0.5) * 2.5;

    this._smokeAge[i] = 0;
    this._smokeLife[i] = 4.6 + this._rand() * 3.8;
    this._smokeBaseScale[i] = 4.2 + intensityNorm * 3.8 + this._rand() * 2.2;
    this._smokeRot[o2] = this._rand() * Math.PI * 2;
    this._smokeRot[o2 + 1] = (this._rand() - 0.5) * 0.9;
    this._smokeGlowBoost[i] = Math.min(1.0, 0.72 + intensityNorm * 0.35);
  }

  _spawnEmberSpark(x, y, z, windVx, windVz) {
    const i = this._emberCursor;
    this._emberCursor = (i + 1) % MAX_EMBERS;
    const o3 = i * 3;

    this._emberPos[o3] = x + (this._rand() - 0.5) * 11.0;
    this._emberPos[o3 + 1] = y + 3.0 + this._rand() * 6.0;
    this._emberPos[o3 + 2] = z + (this._rand() - 0.5) * 11.0;

    this._emberVel[o3] = windVx * (0.9 + this._rand() * 0.6) + (this._rand() - 0.5) * 6.5;
    this._emberVel[o3 + 1] = 9.5 + this._rand() * 14.5;
    this._emberVel[o3 + 2] = windVz * (0.9 + this._rand() * 0.6) + (this._rand() - 0.5) * 6.5;

    const life = 2.0 + this._rand() * 2.8;
    this._emberLife[i] = life;
    this._emberMaxLife[i] = life;
  }

  _spawnWakePair(x, z, yawDeg, waterLevel) {
    const yawRad = (yawDeg || 0) * (Math.PI / 180);
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
  update({ dt, elapsed, localAircraft, remotePlanes, fireSnapshot, showDropReticle, dropPreview, atmosphere = null }) {
    const safeDt = Math.min(dt || 0.016, 0.05);
    const terrain = this.terrain;
    const gs = terrain.gridSize;
    const cs = terrain.cellSize;
    const half = terrain.halfWorld;
    const cellHeights = terrain.cellHeights;
    const windVx = fireSnapshot ? (fireSnapshot.windVx || 0) : 0;
    const windVz = fireSnapshot ? (fireSnapshot.windVz || 0) : 0;
    const smokeDensity = atmosphere ? Math.max(0, Math.min(1, atmosphere.smokeDensity || 0)) : 0;
    const turbulence = atmosphere ? Math.max(0, Math.min(1, atmosphere.turbulence || 0)) : 0;
    const heatDanger = atmosphere ? Math.max(0, Math.min(1, atmosphere.heatDanger || 0)) : 0;

    // 1. Update organic animated flames + radial ground ember beds
    this._flameMat.uniforms.uTime.value = elapsed;
    this._flameMat.uniforms.uWind.value.set(
      Math.max(-5.5, Math.min(5.5, windVx * 0.34)),
      Math.max(-5.5, Math.min(5.5, windVz * 0.34))
    );
    this._emberBedMat.uniforms.uTime.value = elapsed;

    if (this._fireLayoutDirty) {
      this._rebuildFireInstances(gs, cs, half, cellHeights);
      this._fireLayoutDirty = false;
    }

    // 2. Emit smoke plumes & glowing embers from active burn cells
    if (this._burnCount > 0) {
      const smokeRate = Math.min(76, 14 + this._burnCount * 0.26);
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

      const emberRate = Math.min(230, 36 + this._burnCount * 0.85);
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

    // 3. Emit lingering wet-firebreak cooling mist (state 13) — clearly steaming dark-teal firebreaks
    if (this._wetCount > 0) {
      const mistRate = Math.min(54, 8 + this._wetCount * 0.28);
      this._wetMistAccum += safeDt * mistRate;
      while (this._wetMistAccum >= 1.0) {
        this._wetMistAccum -= 1.0;
        const pick = Math.floor(this._rand() * this._wetCount);
        const idx = this._wetCells[pick];
        const gx = idx % gs;
        const gz = (idx / gs) | 0;
        const wx = (gx + 0.5) * cs - half + (this._rand() - 0.5) * cs * 0.72;
        const wz = (gz + 0.5) * cs - half + (this._rand() - 0.5) * cs * 0.72;
        const wy = cellHeights[idx];

        this._spawnSteamParticle(
          wx,
          wy + 1.5,
          wz,
          windVx * 0.24,
          3.4 + this._rand() * 2.8,
          windVz * 0.24,
          2.8 + this._rand() * 1.4,
          2.5 + this._rand() * 1.6,
          COL_STEAM_WET_MIST,
          0.38
        );
      }
    }

    // 3b. Cockpit smoke plume ash specks whipping past aircraft when flying inside smoke/turbulence
    if (localAircraft && !localAircraft.crashed && (smokeDensity > 0.06 || turbulence > 0.12)) {
      const ashIntensity = Math.max(smokeDensity, turbulence * 0.75);
      this._ashAccum += safeDt * (24 + ashIntensity * 90);
      const yawRad = (localAircraft.yawDeg || 0) * (Math.PI / 180);
      const fx = Math.sin(yawRad);
      const fz = -Math.cos(yawRad);
      const rx = Math.cos(yawRad);
      const rz = Math.sin(yawRad);
      while (this._ashAccum >= 1.0) {
        this._ashAccum -= 1.0;
        const ahead = 8 + this._rand() * 24;
        const side = (this._rand() - 0.5) * 26;
        const up = (this._rand() - 0.5) * 14;
        this._spawnEmberSpark(
          localAircraft.x + fx * ahead + rx * side,
          localAircraft.y + up,
          localAircraft.z + fz * ahead + rz * side,
          windVx * 0.6 - fx * 6.0,
          windVz * 0.6 - fz * 6.0
        );
      }
    }

    // 4. Emit twin pontoon foam wakes & remote water curtains
    this._wakeAccum += safeDt;
    if (this._wakeAccum >= 0.045) {
      this._wakeAccum = 0;
      if (localAircraft && localAircraft.scooping && !localAircraft.crashed) {
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
    this._updateImpactRings(safeDt);

    // 6. Impossible-to-miss terrain-draped Drop Corridor + Altitude-Aware Target Reticle
    const hasWater = !localAircraft || ((localAircraft.tankPct ?? 100) > 0.25 && !localAircraft.crashed);
    if (showDropReticle && dropPreview && hasWater) {
      this._updateDropReticle(dropPreview, localAircraft, elapsed, heatDanger);
    } else {
      this.reticleGroup.visible = false;
    }
  }

  /**
   * Rebuilds organic jittered sub-cell flame tongues (2-3 per cell) + soft radial ember beds
   * whenever FireSim cells change. Completely breaks up any grid blockiness.
   */
  _rebuildFireInstances(gs, cs, half, cellHeights) {
    const burnCount = this._burnCount;
    const emberCount = this._emberWarnCount;
    const terrain = this.terrain;

    if (burnCount === 0 && emberCount === 0) {
      this.flameMesh.count = 0;
      this.emberBedMesh.count = 0;
      return;
    }

    // Scatter 2-3 sub-cell tongues per burning cell, scaling cleanly if massive fire
    const tonguesPerCell = burnCount > 1100 ? 1 : burnCount > 520 ? 2 : 3;
    const cellStride = burnCount * tonguesPerCell > MAX_FLAMES
      ? Math.ceil((burnCount * tonguesPerCell) / MAX_FLAMES)
      : 1;

    let flameIdx = 0;
    for (let i = 0; i < burnCount && flameIdx < MAX_FLAMES; i += cellStride) {
      const cellIdx = this._burnCells[i];
      const intensity = this._burnIntensity[i];
      const normI = intensity / 12.0;
      const gx = cellIdx % gs;
      const gz = (cellIdx / gs) | 0;
      const cx = (gx + 0.5) * cs - half;
      const cz = (gz + 0.5) * cs - half;

      // High intensity cells get full tongue count; low smoldering edges get 1-2
      const countHere = intensity >= 7 ? tonguesPerCell : Math.max(1, tonguesPerCell - 1);

      for (let t = 0; t < countHere && flameIdx < MAX_FLAMES; t++) {
        const key = cellIdx * 17 + t * 53;
        const rAng = hash1(key + 1.3) * Math.PI * 2;
        // Tightened sub-cell scatter so carved wet firebreaks show a crisp gap immediately
        const rDist = (t === 0 ? 0.12 : 0.22 + hash1(key + 7.9) * 0.20) * cs;
        const wx = cx + Math.cos(rAng) * rDist;
        const wz = cz + Math.sin(rAng) * rDist;
        const wy = terrain.getHeight ? terrain.getHeight(wx, wz) : cellHeights[cellIdx];

        const phase = hash1(key + 19.7);
        const rotY = hash1(key + 31.1) * Math.PI * 2;
        const widthVar = 0.76 + hash1(key + 41.3) * 0.48;
        const heightVar = 0.74 + hash1(key + 59.9) * 0.56;

        const baseScale = (0.58 + normI * 0.94) * (cs / 16.0);
        const sx = baseScale * widthVar * (t === 0 ? 1.08 : 0.84);
        const sy = (0.38 + normI * 1.28) * heightVar * (t === 0 ? 1.18 : 0.84);

        this._pos.set(wx, wy - 0.55, wz);
        this._euler.set(0, rotY, 0, 'YXZ');
        this._quat.setFromEuler(this._euler);
        this._scale.set(sx, sy, sx);
        this._mat.compose(this._pos, this._quat, this._scale);

        this.flameMesh.setMatrixAt(flameIdx, this._mat);
        this._flamePhaseArr[flameIdx] = phase;
        this._flameIntArr[flameIdx] = 0.22 + normI * 0.98;
        flameIdx++;
      }
    }

    this.flameMesh.count = flameIdx;
    this.flameMesh.instanceMatrix.needsUpdate = true;
    this._flamePhaseAttr.needsUpdate = true;
    this._flameIntAttr.needsUpdate = true;

    // Soft radial ember beds tight to burning cells so extinguished wet trenches stay vividly dark-teal
    const bedStride = burnCount > MAX_EMBER_BEDS - 120
      ? Math.ceil(burnCount / (MAX_EMBER_BEDS - 120))
      : 1;
    let bedIdx = 0;
    for (let i = 0; i < burnCount && bedIdx < MAX_EMBER_BEDS; i += bedStride) {
      const cellIdx = this._burnCells[i];
      const normI = this._burnIntensity[i] / 12.0;
      const gx = cellIdx % gs;
      const gz = (cellIdx / gs) | 0;
      const jx = (hash1(cellIdx * 3.1 + 2.0) - 0.5) * cs * 0.22;
      const jz = (hash1(cellIdx * 7.3 + 5.0) - 0.5) * cs * 0.22;
      const wx = (gx + 0.5) * cs - half + jx;
      const wz = (gz + 0.5) * cs - half + jz;
      const wy = Math.max(terrain.waterLevel + 0.25, (terrain.getHeight ? terrain.getHeight(wx, wz) : cellHeights[cellIdx]) + 0.45);

      const diam = cs * (1.12 + normI * 0.34);
      this._pos.set(wx, wy, wz);
      this._euler.set(0, hash1(cellIdx * 11.7) * Math.PI * 2, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(diam, 1.0, diam);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.emberBedMesh.setMatrixAt(bedIdx, this._mat);
      this._bedPhaseArr[bedIdx] = hash1(cellIdx * 19.3);
      this._bedIntArr[bedIdx] = 0.35 + normI * 0.85;
      this._bedModeArr[bedIdx] = 0.0;
      bedIdx++;
    }

    for (let i = 0; i < emberCount && bedIdx < MAX_EMBER_BEDS; i++) {
      const cellIdx = this._emberWarnCells[i];
      const gx = cellIdx % gs;
      const gz = (cellIdx / gs) | 0;
      const wx = (gx + 0.5) * cs - half;
      const wz = (gz + 0.5) * cs - half;
      const wy = Math.max(terrain.waterLevel + 0.25, cellHeights[cellIdx] + 0.55);

      const diam = cs * 1.45;
      this._pos.set(wx, wy, wz);
      this._euler.set(0, hash1(cellIdx * 5.7) * Math.PI * 2, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(diam, 1.0, diam);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.emberBedMesh.setMatrixAt(bedIdx, this._mat);
      this._bedPhaseArr[bedIdx] = hash1(cellIdx * 23.1);
      this._bedIntArr[bedIdx] = 0.9;
      this._bedModeArr[bedIdx] = 1.0;
      bedIdx++;
    }

    this.emberBedMesh.count = bedIdx;
    this.emberBedMesh.instanceMatrix.needsUpdate = true;
    this._bedPhaseAttr.needsUpdate = true;
    this._bedIntAttr.needsUpdate = true;
    this._bedModeAttr.needsUpdate = true;
  }

  _updateDropReticle(dropPreview, localAircraft, elapsed, heatDanger = 0) {
    const terrain = this.terrain;
    const ix = Number.isFinite(dropPreview.impactX) ? dropPreview.impactX : dropPreview.x;
    const iz = Number.isFinite(dropPreview.impactZ) ? dropPreview.impactZ : dropPreview.z;
    if (!Number.isFinite(ix) || !Number.isFinite(iz)) {
      this.reticleGroup.visible = false;
      return;
    }

    const agl = localAircraft && Number.isFinite(localAircraft.agl) ? localAircraft.agl : 36;
    const altZone =
      dropPreview.altZone === 'optimal' ||
      dropPreview.altZone === 'too_high' ||
      dropPreview.altZone === 'too_low'
        ? dropPreview.altZone
        : agl > 58
          ? 'too_high'
          : agl < 16
            ? 'too_low'
            : 'optimal';

    const r = Math.max(14, Math.min(88, dropPreview.radiusM ?? dropPreview.radius ?? 28));
    const onTarget = Boolean(dropPreview.onTarget || (dropPreview.fireCellsInTarget > 0));
    const nearDist = Number.isFinite(dropPreview.nearFireDistM) ? dropPreview.nearFireDistM : Infinity;
    const isNear = !onTarget && nearDist < 80;
    const isTooHigh = altZone === 'too_high';
    const isLowDanger = (altZone === 'too_low' && (onTarget || nearDist < 90)) || heatDanger > 0.22;

    // Swap concentrated CCIP ring vs wide dashed mist ring when flying too high
    const desiredTex = isTooHigh ? this._reticleMistTex : this._reticleTex;
    if (this._reticleMat.map !== desiredTex) {
      this._reticleMat.map = desiredTex;
      this._reticleMat.needsUpdate = true;
    }
    if (this._haloMat.map !== desiredTex) {
      this._haloMat.map = desiredTex;
      this._haloMat.needsUpdate = true;
    }

    // Select altitude-envelope reticle color & pulse dynamics:
    // - Low over fire / thermal danger -> flashing CRIMSON RED
    // - Too high (> 58 m) -> wide dashed AMBER mist ring
    // - Optimal (18-52 m) & onTarget -> glowing EMERALD GREEN lock
    // - Near fire -> AMBER; Clear ground -> CYAN-WHITE
    const targetCol = isLowDanger
      ? COL_RETICLE_DANGER
      : isTooHigh
        ? COL_RETICLE_NEAR
        : onTarget
          ? COL_RETICLE_LOCK
          : isNear
            ? COL_RETICLE_NEAR
            : COL_RETICLE_CLEAR;

    const pulse = isLowDanger
      ? 0.5 + 0.5 * Math.sin(elapsed * 16.0)
      : onTarget && !isTooHigh
        ? 0.5 + 0.5 * Math.sin(elapsed * 11.0)
        : isTooHigh || isNear
          ? 0.5 + 0.5 * Math.sin(elapsed * 6.0)
          : 0.5 + 0.5 * Math.sin(elapsed * 3.5);

    const ringScale = r * (
      isTooHigh
        ? (1.14 + pulse * 0.06)
        : isLowDanger
          ? (0.96 + pulse * 0.10)
          : onTarget
            ? (1.02 + pulse * 0.14)
            : isNear
              ? (1.0 + pulse * 0.06)
              : 1.0
    );

    // Heading basis
    const yawRad = localAircraft ? (localAircraft.yawDeg || 0) * (Math.PI / 180) : 0;
    const fwdX = Math.sin(yawRad);
    const fwdZ = -Math.cos(yawRad);
    const rightX = Math.cos(yawRad);
    const rightZ = Math.sin(yawRad);

    // 1. Drape Target Ring mesh directly onto terrain heightmap (zero hillside clipping!)
    const rPos = this._reticleGeo.attributes.position;
    const cols = RETICLE_SEGS + 1;
    const rows = RETICLE_SEGS + 1;
    const rxScale = ringScale * 0.96;
    const rzScale = ringScale * 1.14;

    for (let j = 0; j < rows; j++) {
      const v = (j / RETICLE_SEGS) * 2.0 - 1.0; // -1..1 along forward
      for (let i = 0; i < cols; i++) {
        const u = (i / RETICLE_SEGS) * 2.0 - 1.0; // -1..1 along right
        const wx = ix + rightX * (u * rxScale) + fwdX * (-v * rzScale);
        const wz = iz + rightZ * (u * rxScale) + fwdZ * (-v * rzScale);
        const wy = Math.max(terrain.waterLevel + 0.45, terrain.getHeight(wx, wz) + 1.15);
        rPos.setXYZ(j * cols + i, wx, wy, wz);
      }
    }
    rPos.needsUpdate = true;
    this._reticleMat.color.copy(targetCol);
    this._reticleMat.opacity = isLowDanger
      ? (0.82 + pulse * 0.18)
      : isTooHigh
        ? (0.58 + pulse * 0.16)
        : onTarget
          ? (0.86 + pulse * 0.14)
          : isNear
            ? (0.74 + pulse * 0.14)
            : (0.60 + pulse * 0.12);

    // 2. Drape Drop Corridor strip (corridorStart -> corridorEnd) directly onto terrain
    let csX = Number.isFinite(dropPreview.corridorStartX) ? dropPreview.corridorStartX : ix - fwdX * r * 0.6;
    let csZ = Number.isFinite(dropPreview.corridorStartZ) ? dropPreview.corridorStartZ : iz - fwdZ * r * 0.6;
    let ceX = Number.isFinite(dropPreview.corridorEndX) ? dropPreview.corridorEndX : ix + fwdX * r * 1.5;
    let ceZ = Number.isFinite(dropPreview.corridorEndZ) ? dropPreview.corridorEndZ : iz + fwdZ * r * 1.5;

    let cdx = ceX - csX;
    let cdz = ceZ - csZ;
    let cLen = Math.hypot(cdx, cdz);
    if (cLen < r * 0.9) {
      csX = ix - fwdX * r * 0.45;
      csZ = iz - fwdZ * r * 0.45;
      ceX = ix + fwdX * r * 1.35;
      ceZ = iz + fwdZ * r * 1.35;
      cdx = ceX - csX;
      cdz = ceZ - csZ;
      cLen = Math.hypot(cdx, cdz);
    }
    const dirX = cdx / Math.max(1, cLen);
    const dirZ = cdz / Math.max(1, cLen);
    const cRightX = -dirZ;
    const cRightZ = dirX;
    const halfWidth = r * (isTooHigh ? 0.72 : 0.60);

    const cPos = this._corridorGeo.attributes.position;
    const cCols = CORRIDOR_SEGS_W + 1;
    const cRows = CORRIDOR_SEGS_L + 1;
    for (let j = 0; j < cRows; j++) {
      const t = 1.0 - j / CORRIDOR_SEGS_L;
      const baseX = csX + cdx * t;
      const baseZ = csZ + cdz * t;
      for (let i = 0; i < cCols; i++) {
        const u = (i / CORRIDOR_SEGS_W) * 2.0 - 1.0;
        const wx = baseX + cRightX * (u * halfWidth);
        const wz = baseZ + cRightZ * (u * halfWidth);
        const wy = Math.max(terrain.waterLevel + 0.35, terrain.getHeight(wx, wz) + 0.9);
        cPos.setXYZ(j * cCols + i, wx, wy, wz);
      }
    }
    cPos.needsUpdate = true;

    this._corridorTex.repeat.set(1, Math.max(1.2, cLen / Math.max(24, r * 1.2)));
    this._corridorTex.offset.y = -(elapsed * (onTarget && !isTooHigh ? 2.4 : 1.2)) % 1;
    this._corridorMat.color.copy(targetCol);
    this._corridorMat.opacity = isTooHigh
      ? (0.36 + pulse * 0.10)
      : onTarget
        ? (0.72 + pulse * 0.22)
        : isNear
          ? (0.58 + pulse * 0.14)
          : (0.44 + pulse * 0.10);

    // 3. Canopy-clearance halo + center pipper beacon (never hidden by pine crowns!)
    const centerGroundY = Math.max(terrain.waterLevel + 0.4, terrain.getHeight(ix, iz));
    const canopyH = onTarget ? 10.5 : 8.5;

    this.reticleHaloMesh.position.set(ix, centerGroundY + canopyH, iz);
    this.reticleHaloMesh.rotation.set(0, -yawRad, 0);
    this.reticleHaloMesh.scale.set(ringScale * 0.88, 1.0, ringScale * 1.04);
    this._haloMat.color.copy(targetCol);
    this._haloMat.opacity = isLowDanger
      ? (0.65 + pulse * 0.30)
      : isTooHigh
        ? (0.38 + pulse * 0.12)
        : onTarget
          ? (0.68 + pulse * 0.28)
          : isNear
            ? (0.44 + pulse * 0.14)
            : 0.26;

    // Vertical center pipper column connecting ground to canopy halo
    this.reticleBeaconMesh.position.set(ix, centerGroundY + 0.6, iz);
    this.reticleBeaconMesh.scale.set(onTarget ? 1.35 : 0.9, canopyH + 2.5, onTarget ? 1.35 : 0.9);
    this._beaconMat.color.copy(targetCol);
    this._beaconMat.opacity = isTooHigh ? 0.22 : onTarget ? (0.56 + pulse * 0.28) : isNear ? 0.34 : 0.20;

    // 4. Expanding lock-on wave when optimal ON TARGET (or danger pulse when too low over fire)
    if ((onTarget && !isTooHigh) || isLowDanger) {
      const wave = (elapsed * (isLowDanger ? 2.2 : 1.65)) % 1.0;
      const pScale = r * (0.75 + wave * 0.78);
      this.reticlePulseMesh.visible = true;
      this.reticlePulseMesh.position.set(ix, centerGroundY + canopyH + 0.4, iz);
      this.reticlePulseMesh.scale.set(pScale, 1.0, pScale);
      this._pulseRingMat.color.copy(isLowDanger ? COL_RETICLE_DANGER : COL_RETICLE_LOCK);
      this._pulseRingMat.opacity = (1.0 - wave) * 0.88;
    } else {
      this.reticlePulseMesh.visible = false;
    }

    this.reticleGroup.visible = true;
  }

  _updateImpactRings(dt) {
    for (let i = 0; i < MAX_IMPACT_RINGS; i++) {
      const r = this._impactRings[i];
      if (!r.active) continue;
      if (r.delay > 0) {
        r.delay -= dt;
        if (r.delay <= 0) {
          r.mesh.visible = true;
        }
        continue;
      }
      r.age += dt;
      if (r.age >= r.life) {
        r.active = false;
        r.mesh.visible = false;
        continue;
      }
      const t = r.age / r.life;
      const easeOut = 1.0 - (1.0 - t) * (1.0 - t);
      const rad = r.startR + (r.endR - r.startR) * easeOut;
      r.mesh.scale.set(rad, 1.0, rad);
      const fadeIn = Math.min(1.0, t / 0.12);
      const fadeOut = 1.0 - Math.max(0.0, (t - 0.18) / 0.82);
      r.mat.opacity = r.peakOpacity * fadeIn * fadeOut * fadeOut;
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
      const fadeIn = Math.min(1.0, t / 0.14);
      const fadeOut = 1.0 - Math.max(0.0, (t - 0.30) / 0.70);
      const opacity = fadeIn * fadeOut * 0.86;
      const fireGlow = Math.max(0.0, 1.0 - t * 1.8) * (this._smokeGlowBoost[i] || 0.88);

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
    const gDrop = -(FLIGHT_CONSTANTS.DROP_GRAVITY || 15.5);
    const windFactor = FLIGHT_CONSTANTS.WIND_DRIFT_FACTOR ?? 0.35;
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
      this._waterVel[o3] += this._waterWind[o2] * windFactor * dt;
      this._waterVel[o3 + 1] += gDrop * dt;
      this._waterVel[o3 + 2] += this._waterWind[o2 + 1] * windFactor * dt;

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
      const s = this._waterScale[i] * (0.72 + age * 1.2);
      this._pos.set(nx, ny, nz);
      this._euler.set(age * 1.4, age * 2.1 + i, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(s * 0.90, s * (1.28 + t * 0.65), s * 0.90);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.waterMesh.setMatrixAt(visibleCount, this._mat);
      this._col.copy(COL_WATER_B).lerp(COL_WATER_A, this._waterColorMix[i] * 0.24);
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
      const drag = this._steamDrag[i] || 0.45;

      this._steamPos[o3] += this._steamVel[o3] * Math.max(0.15, 1.0 - t * drag) * dt;
      this._steamPos[o3 + 1] += this._steamVel[o3 + 1] * Math.max(0.2, 1.0 - t * drag * 0.8) * dt;
      this._steamPos[o3 + 2] += this._steamVel[o3 + 2] * Math.max(0.15, 1.0 - t * drag) * dt;

      const env = t < 0.16 ? t / 0.16 : Math.max(0, 1.0 - (t - 0.16) / 0.84);
      const s = this._steamBaseScale[i] * (0.65 + t * 1.75) * env;
      if (s <= 0.05) continue;

      this._pos.set(this._steamPos[o3], this._steamPos[o3 + 1], this._steamPos[o3 + 2]);
      this._euler.set(age * 0.8, age * 1.1 + i, 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._scale.set(s, s * 0.88, s);
      this._mat.compose(this._pos, this._quat, this._scale);

      this.steamMesh.setMatrixAt(visibleCount, this._mat);
      this._col.setRGB(this._steamRGB[o3], this._steamRGB[o3 + 1], this._steamRGB[o3 + 2]);
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
    if (this.emberBedMesh) this.emberBedMesh.dispose();
    if (this.flameMesh) this.flameMesh.dispose();
    if (this.smokeMesh) this.smokeMesh.dispose();
    if (this.waterMesh) this.waterMesh.dispose();
    if (this.steamMesh) this.steamMesh.dispose();
    if (this.wakeMesh) this.wakeMesh.dispose();
    this._emberBedGeo.dispose();
    this._emberBedMat.dispose();
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
    this._impactRingGeo.dispose();
    this._impactRingTex.dispose();
    for (let i = 0; i < this._impactRings.length; i++) {
      this._impactRings[i].mat.dispose();
    }
    this._corridorGeo.dispose();
    this._corridorMat.dispose();
    this._corridorTex.dispose();
    this._reticleGeo.dispose();
    this._reticleMat.dispose();
    this._reticleTex.dispose();
    if (this._reticleMistTex) this._reticleMistTex.dispose();
    this._haloGeo.dispose();
    this._haloMat.dispose();
    this._pulseRingMat.dispose();
    this._beaconGeo.dispose();
    this._beaconMat.dispose();
  }
}
