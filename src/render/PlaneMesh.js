import * as THREE from 'three';
import { LIVERIES } from '../config/liveries.js';

const DEFAULT_LIVERY = {
  id: 0,
  name: 'EF-07 Canary',
  primary: '#f8ce64',
  shaded: '#d08a2e',
  accent: '#e0542d',
  stripe: '#f2f2f2',
  pontoon: '#8a929a',
  hudColor: '#f8ce64',
};

const ROLE_PRIMARY = 0;
const ROLE_SHADED = 1;
const ROLE_ACCENT = 2;
const ROLE_STRIPE = 3;
const ROLE_PONTOON = 4;
const ROLE_DARK = 5;

const DARK_COLOR = new THREE.Color('#222222');

/**
 * Helper to collect flat-shaded triangles with a per-vertex role ID
 * (0=primary, 1=shaded, 2=accent, 3=stripe, 4=pontoon, 5=dark).
 */
class LowPolyBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.roles = [];
    this._vA = new THREE.Vector3();
    this._vB = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._ab = new THREE.Vector3();
    this._ac = new THREE.Vector3();
    this._n = new THREE.Vector3();
  }

  addTri(ax, ay, az, bx, by, bz, cx, cy, cz, role) {
    this._vA.set(ax, ay, az);
    this._vB.set(bx, by, bz);
    this._vC.set(cx, cy, cz);
    this._ab.subVectors(this._vB, this._vA);
    this._ac.subVectors(this._vC, this._vA);
    this._n.crossVectors(this._ab, this._ac).normalize();

    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.normals.push(
      this._n.x, this._n.y, this._n.z,
      this._n.x, this._n.y, this._n.z,
      this._n.x, this._n.y, this._n.z
    );
    this.roles.push(role, role, role);
  }

  addQuad(a, b, c, d, role) {
    this.addTri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], role);
    this.addTri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], role);
  }

  /**
   * Adds a tapered rectangular prism between two Z slices (zFront < zBack; nose is -Z).
   * roles = { top, bottom, side, front, back }
   */
  addTaperedSection(
    zFront, wFront, yTopF, yBotF,
    zBack, wBack, yTopB, yBotB,
    roles,
    xOffset = 0,
    capFront = false,
    capBack = false
  ) {
    const hwF = wFront * 0.5;
    const hwB = wBack * 0.5;

    const flt = [xOffset - hwF, yTopF, zFront];
    const frt = [xOffset + hwF, yTopF, zFront];
    const flb = [xOffset - hwF, yBotF, zFront];
    const frb = [xOffset + hwF, yBotF, zFront];

    const blt = [xOffset - hwB, yTopB, zBack];
    const brt = [xOffset + hwB, yTopB, zBack];
    const blb = [xOffset - hwB, yBotB, zBack];
    const brb = [xOffset + hwB, yBotB, zBack];

    // Top (+Y)
    this.addQuad(flt, blt, brt, frt, roles.top);
    // Bottom (-Y)
    this.addQuad(flb, frb, brb, blb, roles.bottom);
    // Right (+X)
    this.addQuad(frt, brt, brb, frb, roles.side);
    // Left (-X)
    this.addQuad(blt, flt, flb, blb, roles.side);

    if (capFront) {
      this.addQuad(flt, frt, frb, flb, roles.front ?? roles.side);
    }
    if (capBack) {
      this.addQuad(brt, blt, blb, brb, roles.back ?? roles.side);
    }
  }

  /**
   * Adds an axis-aligned box centered at (cx, cy, cz) with size (sx, sy, sz).
   */
  addBox(cx, cy, cz, sx, sy, sz, roles) {
    const r = typeof roles === 'number'
      ? { top: roles, bottom: roles, side: roles, front: roles, back: roles }
      : roles;
    this.addTaperedSection(
      cz - sz * 0.5, sx, cy + sy * 0.5, cy - sy * 0.5,
      cz + sz * 0.5, sx, cy + sy * 0.5, cy - sy * 0.5,
      r, cx, true, true
    );
  }

  /**
   * Adds a thin oriented strut between two 3D points (8 tris).
   */
  addStrut(p0, p1, thickness, role) {
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

    this.addQuad(a0, a1, b1, b0, role);
    this.addQuad(a1, a2, b2, b1, role);
    this.addQuad(a2, a3, b3, b2, role);
    this.addQuad(a3, a0, b0, b3, role);
  }

  buildGeometry() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geom.setAttribute('aPartRole', new THREE.Float32BufferAttribute(this.roles, 1));
    return geom;
  }
}

