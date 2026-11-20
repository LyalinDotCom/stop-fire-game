// Responsive Multi-Touch Aviation Flight Controls for EMBER FRONT
// Strictly uses DOM APIs and SVG createElementNS (zero innerHTML, zero emoji/text clutter).
// Supports Portrait & Landscape mobile ergonomics, independent multi-touch pointerId tracking,
// quadratic yoke curve with 0.08 deadzone, live circular SVG tank gauge, and DEMO FLIGHT tap-takeover.

const SVG_NS = 'http://www.w3.org/2000/svg';
const STICK_DEADZONE = 0.08;
const STICK_TICK_THRESHOLD = 0.22;
const DROP_RING_RADIUS = 37;
const DROP_RING_CIRCUMFERENCE = 2 * Math.PI * DROP_RING_RADIUS;

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function detectTouchDevice() {
  if (typeof window === 'undefined') return false;
  return Boolean(
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  );
}

function hasTouchQueryParam() {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const val = params.get('touch');
    return val === '1' || val === 'true';
  } catch {
    return false;
  }
}

function buildGimbalSvg() {
  const svg = svgEl('svg', {
    viewBox: '0 0 128 128',
    class: 'ef-touch-gimbal-svg',
    'aria-hidden': 'true',
  });

  // Outer fine calibration dashed ring & inner bezel
  svg.appendChild(
    svgEl('circle', {
      cx: 64,
      cy: 64,
      r: 60,
      class: 'ef-gimbal-outer-ring',
    })
  );
  svg.appendChild(
    svgEl('circle', {
      cx: 64,
      cy: 64,
      r: 52,
      class: 'ef-gimbal-inner-ring',
    })
  );

  // Subtle deadzone reference ring
  svg.appendChild(
    svgEl('circle', {
      cx: 64,
      cy: 64,
      r: 14,
      class: 'ef-gimbal-deadzone-ring',
    })
  );

  // Broken attitude crosshair axes
  const axisLines = [
    [64, 24, 64, 38],
    [64, 90, 64, 104],
    [24, 64, 38, 64],
    [90, 64, 104, 64],
  ];
  for (let i = 0; i < axisLines.length; i++) {
    const [x1, y1, x2, y2] = axisLines[i];
    svg.appendChild(svgEl('line', { x1, y1, x2, y2, class: 'ef-gimbal-axis' }));
  }

  // 45-degree diagonal tactical corner ticks
  const diagAngles = [45, 135, 225, 315];
  for (let i = 0; i < diagAngles.length; i++) {
    const rad = (diagAngles[i] * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    svg.appendChild(
      svgEl('line', {
        x1: (64 + c * 49).toFixed(1),
        y1: (64 + s * 49).toFixed(1),
        x2: (64 + c * 55).toFixed(1),
        y2: (64 + s * 55).toFixed(1),
        class: 'ef-gimbal-diag-tick',
      })
    );
  }

  // Crisp directional attitude triangles (Up / Down / Left / Right)
  const tickUp = svgEl('polygon', {
    points: '64,6 69.5,14.5 58.5,14.5',
    class: 'ef-gimbal-dir-tick ef-tick-up',
  });
  const tickDown = svgEl('polygon', {
    points: '64,122 69.5,113.5 58.5,113.5',
    class: 'ef-gimbal-dir-tick ef-tick-down',
  });
  const tickLeft = svgEl('polygon', {
    points: '6,64 14.5,58.5 14.5,69.5',
    class: 'ef-gimbal-dir-tick ef-tick-left',
  });
  const tickRight = svgEl('polygon', {
    points: '122,64 113.5,58.5 113.5,69.5',
    class: 'ef-gimbal-dir-tick ef-tick-right',
  });

  svg.appendChild(tickUp);
  svg.appendChild(tickDown);
  svg.appendChild(tickLeft);
  svg.appendChild(tickRight);

  return { svg, tickUp, tickDown, tickLeft, tickRight };
}

function buildPuckCrosshairSvg() {
  const svg = svgEl('svg', {
    viewBox: '0 0 36 36',
    class: 'ef-touch-puck-svg',
    'aria-hidden': 'true',
  });

  // Aircraft attitude horizon wings (HUD flight director symbol)
  svg.appendChild(
    svgEl('path', {
      d: 'M4.5 18 H13.2 L15.4 20.8',
      class: 'ef-puck-wing',
    })
  );
  svg.appendChild(
    svgEl('path', {
      d: 'M31.5 18 H22.8 L20.6 20.8',
      class: 'ef-puck-wing',
    })
  );
  // Subtle dorsal vertical pitch tick
  svg.appendChild(
    svgEl('line', {
      x1: 18,
      y1: 10.5,
      x2: 18,
      y2: 13.8,
      class: 'ef-puck-fin',
    })
  );
  // Center boresight dot
  svg.appendChild(
    svgEl('circle', {
      cx: 18,
      cy: 18,
      r: 2.1,
      class: 'ef-puck-dot',
    })
  );

  return svg;
}

function buildDropRingSvg() {
  const svg = svgEl('svg', {
    viewBox: '0 0 84 84',
    class: 'ef-drop-ring-svg',
    'aria-hidden': 'true',
  });

  // Target-lock corner micro-ticks
  const lockAngles = [45, 135, 225, 315];
  for (let i = 0; i < lockAngles.length; i++) {
    const rad = (lockAngles[i] * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    svg.appendChild(
      svgEl('line', {
        x1: (42 + c * 39.2).toFixed(1),
        y1: (42 + s * 39.2).toFixed(1),
        x2: (42 + c * 41.8).toFixed(1),
        y2: (42 + s * 41.8).toFixed(1),
        class: 'ef-drop-lock-tick',
      })
    );
  }

  // Circular tank track
  svg.appendChild(
    svgEl('circle', {
      cx: 42,
      cy: 42,
      r: DROP_RING_RADIUS,
      class: 'ef-drop-ring-track',
    })
  );

  // Live tank fill arc (rotates -90deg so 100% fills clockwise from top)
  const progressCircle = svgEl('circle', {
    cx: 42,
    cy: 42,
    r: DROP_RING_RADIUS,
    class: 'ef-drop-ring-fill',
    transform: 'rotate(-90 42 42)',
    'stroke-dasharray': DROP_RING_CIRCUMFERENCE.toFixed(2),
    'stroke-dashoffset': '0',
  });
  svg.appendChild(progressCircle);

  return { svg, progressCircle };
}

function buildDropIconSvg() {
  const svg = svgEl('svg', {
    viewBox: '0 0 36 36',
    class: 'ef-drop-icon-svg',
    'aria-hidden': 'true',
  });

  // Aerodynamic primary water droplet
  svg.appendChild(
    svgEl('path', {
      d: 'M18 4.2 C18 4.2 10.6 13.8 10.6 20.1 C10.6 24.3 13.9 27.6 18 27.6 C22.1 27.6 25.4 24.3 25.4 20.1 C25.4 13.8 18 4.2 18 4.2 Z',
      class: 'ef-drop-droplet',
    })
  );
  // Crisp interior specular sheen arc
  svg.appendChild(
    svgEl('path', {
      d: 'M14.4 19.4 C14.4 21.8 15.6 23.6 17.5 24.3',
      class: 'ef-drop-sheen',
    })
  );
  // Aerial bomber water cascade ribbons (flanking & bottom splash arc)
  svg.appendChild(
    svgEl('path', {
      d: 'M7.4 22.2 C7.0 25.0 8.2 27.7 10.6 29.5',
      class: 'ef-drop-cascade',
    })
  );
  svg.appendChild(
    svgEl('path', {
      d: 'M28.6 22.2 C29.0 25.0 27.8 27.7 25.4 29.5',
      class: 'ef-drop-cascade',
    })
  );
  svg.appendChild(
    svgEl('path', {
      d: 'M13.6 31.1 Q18 33.0 22.4 31.1',
      class: 'ef-drop-cascade',
    })
  );

  return svg;
}

function buildThrottleChevronSvg(direction) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    class: 'ef-throttle-icon-svg',
    'aria-hidden': 'true',
  });

  if (direction > 0) {
    // Double chevron UP (increase thrust)
    svg.appendChild(
      svgEl('polyline', {
        points: '6.5,13.5 12,8 17.5,13.5',
        class: 'ef-chevron-primary',
      })
    );
    svg.appendChild(
      svgEl('polyline', {
        points: '6.5,18.2 12,12.7 17.5,18.2',
        class: 'ef-chevron-secondary',
      })
    );
  } else {
    // Double chevron DOWN (reduce thrust / scoop speed)
    svg.appendChild(
      svgEl('polyline', {
        points: '6.5,5.8 12,11.3 17.5,5.8',
        class: 'ef-chevron-secondary',
      })
    );
    svg.appendChild(
      svgEl('polyline', {
        points: '6.5,10.5 12,16 17.5,10.5',
        class: 'ef-chevron-primary',
      })
    );
  }

  return svg;
}

function isIgnoredTakeoverTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(
    target.closest(
      '.ef-touch-controls, .ef-topright-cluster, .ef-drawer, .ef-drawer-backdrop, .ef-overlay, .ef-overlay-card, .ef-launch-overlay, button, input, select, textarea, label, a'
    )
  );
}

export class TouchControls {
  /**
   * @param {HTMLElement} containerEl - Mount container (recommended: #hud-root)
   * @param {import('../input/InputManager.js').InputManager} inputManager
   * @param {object} [opts]
   * @param {() => void} [opts.onInteract] - Called on touch interaction (e.g. to unlock Web Audio)
   */
  constructor(containerEl, inputManager, { onInteract } = {}) {
    this._container =
      containerEl ||
      (typeof document !== 'undefined' &&
        (document.getElementById('hud-root') || document.body)) ||
      null;
    this._inputManager = inputManager || null;
    this._onInteract = typeof onInteract === 'function' ? onInteract : null;

    this._detectedTouch = detectTouchDevice();
    this._queryForced = hasTouchQueryParam();
    this._forcedVisible = null; // null = auto, true = force on, false = force off
    this._visible = true;
    this._touchMode = false;

    // Live flight state synced via update()
    this._tankPct = 100;
    this._onTarget = false;
    this._scooping = false;
    this._releasing = false;
    this._demoFlight = true;
    this._crashed = false;
    this._lastRingOffsetStr = '';

    // Independent multi-touch pointer tracking
    this._stickPointerId = null;
    this._stickCenterX = 0;
    this._stickCenterY = 0;
    this._stickMaxRadius = 40;

    this._dropPointerId = null;

    this._throttlePointerId = null;
    this._throttleDir = 0;

    this._rippleTimers = new Set();
    this._disposed = false;

    this._buildDom();
    this._bindEvents();
    this._syncModeAndVisibility();
  }

