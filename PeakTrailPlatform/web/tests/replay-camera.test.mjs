import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { ReplayCamera, REPLAY_CAMERA_HELP } from "../src/replay-camera.js";

class Surface {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  emit(name, properties = {}) {
    const event = { target: this, defaultPrevented: false, ...properties,
      preventDefault() { this.defaultPrevented = true; },
      composedPath() { return [this.target]; } };
    for (const listener of this.listeners.get(name) || []) listener(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

function harness({ tabIndex = null } = {}) {
  const document = new Surface();
  document.defaultView = new Surface();
  document.hidden = false;
  const canvas = new Surface();
  canvas.ownerDocument = document;
  canvas.tagName = "CANVAS";
  canvas.attributes = new Map(tabIndex === null ? [] : [["tabindex", String(tabIndex)]]);
  canvas.getAttribute = (name) => canvas.attributes.get(name) ?? null;
  canvas.setAttribute = (name, value) => canvas.attributes.set(name, String(value));
  canvas.removeAttribute = (name) => canvas.attributes.delete(name);
  Object.defineProperty(canvas, "tabIndex", {
    get: () => Number(canvas.getAttribute("tabindex") ?? -1),
    set: (value) => canvas.setAttribute("tabindex", value),
  });
  canvas.focus = () => { document.activeElement = canvas; };
  canvas.captured = new Set();
  canvas.setPointerCapture = (id) => canvas.captured.add(id);
  canvas.hasPointerCapture = (id) => canvas.captured.has(id);
  canvas.releasePointerCapture = (id) => canvas.captured.delete(id);
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.5, 3200);
  camera.position.set(60, 85, -70);
  camera.lookAt(0, 0, 0);
  const controls = { target: new THREE.Vector3(), enabled: true, enableDamping: true,
    autoRotate: false, minDistance: 2, maxDistance: 12000, maxPolarAngle: Math.PI * 0.495,
    update() { this.updateCount = (this.updateCount || 0) + 1; } };
  const changes = [];
  const replay = new ReplayCamera({ THREE, camera, controls, canvas, onModeChange: (mode) => changes.push(mode) });
  const key = (code, properties) => canvas.emit("keydown", { code, ...properties });
  const up = (code) => canvas.emit("keyup", { code });
  return { replay, camera, controls, canvas, document, changes, key, up };
}

function vector(actual, expected, epsilon = 1e-8) {
  actual.toArray().forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon,
    `axis ${index}: expected ${expected[index]}, got ${value}`));
}

test("free camera preserves the survey view and restores orbit settings exactly", () => {
  const { replay, camera, controls, changes } = harness();
  const position = camera.position.clone();
  const quaternion = camera.quaternion.clone();
  const target = controls.target.clone();
  const limits = [controls.minDistance, controls.maxDistance, controls.maxPolarAngle];
  controls.autoRotate = true;
  replay.setMode("free");
  assert.equal(replay.mode, "free");
  assert.equal(controls.enabled, false);
  assert.equal(controls.autoRotate, false);
  assert.equal(controls.enableDamping, true);
  assert.equal(camera.near, 0.05);
  assert.equal(camera.far, 3200);
  assert.equal(controls.updateCount, 1);
  vector(camera.position, position.toArray());
  replay.enterAt([1, 2, 3]);
  replay.setMode("orbit");
  vector(camera.position, position.toArray());
  assert.ok(camera.quaternion.equals(quaternion));
  vector(controls.target, target.toArray());
  assert.equal(camera.near, 0.5);
  assert.equal(controls.enabled, true);
  assert.equal(controls.autoRotate, true);
  assert.deepEqual([controls.minDistance, controls.maxDistance, controls.maxPolarAngle], limits);
  assert.deepEqual(changes, ["free", "orbit"]);
});

test("interior placement uses the exact renderer-space point and requested facing", () => {
  const { replay, camera, controls, canvas, document } = harness();
  replay.enterAt([-221, 492.6, 822], [1, 0, 0]);
  vector(camera.position, [-221, 492.6, 822]);
  vector(camera.getWorldDirection(new THREE.Vector3()), [1, 0, 0]);
  vector(controls.target, [-215, 492.6, 822]);
  assert.equal(document.activeElement, canvas);
  replay.enterAt(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, 1));
  vector(camera.getWorldDirection(new THREE.Vector3()), [0, 0, 1]);
});

