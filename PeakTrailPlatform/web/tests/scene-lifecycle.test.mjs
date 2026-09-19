import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { layoutPortraitLabels, clusterPlayerEntries } from "../src/portrait-layout.js";
import { latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES } from "../src/protocol.js";
import { chooseRecordedInteriorPose, isInteriorLayer } from "../src/camera-placement.js";
import { ReplayCamera } from "../src/replay-camera.js";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";

// Exercise the actual scene methods without a browser/WebGL context. Only the
// imported renderer ports are replaced; no lifecycle method is reimplemented.
const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace("export class TrailScene", "class TrailScene");

function group(layer = null) {
  return {
    children: [],
    userData: layer ? { mapLayer: layer, segment: layer.segment, loaded: false } : {},
    position: { copy() { return this; }, multiplyScalar() { return this; } },
    add(child) { this.children.push(child); },
    clear() { this.children = []; },
    traverse(visitor) { visitor(this); this.children.forEach((child) => child.traverse(visitor)); },
  };
}

function model() {
  const result = group();
  result.disposed = 0;
  result.geometry = { dispose() { result.disposed++; } };
  return result;
}

function fixture(selected = 0) {
  const requests = [];
  const load = (layer, signal, gameBuildId) => new Promise((resolve, reject) => requests.push({ layer: layer.id, signal, gameBuildId, resolve, reject }));
  const TrailScene = new Function("THREE", "loadGameGeometry", "cancelAnimationFrame", "layoutPortraitLabels", "clusterPlayerEntries", "latestLifeEventBefore", "MARKER_LIFE_EVENT_TYPES", "isInteriorLayer", "chooseRecordedInteriorPose", `${source}\nreturn TrailScene;`)(
    THREE, load, () => {}, layoutPortraitLabels, clusterPlayerEntries, latestLifeEventBefore, MARKER_LIFE_EVENT_TYPES, isInteriorLayer, chooseRecordedInteriorPose,
  );
  const layers = [
    { id: "A", segment: 0, biome: "shore" },
    { id: "B", segment: 1, biome: "roots" },
    { id: "C", segment: 2, biome: "mesa" },
  ];
  const scene = Object.create(TrailScene.prototype);
  Object.assign(scene, {
    mapPack: { identityVersion: 3, gameBuildId: "25306743", layers }, useMap: true, activeSegment: selected,
    buildToken: 1, geometrySelectionToken: 1, geometryAbort: new AbortController(), geometryLoads: new Map(),
    origin: { clone() { return this; } }, terrainRoot: group(), trailRoot: group(), gridRoot: group(),
    playerGroups: new Map(), playerPortraits: new Map(), playerLabels: new Map(), playerObjects: new Map(),
    playerColors: new Map(),
    statuses: [], resizeObserver: { disconnect() {} }, controls: { dispose() {} }, renderer: { dispose() {} },
    cameraSelectionRevision: 0,
    freeCamera: { mode: "orbit", setMode(value) { this.mode = value; }, focus() {}, dispose() {} }, worldRenderer: { dispose() {} }, fogDepthPass: { dispose() {} },
    emitMapStatus(...args) { this.statuses.push(args); }, setTime() {}, fitView() { ++this.cameraSelectionRevision; },
  });
  scene.terrainRoot.children = layers.map(group);
  return { scene, requests };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a stale chapter completing after the selected chapter is disposed, not cached or attached", async () => {
  const { scene, requests } = fixture();
  const pendingA = scene.ensureGeometryLayers();
  assert.equal(requests[0].gameBuildId, "25306743");
  scene.setActiveSegment(1);
  const a = model(); const b = model();
  requests[1].resolve(b); await flush();
  requests[0].resolve(a); await pendingA;
  assert.equal(a.disposed, 1);
  assert.equal(b.disposed, 0);
  assert.equal(scene.terrainRoot.children[0].children.length, 0);
  assert.equal(scene.terrainRoot.children[1].children.length, 1);
  assert.deepEqual([...scene.geometryLoads.keys()], ["B"]);
  assert.deepEqual(scene.statuses.filter(([status]) => status === "ready").map(([, , segment]) => segment), [1]);
});

