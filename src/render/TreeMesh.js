import * as THREE from 'three';

export const TREE_TEXTURES = {
  foliage: 'textures/pine-foliage.png',
  bark: 'textures/pine-bark.png',
};

// Target alpine forest palette (compensated cleanly for lifted pine-foliage.png albedo so
// rendered twilight conifers hit deep spruce #213a34, alpine pine #2f4f3f, dusty sage #3e5c45,
// and autumn-touched olive #4a593d without double-darkening).
const ALPINE_TINTS = [
  new THREE.Color('#3b6a5f'), // Deep alpine spruce (renders ~#213a34)
  new THREE.Color('#4f8469'), // Pacific alpine pine (renders ~#2f4f3f)
  new THREE.Color('#6a9874'), // Sunlit dusty sage (renders ~#3e5c45)
  new THREE.Color('#7c9164'), // Autumn-touched olive (renders ~#4a593d)
];

const COL_FOLIAGE_CHARRED = new THREE.Color('#231e1d');
const COL_FOLIAGE_BURNING = new THREE.Color('#8e3f1c');
const COL_FOLIAGE_WET = new THREE.Color('#36696a');
const COL_FOLIAGE_EMBER = new THREE.Color('#705a42');

const COL_BARK_LIGHT = new THREE.Color('#c8bcb0');
const COL_BARK_DARK = new THREE.Color('#95877b');
const COL_BARK_CHARRED = new THREE.Color('#1d1918');
const COL_BARK_BURNING = new THREE.Color('#6a341c');
const COL_BARK_WET = new THREE.Color('#665f5a');

