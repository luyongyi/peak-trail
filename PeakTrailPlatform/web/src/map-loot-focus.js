import { lootTypeStyle, MAP_LOOT_MAX_BEAM_HEIGHT } from "./map-loot-style.js";

const CONTROL_FIELDS = ["enabled", "enableDamping", "autoRotate", "minDistance", "maxDistance",
  "minPolarAngle", "maxPolarAngle", "minAzimuthAngle", "maxAzimuthAngle", "minTargetRadius", "maxTargetRadius",
  "enablePan", "enableRotate", "enableZoom", "screenSpacePanning", "rotateSpeed", "panSpeed", "zoomSpeed"];

function cloneOrbit(value) {
  if (!value) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item?.clone ? item.clone() : item]));
}

/** Keep the long outdoor view when its real line of sight is open. A roof or
 * wall switches the search to low, short views on the item's own side of it. */
export function chooseMapLootFocusPose({ THREE, anchor, direction, distance, query = null, interiorReference = null }) {
  const target = anchor.clone().add(new THREE.Vector3(0, 4, 0));
  const primary = { target, position: target.clone().addScaledVector(direction, distance) };
  if (!query?.cast) return primary;
  const subject = anchor.clone().add(new THREE.Vector3(0, 1.2, 0));
  const ray = new THREE.Vector3();
  const clearLine = (position, point) => {
    ray.copy(point).sub(position);
    const length = ray.length();
    if (length < 0.3) return false;
    ray.divideScalar(length);
    // Leave only the final 30 cm to the prop itself: a nearby room wall must
    // still block the camera rather than being mistaken for the selected item.
    return !query.cast(position, ray, length - 0.3);
  };
  if (clearLine(primary.position, subject)) return primary;

  const preferred = Math.atan2(direction.x, direction.z);
  const inward = interiorReference && Number.isFinite(interiorReference.x) && Number.isFinite(interiorReference.z)
    ? Math.atan2(interiorReference.x - anchor.x, interiorReference.z - anchor.z) : preferred;
  const angles = [...new Set([inward, preferred, ...[1, -1, 2, -2, 3, -3, 4, -4, 6].map(step => inward + step * Math.PI / 6)])];
  const candidateDirection = new THREE.Vector3(), side = new THREE.Vector3(), probe = new THREE.Vector3();
  let best = null;
  const evaluate = (aim, requestedDistance, angle, pitch, compact) => {
    candidateDirection.set(Math.sin(angle) * Math.cos(pitch), Math.sin(pitch), Math.cos(angle) * Math.cos(pitch));
    const position = aim.clone().addScaledVector(candidateDirection, requestedDistance);
    if (!clearLine(position, subject)) return;
    side.set(candidateDirection.z, 0, -candidateDirection.x).normalize();
    let openness = 0;
    for (const [horizontal, vertical] of [[-0.5, 0], [0.5, 0], [0, 0.5], [0, -0.5]]) {
      probe.copy(subject).addScaledVector(side, horizontal); probe.y += vertical;
      if (clearLine(position, probe)) openness++;
    }
    if (openness < 2) return;
    // Source enclosure axes guide the search, but never replace triangle
    // visibility: an inward candidate behind a wall is rejected above.
    const score = openness * 3 + Math.min(requestedDistance, 10) * 0.16
      + Math.cos(angle - preferred) * 0.35 + Math.cos(angle - inward) * 0.45
      - Math.abs(pitch - 0.1) * 0.4 + (compact ? 0 : 0.4);
    if (!best || score > best.score) best = { position, target: aim.clone(), score };
  };
  // Look for an unobstructed long view around an outdoor rock before going
  // inside. An actual low ceiling makes those high candidates inapplicable.
  const ceiling = query.cast(subject, new THREE.Vector3(0, 1, 0), 8);
  if (!ceiling || ceiling.distance > 6) for (const angle of angles) evaluate(target, distance, angle, 0.5, false);
  if (best) return { position: best.position, target: best.target };
  for (const requestedDistance of [10, 7, 5, 3, 2]) {
    for (const angle of angles) for (const pitch of [0.1, 0, 0.25]) evaluate(subject, requestedDistance, angle, pitch, true);
  }
  if (best) return { position: best.position, target: best.target };
  // Very narrow geometry can have no open 2 m boom. Keep the camera on the
  // subject's side of the nearest measured surface, never beyond the wall.
  let fallback = null;
  for (const angle of angles) {
    candidateDirection.set(Math.sin(angle), 0.06, Math.cos(angle)).normalize();
    const hit = query.cast(subject, candidateDirection, 2.4);
    const reach = hit ? Math.max(0.35, hit.distance - 0.3) : 2.4;
    if (!fallback || reach > fallback.reach) fallback = { reach, position: subject.clone().addScaledVector(candidateDirection, reach) };
  }
  return { target: subject, position: fallback.position };
}

