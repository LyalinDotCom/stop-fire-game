import * as THREE from 'three';

const SKYBOX_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldDir;

void main() {
  vWorldDir = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w * 0.99999;
}
`;

const SKYBOX_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uZenithColor;
uniform vec3 uMidColor;
uniform vec3 uHorizonColor;
uniform vec3 uBelowColor;
uniform vec3 uSunsetGlowColor;
uniform vec3 uMoonColor;
uniform vec3 uStarColor;
uniform vec3 uMoonDir;
uniform vec3 uSunDir;
uniform float uTime;

varying vec3 vWorldDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Seamless cube-face projection for 1-px procedural stars (zero seam, zero pole pinch)
float starField(vec3 dir) {
  vec3 ad = abs(dir);
  vec2 uv;
  float faceId;
  if (ad.x >= ad.y && ad.x >= ad.z) {
    uv = dir.yz / ad.x;
    faceId = dir.x > 0.0 ? 1.0 : 2.0;
  } else if (ad.y >= ad.x && ad.y >= ad.z) {
    uv = dir.xz / ad.y;
    faceId = dir.y > 0.0 ? 3.0 : 4.0;
  } else {
    uv = dir.xy / ad.z;
    faceId = dir.z > 0.0 ? 5.0 : 6.0;
  }

  float scale = 190.0;
  vec2 grid = (uv * 0.5 + 0.5) * scale;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);

  float h = hash21(cell + faceId * 71.37);
  if (h < 0.986) return 0.0;

  vec2 center = vec2(
    hash21(cell * 1.31 + faceId * 19.1),
    hash21(cell * 2.17 + faceId * 37.7)
  ) * 0.5 + 0.25;

  float d = length(f - center);
  float size = mix(0.16, 0.28, fract(h * 113.7));
  float star = 1.0 - step(size, d);

  // Subtle slow star shimmer
  float twinkle = 0.78 + 0.22 * sin(uTime * 1.4 + h * 628.3);
  return star * twinkle;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  float elev = dir.y;

  // Twilight vertical gradient:
  // #e59462 (horizon 0.0) -> #6e5053 (mid ~0.25) -> #2c2d42 (zenith >= 0.65)
  vec3 skyColor;
  if (elev < 0.0) {
    float tBelow = clamp(-elev / 0.35, 0.0, 1.0);
    skyColor = mix(uHorizonColor, uBelowColor, smoothstep(0.0, 1.0, tBelow));
  } else if (elev < 0.25) {
    float tMid = elev / 0.25;
    skyColor = mix(uHorizonColor, uMidColor, smoothstep(0.0, 1.0, tMid));
  } else {
    float tZen = clamp((elev - 0.25) / 0.40, 0.0, 1.0);
    skyColor = mix(uMidColor, uZenithColor, smoothstep(0.0, 1.0, tZen));
  }

  // Subtle warm afterglow along the sunset azimuth near horizon
  float sunAlign = max(dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  float horizonBand = exp(-abs(elev - 0.02) * 9.5);
  skyColor += uSunsetGlowColor * (pow(sunAlign, 3.0) * horizonBand * 0.22);

  // Procedural 1-px stars above dir.y > 0.12
  float starMask = smoothstep(0.12, 0.26, elev);
  float moonDot = dot(dir, uMoonDir);
  if (starMask > 0.001 && moonDot < 0.996) {
    float s = starField(dir);
    skyColor = mix(skyColor, uStarColor, s * starMask * 0.92);
  }

  // Hard-edged pale cream-yellow moon (#ffdd99, ~1.8 deg angular radius) at NNE (az 22, el 18)
  // cos(1.8 deg) = 0.99950656
  float moonHalo = pow(max(moonDot, 0.0), 420.0) * 0.14;
  skyColor += uMoonColor * moonHalo;

  float moonDisc = smoothstep(0.99944, 0.99956, moonDot);
  skyColor = mix(skyColor, uMoonColor, moonDisc);

  gl_FragColor = vec4(skyColor, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Creates a seamless camera-centered twilight sky dome with procedural stars and moon.
 * Evaluates 3D normalize(vWorldDir) in GLSL to eliminate any spherical UV wrap seam.
 */
export function createSkybox() {
  // NNE: azimuth 22 deg (0 = North -Z, 90 = East +X), elevation 18 deg
  const azRad = THREE.MathUtils.degToRad(22);
  const elRad = THREE.MathUtils.degToRad(18);
  const moonDir = new THREE.Vector3(
    Math.sin(azRad) * Math.cos(elRad),
    Math.sin(elRad),
    -Math.cos(azRad) * Math.cos(elRad)
  ).normalize();

  // Sunset afterglow direction (WNW low horizon, matching sunset DirectionalLight)
  const sunDir = new THREE.Vector3(-0.78, 0.22, -0.58).normalize();

  const geometry = new THREE.IcosahedronGeometry(1800, 3);
  const material = new THREE.ShaderMaterial({
    vertexShader: SKYBOX_VERTEX_SHADER,
    fragmentShader: SKYBOX_FRAGMENT_SHADER,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: {
      uZenithColor: { value: new THREE.Color('#2c2d42') },
      uMidColor: { value: new THREE.Color('#6e5053') },
      uHorizonColor: { value: new THREE.Color('#e59462') },
      uBelowColor: { value: new THREE.Color('#7f6585') },
      uSunsetGlowColor: { value: new THREE.Color('#e59462') },
      uMoonColor: { value: new THREE.Color('#ffdd99') },
      uStarColor: { value: new THREE.Color('#f0ece4') },
      uMoonDir: { value: moonDir },
      uSunDir: { value: sunDir },
      uTime: { value: 0 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'TwilightSkybox';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;

  return {
    mesh,
    material,
    update(cameraPos, elapsed) {
      mesh.position.copy(cameraPos);
      material.uniforms.uTime.value = elapsed;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