function hash2(x, z) {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

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

const _sharedTreeTextures = {
  initialized: false,
  foliage: null,
  bark: null,
  fallbackFoliage: null,
  fallbackBark: null,
  listeners: [],
};

function getSharedTreeTextures(onLoaded = null) {
  if (!_sharedTreeTextures.initialized) {
    _sharedTreeTextures.initialized = true;
    _sharedTreeTextures.fallbackFoliage = makeSolidDataTexture(175, 190, 175);
    _sharedTreeTextures.fallbackBark = makeSolidDataTexture(118, 102, 92);
    _sharedTreeTextures.foliage = _sharedTreeTextures.fallbackFoliage;
    _sharedTreeTextures.bark = _sharedTreeTextures.fallbackBark;

    if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
      const loader = new THREE.TextureLoader();

      loader.load(
        resolveAssetUrl(TREE_TEXTURES.foliage),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedTreeTextures.foliage = tex;
          for (const cb of _sharedTreeTextures.listeners) cb('foliage', tex);
        },
        undefined,
        () => {}
      );

      loader.load(
        resolveAssetUrl(TREE_TEXTURES.bark),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedTreeTextures.bark = tex;
          for (const cb of _sharedTreeTextures.listeners) cb('bark', tex);
        },
        undefined,
        () => {}
      );
    }
  }

  if (onLoaded) {
    _sharedTreeTextures.listeners.push(onLoaded);
    if (_sharedTreeTextures.foliage !== _sharedTreeTextures.fallbackFoliage) {
      onLoaded('foliage', _sharedTreeTextures.foliage);
    }
    if (_sharedTreeTextures.bark !== _sharedTreeTextures.fallbackBark) {
      onLoaded('bark', _sharedTreeTextures.bark);
    }
  }

  return {
    foliage: _sharedTreeTextures.foliage,
    bark: _sharedTreeTextures.bark,
    unsubscribe() {
      if (!onLoaded) return;
      const idx = _sharedTreeTextures.listeners.indexOf(onLoaded);
      if (idx >= 0) _sharedTreeTextures.listeners.splice(idx, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Organic Conifer Geometry Builder (ragged drooping bough tiers + crooked bark trunks)
// ---------------------------------------------------------------------------

class OrganicMeshBuilder {
  constructor() {
    this.positions = [];
    this.uvs = [];
    this.colors = [];
  }

  addTri(a, b, c, uvA, uvB, uvC, colA, colB, colC) {
    this.positions.push(
      a[0], a[1], a[2],
      b[0], b[1], b[2],
      c[0], c[1], c[2]
    );
    this.uvs.push(
      uvA[0], uvA[1],
      uvB[0], uvB[1],
      uvC[0], uvC[1]
    );
    this.colors.push(
      colA[0], colA[1], colA[2],
      colB[0], colB[1], colB[2],
      colC[0], colC[1], colC[2]
    );
  }

  addQuad(a, b, c, d, uvA, uvB, uvC, uvD, colA, colB, colC, colD) {
    this.addTri(a, b, c, uvA, uvB, uvC, colA, colB, colC);
    this.addTri(a, c, d, uvA, uvC, uvD, colA, colC, colD);
  }

  /**
   * Builds a slightly crooked, root-flared tapered cedar/pine bark trunk.
   */
  addOrganicTrunk({
    height,
    rBase,
    rTop,
    bendX = 0.0,
    bendZ = 0.0,
    segs = 5,
    rings = 3,
    seed = 1.0,
  }) {
    const ringPts = [];
    const ringVs = [];
    const ringAos = [];

    for (let r = 0; r <= rings; r++) {
      const t = r / rings;
      const y = -0.65 + t * (height + 0.65);
      // Root flare near ground, tapering steadily upward
      const rootFlare = r === 0 ? 1.38 : 1.0;
      const rad = (rBase + (rTop - rBase) * Math.pow(t, 0.85)) * rootFlare;
      const cx = bendX * t * t;
      const cz = bendZ * t * t;

      const pts = [];
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2 + seed * 0.37;
        const j = 0.90 + hash2(i * 3.1 + seed, r * 5.7) * 0.22;
        pts.push([cx + Math.cos(a) * rad * j, y, cz + Math.sin(a) * rad * j]);
      }
      ringPts.push(pts);
      ringVs.push(t * (height * 0.42));
      // Subtle vertical AO: darker near root & under deep canopy shadow
      const ao = 0.62 + 0.34 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.65);
      ringAos.push([ao, ao * 0.98, ao * 0.95]);
    }

    for (let r = 0; r < rings; r++) {
      const bot = ringPts[r];
      const top = ringPts[r + 1];
      const v0 = ringVs[r];
      const v1 = ringVs[r + 1];
      const c0 = ringAos[r];
      const c1 = ringAos[r + 1];

      for (let i = 0; i < segs; i++) {
        const ni = (i + 1) % segs;
        const u0 = i / segs;
        const u1 = (i + 1) / segs;
        // Verified outward winding: (bot[i], top[i], top[ni]) and (bot[i], top[ni], bot[ni])
        this.addQuad(
          bot[i], top[i], top[ni], bot[ni],
          [u0, v0], [u0, v1], [u1, v1], [u1, v0],
          c0, c1, c1, c0
        );
      }
    }
  }

  /**
   * Builds one irregular, notched, drooping ragged conifer bough tier with:
   * - Alternating protruding branch lobes & inward notched shadow cutouts
   * - Downward outer bough droop & per-lobe organic jitter
   * - Shadowed recessed underside skirt (zero hollow cones when viewed from below!)
   * - Vertical & interior vertex-color AO (dark interior -> sunlit dusty outer upper tips)
   */
  addRaggedBoughTier({
    cx = 0,
    cz = 0,
    yBase,
    height,
    radius,
    spokes = 10,
    droop = 0.45,
    raggedness = 0.34,
    rotOffset = 0.0,
    tierT = 0.5, // 0 = bottom tier, 1 = crown top
    seed = 1.0,
    includeUnderside = true,
  }) {
    const topPts = [];
    const outerPts = [];
    const underPts = [];
    const outerCols = [];
    const topCols = [];
    const underCols = [];

    const apexX = cx + (hash2(seed, 19.3) - 0.5) * radius * 0.14;
    const apexZ = cz + (hash2(seed, 47.1) - 0.5) * radius * 0.14;
    const yApex = yBase + height;
    const innerR = radius * 0.16;
    const underR = radius * 0.28;

    // Vertical lighting gradient: lower skirts shaded deeper than sunlit crown top
    const heightLight = 0.72 + tierT * 0.32;

    for (let i = 0; i < spokes; i++) {
      const frac = i / spokes;
      const angJitter = (hash2(i * 7.3 + seed, tierT * 11.1) - 0.5) * (Math.PI / spokes) * 0.52;
      const a = frac * Math.PI * 2 + rotOffset + angJitter;
      const ca = Math.cos(a);
      const sa = Math.sin(a);

      // Alternating ragged bough lobes (even) vs deeply notched gaps (odd) + organic noise
      const isLobe = (i & 1) === 0;
      const nR = hash2(i * 13.7 + seed, yBase * 2.3);
      const nY = hash2(i * 5.9 + seed, radius * 4.1);

      const radialMult = isLobe
        ? 1.0 + raggedness * (0.45 + nR * 0.65)
        : 1.0 - raggedness * (0.42 + nR * 0.55);
      const rOut = radius * radialMult;

      // Protruding branch tips droop downward naturally; notches tuck slightly upward
      const yDroop = isLobe
        ? -droop * (0.65 + nY * 0.60)
        : +droop * (0.20 + nY * 0.35);
      const yOut = yBase + yDroop;

      outerPts.push([cx + ca * rOut, yOut, cz + sa * rOut]);
      topPts.push([apexX + ca * innerR, yApex - (isLobe ? 0.0 : 0.08), apexZ + sa * innerR]);
      underPts.push([cx + ca * underR, yBase - droop * 0.18, cz + sa * underR]);

      // Vertex AO colors:
      // - Outer lobes catch sunlit warm-sage sky light; notched gaps stay deeply shaded!
      const tipShade = isLobe
        ? Math.min(1.08, heightLight * (0.98 + nR * 0.12))
        : heightLight * (0.62 + nR * 0.12);
      // Slight warm sunlit shift on upper bough tips, cooler blue-green tint in shadowed notches
      outerCols.push([
        tipShade * (isLobe ? 1.03 : 0.90),
        tipShade * 1.00,
        tipShade * (isLobe ? 0.95 : 1.04),
      ]);

      const crownShade = Math.min(1.08, heightLight * 0.96);
      topCols.push([crownShade * 1.02, crownShade, crownShade * 0.96]);

      const underShade = heightLight * 0.48;
      underCols.push([underShade * 0.88, underShade * 0.96, underShade * 1.04]);
    }

    // Upper ragged drooping bough canopy
    const uScale = Math.max(1.5, Math.round(radius * 0.85));
    const vSpan = Math.max(0.7, height * 0.28);

    for (let i = 0; i < spokes; i++) {
      const ni = (i + 1) % spokes;
      const u0 = (i / spokes) * uScale;
      const u1 = ((i + 1) / spokes) * uScale;

      // Verified outward (+Y/+R) winding: (outer[i], top[i], top[ni], outer[ni])
      this.addQuad(
        outerPts[i], topPts[i], topPts[ni], outerPts[ni],
        [u0, 0.0], [u0, vSpan], [u1, vSpan], [u1, 0.0],
        outerCols[i], topCols[i], topCols[ni], outerCols[ni]
      );

      // Shadowed underside skirt tucking back to trunk (verified downward -Y winding)
      if (includeUnderside) {
        this.addQuad(
          outerPts[i], outerPts[ni], underPts[ni], underPts[i],
          [u0, 0.0], [u1, 0.0], [u1, 0.55], [u0, 0.55],
          outerCols[i], outerCols[ni], underCols[ni], underCols[i]
        );
      }
    }

    // Small closed top cap on highest crown spire
    if (tierT > 0.92) {
      const tipPt = [apexX, yApex + height * 0.24, apexZ];
      const tipCol = [1.06, 1.04, 0.98];
      for (let i = 0; i < spokes; i++) {
        const ni = (i + 1) % spokes;
        this.addTri(
          topPts[i], tipPt, topPts[ni],
          [i / spokes, 0.2], [0.5, 0.9], [(i + 1) / spokes, 0.2],
          topCols[i], tipCol, topCols[ni]
        );
      }
    }
  }

  build() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geom.computeVertexNormals();
    return geom;
  }
}