/** One reversible close-up, independent of rendering and the replay clock. */
export class MapLootFocus {
  constructor(scene, THREE, { duration = 650, now = () => performance.now(), reducedMotion = () =>
    Boolean(scene.canvas.ownerDocument?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) } = {}) {
    this.scene = scene;
    this.THREE = THREE;
    this.duration = duration;
    this.now = now;
    this.reducedMotion = reducedMotion;
    this.snapshot = null;
    this.marker = null;
    this.animation = null;
  }

  capture() {
    const { camera, controls, freeCamera, followTargetId, surveyPreset } = this.scene;
    const config = Object.fromEntries(CONTROL_FIELDS.filter(key => controls[key] !== undefined).map(key => [key, controls[key]]));
    // A player-follow pose becomes an ordinary, operable static orbit on return.
    if (followTargetId != null) config.enabled = true;
    return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(),
      target: controls.target.clone(), near: camera.near, far: camera.far,
      config, mode: freeCamera.mode, savedOrbit: cloneOrbit(freeCamera.savedOrbit), surveyPreset };
  }

  emit() {
    const marker = this.marker;
    this.scene.canvas.dispatchEvent(new CustomEvent("peaktrail-loot-focus", { detail: marker
      ? { active: true, markerId: marker.id, name: marker.name, type: marker.type, category: marker.category }
      : { active: false, markerId: null, name: null, type: null, category: null } }));
  }

  flushControls() {
    const { camera, controls } = this.scene;
    const pose = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), target: controls.target.clone() };
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.update();
    camera.position.copy(pose.position);
    camera.quaternion.copy(pose.quaternion);
    controls.target.copy(pose.target);
  }

  setCameraMode(mode) {
    this.changingMode = true;
    try { this.scene.freeCamera.setMode(mode, { focus: false }); }
    finally { this.changingMode = false; }
  }

  focus(marker, pointerSnapshot = null) {
    if (!Array.isArray(marker?.pos) || !marker.pos.every(Number.isFinite)) return false;
    if (this.marker?.id === marker.id) return this.restore();
    const scene = this.scene, { camera, controls } = scene;
    const original = this.snapshot || pointerSnapshot || this.capture();
    const start = this.capture();
    scene.setFollowTarget(null);
    this.setCameraMode("orbit");
    camera.position.copy(start.position); camera.quaternion.copy(start.quaternion); camera.up.copy(start.up);
    camera.near = start.near; camera.far = start.far; controls.target.copy(start.target);
    this.snapshot = original;
    this.marker = marker;
    scene.surveyPreset = null;
    ++scene.cameraSelectionRevision;
    this.flushControls();
    const anchor = new this.THREE.Vector3(marker.pos[0] - scene.origin.x,
      (marker.pos[1] - scene.origin.y) * scene.heightScale, -(marker.pos[2] - scene.origin.z));
    const target = anchor.clone().add(new this.THREE.Vector3(0, 4, 0));
    const direction = camera.position.clone().sub(target);
    if (direction.lengthSq() < 0.001) direction.set(0.52, 0.65, 0.62);
    direction.normalize();
    const horizontal = Math.hypot(direction.x, direction.z);
    const elevation = Math.max(0.42, Math.min(0.72, direction.y));
    if (horizontal < 0.001) direction.set(0.64, elevation, 0.77);
    else direction.set(direction.x / horizontal, elevation / Math.sqrt(1 - elevation * elevation), direction.z / horizontal);
    direction.normalize();
    const height = Math.min(MAP_LOOT_MAX_BEAM_HEIGHT, lootTypeStyle(marker.type, marker.category).beamHeight);
    const distance = Math.max(26, Math.min(35, (height - 4) * 1.22 / Math.tan(camera.fov * Math.PI / 360)));
    const terrain = scene.mapLootFocusTerrainQuery?.(marker);
    const pose = chooseMapLootFocusPose({ THREE: this.THREE, anchor, direction, distance,
      query: terrain?.query, interiorReference: terrain?.interiorReference });
    const position = pose.position;
    const destinationCamera = camera.clone();
    destinationCamera.up.set(0, 1, 0); destinationCamera.position.copy(position); destinationCamera.lookAt(pose.target);
    const destination = { position, target: pose.target, up: destinationCamera.up.clone(), quaternion: destinationCamera.quaternion.clone(),
      near: Math.min(camera.near, 0.05), far: camera.far };
    controls.minDistance = Math.min(1, controls.minDistance ?? 1);
    controls.maxDistance = Math.max(controls.maxDistance ?? 100, distance * 4);
    scene.mapLootOverlay?.setSelected?.(marker.id);
    scene.canvas.focus?.({ preventScroll: true });
    this.emit();
    this.begin(destination, false);
    return true;
  }

  begin(destination, restoring) {
    const { camera, controls } = this.scene;
    this.animation = { start: this.capture(), destination, restoring, startedAt: this.now() };
    this.flushControls();
    controls.enabled = false;
    camera.near = Math.min(camera.near, destination.near);
    camera.far = Math.max(camera.far, destination.far);
    camera.updateProjectionMatrix();
    if (this.reducedMotion() || this.duration <= 0) this.update(this.animation.startedAt + this.duration);
  }

  update(timestamp = this.now()) {
    const animation = this.animation;
    if (!animation) return false;
    const { camera, controls } = this.scene, { start, destination } = animation;
    const fraction = this.duration <= 0 ? 1 : Math.max(0, Math.min(1, (timestamp - animation.startedAt) / this.duration));
    const eased = fraction * fraction * (3 - 2 * fraction);
    camera.position.lerpVectors(start.position, destination.position, eased);
    camera.quaternion.slerpQuaternions(start.quaternion, destination.quaternion, eased);
    camera.up.lerpVectors(start.up, destination.up, eased).normalize();
    controls.target.lerpVectors(start.target, destination.target, eased);
    if (fraction === 1) {
      this.animation = null;
      if (animation.restoring) this.finishRestore();
      else this.unlock();
    }
    return true;
  }

  unlock() {
    const { controls } = this.scene;
    controls.enabled = true;
    controls.enableDamping = this.snapshot?.config.enableDamping ?? true;
    controls.autoRotate = false;
  }

  /** A drag/zoom cancels only the flight. The original return point stays valid. */
  interrupt() {
    if (!this.animation) return false;
    this.animation = null;
    this.unlock();
    return true;
  }

  restore() {
    if (!this.snapshot || !this.marker) return false;
    this.begin(this.snapshot, true);
    return true;
  }

  finishRestore() {
    const saved = this.snapshot;
    if (!saved) return;
    const { camera, controls, freeCamera } = this.scene;
    this.flushControls();
    this.setCameraMode(saved.mode);
    freeCamera.clearInput();
    freeCamera.savedOrbit = cloneOrbit(saved.savedOrbit);
    camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); camera.up.copy(saved.up);
    camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix();
    controls.target.copy(saved.target);
    Object.assign(controls, saved.config);
    freeCamera.euler?.setFromQuaternion(camera.quaternion, "YXZ");
    this.scene.surveyPreset = saved.surveyPreset;
    this.snapshot = null; this.marker = null;
    this.scene.mapLootOverlay?.setSelected?.(null);
    this.emit();
  }

  reconcile(markers) {
    if (!this.marker) return;
    const current = markers.find(marker => marker.id === this.marker.id);
    if (!current) { if (!this.animation?.restoring) this.restore(); return; }
    if (current.name !== this.marker.name || current.type !== this.marker.type || current.category !== this.marker.category) {
      this.marker = current; this.emit();
    }
  }

  clear({ restore = false } = {}) {
    if (restore) return this.restore();
    if (!this.snapshot && !this.marker) return false;
    this.interrupt();
    this.snapshot = null; this.marker = null;
    this.scene.mapLootOverlay?.setSelected?.(null);
    this.emit();
    return true;
  }
}
