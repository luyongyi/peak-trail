import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { ReplayCamera } from "../src/replay-camera.js";
import { MapLootFocus, chooseMapLootFocusPose } from "../src/map-loot-focus.js";
import { lootTypeStyle } from "../src/map-loot-style.js";
import { FollowTerrainQuery } from "../src/follow-terrain.js";

const orbitSource = (await readFile(new URL("../../vendor/three/0.180.0/examples/jsm/controls/OrbitControls.js", import.meta.url), "utf8"))
  .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, "").replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
const OrbitControls = new Function(...Object.keys(THREE), `${orbitSource}\nreturn OrbitControls;`)(...Object.values(THREE));
const sceneSource = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const TrailScene = new Function("THREE", "FollowTerrainQuery", `${sceneSource}\nreturn TrailScene;`)(THREE, FollowTerrainQuery);

class Surface extends EventTarget {
  emit(name, properties = {}) { const event = new Event(name, { cancelable: true }); Object.assign(event, properties); this.dispatchEvent(event); return event; }
}

function fixture(t, { reducedMotion = false, aspect = 1.5 } = {}) {
  const document = new Surface(); document.defaultView = new Surface();
  const canvas = new Surface(); canvas.ownerDocument = document; canvas.getRootNode = () => document;
  canvas.style = {}; canvas.tagName = "CANVAS"; canvas.clientHeight = 800; canvas.clientWidth = 1200;
  const attributes = new Map();
  canvas.getAttribute = key => attributes.get(key) ?? null;
  canvas.setAttribute = (key, value) => attributes.set(key, String(value)); canvas.removeAttribute = key => attributes.delete(key);
  canvas.focus = () => { document.activeElement = canvas; }; canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {};
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 1200, height: 800 });
  const camera = new THREE.PerspectiveCamera(38, aspect, 0.27, 4200); camera.position.set(100, 135, 180);
  const controls = new OrbitControls(camera, canvas); controls.target.set(2, 3, 4); controls.update();
  controls.enableDamping = true; controls.screenSpacePanning = false; controls.minDistance = 2; controls.maxDistance = 1000;
  const scene = Object.create(TrailScene.prototype);
  const freeCamera = new ReplayCamera({ THREE, camera, controls, canvas,
    onModeChange() { if (!scene.mapLootFocus?.changingMode) scene.clearMapLootFocus(); scene.surveyPreset = null; } });
  const selected = [], events = [];
  canvas.addEventListener("peaktrail-loot-focus", event => events.push(event.detail));
  let clock = 1000;
  Object.assign(scene, { canvas, camera, controls, freeCamera, followTargetId: null, surveyPreset: "overview",
    cameraSelectionRevision: 0, origin: new THREE.Vector3(100, 200, 300), heightScale: 1.5,
    mapLootOverlay: { setSelected: value => selected.push(value) }, playerObjects: new Map() });
  const focus = scene.mapLootFocus = new MapLootFocus(scene, THREE, { now: () => clock, reducedMotion: () => reducedMotion });
  const marker = (id = "a", changes = {}) => ({ id, pos: [108, 208, 312], type: "chest_small", category: "chest", name: "LUGGAGE", ...changes });
  const finish = () => { clock += 650; focus.update(clock); };
  t.after(() => { focus.clear(); freeCamera.dispose(); controls.dispose(); });
  return { scene, camera, controls, freeCamera, canvas, focus, marker, selected, events, finish,
    advance(ms) { clock += ms; focus.update(clock); } };
}

function pose(f) {
  return { position: f.camera.position.toArray(), quaternion: f.camera.quaternion.toArray(), up: f.camera.up.toArray(),
    target: f.controls.target.toArray(), near: f.camera.near, far: f.camera.far };
}

function assertPose(f, expected) {
  const actual = pose(f);
  for (const key of ["position", "quaternion", "up", "target"]) actual[key].forEach((v, i) => assert.ok(Math.abs(v - expected[key][i]) < 1e-9, `${key}[${i}]`));
  assert.equal(actual.near, expected.near); assert.equal(actual.far, expected.far);
}