test("WASD movement follows view yaw rather than world axes", () => {
  const { replay, camera, key, up } = harness();
  replay.enterAt([0, 4, 0], [1, 0, 0]);
  assert.equal(key("KeyW").defaultPrevented, true);
  replay.update(0.05);
  vector(camera.position, [0.5, 4, 0]);
  up("KeyW");
  key("KeyD");
  replay.update(0.05);
  vector(camera.position, [0.5, 4, 0.5]);
  up("KeyD");
  key("KeyS");
  replay.update(0.05);
  vector(camera.position, [0, 4, 0.5]);
  up("KeyS");
  key("KeyA");
  replay.update(0.05);
  vector(camera.position, [0, 4, 0]);
});

test("walking stays horizontal while looking up; Q and E alone move vertically", () => {
  const { replay, camera, key, up } = harness();
  replay.enterAt([0, 0, 0], [0, 1, -1]);
  key("KeyW");
  replay.update(0.05);
  vector(camera.position, [0, 0, -0.5]);
  up("KeyW");
  key("KeyE");
  replay.update(0.05);
  vector(camera.position, [0, 0.5, -0.5]);
  up("KeyE");
  key("KeyQ");
  replay.update(0.05);
  vector(camera.position, [0, 0, -0.5]);
});

test("diagonal and vertical combinations do not accelerate beyond configured speed", () => {
  const { replay, camera, key } = harness();
  replay.enterAt([0, 0, 0], [0, 0, -1]);
  key("KeyW"); key("KeyD"); key("KeyE");
  replay.update(0.05);
  assert.ok(Math.abs(camera.position.length() - 0.5) < 1e-8);
  assert.ok(camera.position.x > 0 && camera.position.y > 0 && camera.position.z < 0);
});

test("Shift accelerates but returning from a stalled or hidden tab never teleports", () => {
  const { replay, camera, key, up } = harness();
  replay.enterAt([0, 0, 0], [0, 0, -1]);
  key("KeyW"); key("ShiftRight");
  replay.update(100);
  vector(camera.position, [0, 0, -1.5]);
  for (const dt of [0, -1, NaN, Infinity, undefined]) assert.equal(replay.update(dt), false);
  vector(camera.position, [0, 0, -1.5]);
  up("ShiftRight");
  replay.update(0.025);
  vector(camera.position, [0, 0, -1.75]);
});

test("opposite keys cancel without moving and keyup stops movement", () => {
  const { replay, camera, key, up } = harness();
  replay.enterAt([0, 0, 0]);
  key("KeyW"); key("KeyS"); key("KeyQ"); key("KeyE");
  assert.equal(replay.update(0.05), false);
  vector(camera.position, [0, 0, 0]);
  up("KeyW"); up("KeyS"); up("KeyQ"); up("KeyE");
  assert.equal(replay.update(0.05), false);
});

test("keyboard events stay untouched in orbit, outside canvas focus, or in forms", () => {
  const { replay, camera, document, key } = harness();
  assert.equal(key("KeyW").defaultPrevented, false);
  replay.enterAt([0, 0, 0]);
  document.activeElement = { tagName: "BUTTON" };
  assert.equal(key("KeyW").defaultPrevented, false);
  replay.focus();
  for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "DIV", isContentEditable: true }, { tagName: "SPAN", closest: () => ({}) }]) {
    assert.equal(key("KeyW", { target }).defaultPrevented, false);
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
    assert.equal(key("KeyW", { [modifier]: true }).defaultPrevented, false);
  }
  assert.equal(key("Space").defaultPrevented, false);
  assert.equal(key("Tab").defaultPrevented, false);
  assert.equal(replay.update(0.05), false);
  vector(camera.position, [0, 0, 0]);
});

test("blur, document hiding and focus changes clear held movement keys", () => {
  const { replay, camera, canvas, document, key } = harness();
  replay.enterAt([0, 0, 0]);
  for (const clear of [() => canvas.emit("blur"), () => document.defaultView.emit("blur"),
    () => { document.hidden = true; document.emit("visibilitychange"); document.hidden = false; },
    () => { document.activeElement = null; replay.update(0.05); replay.focus(); }]) {
    key("KeyW");
    clear();
    assert.equal(replay.update(0.05), false);
  }
  vector(camera.position, [0, 0, 0]);
});