  get el() {
    return this._root;
  }

  isTouchMode() {
    return this._touchMode;
  }

  /**
   * Force touch mode visible (true), disabled (false), or revert to auto-detect (null).
   */
  setForcedVisible(bool) {
    if (bool === null || bool === undefined) {
      this._forcedVisible = null;
    } else {
      this._forcedVisible = Boolean(bool);
    }
    this._syncModeAndVisibility();
  }

  /**
   * Show or hide the touch control overlay (e.g. during modal overlays/drawers)
   * without changing detected touch mode.
   */
  setVisible(bool) {
    this._visible = Boolean(bool);
    if (!this._visible) {
      this._releaseAllPointers();
    }
    this._syncModeAndVisibility();
  }

  /**
   * Sync live aircraft / drop-lock telemetry into the touch UI each frame.
   */
  update({ tankPct, onTarget, scooping, releasing, demoFlight, crashed } = {}) {
    if (this._disposed) return;

    const pct = Number.isFinite(tankPct) ? clamp(tankPct, 0, 100) : this._tankPct;
    const isCrashed = Boolean(crashed);
    const isScooping = Boolean(scooping);
    const isReleasing = Boolean(releasing);
    const isDemo = Boolean(demoFlight);
    const isOnTarget = Boolean(onTarget) && pct > 0.5 && !isCrashed;
    const isEmpty = pct <= 0.5;

    if (isCrashed && !this._crashed) {
      this._releaseAllPointers();
    }

    this._tankPct = pct;
    this._onTarget = isOnTarget;
    this._scooping = isScooping;
    this._releasing = isReleasing;
    this._demoFlight = isDemo;
    this._crashed = isCrashed;

    // Update circular SVG tank progress ring only when stroke-dashoffset visibly changes
    const offset = DROP_RING_CIRCUMFERENCE * (1 - pct / 100);
    const offsetStr = offset.toFixed(1);
    if (offsetStr !== this._lastRingOffsetStr) {
      this._lastRingOffsetStr = offsetStr;
      this._dropRingFillEl.setAttribute('stroke-dashoffset', offsetStr);
    }

    // Update visual state classes on Drop button & root
    this._dropBtnEl.classList.toggle('is-on-target', isOnTarget);
    this._dropBtnEl.classList.toggle('is-empty', isEmpty);
    this._dropBtnEl.classList.toggle('is-scooping', isScooping);
    this._dropBtnEl.classList.toggle('is-releasing', isReleasing);
    this._dropBtnEl.classList.toggle('is-disabled', isCrashed);

    this._root.classList.toggle('is-demo', isDemo);
    this._root.classList.toggle('is-crashed', isCrashed);
  }