/**
 * Builds the 3 distinct organic alpine conifer archetypes:
 * 0: Tall Tiered Douglas Fir (stately 5-tier ragged boughs)
 * 1: Irregular Gnarled Spruce (broad wind-sculpted asymmetric drooping boughs)
 * 2: Slender Mountain Pine / Subalpine Fir (tall high-trunk narrow ragged spire)
 */
function buildConiferArchetypes() {
  const archetypes = [];

  // --- ARCHETYPE 0: Tall Tiered Douglas Fir (~13.2 m) ---
  {
    const trunkB = new OrganicMeshBuilder();
    trunkB.addOrganicTrunk({
      height: 10.2,
      rBase: 0.42,
      rTop: 0.09,
      bendX: 0.14,
      bendZ: -0.08,
      segs: 5,
      rings: 3,
      seed: 1.7,
    });

    const folB = new OrganicMeshBuilder();
    const tiers = [
      { yBase: 2.3, height: 3.6, radius: 3.35, spokes: 10, droop: 0.62, rag: 0.32, rot: 0.10, t: 0.05, ox: 0.02, oz: 0.00 },
      { yBase: 4.5, height: 3.5, radius: 2.85, spokes: 10, droop: 0.52, rag: 0.34, rot: 0.58, t: 0.30, ox: 0.06, oz: -0.04 },
      { yBase: 6.7, height: 3.3, radius: 2.28, spokes: 8,  droop: 0.40, rag: 0.33, rot: 1.12, t: 0.55, ox: 0.10, oz: -0.06 },
      { yBase: 8.8, height: 2.9, radius: 1.62, spokes: 8,  droop: 0.28, rag: 0.30, rot: 1.75, t: 0.78, ox: 0.13, oz: -0.08 },
      { yBase: 10.6, height: 2.5, radius: 1.02, spokes: 8, droop: 0.16, rag: 0.28, rot: 2.25, t: 0.96, ox: 0.15, oz: -0.09 },
    ];
    for (let i = 0; i < tiers.length; i++) {
      const tr = tiers[i];
      folB.addRaggedBoughTier({
        cx: tr.ox,
        cz: tr.oz,
        yBase: tr.yBase,
        height: tr.height,
        radius: tr.radius,
        spokes: tr.spokes,
        droop: tr.droop,
        raggedness: tr.rag,
        rotOffset: tr.rot,
        tierT: tr.t,
        seed: 11.3 + i * 7.1,
        includeUnderside: i < 3,
      });
    }
    archetypes.push({
      name: 'DouglasFir',
      trunkGeo: trunkB.build(),
      foliageGeo: folB.build(),
    });
  }

  // --- ARCHETYPE 1: Irregular Gnarled Mountain Spruce (~11.4 m) ---
  {
    const trunkB = new OrganicMeshBuilder();
    trunkB.addOrganicTrunk({
      height: 8.6,
      rBase: 0.48,
      rTop: 0.12,
      bendX: -0.32,
      bendZ: 0.22,
      segs: 5,
      rings: 3,
      seed: 4.9,
    });

    const folB = new OrganicMeshBuilder();
    const tiers = [
      { yBase: 1.8, height: 3.7, radius: 3.75, spokes: 10, droop: 0.78, rag: 0.38, rot: 0.35, t: 0.05, ox: -0.04, oz: 0.04 },
      { yBase: 4.1, height: 3.5, radius: 3.05, spokes: 10, droop: 0.65, rag: 0.40, rot: 1.02, t: 0.35, ox: -0.14, oz: 0.12 },
      { yBase: 6.4, height: 3.2, radius: 2.22, spokes: 8,  droop: 0.46, rag: 0.38, rot: 1.88, t: 0.68, ox: -0.24, oz: 0.18 },
      { yBase: 8.5, height: 2.7, radius: 1.38, spokes: 8,  droop: 0.26, rag: 0.34, rot: 2.60, t: 0.96, ox: -0.34, oz: 0.24 },
    ];
    for (let i = 0; i < tiers.length; i++) {
      const tr = tiers[i];
      folB.addRaggedBoughTier({
        cx: tr.ox,
        cz: tr.oz,
        yBase: tr.yBase,
        height: tr.height,
        radius: tr.radius,
        spokes: tr.spokes,
        droop: tr.droop,
        raggedness: tr.rag,
        rotOffset: tr.rot,
        tierT: tr.t,
        seed: 29.1 + i * 9.3,
        includeUnderside: i < 3,
      });
    }
    archetypes.push({
      name: 'GnarledSpruce',
      trunkGeo: trunkB.build(),
      foliageGeo: folB.build(),
    });
  }

  // --- ARCHETYPE 2: Slender Mountain Pine / Subalpine Fir (~14.2 m) ---
  {
    const trunkB = new OrganicMeshBuilder();
    trunkB.addOrganicTrunk({
      height: 11.4,
      rBase: 0.36,
      rTop: 0.08,
      bendX: 0.20,
      bendZ: 0.16,
      segs: 5,
      rings: 3,
      seed: 8.3,
    });

    const folB = new OrganicMeshBuilder();
    const tiers = [
      { yBase: 3.4, height: 3.1, radius: 2.45, spokes: 8, droop: 0.48, rag: 0.36, rot: 0.22, t: 0.08, ox: 0.05, oz: 0.03 },
      { yBase: 5.4, height: 3.0, radius: 2.18, spokes: 8, droop: 0.42, rag: 0.38, rot: 0.95, t: 0.30, ox: 0.09, oz: 0.07 },
      { yBase: 7.4, height: 2.8, radius: 1.82, spokes: 8, droop: 0.34, rag: 0.35, rot: 1.68, t: 0.52, ox: 0.13, oz: 0.11 },
      { yBase: 9.3, height: 2.6, radius: 1.40, spokes: 8, droop: 0.25, rag: 0.33, rot: 2.34, t: 0.74, ox: 0.17, oz: 0.14 },
      { yBase: 11.1, height: 2.6, radius: 0.92, spokes: 6, droop: 0.14, rag: 0.30, rot: 3.05, t: 0.96, ox: 0.21, oz: 0.17 },
    ];
    for (let i = 0; i < tiers.length; i++) {
      const tr = tiers[i];
      folB.addRaggedBoughTier({
        cx: tr.ox,
        cz: tr.oz,
        yBase: tr.yBase,
        height: tr.height,
        radius: tr.radius,
        spokes: tr.spokes,
        droop: tr.droop,
        raggedness: tr.rag,
        rotOffset: tr.rot,
        tierT: tr.t,
        seed: 53.7 + i * 11.7,
        includeUnderside: i < 2,
      });
    }
    archetypes.push({
      name: 'AlpinePine',
      trunkGeo: trunkB.build(),
      foliageGeo: folB.build(),
    });
  }

  return archetypes;
}