/**
 * Builds the procedural ~260-triangle twin-pontoon amphibious water-bomber geometry.
 * Forward nose points along -Z, wingspan along +-X, up along +Y.
 */
export function buildFloatplaneGeometry() {
  const b = new LowPolyBuilder();

  // --- FUSELAGE (nose -Z = -3.35 to tail +Z = +4.45) ---
  // 1. Engine spinner/cowl nose cap (accent ring + dark intake)
  b.addTaperedSection(
    -3.35, 0.56, 0.16, -0.34,
    -2.92, 0.92, 0.34, -0.48,
    { top: ROLE_ACCENT, bottom: ROLE_SHADED, side: ROLE_ACCENT, front: ROLE_DARK },
    0, true, false
  );
  // 2. Engine cowling (yellow top/side, amber belly)
  b.addTaperedSection(
    -2.92, 0.92, 0.34, -0.48,
    -1.65, 1.12, 0.44, -0.58,
    { top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY },
    0, false, false
  );
  // 3. Main cabin fuselage lower body
  b.addTaperedSection(
    -1.65, 1.12, 0.32, -0.58,
    0.85, 1.06, 0.36, -0.56,
    { top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY },
    0, false, false
  );
  // 4. Cockpit greenhouse / windshield cabin top (dark glass)
  b.addTaperedSection(
    -1.55, 0.94, 0.80, 0.30,
    -0.55, 1.04, 0.86, 0.30,
    { top: ROLE_PRIMARY, bottom: ROLE_DARK, side: ROLE_DARK, front: ROLE_DARK },
    0, true, false
  );
  // Rear upper cabin fairing behind cockpit
  b.addTaperedSection(
    -0.55, 1.04, 0.86, 0.32,
    0.85, 0.98, 0.68, 0.34,
    { top: ROLE_PRIMARY, bottom: ROLE_PRIMARY, side: ROLE_STRIPE, back: ROLE_PRIMARY },
    0, false, true
  );
  // 5. Mid tailboom taper
  b.addTaperedSection(
    0.85, 1.06, 0.62, -0.54,
    2.75, 0.60, 0.44, -0.24,
    { top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY },
    0, false, false
  );
  // 6. Aft tailboom tip (crimson accent tail cone)
  b.addTaperedSection(
    2.75, 0.60, 0.44, -0.24,
    4.35, 0.24, 0.34, 0.02,
    { top: ROLE_ACCENT, bottom: ROLE_SHADED, side: ROLE_ACCENT, back: ROLE_ACCENT },
    0, false, true
  );

  // --- HIGH WING (y = +0.86, total span 12.6 m, chord 1.9 m) ---
  // Center wing section (x = -2.2..+2.2)
  b.addBox(0, 0.92, -0.45, 4.4, 0.22, 1.92, {
    top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY, front: ROLE_PRIMARY, back: ROLE_SHADED,
  });
  // Left & Right White identification stripe bands (x = +-2.2..+-3.0)
  for (const s of [-1, 1]) {
    b.addBox(s * 2.6, 0.92, -0.45, 0.80, 0.21, 1.88, {
      top: ROLE_STRIPE, bottom: ROLE_STRIPE, side: ROLE_STRIPE, front: ROLE_STRIPE, back: ROLE_STRIPE,
    });
    // Mid-outer yellow wing panels (x = +-3.0..+-5.0)
    b.addBox(s * 4.0, 0.92, -0.42, 2.00, 0.19, 1.76, {
      top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY, front: ROLE_PRIMARY, back: ROLE_SHADED,
    });
    // Crimson wingtips (x = +-5.0..+-6.3)
    b.addBox(s * 5.65, 0.93, -0.38, 1.30, 0.17, 1.56, {
      top: ROLE_ACCENT, bottom: ROLE_ACCENT, side: ROLE_ACCENT, front: ROLE_ACCENT, back: ROLE_ACCENT,
    });
  }

  // Twin V-struts supporting high wing from lower fuselage
  for (const s of [-1, 1]) {
    b.addStrut([s * 0.54, -0.42, -0.95], [s * 2.95, 0.84, -0.85], 0.085, ROLE_DARK);
    b.addStrut([s * 0.54, -0.42, 0.12], [s * 2.95, 0.84, 0.05], 0.085, ROLE_DARK);
  }

  // --- EMPENNAGE (Horizontal & Vertical Stabilizers) ---
  // Horizontal stabilizer (span 4.1 m)
  b.addBox(0, 0.42, 3.65, 3.2, 0.12, 1.05, {
    top: ROLE_PRIMARY, bottom: ROLE_SHADED, side: ROLE_PRIMARY, front: ROLE_PRIMARY, back: ROLE_SHADED,
  });
  for (const s of [-1, 1]) {
    b.addBox(s * 1.92, 0.42, 3.70, 0.65, 0.11, 0.92, ROLE_ACCENT);
  }

  // Vertical stabilizer / tail fin (crimson + white stripe)
  b.addTaperedSection(
    2.65, 0.14, 0.80, 0.36,
    4.25, 0.14, 1.92, 0.32,
    { top: ROLE_ACCENT, bottom: ROLE_ACCENT, side: ROLE_ACCENT, front: ROLE_ACCENT, back: ROLE_STRIPE },
    0, true, true
  );
  b.addBox(0, 1.78, 3.78, 0.15, 0.24, 0.92, ROLE_STRIPE);

  // --- TWIN AMPHIBIOUS PONTOONS (x = +-1.48, y = -1.48) ---
  for (const s of [-1, 1]) {
    const px = s * 1.48;
    // Pontoon bow tip (crimson nose bumper)
    b.addTaperedSection(
      -3.05, 0.22, -1.26, -1.58,
      -2.45, 0.56, -1.20, -1.70,
      { top: ROLE_ACCENT, bottom: ROLE_PONTOON, side: ROLE_ACCENT, front: ROLE_DARK },
      px, true, false
    );
    // Pontoon main hull
    b.addTaperedSection(
      -2.45, 0.56, -1.20, -1.70,
      0.55, 0.58, -1.22, -1.72,
      { top: ROLE_PONTOON, bottom: ROLE_DARK, side: ROLE_PONTOON },
      px, false, false
    );
    // Pontoon aft taper
    b.addTaperedSection(
      0.55, 0.58, -1.22, -1.72,
      2.15, 0.26, -1.26, -1.52,
      { top: ROLE_PONTOON, bottom: ROLE_DARK, side: ROLE_PONTOON, back: ROLE_PONTOON },
      px, false, true
    );

    // Diagonal pontoon struts to fuselage
    b.addStrut([s * 0.48, -0.52, -1.55], [px, -1.22, -1.40], 0.09, ROLE_DARK);
    b.addStrut([s * 0.48, -0.52, 0.35], [px, -1.22, 0.30], 0.09, ROLE_DARK);
  }
  // Cross-bracing spreader bars between pontoons
  b.addStrut([-1.45, -1.24, -1.40], [1.45, -1.24, -1.40], 0.075, ROLE_PONTOON);
  b.addStrut([-1.45, -1.24, 0.30], [1.45, -1.24, 0.30], 0.075, ROLE_PONTOON);

  return b.buildGeometry();
}