  _buildDom() {
    const root = el('div', 'ef-touch-layer ef-touch-controls ef-hidden');
    root.setAttribute('aria-label', 'Touch Flight Controls');
    root.dataset.touchControls = 'true';

    // 1. Left Thumb — Virtual Flight Yoke (Thumbstick)
    const leftCluster = el('div', 'ef-touch-left');
    const stickZone = el('div', 'ef-touch-stick-zone');
    stickZone.setAttribute('role', 'slider');
    stickZone.setAttribute('aria-label', 'Flight Yoke');
    stickZone.dataset.touchControl = 'yoke';

    const gimbal = buildGimbalSvg();
    this._tickUpEl = gimbal.tickUp;
    this._tickDownEl = gimbal.tickDown;
    this._tickLeftEl = gimbal.tickLeft;
    this._tickRightEl = gimbal.tickRight;
    stickZone.appendChild(gimbal.svg);

    const puck = el('div', 'ef-touch-stick-puck is-springing');
    puck.appendChild(buildPuckCrosshairSvg());
    stickZone.appendChild(puck);

    leftCluster.appendChild(stickZone);
    root.appendChild(leftCluster);

    // 2. Right Thumb — Throttle Rocker Capsule + Primary Water Drop Button
    const rightCluster = el('div', 'ef-touch-right');

    // Compact vertical Throttle Rocker (+ / -)
    const throttleCapsule = el('div', 'ef-touch-throttle');
    throttleCapsule.setAttribute('role', 'group');
    throttleCapsule.setAttribute('aria-label', 'Throttle');
    throttleCapsule.dataset.touchControl = 'throttle';

    const throttleUpBtn = el('button', 'ef-touch-throttle-btn is-up');
    throttleUpBtn.type = 'button';
    throttleUpBtn.setAttribute('aria-label', 'Increase Throttle');
    throttleUpBtn.dataset.touchControl = 'throttle-up';
    throttleUpBtn.appendChild(buildThrottleChevronSvg(+1));

    const throttleDivider = el('div', 'ef-touch-throttle-divider');

    const throttleDownBtn = el('button', 'ef-touch-throttle-btn is-down');
    throttleDownBtn.type = 'button';
    throttleDownBtn.setAttribute('aria-label', 'Decrease Throttle');
    throttleDownBtn.dataset.touchControl = 'throttle-down';
    throttleDownBtn.appendChild(buildThrottleChevronSvg(-1));

    throttleCapsule.appendChild(throttleUpBtn);
    throttleCapsule.appendChild(throttleDivider);
    throttleCapsule.appendChild(throttleDownBtn);
    rightCluster.appendChild(throttleCapsule);

    // Primary Water Drop Button with live circular SVG tank gauge
    const dropBtn = el('button', 'ef-touch-drop-btn');
    dropBtn.type = 'button';
    dropBtn.setAttribute('aria-label', 'Drop Water');
    dropBtn.dataset.touchControl = 'drop';

    const dropRing = buildDropRingSvg();
    this._dropRingFillEl = dropRing.progressCircle;
    dropBtn.appendChild(dropRing.svg);
    dropBtn.appendChild(buildDropIconSvg());
    rightCluster.appendChild(dropBtn);

    root.appendChild(rightCluster);

    this._root = root;
    this._stickZoneEl = stickZone;
    this._stickPuckEl = puck;
    this._throttleCapsuleEl = throttleCapsule;
    this._throttleUpBtnEl = throttleUpBtn;
    this._throttleDownBtnEl = throttleDownBtn;
    this._dropBtnEl = dropBtn;

    if (this._container) {
      this._container.appendChild(root);
    }
  }

