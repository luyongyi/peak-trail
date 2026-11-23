import * as i18n from "../src/i18n.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { ReplayCamera } from "../src/replay-camera.js";
import { createSectionPlane, orientSectionPlane } from "../src/section-plane.js";
import { chooseOverviewDirection, fitPerspectivePoints } from "../src/camera-framing.js";
import { chooseRecordedInteriorPose, isInteriorLayer } from "../src/camera-placement.js";
import { latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES } from "../src/protocol.js";
import { pointInBounds, markerInDisplayBounds } from "../src/trail-spatial.js";
import { FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE, FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MIN_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE } from "../src/spectator-camera.js";
import { followLayerAtPosition } from "../src/map-enclosures.js";
import { fitSurveyCamera } from "../src/survey-camera-fit.js";

// The real TrailScene methods and ReplayCamera own state transitions. Only
// WebGL, terrain-query and world-rendering ports are replaced with small spies.
const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export class TrailScene", "class TrailScene");
const ports = { ...i18n, THREE, chooseOverviewDirection, fitPerspectivePoints, chooseRecordedInteriorPose, isInteriorLayer, latestLifeEventBefore,
  MARKER_LIFE_EVENT_TYPES, pointInBounds, markerInDisplayBounds, FOLLOW_DISTANCE, FOLLOW_MIN_DISTANCE, FOLLOW_MAX_DISTANCE,
  FOLLOW_INTERIOR_DISTANCE, FOLLOW_INTERIOR_MIN_DISTANCE, FOLLOW_INTERIOR_MAX_DISTANCE, followLayerAtPosition,
  fitSurveyCamera, createSectionPlane, orientSectionPlane,
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
    sectionPlane: createSectionPlane(THREE),
    followTerrain: { setRoots(roots) { queryCalls.push(roots); }, cast() { return null; } },
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

test("navigation follow locks the course axis and fades only a ray-tested foreground", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.mapPack.gameBuildId = "26542162";
    scene.trace.manifest.positionAuthority = "photon-character-hip";
    scene.followOcclusion = { value: new THREE.Vector4(0, 0, 0, 0) };
    f.player("a"); scene.setTime(0); scene.setFollowTarget("a");
    scene.updateFollowCamera(1/60);
    assert.equal(f.rigCalls.at(-1).options.fixedFollow, true);
    const point = scene.followOcclusion.value;
    assert.ok(point.z < -50 && Math.hypot(point.x, point.y) < .001 && point.w === 0);
    const cameraBefore = scene.camera.position.clone();
    scene.followTerrain.cast = (eye, ray, maxDistance, section, options) => {
      assert.equal(eye, scene.camera.position);
      assert.ok(eye.clone().add(ray).distanceTo(scene.followAnchor) < 1e-9);
      assert.ok(Math.abs(maxDistance - (ray.length() - 0.65)) < 1e-9);
      assert.equal(options.renderedFacesOnly, true);
      return { distance: 4 };
    };
    scene.updateFollowCamera(1/60);
    assert.ok(point.w > 0, "activate the fade only after an obstruction");
    assert.ok(scene.camera.position.equals(cameraBefore), "an obstruction must never move the fixed camera");
    const width = point.w;
    scene.camera.aspect = .45;
    scene.updateFollowCamera(1 / 60);
    assert.ok(point.w < width, "the fade stays local on portrait displays");
    scene.setFollowTarget(null);
    assert.equal(point.w, 0);
  } finally { f.cleanup(); }
});

test("the native checkpoints advance along one Unity +Z axis to the summit", async () => {
  for (const build of ["25739797", "26134529", "26155610", "26542162"]) {
    const index = JSON.parse(await readFile(new URL(`../../data/maps/landmarks.${build}.json`, import.meta.url), "utf8"));
    assert.ok(index.maps.length);
    for (const map of index.maps) {
      const checkpoints = map.alignment.landmarks.filter(entry => entry.kind === "progress-point");
      const summit = checkpoints.find(point => point.key === "progress-point:peak");
      for (let segment = 0; segment <= 4; segment++) {
        const start = checkpoints.find(point => point.stageIndex === segment).positionCm;
        const exit = (segment === 4 ? summit : checkpoints.find(point => point.stageIndex === segment + 1)).positionCm;
        assert.equal(exit[0], start[0], map.sceneName);
        assert.ok(exit[2] > start[2], map.sceneName);
      }
    }
  }
});

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
    assert.equal(f.statuses.at(-1).reason, "manual", "the explicit auto-follow button is a user choice");
    scene.cycleFollowTarget(); assert.equal(scene.followTargetId, "alive");
    scene.playerObjects.get("alive").group.visible = false;
    assert.equal(scene.canFollowPlayer("alive"), false);
    scene.updateFollowCamera(1 / 60); assert.equal(scene.followTargetId, null);
    assert.equal(f.statuses.at(-1).reason, "unavailable", "lost player data does not express a manual camera choice");
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
  } finally { f.cleanup(); }
});