test("A to B to A reuses the pending A request and mounts it exactly once", async () => {
  const { scene, requests } = fixture();
  const originalA = scene.ensureGeometryLayers();
  scene.setActiveSegment(1);
  scene.setActiveSegment(0);
  assert.deepEqual(requests.map((request) => request.layer), ["A", "B"]);
  const a = model(); const b = model();
  requests[0].resolve(a); await originalA; await flush();
  requests[1].resolve(b); await flush();
  assert.equal(a.disposed, 0);
  assert.equal(b.disposed, 1);
  assert.equal(scene.terrainRoot.children[0].children.length, 1);
  assert.deepEqual([...scene.geometryLoads.keys()], ["A"]);
  assert.deepEqual(scene.statuses.filter(([status]) => status === "ready").map(([, , segment]) => segment), [0]);
});

test("leaving overview cancels its remaining queue even when the first parse is already running", async () => {
  const { scene, requests } = fixture(null);
  const overview = scene.ensureGeometryLayers();
  scene.setActiveSegment(1);
  requests[1].resolve(model()); await flush();
  requests[0].resolve(model()); await overview;
  assert.deepEqual(requests.map((request) => request.layer), ["A", "B"]);
  assert.deepEqual([...scene.geometryLoads.keys()], ["B"]);
});

test("dispose invalidates an already parsing model and emits no late ready status", async () => {
  const { scene, requests } = fixture();
  const pending = scene.ensureGeometryLayers();
  const detached = scene.terrainRoot.children[0];
  scene.dispose();
  assert.equal(requests[0].signal.aborted, true);
  const late = model(); requests[0].resolve(late); await pending;
  assert.equal(late.disposed, 1);
  assert.equal(detached.children.length, 0);
  assert.equal(scene.geometryLoads.size, 0);
  assert.equal(scene.statuses.some(([status]) => status === "ready"), false);
});

test("stale request errors cannot overwrite current status or evict a newer cache entry", async () => {
  const { scene, requests } = fixture();
  const pendingA = scene.ensureGeometryLayers();
  scene.setActiveSegment(1);
  requests[1].resolve(model()); await flush();
  const newerRequest = Promise.resolve();
  scene.geometryLoads.set("A", newerRequest);
  requests[0].reject(new Error("old A failed")); await pendingA;
  assert.equal(scene.geometryLoads.get("A"), newerRequest);
  assert.equal(scene.statuses.some(([status]) => status === "error"), false);
  assert.equal(scene.statuses.at(-1)[0], "ready");
});

test("an explicit Void chapter loads normally but overview neither loads nor reveals it", async () => {
  const { scene, requests } = fixture(null);
  const voidLayer = { id: "Void", segment: 5, biome: "Void" };
  scene.mapPack.layers.push(voidLayer);
  const voidGroup = group(voidLayer); scene.terrainRoot.children.push(voidGroup);
  scene.applyLayerVisibility();
  assert.equal(voidGroup.visible, false);
  assert.equal(scene.isGeometryLayerRequested(voidLayer), false);
  scene.setActiveSegment(5);
  assert.deepEqual(requests.map((request) => request.layer), ["Void"]);
  requests[0].resolve(model()); await flush();
  assert.equal(voidGroup.visible, true);
  assert.equal(voidGroup.userData.loaded, true);
});

test("a failed current chapter clears its pending cache and can be retried", async () => {
  const { scene, requests } = fixture();
  const failed = scene.ensureGeometryLayers();
  requests[0].reject(new Error("network failed")); await failed;
  assert.equal(scene.geometryLoads.size, 0);
  assert.equal(scene.statuses.at(-1)[0], "error");
  const retry = scene.ensureGeometryLayers();
  requests[1].resolve(model()); await retry;
  assert.equal(scene.terrainRoot.children[0].userData.loaded, true);
  assert.equal(scene.statuses.at(-1)[0], "ready");
});

