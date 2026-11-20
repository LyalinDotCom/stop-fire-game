/**
 * InputManager — Unified Keyboard, Gamepad API, Multi-Touch, and opt-in Mouse-Yoke input
 * for EMBER FRONT — Aerial Fire Response Unit.
 *
 * Polarity matches docs/INTERFACES.md §3 & docs/gamespec.md §2:
 *   pitch: -1 (nose down) .. +1 (nose up)  [default: W = -1, S = +1; flipped when invertPitch=true]
 *   roll:  -1 (bank left) .. +1 (bank right) [A = -1, D = +1]
 *   throttleDelta: -1 (Q / LT / Touch -) .. +1 (E / RT / Touch +)
 *   drop: boolean (SPACE / A / RB / Touch Drop / Mouse-Yoke LMB)
 *   dropJustPressed: boolean (rising edge consumed each sample())
 */

const FLIGHT_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

function applyDeadzone(val, dz = 0.15) {
  const abs = Math.abs(val);
  if (abs <= dz) return 0;
  const scaled = (abs - dz) / (1 - dz);
  return Math.sign(val) * Math.min(1, scaled);
}

export class InputManager {
  /**
   * @param {object} opts
   * @param {HTMLElement} [opts.canvas]
   * @param {boolean} [opts.invertPitch=false]
   * @param {boolean} [opts.mouseYoke=false]
   * @param {() => void} [opts.onFlightKey]
   * @param {() => void} [opts.onFirstGesture]
   * @param {() => void} [opts.onUserGesture]
   * @param {() => void} [opts.onToggleMute]
   * @param {() => void} [opts.onToggleDrawer]
   * @param {() => void} [opts.onEscape]
   */
  constructor(opts = {}) {
    this._canvas = opts.canvas || null;
    this._invertPitch = Boolean(opts.invertPitch);
    this._mouseYoke = Boolean(opts.mouseYoke);
    this._drawerOpen = false;

    this._onFlightKey = opts.onFlightKey || null;
    this._onFirstGesture = opts.onFirstGesture || null;
    this._onUserGesture = opts.onUserGesture || null;
    this._onToggleMute = opts.onToggleMute || null;
    this._onToggleDrawer = opts.onToggleDrawer || null;
    this._onEscape = opts.onEscape || null;

    this._keys = new Set();
    this._dropJustPressedPending = false;
    this._prevPadDrop = false;
    this._mouseDown = false;
    this._mouseNormX = 0;
    this._mouseNormY = 0;
    this._mouseInside = false;
    this._mouseNeedsRecenter = false;

    this._gestureFired = false;
    this._lastActivityMs = performance.now();

    // Optional programmatic overrides for QA / touch helpers
    this._overrideDrop = false;
    this._overrideDropTimer = 0;

    // Multi-touch flight control inputs (driven by TouchControls)
    this._touchPitch = 0;
    this._touchBank = 0;
    this._touchThrottle = 0;
    this._touchDrop = false;

    this._handleKeyDown = this._handleKeyDown.bind(this);
    this._handleKeyUp = this._handleKeyUp.bind(this);
    this._handleBlur = this._handleBlur.bind(this);
    this._handleVisibilityChange = this._handleVisibilityChange.bind(this);
    this._handlePointerDown = this._handlePointerDown.bind(this);
    this._handlePointerUp = this._handlePointerUp.bind(this);
    this._handlePointerMove = this._handlePointerMove.bind(this);
    this._handlePointerLeave = this._handlePointerLeave.bind(this);

    window.addEventListener('keydown', this._handleKeyDown, { passive: false });
    window.addEventListener('keyup', this._handleKeyUp);
    window.addEventListener('blur', this._handleBlur);
    document.addEventListener('visibilitychange', this._handleVisibilityChange);
    window.addEventListener('pointerdown', this._handlePointerDown, { passive: true });
    window.addEventListener('pointerup', this._handlePointerUp, { passive: true });
    window.addEventListener('pointermove', this._handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', this._handlePointerLeave);
  }

  _clearTouchState() {
    this._touchPitch = 0;
    this._touchBank = 0;
    this._touchThrottle = 0;
    this._touchDrop = false;
  }

  setOptions({ invertPitch, invertY, mouseYoke, drawerOpen } = {}) {
    if (typeof invertPitch === 'boolean') {
      this._invertPitch = invertPitch;
    } else if (typeof invertY === 'boolean') {
      this._invertPitch = invertY;
    }
    if (typeof mouseYoke === 'boolean') {
      this._mouseYoke = mouseYoke;
      if (!mouseYoke) {
        this._mouseDown = false;
        this._mouseInside = false;
        this._mouseNeedsRecenter = false;
      }
    }
    if (typeof drawerOpen === 'boolean') {
      const wasOpen = this._drawerOpen;
      this._drawerOpen = drawerOpen;
      if (drawerOpen && !wasOpen) {
        // Only clear active flight inputs on the false -> true transition edge
        this._keys.clear();
        this._mouseDown = false;
        this._mouseInside = false;
        this._mouseNeedsRecenter = true;
        this._clearTouchState();
      } else if (!drawerOpen && wasOpen) {
        // Keep Mouse-Yoke disarmed after closing drawer via corner × until cursor re-enters center zone
        this._mouseInside = false;
        this._mouseNeedsRecenter = true;
      }
    }
  }

  getLastActivityMs() {
    return this._lastActivityMs;
  }

  markActivity() {
    this._lastActivityMs = performance.now();
  }

  /**
   * Set continuous analog touch flight-yoke axes (-1..+1).
   * pitch: -1 (thumb pushed up / nose down default) .. +1 (thumb pulled down / nose up default).
   *        Honors invertPitch / invertY identically to keyboard & gamepad.
   * bank:  -1 (bank left) .. +1 (bank right).
   */
  setTouchAxis(pitch, bank) {
    const p = Number.isFinite(pitch) ? Math.max(-1, Math.min(1, pitch)) : 0;
    const b = Number.isFinite(bank) ? Math.max(-1, Math.min(1, bank)) : 0;
    this._touchPitch = p;
    this._touchBank = b;
    if (Math.abs(p) > 0.01 || Math.abs(b) > 0.01) {
      this._fireFirstGesture();
      this._lastActivityMs = performance.now();
    }
  }

  /**
   * Set touch throttle rocker delta (-1, 0, +1).
   */
  setTouchThrottle(delta) {
    const d = Number.isFinite(delta) ? Math.max(-1, Math.min(1, delta)) : 0;
    this._touchThrottle = d;
    if (Math.abs(d) > 0.01) {
      this._fireFirstGesture();
      this._lastActivityMs = performance.now();
    }
  }

  /**
   * Set touch water drop active state (boolean).
   * Fires the exact same rising edge (dropJustPressed) as pressing SPACE.
   */
  setTouchDrop(active) {
    const next = Boolean(active);
    if (next && !this._touchDrop) {
      this._dropJustPressedPending = true;
      this._fireFirstGesture(true);
      this._lastActivityMs = performance.now();
      if (!this._drawerOpen && this._onFlightKey) {
        this._onFlightKey('TouchDrop');
      }
    } else if (next) {
      this._lastActivityMs = performance.now();
    }
    this._touchDrop = next;
  }

  /**
   * Trigger manual-control takeover from DEMO FLIGHT (same callback as pressing a flight key)
   * and unlock audio on user gesture.
   */
  triggerTakeover() {
    this._fireFirstGesture(true);
    this._lastActivityMs = performance.now();
    if (!this._drawerOpen && this._onFlightKey) {
      this._onFlightKey('TouchTakeover');
    }
  }

  /**
   * Programmatic drop pulse for automated QA or accessibility buttons.
   */
  triggerDropPulse(durationMs = 800) {
    this._overrideDrop = true;
    this._overrideDropTimer = Math.max(this._overrideDropTimer, durationMs / 1000);
    this._dropJustPressedPending = true;
    this._lastActivityMs = performance.now();
  }

  _fireFirstGesture(discrete = false) {
    if (!this._gestureFired || discrete) {
      this._gestureFired = true;
      if (this._onFirstGesture) this._onFirstGesture();
      if (this._onUserGesture) this._onUserGesture();
    }
  }

  _handleKeyDown(e) {
    // Unlock / resume audio on discrete user keydown (handles iOS 'interrupted' recovery too)
    this._fireFirstGesture(!e.repeat);

    const editable = isEditableTarget(e.target) || isEditableTarget(document.activeElement);

    if (e.code === 'Escape') {
      if (editable && document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      if (this._onEscape) this._onEscape();
      return;
    }

    // Ignore all flight keys & HUD hotkeys while typing in callsign <input> or other form fields
    if (editable) return;

    // Ignore modified shortcuts (Ctrl/Cmd/Alt) except Shift+? for drawer
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Drawer toggle: H or ?
    if (!e.repeat && (e.code === 'KeyH' || e.key === '?' || (e.code === 'Slash' && e.shiftKey))) {
      e.preventDefault();
      if (this._onToggleDrawer) this._onToggleDrawer();
      return;
    }

    // Mute toggle: M
    if (!e.repeat && e.code === 'KeyM') {
      e.preventDefault();
      if (this._onToggleMute) this._onToggleMute();
      return;
    }

    // If settings drawer is open, ignore flight keys so user isn't flying blind
    if (this._drawerOpen) return;

    if (FLIGHT_CODES.has(e.code)) {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) {
        e.preventDefault();
      }
      const wasDown = this._keys.has(e.code);
      this._keys.add(e.code);
      if (e.code === 'Space' && !wasDown) {
        this._dropJustPressedPending = true;
      }
      this._lastActivityMs = performance.now();
      if (this._onFlightKey) this._onFlightKey(e.code);
    }
  }

  _handleKeyUp(e) {
    this._keys.delete(e.code);
  }

  _handleBlur() {
    this._keys.clear();
    this._mouseDown = false;
    this._mouseInside = false;
    this._gestureFired = false;
    this._clearTouchState();
  }

  _handleVisibilityChange() {
    if (document.hidden) {
      this._keys.clear();
      this._mouseDown = false;
      this._mouseInside = false;
      this._gestureFired = false;
      this._clearTouchState();
    } else {
      // Returning from lock-screen / app-switch (iOS Safari 'interrupted' audio context): re-arm gesture unlock
      this._gestureFired = false;
    }
  }

  _handlePointerDown(e) {
    this._fireFirstGesture(true);
    if (e.pointerType === 'touch') return;
    if (!this._mouseYoke || this._drawerOpen) return;
    if (e.button !== 0) return;
    // Only capture drop clicks directly on the game canvas (not HUD buttons)
    if (this._canvas && e.target !== this._canvas) return;
    this._mouseNeedsRecenter = false;
    if (!this._mouseDown) {
      this._dropJustPressedPending = true;
    }
    this._mouseDown = true;
    this._lastActivityMs = performance.now();
    if (this._onFlightKey) this._onFlightKey('Mouse0');
  }

  _handlePointerUp(e) {
    if (e.pointerType === 'touch') return;
    if (e.button === 0) {
      this._mouseDown = false;
    }
  }

  _handlePointerMove(e) {
    if (e.pointerType === 'touch') return;
    if (!this._mouseYoke || this._drawerOpen) return;
    // Ignore pointer moves over HUD buttons, drawers, or overlays
    if (this._canvas && e.target && e.target !== this._canvas) return;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const nx = ((e.clientX / w) - 0.5) * 2;
    const ny = ((e.clientY / h) - 0.5) * 2;
    this._mouseNormX = nx;
    this._mouseNormY = ny;
    if (this._mouseNeedsRecenter) {
      // Re-arm Mouse-Yoke only once cursor moves back near screen center/deadzone
      if (Math.hypot(nx, ny) <= 0.35) {
        this._mouseNeedsRecenter = false;
        this._mouseInside = true;
      }
      return;
    }
    this._mouseInside = true;
  }

  _handlePointerLeave() {
    this._mouseInside = false;
    this._mouseDown = false;
  }

  /**
   * Sample combined keyboard + gamepad + multi-touch + optional mouse-yoke state for one physics step.
   * @param {number} [dt=1/60]
   * @returns {{ pitch: number, roll: number, throttleDelta: number, drop: boolean, dropJustPressed: boolean, anyManualInput: boolean }}
   */
  sample(dt = 1 / 60) {
    let pitch = 0;
    let roll = 0;
    let throttleDelta = 0;
    let drop = false;
    let dropJustPressed = this._dropJustPressedPending;
    this._dropJustPressedPending = false;

    if (this._overrideDropTimer > 0) {
      this._overrideDropTimer = Math.max(0, this._overrideDropTimer - dt);
      if (this._overrideDropTimer === 0) this._overrideDrop = false;
    }

    if (!this._drawerOpen) {
      // Keyboard pitch: W = nose down (-1), S = nose up (+1); flipped when invertPitch = true
      const pitchUp = this._keys.has('KeyS') || this._keys.has('ArrowDown');
      const pitchDown = this._keys.has('KeyW') || this._keys.has('ArrowUp');
      let kbPitch = (pitchUp ? 1 : 0) - (pitchDown ? 1 : 0);
      if (this._invertPitch) kbPitch = -kbPitch;
      pitch += kbPitch;

      // Keyboard roll: A = left (-1), D = right (+1)
      const rollRight = this._keys.has('KeyD') || this._keys.has('ArrowRight');
      const rollLeft = this._keys.has('KeyA') || this._keys.has('ArrowLeft');
      roll += (rollRight ? 1 : 0) - (rollLeft ? 1 : 0);

      // Keyboard throttle: Q = decrease (-1), E = increase (+1)
      const throtUp = this._keys.has('KeyE');
      const throtDown = this._keys.has('KeyQ');
      throttleDelta += (throtUp ? 1 : 0) - (throtDown ? 1 : 0);

      if (this._keys.has('Space')) drop = true;

      // Optional Mouse-Yoke mode
      if (this._mouseYoke && this._mouseInside) {
        const mx = applyDeadzone(this._mouseNormX, 0.06);
        let my = applyDeadzone(this._mouseNormY, 0.06);
        if (this._invertPitch) my = -my;
        const mouseActive = Math.abs(mx) > 0 || Math.abs(my) > 0 || this._mouseDown;
        if (mouseActive) {
          this._lastActivityMs = performance.now();
          if (this._onFlightKey) this._onFlightKey('MouseYoke');
        }
        if (Math.abs(mx) > Math.abs(roll)) roll = mx;
        if (Math.abs(my) > Math.abs(pitch)) pitch = my;
        if (this._mouseDown) drop = true;
      }

      // Multi-touch virtual flight yoke, throttle rocker, and drop button
      const touchActive =
        Math.abs(this._touchPitch) > 0.01 ||
        Math.abs(this._touchBank) > 0.01 ||
        Math.abs(this._touchThrottle) > 0.01 ||
        this._touchDrop;
      if (touchActive) {
        this._lastActivityMs = performance.now();
        const tBank = this._touchBank;
        let tPitch = this._touchPitch;
        if (this._invertPitch) tPitch = -tPitch;
        if (Math.abs(tBank) > Math.abs(roll)) roll = tBank;
        if (Math.abs(tPitch) > Math.abs(pitch)) pitch = tPitch;
        if (Math.abs(this._touchThrottle) > Math.abs(throttleDelta)) {
          throttleDelta = this._touchThrottle;
        }
        if (this._touchDrop) drop = true;
      }

      // Gamepad API (standard mapping: left stick axes 0/1, LT btn 6, RT btn 7, A btn 0, RB btn 5)
      if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
        const pads = navigator.getGamepads();
        if (pads) {
          for (let i = 0; i < pads.length; i++) {
            const pad = pads[i];
            if (!pad || !pad.connected) continue;
            const gx = applyDeadzone(pad.axes[0] || 0, 0.15);
            let gy = applyDeadzone(pad.axes[1] || 0, 0.15);
            if (this._invertPitch) gy = -gy;

            const lt = pad.buttons[6] ? pad.buttons[6].value : 0;
            const rt = pad.buttons[7] ? pad.buttons[7].value : 0;
            const gThrottle = (rt > 0.1 ? rt : 0) - (lt > 0.1 ? lt : 0);

            const padDrop = Boolean(
              (pad.buttons[0] && pad.buttons[0].pressed) ||
              (pad.buttons[5] && pad.buttons[5].pressed)
            );
            if (padDrop && !this._prevPadDrop) {
              dropJustPressed = true;
            }
            this._prevPadDrop = padDrop;

            const padActive = Math.abs(gx) > 0 || Math.abs(gy) > 0 || Math.abs(gThrottle) > 0 || padDrop;
            if (padActive) {
              this._fireFirstGesture();
              this._lastActivityMs = performance.now();
              if (this._onFlightKey) this._onFlightKey('Gamepad');
            }

            if (Math.abs(gx) > Math.abs(roll)) roll = gx;
            if (Math.abs(gy) > Math.abs(pitch)) pitch = gy;
            if (Math.abs(gThrottle) > Math.abs(throttleDelta)) throttleDelta = gThrottle;
            if (padDrop) drop = true;
            break;
          }
        }
      }
    }

    if (this._overrideDrop) drop = true;

    pitch = Math.max(-1, Math.min(1, pitch));
    roll = Math.max(-1, Math.min(1, roll));
    throttleDelta = Math.max(-1, Math.min(1, throttleDelta));

    const anyManualInput =
      Math.abs(pitch) > 0.01 ||
      Math.abs(roll) > 0.01 ||
      Math.abs(throttleDelta) > 0.01 ||
      drop;

    return {
      pitch,
      roll,
      throttleDelta,
      drop,
      dropJustPressed,
      anyManualInput,
    };
  }

  dispose() {
    window.removeEventListener('keydown', this._handleKeyDown);
    window.removeEventListener('keyup', this._handleKeyUp);
    window.removeEventListener('blur', this._handleBlur);
    document.removeEventListener('visibilitychange', this._handleVisibilityChange);
    window.removeEventListener('pointerdown', this._handlePointerDown);
    window.removeEventListener('pointerup', this._handlePointerUp);
    window.removeEventListener('pointermove', this._handlePointerMove);
    document.removeEventListener('pointerleave', this._handlePointerLeave);
    this._keys.clear();
    this._clearTouchState();
  }
}