test("locking the same followed player records manual ownership without snapping the rig", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.startAutoFollow(); const count = f.statuses.length;
    const revision = scene.cameraSelectionRevision;
    const resets = scene.followRig.resets;
    scene.lockFollowTarget("a");
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.followAutoRotate, false);
    assert.ok(f.statuses.length > count); assert.equal(f.statuses.at(-1).autoRotate, false);
    assert.equal(scene.cameraSelectionRevision, revision + 1, "same-ID lock invalidates a pending automatic selection");
    assert.equal(scene.followRig.resets, resets, "recording intent does not snap the rig");
    assert.equal(scene.followChangeReason, "manual");
    assert.equal(f.statuses.at(-1).reason, "manual");
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
  } finally { f.cleanup(); }
});

test("starting auto-follow on the same locked first player updates the HUD without resetting the rig", () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.lockFollowTarget("a"); const count = f.statuses.length;
    scene.followUserOrbit = true;
    const revision = scene.cameraSelectionRevision;
    const resets = scene.followRig.resets;
    assert.equal(scene.startAutoFollow(), true);
    assert.equal(scene.followTargetId, "a"); assert.equal(scene.followAutoRotate, true);
    assert.equal(scene.followUserOrbit, false, "explicit auto-follow releases a prior manual orbit");
    assert.ok(f.statuses.length > count); assert.equal(f.statuses.at(-1).autoRotate, true);
    assert.equal(scene.cameraSelectionRevision, revision + 1, "explicit cruise selection records manual camera ownership");
    assert.equal(scene.followRig.resets, resets, "same-ID mode switch preserves the rig");
    assert.equal(f.statuses.at(-1).reason, "manual");
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
  } finally { f.cleanup(); }
});

test("automatic follow replacement and timed rotation remain distinct from manual cycling", () => {
  const f = fixture(); const { scene } = f;
  try {
    const a = f.player("a"), b = f.player("b");
    scene.startAutoFollow();
    a.group.visible = false;
    scene.updateFollowCamera(1 / 60);
    assert.equal(scene.followTargetId, "b");
    assert.equal(scene.followChangeReason, "automatic");
    assert.equal(f.statuses.at(-1).reason, "automatic");
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
    a.group.visible = true;
    scene.followAutoSwitchAt = 0;
    scene.updateFollowCamera(1 / 60);
    assert.equal(scene.followTargetId, "a");
    assert.equal(f.statuses.at(-1).reason, "automatic");
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
    scene.cycleFollowTarget();
    assert.equal(scene.followTargetId, "b");
    assert.equal(f.statuses.at(-1).reason, "manual", "the existing no-argument API remains a manual next-player action");
    a.group.visible = false; b.group.visible = false;
    scene.updateFollowCamera(1 / 60);
    assert.equal(scene.followTargetId, null);
    assert.equal(f.statuses.at(-1).reason, "unavailable");
  } finally { f.cleanup(); }
});

test("follow reasons cannot misclassify a later overview choice after the target disappears", () => {
  const f = fixture(); const { scene } = f;
  try {
    const a = f.player("a"); scene.setFollowTarget("a", { reason: "automatic" });
    a.group.visible = false; scene.updateFollowCamera(1 / 60);
    const unavailableRevision = scene.followChangeRevision;
    assert.equal(unavailableRevision, scene.cameraSelectionRevision);
    scene.fitView();
    assert.equal(scene.followTargetId, null);
    assert.ok(scene.cameraSelectionRevision > unavailableRevision);
    assert.equal(scene.followChangeRevision, scene.cameraSelectionRevision);
    assert.equal(scene.followChangeReason, "manual",
      "the later explicit overview replaces the old unavailability reason");
  } finally { f.cleanup(); }
});

test("replacing the trace labels the follow release as a data change", async () => {
  const f = fixture(); const { scene } = f;
  try {
    f.player("a"); scene.setFollowTarget("a", { reason: "automatic" });
    Object.assign(scene, {
      playerPortraits: new Map(), playerLabels: new Map(), playerGroups: new Map(), geometryLoads: new Map(),
      labelOverlay: { replaceChildren() {} }, buildGrid() {}, buildTracks() {}, resize() {},
    });
    scene.worldRenderer.setData = () => {};
    scene.worldRenderer.setMapFog = () => {};
    await scene.setData({ mapPack: null, trace: null, useMap: false, activeSegment: null });
    assert.equal(scene.followTargetId, null);
    assert.equal(f.statuses.at(-1).reason, "data");
    assert.equal(f.statuses.at(-1).active, false);
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

test("opening and restoring the facade changes follow geometry and distance while retaining the player and manual orbit", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.activeSegment = 4;
    f.player("inside", { segment: 4 }); scene.setTime(1);
    scene.facadeState = { available: true, visible: false };
    scene.setFollowTarget("inside");
    scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.interior, false);
    assert.equal(scene.followDistance, 36);
    assert.equal(f.rigCalls.at(-1).options.sectionPlane.footing.value.y, scene.followAnchor.y + 0.15);
    scene.facadeState.visible = true;
    scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.interior, true);
    assert.equal(f.rigCalls.at(-1).options.sectionPlane, null);
    assert.equal(scene.followDistance, FOLLOW_INTERIOR_DISTANCE);
    scene.followUserOrbit = true; scene.followAzimuth = 0.8; scene.followDistance = 21;
    scene.facadeState.visible = false;
    scene.updateFollowCamera(1 / 60);
    assert.equal(f.rigCalls.at(-1).options.manual, true);
    assert.equal(f.rigCalls.at(-1).options.azimuth, 0.8);
    assert.equal(scene.followDistance, 21);
    assert.equal(scene.followTargetId, "inside");
  } finally { f.cleanup(); }
});

