import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { ReplayCamera } from "../src/replay-camera.js";
import { chooseRecordedInteriorPose, isInteriorLayer } from "../src/camera-placement.js";
import { latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES } from "../src/protocol.js";
import { pointInBounds } from "../src/trail-spatial.js";
import { FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE, FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MIN_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE } from "../src/spectator-camera.js";
import { followLayerAtPosition } from "../src/map-enclosures.js";

// The real TrailScene methods and ReplayCamera own state transitions. Only
// WebGL, terrain-query and world-rendering ports are replaced with small spies.
const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export class TrailScene", "class TrailScene");
const ports = { THREE, chooseRecordedInteriorPose, isInteriorLayer, latestLifeEventBefore,
  MARKER_LIFE_EVENT_TYPES, pointInBounds, FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE,
  FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MIN_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE, followLayerAtPosition,
  updateRecordedMineVisibility() {}, updateMapFogSurfaceVisibility() {} };
const TrailScene = new Function(...Object.keys(ports), `${source}\nreturn TrailScene;`)(...Object.values(ports));

function fixture() {
  const document = new EventTarget(); document.defaultView = new EventTarget();
  const canvas = new EventTarget(); canvas.ownerDocument = document;
  const attributes = new Map();
  canvas.getAttribute = (key) => attributes.get(key) ?? null;
  canvas.setAttribute = (key, value) => attributes.set(key, String(value));
  canvas.removeAttribute = (key) => attributes.delete(key);
  canvas.tabIndex = -1; canvas.focus = () => { document.activeElement = canvas; };
  const released = []; canvas.releasePointerCapture = (id) => released.push(id);
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.5, 3200); camera.position.set(60, 40, 50);
  const controls = { enabled: true, enableDamping: true, autoRotate: false,
    target: new THREE.Vector3(), updates: 0, update() { this.updates++; } };
  const freeCamera = new ReplayCamera({ THREE, camera, controls, canvas });
  const statuses = []; canvas.addEventListener("peaktrail-follow-status", (event) => statuses.push(event.detail));
  const scene = Object.create(TrailScene.prototype);
  const queryCalls = [], rigCalls = [];
  Object.assign(scene, { canvas, camera, controls, freeCamera, cameraSelectionRevision: 0,
    origin: new THREE.Vector3(), activeSegment: 0, useMap: false, heightScale: 1, currentTime: 0,
    showMarkers: true, showTracks: true, playerVisibility: new Map(), playerObjects: new Map(),
    terrainRoot: new THREE.Group(), trailRoot: new THREE.Group(), followTargetId: null,
    followAutoRotate: false, followAutoSwitchAt: Infinity, followTerrainDirty: true,
    followDiscontinuity: false, followAnchor: new THREE.Vector3(), followTmp: new THREE.Vector3(),
    followDistance: FOLLOW_DISTANCE, followAzimuth: 0, followPitch: 0.22, followUserOrbit: false,
    followTerrain: { setRoots(roots) { queryCalls.push(roots); } },
    followRig: { resets: 0, invalidations: 0, reset() { this.resets++; }, invalidate() { this.invalidations++; },
      update(anchor, dt, options) { rigCalls.push({ anchor: anchor.clone(), dt, options: { ...options } });
        return { position: anchor.clone().add(new THREE.Vector3(0, 12, 56)), target: anchor.clone(), azimuth: 0, pitch: 0.22 }; } },
    worldRenderer: { root: new THREE.Group(), objects: [], update() {} },
    trace: { participants: [], tracks: new Map(), events: [], manifest: { sampleHz: 5 },
      bounds: { min: [-100, 0, -100], max: [100, 300, 100] } },
    mapPack: { layers: [{ segment: 0, name: "Shore_Segment", minX: -100, maxX: 100,
      minY: 0, maxY: 300, minZ: -100, maxZ: 100 }, { segment: 4, name: "Temple_Segment",
      minX: -100, maxX: 100, minY: 0, maxY: 300, minZ: -100, maxZ: 100 }] },
    buildToken: 1, geometrySelectionToken: 1,
  });
  for (const layer of scene.mapPack.layers) {
    const group = new THREE.Group(); group.userData = { segment: layer.segment, mapLayer: layer };
    scene.terrainRoot.add(group);
  }
  function player(id, { times = [0, 1, 2], segment = 0, events = [] } = {}) {
    const group = new THREE.Group(); group.userData.playerId = id;
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial());
    marker.userData = { replayVisible: true, followable: true };
    group.add(marker); scene.trailRoot.add(group);
    const samples = times.map((t) => ({ t, pos: [2 + t, 10, 5], yaw: 0, segment }));
    const line = { geometry: { instanceCount: 0 }, userData: { endTimes: times } };
    const entry = { group, marker, line, outline: {}, occludedLine: {}, samples,
      blockingEvents: events, lifecycleEvents: events, maxGap: 1 };
    scene.playerObjects.set(id, entry); scene.trace.tracks.set(id, samples);
    scene.trace.participants.push({ id, nickname: id }); scene.trace.events.push(...events.map((e) => ({ ...e, playerId: id })));
    return entry;
  }
  function cleanup() {
    freeCamera.dispose();
    for (const { marker } of scene.playerObjects.values()) { marker.geometry.dispose(); marker.material.dispose(); }
  }
  return { scene, player, statuses, released, queryCalls, rigCalls, cleanup };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("automatic chapter transitions retain follow ownership before and after interior geometry resolves", async () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a", { segment: 4 }); scene.setFollowTarget("a");
    let resolveGeometry; scene.ensureGeometryLayers = () => new Promise((resolve) => { resolveGeometry = resolve; });
    scene.buildTracks = () => {};
    const calls = []; scene.fitView = () => calls.push("fit"); scene.enterInteriorView = () => calls.push("interior");
    scene.setActiveSegment(4);
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.controls.enabled, false);
    assert.equal(scene.followTerrainDirty, true); assert.deepEqual(calls, []);
    resolveGeometry(); await flush();
    assert.equal(scene.followTargetId, "a"); assert.deepEqual(calls, []);
  } finally { f.cleanup(); }
});

