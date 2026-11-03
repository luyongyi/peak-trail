import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "../../vendor/three/0.180.0/build/three.module.js";
import { createLiveCameraController } from "../src/live-camera.js";

function fixture() {
  const usable = new Set(), calls = [];
  const viewer = {
    cameraSelectionRevision: 0, followTargetId: null, followAutoRotate: false, surveyPreset: "overview",
    camera: new PerspectiveCamera(), controls: { target: new Vector3(), enableDamping: true, update() {} },
    freeCamera: { mode: "orbit", setMode(value) { this.mode = value; } }, playerObjects: new Map(),
    canFollowPlayer: id => usable.has(id),
    setFollowTarget(id, { reason = "manual" } = {}) {
      if (this.followTargetId === id) return;
      this.followTargetId = id; this.surveyPreset = null;
      this.followChangeReason = reason;
      this.followChangeRevision = ++this.cameraSelectionRevision;
      calls.push({ id, reason });
    },
  };
  const control = createLiveCameraController(), live = { active: true, ready: true, status: "live" };
  const add = (id, valid = true) => { viewer.playerObjects.set(id, {}); if (valid) usable.add(id); };
  const sync = options => control.sync(viewer, { ...live, ...options });
  control.begin("room-one", viewer, { runId: "run-one" });
  return { viewer, usable, calls, control, add, sync };
}

test("live camera waits for a usable position, then follows one player without timed rotation", () => {
  const f = fixture(); f.add("prejoin", false); f.add("player", false);
  f.sync(); assert.equal(f.viewer.followTargetId, null);
  f.usable.add("player"); f.sync();
  assert.equal(f.viewer.followTargetId, "player"); assert.equal(f.viewer.followAutoRotate, false);
  f.add("other"); f.sync(); f.sync();
  assert.deepEqual(f.calls, [{ id: "player", reason: "automatic" }]);
});

test("automatic target loss selects a remaining player and recovers after a gap with nobody available", () => {
  const f = fixture(); f.add("a"); f.add("b"); f.sync();
  f.usable.delete("a"); f.viewer.setFollowTarget(null, { reason: "unavailable" }); f.sync();
  assert.equal(f.viewer.followTargetId, "b");
  f.usable.clear(); f.viewer.setFollowTarget(null, { reason: "unavailable" }); f.sync();
  assert.equal(f.viewer.followTargetId, null);
  f.usable.add("a"); f.sync(); assert.equal(f.viewer.followTargetId, "a");
});

test("manual overview and same-target locks survive later flushes, even when a player becomes unavailable", () => {
  for (const choice of ["overview", "same-lock", "free"]) {
    const f = fixture(); f.add("a"); f.add("b"); f.sync();
    if (choice === "same-lock") {
      f.viewer.followChangeReason = "manual";
      f.viewer.followChangeRevision = ++f.viewer.cameraSelectionRevision;
    } else {
      f.viewer.setFollowTarget(null);
      if (choice === "overview") f.viewer.surveyPreset = "overview";
      else f.viewer.freeCamera.mode = "free";
      f.viewer.cameraSelectionRevision++;
    }
    f.sync(); f.usable.delete("a");
    if (choice === "same-lock") f.viewer.setFollowTarget(null, { reason: "unavailable" });
    f.sync(); assert.equal(f.viewer.followTargetId, null, choice);
  }
});

test("a stale automatic reason cannot turn a later manual camera revision into an automatic choice", () => {
  const f = fixture(); f.add("a"); f.sync(); f.usable.clear();
  f.viewer.setFollowTarget(null, { reason: "unavailable" }); f.sync();
  f.viewer.cameraSelectionRevision++; f.viewer.surveyPreset = "overview";
  f.usable.add("a"); f.sync(); assert.equal(f.viewer.followTargetId, null);
});

test("snapshot rebuilding cannot steal manual free-view pose or revive a superseded snapshot", () => {
  const f = fixture(); f.add("a"); f.sync();
  f.viewer.setFollowTarget(null); f.viewer.freeCamera.mode = "free";
  f.viewer.camera.position.set(7, 8, 9); f.viewer.controls.target.set(2, 3, 4);
  f.viewer.cameraSelectionRevision++;
  const stale = f.control.suspend(f.viewer), latest = f.control.suspend(f.viewer);
  f.viewer.camera.position.set(200, 300, 400); f.viewer.freeCamera.mode = "orbit";
  f.viewer.surveyPreset = "overview"; f.viewer.cameraSelectionRevision += 2;
  f.viewer.followChangeRevision = f.viewer.cameraSelectionRevision; f.viewer.followChangeReason = "data";
  f.sync(); assert.equal(f.viewer.followTargetId, null);
  assert.equal(f.control.resume(stale, f.viewer), false);
  assert.equal(f.control.resume(latest, f.viewer), true); f.sync();
  assert.deepEqual(f.viewer.camera.position.toArray(), [7, 8, 9]);
  assert.equal(f.viewer.freeCamera.mode, "free"); assert.equal(f.viewer.followTargetId, null);
});

test("same-run reconnect restores a manually locked player while a new run starts automatic selection", () => {
  const f = fixture(); f.add("a"); f.add("b"); f.sync();
  f.viewer.setFollowTarget("b"); f.sync();
  const token = f.control.suspend(f.viewer);
  f.viewer.setFollowTarget(null, { reason: "data" }); f.viewer.cameraSelectionRevision++;
  f.viewer.followChangeRevision = f.viewer.cameraSelectionRevision;
  f.control.begin("room-one", f.viewer, { runId: "run-one" });
  f.control.resume(token, f.viewer); f.sync(); assert.equal(f.viewer.followTargetId, "b");
  f.control.begin("room-one", f.viewer, { runId: "run-two" });
  const next = f.control.suspend(f.viewer); f.viewer.setFollowTarget(null, { reason: "data" });
  f.control.resume(next, f.viewer); f.sync(); assert.equal(f.viewer.followTargetId, "a");
});

