import * as THREE from 'three';
import { LIVERIES } from '../config/liveries.js';

const DEFAULT_LIVERY = {
  id: 0,
  name: 'EF-07 Forestry Gold',
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
const ROLE_GLASS = 6;

const DARK_COLOR = new THREE.Color('#282c31');
const GLASS_COLOR = new THREE.Color('#1a2f3d');

// ---------------------------------------------------------------------------
// Shared texture loader with safe fallback DataTextures (zero black frames / Node-safe)
// ---------------------------------------------------------------------------

function resolveAssetUrl(relPath) {
  const base =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
      ? import.meta.env.BASE_URL
      : './';
  return `${base.replace(/\/?$/, '/')}${relPath.replace(/^\/+/, '')}`;
}

function makeSolidDataTexture(r, g, b, isSRGB = false) {
  const data = new Uint8Array([r, g, b, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.colorSpace = isSRGB ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

const _sharedPlaneTextures = {
  initialized: false,
  albedo: null,
  bump: null,
  fallbackAlbedo: null,
  fallbackBump: null,
  listeners: [],
};

function getSharedPlaneTextures(onLoaded = null) {
  if (!_sharedPlaneTextures.initialized) {
    _sharedPlaneTextures.initialized = true;
    _sharedPlaneTextures.fallbackAlbedo = makeSolidDataTexture(236, 236, 232, true);
    _sharedPlaneTextures.fallbackBump = makeSolidDataTexture(176, 176, 176, false);
    _sharedPlaneTextures.albedo = _sharedPlaneTextures.fallbackAlbedo;
    _sharedPlaneTextures.bump = _sharedPlaneTextures.fallbackBump;

    if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
      const loader = new THREE.TextureLoader();

      loader.load(
        resolveAssetUrl('textures/plane-albedo.png'),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedPlaneTextures.albedo = tex;
          for (const cb of _sharedPlaneTextures.listeners) {
            cb('albedo', tex);
          }
        },
        undefined,
        () => {}
      );

      loader.load(
        resolveAssetUrl('textures/plane-bump.png'),
        (tex) => {
          tex.colorSpace = THREE.NoColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          _sharedPlaneTextures.bump = tex;
          for (const cb of _sharedPlaneTextures.listeners) {
            cb('bump', tex);
          }
        },
        undefined,
        () => {}
      );
    }
  }

  if (onLoaded) {
    _sharedPlaneTextures.listeners.push(onLoaded);
    if (_sharedPlaneTextures.albedo !== _sharedPlaneTextures.fallbackAlbedo) {
      onLoaded('albedo', _sharedPlaneTextures.albedo);
    }
    if (_sharedPlaneTextures.bump !== _sharedPlaneTextures.fallbackBump) {
      onLoaded('bump', _sharedPlaneTextures.bump);
    }
  }

  return {
    albedo: _sharedPlaneTextures.albedo,
    bump: _sharedPlaneTextures.bump,
    unsubscribe() {
      if (!onLoaded) return;
      const idx = _sharedPlaneTextures.listeners.indexOf(onLoaded);
      if (idx >= 0) _sharedPlaneTextures.listeners.splice(idx, 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Sculpted Airframe Geometry Builder (smooth lofted profiles, UVs, baked AO)
// ---------------------------------------------------------------------------

class SculptedPlaneBuilder {
  constructor() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.roles = [];
    this.aos = [];
    this._vA = new THREE.Vector3();
    this._vB = new THREE.Vector3();
    this._vC = new THREE.Vector3();
    this._ab = new THREE.Vector3();
    this._ac = new THREE.Vector3();
    this._n = new THREE.Vector3();
  }

  addVert(x, y, z, nx, ny, nz, u, v, role, ao = 1.0) {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.roles.push(role);
    this.aos.push(ao);
  }

  addFlatTri(a, b, c, uvA, uvB, uvC, role, aoA = 1.0, aoB = aoA, aoC = aoA) {
    this._vA.set(a[0], a[1], a[2]);
    this._vB.set(b[0], b[1], b[2]);
    this._vC.set(c[0], c[1], c[2]);
    this._ab.subVectors(this._vB, this._vA);
    this._ac.subVectors(this._vC, this._vA);
    this._n.crossVectors(this._ab, this._ac);
    const len = this._n.length();
    if (len < 1e-7) return;
    this._n.divideScalar(len);

    this.addVert(a[0], a[1], a[2], this._n.x, this._n.y, this._n.z, uvA[0], uvA[1], role, aoA);
    this.addVert(b[0], b[1], b[2], this._n.x, this._n.y, this._n.z, uvB[0], uvB[1], role, aoB);
    this.addVert(c[0], c[1], c[2], this._n.x, this._n.y, this._n.z, uvC[0], uvC[1], role, aoC);
  }

  addFlatQuad(a, b, c, d, uvA, uvB, uvC, uvD, role, aoA = 1.0, aoB = aoA, aoC = aoA, aoD = aoA) {
    this.addFlatTri(a, b, c, uvA, uvB, uvC, role, aoA, aoB, aoC);
    this.addFlatTri(a, c, d, uvA, uvC, uvD, role, aoA, aoC, aoD);
  }

  /**
   * Lofts a closed multi-station profile along Z (stations sorted nose -Z to tail +Z).
   * Each station has:
   *   points: Array<[x, y, z]> (length M, clockwise around +Z looking from front: top -> +X -> bot -> -X)
   *   vCoord: UV v along length
   *   roleFn(segIndex, M, stationIndex) -> role
   *   aoFn(x, y, z, nx, ny, nz) -> ao
   *   smooth: boolean (true = averaged vertex normals along ring, false = flat per-quad)
   */
  addLoftedTube(stations, { capFrontRole = null, capBackRole = null, smooth = true, uScale = 1.0 } = {}) {
    const S = stations.length;
    if (S < 2) return;
    const M = stations[0].points.length;

    // Precompute smooth normals per station vertex if requested
    const vertNormals = [];
    if (smooth) {
      for (let s = 0; s < S; s++) {
        const ringN = [];
        const pts = stations[s].points;
        const prevPts = stations[Math.max(0, s - 1)].points;
        const nextPts = stations[Math.min(S - 1, s + 1)].points;
        for (let k = 0; k < M; k++) {
          const pPrev = pts[(k - 1 + M) % M];
          const pNext = pts[(k + 1) % M];
          // Tangent around ring (clockwise from front: top -> +X -> bot -> -X)
          const tx = pNext[0] - pPrev[0];
          const ty = pNext[1] - pPrev[1];
          const tz = pNext[2] - pPrev[2];
          // Tangent along length (-Z -> +Z)
          const lx = nextPts[k][0] - prevPts[k][0];
          const ly = nextPts[k][1] - prevPts[k][1];
          const lz = nextPts[k][2] - prevPts[k][2];
          // Outward normal = L x T
          let nx = ly * tz - lz * ty;
          let ny = lz * tx - lx * tz;
          let nz = lx * ty - ly * tx;
          const len = Math.hypot(nx, ny, nz);
          if (len > 1e-6) {
            nx /= len;
            ny /= len;
            nz /= len;
          } else {
            nx = 0;
            ny = 1;
            nz = 0;
          }
          ringN.push([nx, ny, nz]);
        }
        vertNormals.push(ringN);
      }
    }

    for (let s = 0; s < S - 1; s++) {
      const st0 = stations[s];
      const st1 = stations[s + 1];
      const v0 = st0.vCoord;
      const v1 = st1.vCoord;

      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        const p00 = st0.points[k];
        const p10 = st0.points[kn];
        const p01 = st1.points[k];
        const p11 = st1.points[kn];

        const u0 = (k / M) * uScale;
        const u1 = ((k + 1) / M) * uScale;

        const role = st0.roleFn ? st0.roleFn(k, M, s) : ROLE_PRIMARY;

        if (smooth && !st0.creaseAfter) {
          const n00 = vertNormals[s][k];
          const n10 = vertNormals[s][kn];
          const n01 = vertNormals[s + 1][k];
          const n11 = vertNormals[s + 1][kn];

          const ao00 = st0.aoFn ? st0.aoFn(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2]) : 1.0;
          const ao10 = st0.aoFn ? st0.aoFn(p10[0], p10[1], p10[2], n10[0], n10[1], n10[2]) : 1.0;
          const ao01 = st1.aoFn ? st1.aoFn(p01[0], p01[1], p01[2], n01[0], n01[1], n01[2]) : 1.0;
          const ao11 = st1.aoFn ? st1.aoFn(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2]) : 1.0;

          // Outward winding: (p00, p01, p11) and (p00, p11, p10)
          this.addVert(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2], u0, v0, role, ao00);
          this.addVert(p01[0], p01[1], p01[2], n01[0], n01[1], n01[2], u0, v1, role, ao01);
          this.addVert(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2], u1, v1, role, ao11);

          this.addVert(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2], u0, v0, role, ao00);
          this.addVert(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2], u1, v1, role, ao11);
          this.addVert(p10[0], p10[1], p10[2], n10[0], n10[1], n10[2], u1, v0, role, ao10);
        } else {
          const ao = st0.aoFn ? st0.aoFn(p00[0], p00[1], p00[2], 0, 0, 0) : 1.0;
          this.addFlatQuad(p00, p01, p11, p10, [u0, v0], [u0, v1], [u1, v1], [u1, v0], role, ao);
        }
      }
    }

    // Front cap (-Z outward normal): (center, p0, p1)
    if (capFrontRole !== null) {
      const pts = stations[0].points;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) {
        cx += pts[k][0];
        cy += pts[k][1];
        cz += pts[k][2];
      }
      const center = [cx / M, cy / M, cz / M];
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        this.addFlatTri(center, pts[k], pts[kn], [0.5, 0.5], [0.5 + pts[k][0] * 0.4, 0.5 + pts[k][1] * 0.4], [0.5 + pts[kn][0] * 0.4, 0.5 + pts[kn][1] * 0.4], capFrontRole, 0.82);
      }
    }

    // Back cap (+Z outward normal): (center, p1, p0)
    if (capBackRole !== null) {
      const pts = stations[S - 1].points;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) {
        cx += pts[k][0];
        cy += pts[k][1];
        cz += pts[k][2];
      }
      const center = [cx / M, cy / M, cz / M];
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        this.addFlatTri(center, pts[kn], pts[k], [0.5, 0.5], [0.5 + pts[kn][0] * 0.4, 0.5 + pts[kn][1] * 0.4], [0.5 + pts[k][0] * 0.4, 0.5 + pts[k][1] * 0.4], capBackRole, 0.86);
      }
    }
  }

  /**
   * Lofts an airfoil wing or horizontal stabilizer along X (x increasing from left -X to right +X).
   * Each station: { x, y, zLe, chord, thickness, camber, roleTop, roleBot }
   */
  addAirfoilSpan(stations, { capLeft = true, capRight = true, aoFn = null } = {}) {
    // 10-point closed cambered airfoil loop starting at trailing edge -> upper -> leading edge -> lower
    // (s = chord fraction 0=LE .. 1=TE)
    const profileSpec = [
      { s: 1.00, side: 0 },     // 0: TE
      { s: 0.72, side: +1 },    // 1: upper aft
      { s: 0.44, side: +1 },    // 2: upper mid
      { s: 0.20, side: +1 },    // 3: upper max camber
      { s: 0.05, side: +1 },    // 4: upper LE shoulder
      { s: 0.00, side: 0 },     // 5: LE nose
      { s: 0.08, side: -1 },    // 6: lower LE shoulder
      { s: 0.30, side: -1 },    // 7: lower mid
      { s: 0.65, side: -1 },    // 8: lower aft
    ];
    const M = profileSpec.length;

    const evalAirfoil = (st) => {
      const pts = [];
      const norms = [];
      for (let k = 0; k < M; k++) {
        const { s, side } = profileSpec[k];
        // NACA-inspired thickness distribution
        const yt = 5.0 * st.thickness * (
          0.2969 * Math.sqrt(Math.max(0, s)) -
          0.1260 * s -
          0.3516 * s * s +
          0.2843 * s * s * s -
          0.1015 * s * s * s * s
        );
        // Smooth camber line peaking near 38% chord
        const yc = st.camber * 4.0 * s * (1.0 - s);
        const py = st.y + yc + side * yt;
        const pz = st.zLe + s * st.chord;
        pts.push([st.x, py, pz]);
      }

      // Compute clean outward normals around the airfoil loop
      for (let k = 0; k < M; k++) {
        const pPrev = pts[(k - 1 + M) % M];
        const pNext = pts[(k + 1) % M];
        // Tangent in YZ plane moving around profile (TE -> upper -> LE -> lower)
        const ty = pNext[1] - pPrev[1];
        const tz = pNext[2] - pPrev[2];
        // Outward normal = (+1, 0, 0) x (0, ty, tz) = (0, -tz, ty)
        let ny = -tz;
        let nz = ty;
        const len = Math.hypot(ny, nz);
        if (len > 1e-6) {
          ny /= len;
          nz /= len;
        } else {
          ny = 1;
          nz = 0;
        }
        // Keep trailing edge crisp without weird averaging
        if (k === 0) {
          ny = 0;
          nz = 1;
        }
        norms.push([0, ny, nz]);
      }
      return { pts, norms };
    };

    const evals = stations.map(evalAirfoil);

    for (let s = 0; s < stations.length - 1; s++) {
      const st0 = stations[s];
      const st1 = stations[s + 1];
      const e0 = evals[s];
      const e1 = evals[s + 1];

      const uSpan0 = st0.x * 0.34;
      const uSpan1 = st1.x * 0.34;

      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        const p00 = e0.pts[k];
        const p01 = e0.pts[kn];
        const p10 = e1.pts[k];
        const p11 = e1.pts[kn];

        const n00 = e0.norms[k];
        const n01 = e0.norms[kn];
        const n10 = e1.norms[k];
        const n11 = e1.norms[kn];

        const isUpper = k < 5;
        const role = isUpper ? st0.roleTop : st0.roleBot;

        const v0 = profileSpec[k].s * (st0.chord * 0.42);
        const v1 = profileSpec[kn].s * (st0.chord * 0.42);
        const v0b = profileSpec[k].s * (st1.chord * 0.42);
        const v1b = profileSpec[kn].s * (st1.chord * 0.42);

        const defaultAo = isUpper ? 1.0 : 0.78;
        const ao00 = aoFn ? aoFn(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2], isUpper) : defaultAo;
        const ao01 = aoFn ? aoFn(p01[0], p01[1], p01[2], n01[0], n01[1], n01[2], isUpper) : defaultAo;
        const ao10 = aoFn ? aoFn(p10[0], p10[1], p10[2], n10[0], n10[1], n10[2], isUpper) : defaultAo;
        const ao11 = aoFn ? aoFn(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2], isUpper) : defaultAo;

        // Verified outward winding for x1 > x0: (p00, p10, p11) and (p00, p11, p01)
        this.addVert(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2], uSpan0, v0, role, ao00);
        this.addVert(p10[0], p10[1], p10[2], n10[0], n10[1], n10[2], uSpan1, v0b, role, ao10);
        this.addVert(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2], uSpan1, v1b, role, ao11);

        this.addVert(p00[0], p00[1], p00[2], n00[0], n00[1], n00[2], uSpan0, v0, role, ao00);
        this.addVert(p11[0], p11[1], p11[2], n11[0], n11[1], n11[2], uSpan1, v1b, role, ao11);
        this.addVert(p01[0], p01[1], p01[2], n01[0], n01[1], n01[2], uSpan0, v1, role, ao01);
      }
    }

    // Left cap (-X outward): (center, p_k, p_{k+1})
    if (capLeft) {
      const pts = evals[0].pts;
      const role = stations[0].roleTop;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) { cx += pts[k][0]; cy += pts[k][1]; cz += pts[k][2]; }
      const c = [cx / M, cy / M, cz / M];
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        this.addFlatTri(c, pts[k], pts[kn], [0.5, 0.5], [0.4, 0.4], [0.6, 0.4], role, 0.90);
      }
    }

    // Right cap (+X outward): (center, p_{k+1}, p_k)
    if (capRight) {
      const last = evals.length - 1;
      const pts = evals[last].pts;
      const role = stations[last - 1]?.roleTop ?? stations[last].roleTop;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) { cx += pts[k][0]; cy += pts[k][1]; cz += pts[k][2]; }
      const c = [cx / M, cy / M, cz / M];
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        this.addFlatTri(c, pts[kn], pts[k], [0.5, 0.5], [0.4, 0.4], [0.6, 0.4], role, 0.90);
      }
    }
  }

  /**
   * Lofts a symmetric vertical stabilizer fin along Y (y increasing upward).
   * Each station: { y, zLe, chord, halfThick, role }
   */
  addVerticalFin(stations, { capTop = true } = {}) {
    // 8-point symmetric airfoil in XZ plane going clockwise when viewed from +Y:
    // TE -> +X aft -> +X max -> LE -> -X max -> -X aft
    const prof = [
      { s: 1.00, sx: 0 },
      { s: 0.62, sx: +0.62 },
      { s: 0.25, sx: +1.00 },
      { s: 0.05, sx: +0.58 },
      { s: 0.00, sx: 0 },
      { s: 0.05, sx: -0.58 },
      { s: 0.25, sx: -1.00 },
      { s: 0.62, sx: -0.62 },
    ];
    const M = prof.length;

    const evalSt = (st) => {
      const pts = [];
      for (let k = 0; k < M; k++) {
        pts.push([prof[k].sx * st.halfThick, st.y, st.zLe + prof[k].s * st.chord]);
      }
      return pts;
    };

    const rings = stations.map(evalSt);

    for (let s = 0; s < stations.length - 1; s++) {
      const r0 = rings[s];
      const r1 = rings[s + 1];
      const role = stations[s].role;
      const v0 = stations[s].y * 0.45;
      const v1 = stations[s + 1].y * 0.45;
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        const p00 = r0[k];
        const p01 = r0[kn];
        const p10 = r1[k];
        const p11 = r1[kn];
        const u0 = prof[k].s * 0.7;
        const u1 = prof[kn].s * 0.7;
        const ao = s === 0 ? 0.86 : 0.98;
        // Outward winding for +Y upward & clockwise XZ loop: (p00, p01, p11, p10)
        // Check: on +X side, p00=(+x, y0, zBack), p01=(+x, y0, zFront), p10=(+x, y1, zBack)
        // (p01 - p00) x (p10 - p00) = (0,0,-1) x (0,1,0) = (+1, 0, 0) -> OUTWARD +X!
        this.addFlatQuad(p00, p01, p11, p10, [u0, v0], [u1, v0], [u1, v1], [u0, v1], role, ao);
      }
    }

    if (capTop) {
      const top = rings[rings.length - 1];
      const role = stations[stations.length - 1].role;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < M; k++) { cx += top[k][0]; cy += top[k][1]; cz += top[k][2]; }
      const c = [cx / M, cy / M, cz / M];
      for (let k = 0; k < M; k++) {
        const kn = (k + 1) % M;
        // +Y outward: (c, top[k], top[kn])
        this.addFlatTri(c, top[k], top[kn], [0.5, 0.5], [0.4, 0.5], [0.6, 0.5], role, 1.0);
      }
    }
  }

  /**
   * Adds a streamlined 6-sided oval/teardrop aerodynamic strut between p0 and p1.
   */
  addAeroStrut(p0, p1, width, chord, role, ao = 0.78) {
    const a = new THREE.Vector3(...p0);
    const b = new THREE.Vector3(...p1);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);

    // Align chord roughly along fuselage Z axis so strut slices airflow cleanly
    const zRef = new THREE.Vector3(0, 0, 1);
    let side = new THREE.Vector3().crossVectors(dir, zRef);
    if (side.lengthSq() < 1e-4) {
      side.set(0, 1, 0).cross(dir);
    }
    side.normalize();
    // (side, fore, dir) right-handed -> fore x dir = +side (strictly outward normals)
    const fore = new THREE.Vector3().crossVectors(dir, side).normalize();

    const segs = 6;
    const rA = [];
    const rB = [];
    for (let i = 0; i < segs; i++) {
      const ang = (i / segs) * Math.PI * 2;
      const cs = Math.cos(ang) * (width * 0.5);
      const sn = Math.sin(ang) * (chord * 0.5);
      const ox = side.x * cs + fore.x * sn;
      const oy = side.y * cs + fore.y * sn;
      const oz = side.z * cs + fore.z * sn;
      rA.push([a.x + ox, a.y + oy, a.z + oz]);
      rB.push([b.x + ox, b.y + oy, b.z + oz]);
    }

    for (let i = 0; i < segs; i++) {
      const ni = (i + 1) % segs;
      const u0 = i / segs;
      const u1 = (i + 1) / segs;
      // Check orientation: (rB[i] - rA[i]) = +dir; (rA[ni] - rA[i]) = tangent around +dir
      // (side -> fore) cross dir: side x fore = dir, so tangent x dir = outward!
      // Therefore (rA[i], rA[ni], rB[ni], rB[i]): (rA[ni]-rA[i]) x (rB[i]-rA[i]) = tangent x dir = outward!
      this.addFlatQuad(rA[i], rA[ni], rB[ni], rB[i], [u0, 0], [u1, 0], [u1, len * 0.35], [u0, len * 0.35], role, ao);
    }
  }

  buildGeometry() {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    geom.setAttribute('aPartRole', new THREE.Float32BufferAttribute(this.roles, 1));
    geom.setAttribute('aAo', new THREE.Float32BufferAttribute(this.aos, 1));
    return geom;
  }
}