/**
 * Patches a matte MeshStandardMaterial so actively burning trees (`aBurnHeat > 0`) emit
 * a flickering warm orange-red ember rim along outer bough silhouettes while intact trees
 * remain 100% pure matte PBR (roughness 0.92, metalness 0.0).
 */
function attachEmberRimShader(material, sharedEmberUniform, cacheKey) {
  material.customProgramCacheKey = () => cacheKey;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEmberTime = sharedEmberUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aBurnHeat;
        varying float vBurnHeat;
        varying float vLocalH;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vBurnHeat = aBurnHeat;
        vLocalH = position.y;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uEmberTime;
        varying float vBurnHeat;
        varying float vLocalH;`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vBurnHeat > 0.01) {
          vec3 emberViewDir = normalize(vViewPosition);
          float rim = pow(1.0 - abs(dot(normalize(normal), emberViewDir)), 1.55);
          float lowBias = clamp(1.18 - vLocalH * 0.075, 0.24, 1.0);
          float flick = 0.82 + 0.18 * sin(uEmberTime * 11.5 + vLocalH * 1.7);
          float glow = vBurnHeat * (0.24 + 0.90 * rim) * lowBias * flick;
          vec3 emberCol = mix(vec3(0.95, 0.20, 0.02), vec3(1.0, 0.62, 0.14), rim);
          totalEmissiveRadiance += emberCol * glow * 1.35;
        }`
      );
  };
}

/**
 * Computes natural varied alpine conifer color for a tree instance across:
 * deep spruce, alpine pine, dusty sage, and autumn-touched olive.
 */
function computeAlpineFoliageColor(tree, archetypeIdx, outColor) {
  const h1 = tree.tint !== undefined ? tree.tint : hash2(tree.x * 0.09, tree.z * 0.11);
  const h2 = hash2(tree.x * 0.31 + 17.3, tree.z * 0.27 - 9.1);

  // Subtle species-character color bias so archetypes also enrich forest canopy texture
  let selector = h1 * 0.72 + h2 * 0.28;
  if (archetypeIdx === 0) selector = selector * 0.85;            // Douglas fir favors spruce/pine
  else if (archetypeIdx === 2) selector = 0.22 + selector * 0.78; // Alpine pine favors pine/sage/olive

  const scaled = Math.max(0, Math.min(2.999, selector * 3.0));
  const idxA = Math.floor(scaled);
  const idxB = Math.min(3, idxA + 1);
  const frac = scaled - idxA;

  outColor.copy(ALPINE_TINTS[idxA]).lerp(ALPINE_TINTS[idxB], frac);

  // Fine per-tree natural luminance shift (+-10%) so adjacent trees never look cloned
  const lum = 0.90 + hash2(tree.x * 0.73, tree.z * 0.61) * 0.20;
  outColor.multiplyScalar(lum);
  return outColor;
}

