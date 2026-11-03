import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PerspectiveCamera, Vector3 } from "../../vendor/three/0.180.0/build/three.module.js";
import { appendLiveRecord, createLiveTrace, finalizeLiveFlush } from "../src/protocol.js";
import { trimWatchTrace } from "../src/watch-window.js";
import { createLiveCameraController } from "../src/live-camera.js";

const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
function functions(names, ports) {
  return new Function(...Object.keys(ports), names.map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, name); return match[0];
  }).join("\n") + `\nreturn {${names.join(",")}};`)(...Object.values(ports));
}
function makeTrace(id = "run", players = []) {
  const trace = createLiveTrace({ schemaVersion: 1, sessionId: id, sceneName: "Level_87", coordinateSpace: "unity-world-meters" }, { sessionId: id });
  for (const name of players) {
    appendLiveRecord(trace, { type: "participant", playerId: name, nickname: name });
    for (const t of [0, 1000]) appendLiveRecord(trace, { type: "sample", playerId: name, t, pos: [1, 2, 3] });
  }
  finalizeLiveFlush(trace); return trace;
}
function fixture() {
  const state = { traceSelectionRevision: 0, currentTime: 0, lastTelemetryAt: 0,
    routeView: { key: "same" }, watch: { active: true, id: "room", status: "connecting" } };
  const calls = [], nodes = new Map();
  let sceneGate = null;
  const $ = id => { if (!nodes.has(id)) nodes.set(id, { setAttribute() {} }); return nodes.get(id); };
  const viewer = {
    trace: null, currentTime: 0, cameraSelectionRevision: 0, followTargetId: null, playerObjects: new Map(),
    camera: new PerspectiveCamera(), controls: { target: new Vector3(), enableDamping: true, update() {} },
    freeCamera: { mode: "orbit", setMode(value) { this.mode = value; } },
    setFollowTarget(id, { reason = "manual" } = {}) {
      if (id === this.followTargetId) return;
      this.followTargetId = id; this.surveyPreset = null;
      this.followChangeReason = reason; this.followChangeRevision = ++this.cameraSelectionRevision;
      calls.push(id);
    },
    setTime(t) { this.currentTime = t; },
    refreshTracks() { this.playerObjects = new Map([...this.trace.tracks.keys()].map(id => [id, {}])); },
    canFollowPlayer(id) { return (this.trace?.tracks.get(id) || []).some(sample => sample.t <= this.currentTime && this.currentTime - sample.t <= 1.5); },
    async setData({ trace }) {
      this.trace = trace; this.refreshTracks(); this.setFollowTarget(null, { reason: "data" });
      this.camera.position.set(500, 500, 500); this.surveyPreset = "overview";
      this.followChangeReason = "data"; this.followChangeRevision = ++this.cameraSelectionRevision;
      if (sceneGate) {
        const gate = sceneGate; sceneGate = null; gate.started();
        await new Promise(resolve => { gate.resolve = resolve; });
      }
    },
    setGameAssetPack() {}, setWorldVisibility() {}, setHeightScale() {}, setTrackVisibility() {}, setMarkerVisibility() {},
  };
  let finishMap = null;
  const liveCameraController = createLiveCameraController();
  liveCameraController.begin("room", viewer);
  let api;
  const ports = { state, viewer, liveCameraController, $, finalizeLiveFlush, trimWatchTrace,
    LIVE_TRAIL_S: 0.3, TELEMETRY_UPDATE_INTERVAL_MS: 125, performance,
    elements: { appShell: { classList: { add() {}, remove() {} } }, eventList: { scrollTop: 0 },
      timeline: { min: "0", max: "0", style: {} }, currentTime: {}, totalTime: {}, sampleCount: {},
      worldToggle: {}, heightScale: { value: "1" }, trackToggle: {}, markerToggle: {} },
    watchText: value => value, tr: value => value, formatTime: String, formatNumber: String,
    resetSegmentNavigation() {}, setPlaying() {}, syncGameAssetsForTrace() {},
    syncMapForTrace: () => finishMap ? new Promise(resolve => { finishMap.resolve = resolve; }) : Promise.resolve(),
    clearAutomaticMap: async () => {}, assessCompatibility: () => ({ compatible: true }),
    renderChain: Promise.resolve(), populateSegmentControls: () => 0,
    updateEmptyState() {}, updateSceneMeta() {}, syncCommunityContext() {}, markSegmentTransition() {},
    updateTraceUI() {}, updateMapUI() {}, updateCompatibilityUI() {}, updateWatchStatus() {},
    updatePlayers() {}, updateEvents() {}, updatePlayerTelemetry() {}, syncSegmentToPlayback() {},
    buildSegmentTimeline: () => [], itemEventPanel: { sync() {} }, isLiveFollowing: () => true,
    resolveReplayRoute: () => ({ key: "same", layers: [] }), showError() {}, showEventToast() {},
  };
  api = functions(["applyWatchSnapshot", "syncWatchCamera", "flushWatch", "updatePlaybackTime", "renderData", "renderDataNow"], ports);
  return { state, viewer, calls, api,
    pauseMap() { finishMap = {}; return { finish: () => { finishMap.resolve(); finishMap = null; } }; },
    pauseScene() {
      const gate = {}; sceneGate = gate;
      return { started: new Promise(resolve => { gate.started = resolve; }), finish: () => gate.resolve() };
    },
  };
}

