import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { pointInBounds, clipTrailSegment } from "../src/trail-spatial.js";
import { latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES } from "../src/protocol.js";

// Load the bundled Three line implementations unchanged apart from their import/export
// wiring. These are real instanced geometries and shader materials, not hand-written
// lookalikes, so sharing, depth functions and rewind instance counts remain observable.
async function lineAddon(name, dependencies = {}) {
  const source = (await readFile(new URL(`../../vendor/three/0.180.0/examples/jsm/lines/${name}.js`, import.meta.url), "utf8"))
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
  const ports = { ...THREE, ...dependencies };
  return new Function(...Object.keys(ports), `${source}\nreturn ${name};`)(...Object.values(ports));
}
const LineSegmentsGeometry = await lineAddon("LineSegmentsGeometry");
const LineMaterial = await lineAddon("LineMaterial");
const LineSegments2 = await lineAddon("LineSegments2", { LineSegmentsGeometry, LineMaterial });
const sceneSource = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");

function fixture({ samples = defaultSamples(), events = [], activeSegment = null, spatial = {} } = {}) {
  const ports = { THREE, LineSegmentsGeometry, LineMaterial, LineSegments2, pointInBounds, clipTrailSegment, updateRecordedMineVisibility() {}, updateMapFogSurfaceVisibility() {}, latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES, ...spatial };
  const TrailScene = new Function(...Object.keys(ports), `${sceneSource}\nreturn TrailScene;`)(...Object.values(ports));
  const scene = Object.create(TrailScene.prototype);
  Object.assign(scene, {
    trace: { manifest: { sampleHz: 5 }, participants: [{ id: "synthetic-player", nickname: "Test" }],
      tracks: new Map([["synthetic-player", samples]]), events },
    trailRoot: new THREE.Group(), terrainRoot: new THREE.Group(), gridRoot: new THREE.Group(),
    camera: new THREE.PerspectiveCamera(60, 1, 0.01, 5000),
    origin: new THREE.Vector3(100, 200, 300), heightScale: 1, useMap: false, activeSegment,
    currentTime: 0, showTracks: true, showMarkers: true,
    playerVisibility: new Map(), playerObjects: new Map(), playerGroups: new Map(),
    getPlayerColor() { return "#efb74e"; }, rebuildPlayerLabels() {},
    worldRenderer: { objects: [], root: new THREE.Group(), update() {} },
  });
  return scene;
}