test("close-up animates toward the actual anchor and returns the exact original camera without a fit", t => {
  const f = fixture(t), original = pose(f);
  f.controls.maxPolarAngle = 1.47; const config = { enabled: f.controls.enabled, enableDamping: true,
    autoRotate: false, minDistance: 2, maxDistance: 1000, maxPolarAngle: 1.47 };
  assert.equal(f.focus.focus(f.marker()), true); assert.equal(f.controls.enabled, false);
  f.advance(325); assert.notDeepEqual(pose(f).position, original.position);
  f.finish(); assert.equal(f.controls.enabled, true); assert.equal(f.events.at(-1).active, true);
  assert.deepEqual(f.controls.target.toArray(), [8, 16, -12]);
  assert.ok(f.camera.position.distanceTo(f.controls.target) >= 25.99999 && f.camera.position.distanceTo(f.controls.target) <= 35.00001);
  f.scene.restoreMapLootView(); f.finish(); assertPose(f, original);
  for (const [key, value] of Object.entries(config)) assert.equal(f.controls[key], value, key);
  assert.equal(f.scene.surveyPreset, "overview"); assert.equal(f.events.at(-1).active, false); assert.equal(f.selected.at(-1), null);
});

test("switching several markers and clicking the current one retains the first return point", t => {
  const f = fixture(t), original = pose(f);
  f.focus.focus(f.marker()); f.finish();
  f.focus.focus(f.marker("b", { pos: [150, 220, 305] })); f.finish();
  f.focus.focus(f.marker("b")); f.finish(); assertPose(f, original); assert.equal(f.focus.snapshot, null);
});

test("dragging interrupts either flight but preserves the return action and never carries damping into it", t => {
  const f = fixture(t), original = pose(f);
  f.focus.focus(f.marker()); f.advance(200); f.focus.interrupt(); const partial = pose(f);
  f.advance(1000); assert.deepEqual(pose(f), partial); assert.ok(f.focus.snapshot); assert.equal(f.controls.enabled, true);
  f.controls._sphericalDelta.theta = 0.4; f.controls.update();
  f.focus.restore(); f.advance(100); f.focus.interrupt(); assert.ok(f.focus.marker);
  f.focus.restore(); f.finish(); assertPose(f, original);
  f.controls.update(); assertPose(f, original);
});

test("reduced motion performs both transitions immediately", t => {
  const f = fixture(t, { reducedMotion: true }), original = pose(f);
  f.focus.focus(f.marker()); assert.equal(f.focus.animation, null); assert.equal(f.controls.enabled, true);
  f.focus.restore(); assertPose(f, original); assert.equal(f.focus.marker, null);
});

test("free camera restores its own pose and saved orbit independently", t => {
  const f = fixture(t), orbit = pose(f);
  f.freeCamera.enterAt([12, 9, 44], [0.5, -0.1, 1]); const original = pose(f);
  f.focus.focus(f.marker()); f.finish(); assert.equal(f.freeCamera.mode, "orbit");
  f.focus.restore(); f.finish(); assertPose(f, original); assert.equal(f.freeCamera.mode, "free"); assert.equal(f.controls.enabled, false);
  f.freeCamera.setMode("orbit"); assertPose(f, orbit);
});

test("a followed player returns as a usable static view rather than resuming camera ownership", t => {
  const f = fixture(t); f.scene.followTargetId = "player-a"; f.controls.enabled = false;
  f.scene.setFollowTarget = () => { f.scene.followTargetId = null; f.controls.enabled = true; };
  const original = pose(f); f.focus.focus(f.marker()); f.finish(); f.focus.restore(); f.finish();
  assertPose(f, original); assert.equal(f.scene.followTargetId, null); assert.equal(f.controls.enabled, true);
});

test("localized marker metadata updates the focus label while hiding it restores the view", t => {
  const f = fixture(t), original = pose(f); f.focus.focus(f.marker()); f.finish();
  const before = pose(f); f.focus.reconcile([f.marker("a", { name: "行李箱" })]);
  assert.deepEqual(pose(f), before); assert.equal(f.events.at(-1).name, "行李箱");
  f.focus.reconcile([]); assert.equal(f.focus.animation.restoring, true); f.finish(); assertPose(f, original);
});

test("clearing a stale map focus stops its animation and disables restoration", t => {
  const f = fixture(t); f.focus.focus(f.marker()); f.advance(80); f.scene.clearMapLootFocus();
  const previous = pose(f); f.advance(1000); assert.deepEqual(pose(f), previous);
  assert.equal(f.scene.restoreMapLootView(), false); assert.equal(f.events.at(-1).active, false);
});

for (const category of ["item", "chest", "animal"]) for (const aspect of [1.78, 0.46]) {
  test(`${category} close-up keeps its actual anchor and finite beacon visible at aspect ${aspect}`, t => {
    const f = fixture(t, { aspect }); const marker = f.marker("a", { category, type: category });
    f.focus.focus(marker); f.finish(); f.camera.updateMatrixWorld(true);
    const anchor = new THREE.Vector3(8, 12, -12);
    for (const height of [0, lootTypeStyle(category, category).beamHeight]) {
      const point = anchor.clone().add(new THREE.Vector3(0, height, 0)).project(f.camera);
      assert.ok(Math.abs(point.x) < 0.9 && Math.abs(point.y) < 0.9 && Math.abs(point.z) < 1, JSON.stringify(point));
    }
  });
}