/**
 * Creates a high-performance multi-archetype organic alpine forest system (3 conifer species,
 * 6 total InstancedMeshes: 3 matte textured canopies + 3 weathered bark trunks).
 *
 * Accepts either `trees` array (`Array<{ x, z, y, cellIdx, scale, tint }>`) or a `terrain` object
 * containing `{ trees, gridSize }`. If `sceneOrGroup` is passed, mounts `group` automatically.
 */
export function createForestSystem(treesOrTerrain, sceneOrGroup = null, options = {}) {
  const isTerrainObj =
    treesOrTerrain && !Array.isArray(treesOrTerrain) && Array.isArray(treesOrTerrain.trees);
  const trees = isTerrainObj ? treesOrTerrain.trees : (treesOrTerrain || []);
  const count = trees.length;

  const group = new THREE.Group();
  group.name = 'OrganicAlpineForest';
  if (sceneOrGroup && typeof sceneOrGroup.add === 'function') {
    sceneOrGroup.add(group);
  }

  // Infer fire grid cell count cleanly
  let cellCount = options.cellCount || 0;
  if (!cellCount && isTerrainObj && treesOrTerrain.gridSize) {
    cellCount = treesOrTerrain.gridSize * treesOrTerrain.gridSize;
  }
  if (!cellCount) {
    let maxIdx = -1;
    for (let i = 0; i < count; i++) {
      if (trees[i].cellIdx > maxIdx) maxIdx = trees[i].cellIdx;
    }
    cellCount = Math.max(1, maxIdx + 1);
  }

  if (count === 0) {
    return {
      group,
      meshes: [],
      treeCount: 0,
      drawCallCount: 0,
      updateFromFireGrid() {},
      updateTime() {},
      dispose() {
        if (group.parent) group.parent.remove(group);
      },
    };
  }

  // Shared ember flicker time uniform + matte weathered PBR materials
  const emberTimeUniform = { value: 0 };

  const foliageMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  attachEmberRimShader(foliageMat, emberTimeUniform, 'ember-conifer-foliage-v1');

  const barkMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
  });
  attachEmberRimShader(barkMat, emberTimeUniform, 'ember-conifer-bark-v1');

  const texHandle = getSharedTreeTextures((kind, tex) => {
    if (kind === 'foliage') {
      foliageMat.map = tex;
      foliageMat.needsUpdate = true;
    } else if (kind === 'bark') {
      barkMat.map = tex;
      barkMat.needsUpdate = true;
    }
  });
  foliageMat.map = texHandle.foliage;
  barkMat.map = texHandle.bark;

  // Assign each tree deterministically to one of the 3 organic conifer archetypes
  const buckets = [[], [], []];
  const treeArchetype = new Uint8Array(count);
  const treeLocalIdx = new Int32Array(count);

  for (let i = 0; i < count; i++) {
    const t = trees[i];
    const h = hash2(t.x * 0.19 + 3.1, t.z * 0.23 - 5.7);
    // Higher elevation subtly increases slender alpine pine share; valley favors lush fir & spruce
    const elevBias = Math.max(0, Math.min(0.18, ((t.y || 25) - 42) / 140));
    let arch = 0;
    if (h < 0.42 - elevBias * 0.5) arch = 0;       // Tall Tiered Douglas Fir
    else if (h < 0.75 - elevBias) arch = 1;        // Irregular Gnarled Spruce
    else arch = 2;                                 // Slender Alpine Pine

    treeArchetype[i] = arch;
    treeLocalIdx[i] = buckets[arch].length;
    buckets[arch].push(i);
  }

  // Build 3 archetype geometry pairs & InstancedMeshes (up to 6 total draw calls!)
  const archetypeSpecs = buildConiferArchetypes();
  const folMeshes = [null, null, null];
  const trunkMeshes = [null, null, null];
  const folBurnAttrs = [null, null, null];
  const trunkBurnAttrs = [null, null, null];
  const allMeshes = [];

  for (let a = 0; a < 3; a++) {
    const n = buckets[a].length;
    if (n === 0) continue;

    const spec = archetypeSpecs[a];
    const folBurnArr = new Float32Array(n);
    const trunkBurnArr = new Float32Array(n);
    const folBurnAttr = new THREE.InstancedBufferAttribute(folBurnArr, 1);
    const trunkBurnAttr = new THREE.InstancedBufferAttribute(trunkBurnArr, 1);
    spec.foliageGeo.setAttribute('aBurnHeat', folBurnAttr);
    spec.trunkGeo.setAttribute('aBurnHeat', trunkBurnAttr);

    const fMesh = new THREE.InstancedMesh(spec.foliageGeo, foliageMat, n);
    fMesh.name = `ForestFoliage_${spec.name}`;
    fMesh.frustumCulled = false;

    const tMesh = new THREE.InstancedMesh(spec.trunkGeo, barkMat, n);
    tMesh.name = `ForestTrunk_${spec.name}`;
    tMesh.frustumCulled = false;

    folMeshes[a] = fMesh;
    trunkMeshes[a] = tMesh;
    folBurnAttrs[a] = folBurnAttr;
    trunkBurnAttrs[a] = trunkBurnAttr;

    group.add(tMesh);
    group.add(fMesh);
    allMeshes.push(tMesh, fMesh);
  }

  // Fast O(1) linked-list lookup: cellIdx -> trees standing on that fire grid cell
  const cellTreeHead = new Int32Array(cellCount);
  cellTreeHead.fill(-1);
  const treeNext = new Int32Array(count);
  const cellStates = new Uint8Array(cellCount);

  // Per-tree cached natural transforms & base colors (zero allocations during fire updates!)
  const baseScaleXZ = new Float32Array(count);
  const baseScaleY = new Float32Array(count);
  const baseQuat = new Float32Array(count * 4);
  const baseFolCol = new Float32Array(count * 3);
  const baseBarkCol = new Float32Array(count * 3);
  const treeStateFlag = new Uint8Array(count); // 0=intact, 1=burning, 2=charred

  const tmpPos = new THREE.Vector3();
  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const tmpQuat = new THREE.Quaternion();
  const tmpScale = new THREE.Vector3();
  const tmpMat = new THREE.Matrix4();
  const tmpCol = new THREE.Color();

  for (let i = 0; i < count; i++) {
    const t = trees[i];
    const cellIdx = t.cellIdx;
    if (cellIdx >= 0 && cellIdx < cellCount) {
      treeNext[i] = cellTreeHead[cellIdx];
      cellTreeHead[cellIdx] = i;
    } else {
      treeNext[i] = -1;
    }

    const arch = treeArchetype[i];
    const loc = treeLocalIdx[i];

    // Natural height variation: 0.72x .. 1.42x + independent girth variation (+-11%)
    const hRand = hash2(t.x * 0.43 + 11.1, t.z * 0.37 - 4.3);
    const rawScale = t.scale !== undefined ? t.scale : (0.78 + hRand * 0.55);
    const sY = THREE.MathUtils.clamp(rawScale * (0.90 + hRand * 0.20), 0.72, 1.42);
    const girthRand = hash2(t.x * 0.59 - 7.3, t.z * 0.47 + 19.1);
    const sXZ = sY * (0.89 + girthRand * 0.22);

    // Full 360 deg yaw + organic wind lean/tilt (+-4 deg = +-0.07 rad)
    const yaw = hash2(t.x * 0.13, t.z * 0.17) * Math.PI * 2;
    const leanX = (hash2(t.x * 0.29 + 5.1, t.z * 0.31) - 0.5) * 0.14; // +-0.07 rad (+-4 deg)
    const leanZ = (hash2(t.x * 0.37, t.z * 0.23 + 9.7) - 0.5) * 0.14;

    tmpEuler.set(leanX, yaw, leanZ, 'YXZ');
    tmpQuat.setFromEuler(tmpEuler);

    baseScaleXZ[i] = sXZ;
    baseScaleY[i] = sY;
    const q4 = i * 4;
    baseQuat[q4] = tmpQuat.x;
    baseQuat[q4 + 1] = tmpQuat.y;
    baseQuat[q4 + 2] = tmpQuat.z;
    baseQuat[q4 + 3] = tmpQuat.w;

    tmpPos.set(t.x, t.y - 0.12, t.z);
    tmpScale.set(sXZ, sY, sXZ);
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);

    folMeshes[arch].setMatrixAt(loc, tmpMat);
    trunkMeshes[arch].setMatrixAt(loc, tmpMat);

    // Natural multi-tone alpine foliage color
    computeAlpineFoliageColor(t, arch, tmpCol);
    const c3 = i * 3;
    baseFolCol[c3] = tmpCol.r;
    baseFolCol[c3 + 1] = tmpCol.g;
    baseFolCol[c3 + 2] = tmpCol.b;
    folMeshes[arch].setColorAt(loc, tmpCol);

    // Natural weathered cedar bark color variation
    const barkMix = hash2(t.x * 0.67, t.z * 0.53);
    tmpCol.copy(COL_BARK_DARK).lerp(COL_BARK_LIGHT, barkMix);
    baseBarkCol[c3] = tmpCol.r;
    baseBarkCol[c3 + 1] = tmpCol.g;
    baseBarkCol[c3 + 2] = tmpCol.b;
    trunkMeshes[arch].setColorAt(loc, tmpCol);
  }

  for (let a = 0; a < 3; a++) {
    if (!folMeshes[a]) continue;
    folMeshes[a].instanceMatrix.needsUpdate = true;
    trunkMeshes[a].instanceMatrix.needsUpdate = true;
    if (folMeshes[a].instanceColor) folMeshes[a].instanceColor.needsUpdate = true;
    if (trunkMeshes[a].instanceColor) trunkMeshes[a].instanceColor.needsUpdate = true;
  }

  // Dirty flag trackers per archetype (reused every call, zero allocations)
  const folColDirty = [false, false, false];
  const trunkColDirty = [false, false, false];
  const folMatDirty = [false, false, false];
  const trunkMatDirty = [false, false, false];
  const folBurnDirty = [false, false, false];
  const trunkBurnDirty = [false, false, false];

  function updateCellTrees(idx, st) {
    let ti = cellTreeHead[idx];
    while (ti !== -1) {
      const arch = treeArchetype[ti];
      const loc = treeLocalIdx[ti];
      const c3 = ti * 3;
      const prevFlag = treeStateFlag[ti];
      let nextFlag = 0;
      let folHeat = 0.0;
      let trunkHeat = 0.0;

      if (st === 14) {
        // Charred/burned snag: blackened standing cedar trunk + sparse scorched ash crown!
        nextFlag = 2;
        folMeshes[arch].setColorAt(loc, COL_FOLIAGE_CHARRED);
        trunkMeshes[arch].setColorAt(loc, COL_BARK_CHARRED);
      } else if (st >= 1 && st <= 12) {
        // Actively burning: scorched dark ember foliage + flickering orange-red glowing ember rim!
        nextFlag = 1;
        const bt = Math.min(1, 0.28 + (st / 12) * 0.72);
        folHeat = bt;
        trunkHeat = bt * 0.55;

        tmpCol.setRGB(
          baseFolCol[c3] + (COL_FOLIAGE_BURNING.r - baseFolCol[c3]) * bt,
          baseFolCol[c3 + 1] + (COL_FOLIAGE_BURNING.g - baseFolCol[c3 + 1]) * bt,
          baseFolCol[c3 + 2] + (COL_FOLIAGE_BURNING.b - baseFolCol[c3 + 2]) * bt
        );
        folMeshes[arch].setColorAt(loc, tmpCol);

        tmpCol.setRGB(
          baseBarkCol[c3] + (COL_BARK_BURNING.r - baseBarkCol[c3]) * bt * 0.85,
          baseBarkCol[c3 + 1] + (COL_BARK_BURNING.g - baseBarkCol[c3 + 1]) * bt * 0.85,
          baseBarkCol[c3 + 2] + (COL_BARK_BURNING.b - baseBarkCol[c3 + 2]) * bt * 0.85
        );
        trunkMeshes[arch].setColorAt(loc, tmpCol);
      } else if (st === 13) {
        // Wet / water-drenched firebreak
        tmpCol.setRGB(
          baseFolCol[c3] * 0.58 + COL_FOLIAGE_WET.r * 0.42,
          baseFolCol[c3 + 1] * 0.58 + COL_FOLIAGE_WET.g * 0.42,
          baseFolCol[c3 + 2] * 0.58 + COL_FOLIAGE_WET.b * 0.42
        );
        folMeshes[arch].setColorAt(loc, tmpCol);

        tmpCol.setRGB(
          baseBarkCol[c3] * 0.65 + COL_BARK_WET.r * 0.35,
          baseBarkCol[c3 + 1] * 0.65 + COL_BARK_WET.g * 0.35,
          baseBarkCol[c3 + 2] * 0.65 + COL_BARK_WET.b * 0.35
        );
        trunkMeshes[arch].setColorAt(loc, tmpCol);
      } else if (st === 15) {
        // Ember warning: subtle warm ember glow reaching canopy
        folHeat = 0.24;
        tmpCol.setRGB(
          baseFolCol[c3] * 0.72 + COL_FOLIAGE_EMBER.r * 0.28,
          baseFolCol[c3 + 1] * 0.72 + COL_FOLIAGE_EMBER.g * 0.28,
          baseFolCol[c3 + 2] * 0.72 + COL_FOLIAGE_EMBER.b * 0.28
        );
        folMeshes[arch].setColorAt(loc, tmpCol);
        tmpCol.setRGB(baseBarkCol[c3], baseBarkCol[c3 + 1], baseBarkCol[c3 + 2]);
        trunkMeshes[arch].setColorAt(loc, tmpCol);
      } else {
        // Intact healthy conifer
        tmpCol.setRGB(baseFolCol[c3], baseFolCol[c3 + 1], baseFolCol[c3 + 2]);
        folMeshes[arch].setColorAt(loc, tmpCol);
        tmpCol.setRGB(baseBarkCol[c3], baseBarkCol[c3 + 1], baseBarkCol[c3 + 2]);
        trunkMeshes[arch].setColorAt(loc, tmpCol);
      }

      folColDirty[arch] = true;
      trunkColDirty[arch] = true;

      // Update ember rim heat attribute
      const fBurnArr = folBurnAttrs[arch].array;
      if (fBurnArr[loc] !== folHeat) {
        fBurnArr[loc] = folHeat;
        folBurnDirty[arch] = true;
      }
      const tBurnArr = trunkBurnAttrs[arch].array;
      if (tBurnArr[loc] !== trunkHeat) {
        tBurnArr[loc] = trunkHeat;
        trunkBurnDirty[arch] = true;
      }

      // Shrink charred canopy into sparse scorched snag while keeping tall charred trunk standing!
      if (nextFlag !== prevFlag) {
        treeStateFlag[ti] = nextFlag;
        const tr = trees[ti];
        const sXZ = baseScaleXZ[ti];
        const sY = baseScaleY[ti];
        const q4 = ti * 4;
        tmpQuat.set(baseQuat[q4], baseQuat[q4 + 1], baseQuat[q4 + 2], baseQuat[q4 + 3]);

        if (nextFlag === 2) {
          // Sparse scorched foliage snag
          tmpPos.set(tr.x, tr.y - 0.35, tr.z);
          tmpScale.set(sXZ * 0.36, sY * 0.64, sXZ * 0.36);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          folMeshes[arch].setMatrixAt(loc, tmpMat);
          folMatDirty[arch] = true;

          // Tall stark blackened trunk stays standing!
          tmpPos.set(tr.x, tr.y - 0.12, tr.z);
          tmpScale.set(sXZ * 0.88, sY * 0.96, sXZ * 0.88);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          trunkMeshes[arch].setMatrixAt(loc, tmpMat);
          trunkMatDirty[arch] = true;
        } else if (nextFlag === 1) {
          // Slightly singed active-burn crown
          tmpPos.set(tr.x, tr.y - 0.12, tr.z);
          tmpScale.set(sXZ * 0.92, sY * 0.97, sXZ * 0.92);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          folMeshes[arch].setMatrixAt(loc, tmpMat);
          folMatDirty[arch] = true;

          tmpScale.set(sXZ, sY, sXZ);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          trunkMeshes[arch].setMatrixAt(loc, tmpMat);
          trunkMatDirty[arch] = true;
        } else {
          // Full healthy restored conifer
          tmpPos.set(tr.x, tr.y - 0.12, tr.z);
          tmpScale.set(sXZ, sY, sXZ);
          tmpMat.compose(tmpPos, tmpQuat, tmpScale);
          folMeshes[arch].setMatrixAt(loc, tmpMat);
          trunkMeshes[arch].setMatrixAt(loc, tmpMat);
          folMatDirty[arch] = true;
          trunkMatDirty[arch] = true;
        }
      }

      ti = treeNext[ti];
    }
  }

  function updateFromFireGrid(fireGrid, dirtyIndices = null, elapsed = 0) {
    if (elapsed !== undefined) {
      emberTimeUniform.value = elapsed;
    }
    const cells = fireGrid && fireGrid.cells ? fireGrid.cells : fireGrid;
    if (!cells) return;

    folColDirty[0] = folColDirty[1] = folColDirty[2] = false;
    trunkColDirty[0] = trunkColDirty[1] = trunkColDirty[2] = false;
    folMatDirty[0] = folMatDirty[1] = folMatDirty[2] = false;
    trunkMatDirty[0] = trunkMatDirty[1] = trunkMatDirty[2] = false;
    folBurnDirty[0] = folBurnDirty[1] = folBurnDirty[2] = false;
    trunkBurnDirty[0] = trunkBurnDirty[1] = trunkBurnDirty[2] = false;

    const fullPass = dirtyIndices === null || dirtyIndices === undefined;
    if (fullPass) {
      const lim = Math.min(cellCount, cells.length);
      for (let idx = 0; idx < lim; idx++) {
        const st = cells[idx];
        cellStates[idx] = st;
        if (cellTreeHead[idx] !== -1) {
          updateCellTrees(idx, st);
        }
      }
    } else {
      for (let k = 0; k < dirtyIndices.length; k++) {
        const idx = dirtyIndices[k];
        if (idx < 0 || idx >= cellCount) continue;
        const st = cells[idx];
        if (st === cellStates[idx]) continue;
        cellStates[idx] = st;
        if (cellTreeHead[idx] !== -1) {
          updateCellTrees(idx, st);
        }
      }
    }

    for (let a = 0; a < 3; a++) {
      if (!folMeshes[a]) continue;
      if (folColDirty[a] && folMeshes[a].instanceColor) folMeshes[a].instanceColor.needsUpdate = true;
      if (trunkColDirty[a] && trunkMeshes[a].instanceColor) trunkMeshes[a].instanceColor.needsUpdate = true;
      if (folMatDirty[a]) folMeshes[a].instanceMatrix.needsUpdate = true;
      if (trunkMatDirty[a]) trunkMeshes[a].instanceMatrix.needsUpdate = true;
      if (folBurnDirty[a]) folBurnAttrs[a].needsUpdate = true;
      if (trunkBurnDirty[a]) trunkBurnAttrs[a].needsUpdate = true;
    }
  }

  function updateTime(elapsed) {
    emberTimeUniform.value = elapsed || 0;
  }

  function dispose() {
    texHandle.unsubscribe();
    for (let a = 0; a < 3; a++) {
      if (folMeshes[a]) folMeshes[a].dispose();
      if (trunkMeshes[a]) trunkMeshes[a].dispose();
      archetypeSpecs[a].foliageGeo.dispose();
      archetypeSpecs[a].trunkGeo.dispose();
    }
    foliageMat.dispose();
    barkMat.dispose();
    if (group.parent) group.parent.remove(group);
  }

  return {
    group,
    meshes: allMeshes,
    treeCount: count,
    drawCallCount: allMeshes.length,
    updateFromFireGrid,
    updateTime,
    dispose,
  };
}

/**
 * Standalone helper updating a forest system created by `createForestSystem` from a fire grid
 * (`Uint8Array` cells or `fireSnapshot` `{ cells }`) and optional `dirtyIndices` array.
 */
export function updateForestFromFireGrid(forestSystem, fireGrid, dirtyIndices = null, elapsed = 0) {
  if (!forestSystem || typeof forestSystem.updateFromFireGrid !== 'function') return;
  forestSystem.updateFromFireGrid(fireGrid, dirtyIndices, elapsed);
}

/**
 * Standalone helper cleanly disposing a forest system created by `createForestSystem`.
 */
export function disposeForestSystem(forestSystem) {
  if (!forestSystem || typeof forestSystem.dispose !== 'function') return;
  forestSystem.dispose();
}