/**
 * Generates a closed superellipse ring of M points at z (clockwise from front: top -> +X -> bot -> -X).
 */
function makeSuperellipseRing(z, rx, yTop, yBot, power = 0.88, M = 14) {
  const yc = (yTop + yBot) * 0.5;
  const ry = (yTop - yBot) * 0.5;
  const pts = [];
  for (let k = 0; k < M; k++) {
    const a = (k / M) * Math.PI * 2;
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const sx = Math.sign(sa) * Math.pow(Math.abs(sa), power);
    const sy = Math.sign(ca) * Math.pow(Math.abs(ca), power);
    pts.push([sx * rx, yc + sy * ry, z]);
  }
  return pts;
}

/**
 * Generates a realistic 10-point hydrodynamic seaplane float hull cross-section
 * (crowned deck, rounded chine shoulders, sharp chine, V-deadrise keel).
 */
function makePontoonRing(cx, z, halfW, yDeck, yChine, yKeel) {
  const crown = (yDeck - yChine) * 0.28;
  return [
    [cx, yDeck + crown, z],               // 0: deck centerline crown
    [cx + halfW * 0.62, yDeck, z],        // 1: starboard deck shoulder
    [cx + halfW, yChine + (yDeck - yChine) * 0.35, z], // 2: starboard upper side
    [cx + halfW * 1.02, yChine, z],       // 3: starboard sharp chine
    [cx + halfW * 0.52, (yChine + yKeel) * 0.52, z],   // 4: starboard planing bottom
    [cx, yKeel, z],                       // 5: V-keel bottom
    [cx - halfW * 0.52, (yChine + yKeel) * 0.52, z],   // 6: port planing bottom
    [cx - halfW * 1.02, yChine, z],       // 7: port sharp chine
    [cx - halfW, yChine + (yDeck - yChine) * 0.35, z], // 8: port upper side
    [cx - halfW * 0.62, yDeck, z],        // 9: port deck shoulder
  ];
}