  _bindEvents() {
    this._onStickDown = this._handleStickDown.bind(this);
    this._onDropDown = this._handleDropDown.bind(this);
    this._onThrottleUpDown = (e) => this._handleThrottleDown(e, +1);
    this._onThrottleDownDown = (e) => this._handleThrottleDown(e, -1);

    this._onWindowPointerMove = this._handleWindowPointerMove.bind(this);
    this._onWindowPointerUp = this._handleWindowPointerUp.bind(this);
    this._onWindowPointerDown = this._handleWindowPointerDown.bind(this);
    this._onWindowBlur = this._handleWindowBlur.bind(this);
    this._onWindowResize = this._handleWindowResize.bind(this);
    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
    this._onContextMenu = (e) => e.preventDefault();
    this._onTouchPrevent = (e) => {
      if (e.cancelable) e.preventDefault();
    };

    // Control-level pointerdown + iOS touchstart preventDefault (avoids callouts/zoom)
    this._stickZoneEl.addEventListener('pointerdown', this._onStickDown);
    this._stickZoneEl.addEventListener('touchstart', this._onTouchPrevent, { passive: false });

    this._dropBtnEl.addEventListener('pointerdown', this._onDropDown);
    this._dropBtnEl.addEventListener('touchstart', this._onTouchPrevent, { passive: false });

    this._throttleUpBtnEl.addEventListener('pointerdown', this._onThrottleUpDown);
    this._throttleUpBtnEl.addEventListener('touchstart', this._onTouchPrevent, { passive: false });

    this._throttleDownBtnEl.addEventListener('pointerdown', this._onThrottleDownDown);
    this._throttleDownBtnEl.addEventListener('touchstart', this._onTouchPrevent, { passive: false });

    this._root.addEventListener('contextmenu', this._onContextMenu);

    // Window-level listeners for smooth multi-touch tracking & DEMO FLIGHT canvas tap-to-takeover
    window.addEventListener('pointermove', this._onWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', this._onWindowPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._onWindowPointerUp, { passive: true });
    window.addEventListener('pointerdown', this._onWindowPointerDown, { passive: true });
    window.addEventListener('blur', this._onWindowBlur);
    window.addEventListener('resize', this._onWindowResize, { passive: true });
    window.addEventListener('orientationchange', this._onWindowResize, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // Dynamic pointer media query listener (handles responsive devtools / convertible tablets)
    this._coarseMql =
      typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    this._onCoarseChange = (e) => {
      if (e.matches) {
        this._detectedTouch = true;
        this._syncModeAndVisibility();
      }
    };
    if (this._coarseMql && typeof this._coarseMql.addEventListener === 'function') {
      this._coarseMql.addEventListener('change', this._onCoarseChange);
    }
  }

  _syncModeAndVisibility() {
    const active =
      this._forcedVisible !== null
        ? this._forcedVisible
        : this._detectedTouch || this._queryForced;
    this._touchMode = active;

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('touch-active', active);
    }

    const shouldShow = active && this._visible;
    this._root.classList.toggle('ef-hidden', !shouldShow);
    this._root.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  }

  _notifyInteract() {
    if (this._onInteract) {
      this._onInteract();
    }
  }

  _safeSetPointerCapture(target, pointerId) {
    if (target && typeof target.setPointerCapture === 'function' && pointerId != null) {
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Synthetic pointer events in test harnesses may not have an active browser pointerId
      }
    }
  }