test("tap detection ignores dragging back, cancelled and multi-touch gestures; player hits retain priority", t => {
  const f = fixture(t); let selections = 0, players = 0;
  f.scene.mapLootFocus = { interrupt() {}, capture() { return {}; }, focus() { selections++; } };
  f.scene.pickPlayerMarker = () => null; f.scene.pickMapLootMarker = () => f.marker();
  const down = (id, x = 100, changes = {}) => f.scene.onFollowPointerDown({ pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: 120, preventDefault() {}, ...changes });
  const up = (id, x = 100) => f.scene.onFollowPointerUp({ pointerId: id, button: 0, clientX: x, clientY: 120 });
  down(1); f.scene.onFollowPointerMove({ pointerId: 1, clientX: 130, clientY: 120 }); up(1); assert.equal(selections, 0);
  down(2); f.scene.onFollowPointerCancel({ pointerId: 2 }); up(2); assert.equal(selections, 0);
  down(3); down(4, 110, { isPrimary: false }); up(4, 110); up(3); assert.equal(selections, 0);
  down(5); up(5); assert.equal(selections, 1);
  f.scene.pickPlayerMarker = () => "player-a"; f.scene.lockFollowTarget = () => { players++; };
  down(6); up(6); assert.equal(players, 1); assert.equal(selections, 1);
  f.scene.mapLootFocus = f.focus;
});

test("screen picking uses local CSS pixels and rejects a hidden canvas", t => {
  const f = fixture(t); let input;
  f.scene.mapLootOverlay.pickScreen = value => { input = value; return f.marker(); };
  assert.equal(f.scene.pickMapLootMarker({ clientX: 110, clientY: 220 }).id, "a");
  assert.equal(input.x, 100); assert.equal(input.y, 200); assert.equal(input.width, 1200); assert.equal(input.camera, f.camera);
  f.canvas.getBoundingClientRect = () => ({ width: 0, height: 0 });
  assert.equal(f.scene.pickMapLootMarker({ clientX: 0, clientY: 0 }), null);
});

for (const action of ["fitView", "topView", "toggleFreeCamera"]) {
  test(`explicit ${action} clears a previous close-up instead of leaving a stale return action`, t => {
    const f = fixture(t); f.scene.applySurveyPreset = () => {};
    f.focus.focus(f.marker()); f.advance(100); f.scene[action]();
    assert.equal(f.focus.snapshot, null); assert.equal(f.focus.animation, null);
    assert.equal(f.scene.restoreMapLootView(), false); assert.equal(f.events.at(-1).active, false);
    assert.equal(f.freeCamera.mode, action === "toggleFreeCamera" ? "free" : "orbit");
  });
}

test("height changes invalidate the stored world pose while unchanged height leaves focus intact", t => {
  const f = fixture(t); f.scene.applyHeightScale = () => {}; f.scene.setTime = () => {};
  f.focus.focus(f.marker()); f.finish();
  f.scene.setHeightScale(f.scene.heightScale); assert.ok(f.focus.snapshot);
  f.scene.setHeightScale(2); assert.equal(f.focus.snapshot, null); assert.equal(f.scene.restoreMapLootView(), false);
});

function roomQuery(t, { width = 20, height = 4, depth = 20 } = {}) {
  const root = new THREE.Group();
  const box = (size, position) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
    mesh.position.fromArray(position); root.add(mesh); return mesh;
  };
  box([width, 0.5, depth], [0, -0.25, 0]); box([width, 0.5, depth], [0, height + 0.25, 0]);
  box([0.5, height, depth], [-width / 2 - 0.25, height / 2, 0]); box([0.5, height, depth], [width / 2 + 0.25, height / 2, 0]);
  box([width, height, 0.5], [0, height / 2, -depth / 2 - 0.25]); box([width, height, 0.5], [0, height / 2, depth / 2 + 0.25]);
  const query = new FollowTerrainQuery(THREE).setRoots([root]);
  t.after(() => { query.dispose(); root.traverse(mesh => { mesh.geometry?.dispose(); mesh.material?.dispose(); }); });
  return { root, query };
}

