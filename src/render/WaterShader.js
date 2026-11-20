import * as THREE from 'three';

const WATER_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

varying vec3 vWorldPos;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const WATER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform vec3 uBaseColor;
uniform vec3 uDeepColor;
uniform vec3 uShimmerColor;
uniform vec3 uHorizonTint;
uniform float uTime;
uniform vec2 uWindDir;

varying vec3 vWorldPos;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 p = vWorldPos.xz;

  // Subtle broad depth modulation across lake surface
  float waveBand = sin(p.x * 0.032 + p.y * 0.018 + uTime * 0.65) * 0.5 + 0.5;
  vec3 color = mix(uDeepColor, uBaseColor, 0.55 + 0.45 * waveBand);

  // Subtle twilight grazing tint at long view angles
  vec3 viewVec = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(viewVec.y, 0.0), 3.0);
  color = mix(color, uHorizonTint, fresnel * 0.24);

  // Scrolling horizontal pale-cyan specular shimmer dashes (#9ecad0)
  vec2 drift = vec2(uTime * 3.8, uTime * 0.9) + uWindDir * uTime * 1.6;
  vec2 sp = p + drift;

  // Layer 1: primary crisp horizontal dashes
  vec2 cell1 = vec2(floor(sp.x / 18.0), floor(sp.y / 6.5));
  vec2 frac1 = vec2(fract(sp.x / 18.0), fract(sp.y / 6.5));
  float h1 = hash21(cell1);
  float pulse1 = 0.5 + 0.5 * sin(uTime * 2.2 + h1 * 42.0);
  float dash1 =
    step(0.76, h1) *
    step(0.14, frac1.x) * step(frac1.x, 0.78) *
    step(0.36, frac1.y) * step(frac1.y, 0.60) *
    step(0.42, pulse1);

  // Layer 2: finer offset sparkle dashes
  vec2 sp2 = p * vec2(1.0, 1.35) - drift * 0.72 + vec2(37.1, 19.4);
  vec2 cell2 = vec2(floor(sp2.x / 13.0), floor(sp2.y / 5.0));
  vec2 frac2 = vec2(fract(sp2.x / 13.0), fract(sp2.y / 5.0));
  float h2 = hash21(cell2 + 17.3);
  float pulse2 = 0.5 + 0.5 * sin(uTime * 3.1 + h2 * 53.0);
  float dash2 =
    step(0.84, h2) *
    step(0.20, frac2.x) * step(frac2.x, 0.72) *
    step(0.40, frac2.y) * step(frac2.y, 0.58) *
    step(0.48, pulse2);

  float shimmer = clamp(dash1 * 0.78 + dash2 * 0.55, 0.0, 1.0);

  // Fade micro-shimmer gracefully at extreme distance to prevent aliasing noise
  float camDist = length(cameraPosition - vWorldPos);
  float distFade = 1.0 - smoothstep(420.0, 1350.0, camDist);

  color = mix(color, uShimmerColor, shimmer * distFade * 0.85);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Creates the flat alpine lake/river water plane at y = waterLevel
 * with scrolling horizontal pale-cyan specular shimmer dashes (#9ecad0).
 */
export function createWaterPlane(worldSize, waterLevel = 12.0) {
  const geometry = new THREE.PlaneGeometry(worldSize, worldSize, 1, 1);
  geometry.rotateX(-Math.PI / 2);

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uBaseColor: { value: new THREE.Color('#23505f') },
      uDeepColor: { value: new THREE.Color('#1c424f') },
      uShimmerColor: { value: new THREE.Color('#9ecad0') },
      uHorizonTint: { value: new THREE.Color('#6e5053') },
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(1, 0) },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    uniforms,
    fog: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = waterLevel;
  mesh.name = 'AlpineWaterPlane';

  return {
    mesh,
    material,
    update(elapsed, windVx = 1, windVz = 0) {
      material.uniforms.uTime.value = elapsed;
      const len = Math.hypot(windVx, windVz) || 1;
      material.uniforms.uWindDir.value.set(windVx / len, windVz / len);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