/**
 * Evaluates baked ambient occlusion + subtle exhaust soot darkening for fuselage points.
 */
function fuselageAo(x, y, z, nx, ny, nz) {
  let ao = 0.94 + ny * 0.08; // Gentle sky/ground bounce shading
  // Darken belly under fuselage & wing root crease
  if (y < -0.25) {
    ao *= 0.84;
  }
  // Subtle wing-root ambient occlusion right under high wing (y ~ 0.65..0.95, z ~ -1.3..+0.6)
  if (z > -1.35 && z < 0.65 && y > 0.52 && y < 0.92 && Math.abs(x) > 0.35) {
    ao *= 0.86;
  }
  // Subtle matte soot/oil streak trailing behind twin engine exhaust stubs (z ~ -2.05..-0.55)
  if (z > -2.10 && z < -0.45 && y > -0.48 && y < 0.06 && Math.abs(x) > 0.40) {
    const fade = 1.0 - (z + 2.10) / 1.65;
    ao *= 1.0 - 0.18 * Math.max(0, Math.min(1, fade));
  }
  return Math.max(0.62, Math.min(1.04, ao));
}

/**
 * Builds the sculpted aerodynamic amphibious water-bomber BufferGeometry
 * (DHC-2 Beaver / Air Tractor Fire Boss / CL-415 inspired silhouette).
 * Forward nose points along -Z, wingspan along +-X, up along +Y.
 */