  _handleWindowPointerDown(e) {
    if (this._disposed) return;

    // Dynamically enable touch mode if an actual touch contact occurs on a hybrid device
    if (e.pointerType === 'touch' && !this._detectedTouch && this._forcedVisible === null) {
      this._detectedTouch = true;
      this._syncModeAndVisibility();
    }

    if (!this._touchMode || !this._visible) return;
    if (!this._demoFlight || this._crashed) return;
    if (isIgnoredTakeoverTarget(e.target)) return;

    // Canvas tap-to-takeover during DEMO FLIGHT
    this._notifyInteract();
    if (this._inputManager && typeof this._inputManager.triggerTakeover === 'function') {
      this._inputManager.triggerTakeover();
    }
    this._spawnTapRipple(e.clientX, e.clientY);
  }

  _spawnTapRipple(clientX, clientY) {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const ripple = el('div', 'ef-touch-takeover-ripple');
    ripple.style.left = `${clientX}px`;
    ripple.style.top = `${clientY}px`;
    this._root.appendChild(ripple);
    const timer = setTimeout(() => {
      this._rippleTimers.delete(timer);
      ripple.remove();
    }, 340);
    this._rippleTimers.add(timer);
  }

  // --- Left Thumb: Virtual Flight Yoke ---
  _handleStickDown(e) {
    if (!this._touchMode || !this._visible || this._crashed) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (this._stickPointerId !== null) return;

    const rect = this._stickZoneEl.getBoundingClientRect();
    const puckRect = this._stickPuckEl.getBoundingClientRect();
    const outerRadius = Math.min(rect.width, rect.height) * 0.5;
    const puckRadius = Math.min(puckRect.width, puckRect.height) * 0.5 || 24;

    this._stickPointerId = e.pointerId;
    this._stickCenterX = rect.left + rect.width * 0.5;
    this._stickCenterY = rect.top + rect.height * 0.5;
    this._stickMaxRadius = Math.max(24, outerRadius - puckRadius * 0.65);

    this._safeSetPointerCapture(this._stickZoneEl, e.pointerId);
    this._stickZoneEl.classList.add('is-active');
    this._stickPuckEl.classList.remove('is-springing');

    this._notifyInteract();
    if (this._demoFlight && this._inputManager && typeof this._inputManager.triggerTakeover === 'function') {
      this._inputManager.triggerTakeover();
    }

    this._updateStickFromClient(e.clientX, e.clientY);
  }