test("map overview fits the entire mountain instead of a short imported route", () => {
  const { scene } = fixture(null);
  scene.currentBounds = { min: [-200, 0, -400], max: [200, 1000, 1400] };
  scene.trace = { bounds: { min: [0, 0, 0], max: [2, 3, 4] } };
  assert.equal(scene.viewBounds(), scene.currentBounds);
  scene.useMap = false;
  assert.equal(scene.viewBounds(), scene.trace.bounds);
  Object.assign(scene.mapPack.layers[1], { minX: 10, minY: 20, minZ: 30, maxX: 40, maxY: 50, maxZ: 60 });
  scene.useMap = true; scene.activeSegment = 1;
  assert.deepEqual(scene.viewBounds(), { min: [10, 20, 30], max: [40, 50, 60] });
});

test("portrait overlays follow visible players and are clipped outside the camera", () => {
  const { scene } = fixture();
  const label = { element: { hidden: true, style: {} } };
  let point = { x: 0, y: 0, z: 0 };
  const marker = { visible: true, getWorldPosition(vector) { Object.assign(vector, point); } };
  scene.labelPosition = { project() {} };
  scene.canvas = { clientWidth: 1000, clientHeight: 600 };
  scene.playerLabels = new Map([["qa", label]]);
  scene.playerObjects = new Map([["qa", { group: { visible: true }, marker }]]);
  scene.updatePlayerLabelPositions();
  assert.equal(label.element.hidden, false);
  assert.equal(label.element.style.transform, "translate(460px, 230px)");
  marker.visible = false;
  scene.updatePlayerLabelPositions();
  assert.equal(label.element.hidden, true);
  marker.visible = true; point = { x: 0, y: 0, z: 2 };
  scene.updatePlayerLabelPositions();
  assert.equal(label.element.hidden, true);
  point = { x: 0, y: 0, z: 0 }; scene.playerObjects.get("qa").group.visible = false;
  scene.updatePlayerLabelPositions();
  assert.equal(label.element.hidden, true);
});

