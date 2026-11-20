import * as THREE from 'three';

const FLAME_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aPlaneSeed;
attribute float aPhase;
attribute float aIntensity;

uniform float uTime;
uniform vec2 uWind;

varying vec2 vUv;
varying float vPhase;
varying float vIntensity;
varying float vPlaneSeed;

void main() {
  vUv = uv;
  vPhase = aPhase;
  vIntensity = aIntensity;
  vPlaneSeed = aPlaneSeed;

  mat4 instMat = mat4(1.0);
  #ifdef USE_INSTANCING
    instMat = instanceMatrix;
  #endif

  vec3 pos = position;
  float h = clamp(uv.y, 0.0, 1.0);
  float h2 = h * h;

  // Local flickering width breathe & tongue flutter
  float flutter = sin(uTime * 7.4 + aPhase * 6.2831 + aPlaneSeed * 2.1 + h * 5.0) * 0.14
                + cos(uTime * 11.2 + aPhase * 13.7 - h * 6.4) * 0.08;
  pos.x += flutter * h * 1.15;

  // Vertical pulse (tall roaring stretch on strong flames)
  float stretch = 1.0 + 0.12 * sin(uTime * 6.1 + aPhase * 9.42 + aPlaneSeed);
  pos.y *= stretch;

  vec4 worldPosition = modelMatrix * instMat * vec4(pos, 1.0);

  // World-space wind lean + turbulent sway (base anchored, tips whip downwind)
  float windSway = sin(uTime * 4.8 + aPhase * 8.1 + worldPosition.x * 0.06 + worldPosition.z * 0.06) * 0.65;
  worldPosition.x += (uWind.x * 1.55 + windSway * 0.55) * h2 * (0.75 + 0.45 * aIntensity);
  worldPosition.z += (uWind.y * 1.55 - windSway * 0.45) * h2 * (0.75 + 0.45 * aIntensity);

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FLAME_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform float uTime;

varying vec2 vUv;
varying float vPhase;
varying float vIntensity;
varying float vPlaneSeed;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  v += 0.62 * valueNoise(p);
  v += 0.38 * valueNoise(p * 2.13 + vec2(17.1, 31.7));
  return v;
}

void main() {
  float y = clamp(vUv.y, 0.0, 1.0);
  float dx = abs(vUv.x - 0.5) * 2.0;

  // Upward-scrolling procedural turbulence
  float speed = 2.6 + vIntensity * 1.35;
  vec2 nUv = vec2(vUv.x * 2.8 + vPhase * 7.3 + vPlaneSeed * 1.9, y * 2.5 - uTime * speed + vPhase * 3.1);
  float n1 = fbm(nUv);
  float n2 = valueNoise(vec2(vUv.x * 5.2 - vPhase * 4.7, y * 4.4 - uTime * (speed * 1.45)));
  float turb = n1 * 0.68 + n2 * 0.32;

  // Secondary split flame tongues along width so silhouettes feel ragged and organic
  float tongueWave = 0.16 * sin(vUv.x * 9.4248 + vPhase * 12.0 + uTime * 4.2 + y * 3.0) * y;

  // Teardrop tapered flame profile: full warm base, licking pointed crown
  float baseFull = smoothstep(0.0, 0.16, y);
  float topTaper = pow(max(0.0, 1.0 - y), 0.78);
  float widthEnv = (0.42 + 0.56 * baseFull) * topTaper + tongueWave;

  // Horizontal distortion increases upward into flickering tips
  float warpDx = dx + (turb - 0.5) * (0.28 + 0.68 * y);
  float shape = widthEnv - warpDx + (turb - 0.45) * (0.42 + 0.55 * y);

  // Softly anchor base & sharpen ragged tip cutoff
  float alpha = smoothstep(0.02, 0.22, shape) * smoothstep(0.0, 0.055, y);
  if (alpha < 0.09) {
    discard;
  }

  // Hot-to-cool vertical + interior core temperature ramp:
  // #a81808 crimson tips -> #ff5510 orange -> #ffb326 gold -> #fff6cc white-hot core
  float coreHeat = clamp(
    shape * 1.55 + (1.0 - y) * 0.52 + (vIntensity - 0.55) * 0.36 + (n2 - 0.5) * 0.16,
    0.0,
    1.35
  );

  vec3 colCrimson = vec3(0.659, 0.094, 0.031); // #a81808
  vec3 colOrange  = vec3(1.000, 0.333, 0.063); // #ff5510
  vec3 colGold    = vec3(1.000, 0.702, 0.149); // #ffb326
  vec3 colCore    = vec3(1.000, 0.965, 0.800); // #fff6cc

  vec3 col = mix(colCrimson, colOrange, smoothstep(0.05, 0.40, coreHeat));
  col = mix(col, colGold, smoothstep(0.38, 0.78, coreHeat));
  col = mix(col, colCore, smoothstep(0.76, 1.12, coreHeat));

  // Subtle brightness punch for incandescent flame hearts
  float corePunch = smoothstep(0.75, 1.25, coreHeat) * 0.22;
  col = min(vec3(1.18), col * (1.0 + corePunch));

  gl_FragColor = vec4(col, alpha * 0.96);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const EMBER_BED_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aPhase;
attribute float aIntensity;
attribute float aMode;

varying vec2 vUv;
varying float vPhase;
varying float vIntensity;
varying float vMode;

void main() {
  vUv = uv;
  vPhase = aPhase;
  vIntensity = aIntensity;
  vMode = aMode;

  mat4 instMat = mat4(1.0);
  #ifdef USE_INSTANCING
    instMat = instanceMatrix;
  #endif

  vec4 worldPosition = modelMatrix * instMat * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const EMBER_BED_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform float uTime;

varying vec2 vUv;
varying float vPhase;
varying float vIntensity;
varying float vMode;

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 centered = vUv * 2.0 - 1.0;
  float dist = length(centered);
  if (dist > 1.0) discard;

  float n = noise2(centered * 3.2 + vec2(vPhase * 9.7, uTime * 0.9));
  float nFine = noise2(centered * 7.5 - vec2(uTime * 1.6, vPhase * 13.1));

  // Organic irregular ember bed perimeter (zero square corners)
  float radial = 1.0 - smoothstep(0.15, 0.98, dist + (n - 0.5) * 0.34);
  if (radial < 0.03) discard;

  float pulse = 0.80 + 0.20 * sin(uTime * 6.5 + vPhase * 6.2831 + n * 3.0);

  if (vMode > 0.5) {
    // Ember-spot warning cell (state 15): pulsing amber-gold hot ember glow
    float warnPulse = 0.55 + 0.45 * sin(uTime * 10.5 + vPhase * 6.2831);
    float ring = smoothstep(0.45, 0.72, dist) * (1.0 - smoothstep(0.72, 0.96, dist));
    vec3 col = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.84, 0.32), clamp(radial + ring, 0.0, 1.0));
    float a = (radial * 0.55 + ring * 0.75) * warnPulse;
    gl_FragColor = vec4(col, a);
  } else {
    // Active fire glowing ember bed under flames
    float cracks = smoothstep(0.32, 0.82, n * 0.55 + nFine * 0.45);
    vec3 outerCol = vec3(0.68, 0.14, 0.04);
    vec3 midCol   = vec3(1.00, 0.36, 0.06);
    vec3 hotCol   = vec3(1.00, 0.78, 0.24);
    vec3 col = mix(outerCol, midCol, smoothstep(0.15, 0.62, radial));
    col = mix(col, hotCol, smoothstep(0.55, 0.95, radial * (0.65 + 0.55 * cracks)) * vIntensity);
    float a = radial * (0.48 + 0.34 * vIntensity) * pulse;
    gl_FragColor = vec4(col, a);
  }

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Builds a 3-plane crossed tapered flame cluster geometry (0, 60, 120 deg)
 * with 4 vertical subdivisions for smooth curved wind-lean bending and organic silhouettes.
 */