  _updateStickFromClient(clientX, clientY) {
    const dx = clientX - this._stickCenterX;
    const dy = clientY - this._stickCenterY;
    const dist = Math.hypot(dx, dy);
    const maxR = this._stickMaxRadius || 40;
    const normDist = Math.min(1, dist / maxR);

    // Clamp visual puck position inside circular gimbal ring
    const visualX = dist > maxR && dist > 0 ? (dx / dist) * maxR : dx;
    const visualY = dist > maxR && dist > 0 ? (dy / dist) * maxR : dy;
    this._stickPuckEl.style.transform = `translate3d(${visualX.toFixed(1)}px, ${visualY.toFixed(1)}px, 0)`;

    // Apply 0.08 radial deadzone + smooth quadratic curve for fine aiming & full authority
    let pitch = 0;
    let bank = 0;
    if (normDist > STICK_DEADZONE && dist > 0) {
      const scaled = (normDist - STICK_DEADZONE) / (1 - STICK_DEADZONE);
      const curved = scaled * scaled;
      const nx = dx / dist;
      const ny = dy / dist;
      bank = clamp(nx * curved, -1, 1);
      pitch = clamp(ny * curved, -1, 1);
    }

    // Highlight directional attitude ticks
    this._tickUpEl.classList.toggle('is-lit', dy / maxR < -STICK_TICK_THRESHOLD);
    this._tickDownEl.classList.toggle('is-lit', dy / maxR > STICK_TICK_THRESHOLD);
    this._tickLeftEl.classList.toggle('is-lit', dx / maxR < -STICK_TICK_THRESHOLD);
    this._tickRightEl.classList.toggle('is-lit', dx / maxR > STICK_TICK_THRESHOLD);

    if (this._inputManager && typeof this._inputManager.setTouchAxis === 'function') {
      this._inputManager.setTouchAxis(pitch, bank);
    }
  }

  _releaseStick() {
    this._stickPointerId = null;
    this._stickZoneEl.classList.remove('is-active');
    this._stickPuckEl.classList.add('is-springing');
    this._stickPuckEl.style.transform = 'translate3d(0px, 0px, 0)';
    this._tickUpEl.classList.remove('is-lit');
    this._tickDownEl.classList.remove('is-lit');
    this._tickLeftEl.classList.remove('is-lit');
    this._tickRightEl.classList.remove('is-lit');
    if (this._inputManager && typeof this._inputManager.setTouchAxis === 'function') {
      this._inputManager.setTouchAxis(0, 0);
    }
  }

  // --- Right Thumb: Primary Water Drop Button ---
  _handleDropDown(e) {
    if (!this._touchMode || !this._visible || this._crashed) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (this._dropPointerId !== null) return;

    this._dropPointerId = e.pointerId;
    this._safeSetPointerCapture(this._dropBtnEl, e.pointerId);
    this._dropBtnEl.classList.add('is-pressed');

    this._notifyInteract();
    if (this._inputManager && typeof this._inputManager.setTouchDrop === 'function') {
      this._inputManager.setTouchDrop(true);
    }
  }

  _releaseDrop() {
    this._dropPointerId = null;
    this._dropBtnEl.classList.remove('is-pressed');
    if (this._inputManager && typeof this._inputManager.setTouchDrop === 'function') {
      this._inputManager.setTouchDrop(false);
    }
  }

  // --- Right Thumb: Compact Throttle Rocker (+ / -) ---
  _handleThrottleDown(e, dir) {
    if (!this._touchMode || !this._visible || this._crashed) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (this._throttlePointerId !== null) return;

    this._throttlePointerId = e.pointerId;
    this._safeSetPointerCapture(this._throttleCapsuleEl, e.pointerId);
    this._setThrottleDir(dir);

    this._notifyInteract();
    if (this._demoFlight && this._inputManager && typeof this._inputManager.triggerTakeover === 'function') {
      this._inputManager.triggerTakeover();
    }
  }

