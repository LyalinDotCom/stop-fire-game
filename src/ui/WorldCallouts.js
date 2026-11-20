// Native-resolution 3D-projected floating tactical callout pins for EMBER FRONT

function createPin(className, glyph, label) {
  const root = document.createElement('div');
  root.className = `ef-callout ${className}`;

  const tag = document.createElement('div');
  tag.className = 'ef-callout-tag';

  const glyphEl = document.createElement('span');
  glyphEl.textContent = glyph;

  const textEl = document.createElement('span');
  textEl.textContent = label;

  tag.appendChild(glyphEl);
  tag.appendChild(textEl);

  const stem = document.createElement('div');
  stem.className = 'ef-callout-stem';

  const dot = document.createElement('div');
  dot.className = 'ef-callout-dot';

  root.appendChild(tag);
  root.appendChild(stem);
  root.appendChild(dot);

  return { root, glyphEl, textEl, visible: false, isRisk: false };
}

export class WorldCallouts {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'ef-callouts-layer';

    this._scoopPin = createPin('is-scoop', '≈', 'SCOOP ZONE');
    this._firePin = createPin('is-fire', '◇', 'FIRE HEAD');
    this._settlementPin = createPin('is-settlement', '△', 'SETTLEMENT');

    this.el.appendChild(this._scoopPin.root);
    this.el.appendChild(this._firePin.root);
    this.el.appendChild(this._settlementPin.root);
  }

  _positionPin(pin, worldPos, projectFn, viewW, viewH) {
    if (!worldPos || !projectFn) {
      if (pin.visible) {
        pin.root.classList.remove('is-visible');
        pin.visible = false;
      }
      return;
    }

    const proj = projectFn(worldPos);
    if (
      !proj ||
      proj.behind ||
      !proj.visible ||
      !Number.isFinite(proj.x) ||
      !Number.isFinite(proj.y) ||
      proj.x < 0.04 ||
      proj.x > 0.96 ||
      proj.y < 0.07 ||
      proj.y > 0.90
    ) {
      if (pin.visible) {
        pin.root.classList.remove('is-visible');
        pin.visible = false;
      }
      return;
    }

    const px = Math.round(proj.x * viewW);
    const py = Math.round(proj.y * viewH);
    pin.root.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -100%)`;

    if (!pin.visible) {
      pin.root.classList.add('is-visible');
      pin.visible = true;
    }
  }

  _findNearestScoopZone(terrain, aircraft) {
    const zones = terrain && terrain.scoopZones;
    if (!zones || zones.length === 0) return null;
    if (!aircraft || zones.length === 1) {
      const z0 = zones[0];
      return { x: z0.x, y: (terrain.waterLevel ?? 12) + 4, z: z0.z };
    }
    let best = zones[0];
    let bestDistSq = Infinity;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const dx = z.x - aircraft.x;
      const dz = z.z - aircraft.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        best = z;
      }
    }
    return { x: best.x, y: (terrain.waterLevel ?? 12) + 4, z: best.z };
  }

  _resolveSettlementAnchor(terrain, fireSnapshot) {
    if (fireSnapshot && fireSnapshot.atRiskTarget) {
      const t = fireSnapshot.atRiskTarget;
      const y = (terrain && terrain.getHeight ? terrain.getHeight(t.x, t.z) : 20) + 14;
      return { pos: { x: t.x, y, z: t.z }, atRisk: true };
    }

    if (fireSnapshot && fireSnapshot.settlementTarget) {
      const t = fireSnapshot.settlementTarget;
      const y = (terrain && terrain.getHeight ? terrain.getHeight(t.x, t.z) : 20) + 14;
      return { pos: { x: t.x, y, z: t.z }, atRisk: false };
    }

    if (terrain && terrain.settlements && terrain.settlements.length > 0) {
      const s0 = terrain.settlements[0];
      const y = (terrain.getHeight ? terrain.getHeight(s0.x, s0.z) : 20) + 14;
      return { pos: { x: s0.x, y, z: s0.z }, atRisk: false };
    }

    return { pos: null, atRisk: false };
  }

  update({ terrain, aircraft, fireSnapshot, projectFn }) {
    if (typeof window === 'undefined') return;
    const viewW = window.innerWidth || 1280;
    const viewH = window.innerHeight || 720;

    // 1. ≈ SCOOP ZONE
    const scoopPos = this._findNearestScoopZone(terrain, aircraft);
    this._positionPin(this._scoopPin, scoopPos, projectFn, viewW, viewH);

    // 2. ◇ FIRE HEAD
    let firePos = null;
    if (fireSnapshot && fireSnapshot.fireHead && (fireSnapshot.burningCount === undefined || fireSnapshot.burningCount > 0)) {
      const fh = fireSnapshot.fireHead;
      const fy = (terrain && terrain.getHeight ? terrain.getHeight(fh.x, fh.z) : 20) + 18;
      firePos = { x: fh.x, y: fy, z: fh.z };
    }
    this._positionPin(this._firePin, firePos, projectFn, viewW, viewH);

    // 3. △ SETTLEMENT -> dynamically upgrades to pulsing △ CABIN AT RISK
    const { pos: settlementPos, atRisk } = this._resolveSettlementAnchor(terrain, fireSnapshot);
    if (atRisk !== this._settlementPin.isRisk) {
      this._settlementPin.isRisk = atRisk;
      this._settlementPin.root.classList.toggle('is-risk', atRisk);
      this._settlementPin.root.classList.toggle('is-settlement', !atRisk);
      this._settlementPin.textEl.textContent = atRisk ? 'CABIN AT RISK' : 'SETTLEMENT';
    }
    this._positionPin(this._settlementPin, settlementPos, projectFn, viewW, viewH);
  }

  dispose() {
    this.el.remove();
  }
}
