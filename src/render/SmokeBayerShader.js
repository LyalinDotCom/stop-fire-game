import * as THREE from 'three';

const SMOKE_BAYER_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aOpacity;
attribute float aFireGlow;

varying vec3 vWorldNormal;
varying float vOpacity;
varying float vFireGlow;

void main() {
  vOpacity = aOpacity;
  vFireGlow = aFireGlow;

  mat4 instMat = mat4(1.0);
  #ifdef USE_INSTANCING
    instMat = instanceMatrix;
  #endif

  vec4 localPos = instMat * vec4(position, 1.0);
  vec4 worldPosition = modelMatrix * localPos;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instMat) * normal);

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const SMOKE_BAYER_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform vec3 uSmokeLight;
uniform vec3 uSmokeDark;
uniform vec3 uFireUnderlight;
uniform vec3 uSunDir;

varying vec3 vWorldNormal;
varying float vOpacity;
varying float vFireGlow;

// Branchless GLSL ES 1.00 / WebGL2 / SwiftShader-safe ordered Bayer 4x4 screen-door dither
float bayer2x2(vec2 p) {
  vec2 m = mod(floor(p), 2.0);
  return mod(m.x * 2.0 + m.y * 3.0, 4.0) / 4.0;
}

float bayer4x4(vec2 p) {
  vec2 p0 = mod(floor(p), 4.0);
  vec2 p1 = floor(p0 * 0.5);
  vec2 p2 = mod(p0, 2.0);
  float b1 = mod(p1.x * 2.0 + p1.y * 3.0, 4.0);
  float b2 = mod(p2.x * 2.0 + p2.y * 3.0, 4.0);
  return (b2 * 4.0 + b1 + 0.5) / 16.0;
}

void main() {
  float threshold = bayer4x4(gl_FragCoord.xy);
  if (vOpacity <= threshold) {
    discard;
  }

  vec3 n = normalize(vWorldNormal);
  float ndl = dot(n, normalize(uSunDir)) * 0.5 + 0.5;
  float topShade = smoothstep(-0.6, 0.85, n.y);
  vec3 baseCol = mix(uSmokeDark, uSmokeLight, clamp(ndl * 0.65 + topShade * 0.35, 0.0, 1.0));

  // Warm orange under-lighting proportional to fire proximity below
  float underMask = smoothstep(0.40, -0.75, n.y);
  vec3 color = mix(baseCol, uFireUnderlight, underMask * clamp(vFireGlow, 0.0, 0.88));

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Creates the custom ordered Bayer 4x4 screen-door dither ShaderMaterial
 * for retro billowing smoke puffs (#6d6b77 / #626270 + #ff6f00 under-lighting).
 */
export function createSmokeBayerMaterial() {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uSmokeLight: { value: new THREE.Color('#6d6b77') },
      uSmokeDark: { value: new THREE.Color('#626270') },
      uFireUnderlight: { value: new THREE.Color('#ff6f00') },
      uSunDir: { value: new THREE.Vector3(-0.65, 0.45, -0.60).normalize() },
    },
  ]);

  return new THREE.ShaderMaterial({
    vertexShader: SMOKE_BAYER_VERTEX_SHADER,
    fragmentShader: SMOKE_BAYER_FRAGMENT_SHADER,
    uniforms,
    fog: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });
}