  _setThrottleDir(dir) {
    this._throttleDir = dir;
    this._throttleUpBtnEl.classList.toggle('is-pressed', dir > 0);
    this._throttleDownBtnEl.classList.toggle('is-pressed', dir < 0);
    this._throttleCapsuleEl.classList.toggle('is-active', dir !== 0);
    if (this._inputManager && typeof this._inputManager.setTouchThrottle === 'function') {
      this._inputManager.setTouchThrottle(dir);
    }
  }

  _releaseThrottle() {
    this._throttlePointerId = null;
    this._setThrottleDir(0);
  }

  // --- Global Multi-Touch Pointer Tracking ---
  _handleWindowPointerMove(e) {
    if (this._disposed) return;

    if (this._stickPointerId !== null && e.pointerId === this._stickPointerId) {
      this._updateStickFromClient(e.clientX, e.clientY);
    }

    // Allow smooth vertical slide across the throttle rocker capsule
    if (this._throttlePointerId !== null && e.pointerId === this._throttlePointerId) {
      const rect = this._throttleCapsuleEl.getBoundingClientRect();
      if (rect.height > 0) {
        const midY = rect.top + rect.height * 0.5;
        const nextDir = e.clientY <= midY ? +1 : -1;
        if (nextDir !== this._throttleDir) {
          this._setThrottleDir(nextDir);
        }
      }
    }
  }

  _handleWindowPointerUp(e) {
    if (this._disposed) return;

    if (this._stickPointerId !== null && e.pointerId === this._stickPointerId) {
      this._releaseStick();
    }
    if (this._dropPointerId !== null && e.pointerId === this._dropPointerId) {
      this._releaseDrop();
    }
    if (this._throttlePointerId !== null && e.pointerId === this._throttlePointerId) {
      this._releaseThrottle();
    }
  }

  _handleWindowBlur() {
    this._releaseAllPointers();
  }

  _handleWindowResize() {
    this._releaseAllPointers();
  }

  _handleVisibilityChange() {
    if (document.hidden) {
      this._releaseAllPointers();
    }
  }

  _releaseAllPointers() {
    if (this._stickPointerId !== null) this._releaseStick();
    if (this._dropPointerId !== null) this._releaseDrop();
    if (this._throttlePointerId !== null) this._releaseThrottle();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._releaseAllPointers();

    for (const timer of this._rippleTimers) {
      clearTimeout(timer);
    }
    this._rippleTimers.clear();

    this._stickZoneEl.removeEventListener('pointerdown', this._onStickDown);
    this._stickZoneEl.removeEventListener('touchstart', this._onTouchPrevent);

    this._dropBtnEl.removeEventListener('pointerdown', this._onDropDown);
    this._dropBtnEl.removeEventListener('touchstart', this._onTouchPrevent);

    this._throttleUpBtnEl.removeEventListener('pointerdown', this._onThrottleUpDown);
    this._throttleUpBtnEl.removeEventListener('touchstart', this._onTouchPrevent);

    this._throttleDownBtnEl.removeEventListener('pointerdown', this._onThrottleDownDown);
    this._throttleDownBtnEl.removeEventListener('touchstart', this._onTouchPrevent);

    this._root.removeEventListener('contextmenu', this._onContextMenu);

    window.removeEventListener('pointermove', this._onWindowPointerMove);
    window.removeEventListener('pointerup', this._onWindowPointerUp);
    window.removeEventListener('pointercancel', this._onWindowPointerUp);
    window.removeEventListener('pointerdown', this._onWindowPointerDown);
    window.removeEventListener('blur', this._onWindowBlur);
    window.removeEventListener('resize', this._onWindowResize);
    window.removeEventListener('orientationchange', this._onWindowResize);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    if (this._coarseMql && typeof this._coarseMql.removeEventListener === 'function') {
      this._coarseMql.removeEventListener('change', this._onCoarseChange);
    }

    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('touch-active');
    }

    this._root.remove();
  }
}