function defaultSamples() {
  return [
    { t: 0, pos: [101, 202, 303], yaw: 0, activeSegment: 99 },
    { t: 0.5, pos: [103, 205, 307], yaw: 45, activeSegment: 99 },
    { t: 1, pos: [105, 201, 309], yaw: 90, activeSegment: 99 },
    { t: 1.5, pos: [107, 209, 311], yaw: 135, activeSegment: 99 },
  ];
}
const player = (scene) => scene.playerObjects.get("synthetic-player");
function vec3(attribute, index) { return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]; }
function close(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${value} != ${expected[i]} at ${i}`));
}

test("trail depth passes are complementary, transparent and do not write depth", () => {
  const scene = fixture(); scene.buildTracks();
  const { line, outline, occludedLine } = player(scene);
  assert.ok(line instanceof LineSegments2); assert.ok(line.geometry instanceof LineSegmentsGeometry);
  for (const pass of [line, outline, occludedLine]) {
    assert.equal(pass.material.depthTest, true); assert.equal(pass.material.depthWrite, false);
    assert.equal(pass.material.transparent, true); assert.equal(pass.material.worldUnits, false);
  }
  assert.equal(line.material.depthFunc, THREE.LessEqualDepth); assert.equal(outline.material.depthFunc, THREE.LessEqualDepth);
  assert.equal(occludedLine.material.depthFunc, THREE.GreaterDepth);
  assert.equal(line.material.opacity, 0.92); assert.equal(outline.material.opacity, 0.8);
  assert.equal(occludedLine.material.opacity, 0.18); assert.equal(occludedLine.material.linewidth, 2.5);
  assert.ok(occludedLine.renderOrder < outline.renderOrder && outline.renderOrder < line.renderOrder);
});

test("all trail passes share unchanged recorded XYZ without a floor projection or arbitrary Y lift", () => {
  const samples = defaultSamples(), original = structuredClone(samples), scene = fixture({ samples }); scene.buildTracks();
  const { line, outline, occludedLine } = player(scene), geometry = line.geometry;
  assert.equal(outline.geometry, geometry); assert.equal(occludedLine.geometry, geometry);
  assert.equal(geometry.attributes.instanceStart.count, 3);
  for (let index = 0; index < 3; index++) {
    close(vec3(geometry.attributes.instanceStart, index), samples[index].pos.map((value, axis) => value - scene.origin.getComponent(axis)));
    close(vec3(geometry.attributes.instanceEnd, index), samples[index + 1].pos.map((value, axis) => value - scene.origin.getComponent(axis)));
  }
  assert.deepEqual(samples, original, "the renderer must never rewrite logged coordinates");
});

test("seeking backward reduces the one shared instanceCount for every depth pass", () => {
  const scene = fixture(); scene.buildTracks();
  const { line, outline, occludedLine, marker } = player(scene);
  for (const [time, expected] of [[0, 0], [0.75, 1], [1.5, 3], [0.5, 1], [0.25, 0]]) {
    scene.setTime(time);
    for (const pass of [line, outline, occludedLine]) assert.equal(pass.geometry.instanceCount, expected);
  }
  close(marker.position.toArray(), [2, 3.5, 5], 1e-6);
  assert.equal(marker.rotation.y, THREE.MathUtils.degToRad(22.5));
  scene.setHeightScale(2);
  assert.equal(scene.trailRoot.scale.y, 2);
  close(marker.position.toArray(), [2, 3.5, 5], 1e-6);
});

test("showTracks hides all visible and occluded strokes while marker and player controls remain independent", () => {
  const scene = fixture(); scene.buildTracks(); scene.setTime(1);
  const object = player(scene), passes = [object.line, object.outline, object.occludedLine];
  scene.setTrackVisibility(false);
  assert.ok(passes.every((pass) => !pass.visible)); assert.equal(object.marker.visible, true);
  scene.setTime(0.25); assert.ok(passes.every((pass) => !pass.visible));
  scene.setTrackVisibility(true); assert.ok(passes.every((pass) => pass.visible));
  scene.setMarkerVisibility(false); assert.equal(object.marker.visible, false); assert.ok(passes.every((pass) => pass.visible));
  scene.setPlayerVisibility("synthetic-player", false); assert.equal(object.group.visible, false);
  scene.setPlayerVisibility("synthetic-player", true); assert.equal(object.group.visible, true); assert.equal(object.marker.visible, false);
});

test("marker visible/occluded mesh pairs share geometry and pose, with independent complementary materials", () => {
  const scene = fixture(), marker = scene.createPlayerMarker("#efb74e");
  const visible = marker.children.filter((mesh) => mesh.material.depthFunc === THREE.LessEqualDepth);
  const occluded = marker.children.filter((mesh) => mesh.material.depthFunc === THREE.GreaterDepth);
  assert.equal(visible.length, 3); assert.equal(occluded.length, 3);
  for (const mesh of visible) {
    const ghost = occluded.find((candidate) => candidate.geometry === mesh.geometry);
    assert.ok(ghost); assert.notEqual(ghost.material, mesh.material);
    close(ghost.position.toArray(), mesh.position.toArray()); close(ghost.quaternion.toArray(), mesh.quaternion.toArray());
    assert.equal(ghost.material.opacity, 0.18); assert.ok(mesh.material.opacity > ghost.material.opacity);
    for (const material of [mesh.material, ghost.material]) {
      assert.equal(material.depthTest, true); assert.equal(material.depthWrite, false); assert.equal(material.transparent, true);
    }
  }
});

test("rebuilding tracks releases a shared multi-pass geometry only once", () => {
  const scene = fixture(); scene.buildTracks();
  const object = player(scene), geometry = object.line.geometry;
  let geometryDisposals = 0, materialDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  for (const pass of [object.line, object.outline, object.occludedLine]) pass.material.addEventListener("dispose", () => materialDisposals++);
  scene.buildTracks();
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 3);
  assert.notEqual(player(scene).line.geometry, geometry); assert.equal(scene.trailRoot.children.length, 1);
});

test("discontinuity gaps never become visible or occluded bridge segments", () => {
  const scene = fixture({ events: [{ type: "warp", t: 0.75, playerId: "synthetic-player" }] });
  scene.buildTracks(); scene.setTime(2);
  const { line, occludedLine } = player(scene);
  assert.deepEqual(line.userData.endTimes, [0.5, 1.5]); assert.equal(line.geometry.instanceCount, 2);
  assert.equal(occludedLine.geometry.instanceCount, 2);
  scene.setTime(0.75); close(player(scene).marker.position.toArray(), [3, 5, 7]);
});

test("single chapter clips unassigned XYZ to spatial bounds without using global progression as ownership", () => {
  const samples = [
    { t: 0, pos: [-5, 1, 5], yaw: 0, activeSegment: 99 },
    { t: 0.5, pos: [5, 3, 5], yaw: 0, activeSegment: 99 },
    { t: 1, pos: [15, 5, 5], yaw: 0, activeSegment: 99 },
    { t: 1.5, pos: [18, 5, 5], yaw: 0, activeSegment: 99 },
  ];
  const original = structuredClone(samples), scene = fixture({ samples, activeSegment: 1 });
  scene.useMap = true; scene.origin.set(0, 0, 0);
  scene.mapPack = { layers: [{ segment: 1, minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 }] };
  scene.currentBounds = { min: [-100, -100, -100], max: [100, 100, 100] };
  scene.buildTracks();
  const object = player(scene), geometry = object.line.geometry;
  assert.deepEqual(object.line.userData.endTimes, [0.5, 1]);
  close(vec3(geometry.attributes.instanceStart, 0), [0, 2, 5]); close(vec3(geometry.attributes.instanceEnd, 0), [5, 3, 5]);
  close(vec3(geometry.attributes.instanceStart, 1), [5, 3, 5]); close(vec3(geometry.attributes.instanceEnd, 1), [10, 4, 5]);
  scene.setTime(0.4); assert.equal(geometry.instanceCount, 0, "a clipped endpoint must not reveal a future segment early");
  scene.setTime(0.5); assert.equal(geometry.instanceCount, 1); assert.equal(object.marker.visible, true);
  close(object.marker.position.toArray(), [5, 3, 5]);
  scene.setTime(1); assert.equal(geometry.instanceCount, 2); assert.equal(object.marker.visible, false, "a different chapter's marker is not drawn through the walls");
  scene.setTime(0.125); assert.equal(geometry.instanceCount, 0); assert.equal(object.marker.visible, false);
  assert.deepEqual(samples, original, "view clipping must not assign a fake per-player segment or flatten Y");
  scene.activeSegment = null; scene.buildTracks(); scene.setTime(1.5);
  assert.equal(player(scene).line.geometry.instanceCount, 3, "overview retains the recorded unclipped route");
  assert.equal(player(scene).marker.visible, true);
});

test("a real recorded per-player segment still excludes another chapter even if XYZ overlaps", () => {
  const scene = fixture({ activeSegment: 1, samples: defaultSamples().map((sample) => ({ ...sample, segment: 2 })) });
  scene.useMap = true;
  scene.mapPack = { layers: [{ segment: 1, minX: 0, minY: 0, minZ: 0, maxX: 1000, maxY: 1000, maxZ: 1000 }] };
  scene.buildTracks(); scene.setTime(1.5);
  assert.deepEqual(player(scene).line.userData.endTimes, []);
  assert.equal(player(scene).line.geometry.instanceCount, 0); assert.equal(player(scene).occludedLine.geometry.instanceCount, 0);
  assert.equal(player(scene).marker.visible, false);
});

test("near-camera markers hide and restore automatically without modifying any trail depth pass", () => {
  const scene = fixture(); scene.buildTracks(); scene.setTime(0.5);
  const { marker, line, outline, occludedLine } = player(scene), passes = [line, outline, occludedLine];
  assert.equal(marker.userData.replayVisible, true);
  scene.camera.position.copy(marker.position); scene.updateCameraMarkerVisibility();
  assert.equal(marker.visible, false); assert.equal(marker.userData.replayVisible, true, "proximity does not erase replay eligibility");
  assert.ok(passes.every((pass) => pass.visible && pass.geometry.instanceCount === 1));
  scene.camera.position.x += 1.79; scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, false);
  scene.camera.position.x += 0.02; scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, true);
  scene.camera.position.copy(marker.position); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, false);
  assert.ok(passes.every((pass) => pass.visible && pass.geometry.instanceCount === 1));
  close(marker.position.toArray(), [3, 5, 7]);
});

test("moving the camera away cannot restore markers hidden by toggles, chapter bounds or player departure", () => {
  const scene = fixture(); scene.buildTracks(); scene.setTime(0.5);
  scene.setMarkerVisibility(false); scene.camera.position.set(500, 500, 500); scene.updateCameraMarkerVisibility();
  assert.equal(player(scene).marker.userData.replayVisible, false); assert.equal(player(scene).marker.visible, false);
  scene.setMarkerVisibility(true); scene.updateCameraMarkerVisibility(); assert.equal(player(scene).marker.visible, true);
  scene.activeSegment = 1; scene.useMap = true;
  scene.mapPack = { layers: [{ segment: 1, minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 10 }] };
  scene.setTime(0.5); scene.updateCameraMarkerVisibility();
  assert.equal(player(scene).marker.userData.replayVisible, false); assert.equal(player(scene).marker.visible, false);
  scene.activeSegment = null; scene.useMap = false;
  scene.trace.events.push({ type: "leave", t: 0.25, playerId: "synthetic-player" });
  scene.buildTracks(); scene.setTime(0.5); scene.updateCameraMarkerVisibility();
  assert.equal(player(scene).marker.userData.replayVisible, false); assert.equal(player(scene).marker.visible, false);
});

test("camera clearance uses origin-relative world positions and scaled marker transforms", () => {
  const scene = fixture(); scene.buildTracks(); scene.setTime(0.5); scene.setHeightScale(3);
  const { marker } = player(scene);
  // Recorded Unity coordinates are [103,205,307], local origin is [100,200,300],
  // and the common trail root scales Y. Actual rendered world anchor is [3,15,7].
  scene.camera.position.set(3, 15, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, false);
  close(scene.markerWorldPosition.toArray(), [3, 15, 7]);
  scene.camera.position.set(3, 5, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, true, "unscaled local coordinates are not the rendered marker location");
  scene.camera.position.set(3 + 5.39, 15, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, false);
  scene.camera.position.set(3 + 5.41, 15, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, true);
  scene.setHeightScale(0.2);
  scene.camera.position.set(3 + 1.79, 1, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, false, "shrinking terrain must not shrink the minimum 1.8-unit clearance");
  scene.camera.position.set(3 + 1.81, 1, 7); scene.updateCameraMarkerVisibility(); assert.equal(marker.visible, true);
  close(marker.position.toArray(), [3, 5, 7], 1e-6);
});

test("static fog replacement wiring distinguishes legacy display objects from verified recorded-world surface mappings", () => {
  const calls = [], scene = fixture({ spatial: {
    updateMapFogSurfaceVisibility(root, objects) { calls.push({ root, objects }); },
  } });
  scene.buildTracks(); scene.worldRenderer.enabled = true;
  const legacyObjects = [{ objectId: "map-fog:3", authority: "map-baseline", kind: "sleep_fog", segment: 3 }];
  const verifiedVolumes = [{ objectId: "map-fog:verified", authority: "map-baseline", kind: "sleep_fog", segment: 4 }];
  scene.worldRenderer.objects = legacyObjects; scene.worldRenderer.mapFog = { volumes: verifiedVolumes };
  scene.trace.worldTimeline = { captured: false }; scene.setTime(1);
  assert.equal(calls.at(-1).root, scene.terrainRoot); assert.equal(calls.at(-1).objects, legacyObjects);
  const dynamicObjects = [{ objectId: "live-fog:1", kind: "sleep_fog", pos: [999, 444, 555], source: "StatusFieldGloom.Drowsy" }];
  scene.trace.worldTimeline = { captured: true, firstTime: 10 };
  scene.worldRenderer.objects = dynamicObjects; scene.setTime(11);
  assert.equal(calls.at(-1).objects, verifiedVolumes, "moving live fog must not be matched to static geometry by position");
  assert.notEqual(calls.at(-1).objects, dynamicObjects);
  scene.worldRenderer.objects = []; scene.setTime(0);
  assert.equal(calls.at(-1).objects, verifiedVolumes, "before the first recorded sample, an initial static plane must not fabricate future live fog");
  scene.setTime(12);
  assert.equal(calls.at(-1).objects, verifiedVolumes, "a recorded complete empty world must not restore the old static fog plane");
});

test("world-off restores static fog and an unmapped captured world never guesses a replacement", () => {
  const calls = [], scene = fixture({ spatial: {
    updateMapFogSurfaceVisibility(root, objects) { calls.push(objects); },
  } });
  scene.buildTracks(); scene.worldRenderer.enabled = true;
  scene.worldRenderer.objects = [{ objectId: "live-fog:1", kind: "sleep_fog", pos: [1, 2, 3] }];
  scene.trace.worldTimeline = { captured: true };
  scene.worldRenderer.mapFog = null; scene.setTime(1);
  assert.deepEqual(calls.at(-1), [], "no verified map identity means no static mesh can be hidden by guessed proximity");
  scene.worldRenderer.mapFog = { volumes: [{ objectId: "map-fog:known", authority: "map-baseline", segment: 3 }] };
  scene.setWorldVisibility(false); assert.deepEqual(calls.at(-1), []);
  scene.trace.worldTimeline = { captured: false }; scene.setTime(2);
  assert.deepEqual(calls.at(-1), [], "world-off restores static geometry for legacy logs too");
  scene.setWorldVisibility(true); assert.equal(calls.at(-1), scene.worldRenderer.objects);
});
