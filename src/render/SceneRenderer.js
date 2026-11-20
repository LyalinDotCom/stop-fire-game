import * as THREE from 'three';
import { createSkybox } from './SkyboxShader.js';
import { createWaterPlane } from './WaterShader.js';
import { createHeroPlaneMesh, RemotePlaneFleet } from './PlaneMesh.js';
import { WorldMeshes } from './WorldMeshes.js';
import { VfxSystem } from './VfxSystem.js';

const TARGET_RENDER_HEIGHT = 360;
const FIRE_LIGHT_COUNT = 6;

/**
 * Orchestrates the 640x360 retro pixelated Three.js rendering pipeline for EMBER FRONT.
 */
export class SceneRenderer {
  constructor(canvas, terrain) {
    this.canvas = canvas;
    this.terrain = terrain;
    this._lastElapsed = 0;
    this._cameraSnapped = false;
    this._renderWidth = 640;
    this._renderHeight = TARGET_RENDER_HEIGHT;

    // WebGLRenderer locked to 360 vertical rows, antialias off, pixelRatio 1, sRGB output
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false;

    // Enforce crisp nearest-neighbor pixelated upscaling on canvas element
    if (canvas && canvas.style) {
      canvas.style.imageRendering = 'pixelated';
    }

    // Scene + twilight lavender-mauve distance fog
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#2c2d42');
    this.scene.fog = new THREE.Fog('#7f6585', 450, 2400);

    // Camera (FOV 52 deg)
    this.camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.8, 3200);
    this.camera.position.set(0, 80, 120);

    // Sunset DirectionalLight (#ffbe8a, 0.9) + Twilight HemisphereLight (#5c5270 / #2b3d38, 0.65)
    this._sunLight = new THREE.DirectionalLight('#ffbe8a', 0.9);
    this._sunLight.position.set(-650, 450, -600);
    this.scene.add(this._sunLight);

    this._hemiLight = new THREE.HemisphereLight('#5c5270', '#2b3d38', 0.65);
    this.scene.add(this._hemiLight);

    // Pool of 6 dynamic flickering #ff6f00 PointLights tracking fireSnapshot.hotClusters
    this._fireLights = [];
    for (let i = 0; i < FIRE_LIGHT_COUNT; i++) {
      const pt = new THREE.PointLight('#ff6f00', 0, 185, 2);
      pt.position.set(0, -500, 0);
      this.scene.add(pt);
      this._fireLights.push(pt);
    }

    // Seamless 3D twilight sky dome
    this._skybox = createSkybox();
    this.scene.add(this._skybox.mesh);

    // Hero plane + 99-plane instanced remote fleet
    this._heroPlane = createHeroPlaneMesh(0, '07');
    this.scene.add(this._heroPlane.group);

    this._remoteFleet = new RemotePlaneFleet(99);
    this.scene.add(this._remoteFleet.group);

    // World & VFX (built from terrain)
    this._water = null;
    this._world = null;
    this._vfx = null;

    // Elastic chase camera state & scratch vectors (zero per-frame alloc)
    this._camPos = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camDesiredPos = new THREE.Vector3();
    this._camDesiredLook = new THREE.Vector3();
    this._camRollLag = 0;
    this._camUp = new THREE.Vector3(0, 1, 0);
    this._fwdVec = new THREE.Vector3();
    this._rightVec = new THREE.Vector3();
    this._projVec = new THREE.Vector3();
    this._camForward = new THREE.Vector3();
    this._toTarget = new THREE.Vector3();
    this._internalShake = 0;
    this._wasCrashed = false;
    this._crashOrbitAngle = 0;
    this._crashPos = new THREE.Vector3();

