import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { layoutPortraitLabels } from "../src/portrait-layout.js";

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
  const TrailScene = new Function("THREE", "loadGameGeometry", "cancelAnimationFrame", "layoutPortraitLabels", `${source}\nreturn TrailScene;`)(
    {}, load, () => {}, layoutPortraitLabels,
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
    statuses: [], resizeObserver: { disconnect() {} }, controls: { dispose() {} }, renderer: { dispose() {} },
    emitMapStatus(...args) { this.statuses.push(args); }, setTime() {}, fitView() {},
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