test("watch snapshot arms camera only after matching trace and playback positions are rendered", async () => {
  const f = fixture(), pending = f.pauseMap(), trace = makeTrace("run", ["player"]);
  const loading = f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, trace);
  f.api.syncWatchCamera(); assert.deepEqual(f.calls, []);
  pending.finish(); await loading;
  assert.equal(f.viewer.trace, trace); assert.equal(f.viewer.currentTime, 0.7);
  assert.deepEqual(f.calls, ["player"]); assert.equal(f.viewer.followAutoRotate, false);
});

test("a packet-style empty first snapshot starts following when later records are flushed", async () => {
  const f = fixture(), trace = makeTrace();
  await f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, trace);
  assert.equal(f.viewer.followTargetId, null);
  appendLiveRecord(trace, { type: "participant", playerId: "player", nickname: "player" });
  for (const t of [0, 1000]) appendLiveRecord(trace, { type: "sample", playerId: "player", t, pos: [1, 2, 3] });
  f.state.watch.dirty = true; f.api.flushWatch();
  assert.equal(f.viewer.followTargetId, "player");
  f.viewer.setFollowTarget(null); f.viewer.surveyPreset = "overview"; f.viewer.cameraSelectionRevision++;
  f.api.flushWatch(); f.api.updatePlaybackTime(0.7, false);
  assert.equal(f.viewer.followTargetId, null, "later polls and playhead updates preserve the user's overview");
});

test("ended snapshot metadata arrives before onState and still keeps the initial recording overview", async () => {
  const f = fixture();
  await f.api.applyWatchSnapshot({ epoch: 1, status: "ended" }, makeTrace("run", ["player"]));
  assert.equal(f.state.watch.status, "ended"); assert.equal(f.viewer.followTargetId, null);
  f.api.flushWatch(); f.api.updatePlaybackTime(1, false);
  assert.equal(f.viewer.followTargetId, null);
});

test("reconnecting the same run restores manual free-camera pose through snapshot and render resets", async () => {
  const f = fixture();
  await f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, makeTrace("run", ["player"]));
  f.viewer.setFollowTarget(null); f.viewer.freeCamera.mode = "free";
  f.viewer.camera.position.set(11, 22, 33); f.viewer.cameraSelectionRevision++;
  await f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, makeTrace("run", ["player"]));
  assert.equal(f.viewer.followTargetId, null); assert.equal(f.viewer.freeCamera.mode, "free");
  assert.deepEqual(f.viewer.camera.position.toArray(), [11, 22, 33]);
});

test("a gesture during asynchronous map lookup is saved before the queued data render changes its camera", async () => {
  const f = fixture();
  await f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, makeTrace("run", ["player"]));
  const waiting = f.pauseMap();
  const pending = f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, makeTrace("run", ["player"]));
  f.viewer.camera.position.set(99, 88, 77); f.viewer.freeCamera.mode = "free"; f.viewer.cameraSelectionRevision++;
  waiting.finish(); await pending;
  assert.equal(f.viewer.followTargetId, null); assert.equal(f.viewer.freeCamera.mode, "free");
  assert.deepEqual(f.viewer.camera.position.toArray(), [99, 88, 77]);
});

test("a same-session snapshot object rebuilds even when an earlier render restored an identical signature", async () => {
  const f = fixture(), first = makeTrace("run", ["old-player"]), scene = f.pauseScene();
  const older = f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, first);
  await scene.started;
  const second = makeTrace("run", ["new-player"]);
  const newer = f.api.applyWatchSnapshot({ epoch: 1, status: "live" }, second);
  // Queue the replacement behind the first model load, then allow the older
  // render to restore the same signature that the new snapshot just cleared.
  await Promise.resolve(); scene.finish();
  await Promise.all([older, newer]);
  assert.equal(f.viewer.trace, second);
  assert.deepEqual([...f.viewer.playerObjects.keys()], ["new-player"]);
  assert.equal(f.viewer.followTargetId, "new-player");
});
