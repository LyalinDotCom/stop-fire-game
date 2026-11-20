// Fixed North-Up 240x150 2D Canvas Tactical Minimap for EMBER FRONT

import { LIVERIES } from '../config/liveries.js';

const MAP_CSS_W = 240;
const MAP_CSS_H = 150;
const GRID_COLS = 8;
const GRID_ROWS = 5;
const MAX_REMOTE_CHEVRONS = 20;

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

    // Reusable sort buffer for MP density capping (zero per-frame allocs)
    this._remoteScratch = [];
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
          // Check shoreline adjacency for subtle crisp coastal highlight
          const edge =
            (gx > 0 && !waterMask[idx - 1]) ||
            (gx + 1 < gs && !waterMask[idx + 1]) ||
            (gz > 0 && !waterMask[idx - gs]) ||
            (gz + 1 < gs && !waterMask[idx + gs]);
          if (edge) {
            data[p] = 66;
            data[p + 1] = 148;
            data[p + 2] = 166;
            data[p + 3] = 255;
          } else {
            data[p] = 35;
            data[p + 1] = 88;
            data[p + 2] = 104;
            data[p + 3] = 255;
          }
        } else {
          const b = biomeMask ? biomeMask[idx] : 3;
          if (b === 1) {
            // Shore
            data[p] = 48;
            data[p + 1] = 52;
            data[p + 2] = 44;
          } else if (b === 2) {
            // Meadow
            data[p] = 54;
            data[p + 1] = 55;
            data[p + 2] = 42;
          } else if (b === 4) {
            // Ridge
            data[p] = 44;
            data[p + 1] = 41;
            data[p + 2] = 52;
          } else if (b === 5) {
            // Peak
            data[p] = 58;
            data[p + 1] = 52;
            data[p + 2] = 66;
          } else {
            // Forest
            data[p] = 29;
            data[p + 1] = 46;
            data[p + 2] = 40;
          }
          data[p + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this._terrainCanvas = off;

    // Prepare matching fire overlay canvas
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
          // Hot core yellow-orange
          data[p] = 255;
          data[p + 1] = 216;
          data[p + 2] = 88;
          data[p + 3] = 245;
        } else if (s >= 5) {
          // Bright wildfire orange
          data[p] = 255;
          data[p + 1] = 111;
          data[p + 2] = 0;
          data[p + 3] = 235;
        } else {
          // Low crimson-orange
          data[p] = 224;
          data[p + 1] = 74;
          data[p + 2] = 42;
          data[p + 3] = 220;
        }
      } else if (s === 13) {
        // Wet / Steam cooldown
        data[p] = 92;
        data[p + 1] = 225;
        data[p + 2] = 230;
        data[p + 3] = 90;
      } else if (s === 14) {
        // Charred
        data[p] = 16;
        data[p + 1] = 14;
        data[p + 2] = 14;
        data[p + 3] = 145;
      } else if (s === 15) {
        // Ember-spot warning
        data[p] = 255;
        data[p + 1] = 196;
        data[p + 2] = 64;
        data[p + 3] = pulse ? 235 : 95;
      } else {
        data[p + 3] = 0;
      }
    }
    this._fireCtx.putImageData(this._fireImageData, 0, 0);
  }

  update({ terrain, aircraft, fireSnapshot, remotePlanes }) {
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

    // 2. Live cellular fire bitmap
    if (fireSnapshot && fireSnapshot.cells && this._fireCanvas) {
      this._updateFireBitmap(fireSnapshot.cells, terrain.gridSize, nowMs);
      ctx.drawImage(this._fireCanvas, 0, 0, w, h);
    }

    // 3. 8x5 Tactical Grid
    ctx.strokeStyle = 'rgba(197, 212, 186, 0.14)';
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

    // 5. Remote multiplayer pilots with density capping
    // Up to 20 nearest chevrons (prioritizing releasing/scooping), 2x2 dots for remainder
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

      // Draw remaining remote pilots first as crisp 2x2 livery dots
      for (let i = chevronCount; i < scratch.length; i++) {
        const rp = scratch[i].rp;
        const rx = (rp.x + halfWorld) * invWorld * w;
        const ry = (rp.z + halfWorld) * invWorld * h;
        const liv = LIVERIES[rp.colorIdx % LIVERIES.length] || LIVERIES[0];
        ctx.fillStyle = liv ? liv.hudColor : '#f8ce64';
        ctx.fillRect(Math.round(rx) - 1, Math.round(ry) - 1, 2, 2);
      }

      // Draw up to 20 prioritized/nearest remote pilots as directional livery chevrons
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

    // 6. Local aircraft white arrowhead with crisp dark outline
    if (aircraft) {
      const px = (aircraft.x + halfWorld) * invWorld * w;
      const py = (aircraft.z + halfWorld) * invWorld * h;
      const rad = ((aircraft.yawDeg || 0) * Math.PI) / 180;

      ctx.save();
      ctx.translate(px, py);
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
    this._remoteScratch.length = 0;
  }
}