    this.rebuildWorld(terrain);
    this.resize();
  }

  /**
   * Rebuilds terrain, water, pines, cabins, water towers, and resets VFX for a new operation/mode.
   */
  rebuildWorld(terrain) {
    this.terrain = terrain;
    this._cameraSnapped = false;
    this._wasCrashed = false;
    this._internalShake = 0;

    if (this._water) {
      this.scene.remove(this._water.mesh);
      this._water.dispose();
      this._water = null;
    }
    if (this._world) {
      this.scene.remove(this._world.group);
      this._world.dispose();
      this._world = null;
    }

    // Extend water plane slightly wider than playable grid so basin lakes/edges stay seamless
    this._water = createWaterPlane(terrain.worldSize + 120, terrain.waterLevel);
    this.scene.add(this._water.mesh);

    this._world = new WorldMeshes(terrain);
    this.scene.add(this._world.group);

    if (!this._vfx) {
      this._vfx = new VfxSystem(terrain);
      this.scene.add(this._vfx.group);
    } else {
      this._vfx.resetForTerrain(terrain);
    }

    // Turn off fire lights until next fireSnapshot arrives
    for (let i = 0; i < this._fireLights.length; i++) {
      this._fireLights[i].intensity = 0;
    }
  }

  /**
   * Synchronizes cellular fire state into terrain colors, pine charring, cabin ruins, and VFX lists.
   */
  syncFireGrid(cells, phases, dirtyIndices, cabinHp, cabinAtRisk) {
    const dirtyArg = dirtyIndices === undefined ? null : dirtyIndices;
    if (this._world) {
      this._world.syncFireState(cells, dirtyArg, cabinHp, cabinAtRisk, this._lastElapsed);
    }
    if (this._vfx && cells) {
      this._vfx.syncFireCells(cells);
    }
  }

  /**
   * Spawns ballistic water drop curtain puffs in world space.
   */
  spawnDropVisual(x, y, z, vx, vy, vz, windVx, windVz) {
    if (this._vfx) {
      this._vfx.spawnDropVisual(x, y, z, vx, vy, vz, windVx, windVz);
    }
  }

  /**
   * Spawns impact steam bursts when water hits fire or ground.
   */
  spawnImpactSteam(x, y, z, extinguished) {
    if (this._vfx) {
      this._vfx.spawnImpactSteam(x, y, z, extinguished);
    }
  }

  /**
   * Spawns unmistakable drop impact VFX (tall steam column + glowing splash rings on hit/partial;
   * muted splash dust + amber-red ring on miss).
   */
  spawnDropImpactEffect(x, y, z, outcome, cellsExtinguished = 0) {
    if (this._vfx) {
      this._vfx.spawnDropImpactEffect(x, y, z, outcome, cellsExtinguished);
    }
  }

  /**
   * Spawns debris/spark burst and applies heavy camera shake when the plane clips a tree.
   */
  spawnTreeHitEffect(x, y, z) {
    this._internalShake = Math.max(this._internalShake, 0.95);
    if (this._vfx) {
      this._vfx.spawnTreeHitEffect(x, y, z);
    }
  }

  /**
   * Spawns fiery crash fireball + smoke plume + heavy camera jolt on airframe loss.
   */
  spawnCrashExplosion(x, y, z) {
    this._internalShake = Math.max(this._internalShake, 1.65);
    if (Number.isFinite(x) && Number.isFinite(z)) {
      this._crashPos.set(x, Number.isFinite(y) ? y : 18, z);
    }
    if (this._vfx) {
      this._vfx.spawnCrashExplosion(x, y, z);
    }
  }

  /**
   * Advances camera, lights, meshes, shaders, and VFX, then renders the 640x360 WebGL frame.
   */
  update({
    dt = 1 / 60,
    elapsed = 0,
    localAircraft = null,
    remotePlanes = null,
    fireSnapshot = null,
    showDropReticle = false,
    dropPreview = null,
    cameraShake = 0,
  } = {}) {
    const safeDt = Math.min(Math.max(dt, 0.001), 0.05);
    this._lastElapsed = elapsed;

    // 1. Hero plane pose, livery & wing stencil
    if (localAircraft) {
      const isCrashed = Boolean(localAircraft.crashed);
      if (isCrashed && !this._wasCrashed) {
        this._crashPos.set(localAircraft.x, localAircraft.y, localAircraft.z);
        this._crashOrbitAngle = ((localAircraft.yawDeg || 0) * Math.PI) / 180;
        this._internalShake = Math.max(this._internalShake, 1.45);
      } else if (!isCrashed && this._wasCrashed) {
        // Snap chase camera cleanly onto respawned airframe
        this._cameraSnapped = false;
      }
      this._wasCrashed = isCrashed;

      this._heroPlane.group.visible = !isCrashed;
      if (!isCrashed) {
        if (localAircraft.colorIdx !== undefined) {
          this._heroPlane.setLivery(localAircraft.colorIdx);
        }
        if (localAircraft.slotId !== undefined && localAircraft.slotId !== null && localAircraft.slotId >= 0) {
          const digits = String(localAircraft.slotId % 100).padStart(2, '0');
          this._heroPlane.setStencil(digits);
        } else {
          this._heroPlane.setStencil('07');
        }
        this._heroPlane.updatePose(localAircraft, safeDt);
      }

      const combinedShake = Math.max(cameraShake || 0, this._internalShake);
      if (isCrashed) {
        this._updateCrashCamera(safeDt, elapsed, combinedShake);
      } else {
        this._updateChaseCamera(localAircraft, safeDt, elapsed, combinedShake);
      }
    }

    this._internalShake = Math.max(0, this._internalShake - safeDt * 2.2);

    // 2. Skybox follows camera seamlessly
    this._skybox.update(this.camera.position, elapsed);

    // 3. Water shimmer & world animations (burning tree ember rims)
    if (this._water) {
      const windVx = fireSnapshot ? (fireSnapshot.windVx || 0) : 0;
      const windVz = fireSnapshot ? (fireSnapshot.windVz || 0) : 0;
      this._water.update(elapsed, windVx, windVz);
    }
    if (this._world && typeof this._world.update === 'function') {
      this._world.update(elapsed);
    }

    // 4. Dynamic flickering orange fire PointLights tracking fireSnapshot.hotClusters
    this._updateFireLights(fireSnapshot, elapsed);

    // 5. Remote plane fleet (up to 99 instanced planes with <15m camera proximity fade)
    this._remoteFleet.update(remotePlanes, this.camera.position, elapsed);

    // 6. VFX pools & drop reticle
    if (this._vfx) {
      this._vfx.update({
        dt: safeDt,
        elapsed,
        localAircraft,
        remotePlanes,
        fireSnapshot,
        showDropReticle,
        dropPreview,
      });
    }

    // 7. Render low-res retro WebGL pass
    this.renderer.render(this.scene, this.camera);
  }

  _updateChaseCamera(plane, dt, elapsed, extShake) {
    const yawRad = (plane.yawDeg || 0) * (Math.PI / 180);
    const pitchRad = (plane.pitchDeg || 0) * (Math.PI / 180);
    const rollRad = (plane.rollDeg || 0) * (Math.PI / 180);

    // Forward horizontal & gentle pitched vector (0 deg = North -Z, 90 deg = East +X)
    const fx = Math.sin(yawRad);
    const fz = -Math.cos(yawRad);
    const fy = Math.sin(pitchRad) * 0.45;
    this._fwdVec.set(fx, fy, fz).normalize();

    // Right vector in horizontal plane
    this._rightVec.set(Math.cos(yawRad), 0, Math.sin(yawRad));

    // Target chase offset: 18 m behind, 6.5 m above tail (pull slightly wider in portrait mobile)
    const aspect = this.camera ? this.camera.aspect : 16 / 9;
    const portraitExtra = aspect < 0.9 ? Math.min(6.5, (0.9 - aspect) * 14.0) : 0;
    const followDist = 18.0 + portraitExtra;
    const followHeight = 6.5 + portraitExtra * 0.28;
    this._camDesiredPos.set(
      plane.x - fx * followDist,
      plane.y + followHeight - fy * 6.5,
      plane.z - fz * followDist
    );

    // Prevent camera from dipping beneath water or terrain
    if (this.terrain) {
      const groundH = Math.max(
        this.terrain.waterLevel + 1.8,
        this.terrain.getHeight(this._camDesiredPos.x, this._camDesiredPos.z) + 2.4
      );
      if (this._camDesiredPos.y < groundH) {
        this._camDesiredPos.y = groundH;
      }
    }

    // Look 12 m ahead of nose
    this._camDesiredLook.set(
      plane.x + fx * 12.0,
      plane.y + 1.4 + fy * 10.0,
      plane.z + fz * 12.0
    );

    // Damped elastic smoothing (snap immediately on first frame / world switch)
    if (!this._cameraSnapped) {
      this._camPos.copy(this._camDesiredPos);
      this._camLook.copy(this._camDesiredLook);
      this._camRollLag = rollRad * 0.28;
      this._cameraSnapped = true;
    } else {
      const posAlpha = 1.0 - Math.exp(-8.5 * dt);
      const lookAlpha = 1.0 - Math.exp(-12.0 * dt);
      const rollAlpha = 1.0 - Math.exp(-6.5 * dt);
      this._camPos.lerp(this._camDesiredPos, posAlpha);
      this._camLook.lerp(this._camDesiredLook, lookAlpha);
      // 28% damped roll lag
      this._camRollLag += (rollRad * 0.28 - this._camRollLag) * rollAlpha;
    }

    // Impulse shake from drop, scoop, bounce, or external caller
    let shake = extShake || 0;
    if (plane.releasing) shake = Math.max(shake, 0.14);
    if (plane.scooping) shake = Math.max(shake, 0.18);
    if (plane.bounceTimer > 0) shake = Math.max(shake, 0.45 * Math.min(1, plane.bounceTimer / 0.4));

    let sx = 0;
    let sy = 0;
    if (shake > 0.001) {
      sx = Math.sin(elapsed * 57.0) * shake * 0.65;
      sy = Math.cos(elapsed * 73.0) * shake * 0.50;
    }

    this.camera.position.set(this._camPos.x + sx, this._camPos.y + sy, this._camPos.z);

    // Apply 28% damped bank roll to camera up vector around forward axis
    const sinR = Math.sin(this._camRollLag);
    const cosR = Math.cos(this._camRollLag);
    this._camUp.set(
      this._rightVec.x * sinR,
      cosR,
      this._rightVec.z * sinR
    ).normalize();
    this.camera.up.copy(this._camUp);
    this.camera.lookAt(this._camLook);
  }

  _updateCrashCamera(dt, elapsed, shake) {
    this._crashOrbitAngle += dt * 0.42;
    const dist = 34.0;
    const height = 18.0;
    const cx = this._crashPos.x;
    const cy = this._crashPos.y;
    const cz = this._crashPos.z;

    this._camDesiredPos.set(
      cx - Math.sin(this._crashOrbitAngle) * dist,
      cy + height,
      cz + Math.cos(this._crashOrbitAngle) * dist
    );
    if (this.terrain) {
      const groundH = Math.max(
        this.terrain.waterLevel + 3.0,
        this.terrain.getHeight(this._camDesiredPos.x, this._camDesiredPos.z) + 5.0
      );
      if (this._camDesiredPos.y < groundH) {
        this._camDesiredPos.y = groundH;
      }
    }
    this._camDesiredLook.set(cx, cy + 4.5, cz);

    const alpha = 1.0 - Math.exp(-3.5 * dt);
    this._camPos.lerp(this._camDesiredPos, alpha);
    this._camLook.lerp(this._camDesiredLook, alpha);

    let sx = 0;
    let sy = 0;
    if (shake > 0.001) {
      sx = Math.sin(elapsed * 61.0) * shake * 0.9;
      sy = Math.cos(elapsed * 79.0) * shake * 0.7;
    }

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(this._camPos.x + sx, this._camPos.y + sy, this._camPos.z);
    this.camera.lookAt(this._camLook);
  }

  _updateFireLights(fireSnapshot, elapsed) {
    const clusters = fireSnapshot && fireSnapshot.hotClusters ? fireSnapshot.hotClusters : null;
    const count = clusters ? Math.min(clusters.length, FIRE_LIGHT_COUNT) : 0;

    for (let i = 0; i < FIRE_LIGHT_COUNT; i++) {
      const light = this._fireLights[i];
      if (i < count) {
        const c = clusters[i];
        const normInt = Math.max(0.25, Math.min(1.5, (c.intensity || 8) / 10));
        // +-14% fast organic wildfire flicker
        const flicker =
          1.0 +
          0.09 * Math.sin(elapsed * 13.7 + i * 2.13) +
          0.05 * Math.cos(elapsed * 23.1 + i * 4.71);
        light.position.set(c.x, (c.y || 20) + 15.0, c.z);
        light.distance = 155 + normInt * 55; // 155..220 m range
        // Physically calibrated intensity for Three.js r170 decay = 2
        light.intensity = (2600 + normInt * 2200) * flicker;
      } else {
        light.intensity = 0;
      }
    }
  }

  /**
   * Projects a 3D world position into normalized 0..1 screen coordinates for native-res HUD callouts.
   */
  projectToScreen(worldPos) {
    if (!worldPos) {
      return { x: -1, y: -1, visible: false, behind: true };
    }
    this._projVec.set(worldPos.x, worldPos.y ?? 20, worldPos.z);

    this.camera.getWorldDirection(this._camForward);
    this._toTarget.subVectors(this._projVec, this.camera.position);
    const behind = this._toTarget.dot(this._camForward) <= 0.5;

    this._projVec.project(this.camera);
    const x = this._projVec.x * 0.5 + 0.5;
    const y = 0.5 - this._projVec.y * 0.5;
    const visible = !behind && x >= -0.05 && x <= 1.05 && y >= -0.05 && y <= 1.05;

    return { x, y, visible, behind };
  }

  getCamera() {
    return this.camera;
  }

  getStats() {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      renderWidth: this._renderWidth,
      renderHeight: this._renderHeight,
      remoteCount: this._remoteFleet ? this._remoteFleet.activeCount : 0,
    };
  }

  /**
   * Updates internal WebGL render buffer size preserving crisp ~360px short-side retro pixelation
   * in BOTH landscape (width >= height, e.g. 640x360) and portrait (height > width, e.g. 360x780),
   * adapting vertical FOV cleanly in portrait so aircraft & horizon stay nicely framed.
   */
  resize() {
    const viewW = Math.max(1, window.innerWidth || this.canvas.clientWidth || 1280);
    const viewH = Math.max(1, window.innerHeight || this.canvas.clientHeight || 720);
    const aspect = viewW / viewH;

    if (aspect >= 1.0) {
      this._renderHeight = TARGET_RENDER_HEIGHT;
      this._renderWidth = Math.max(320, Math.round(TARGET_RENDER_HEIGHT * aspect));
      this.camera.fov = 52;
    } else {
      const safeAspect = Math.max(0.35, aspect);
      this._renderWidth = TARGET_RENDER_HEIGHT;
      this._renderHeight = Math.max(360, Math.round(TARGET_RENDER_HEIGHT / safeAspect));
      // Preserve comfortable horizontal wingspan framing on vertical phone screens (52..78 deg vFOV)
      const minHalfHFovRad = (28 * Math.PI) / 180;
      const computedVFov = (2 * Math.atan(Math.tan(minHalfHFovRad) / safeAspect) * 180) / Math.PI;
      this.camera.fov = Math.max(52, Math.min(78, computedVFov));
    }

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this._renderWidth, this._renderHeight, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    if (this._skybox) this._skybox.dispose();
    if (this._water) this._water.dispose();
    if (this._world) this._world.dispose();
    if (this._vfx) this._vfx.dispose();
    if (this._heroPlane) this._heroPlane.dispose();
    if (this._remoteFleet) this._remoteFleet.dispose();
    this.renderer.dispose();
  }
}
