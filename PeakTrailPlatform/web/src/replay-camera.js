const MOVEMENT_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
const TOUCH_DIRECTIONS = new Set(["forward", "back", "left", "right", "up", "down"]);
const MAX_FRAME_SECONDS = 0.05;
const MAX_PITCH = Math.PI * 0.495;

export const REPLAY_CAMERA_HELP = "点击地图后：WASD 前后左右，Q / E 下降 / 上升，Shift 加速，按住鼠标拖动转向，Esc 返回环绕视角。触屏可按住方向按钮移动，拖动地图转向。自由相机可穿过墙体，不模拟玩家碰撞。";

function typingTarget(target) {
  return Boolean(target && (target.isContentEditable
    || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
    || target.closest?.("[contenteditable]:not([contenteditable='false']), input, textarea, select")));
}

function finitePoint(value) {
  const values = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
  return values.length >= 3 && values.slice(0, 3).every(Number.isFinite) ? values : null;
}

/**
 * A focus-scoped, non-pointer-lock spectator camera. Points passed to enterAt
 * are renderer/world coordinates, already adjusted for origin and height scale.
 * Calling setMode("orbit") returns to the saved survey view; fit/top presets can
 * then replace that view. The owning scene must NOT update OrbitControls while
 * mode === "free" (disabled controls still apply damping in update()).
 */
