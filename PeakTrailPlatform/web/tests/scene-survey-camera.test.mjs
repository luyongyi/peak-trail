import * as i18n from "../src/i18n.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { fitPerspectivePoints } from "../src/camera-framing.js";
import { collectCameraParts, selectCameraSubjectParts } from "../src/camera-subject.js";
import { isInteriorLayer } from "../src/camera-placement.js";
import { chooseRenderPolicy } from "../src/render-policy.js";

const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const ports = { ...i18n, THREE, fitPerspectivePoints, collectCameraParts, selectCameraSubjectParts, isInteriorLayer, chooseRenderPolicy };
const Scene = new Function(...Object.keys(ports), `${source}\nreturn TrailScene;`)(...Object.values(ports));
const layers = [
  { id: "shore", segment: 0, name: "Shore_Segment", biome: "Shore", minX: -230, maxX: 230, minY: -127, maxY: 295, minZ: -540, maxZ: 340 },
  { id: "temple", segment: 4, name: "Temple_Segment", biome: "Swamp", minX: -120, maxX: 120, minY: 800, maxY: 1233, minZ: 2000, maxZ: 2400 },
];
function fixture() {
  const scene = Object.create(Scene.prototype), container = { clientWidth: 1280, clientHeight: 720 };
  const camera = new THREE.PerspectiveCamera(38, 1, .1, 20000), target = new THREE.Vector3();
  const controls = { target, enableDamping: true, update() { camera.lookAt(target); } };
  const canvas = { parentElement: container,
    ownerDocument: { defaultView: { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) } } };
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  Object.assign(scene, { camera, controls, canvas,
    renderer: { setDrawingBufferSize(width, height, pixelRatio) {
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
    } }, freeCamera: { mode: "orbit", setMode(value) { this.mode = value; } },
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
    assert.ok(Math.abs(ndc.x) <= 1 / 1.02 + 1e-9, `X ${ndc.x}`);
    assert.ok(Math.abs(ndc.y) <= 1 / 1.02 + 1e-9, `Y ${ndc.y}`);
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

test("a hidden viewer gets finite framing and refits when its real viewport becomes visible", async () => {
  const { scene, container, finish } = fixture();
  container.clientWidth = 0; container.clientHeight = 0;
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  assert.ok(scene.camera.position.toArray().every(Number.isFinite));
  assert.equal(scene.surveyPreset, "overview");
  const revision = scene.cameraSelectionRevision;
  container.clientWidth = 360; container.clientHeight = 900;
  scene.resize();
  assert.equal(scene.camera.aspect, 0.4);
  assert.equal(scene.cameraSelectionRevision, revision, "becoming visible is not a user camera choice");
  assertInFrame(scene, layers[0]);
  finish(); await loading;
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

test("survey presets keep the complete subject below persistent viewport controls", async () => {
  const { scene, finish } = fixture();
  scene.canvas.getBoundingClientRect = () => ({ left: 0, right: 1280, top: 56, bottom: 720, width: 1280, height: 664 });
  scene.canvas.parentElement.querySelectorAll = () => [
    { getBoundingClientRect: () => ({ left: 16, right: 1264, top: 72, bottom: 107, width: 1248, height: 35 }) },
    { getBoundingClientRect: () => ({ left: 450, right: 830, top: 75, bottom: 104, width: 380, height: 29 }) },
    { getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) },
  ];
  const loading = scene.setData({ mapPack, trace: null, useMap: true, activeSegment: 0 });
  finish(); await loading;
  const frame = scene.surveyCameraFrame();
  assert.equal(frame.top, 1 - 110 / 664);
  for (const preset of ["overview", "top"]) {
    scene.applySurveyPreset(preset);
    scene.camera.updateMatrixWorld(true);
    for (const point of scene.cameraFitPoints()) {
      const ndc = new THREE.Vector3(...point).project(scene.camera);
      const midpoint = (frame.top + frame.bottom) / 2;
      assert.ok(Math.abs(ndc.x) <= 1 / 1.02 + 1e-9);
      assert.ok(ndc.y <= midpoint + (frame.top - midpoint) / 1.02 + 1e-9);
      assert.ok(ndc.y >= midpoint + (frame.bottom - midpoint) / 1.02 - 1e-9);
    }
  }
});

test("a temporary expanded navigator cannot enlarge the reserved camera area", () => {
  const { scene } = fixture();
  let width = 1024, top = 138, height = 240;
  scene.canvas.getBoundingClientRect = () => ({ left: 0, right: width, top: 56, bottom: 816, width, height: 760 });
  scene.canvas.parentElement.querySelectorAll = () => [{
    matches: (selector) => selector === ".segment-navigator",
    getBoundingClientRect: () => ({ left: 16, right: width - 16, top, bottom: top + height, width: width - 32, height }),
  }];
  const desktop = scene.surveyCameraFrame();
  top = 72; height = 35;
  assert.deepEqual(scene.surveyCameraFrame(), desktop, "tablet chapter flash uses its collapsed top-row footprint");
  width = 375; top = 148; height = 240;
  const phone = scene.surveyCameraFrame();
  height = 55;
  assert.deepEqual(scene.surveyCameraFrame(), phone, "phone chapter flash keeps the collapsed capsule height");
  width = 844; top = 122; height = 240;
  scene.canvas.ownerDocument = { defaultView: { matchMedia: () => ({ matches: true }) } };
  const landscape = scene.surveyCameraFrame();
  height = 46;
  assert.deepEqual(scene.surveyCameraFrame(), landscape, "sideways phones use their collapsed toolbar row");
  assert.equal(landscape.top, 1 - 2 * (6 + 46 + 4) / 760);
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