test("drag turns the camera without pointer lock and clamps near vertical pitch", () => {
  const { replay, camera, canvas, document } = harness();
  replay.enterAt([0, 0, 0], [0, 0, -1]);
  canvas.emit("pointerdown", { pointerId: 7, button: 0, clientX: 100, clientY: 100 });
  assert.equal(canvas.captured.has(7), true);
  document.emit("pointermove", { pointerId: 99, clientX: 200, clientY: 100 });
  vector(camera.getWorldDirection(new THREE.Vector3()), [0, 0, -1]);
  document.emit("pointermove", { pointerId: 7, clientX: 200, clientY: 100 });
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).x > 0);
  document.emit("pointermove", { pointerId: 7, clientX: 200, clientY: -100000 });
  assert.equal(replay.euler.x, Math.PI * 0.495);
  assert.equal(replay.euler.z, 0);
  document.emit("pointerup", { pointerId: 7 });
  assert.equal(canvas.captured.has(7), false);
  const facing = camera.quaternion.clone();
  document.emit("pointermove", { pointerId: 7, clientX: 0, clientY: 0 });
  assert.ok(camera.quaternion.equals(facing));
});

test("lost focus and cancelled pointers release capture and stop drag", () => {
  const { replay, canvas, document } = harness();
  replay.enterAt([0, 0, 0]);
  for (const cancel of [() => canvas.emit("blur"), () => document.emit("pointercancel", { pointerId: 1 })]) {
    canvas.emit("pointerdown", { pointerId: 1, button: 2, clientX: 0, clientY: 0 });
    cancel();
    assert.equal(canvas.captured.size, 0);
    assert.equal(replay.pointer, null);
  }
});

test("Escape exits free view without consuming Escape in other controls", () => {
  const { replay, canvas, key, document } = harness();
  replay.enterAt([1, 2, 3]);
  document.activeElement = {};
  assert.equal(key("Escape").defaultPrevented, false);
  assert.equal(replay.mode, "free");
  canvas.focus();
  assert.equal(key("Escape").defaultPrevented, true);
  assert.equal(replay.mode, "orbit");
});

test("invalid poses fail before changing mode or viewpoint", () => {
  const { replay, camera } = harness();
  const position = camera.position.toArray();
  for (const point of [null, [1, 2], [0, NaN, 0], [0, Infinity, 1]]) {
    assert.throws(() => replay.enterAt(point), TypeError);
  }
  assert.throws(() => replay.enterAt([0, 0, 0], [0, 0, 0]), TypeError);
  assert.throws(() => replay.setMode("walk"), TypeError);
  assert.equal(replay.mode, "orbit");
  vector(camera.position, position);
});

test("orbit damping is flushed once but the snapshot does not inherit its extra movement", () => {
  const { replay, camera, controls } = harness();
  const position = camera.position.toArray();
  controls.update = () => {
    assert.equal(controls.enableDamping, false);
    assert.equal(controls.autoRotate, false);
    camera.position.addScalar(100);
    controls.target.addScalar(10);
  };
  replay.setMode("free");
  vector(camera.position, position);
  replay.setMode("orbit");
  vector(camera.position, position);
  vector(controls.target, [0, 0, 0]);
});

test("dispose restores original tab order and controls, removing every listener", () => {
  for (const tabIndex of [null, -1, 2]) {
    const { replay, controls, canvas, document, key } = harness({ tabIndex });
    assert.ok(canvas.tabIndex >= 0);
    replay.enterAt([1, 2, 3]);
    key("KeyW");
    canvas.emit("pointerdown", { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    replay.dispose();
    assert.equal(canvas.getAttribute("tabindex"), tabIndex === null ? null : String(tabIndex));
    assert.equal(controls.enabled, true);
    assert.equal(canvas.captured.size, 0);
    assert.equal(canvas.listenerCount() + document.listenerCount() + document.defaultView.listenerCount(), 0);
    assert.equal(replay.update(0.05), false);
    replay.dispose();
    replay.setMode("free");
    assert.equal(replay.mode, "orbit");
  }
});

test("help text explains vertical movement, focus and non-physical spectator navigation", () => {
  for (const term of ["点击地图", "WASD", "Q / E", "Shift", "Esc", "穿过墙体"]) {
    assert.ok(REPLAY_CAMERA_HELP.includes(term));
  }
});

test("automatic interior placement can preserve focus on playback controls and inputs", () => {
  const { replay, document, canvas } = harness();
  const input = { tagName: "INPUT" };
  document.activeElement = input;
  replay.setMode("free", { focus: false });
  assert.equal(document.activeElement, input);
  replay.enterAt([1, 2, 3], [0, 0, 1], { focus: false });
  assert.equal(document.activeElement, input);
  replay.setMode("orbit");
  replay.enterAt([2, 3, 4], [1, 0, 0], { focus: false });
  assert.equal(document.activeElement, input);
  replay.enterAt([2, 3, 4]);
  assert.equal(document.activeElement, canvas);
});
