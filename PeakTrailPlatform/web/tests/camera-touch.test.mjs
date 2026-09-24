import assert from "node:assert/strict";
import test from "node:test";
import { bindCameraTouchControls } from "../src/camera-touch.js";

class Target extends EventTarget {
  constructor() { super(); this.attributes = new Map(); this.capture = new Set(); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture(id) { this.capture.add(id); }
  hasPointerCapture(id) { return this.capture.has(id); }
  releasePointerCapture(id) { this.capture.delete(id); }
  emit(name, props = {}) {
    const event = new Event(name, { cancelable: true });
    Object.assign(event, props);
    this.dispatchEvent(event);
    return event;
  }
}
function setup() {
  const window = new Target(), document = new Target(), canvas = new Target(), root = new Target();
  document.defaultView = window;
  root.ownerDocument = document;
  const buttons = ["forward", "left", "up"].map((direction) => {
    const button = new Target(); button.dataset = { cameraMove: direction }; return button;
  });
  root.querySelectorAll = () => buttons;
  const calls = [];
  const camera = { mode: "free", setTouchMovement: (...args) => { calls.push(args); return true; } };
  let currentCamera = camera;
  const dispose = bindCameraTouchControls({ root, canvas, getCamera: () => currentCamera });
  return { window, document, canvas, root, buttons, camera, calls, dispose, replace: () => { currentCamera = null; } };
}

test("hold buttons preserve focus, capture each finger and release the original camera", () => {
  const { buttons, document, calls, replace } = setup();
  assert.equal(buttons[0].emit("pointerdown", { button: 0, pointerId: 1 }).defaultPrevented, true);
  buttons[1].emit("pointerdown", { button: 0, pointerId: 2 });
  assert.equal(buttons[0].capture.has(1), true);
  replace();
  document.emit("pointerup", { pointerId: 1 });
  assert.equal(buttons[0].attributes.has("data-held"), false);
  assert.equal(buttons[1].attributes.has("data-held"), true);
  document.emit("pointercancel", { pointerId: 2 });
  assert.deepEqual(calls, [["forward", true, 1], ["left", true, 2], ["forward", false, 1], ["left", false, 2]]);
});

test("multiple fingers on the same button retain its held appearance until all release", () => {
  const { buttons, document } = setup();
  for (const pointerId of [1, 2]) buttons[0].emit("pointerdown", { button: 0, pointerId });
  buttons[0].emit("lostpointercapture", { pointerId: 1 });
  assert.equal(buttons[0].attributes.has("data-held"), true);
  document.emit("pointerup", { pointerId: 2 });
  assert.equal(buttons[0].attributes.has("data-held"), false);
});

test("hidden/orbit controls ignore presses; keyboard hold uses document release without repeat", () => {
  const { buttons, root, camera, document, calls } = setup();
  root.hidden = true; buttons[0].emit("pointerdown", { button: 0, pointerId: 1 });
  root.hidden = false; camera.mode = "orbit"; buttons[0].emit("pointerdown", { button: 0, pointerId: 1 });
  camera.mode = "free";
  buttons[0].emit("pointerdown", { button: 2, pointerId: 1 });
  assert.equal(calls.length, 0);
  assert.equal(buttons[2].emit("keydown", { code: "Space" }).defaultPrevented, true);
  buttons[2].emit("keydown", { code: "Space", repeat: true });
  assert.equal(document.emit("keydown", { code: "Space", repeat: true }).defaultPrevented, true);
  assert.equal(document.emit("keydown", { code: "KeyW", repeat: true }).defaultPrevented, false);
  document.emit("keyup", { code: "Space" });
  assert.equal(document.emit("keydown", { code: "Space", repeat: true }).defaultPrevented, false);
  assert.deepEqual(calls, [["up", true, "key:Space"], ["up", false, "key:Space"]]);
});

test("blur, hidden page, mode changes and disposal cannot leave movement held", () => {
  for (const reason of ["blur", "pagehide", "visibilitychange", "canvasblur", "cameramodechange", "dispose"]) {
    const { buttons, window, document, canvas, calls, dispose } = setup();
    buttons[0].emit("pointerdown", { button: 0, pointerId: 1 });
    if (reason === "dispose") dispose();
    else if (reason === "visibilitychange") { document.hidden = true; document.emit(reason); }
    else if (reason === "canvasblur") canvas.emit("blur");
    else if (reason === "cameramodechange") canvas.emit(reason);
    else window.emit(reason);
    assert.deepEqual(calls.at(-1), ["forward", false, 1], reason);
    assert.equal(buttons[0].capture.size, 0);
    dispose();
    const previous = calls.length;
    buttons[0].emit("pointerdown", { button: 0, pointerId: 2 });
    assert.equal(calls.length, previous);
  }
});
