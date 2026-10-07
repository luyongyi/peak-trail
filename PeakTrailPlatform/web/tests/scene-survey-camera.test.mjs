import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { fitSurveyCamera } from "../src/survey-camera-fit.js";
import { isInteriorLayer } from "../src/camera-placement.js";

const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const Scene = new Function("THREE", "fitSurveyCamera", "isInteriorLayer", `${source}\nreturn TrailScene;`)(THREE, fitSurveyCamera, isInteriorLayer);
const layers = [
  { id: "shore", segment: 0, name: "Shore_Segment", biome: "Shore", minX: -230, maxX: 230, minY: -127, maxY: 295, minZ: -540, maxZ: 340 },
  { id: "temple", segment: 4, name: "Temple_Segment", biome: "Swamp", minX: -120, maxX: 120, minY: 800, maxY: 1233, minZ: 2000, maxZ: 2400 },
];
function fixture() {
  const scene = Object.create(Scene.prototype), container = { clientWidth: 1280, clientHeight: 720 };
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 20000), target = new THREE.Vector3();
  const controls = { target, enableDamping: true, update() { camera.lookAt(target); } };
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  Object.assign(scene, { camera, controls, canvas: { parentElement: container },
    renderer: { setSize() {} }, freeCamera: { mode: "orbit", setMode(value) { this.mode = value; } },
    origin: new THREE.Vector3(), currentBounds: null, heightScale: 1, cameraSelectionRevision: 0,
    followTargetId: null, buildToken: 0, geometrySelectionToken: 0, geometryLoads: new Map(),
    terrainRoot: new THREE.Group(), trailRoot: new THREE.Group(), gridRoot: new THREE.Group(),
    playerObjects: new Map(), playerLabels: new Map(), playerGroups: new Map(), playerPortraits: new Map(),
    labelOverlay: { replaceChildren() {} }, worldRenderer: { root: new THREE.Group(), setData() {}, setMapFog() {} },
    currentTime: 0, setTime() {}, buildGrid() {}, buildTracks() {},
    buildTerrain: () => pending, applyLayerVisibility() {}, summitCameraBounds: () => null, nadirGeometryBounds: () => null,
  });
  return { scene, container, finish };
}
const mapPack = { identityVersion: 3, gameBuildId: "25739797", layers };
function assertInFrame(scene, layer) {
  scene.camera.updateMatrixWorld(true);
  for (const x of [layer.minX, layer.maxX]) for (const y of [layer.minY, layer.maxY]) for (const z of [layer.minZ, layer.maxZ]) {
    const ndc = new THREE.Vector3(x - scene.origin.x, (y - scene.origin.y) * scene.heightScale, -(z - scene.origin.z)).project(scene.camera);
    assert.ok(Math.abs(ndc.x) <= 1 / 1.08 + 1e-9, `X ${ndc.x}`);
    assert.ok(Math.abs(ndc.y) <= 1 / 1.08 + 1e-9, `Y ${ndc.y}`);
    assert.ok(ndc.z >= -1 && ndc.z <= 1, `Z ${ndc.z}`);
  }
}

test("first chapter is already framed while its model is still downloading", async () => {
  const { scene, finish } = fixture();
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  assert.equal(scene.surveyPreset, "overview");
  assertInFrame(scene, layers[0]);
  const preLoad = scene.camera.position.clone();
  finish(); await loading;
  assert.ok(scene.camera.position.distanceTo(preLoad) < 1e-8);
});

test("loading completion keeps later user camera choices after the early frame", async () => {
  const { scene, finish } = fixture();
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  assertInFrame(scene, layers[0]);
  scene.cameraSelectionRevision++; scene.surveyPreset = null;
  scene.camera.position.set(7, 8, 9);
  finish(); await loading;
  assert.deepEqual(scene.camera.position.toArray(), [7, 8, 9]);
});

test("resize refits an untouched preset without invalidating the pending source-bound refit", async () => {
  const { scene, container, finish } = fixture();
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  const revision = scene.cameraSelectionRevision;
  container.clientWidth = 320; container.clientHeight = 800; scene.resize();
  assert.equal(scene.cameraSelectionRevision, revision);
  assertInFrame(scene, layers[0]);
  finish(); await loading;
  assert.equal(scene.cameraSelectionRevision, revision + 1);
  assertInFrame(scene, layers[0]);
});

test("resize and height changes keep manually moved and free cameras", async () => {
  const { scene, container, finish } = fixture();
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  finish(); await loading;
  scene.surveyPreset = null; scene.camera.position.set(3, 4, 5);
  container.clientWidth = 320; scene.resize(); scene.setHeightScale(3);
  assert.deepEqual(scene.camera.position.toArray(), [3, 4, 5]);
  scene.surveyPreset = "overview"; scene.freeCamera.mode = "free";
  container.clientHeight = 400; scene.resize(); scene.setHeightScale(2);
  assert.deepEqual(scene.camera.position.toArray(), [3, 4, 5]);
});

test("height exaggeration and top preset frame every corner", async () => {
  const { scene, finish } = fixture();
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  finish(); await loading;
  scene.setHeightScale(3); assertInFrame(scene, layers[0]);
  scene.topView(); assert.equal(scene.surveyPreset, "top"); assertInFrame(scene, layers[0]);
});

test("map-only citadel entry keeps the complete model in view", async () => {
  const { scene, finish } = fixture(); let interior = 0;
  scene.enterInteriorView = () => { interior++; };
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 4 });
  finish(); await loading;
  assert.equal(interior, 0); assert.equal(scene.freeCamera.mode, "orbit");
  assertInFrame(scene, layers[1]);
});

test("an in-place replay map update preserves free and manually orbited cameras", async () => {
  for (const mode of ["free", "orbit"]) {
    const { scene, finish } = fixture();
    const trace = { bounds: { min: [1, 2, 3], max: [4, 5, 6] } };
    scene.trace = trace; scene.origin.set(8, 9, 10); scene.surveyPreset = null;
    scene.freeCamera.mode = mode; scene.camera.position.set(7, 6, 5);
    const loading = scene.setData({ mapPack, trace, useMap: true, activeSegment: 0 });
    assert.equal(scene.freeCamera.mode, mode);
    assert.deepEqual(scene.camera.position.toArray(), [7, 6, 5]);
    assert.deepEqual(scene.origin.toArray(), [8, 9, 10]);
    finish(); await loading;
    assert.deepEqual(scene.camera.position.toArray(), [7, 6, 5]);
  }
});

test("a retained follow marker is rebuilt before the asynchronous map load", async () => {
  const { scene, finish } = fixture(), trace = {};
  scene.trace = trace; scene.followTargetId = "player"; scene.surveyPreset = null;
  scene.buildTracks = () => scene.playerObjects.set("player", { marker: {} });
  const loading = scene.setData({ mapPack, trace, useMap: true, activeSegment: 0 });
  assert.ok(scene.playerObjects.has(scene.followTargetId));
  finish(); await loading;
  assert.equal(scene.followTargetId, "player");
});