/**
 * Applies a livery palette to a floatplane BufferGeometry's vertex `color` attribute.
 */
function paintFloatplaneVertexColors(geometry, livery) {
  const liv = livery || DEFAULT_LIVERY;
  const roles = geometry.getAttribute('aPartRole');
  const count = roles.count;

  let colorAttr = geometry.getAttribute('color');
  if (!colorAttr) {
    colorAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute('color', colorAttr);
  }

  const palette = [
    new THREE.Color(liv.primary || DEFAULT_LIVERY.primary),
    new THREE.Color(liv.shaded || DEFAULT_LIVERY.shaded),
    new THREE.Color(liv.accent || DEFAULT_LIVERY.accent),
    new THREE.Color(liv.stripe || DEFAULT_LIVERY.stripe),
    new THREE.Color(liv.pontoon || DEFAULT_LIVERY.pontoon),
    DARK_COLOR,
  ];

  const arr = colorAttr.array;
  for (let i = 0; i < count; i++) {
    const roleIdx = Math.min(5, Math.max(0, Math.round(roles.getX(i))));
    const c = palette[roleIdx];
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  colorAttr.needsUpdate = true;
}

/**
 * Generates a crisp pixelated canvas texture for the spinning propeller blur disc.
 */
function createPropellerTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Subtle translucent sweep ring
  ctx.fillStyle = 'rgba(215, 224, 232, 0.24)';
  ctx.beginPath();
  ctx.arc(cx, cy, 29, 0, Math.PI * 2);
  ctx.fill();

  // Three motion-blurred dark blades with yellow safety tips
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);
    ctx.fillStyle = 'rgba(34, 34, 34, 0.62)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 27, -0.18, 0.18);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(248, 206, 100, 0.78)';
    ctx.beginPath();
    ctx.arc(0, 0, 29, -0.16, 0.16);
    ctx.arc(0, 0, 24, 0.16, -0.16, true);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Spinner hub
  ctx.fillStyle = '#222222';
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a crisp canvas-painted wing stencil texture ("07" or slot digits).
 */