test("the vertical building section follows the view in orbit, player follow and free camera, retaining the overhead bearing", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.activeSegment = 4;
    scene.facadeState = { available: true, visible: false };
    const s = scene.sectionPlane;
    s.axisX = 20; s.axisZ = -50;
    scene.camera.position.set(10, 5, 4); scene.camera.lookAt(10, 5, 0);
    scene.updateSectionPlane(); assert.deepEqual(s.value.toArray(), [0, 1, 50, 1]);
    scene.camera.lookAt(20, 5, 4); scene.updateSectionPlane();
    assert.ok(Math.abs(s.value.x + 1) < 1e-8 && Math.abs(s.value.z - 20) < 1e-8);
    scene.camera.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    scene.updateSectionPlane(); assert.ok(Math.abs(s.value.x + 1) < 1e-8);
    f.player("inside", { segment: 4 }); scene.setTime(1); scene.setFollowTarget("inside");
    scene.updateFollowCamera(1 / 60); scene.updateSectionPlane();
    const player = scene.followAnchor;
    assert.deepEqual(s.footing.value.toArray(), [player.x, player.y + 0.15, player.z, 3]);
    assert.ok(s.value.x * player.x + s.value.y * player.z + s.value.z < 0, "automatic follow retains the player's wall");
    scene.toggleFreeCamera(); scene.updateSectionPlane();
    assert.equal(s.value.w, 1); assert.equal(s.footing.value.w, 0);
    scene.facadeState.visible = true; scene.updateSectionPlane(); assert.equal(s.value.w, 0);
    scene.facadeState.visible = false; scene.updateSectionPlane(); assert.equal(s.value.w, 1);
    scene.facadeState.available = false; scene.updateSectionPlane(); assert.equal(s.value.w, 0);
  } finally { f.cleanup(); }
});

test("touch pinch changes followed-camera distance and lifting a finger resumes one-finger orbit", () => {
  const f = fixture();
  try {
    f.player("p1"); f.scene.setFollowTarget("p1");
    const event = (id, x, primary = true) => ({ pointerId: id, pointerType: "touch", isPrimary: primary,
      button: 0, clientX: x, clientY: 10, preventDefault() {} });
    f.scene.onFollowPointerDown(event(1, 0));
    f.scene.onFollowPointerDown(event(2, 100, false));
    const before = f.scene.followDistance;
    f.scene.onFollowPointerMove(event(2, 200, false));
    assert.ok(f.scene.followDistance < before);
    f.scene.onFollowPointerUp(event(1, 0));
    const azimuth = f.scene.followAzimuth;
    f.scene.onFollowPointerMove(event(2, 220, false));
    assert.notEqual(f.scene.followAzimuth, azimuth);
    f.scene.setFollowTarget(null);
    assert.equal(f.scene.followTouches.size, 0);
  } finally { f.cleanup(); }
});

test("packet navigation keeps its axis during mouse and touch drags, with pinch zoom and a free camera", () => {
  const f = fixture(), { scene } = f;
  try {
    scene.trace.manifest.positionAuthority = "photon-character-hip";
    f.player("p1"); scene.setTime(0); scene.setFollowTarget("p1"); scene.updateFollowCamera(1 / 60);
    const { followAzimuth, followPitch, followDistance } = scene;
    const pointer = (pointerId, pointerType, clientX, clientY, isPrimary = true) => ({
      pointerId, pointerType, isPrimary, button: 0, clientX, clientY, preventDefault() {},
    });
    scene.onFollowPointerDown(pointer(1, "mouse", 10, 20));
    scene.onFollowPointerMove(pointer(1, "mouse", 130, 90));
    scene.onFollowPointerUp(pointer(1, "mouse", 130, 90));
    scene.onFollowPointerDown(pointer(2, "touch", 30, 10));
    scene.onFollowPointerDown(pointer(3, "touch", 150, 10, false));
    scene.onFollowPointerMove(pointer(3, "touch", 210, 10, false));
    assert.ok(scene.followDistance < followDistance);
    scene.onFollowPointerUp(pointer(2, "touch", 30, 10));
    scene.onFollowPointerMove(pointer(3, "touch", 240, 60, false));
    assert.equal(scene.followAzimuth, followAzimuth);
    assert.equal(scene.followPitch, followPitch);
    assert.equal(scene.followUserOrbit, false);
    scene.toggleFreeCamera();
    assert.equal(scene.followTargetId, null);
    assert.equal(scene.freeCamera.mode, "free");
  } finally { f.cleanup(); }
});