export function createFlameGeometry() {
  const planes = 3;
  const segsY = 4;
  const positions = [];
  const uvs = [];
  const planeSeeds = [];

  const halfWBase = 2.65;
  const height = 9.2;

  for (let p = 0; p < planes; p++) {
    const angle = (p / planes) * Math.PI;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const seed = p * 1.73;

    // Subtle off-center radial offset per ribbon so crossed planes don't pinch to a thin line
    const offX = -sa * 0.18;
    const offZ = ca * 0.18;

    for (let s = 0; s < segsY; s++) {
      const v0 = s / segsY;
      const v1 = (s + 1) / segsY;
      const y0 = v0 * height;
      const y1 = v1 * height;

      // Slight natural bulge near base, gentle taper toward tip
      const w0 = halfWBase * (1.0 - v0 * 0.24 + Math.sin(v0 * Math.PI) * 0.12);
      const w1 = halfWBase * (1.0 - v1 * 0.24 + Math.sin(v1 * Math.PI) * 0.12);

      const x0L = offX - ca * w0;
      const z0L = offZ - sa * w0;
      const x0R = offX + ca * w0;
      const z0R = offZ + sa * w0;

      const x1L = offX - ca * w1;
      const z1L = offZ - sa * w1;
      const x1R = offX + ca * w1;
      const z1R = offZ + sa * w1;

      // Tri 1: (0L, 0R, 1R)
      positions.push(x0L, y0, z0L, x0R, y0, z0R, x1R, y1, z1R);
      uvs.push(0, v0, 1, v0, 1, v1);
      planeSeeds.push(seed, seed, seed);

      // Tri 2: (0L, 1R, 1L)
      positions.push(x0L, y0, z0L, x1R, y1, z1R, x1L, y1, z1L);
      uvs.push(0, v0, 1, v1, 0, v1);
      planeSeeds.push(seed, seed, seed);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('aPlaneSeed', new THREE.Float32BufferAttribute(planeSeeds, 1));
  return geom;
}

/**
 * Creates the GLSL ES 1.00 / WebGL1+2 compatible animated organic wildfire ShaderMaterial.
 */
export function createFlameMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(0, 0) },
    },
  ]);

  return new THREE.ShaderMaterial({
    vertexShader: FLAME_VERTEX_SHADER,
    fragmentShader: FLAME_FRAGMENT_SHADER,
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

/**
 * Creates the organic radial glowing ember-bed decal ShaderMaterial rendered under active fire.
 */
export function createEmberBedMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
    },
  ]);

  return new THREE.ShaderMaterial({
    vertexShader: EMBER_BED_VERTEX_SHADER,
    fragmentShader: EMBER_BED_FRAGMENT_SHADER,
    uniforms,
    fog: true,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    blending: THREE.AdditiveBlending,
  });
}
