// Fixed North-Up 240x150 2D Canvas Tactical Minimap for EMBER FRONT
// Includes live predicted drop footprint, lingering 6.5s Hit/Miss impact ripples,
// and clear wet-firebreak vs active-fire contrast.

import { LIVERIES } from '../config/liveries.js';

const MAP_CSS_W = 240;
const MAP_CSS_H = 150;
const GRID_COLS = 8;
const GRID_ROWS = 5;
const MAX_REMOTE_CHEVRONS = 20;
const IMPACT_DURATION_MS = 6500;
const MAX_IMPACT_MARKERS = 14;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class TacticalMap {
  constructor() {
    this.el = el('section', 'ef-card ef-map-card');
    this.el.setAttribute('aria-label', 'Tactical Map');

    const header = el('div', 'ef-map-header');
    header.appendChild(el('span', null, 'TACTICAL MAP'));
    header.appendChild(el('span', 'ef-map-north', '↑ N'));
    this.el.appendChild(header);

    this._canvas = el('canvas', 'ef-map-canvas');
    this._canvas.width = MAP_CSS_W;
    this._canvas.height = MAP_CSS_H;
    this.el.appendChild(this._canvas);

    const legend = el('div', 'ef-map-legend');
    const items = [
      ['is-water', 'WATER'],
      ['is-fire', 'FIRE'],
      ['is-wet', 'WET'],
      ['is-cabin', 'CABIN'],
    ];
    for (const [cls, label] of items) {
      const item = el('span', 'ef-legend-item');
      item.appendChild(el('span', `ef-legend-swatch ${cls}`));
      item.appendChild(el('span', null, label));
      legend.appendChild(item);
    }
    this.el.appendChild(legend);

    this._ctx = this._canvas.getContext('2d');
    this._dpr = 1;
    this._syncBackingStore();

    // Cached offscreen terrain & fire bitmaps
    this._terrainRef = null;
    this._terrainCanvas = null;
    this._fireCanvas = null;
    this._fireCtx = null;
    this._fireImageData = null;
    this._lastFirePaintMs = 0;

    // Lingering post-drop hit/miss impact markers (~6.5s)
    this._impactMarkers = [];

    // Reusable sort buffer for MP density capping (zero per-frame allocs)
    this._remoteScratch = [];
  }

  /**
   * Records a water drop impact marker that pulses on the Tactical Map for ~6.5 seconds
   * so pilots immediately see where their drop landed relative to the flames as they fly away.
   * @param {number} x World X coordinate
   * @param {number} z World Z coordinate
   * @param {'direct'|'partial'|'miss'|string} outcome
   * @param {number} [cellsExtinguished=0]
   */
  recordDropImpact(x, z, outcome = 'miss', cellsExtinguished = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const norm = String(outcome || 'miss').toLowerCase();
    const kind = norm === 'direct' || norm === 'hit'
      ? 'direct'
      : norm === 'partial'
        ? 'partial'
        : 'miss';

    // Deduplicate identical markers fired back-to-back within 150ms & 2m
    for (let i = this._impactMarkers.length - 1; i >= 0; i--) {
      const m = this._impactMarkers[i];
      if (nowMs - m.createdMs < 150 && m.outcome === kind && Math.hypot(m.x - x, m.z - z) < 2.5) {
        m.cells = Math.max(m.cells, Math.max(0, Math.round(cellsExtinguished || 0)));
        return;
      }
    }

    this._impactMarkers.push({
      x,
      z,
      outcome: kind,
      cells: Math.max(0, Math.round(cellsExtinguished || 0)),
      createdMs: nowMs,
    });
    if (this._impactMarkers.length > MAX_IMPACT_MARKERS) {
      this._impactMarkers.shift();
    }
  }

  _syncBackingStore() {
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    if (dpr === this._dpr && this._canvas.width === Math.round(MAP_CSS_W * dpr)) return;
    this._dpr = dpr;
    this._canvas.width = Math.round(MAP_CSS_W * dpr);
    this._canvas.height = Math.round(MAP_CSS_H * dpr);
  }

  _buildTerrainLayer(terrain) {
    this._terrainRef = terrain;
    this._impactMarkers.length = 0;
    const gs = terrain.gridSize;
    const off = document.createElement('canvas');
    off.width = gs;
    off.height = gs;
    const ctx = off.getContext('2d');
    const img = ctx.createImageData(gs, gs);
    const data = img.data;
    const waterMask = terrain.waterMask;
    const biomeMask = terrain.biomeMask;

    for (let gz = 0; gz < gs; gz++) {
      for (let gx = 0; gx < gs; gx++) {
        const idx = gz * gs + gx;
        const p = idx * 4;
        if (waterMask && waterMask[idx]) {
          const edge =
            (gx > 0 && !waterMask[idx - 1]) ||
            (gx + 1 < gs && !waterMask[idx + 1]) ||
            (gz > 0 && !waterMask[idx - gs]) ||
            (gz + 1 < gs && !waterMask[idx + gs]);
          if (edge) {
            data[p] = 64;
            data[p + 1] = 144;
            data[p + 2] = 166;
            data[p + 3] = 255;
          } else {
            data[p] = 28;
            data[p + 1] = 74;
            data[p + 2] = 94;
            data[p + 3] = 255;
          }
        } else {
          const b = biomeMask ? biomeMask[idx] : 3;
          if (b === 1) {
            data[p] = 46;
            data[p + 1] = 50;
            data[p + 2] = 42;
          } else if (b === 2) {
            data[p] = 52;
            data[p + 1] = 53;
            data[p + 2] = 40;
          } else if (b === 4) {
            data[p] = 42;
            data[p + 1] = 39;
            data[p + 2] = 50;
          } else if (b === 5) {
            data[p] = 56;
            data[p + 1] = 50;
            data[p + 2] = 64;
          } else {
            data[p] = 27;
            data[p + 1] = 44;
            data[p + 2] = 38;
          }
          data[p + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this._terrainCanvas = off;

    const fireOff = document.createElement('canvas');
    fireOff.width = gs;
    fireOff.height = gs;
    const fCtx = fireOff.getContext('2d');
    this._fireCanvas = fireOff;
    this._fireCtx = fCtx;
    this._fireImageData = fCtx.createImageData(gs, gs);
    this._lastFirePaintMs = 0;
  }

  _updateFireBitmap(cells, gs, nowMs) {
    if (!cells || !this._fireImageData || !this._fireCtx) return;
    if (nowMs - this._lastFirePaintMs < 65) return;
    this._lastFirePaintMs = nowMs;

    const data = this._fireImageData.data;
    const len = gs * gs;
    const pulse = (Math.sin(nowMs * 0.012) * 0.5 + 0.5) > 0.35;

    for (let i = 0; i < len; i++) {
      const s = cells[i];
      const p = i * 4;
      if (s === 0) {
        data[p + 3] = 0;
      } else if (s >= 1 && s <= 12) {
        if (s >= 10) {
          // Hot core incandescent yellow-white
          data[p] = 255;
          data[p + 1] = 232;
          data[p + 2] = 112;
          data[p + 3] = 255;
        } else if (s >= 5) {
          // Bright wildfire orange
          data[p] = 255;
          data[p + 1] = 114;
          data[p + 2] = 14;
          data[p + 3] = 246;
        } else {
          // Active crimson-orange edge
          data[p] = 230;
          data[p + 1] = 68;
          data[p + 2] = 36;
          data[p + 3] = 228;
        }
      } else if (s === 13) {
        // Cool dark-cyan wet firebreak (unmistakably distinct from active fire & deep lakes)
        data[p] = 32;
        data[p + 1] = 206;
        data[p + 2] = 224;
        data[p + 3] = 215;
      } else if (s === 14) {
        // Charred dark ash
        data[p] = 16;
        data[p + 1] = 14;
        data[p + 2] = 15;
        data[p + 3] = 160;
      } else if (s === 15) {
        // Ember-spot warning
        data[p] = 255;
        data[p + 1] = 204;
        data[p + 2] = 72;
        data[p + 3] = pulse ? 245 : 100;
      } else {
        data[p + 3] = 0;
      }
    }
    this._fireCtx.putImageData(this._fireImageData, 0, 0);
  }

  _drawDropFootprint(ctx, aircraft, dropPreview, halfWorld, invWorld, w, h, nowMs) {
    if (!aircraft || aircraft.autopilot || aircraft.crashed) return;
    if ((aircraft.tankPct ?? 0) <= 0.25 || !dropPreview) return;

    const ixWorld = Number.isFinite(dropPreview.impactX) ? dropPreview.impactX : dropPreview.x;
    const izWorld = Number.isFinite(dropPreview.impactZ) ? dropPreview.impactZ : dropPreview.z;
    if (!Number.isFinite(ixWorld) || !Number.isFinite(izWorld)) return;

    const px = (aircraft.x + halfWorld) * invWorld * w;
    const py = (aircraft.z + halfWorld) * invWorld * h;
    const ix = (ixWorld + halfWorld) * invWorld * w;
    const iy = (izWorld + halfWorld) * invWorld * h;

    const onTarget = Boolean(dropPreview.onTarget || (dropPreview.fireCellsInTarget > 0));
    const nearDist = Number.isFinite(dropPreview.nearFireDistM) ? dropPreview.nearFireDistM : Infinity;
    const isNear = !onTarget && nearDist < 80;
    const agl = Number.isFinite(aircraft.agl) ? aircraft.agl : 36;
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
    const isTooHigh = altZone === 'too_high' && (onTarget || nearDist < 135);
    const isLowDanger = altZone === 'too_low' && (onTarget || nearDist < 90);

    const radiusM = Math.max(14, Math.min(88, dropPreview.radiusM ?? dropPreview.radius ?? 28));
    const rx = Math.max(4.5, radiusM * invWorld * w);
    const ry = Math.max(4.5, radiusM * invWorld * h);
    const pulse = 0.5 + 0.5 * Math.sin(nowMs * 0.015);

    const strokeCol = isLowDanger
      ? '#ff4d45'
      : isTooHigh
        ? '#f6b73c'
        : onTarget
          ? '#38f28b'
          : isNear
            ? '#f6b73c'
            : '#66d9ff';
    const fillCol = isLowDanger
      ? 'rgba(255, 77, 69, 0.22)'
      : isTooHigh
        ? 'rgba(246, 183, 60, 0.12)'
        : onTarget
          ? `rgba(56, 242, 139, ${0.18 + pulse * 0.14})`
          : isNear
            ? 'rgba(246, 183, 60, 0.16)'
            : 'rgba(102, 217, 255, 0.13)';

    ctx.save();

    // Subtle aiming line from aircraft nose to predicted drop impact
    ctx.strokeStyle = isTooHigh
      ? 'rgba(246, 183, 60, 0.36)'
      : onTarget
        ? 'rgba(56, 242, 139, 0.45)'
        : 'rgba(102, 217, 255, 0.30)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2.5, 2.5]);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(ix, iy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Drop corridor strip when start/end provided
    if (
      Number.isFinite(dropPreview.corridorStartX) &&
      Number.isFinite(dropPreview.corridorEndX)
    ) {
      const sx = (dropPreview.corridorStartX + halfWorld) * invWorld * w;
      const sy = (dropPreview.corridorStartZ + halfWorld) * invWorld * h;
      const ex = (dropPreview.corridorEndX + halfWorld) * invWorld * w;
      const ey = (dropPreview.corridorEndZ + halfWorld) * invWorld * h;
      if (Math.hypot(ex - sx, ey - sy) > 2.5) {
        ctx.strokeStyle = isTooHigh
          ? 'rgba(246, 183, 60, 0.24)'
          : onTarget
            ? 'rgba(56, 242, 139, 0.38)'
            : 'rgba(102, 217, 255, 0.28)';
        ctx.lineWidth = Math.max(3, (rx + ry) * 0.55);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    }

    // Main target footprint ellipse (dashed amber mist ring when TOO HIGH!)
    const pulseScale = onTarget && !isTooHigh ? (1.0 + pulse * 0.14) : 1.0;
    ctx.fillStyle = fillCol;
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = onTarget && !isTooHigh ? 1.8 : 1.25;
    if (isTooHigh) ctx.setLineDash([3, 2.5]);
    ctx.beginPath();
    ctx.ellipse(ix, iy, rx * pulseScale, ry * pulseScale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    // Crisp center pip
    ctx.fillStyle = strokeCol;
    ctx.beginPath();
    ctx.arc(ix, iy, onTarget ? 1.8 : 1.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawImpactMarkers(ctx, halfWorld, invWorld, w, h, nowMs) {
    if (this._impactMarkers.length === 0) return;

    let writeIdx = 0;
    for (let i = 0; i < this._impactMarkers.length; i++) {
      const m = this._impactMarkers[i];
      const ageMs = nowMs - m.createdMs;
      if (ageMs >= IMPACT_DURATION_MS) continue;
      this._impactMarkers[writeIdx++] = m;

      const t = ageMs / IMPACT_DURATION_MS;
      const fade = t < 0.72 ? 1.0 : Math.max(0, (1.0 - t) / 0.28);
      const wave = (ageMs % 1300) / 1300;
      const waveFade = (1.0 - wave) * fade;

      const mx = (m.x + halfWorld) * invWorld * w;
      const my = (m.z + halfWorld) * invWorld * h;

      ctx.save();
      if (m.outcome === 'direct') {
        // Expanding bright emerald-cyan pulse ring
        ctx.strokeStyle = `rgba(56, 242, 139, ${(0.92 * waveFade).toFixed(3)})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(mx, my, 4.0 + wave * 13.0, 0, Math.PI * 2);
        ctx.stroke();

        // Crisp steady glowing halo + center dot
        ctx.strokeStyle = `rgba(102, 247, 255, ${(0.80 * fade).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(mx, my, 5.2, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = `rgba(220, 255, 240, ${(0.98 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(mx, my, 2.4, 0, Math.PI * 2);
        ctx.fill();

        // Brief numeric knock badge (-N) for first 3.2s
        if (m.cells > 0 && ageMs < 3200) {
          const lblAlpha = ageMs < 2400 ? 1.0 : (3200 - ageMs) / 800;
          ctx.font = '700 9px monospace';
          ctx.fillStyle = `rgba(56, 242, 139, ${lblAlpha.toFixed(3)})`;
          const tx = Math.min(w - 22, mx + 6);
          const ty = Math.max(10, my - 4);
          ctx.fillText(`-${m.cells}`, tx, ty);
        }
      } else if (m.outcome === 'partial') {
        // Expanding amber pulse ring
        ctx.strokeStyle = `rgba(246, 183, 60, ${(0.88 * waveFade).toFixed(3)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(mx, my, 3.8 + wave * 10.5, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(246, 183, 60, ${(0.75 * fade).toFixed(3)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(mx, my, 4.4, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = `rgba(255, 224, 140, ${(0.95 * fade).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(mx, my, 2.0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Miss: expanding dashed red-orange ring + crisp X at exact miss coordinates
        ctx.strokeStyle = `rgba(255, 92, 60, ${(0.85 * waveFade).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(mx, my, 4.2 + wave * 9.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = `rgba(255, 108, 72, ${(0.96 * fade).toFixed(3)})`;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(mx - 3.6, my - 3.6);
        ctx.lineTo(mx + 3.6, my + 3.6);
        ctx.moveTo(mx + 3.6, my - 3.6);
        ctx.lineTo(mx - 3.6, my + 3.6);
        ctx.stroke();
      }
      ctx.restore();
    }
    this._impactMarkers.length = writeIdx;
  }

  update({ terrain, aircraft, fireSnapshot, remotePlanes, dropPreview }) {
    if (!this._ctx || !terrain) return;
    this._syncBackingStore();

    if (terrain !== this._terrainRef) {
      this._buildTerrainLayer(terrain);
    }

    const nowMs = performance.now();
    const ctx = this._ctx;
    const dpr = this._dpr;
    const w = MAP_CSS_W;
    const h = MAP_CSS_H;
    const halfWorld = terrain.halfWorld || (terrain.worldSize ? terrain.worldSize * 0.5 : 1024);
    const worldSize = terrain.worldSize || halfWorld * 2;
    const invWorld = 1 / worldSize;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Pre-rendered terrain & lakes
    ctx.imageSmoothingEnabled = false;
    if (this._terrainCanvas) {
      ctx.drawImage(this._terrainCanvas, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#142024';
      ctx.fillRect(0, 0, w, h);
    }

    // 2. Live cellular fire + distinct wet-firebreak bitmap
    if (fireSnapshot && fireSnapshot.cells && this._fireCanvas) {
      this._updateFireBitmap(fireSnapshot.cells, terrain.gridSize, nowMs);
      ctx.drawImage(this._fireCanvas, 0, 0, w, h);
    }

    // 3. 8x5 Tactical Grid
    ctx.strokeStyle = 'rgba(197, 212, 186, 0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < GRID_COLS; c++) {
      const gx = Math.round((c / GRID_COLS) * w) + 0.5;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
    }
    for (let r = 1; r < GRID_ROWS; r++) {
      const gy = Math.round((r / GRID_ROWS) * h) + 0.5;
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
    }
    ctx.stroke();

    // 4. Cabins (cream intact, pulsing red at risk, dim gray destroyed)
    const cabins = terrain.cabins;
    const cabinHp = fireSnapshot ? fireSnapshot.cabinHp : null;
    const cabinAtRisk = fireSnapshot ? fireSnapshot.cabinAtRisk : null;
    const riskPulse = 0.5 + 0.5 * Math.sin(nowMs * 0.01);

    if (cabins && cabins.length > 0) {
      for (let i = 0; i < cabins.length; i++) {
        const cb = cabins[i];
        const cx = (cb.x + halfWorld) * invWorld * w;
        const cy = (cb.z + halfWorld) * invWorld * h;
        const hp = cabinHp ? cabinHp[i] : 100;
        const atRisk = cabinAtRisk ? cabinAtRisk[i] === 1 : false;

        if (hp <= 0) {
          ctx.fillStyle = '#5a6269';
          ctx.fillRect(cx - 2, cy - 2, 4, 4);
        } else if (atRisk) {
          ctx.strokeStyle = `rgba(255, 72, 64, ${0.45 + 0.5 * riskPulse})`;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(cx, cy, 4.5 + riskPulse * 2.5, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = '#ff443a';
          ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
          ctx.strokeStyle = '#120808';
          ctx.lineWidth = 1;
          ctx.strokeRect(cx - 2.5, cy - 2.5, 5, 5);
        } else {
          ctx.fillStyle = '#0e1417';
          ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
          ctx.fillStyle = '#f2ead8';
          ctx.fillRect(cx - 1.8, cy - 1.8, 3.6, 3.6);
        }
      }
    }

    // 5. Lingering 6.5s Hit / Partial / Miss impact markers
    this._drawImpactMarkers(ctx, halfWorld, invWorld, w, h, nowMs);

    // 6. Live predicted drop footprint (whenever manual & tank > 0)
    this._drawDropFootprint(ctx, aircraft, dropPreview, halfWorld, invWorld, w, h, nowMs);

    // 7. Remote multiplayer pilots with density capping
    if (remotePlanes && remotePlanes.length > 0) {
      const lx = aircraft ? aircraft.x : 0;
      const lz = aircraft ? aircraft.z : 0;
      const scratch = this._remoteScratch;
      scratch.length = 0;

      for (let i = 0; i < remotePlanes.length; i++) {
        const rp = remotePlanes[i];
        const dx = rp.x - lx;
        const dz = rp.z - lz;
        const distSq = dx * dx + dz * dz;
        const activePriority = rp.releasing || rp.scooping ? 0 : 1;
        scratch.push({ rp, distSq, activePriority });
      }

      scratch.sort((a, b) => {
        if (a.activePriority !== b.activePriority) {
          return a.activePriority - b.activePriority;
        }
        return a.distSq - b.distSq;
      });

      const chevronCount = Math.min(MAX_REMOTE_CHEVRONS, scratch.length);

      for (let i = chevronCount; i < scratch.length; i++) {
        const rp = scratch[i].rp;
        const rx = (rp.x + halfWorld) * invWorld * w;
        const ry = (rp.z + halfWorld) * invWorld * h;
        const liv = LIVERIES[rp.colorIdx % LIVERIES.length] || LIVERIES[0];
        ctx.fillStyle = liv ? liv.hudColor : '#f8ce64';
        ctx.fillRect(Math.round(rx) - 1, Math.round(ry) - 1, 2, 2);
      }

      for (let i = chevronCount - 1; i >= 0; i--) {
        const rp = scratch[i].rp;
        const rx = (rp.x + halfWorld) * invWorld * w;
        const ry = (rp.z + halfWorld) * invWorld * h;
        const liv = LIVERIES[rp.colorIdx % LIVERIES.length] || LIVERIES[0];
        const color = liv ? liv.hudColor : '#f8ce64';
        const rad = ((rp.yawDeg || 0) * Math.PI) / 180;

        ctx.save();
        ctx.translate(rx, ry);
        ctx.rotate(rad);

        if (rp.releasing || rp.scooping) {
          ctx.fillStyle = 'rgba(92, 225, 230, 0.35)';
          ctx.beginPath();
          ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(0, -4.5);
        ctx.lineTo(3.2, 3.2);
        ctx.lineTo(0, 1.3);
        ctx.lineTo(-3.2, 3.2);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = 'rgba(10, 16, 20, 0.9)';
        ctx.stroke();
        ctx.restore();
      }
    }

    // 8. Local aircraft white arrowhead (or crash X if crashed)
    if (aircraft) {
      const px = (aircraft.x + halfWorld) * invWorld * w;
      const py = (aircraft.z + halfWorld) * invWorld * h;

      ctx.save();
      ctx.translate(px, py);

      if (aircraft.crashed) {
        ctx.strokeStyle = '#ff4d45';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-4, -4);
        ctx.lineTo(4, 4);
        ctx.moveTo(4, -4);
        ctx.lineTo(-4, 4);
        ctx.stroke();
      } else {
        const rad = ((aircraft.yawDeg || 0) * Math.PI) / 180;
        ctx.rotate(rad);

        if (aircraft.scooping || aircraft.releasing) {
          ctx.strokeStyle = aircraft.scooping
            ? 'rgba(92, 225, 230, 0.85)'
            : 'rgba(216, 230, 230, 0.85)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.moveTo(0, -6.5);
        ctx.lineTo(4.8, 4.8);
        ctx.lineTo(0, 2.2);
        ctx.lineTo(-4.8, 4.8);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0b1216';
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.restore();
  }

  dispose() {
    this._terrainRef = null;
    this._terrainCanvas = null;
    this._fireCanvas = null;
    this._fireCtx = null;
    this._fireImageData = null;
    this._impactMarkers.length = 0;
    this._remoteScratch.length = 0;
  }
}