test("players within 10 recorded metres pack into one badge holding every member head", () => {
  const { scene } = fixture();
  const fakeElement = (tag) => ({
    tag, className: "", hidden: false, title: "", textContent: "", alt: "",
    children: [], dataset: {}, style: { setProperty() {} },
    append(...nodes) { this.children.push(...nodes); },
    removeAttribute() {},
  });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => fakeElement(tag) };
  try {
    const overlay = { children: [], append(...nodes) { this.children.push(...nodes); } };
    scene.labelOverlay = overlay;
    scene.canvas = { clientWidth: 1000, clientHeight: 600 };
    // A linear world → NDC stand-in for the camera so world offsets stay observable.
    scene.labelPosition = { project() { this.x /= 100; this.y /= 100; this.z = 0; } };
    const positions = { a: { x: 0, y: 0, z: 0 }, b: { x: 2, y: 0, z: 0 }, c: { x: 4, y: 0, z: 0 },
      d: { x: 6, y: 0, z: 0 }, e: { x: 8, y: 0, z: 0 } };
    for (const id of Object.keys(positions)) {
      scene.playerLabels.set(id, { element: fakeElement("div"), leader: fakeElement("div") });
      scene.playerObjects.set(id, { group: { visible: true },
        marker: { visible: true, getWorldPosition(vector) { Object.assign(vector, positions[id]); } } });
    }

    scene.updatePlayerLabelPositions();
    assert.equal(scene.playerGroups.size, 1, "one badge for the five players inside 10 m");
    for (const id of Object.keys(positions)) assert.equal(scene.playerLabels.get(id).element.hidden, true,
      "the individual label yields to the shared badge");
    const group = scene.playerGroups.values().next().value;
    assert.equal(group.element.hidden, false);
    assert.equal(group.members.size, 5);
    assert.deepEqual([...group.members.keys()].sort(), ["a", "b", "c", "d", "e"]);
    assert.equal(group.ring.children.length, 5, "every member keeps a portrait slot");
    assert.equal(group.columns, 3, "five heads wrap as a 3 + 2 block instead of one wide row");
    assert.equal(group.names.textContent.startsWith("5 人 · "), true);
    // The badge sits on the members' average anchor (500…540 px), not on one member.
    assert.deepEqual(group.element.style.transform, "translate(472px, 196px)");
    assert.ok(overlay.children.includes(group.element));
    assert.ok(overlay.children.includes(group.leader));

    // Walking apart restores the original label for everyone who left the badge.
    Object.assign(positions, { c: { x: 60, y: 0, z: 0 }, d: { x: 71, y: 0, z: 0 }, e: { x: 82, y: 0, z: 0 } });
    scene.updatePlayerLabelPositions();
    assert.equal(group.element.hidden, true, "the old badge is hidden once the party splits");
    for (const id of ["c", "d", "e"]) {
      assert.equal(scene.playerLabels.get(id).element.hidden, false, `${id} returns to its own label`);
    }
    const pair = [...scene.playerGroups.values()].find((entry) => entry.element.hidden === false);
    assert.deepEqual([...pair.members.keys()].sort(), ["a", "b"], "only the two still together stay grouped");
    assert.equal(pair.columns, 2);
    assert.equal(scene.playerLabels.get("a").element.hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("rewinding to unknown appearance removes the image instead of retaining the future face", () => {
  const { scene } = fixture();
  const label = { url: null, image: { hidden: true, removeAttribute() { delete this.src; } }, fallback: { hidden: false } };
  scene.playerPortraits = new Map();
  scene.playerLabels = new Map([["qa", label]]);
  scene.setPlayerPortrait("qa", "data:image/png;base64,fixture");
  assert.equal(label.image.hidden, false);
  assert.equal(label.fallback.hidden, true);
  scene.setPlayerPortrait("qa", null);
  assert.equal(label.image.hidden, true);
  assert.equal(label.fallback.hidden, false);
  assert.equal(label.image.src, undefined);
  assert.equal(scene.playerPortraits.size, 0);
});

test("delayed interior geometry cannot override a camera mode the user chose while loading", async () => {
  const { scene, requests } = fixture();
  scene.mapPack.layers[1].name = "Temple_Segment";
  const placements = [];
  scene.enterInteriorView = (focus) => placements.push(focus);
  scene.setActiveSegment(1);
  scene.toggleFreeCamera();
  requests[0].resolve(model());
  await flush();
  assert.equal(scene.freeCamera.mode, "free");
  assert.deepEqual(placements, []);
});

test("uninterrupted interior chapter load requests automatic placement without stealing focus", async () => {
  const { scene, requests } = fixture();
  scene.mapPack.layers[1].name = "Temple_Segment";
  const placements = [];
  scene.enterInteriorView = (focus) => placements.push(focus);
  scene.setActiveSegment(1);
  requests[0].resolve(model());
  await flush();
  assert.deepEqual(placements, [false]);
});

test("disposing an interior chapter during load cannot run a late camera placement", async () => {
  const { scene, requests } = fixture();
  scene.mapPack.layers[1].name = "Temple_Segment";
  const placements = [];
  scene.enterInteriorView = (focus) => placements.push(focus);
  scene.setActiveSegment(1);
  scene.dispose();
  requests[0].resolve(model());
  await flush();
  assert.deepEqual(placements, []);
});

test("actual scene interior camera uses the recorded torso center without adding a fictitious eye height", () => {
  const { scene } = fixture();
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.activeElement = { tagName: "INPUT" };
  const initialFocus = document.activeElement;
  const canvas = new EventTarget();
  canvas.ownerDocument = document;
  const attributes = new Map();
  canvas.getAttribute = (name) => attributes.get(name) ?? null;
  canvas.setAttribute = (name, value) => attributes.set(name, String(value));
  canvas.removeAttribute = (name) => attributes.delete(name);
  Object.defineProperty(canvas, "tabIndex", { get: () => Number(attributes.get("tabindex") ?? -1),
    set: (value) => attributes.set("tabindex", String(value)) });
  canvas.focus = () => { document.activeElement = canvas; };
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.5, 3200);
  camera.position.set(50, 60, 70);
  const controls = { enabled: true, enableDamping: true, autoRotate: false,
    target: new THREE.Vector3(), update() {} };
  const freeCamera = new ReplayCamera({ THREE, camera, controls, canvas });
  const center = [11, 1232, 2238];
  Object.assign(scene.mapPack.layers[0], { name: "Temple_Segment", minX: 0, maxX: 20,
    minY: 1200, maxY: 1233, minZ: 2200, maxZ: 2250 });
  Object.assign(scene, { canvas, camera, controls, freeCamera, currentTime: 5, heightScale: 1.7,
    origin: new THREE.Vector3(7, 1200, 2200), playerVisibility: new Map(),
    trace: { manifest: { sampleHz: 5 }, events: [], tracks: new Map([["qa:camera-center", [
      { t: 0, pos: [10, 1231, 2237], yaw: 0, segment: null },
      { t: 5, pos: center, yaw: 90, segment: null },
      { t: 10, pos: [12, 1231, 2239], yaw: 180, segment: null },
    ]]]) } });
  const placements = [];
  canvas.addEventListener("cameraplacement", (event) => placements.push(event.detail.note));
  scene.enterInteriorView(false);
  assert.deepEqual(camera.position.toArray(), [4, 32 * 1.7, -38], "rendered space is Z-mirrored (Unity LH → three RH)");
  assert.ok(camera.position.y < (1233 - 1200) * 1.7, "unrecorded standing height would place the camera above the layer ceiling");
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8);
  assert.equal(document.activeElement, initialFocus);
  assert.equal(camera.near, 0.05);
  assert.equal(camera.far, 3200);
  assert.equal(controls.enabled, false);
  assert.match(placements.at(-1), /玩家中心.*非眼位/);
  assert.deepEqual(center, [11, 1232, 2238], "camera placement must not modify the recorded sample");
  scene.enterInteriorView(true);
  assert.equal(document.activeElement, canvas);
  assert.deepEqual(camera.position.toArray(), [4, 32 * 1.7, -38], "rendered space is Z-mirrored (Unity LH → three RH)");
  freeCamera.setMode("orbit");
  assert.equal(camera.near, 0.5);
  assert.equal(controls.enabled, true);
  assert.deepEqual(camera.position.toArray(), [50, 60, 70]);
  freeCamera.dispose();
});

test("a stale settled task is retried with a fresh request instead of leaving the chapter unloaded", async () => {
  const { scene, requests } = fixture();
  // A task left over from an aborted round settles without mounting and removes
  // itself from the map, exactly like the real stale-dispose path does.
  scene.geometryLoads.set("A", Promise.resolve().then(() => scene.geometryLoads.delete("A")));
  const pending = scene.ensureGeometryLayers();
  await flush();
  assert.deepEqual(requests.map((request) => request.layer), ["A"], "the round retries with a fresh request");
  requests[0].resolve(model());
  await pending;
  assert.equal(scene.terrainRoot.children[0].children.length, 1);
  assert.deepEqual(scene.statuses.filter(([status]) => status === "ready").map(([, , segment]) => segment), [0]);
});

test("a task that repeatedly settles without mounting surfaces an error instead of spinning forever", async () => {
  const { scene, requests } = fixture();
  // Pathological entry: never mounts and never removes itself.
  scene.geometryLoads.set("A", Promise.resolve());
  await scene.ensureGeometryLayers();
  assert.deepEqual(requests, []);
  const error = scene.statuses.find(([status]) => status === "error");
  assert.ok(error, "the wedged chapter reports an error status");
  assert.match(error[1], /未能就绪/);
});