export class ReplayCamera {
  constructor({ THREE, camera, controls, canvas, speed = 10, fastMultiplier = 3,
    lookSensitivity = 0.003, onModeChange = null }) {
    this.THREE = THREE;
    this.camera = camera;
    this.controls = controls;
    this.canvas = canvas;
    this.document = canvas.ownerDocument;
    this.window = this.document?.defaultView;
    this.speed = Number.isFinite(speed) && speed > 0 ? speed : 10;
    this.fastMultiplier = Number.isFinite(fastMultiplier) && fastMultiplier >= 1 ? fastMultiplier : 3;
    this.lookSensitivity = Number.isFinite(lookSensitivity) && lookSensitivity > 0 ? lookSensitivity : 0.003;
    this.onModeChange = onModeChange;
    this.mode = "orbit";
    this.disposed = false;
    this.keys = new Set();
    this.touchMovement = new Map();
    this.pointer = null;
    this.savedOrbit = null;
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.movement = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.originalTabIndex = canvas.getAttribute("tabindex");
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    this.listeners = [];
    this.listen(canvas, "keydown", (event) => this.onKeyDown(event));
    this.listen(canvas, "keyup", (event) => this.keys.delete(event.code));
    this.listen(canvas, "blur", () => this.clearInput());
    this.listen(this.window, "blur", () => this.clearInput());
    this.listen(this.document, "visibilitychange", () => {
      if (this.document.hidden) this.clearInput();
    });
    this.listen(canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.listen(this.document || canvas, "pointermove", (event) => this.onPointerMove(event));
    for (const name of ["pointerup", "pointercancel"]) {
      this.listen(this.document || canvas, name, (event) => {
        this.releasePointer(event.pointerId);
        this.touchMovement.delete(event.pointerId);
      });
    }
    this.listen(canvas, "lostpointercapture", () => { this.pointer = null; });
    this.listen(canvas, "contextmenu", (event) => {
      if (this.mode === "free" && this.isFocused()) event.preventDefault();
    });
  }

  listen(target, name, callback) {
    target?.addEventListener(name, callback);
    this.listeners.push([target, name, callback]);
  }

  isFocused() {
    return this.document?.activeElement === this.canvas;
  }

  focus() {
    if (!this.disposed) this.canvas.focus({ preventScroll: true });
  }

  clearInput() {
    this.keys.clear();
    this.clearTouchMovement();
    this.releasePointer();
  }

  /**
   * Hold/release a touch-pad direction without synthesizing keyboard events.
   * Bindings should preventDefault on pointerdown, capture that pointer on the
   * button and pass its pointerId on both press and release/cancel. A source is
   * idempotent; multiple pointers may hold the same direction independently.
   */
  setTouchMovement(direction, active, sourceId = direction) {
    if (!TOUCH_DIRECTIONS.has(direction)) return false;
    if (!active) {
      if (this.touchMovement.get(sourceId) === direction) this.touchMovement.delete(sourceId);
      return true;
    }
    if (this.disposed || this.mode !== "free" || this.document?.hidden) return false;
    this.focus();
    if (!this.isFocused()) return false;
    this.touchMovement.set(sourceId, direction);
    return true;
  }

  clearTouchMovement() {
    this.touchMovement.clear();
  }

  releasePointer(pointerId = this.pointer?.id) {
    if (!this.pointer || pointerId !== this.pointer.id) return;
    const id = this.pointer.id;
    this.pointer = null;
    try {
      if (this.canvas.hasPointerCapture?.(id)) this.canvas.releasePointerCapture(id);
    } catch { /* A removed canvas or a cancelled native pointer may lose capture first. */ }
  }

  onKeyDown(event) {
    if (this.mode !== "free" || !this.isFocused() || event.defaultPrevented
      || event.ctrlKey || event.metaKey || event.altKey
      || typingTarget(event.target) || event.composedPath?.().some(typingTarget)) return;
    if (event.code === "Escape") {
      event.preventDefault();
      this.setMode("orbit");
    } else if (MOVEMENT_KEYS.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    }
  }

  onPointerDown(event) {
    // A pad finger can be the primary pointer while a second finger looks.
    // Never replace a currently captured look gesture with another finger.
    if ((event.isPrimary === false && event.pointerType !== "touch")
      || (event.pointerType === "touch" && this.pointer)
      || (event.button !== 0 && event.button !== 2)) return;
    this.focus();
    if (this.mode !== "free") return;
    event.preventDefault();
    this.releasePointer();
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { this.canvas.setPointerCapture?.(event.pointerId); } catch { /* Capture is optional. */ }
  }

  onPointerMove(event) {
    if (this.mode !== "free" || !this.isFocused() || this.pointer?.id !== event.pointerId) return;
    const dx = event.clientX - this.pointer.x;
    const dy = event.clientY - this.pointer.y;
    this.pointer.x = event.clientX;
    this.pointer.y = event.clientY;
    if (!Number.isFinite(dx + dy)) return;
    event.preventDefault();
    this.euler.y -= dx * this.lookSensitivity;
    this.euler.y = Math.atan2(Math.sin(this.euler.y), Math.cos(this.euler.y));
    this.euler.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.euler.x - dy * this.lookSensitivity));
    this.euler.z = 0;
    this.camera.quaternion.setFromEuler(this.euler);
    this.syncFreeTarget();
  }

  setMode(mode, { focus = true } = {}) {
    if (mode !== "free" && mode !== "orbit") throw new TypeError(`Unknown replay camera mode: ${mode}`);
    if (this.disposed || this.mode === mode) return;
    this.clearInput();
    if (mode === "free") {
      this.savedOrbit = {
        position: this.camera.position.clone(), quaternion: this.camera.quaternion.clone(),
        up: this.camera.up.clone(), target: this.controls.target.clone(),
        near: this.camera.near, enabled: this.controls.enabled,
        enableDamping: this.controls.enableDamping, autoRotate: this.controls.autoRotate,
      };
      // Flush any accumulated damping without carrying its final movement into
      // the free view or applying it when the user later returns to orbit.
      this.controls.enableDamping = false;
      this.controls.autoRotate = false;
      this.controls.update();
      this.camera.position.copy(this.savedOrbit.position);
      this.camera.quaternion.copy(this.savedOrbit.quaternion);
      this.controls.target.copy(this.savedOrbit.target);
      this.controls.enableDamping = this.savedOrbit.enableDamping;
      this.controls.enabled = false;
      this.camera.up.set(0, 1, 0);
      this.camera.near = Math.min(this.savedOrbit.near, 0.05);
      this.camera.updateProjectionMatrix();
      this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
      this.euler.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.euler.x));
      this.euler.z = 0;
      this.camera.quaternion.setFromEuler(this.euler);
      this.syncFreeTarget();
    } else if (this.savedOrbit) {
      const saved = this.savedOrbit;
      this.camera.position.copy(saved.position);
      this.camera.quaternion.copy(saved.quaternion);
      this.camera.up.copy(saved.up);
      this.camera.near = saved.near;
      this.camera.updateProjectionMatrix();
      this.controls.target.copy(saved.target);
      this.controls.enableDamping = saved.enableDamping;
      this.controls.autoRotate = saved.autoRotate;
      this.controls.enabled = saved.enabled;
      this.savedOrbit = null;
    }
    this.mode = mode;
    if (mode === "free" && focus) this.focus();
    this.onModeChange?.(mode);
  }

  enterAt(point, direction = [0, 0, 1], { focus = true } = {}) {
    const positionValues = finitePoint(point);
    const directionValues = finitePoint(direction);
    if (!positionValues || !directionValues) throw new TypeError("Camera position and direction must be finite XYZ coordinates");
    this.direction.fromArray(directionValues);
    if (this.direction.lengthSq() < 1e-12) throw new TypeError("Camera direction must be nonzero");
    if (this.disposed) return;
    this.setMode("free", { focus });
    this.clearInput();
    this.direction.fromArray(directionValues);
    this.camera.position.fromArray(positionValues);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.movement.copy(this.camera.position).add(this.direction.normalize()));
    this.euler.setFromQuaternion(this.camera.quaternion, "YXZ");
    this.euler.x = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.euler.x));
    this.euler.z = 0;
    this.camera.quaternion.setFromEuler(this.euler);
    this.syncFreeTarget();
    if (focus) this.focus();
  }

  syncFreeTarget() {
    this.camera.getWorldDirection(this.direction);
    this.controls.target.copy(this.camera.position).addScaledVector(this.direction, 6);
  }

  update(deltaSeconds) {
    if (this.disposed || this.mode !== "free") return false;
    if (!this.isFocused() || this.document?.hidden) {
      this.clearInput();
      return false;
    }
    const elapsed = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(MAX_FRAME_SECONDS, deltaSeconds)) : 0;
    if (!elapsed || (!this.keys.size && !this.touchMovement.size)) return false;
    const yaw = this.euler.y;
    this.forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.right.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const touch = new Set(this.touchMovement.values());
    const held = (key, direction) => Number(this.keys.has(key) || touch.has(direction));
    const forward = held("KeyW", "forward") - held("KeyS", "back");
    const sideways = held("KeyD", "right") - held("KeyA", "left");
    const vertical = held("KeyE", "up") - held("KeyQ", "down");
    this.movement.copy(this.forward).multiplyScalar(forward).addScaledVector(this.right, sideways);
    this.movement.y = vertical;
    if (this.movement.lengthSq() < 1e-12) return false;
    const fast = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? this.fastMultiplier : 1;
    this.camera.position.addScaledVector(this.movement.normalize(), this.speed * fast * elapsed);
    this.syncFreeTarget();
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.setMode("orbit");
    this.clearInput();
    for (const [target, name, callback] of this.listeners) target?.removeEventListener(name, callback);
    this.listeners.length = 0;
    if (this.originalTabIndex === null) this.canvas.removeAttribute("tabindex");
    else this.canvas.setAttribute("tabindex", this.originalTabIndex);
    this.disposed = true;
  }
}