export function buildFloatplaneGeometry() {
  const b = new SculptedPlaneBuilder();

  // =========================================================================
  // 1. SCULPTED LOFTED FUSELAGE (rounded nose cowl -> cabin -> graceful tailcone)
  // =========================================================================
  const M_FUSE = 14;
  const fuseSpec = [
    // z, rx, yTop, yBot, power, zone
    { z: -3.38, rx: 0.27, yTop: 0.21, yBot: -0.29, p: 1.00, zone: 'noseCap' },
    { z: -3.14, rx: 0.47, yTop: 0.34, yBot: -0.44, p: 0.96, zone: 'cowlRing' },
    { z: -2.72, rx: 0.55, yTop: 0.42, yBot: -0.53, p: 0.92, zone: 'cowl' },
    { z: -1.78, rx: 0.59, yTop: 0.48, yBot: -0.59, p: 0.86, zone: 'firewall' },
    { z: -1.24, rx: 0.61, yTop: 0.91, yBot: -0.61, p: 0.80, zone: 'cockpit' },
    { z: -0.35, rx: 0.60, yTop: 0.93, yBot: -0.60, p: 0.80, zone: 'cabin' },
    { z: +0.68, rx: 0.55, yTop: 0.82, yBot: -0.55, p: 0.84, zone: 'aftCabin' },
    { z: +1.78, rx: 0.41, yTop: 0.60, yBot: -0.34, p: 0.90, zone: 'midTail' },
    { z: +2.98, rx: 0.27, yTop: 0.46, yBot: -0.13, p: 0.95, zone: 'aftTail' },
    { z: +4.28, rx: 0.12, yTop: 0.35, yBot: +0.07, p: 1.00, zone: 'tailTip' },
  ];

  const fuseStations = fuseSpec.map((st, idx) => ({
    points: makeSuperellipseRing(st.z, st.rx, st.yTop, st.yBot, st.p, M_FUSE),
    vCoord: (st.z + 3.4) * 0.32,
    aoFn: fuselageAo,
    roleFn: (k, M) => {
      // k=0 is top centerline, k=3..4 is +X side, k=7 is bottom centerline, k=10..11 is -X side
      const isTopDeck = k === 0 || k === 1 || k === M - 1 || k === M - 2;
      const isTopNarrow = k === 0 || k === M - 1;
      const isBelly = k >= 5 && k <= 8;
      const isMidStripe = k === 3 || k === 10;
      const isUpperSide = k === 1 || k === 2 || k === M - 2 || k === M - 3;

      if (st.zone === 'noseCap' || st.zone === 'cowlRing') {
        return isBelly ? ROLE_SHADED : ROLE_ACCENT;
      }
      if (st.zone === 'cowl') {
        if (isTopNarrow) return ROLE_DARK; // Matte anti-glare top cowling panel
        if (isBelly) return ROLE_SHADED;
        return ROLE_PRIMARY;
      }
      if (st.zone === 'firewall') {
        // Sloped windshield front spans firewall -> cockpit
        if (isTopDeck) return ROLE_GLASS;
        if (isBelly) return ROLE_SHADED;
        if (isMidStripe) return ROLE_STRIPE;
        return ROLE_PRIMARY;
      }
      if (st.zone === 'cockpit') {
        // Side cockpit glazing + painted roof
        if (isTopNarrow) return ROLE_PRIMARY;
        if (isUpperSide) return ROLE_GLASS;
        if (isBelly) return ROLE_SHADED;
        if (isMidStripe) return ROLE_STRIPE;
        return ROLE_PRIMARY;
      }
      if (st.zone === 'cabin' || st.zone === 'aftCabin') {
        if (isBelly) return ROLE_SHADED;
        if (isMidStripe) return ROLE_STRIPE;
        return ROLE_PRIMARY;
      }
      if (st.zone === 'midTail') {
        if (isBelly) return ROLE_SHADED;
        if (isMidStripe) return ROLE_STRIPE;
        return ROLE_PRIMARY;
      }
      // aftTail -> tailTip: high-visibility accent tail cone
      return isBelly ? ROLE_SHADED : ROLE_ACCENT;
    },
  }));

  b.addLoftedTube(fuseStations, {
    capFrontRole: ROLE_DARK,
    capBackRole: ROLE_ACCENT,
    smooth: true,
    uScale: 1.5,
  });

  // Under-cowl chin air-intake scoop (adds unmistakable radial/turboprop water-bomber nose!)
  const chinStations = [
    {
      points: makeSuperellipseRing(-3.08, 0.16, -0.40, -0.56, 0.85, 8),
      vCoord: 0.0,
      roleFn: () => ROLE_ACCENT,
      aoFn: () => 0.78,
    },
    {
      points: makeSuperellipseRing(-2.65, 0.24, -0.44, -0.68, 0.82, 8),
      vCoord: 0.18,
      roleFn: (k) => (k >= 3 && k <= 5 ? ROLE_SHADED : ROLE_PRIMARY),
      aoFn: () => 0.74,
    },
    {
      points: makeSuperellipseRing(-1.95, 0.18, -0.50, -0.64, 0.88, 8),
      vCoord: 0.42,
      roleFn: () => ROLE_SHADED,
      aoFn: () => 0.72,
    },
  ];
  b.addLoftedTube(chinStations, { capFrontRole: ROLE_DARK, capBackRole: ROLE_SHADED, smooth: true, uScale: 0.6 });

  // Twin angled engine exhaust stubs protruding below firewall sides
  for (const s of [-1, 1]) {
    b.addAeroStrut(
      [s * 0.45, -0.34, -2.35],
      [s * 0.60, -0.45, -1.85],
      0.085,
      0.11,
      ROLE_DARK,
      0.66
    );
    b.addAeroStrut(
      [s * 0.48, -0.22, -2.28],
      [s * 0.61, -0.31, -1.92],
      0.075,
      0.095,
      ROLE_DARK,
      0.68
    );
  }

  // Windshield structural center mullion & side A-pillars (crisp framed greenhouse)
  b.addAeroStrut([0.0, 0.46, -1.78], [0.0, 0.92, -1.24], 0.048, 0.055, ROLE_PRIMARY, 0.92);
  for (const s of [-1, 1]) {
    b.addAeroStrut([s * 0.44, 0.40, -1.74], [s * 0.46, 0.84, -1.24], 0.052, 0.058, ROLE_PRIMARY, 0.90);
  }

  // Recessed belly water-drop bay rails / fairing lip
  for (const s of [-1, 1]) {
    b.addAeroStrut([s * 0.28, -0.60, -1.18], [s * 0.28, -0.58, +0.62], 0.065, 0.055, ROLE_DARK, 0.66);
  }

  // =========================================================================
  // 2. AIRFOIL-PROFILE HIGH WINGS (13.0 m span, +2.0 deg dihedral, tapered tips)
  // =========================================================================
  const wingAo = (x, y, z, nx, ny, nz, isUpper) => {
    const rootProximity = Math.exp(-(x * x) / 1.8);
    if (isUpper) {
      return Math.max(0.86, Math.min(1.04, 0.98 + ny * 0.04 - rootProximity * 0.06));
    }
    // Underside of wing darkened by ambient occlusion + strut shadows
    return Math.max(0.64, 0.78 - rootProximity * 0.12);
  };

  // Symmetric stations from port tip (-6.50) to starboard tip (+6.50)
  const wingStations = [
    { x: -6.52, y: 1.16, zLe: -1.04, chord: 0.72, thickness: 0.09, camber: 0.025, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: -6.22, y: 1.09, zLe: -1.26, chord: 1.18, thickness: 0.14, camber: 0.040, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: -5.12, y: 1.05, zLe: -1.36, chord: 1.54, thickness: 0.19, camber: 0.052, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x: -2.85, y: 0.98, zLe: -1.44, chord: 1.90, thickness: 0.24, camber: 0.062, roleTop: ROLE_STRIPE, roleBot: ROLE_STRIPE },
    { x: -2.02, y: 0.96, zLe: -1.46, chord: 1.98, thickness: 0.25, camber: 0.065, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x:  0.00, y: 0.94, zLe: -1.48, chord: 2.04, thickness: 0.27, camber: 0.068, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x: +2.02, y: 0.96, zLe: -1.46, chord: 1.98, thickness: 0.25, camber: 0.065, roleTop: ROLE_STRIPE, roleBot: ROLE_STRIPE },
    { x: +2.85, y: 0.98, zLe: -1.44, chord: 1.90, thickness: 0.24, camber: 0.062, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x: +5.12, y: 1.05, zLe: -1.36, chord: 1.54, thickness: 0.19, camber: 0.052, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: +6.22, y: 1.09, zLe: -1.26, chord: 1.18, thickness: 0.14, camber: 0.040, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: +6.52, y: 1.16, zLe: -1.04, chord: 0.72, thickness: 0.09, camber: 0.025, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
  ];
  b.addAirfoilSpan(wingStations, { capLeft: true, capRight: true, aoFn: wingAo });

  // Streamlined teardrop high-wing lift struts (twin V-struts per side)
  for (const s of [-1, 1]) {
    b.addAeroStrut([s * 0.52, -0.46, -0.98], [s * 3.18, 0.91, -0.94], 0.068, 0.135, ROLE_DARK, 0.74);
    b.addAeroStrut([s * 0.52, -0.44, +0.08], [s * 3.18, 0.91, -0.10], 0.058, 0.115, ROLE_DARK, 0.74);
  }

  // =========================================================================
  // 3. SCULPTED TAIL EMPENNAGE (Airfoil H-stab + Curved Dorsal Fillet V-fin)
  // =========================================================================
  const hStabStations = [
    { x: -2.14, y: 0.45, zLe: 3.38, chord: 0.72, thickness: 0.075, camber: 0.0, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: -1.52, y: 0.44, zLe: 3.18, chord: 1.00, thickness: 0.10, camber: 0.0, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x:  0.00, y: 0.43, zLe: 3.04, chord: 1.18, thickness: 0.12, camber: 0.0, roleTop: ROLE_PRIMARY, roleBot: ROLE_SHADED },
    { x: +1.52, y: 0.44, zLe: 3.18, chord: 1.00, thickness: 0.10, camber: 0.0, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
    { x: +2.14, y: 0.45, zLe: 3.38, chord: 0.72, thickness: 0.075, camber: 0.0, roleTop: ROLE_ACCENT, roleBot: ROLE_ACCENT },
  ];
  b.addAirfoilSpan(hStabStations, { capLeft: true, capRight: true, aoFn: wingAo });

  // Swept vertical stabilizer with curved dorsal strake fillet
  const vFinStations = [
    { y: 0.34, zLe: 1.72, chord: 2.52, halfThick: 0.095, role: ROLE_ACCENT }, // Dorsal strake root
    { y: 0.62, zLe: 2.38, chord: 1.94, halfThick: 0.088, role: ROLE_ACCENT }, // Fillet curve
    { y: 1.18, zLe: 2.86, chord: 1.52, halfThick: 0.078, role: ROLE_ACCENT }, // Mid fin
    { y: 1.66, zLe: 3.16, chord: 1.24, halfThick: 0.068, role: ROLE_STRIPE }, // Forestry ID stripe band
    { y: 2.02, zLe: 3.38, chord: 1.02, halfThick: 0.056, role: ROLE_ACCENT }, // Upper fin
    { y: 2.30, zLe: 3.56, chord: 0.76, halfThick: 0.036, role: ROLE_ACCENT }, // Sculpted rounded fin tip
  ];
  b.addVerticalFin(vFinStations, { capTop: true });

  // =========================================================================
  // 4. HYDRODYNAMIC TWIN AMPHIBIOUS PONTOONS (Stepped Keel + Bow + Water Rudders)
  // =========================================================================
  for (const s of [-1, 1]) {
    const px = s * 1.52;
    const pontoonAo = (x, y, z, nx, ny) => {
      if (ny < -0.25) return 0.68; // Dark shadowed keel underside
      return Math.max(0.76, Math.min(1.0, 0.88 + ny * 0.12));
    };

    // Forward planing hull (bow -> hydrodynamic step at z = +0.16)
    const fwdHull = [
      { z: -3.32, hw: 0.05, yd: -1.24, yc: -1.32, yk: -1.40, zone: 'bumper' },
      { z: -3.02, hw: 0.18, yd: -1.19, yc: -1.34, yk: -1.52, zone: 'bow' },
      { z: -2.42, hw: 0.31, yd: -1.16, yc: -1.40, yk: -1.72, zone: 'bow' },
      { z: -1.45, hw: 0.34, yd: -1.17, yc: -1.44, yk: -1.78, zone: 'hull' },
      { z: +0.16, hw: 0.34, yd: -1.18, yc: -1.45, yk: -1.78, zone: 'hull' },
    ].map((st) => ({
      points: makePontoonRing(px, st.z, st.hw, st.yd, st.yc, st.yk),
      vCoord: (st.z + 3.4) * 0.35,
      aoFn: pontoonAo,
      roleFn: (k) => {
        const isBottom = k >= 4 && k <= 6;
        if (st.zone === 'bumper') return ROLE_DARK;
        if (st.zone === 'bow') return isBottom ? ROLE_DARK : ROLE_ACCENT;
        return isBottom ? ROLE_DARK : ROLE_PONTOON;
      },
    }));
    b.addLoftedTube(fwdHull, { capFrontRole: ROLE_DARK, capBackRole: ROLE_DARK, smooth: true, uScale: 1.0 });

    // Aft hull behind hydrodynamic keel step (step rises +0.14 m cleanly!)
    const aftHull = [
      { z: +0.16, hw: 0.33, yd: -1.18, yc: -1.43, yk: -1.64 },
      { z: +1.15, hw: 0.28, yd: -1.20, yc: -1.41, yk: -1.57 },
      { z: +2.05, hw: 0.16, yd: -1.22, yc: -1.36, yk: -1.46 },
      { z: +2.36, hw: 0.08, yd: -1.24, yc: -1.33, yk: -1.40 },
    ].map((st) => ({
      points: makePontoonRing(px, st.z, st.hw, st.yd, st.yc, st.yk),
      vCoord: (st.z + 3.4) * 0.35,
      aoFn: pontoonAo,
      roleFn: (k) => (k >= 4 && k <= 6 ? ROLE_DARK : ROLE_PONTOON),
    }));
    b.addLoftedTube(aftHull, { capFrontRole: null, capBackRole: ROLE_PONTOON, smooth: true, uScale: 1.0 });

    // Retracted amphibious main wheel cheek blister on pontoon mid-hull
    const wheelBlister = [
      { z: -0.35, rx: 0.08, yt: -1.24, yb: -1.56 },
      { z: +0.05, rx: 0.12, yt: -1.22, yb: -1.62 },
      { z: +0.42, rx: 0.06, yt: -1.26, yb: -1.52 },
    ].map((st) => ({
      points: makeSuperellipseRing(st.z, st.rx, st.yt, st.yb, 0.95, 8).map(([x, y, z]) => [x + px + s * 0.28, y, z]),
      vCoord: st.z,
      roleFn: () => ROLE_DARK,
      aoFn: () => 0.66,
    }));
    b.addLoftedTube(wheelBlister, { capFrontRole: ROLE_DARK, capBackRole: ROLE_DARK, smooth: true, uScale: 0.5 });

    // Rear water rudder fin mounted on stern of each pontoon
    b.addAeroStrut([px, -1.28, +2.34], [px, -1.54, +2.64], 0.042, 0.22, ROLE_DARK, 0.72);

    // Streamlined pontoon N-struts & diagonal X-bracing to lower fuselage
    b.addAeroStrut([s * 0.44, -0.50, -1.60], [px, -1.18, -1.48], 0.062, 0.125, ROLE_DARK, 0.72);
    b.addAeroStrut([s * 0.44, -0.48, +0.34], [px, -1.18, +0.30], 0.062, 0.125, ROLE_DARK, 0.72);
    // Diagonal shear strut
    b.addAeroStrut([s * 0.44, -0.50, -1.52], [px, -1.18, +0.26], 0.044, 0.080, ROLE_DARK, 0.70);
  }

  // Twin streamlined cross-spreader bars connecting port & starboard pontoons
  b.addAeroStrut([-1.48, -1.20, -1.48], [+1.48, -1.20, -1.48], 0.060, 0.120, ROLE_PONTOON, 0.78);
  b.addAeroStrut([-1.48, -1.20, +0.30], [+1.48, -1.20, +0.30], 0.060, 0.120, ROLE_PONTOON, 0.78);

  return b.buildGeometry();
}

/**
 * Applies a livery palette multiplied by baked vertex ambient occlusion to a floatplane BufferGeometry.
 */
function paintFloatplaneVertexColors(geometry, livery) {
  const liv = livery || DEFAULT_LIVERY;
  const roles = geometry.getAttribute('aPartRole');
  const aos = geometry.getAttribute('aAo');
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
    GLASS_COLOR,
  ];

  const arr = colorAttr.array;
  for (let i = 0; i < count; i++) {
    const roleIdx = Math.min(6, Math.max(0, Math.round(roles.getX(i))));
    const ao = aos ? aos.getX(i) : 1.0;
    const c = palette[roleIdx];
    arr[i * 3] = Math.min(1, c.r * ao);
    arr[i * 3 + 1] = Math.min(1, c.g * ao);
    arr[i * 3 + 2] = Math.min(1, c.b * ao);
  }
  colorAttr.needsUpdate = true;
}

/**
 * Generates a smooth radial aviation propeller motion-blur disc texture (128x128).
 */
function createPropellerTexture() {
  if (typeof document === 'undefined') {
    return makeSolidDataTexture(220, 220, 220, true);
  }
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  ctx.clearRect(0, 0, size, size);

  // Soft radial translucent prop wash disc
  const grad = ctx.createRadialGradient(cx, cy, 8, cx, cy, 58);
  grad.addColorStop(0.0, 'rgba(30, 34, 38, 0.35)');
  grad.addColorStop(0.76, 'rgba(190, 200, 210, 0.12)');
  grad.addColorStop(0.92, 'rgba(248, 206, 100, 0.42)');
  grad.addColorStop(0.98, 'rgba(248, 206, 100, 0.12)');
  grad.addColorStop(1.0, 'rgba(248, 206, 100, 0.0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, 58, 0, Math.PI * 2);
  ctx.fill();

  // Three soft motion-blurred dark composite blades with yellow safety tips
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);

    const bGrad = ctx.createLinearGradient(0, -16, 0, 16);
    bGrad.addColorStop(0.0, 'rgba(28, 32, 36, 0.0)');
    bGrad.addColorStop(0.5, 'rgba(28, 32, 36, 0.46)');
    bGrad.addColorStop(1.0, 'rgba(28, 32, 36, 0.0)');
    ctx.fillStyle = bGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 54, -0.26, 0.26);
    ctx.closePath();
    ctx.fill();

    // High-vis yellow blade tip blur arc
    ctx.fillStyle = 'rgba(248, 206, 100, 0.68)';
    ctx.beginPath();
    ctx.arc(0, 0, 57, -0.20, 0.20);
    ctx.arc(0, 0, 49, 0.20, -0.20, true);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates weathered matte aviation wing registration stencil texture (e.g. "EF" or "07").
 */
function createWingStencilTexture(label = '07') {
  if (typeof document === 'undefined') {
    return makeSolidDataTexture(32, 32, 32, true);
  }
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 64);

  // Subtle matte dark charcoal stencil paint with slight weathered alpha
  ctx.fillStyle = 'rgba(26, 30, 34, 0.88)';
  ctx.font = '900 44px "Arial Black", Impact, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(label).slice(0, 4), 64, 35);

  // Subtle top/bottom military-forestry registration trim bars
  ctx.fillStyle = 'rgba(26, 30, 34, 0.45)';
  ctx.fillRect(20, 8, 88, 3);
  ctx.fillRect(20, 54, 88, 3);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Creates the sculpted 3-blade physical propeller + curved aerodynamic spinner hub for the hero plane.
 */
function createHeroPropAssembly(livery) {
  const propGroup = new THREE.Group();
  propGroup.name = 'HeroPropAssembly';

  // Sculpted tapered aluminum/accent spinner cone
  const spinnerPts = [
    new THREE.Vector2(0.001, 0.44),
    new THREE.Vector2(0.11, 0.34),
    new THREE.Vector2(0.21, 0.16),
    new THREE.Vector2(0.25, 0.0),
  ];
  const spinnerGeo = new THREE.LatheGeometry(spinnerPts, 12);
  spinnerGeo.rotateX(-Math.PI / 2); // Point tip toward -Z
  const spinnerMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(livery.accent || DEFAULT_LIVERY.accent),
    roughness: 0.68,
    metalness: 0.25,
  });
  const spinnerMesh = new THREE.Mesh(spinnerGeo, spinnerMat);
  spinnerMesh.position.set(0, 0, 0.08);
  propGroup.add(spinnerMesh);

  // Three physical twisted composite propeller blades with high-vis yellow safety tips
  const bladeGeo = new THREE.BoxGeometry(0.16, 0.96, 0.032);
  bladeGeo.translate(0, 0.56, 0);
  const bladeMat = new THREE.MeshStandardMaterial({
    color: '#25292e',
    roughness: 0.72,
    metalness: 0.18,
  });
  const tipGeo = new THREE.BoxGeometry(0.145, 0.15, 0.034);
  tipGeo.translate(0, 1.02, 0);
  const tipMat = new THREE.MeshStandardMaterial({
    color: '#f5cb5c',
    roughness: 0.78,
    metalness: 0.08,
  });

  const blades = [];
  for (let i = 0; i < 3; i++) {
    const holder = new THREE.Group();
    holder.rotation.z = (i * Math.PI * 2) / 3;
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.rotation.y = 0.28; // Authentic prop pitch twist
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.rotation.y = 0.28;
    holder.add(blade, tip);
    propGroup.add(holder);
    blades.push(holder);
  }

  // Translucent radial motion-blur disc right alongside physical blades
  const propTex = createPropellerTexture();
  const discGeo = new THREE.PlaneGeometry(2.26, 2.26);
  const discMat = new THREE.MeshBasicMaterial({
    map: propTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const discMesh = new THREE.Mesh(discGeo, discMat);
  discMesh.position.set(0, 0, -0.02);
  propGroup.add(discMesh);

  return {
    propGroup,
    spinnerMat,
    dispose() {
      spinnerGeo.dispose();
      spinnerMat.dispose();
      bladeGeo.dispose();
      bladeMat.dispose();
      tipGeo.dispose();
      tipMat.dispose();
      discGeo.dispose();
      discMat.dispose();
      propTex.dispose();
    },
  };
}

/**
 * Creates the dedicated hero floatplane mesh:
 * - Sculpted aerodynamic fuselage, airfoil high wings, dorsal-fillet tail, stepped twin pontoons
 * - Matte weathered riveted aluminum PBR textures (plane-albedo + plane-bump)
 * - Wing EF + slot stencil markings, tinted recessed cockpit canopy & pilot silhouette
 * - Navigation lights (port red, starboard green, tail white + pulsing dorsal beacon)
 * - Animated 3-blade prop + motion-blur disc, control surfaces (ailerons/elevator/rudder),
 *   belly water-drop bay doors, and scooping pontoon water rudders!
 */
export function createHeroPlaneMesh(liveryIndex = 0, stencilText = '07') {
  const group = new THREE.Group();
  group.name = 'HeroFloatplane';
  group.rotation.order = 'YXZ';

  const livery = LIVERIES[liveryIndex] || DEFAULT_LIVERY;
  const bodyGeo = buildFloatplaneGeometry();
  paintFloatplaneVertexColors(bodyGeo, livery);

  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.80,
    metalness: 0.18,
    bumpScale: 0.032,
  });

  const ctrlMatPrimary = new THREE.MeshStandardMaterial({
    color: new THREE.Color(livery.primary || DEFAULT_LIVERY.primary),
    roughness: 0.82,
    metalness: 0.16,
  });
  const ctrlMatAccent = new THREE.MeshStandardMaterial({
    color: new THREE.Color(livery.accent || DEFAULT_LIVERY.accent),
    roughness: 0.82,
    metalness: 0.16,
  });
  const ctrlMatBay = new THREE.MeshStandardMaterial({
    color: new THREE.Color(livery.shaded || DEFAULT_LIVERY.shaded),
    roughness: 0.86,
    metalness: 0.18,
  });

  const texHandle = getSharedPlaneTextures((kind, tex) => {
    if (kind === 'albedo') {
      bodyMat.map = tex;
      bodyMat.needsUpdate = true;
      ctrlMatPrimary.map = tex;
      ctrlMatPrimary.needsUpdate = true;
      ctrlMatAccent.map = tex;
      ctrlMatAccent.needsUpdate = true;
    } else if (kind === 'bump') {
      bodyMat.bumpMap = tex;
      bodyMat.needsUpdate = true;
    }
  });
  bodyMat.map = texHandle.albedo;
  bodyMat.bumpMap = texHandle.bump;
  ctrlMatPrimary.map = texHandle.albedo;
  ctrlMatAccent.map = texHandle.albedo;

  const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
  bodyMesh.name = 'HeroFloatplaneBody';
  group.add(bodyMesh);

  // Subtle recessed cockpit interior silhouette (glare shield + pilot headrest visible behind windshield)
  const cockpitInteriorGeo = new THREE.BoxGeometry(0.56, 0.30, 0.42);
  const cockpitInteriorMat = new THREE.MeshStandardMaterial({
    color: '#171b20',
    roughness: 0.95,
    metalness: 0.0,
  });
  const cockpitInterior = new THREE.Mesh(cockpitInteriorGeo, cockpitInteriorMat);
  cockpitInterior.position.set(0, 0.54, -1.08);
  group.add(cockpitInterior);

  // Tinted semi-gloss aviation windshield overlay for realistic canopy readability
  const windshieldGeo = new THREE.PlaneGeometry(0.92, 0.56);
  const windshieldMat = new THREE.MeshStandardMaterial({
    color: '#1c3647',
    roughness: 0.24,
    metalness: 0.30,
    transparent: true,
    opacity: 0.72,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const windshieldMesh = new THREE.Mesh(windshieldGeo, windshieldMat);
  windshieldMesh.position.set(0, 0.72, -1.53);
  windshieldMesh.rotation.x = -0.86;
  group.add(windshieldMesh);

  // Wing registration stencils: "EF" on port wing, slot digits ("07") on starboard wing
  let currentStencil = String(stencilText || '07').slice(0, 3);
  const efTex = createWingStencilTexture('EF');
  let numTex = createWingStencilTexture(currentStencil);

  const stencilGeo = new THREE.PlaneGeometry(1.55, 0.78);
  stencilGeo.rotateX(-Math.PI / 2);

  const efMat = new THREE.MeshBasicMaterial({
    map: efTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const efMesh = new THREE.Mesh(stencilGeo, efMat);
  efMesh.position.set(-3.92, 1.135, -0.58);
  efMesh.rotation.z = -0.032; // Match wing dihedral
  group.add(efMesh);

  const numMat = new THREE.MeshBasicMaterial({
    map: numTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const numMesh = new THREE.Mesh(stencilGeo, numMat);
  numMesh.position.set(+3.92, 1.135, -0.58);
  numMesh.rotation.z = +0.032;
  group.add(numMesh);

  // =========================================================================
  // Animated Control Surfaces & Belly Water-Drop Bay Doors
  // =========================================================================

  // Port & Starboard Ailerons (hinged at outer trailing edge)
  const aileronGeo = new THREE.BoxGeometry(1.88, 0.055, 0.34);
  aileronGeo.translate(0, 0, 0.17); // Pivot around leading edge
  const leftAileron = new THREE.Mesh(aileronGeo, ctrlMatPrimary);
  leftAileron.position.set(-4.05, 1.03, 0.24);
  leftAileron.rotation.z = -0.032;
  group.add(leftAileron);

  const rightAileron = new THREE.Mesh(aileronGeo, ctrlMatPrimary);
  rightAileron.position.set(+4.05, 1.03, 0.24);
  rightAileron.rotation.z = +0.032;
  group.add(rightAileron);

  // Elevator (hinged along horizontal stabilizer trailing edge)
  const elevatorGeo = new THREE.BoxGeometry(3.05, 0.048, 0.34);
  elevatorGeo.translate(0, 0, 0.17);
  const elevatorMesh = new THREE.Mesh(elevatorGeo, ctrlMatPrimary);
  elevatorMesh.position.set(0, 0.44, 4.18);
  group.add(elevatorMesh);

  // Rudder (hinged along vertical fin trailing edge)
  const rudderGeo = new THREE.BoxGeometry(0.052, 1.56, 0.38);
  rudderGeo.translate(0, 0, 0.19);
  const rudderMesh = new THREE.Mesh(rudderGeo, ctrlMatAccent);
  rudderMesh.position.set(0, 1.44, 4.30);
  group.add(rudderMesh);

  // Twin Hinged Belly Water-Drop Bay Doors
  const bayDoorGeo = new THREE.BoxGeometry(0.32, 0.045, 1.62);
  const leftBayDoor = new THREE.Mesh(bayDoorGeo, ctrlMatBay);
  leftBayDoor.geometry = bayDoorGeo.clone();
  leftBayDoor.geometry.translate(+0.15, 0, 0); // Hinge on outer left edge
  leftBayDoor.position.set(-0.31, -0.61, -0.28);
  group.add(leftBayDoor);

  const rightBayDoor = new THREE.Mesh(bayDoorGeo, ctrlMatBay);
  rightBayDoor.geometry = bayDoorGeo.clone();
  rightBayDoor.geometry.translate(-0.15, 0, 0); // Hinge on outer right edge
  rightBayDoor.position.set(+0.31, -0.61, -0.28);
  group.add(rightBayDoor);

  // =========================================================================
  // Navigation & Anti-Collision Strobe Lights (Port Red, Stbd Green, Tail White)
  // =========================================================================
  const navLightGeo = new THREE.SphereGeometry(0.095, 8, 6);
  const navRedMat = new THREE.MeshBasicMaterial({ color: '#ff3828' });
  const navGreenMat = new THREE.MeshBasicMaterial({ color: '#38f06a' });
  const navWhiteMat = new THREE.MeshBasicMaterial({ color: '#fff6e0' });
  const beaconMat = new THREE.MeshBasicMaterial({ color: '#ff3b24' });

  const portNav = new THREE.Mesh(navLightGeo, navRedMat);
  portNav.position.set(-6.54, 1.18, -0.92);
  group.add(portNav);

  const stbdNav = new THREE.Mesh(navLightGeo, navGreenMat);
  stbdNav.position.set(+6.54, 1.18, -0.92);
  group.add(stbdNav);

  const tailNav = new THREE.Mesh(navLightGeo, navWhiteMat);
  tailNav.scale.setScalar(0.85);
  tailNav.position.set(0, 0.24, 4.34);
  group.add(tailNav);

  const dorsalBeacon = new THREE.Mesh(navLightGeo, beaconMat);
  dorsalBeacon.scale.setScalar(0.95);
  dorsalBeacon.position.set(0, 2.34, 3.88);
  group.add(dorsalBeacon);

  // =========================================================================
  // Spinning 3-Blade Propeller + Motion-Blur Disc at Nose
  // =========================================================================
  const propAsm = createHeroPropAssembly(livery);
  const propMesh = propAsm.propGroup;
  propMesh.position.set(0, -0.04, -3.48);
  group.add(propMesh);

  let currentLiveryIdx = liveryIndex;
  let bayDoorOpen = 0;
  let smoothRollDeflect = 0;
  let smoothPitchDeflect = 0;
  let beaconPhase = 0;

  return {
    group,
    propMesh,
    setLivery(idx) {
      const safeIdx = ((idx | 0) % LIVERIES.length + LIVERIES.length) % LIVERIES.length;
      if (safeIdx === currentLiveryIdx) return;
      currentLiveryIdx = safeIdx;
      const liv = LIVERIES[safeIdx] || DEFAULT_LIVERY;
      paintFloatplaneVertexColors(bodyGeo, liv);
      ctrlMatPrimary.color.set(liv.primary || DEFAULT_LIVERY.primary);
      ctrlMatAccent.color.set(liv.accent || DEFAULT_LIVERY.accent);
      ctrlMatBay.color.set(liv.shaded || DEFAULT_LIVERY.shaded);
      propAsm.spinnerMat.color.set(liv.accent || DEFAULT_LIVERY.accent);
    },
    setStencil(text) {
      const next = String(text || '07').slice(0, 3);
      if (next === currentStencil) return;
      currentStencil = next;
      const old = numTex;
      numTex = createWingStencilTexture(next);
      numMat.map = numTex;
      numMat.needsUpdate = true;
      old.dispose();
    },
    updatePose(aircraft, dt) {
      const safeDt = Math.min(Math.max(dt || 1 / 60, 0.001), 0.1);
      group.position.set(aircraft.x, aircraft.y, aircraft.z);
      const yawRad = THREE.MathUtils.degToRad(aircraft.yawDeg || 0);
      const pitchRad = THREE.MathUtils.degToRad(aircraft.pitchDeg || 0);
      const rollRad = THREE.MathUtils.degToRad(aircraft.rollDeg || 0);
      // YXZ intrinsic: -yaw (0=North -Z, 90=East +X), +pitch (nose up), -roll (right bank)
      group.rotation.set(pitchRad, -yawRad, -rollRad, 'YXZ');

      // Smooth spinning 3-blade prop + motion-blur disc
      const speedFactor = 0.78 + ((aircraft.speedKmh || 158) / 160) * 0.68;
      propMesh.rotation.z += safeDt * 38.0 * speedFactor;

      // Responsive aerodynamic control surface feedback
      const damp = 1.0 - Math.exp(-10.0 * safeDt);
      const targetRoll = THREE.MathUtils.clamp((aircraft.rollDeg || 0) / 48.0, -1, 1);
      const targetPitch = THREE.MathUtils.clamp((aircraft.pitchDeg || 0) / 28.0, -1, 1);
      smoothRollDeflect += (targetRoll - smoothRollDeflect) * damp;
      smoothPitchDeflect += (targetPitch - smoothPitchDeflect) * damp;

      // Right bank (+roll): left aileron down (+x), right aileron up (-x), rudder slightly right
      leftAileron.rotation.x = smoothRollDeflect * 0.34;
      rightAileron.rotation.x = -smoothRollDeflect * 0.34;
      elevatorMesh.rotation.x = -smoothPitchDeflect * 0.36;
      rudderMesh.rotation.y = -smoothRollDeflect * 0.28;

      // Water-drop belly bay doors smoothly swing open during water release!
      const targetDoor = aircraft.releasing ? 1.0 : 0.0;
      bayDoorOpen += (targetDoor - bayDoorOpen) * (1.0 - Math.exp(-14.0 * safeDt));
      leftBayDoor.rotation.z = -bayDoorOpen * 0.92;
      rightBayDoor.rotation.z = +bayDoorOpen * 0.92;

      // Anti-collision dorsal red strobe pulse
      beaconPhase += safeDt * 4.2;
      const pulse = Math.pow(0.5 + 0.5 * Math.sin(beaconPhase), 6.0);
      beaconMat.color.setRGB(0.45 + 0.55 * pulse, 0.08 + 0.20 * pulse, 0.06 + 0.10 * pulse);
    },
    dispose() {
      texHandle.unsubscribe();
      bodyGeo.dispose();
      bodyMat.dispose();
      cockpitInteriorGeo.dispose();
      cockpitInteriorMat.dispose();
      windshieldGeo.dispose();
      windshieldMat.dispose();
      stencilGeo.dispose();
      efMat.dispose();
      efTex.dispose();
      numMat.dispose();
      numTex.dispose();
      aileronGeo.dispose();
      elevatorGeo.dispose();
      rudderGeo.dispose();
      bayDoorGeo.dispose();
      leftBayDoor.geometry.dispose();
      rightBayDoor.geometry.dispose();
      ctrlMatPrimary.dispose();
      ctrlMatAccent.dispose();
      ctrlMatBay.dispose();
      navLightGeo.dispose();
      navRedMat.dispose();
      navGreenMat.dispose();
      navWhiteMat.dispose();
      beaconMat.dispose();
      propAsm.dispose();
    },
  };
}

// ===========================================================================
// REMOTE PLANE FLEET (up to 99 sculpted weathered aircraft in 2 draw calls!)
// ===========================================================================

const REMOTE_BODY_VERTEX_SHADER = /* glsl */ `
#include <fog_pars_vertex>

attribute float aPartRole;
attribute float aAo;
attribute vec3 aPrimary;
attribute vec3 aShaded;
attribute vec3 aAccent;
attribute vec3 aStripe;
attribute vec3 aPontoon;
attribute float aAlpha;

varying vec3 vColor;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying float vAlpha;
varying float vIsGlass;

void main() {
  vAlpha = aAlpha;
  vUv = uv;
  vIsGlass = step(5.5, aPartRole);

  // Select per-instance livery color by vertex part role (0..6)
  vec3 c = aPrimary;
  if (aPartRole > 0.5 && aPartRole < 1.5) c = aShaded;
  else if (aPartRole >= 1.5 && aPartRole < 2.5) c = aAccent;
  else if (aPartRole >= 2.5 && aPartRole < 3.5) c = aStripe;
  else if (aPartRole >= 3.5 && aPartRole < 4.5) c = aPontoon;
  else if (aPartRole >= 4.5 && aPartRole < 5.5) c = vec3(0.024, 0.028, 0.033); // Matte charcoal
  else if (aPartRole >= 5.5) c = vec3(0.015, 0.036, 0.056);                    // Tinted cockpit glass
  vColor = c * aAo;

  vec4 localPos = instanceMatrix * vec4(position, 1.0);
  vec4 worldPosition = modelMatrix * localPos;
  vWorldPos = worldPosition.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const REMOTE_BODY_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

#include <fog_pars_fragment>

uniform sampler2D uAlbedoMap;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;

varying vec3 vColor;
varying vec2 vUv;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;
varying float vAlpha;
varying float vIsGlass;

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
  vec3 sunDir = normalize(uSunDir);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // Sample matte weathered aluminum panel skin (neutral light base preserves livery hues)
  vec3 texCol = texture2D(uAlbedoMap, vUv).rgb;
  vec3 surfaceTex = mix(texCol, vec3(1.0), vIsGlass * 0.85);

  // Soft matte wrapped diffuse + twilight hemisphere bounce (anti-plastic, zero harsh glare)
  float ndl = max(dot(n, sunDir), 0.0);
  float wrapNdl = clamp((dot(n, sunDir) + 0.18) / 1.18, 0.0, 1.0);
  vec3 hemi = mix(uHemiGround, uHemiSky, n.y * 0.5 + 0.5);
  vec3 light = uSunColor * (mix(ndl, wrapNdl, 0.35) * 0.88) + hemi * 0.68;

  // Subtle matte brushed-metal / cockpit-glass grazing sheen
  vec3 halfVec = normalize(sunDir + viewDir);
  float specPow = mix(10.0, 36.0, vIsGlass);
  float specAmt = mix(0.055, 0.24, vIsGlass);
  float spec = pow(max(dot(n, halfVec), 0.0), specPow) * specAmt;

  vec3 finalCol = vColor * surfaceTex * light + uSunColor * spec;
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
 * Instanced fleet renderer for up to 99 remote sculpted weathered aircraft across all 16 LIVERIES
 * with < 15 m camera proximity alpha-fade (1.0 at 15 m -> 0.12 at <= 4 m). Total: 2 draw calls.
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

    // Body InstancedMesh (reuses exact sculpted floatplane geometry!)
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

    this._texHandle = getSharedPlaneTextures((kind, tex) => {
      if (kind === 'albedo' && this._bodyMat) {
        this._bodyMat.uniforms.uAlbedoMap.value = tex;
      }
    });

    const bodyUniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAlbedoMap: { value: this._texHandle.albedo },
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
    this._propGeo = new THREE.PlaneGeometry(2.26, 2.26);
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
    this._propPosLocal = new THREE.Vector3(0, -0.04, -3.50);
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
    if (this._texHandle) this._texHandle.unsubscribe();
    if (this.bodyMesh) this.bodyMesh.dispose();
    if (this.propMesh) this.propMesh.dispose();
    this._bodyGeo.dispose();
    this._bodyMat.dispose();
    this._propGeo.dispose();
    this._propMat.dispose();
    this._propTex.dispose();
  }
}

// Convenient semantic aliases matching documentation references
export const createPlayerPlane = createHeroPlaneMesh;
export function createRemoteFleet(maxInstances = 99) {
  return new RemotePlaneFleet(maxInstances);
}