test("an actual closed roof keeps the selected prop view inside its room at a low short distance", t => {
  const { query } = roomQuery(t);
  const anchor = new THREE.Vector3(), direction = new THREE.Vector3(0.4, 0.65, 0.7).normalize();
  const pose = chooseMapLootFocusPose({ THREE, anchor, direction, distance: 30, query,
    interiorReference: new THREE.Vector3(0, 0, 7) });
  assert.equal(pose.target.y, 1.2);
  assert.ok(pose.position.y > 0.3 && pose.position.y < 3.7);
  assert.ok(Math.abs(pose.position.x) < 10 && Math.abs(pose.position.z) < 10);
  assert.ok(pose.position.distanceTo(pose.target) >= 2 && pose.position.distanceTo(pose.target) <= 10.00001);
  const delta = pose.target.clone().sub(pose.position); const length = delta.length();
  assert.equal(query.cast(pose.position, delta.normalize(), length - 0.3), null, "real roof and walls cannot remain in front of the item");
});

test("a narrow real enclosure uses measured clearance instead of crossing its walls", t => {
  const { query } = roomQuery(t, { width: 2.5, height: 3, depth: 2.5 });
  const pose = chooseMapLootFocusPose({ THREE, anchor: new THREE.Vector3(), direction: new THREE.Vector3(0, 0.7, 0.7).normalize(), distance: 30, query });
  assert.ok(Math.abs(pose.position.x) < 1.25 && Math.abs(pose.position.z) < 1.25);
  assert.ok(pose.position.y > 0.3 && pose.position.y < 2.7);
  assert.ok(pose.position.distanceTo(pose.target) < 2);
});

test("a clear outdoor line of sight retains the original long composition", t => {
  const { query, root } = roomQuery(t);
  root.visible = false;
  const anchor = new THREE.Vector3(20, 30, -40), direction = new THREE.Vector3(0.4, 0.65, 0.7).normalize();
  const pose = chooseMapLootFocusPose({ THREE, anchor, direction, distance: 31, query });
  assert.deepEqual(pose.target.toArray(), [20, 34, -40]);
  assert.ok(Math.abs(pose.position.distanceTo(pose.target) - 31) < 1e-8);
});

test("focus queries index only the matching loaded chapter and visible enclosure context", t => {
  const f = fixture(t); f.scene.terrainRoot = new THREE.Group(); f.scene.buildToken = 1; f.scene.geometrySelectionToken = 2;
  const group = (id, segment, visible = true) => {
    const root = new THREE.Group(); root.visible = visible; root.userData = { layerId: id, segment, loaded: true };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); root.add(mesh);
    f.scene.terrainRoot.add(root); return root;
  };
  const selected = group("selected", 0), other = group("other", 1), hidden = group("hidden", 2, false);
  const context = new THREE.Group(); f.scene.enclosureContext = { root: context };
  f.scene.mapPack = { mapEnclosures: { enclosures: [{ segment: 0, interiorReference: [104, 202, 308] }] } };
  const first = f.scene.mapLootFocusTerrainQuery(f.marker("a", { layerId: "selected", segment: 0 }));
  assert.deepEqual(first.query.roots, [selected, context]);
  assert.ok(!first.query.roots.includes(other) && !first.query.roots.includes(hidden));
  assert.deepEqual(first.interiorReference.toArray(), [4, 3, -8]);
  assert.equal(f.scene.mapLootFocusTerrainQuery(f.marker("b", { layerId: "selected", segment: 0 })).query, first.query);
  f.scene.heightScale = 2;
  const changed = f.scene.mapLootFocusTerrainQuery(f.marker("c", { layerId: "selected", segment: 0 }));
  assert.notEqual(changed.query, first.query); assert.equal(first.query.entries.length, 0);
  f.scene.activeSegment = 0;
  const global = f.marker("global", { scope: "global", layerId: "global", segment: -1 });
  assert.deepEqual(f.scene.mapLootFocusTerrainQuery(global).query.roots, [selected, context]);
  f.scene.activeSegment = null;
  selected.userData.mapLayer = { minX: 100, maxX: 120, minY: 200, maxY: 220, minZ: 300, maxZ: 320 };
  other.userData.mapLayer = { minX: 1000, maxX: 1200, minY: 2000, maxY: 2200, minZ: 3000, maxZ: 3200 };
  assert.deepEqual(f.scene.mapLootFocusTerrainQuery(global).query.roots, [selected, context], "overview globals index a nearby loaded layer rather than the whole mountain");
  t.after(() => { changed.query.dispose(); f.scene.terrainRoot.traverse(mesh => { mesh.geometry?.dispose(); mesh.material?.dispose(); }); });
});