test("automatic reconnect keeps the last available target rather than restarting at the first participant", () => {
  const f = fixture(); f.add("a", false); f.add("b"); f.sync();
  assert.equal(f.viewer.followTargetId, "b");
  const token = f.control.suspend(f.viewer);
  f.viewer.setFollowTarget(null, { reason: "data" }); f.usable.add("a");
  f.control.resume(token, f.viewer); f.sync();
  assert.equal(f.viewer.followTargetId, "b");
});

test("a manual view or player choice made while a snapshot loads wins over the old intent", () => {
  for (const choice of ["free", "overview", "player"]) {
    const f = fixture(); f.add("a"); f.add("b"); f.sync();
    const token = f.control.suspend(f.viewer);
    f.viewer.setFollowTarget(null, { reason: "data" });
    if (choice === "player") f.viewer.setFollowTarget("b");
    else {
      f.viewer.camera.position.set(77, 88, 99);
      f.viewer.freeCamera.mode = choice === "free" ? "free" : "orbit";
      f.viewer.surveyPreset = choice === "overview" ? "overview" : null;
      f.viewer.cameraSelectionRevision++;
    }
    f.control.resume(token, f.viewer); f.sync();
    assert.equal(f.viewer.followTargetId, choice === "player" ? "b" : null, choice);
    if (choice !== "player") assert.deepEqual(f.viewer.camera.position.toArray(), [77, 88, 99]);
  }
});

test("initial ended recordings, waiting rooms and ordinary maps do not start live following", () => {
  const f = fixture(); f.add("a");
  f.sync({ active: false }); f.sync({ ready: false }); f.sync({ status: "waiting" });
  assert.equal(f.viewer.followTargetId, null);
  f.sync({ status: "ended" }); f.sync({ status: "live" });
  assert.equal(f.viewer.followTargetId, null, "the initial archive view remains the user's view");
  f.control.begin("room-two", f.viewer); f.sync(); assert.equal(f.viewer.followTargetId, "a");
});

test("manual intent during map lookup is checkpointed before a subsequent data reset replaces its reason", () => {
  const f = fixture(); f.add("a"); f.sync();
  const token = f.control.suspend(f.viewer);
  f.viewer.setFollowTarget(null, { reason: "data" });
  f.viewer.camera.position.set(4, 5, 6); f.viewer.freeCamera.mode = "free";
  f.viewer.cameraSelectionRevision++;
  f.control.checkpoint(f.viewer, { runId: "run-one" });
  f.viewer.camera.position.set(500, 500, 500); f.viewer.freeCamera.mode = "orbit";
  f.viewer.followChangeReason = "data"; f.viewer.followChangeRevision = ++f.viewer.cameraSelectionRevision;
  f.control.resume(token, f.viewer); f.sync();
  assert.equal(f.viewer.followTargetId, null); assert.equal(f.viewer.freeCamera.mode, "free");
  assert.deepEqual(f.viewer.camera.position.toArray(), [4, 5, 6]);
});

test("a snapshot that finishes before the 3D module loads can follow once the viewer becomes ready", () => {
  const f = fixture(); f.add("a");
  f.control.begin("slow-viewer", undefined);
  const token = f.control.suspend(undefined);
  assert.equal(f.control.resume(token, undefined), true);
  f.viewer.followChangeReason = "data"; f.viewer.followChangeRevision = ++f.viewer.cameraSelectionRevision;
  f.sync(); assert.equal(f.viewer.followTargetId, "a");
});

test("continuous free-camera movement during lookup retains its latest pose without another selection revision", () => {
  const f = fixture(); f.add("a"); f.sync();
  f.viewer.setFollowTarget(null); f.viewer.freeCamera.mode = "free"; f.viewer.cameraSelectionRevision++;
  const token = f.control.suspend(f.viewer);
  f.viewer.camera.position.set(20, 30, 40);
  f.control.checkpoint(f.viewer, { runId: "run-one" });
  f.viewer.camera.position.set(500, 500, 500);
  f.viewer.followChangeReason = "data"; f.viewer.followChangeRevision = ++f.viewer.cameraSelectionRevision;
  // A second data rebuild must not replace the saved manual view with its overview.
  f.control.checkpoint(f.viewer, { runId: "run-one" });
  f.control.resume(token, f.viewer); f.sync();
  assert.deepEqual(f.viewer.camera.position.toArray(), [20, 30, 40]);
});

test("a superseding snapshot remembers a manual gesture before its own immediate data clear", () => {
  const f = fixture(); f.add("a"); f.sync();
  const old = f.control.suspend(f.viewer);
  f.viewer.setFollowTarget(null, { reason: "data" });
  f.viewer.camera.position.set(6, 7, 8); f.viewer.freeCamera.mode = "free";
  f.viewer.cameraSelectionRevision++;
  const latest = f.control.suspend(f.viewer);
  f.viewer.camera.position.set(500, 500, 500);
  f.viewer.followChangeReason = "data"; f.viewer.followChangeRevision = ++f.viewer.cameraSelectionRevision;
  assert.equal(f.control.resume(old, f.viewer), false);
  f.control.resume(latest, f.viewer); f.sync();
  assert.equal(f.viewer.followTargetId, null); assert.deepEqual(f.viewer.camera.position.toArray(), [6, 7, 8]);
});