for (const method of ["fitView", "topView", "toggleFreeCamera", "enterInteriorView"]) {
  test(`manual ${method} exits follow, updates its HUD and transfers controls to the chosen mode`, () => {
    const f = fixture(); const { scene } = f;
    try {
      f.player("a"); scene.setTime(0); scene.setFollowTarget("a"); scene.followAutoRotate = true;
      scene.followPointer = { id: 7 }; const revision = scene.cameraSelectionRevision;
      scene[method]();
      assert.equal(scene.followTargetId, null); assert.equal(scene.followAutoRotate, false);
      assert.equal(f.statuses.at(-1).active, false); assert.equal(f.statuses.at(-1).autoRotate, false);
      assert.ok(scene.cameraSelectionRevision > revision); assert.deepEqual(f.released, [7]);
      assert.equal(scene.followPointer, null);
      const free = ["toggleFreeCamera", "enterInteriorView"].includes(method);
      assert.equal(scene.freeCamera.mode, free ? "free" : "orbit");
      assert.equal(scene.controls.enabled, !free, "OrbitControls never owns the free camera");
      scene.freeCamera.setMode("orbit");
      assert.equal(scene.controls.enabled, true, "returning from free mode restores orbit control");
      assert.equal(scene.controls.enableDamping, true);
    } finally { f.cleanup(); }
  });
}

test("canFollowPlayer and automatic selection reject pre-join, dead, departed, stale and hidden players", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("prejoin", { times: [10, 11] });
    f.player("dead", { events: [{ t: 0, type: "death" }] });
    f.player("departed", { events: [{ t: 0, type: "leave" }] });
    f.player("stale", { times: [0] });
    f.player("hidden"); scene.playerVisibility.set("hidden", false);
    f.player("wrong-chapter", { segment: 4 });
    f.player("alive"); scene.setTime(2);
    for (const id of ["prejoin", "dead", "departed", "stale", "hidden", "wrong-chapter", "missing"])
      assert.equal(scene.canFollowPlayer(id), false, id);
    assert.equal(scene.canFollowPlayer("alive"), true);
    assert.equal(scene.startAutoFollow(), true); assert.equal(scene.followTargetId, "alive");
    scene.cycleFollowTarget(); assert.equal(scene.followTargetId, "alive");
    scene.playerObjects.get("alive").group.visible = false;
    assert.equal(scene.canFollowPlayer("alive"), false);
    scene.updateFollowCamera(1 / 60); assert.equal(scene.followTargetId, null);
  } finally { f.cleanup(); }
});

test("locking the same followed player disables automatic rotation and still emits a HUD update", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.startAutoFollow(); const count = f.statuses.length;
    const revision = scene.cameraSelectionRevision;
    scene.lockFollowTarget("a");
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.followAutoRotate, false);
    assert.ok(f.statuses.length > count); assert.equal(f.statuses.at(-1).autoRotate, false);
    assert.equal(scene.cameraSelectionRevision, revision, "same-ID lock does not snap the rig");
  } finally { f.cleanup(); }
});