function createWingStencilTexture(label = '07') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 64, 32);

  ctx.fillStyle = '#222222';
  ctx.font = '900 24px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label).slice(0, 3), 32, 17);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates the dedicated hero floatplane mesh (body + "07" wing stencil + spinning prop disk).
 */
export function createHeroPlaneMesh(liveryIndex = 0, stencilText = '07') {
  const group = new THREE.Group();
  group.name = 'HeroFloatplane';
  group.rotation.order = 'YXZ';

  const livery = LIVERIES[liveryIndex] || DEFAULT_LIVERY;
  const bodyGeo = buildFloatplaneGeometry();
  paintFloatplaneVertexColors(bodyGeo, livery);

  const bodyMat = new THREE.MeshLambertMaterial({
    flatShading: true,
    vertexColors: true,
  });
  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.name = 'HeroFloatplaneBody';
  group.add(bodyMesh);

  // Canvas-painted "07" wing stencil on upper starboard/center wing
  let currentStencil = stencilText;
  let stencilTex = createWingStencilTexture(currentStencil);
  const stencilGeo = new THREE.PlaneGeometry(1.55, 0.80);
  stencilGeo.rotateX(-Math.PI / 2);
  const stencilMat = new THREE.MeshBasicMaterial({
    map: stencilTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const stencilMesh = new THREE.Mesh(stencilGeo, stencilMat);
  stencilMesh.position.set(0.0, 1.045, -0.45);
  group.add(stencilMesh);

  // Spinning propeller blur disk at nose
  const propTex = createPropellerTexture();
  const propGeo = new THREE.PlaneGeometry(2.15, 2.15);
  const propMat = new THREE.MeshBasicMaterial({
    map: propTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const propMesh = new THREE.Mesh(propGeo, propMat);
  propMesh.position.set(0, -0.06, -3.44);
  group.add(propMesh);

  let currentLiveryIdx = liveryIndex;

  return {
    group,
    propMesh,
    setLivery(idx) {
      const safeIdx = ((idx | 0) % LIVERIES.length + LIVERIES.length) % LIVERIES.length;
      if (safeIdx === currentLiveryIdx) return;
      currentLiveryIdx = safeIdx;
      paintFloatplaneVertexColors(bodyGeo, LIVERIES[safeIdx] || DEFAULT_LIVERY);
    },
    setStencil(text) {
      const next = String(text || '07').slice(0, 3);
      if (next === currentStencil) return;
      currentStencil = next;
      const old = stencilTex;
      stencilTex = createWingStencilTexture(next);
      stencilMat.map = stencilTex;
      stencilMat.needsUpdate = true;
      old.dispose();
    },
    updatePose(aircraft, dt) {
      group.position.set(aircraft.x, aircraft.y, aircraft.z);
      const yawRad = THREE.MathUtils.degToRad(aircraft.yawDeg || 0);
      const pitchRad = THREE.MathUtils.degToRad(aircraft.pitchDeg || 0);
      const rollRad = THREE.MathUtils.degToRad(aircraft.rollDeg || 0);
      // YXZ intrinsic: -yaw (0=North -Z, 90=East +X), +pitch (nose up), -roll (right bank)
      group.rotation.set(pitchRad, -yawRad, -rollRad, 'YXZ');

      const speedFactor = 0.75 + ((aircraft.speedKmh || 158) / 160) * 0.65;
      propMesh.rotation.z += dt * 36.0 * speedFactor;
    },
    dispose() {
      bodyGeo.dispose();
      bodyMat.dispose();
      stencilGeo.dispose();
      stencilMat.dispose();
      stencilTex.dispose();
      propGeo.dispose();
      propMat.dispose();
      propTex.dispose();
    },
  };
}

// --- REMOTE PLANE FLEET (up to 99 remote aircraft in 2 instanced draw calls) ---

const REMOTE_BODY_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aPartRole;
attribute vec3 aPrimary;
attribute vec3 aShaded;
attribute vec3 aAccent;
attribute vec3 aStripe;
attribute vec3 aPontoon;
attribute float aAlpha;

varying vec3 vColor;
varying vec3 vWorldNormal;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;

  // Select per-instance 5-zone livery color by vertex part role
  vec3 c = aPrimary;
  if (aPartRole > 0.5 && aPartRole < 1.5) c = aShaded;
  else if (aPartRole >= 1.5 && aPartRole < 2.5) c = aAccent;
  else if (aPartRole >= 2.5 && aPartRole < 3.5) c = aStripe;
  else if (aPartRole >= 3.5 && aPartRole < 4.5) c = aPontoon;
  else if (aPartRole >= 4.5) c = vec3(0.016, 0.016, 0.016); // #222222 linear
  vColor = c;

  vec4 localPos = instanceMatrix * vec4(position, 1.0);
  vec4 worldPosition = modelMatrix * localPos;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const REMOTE_BODY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;

varying vec3 vColor;
varying vec3 vWorldNormal;
varying float vAlpha;

float bayer4x4(vec2 p) {
  vec2 p0 = mod(floor(p), 4.0);
  vec2 p1 = floor(p0 * 0.5);
  vec2 p2 = mod(p0, 2.0);
  float b1 = mod(p1.x * 2.0 + p1.y * 3.0, 4.0);
  float b2 = mod(p2.x * 2.0 + p2.y * 3.0, 4.0);
  return (b2 * 4.0 + b1 + 0.5) / 16.0;
}

void main() {
  // Smooth < 15 m camera proximity alpha-fade (1.0 at >=15m -> 0.12 at <=4m)
  // via ordered Bayer screen-door discard so zero depth-sorting artifacts occur.
  if (vAlpha < 0.995) {
    if (vAlpha <= bayer4x4(gl_FragCoord.xy)) {
      discard;
    }
  }

  vec3 n = normalize(vWorldNormal);
  float ndl = max(dot(n, normalize(uSunDir)), 0.0);
  vec3 hemi = mix(uHemiGround, uHemiSky, n.y * 0.5 + 0.5);
  vec3 light = uSunColor * (ndl * 0.90) + hemi * 0.65;

  vec3 finalCol = vColor * light;
  gl_FragColor = vec4(finalCol, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const REMOTE_PROP_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aAlpha;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vUv = uv;
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const REMOTE_PROP_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  float alpha = tex.a * vAlpha;
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(tex.rgb, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Instanced fleet renderer for up to 99 remote aircraft across all 16 LIVERIES
 * with < 15 m camera proximity alpha-fade (1.0 at 15 m -> 0.12 at <= 4 m).
 */
export class RemotePlaneFleet {
  constructor(maxInstances = 99) {
    this.maxInstances = maxInstances;
    this.activeCount = 0;

    // Pre-convert all 16 liveries into linear THREE.Color once (zero per-frame alloc)
    this._palette = LIVERIES.map((liv) => ({
      primary: new THREE.Color(liv.primary),
      shaded: new THREE.Color(liv.shaded),
      accent: new THREE.Color(liv.accent),
      stripe: new THREE.Color(liv.stripe),
      pontoon: new THREE.Color(liv.pontoon),
    }));

    // Body InstancedMesh
    this._bodyGeo = buildFloatplaneGeometry();
    this._primaryArr = new Float32Array(maxInstances * 3);
    this._shadedArr = new Float32Array(maxInstances * 3);
    this._accentArr = new Float32Array(maxInstances * 3);
    this._stripeArr = new Float32Array(maxInstances * 3);
    this._pontoonArr = new Float32Array(maxInstances * 3);
    this._alphaArr = new Float32Array(maxInstances);

    this._primaryAttr = new THREE.InstancedBufferAttribute(this._primaryArr, 3);
    this._shadedAttr = new THREE.InstancedBufferAttribute(this._shadedArr, 3);
    this._accentAttr = new THREE.InstancedBufferAttribute(this._accentArr, 3);
    this._stripeAttr = new THREE.InstancedBufferAttribute(this._stripeArr, 3);
    this._pontoonAttr = new THREE.InstancedBufferAttribute(this._pontoonArr, 3);
    this._alphaAttr = new THREE.InstancedBufferAttribute(this._alphaArr, 1);

    this._bodyGeo.setAttribute('aPrimary', this._primaryAttr);
    this._bodyGeo.setAttribute('aShaded', this._shadedAttr);
    this._bodyGeo.setAttribute('aAccent', this._accentAttr);
    this._bodyGeo.setAttribute('aStripe', this._stripeAttr);
    this._bodyGeo.setAttribute('aPontoon', this._pontoonAttr);
    this._bodyGeo.setAttribute('aAlpha', this._alphaAttr);

    const bodyUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSunDir: { value: new THREE.Vector3(-0.65, 0.45, -0.60).normalize() },
        uSunColor: { value: new THREE.Color('#ffbe8a') },
        uHemiSky: { value: new THREE.Color('#5c5270') },
        uHemiGround: { value: new THREE.Color('#2b3d38') },
      },
    ]);

    this._bodyMat = new THREE.ShaderMaterial({
      vertexShader: REMOTE_BODY_VERTEX_SHADER,
      fragmentShader: REMOTE_BODY_FRAGMENT_SHADER,
      uniforms: bodyUniforms,
      fog: true,
      depthWrite: true,
    });

    this.bodyMesh = new THREE.InstancedMesh(this._bodyGeo, this._bodyMat, maxInstances);
    this.bodyMesh.name = 'RemotePlaneFleetBody';
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.count = 0;

    // Propeller InstancedMesh
    this._propGeo = new THREE.PlaneGeometry(2.15, 2.15);
    this._propAlphaAttr = new THREE.InstancedBufferAttribute(this._alphaArr, 1);
    this._propGeo.setAttribute('aAlpha', this._propAlphaAttr);

    this._propTex = createPropellerTexture();
    const propUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uMap: { value: this._propTex },
      },
    ]);
    this._propMat = new THREE.ShaderMaterial({
      vertexShader: REMOTE_PROP_VERTEX_SHADER,
      fragmentShader: REMOTE_PROP_FRAGMENT_SHADER,
      uniforms: propUniforms,
      fog: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.propMesh = new THREE.InstancedMesh(this._propGeo, this._propMat, maxInstances);
    this.propMesh.name = 'RemotePlaneFleetProps';
    this.propMesh.frustumCulled = false;
    this.propMesh.count = 0;

    this.group = new THREE.Group();
    this.group.name = 'RemotePlaneFleet';
    this.group.add(this.bodyMesh);
    this.group.add(this.propMesh);

    // Preallocated scratch objects (zero per-frame allocations)
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._quat = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._mat = new THREE.Matrix4();
    this._propLocalMat = new THREE.Matrix4();
    this._propRotQuat = new THREE.Quaternion();
    this._propPosLocal = new THREE.Vector3(0, -0.06, -3.44);
    this._propAxisZ = new THREE.Vector3(0, 0, 1);
    this._propWorldMat = new THREE.Matrix4();
  }

  /**
   * Updates all remote aircraft instances from the interpolated remotePlanes array.
   */
  update(remotePlanes, cameraPos, elapsed) {
    if (!remotePlanes || remotePlanes.length === 0) {
      this.activeCount = 0;
      this.bodyMesh.count = 0;
      this.propMesh.count = 0;
      return;
    }

    const count = Math.min(remotePlanes.length, this.maxInstances);
    const palLen = this._palette.length;
    const camX = cameraPos.x;
    const camY = cameraPos.y;
    const camZ = cameraPos.z;

    for (let i = 0; i < count; i++) {
      const p = remotePlanes[i];
      const yawRad = (p.yawDeg || 0) * (Math.PI / 180);
      const pitchRad = (p.pitchDeg || 0) * (Math.PI / 180);
      const rollRad = (p.rollDeg || 0) * (Math.PI / 180);

      this._pos.set(p.x, p.y, p.z);
      this._euler.set(pitchRad, -yawRad, -rollRad, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._mat.compose(this._pos, this._quat, this._scale);
      this.bodyMesh.setMatrixAt(i, this._mat);

      // Spinning propeller disk at nose in plane local frame
      const spinAngle = elapsed * 38.0 + (p.slotId || i) * 1.37;
      this._propRotQuat.setFromAxisAngle(this._propAxisZ, spinAngle);
      this._propLocalMat.compose(this._propPosLocal, this._propRotQuat, this._scale);
      this._propWorldMat.multiplyMatrices(this._mat, this._propLocalMat);
      this.propMesh.setMatrixAt(i, this._propWorldMat);

      // Livery colors
      const cIdx = (((p.colorIdx ?? p.slotId ?? 0) | 0) % palLen + palLen) % palLen;
      const liv = this._palette[cIdx];
      const o3 = i * 3;
      this._primaryArr[o3] = liv.primary.r;
      this._primaryArr[o3 + 1] = liv.primary.g;
      this._primaryArr[o3 + 2] = liv.primary.b;

      this._shadedArr[o3] = liv.shaded.r;
      this._shadedArr[o3 + 1] = liv.shaded.g;
      this._shadedArr[o3 + 2] = liv.shaded.b;

      this._accentArr[o3] = liv.accent.r;
      this._accentArr[o3 + 1] = liv.accent.g;
      this._accentArr[o3 + 2] = liv.accent.b;

      this._stripeArr[o3] = liv.stripe.r;
      this._stripeArr[o3 + 1] = liv.stripe.g;
      this._stripeArr[o3 + 2] = liv.stripe.b;

      this._pontoonArr[o3] = liv.pontoon.r;
      this._pontoonArr[o3 + 1] = liv.pontoon.g;
      this._pontoonArr[o3 + 2] = liv.pontoon.b;

      // Camera proximity fade: 1.0 at >= 15 m, smoothly down to 0.12 at <= 4 m
      const dx = p.x - camX;
      const dy = p.y - camY;
      const dz = p.z - camZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let alpha = 1.0;
      if (dist < 15.0) {
        const t = Math.max(0.0, Math.min(1.0, (dist - 4.0) / 11.0));
        alpha = 0.12 + 0.88 * t;
      }
      this._alphaArr[i] = alpha;
    }

    this.activeCount = count;
    this.bodyMesh.count = count;
    this.propMesh.count = count;

    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.propMesh.instanceMatrix.needsUpdate = true;
    this._primaryAttr.needsUpdate = true;
    this._shadedAttr.needsUpdate = true;
    this._accentAttr.needsUpdate = true;
    this._stripeAttr.needsUpdate = true;
    this._pontoonAttr.needsUpdate = true;
    this._alphaAttr.needsUpdate = true;
    this._propAlphaAttr.needsUpdate = true;
  }

  dispose() {
    if (this.bodyMesh) this.bodyMesh.dispose();
    if (this.propMesh) this.propMesh.dispose();
    this._bodyGeo.dispose();
    this._bodyMat.dispose();
    this._propGeo.dispose();
    this._propMat.dispose();
    this._propTex.dispose();
  }
}