test("starting auto-follow on the same locked first player updates the HUD without resetting the rig", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.lockFollowTarget("a"); const count = f.statuses.length;
    scene.followUserOrbit = true;
    const revision = scene.cameraSelectionRevision;
    assert.equal(scene.startAutoFollow(), true);
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.followAutoRotate, true);
    assert.equal(scene.followUserOrbit, false, "explicit auto-follow releases a prior manual orbit");
    assert.ok(f.statuses.length > count); assert.equal(f.statuses.at(-1).autoRotate, true);
    assert.equal(scene.cameraSelectionRevision, revision, "same-ID mode switch preserves the view");
  } finally { f.cleanup(); }
});

test("clicking a player marker locks that player rather than retaining automatic rotation", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.followAutoRotate = true;
    scene.followDownAt = { x: 100, y: 120, time: performance.now() };
    scene.pickPlayerMarker = () => "a";
    scene.onFollowPointerUp({ pointerId: 1, button: 0, clientX: 102, clientY: 121 });
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.followAutoRotate, false);
    assert.equal(f.statuses.at(-1).autoRotate, false);
    assert.equal(scene.followDownAt, null);
  } finally { f.cleanup(); }
});

test("height and chapter visibility invalidate the terrain query; rebuilding is lazy and uses current transforms", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.setTime(0); scene.setFollowTarget("a"); scene.updateFollowCamera(1 / 60);
    assert.equal(f.queryCalls.length, 1); assert.equal(scene.followTerrainDirty, false);
    const resets = scene.followRig.resets;
    scene.setHeightScale(2.5);
    assert.equal(scene.followTerrainDirty, true); assert.ok(scene.followRig.resets > resets);
    assert.equal(scene.terrainRoot.scale.y, 2.5); assert.equal(scene.trailRoot.scale.y, 2.5);
    assert.equal(scene.worldRenderer.root.scale.y, 2.5);
    scene.updateFollowCamera(1 / 60);
    assert.equal(f.queryCalls.length, 2); assert.equal(scene.followRig.invalidations, 2);
    assert.equal(f.rigCalls.at(-1).anchor.y, 25, "anchor follows the same scaled world transform as terrain");
    scene.updateFollowCamera(1 / 60); assert.equal(f.queryCalls.length, 2, "stable terrain is not rebuilt every frame");
    scene.applyLayerVisibility(); assert.equal(scene.followTerrainDirty, true);
    scene.updateFollowCamera(1 / 60); assert.equal(f.queryCalls.length, 3);
  } finally { f.cleanup(); }
});

test("rewinds and seeks pass one discontinuity to the rig while normal playback remains smooth", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a", { times: [0, 1, 2, 3, 4, 5, 6] }); scene.setTime(0); scene.setFollowTarget("a");
    scene.setTime(0.5); scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.discontinuity, false);
    scene.setTime(4); scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.discontinuity, true); assert.equal(scene.followDiscontinuity, false);
    scene.updateFollowCamera(1 / 60); assert.equal(f.rigCalls.at(-1).options.discontinuity, false);
    scene.setTime(2); scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.discontinuity, true);
    scene.setTime(2.1); scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.discontinuity, false);
  } finally { f.cleanup(); }
});

test("interior follow supplies the verified model axis using exactly the player's world transform", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.activeSegment = 4; scene.origin.set(10, 100, 200); scene.heightScale = 2;
    scene.trailRoot.scale.set(1, 2, -1);
    scene.mapPack.mapEnclosures = { enclosures: [{ segment: 4, interiorReference: [7, 805, 2092.5] }] };
    const p = f.player('inside', { segment: 4 }); p.marker.position.set(20, 700, 1900);
    scene.setFollowTarget('inside'); scene.updateFollowCamera(1 / 60);
    assert.equal(scene.followDistance, FOLLOW_INTERIOR_DISTANCE);
    assert.equal(f.rigCalls.at(-1).options.interior, true);
    assert.deepEqual(f.rigCalls.at(-1).options.interiorReference.center, [-3, 1410, -1892.5]);
    assert.equal(f.statuses.at(-1).viewMode, 'interior');
    scene.onFollowWheel({ deltaY: 100000, preventDefault() {} });
    assert.equal(scene.followDistance, FOLLOW_INTERIOR_MAX_DISTANCE);
  } finally { f.cleanup(); }
});

test("overview follows a spatially unique interior player without inventing a centre when metadata is missing", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.activeSegment = null;
    scene.mapPack.layers[0].maxY = 5;
    f.player('inside', { segment: 4 }); scene.setTime(1);
    scene.setFollowTarget('inside'); scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.interior, true);
    assert.equal(f.rigCalls.at(-1).options.interiorReference, null);
    assert.equal(scene.followDistance, FOLLOW_INTERIOR_DISTANCE);
    scene.mapPack.layers[0].maxY = 300;
    scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.interior, false, 'ambiguous overlapping rooms are not asserted to be the interior');
  } finally { f.cleanup(); }
});
