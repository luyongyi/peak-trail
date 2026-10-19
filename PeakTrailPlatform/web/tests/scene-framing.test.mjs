import * as i18n from "../src/i18n.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { ReplayCamera } from "../src/replay-camera.js";
import { fitPerspectivePoints } from "../src/camera-framing.js";
import { collectCameraParts, selectCameraSubjectParts } from "../src/camera-subject.js";
import { isInteriorLayer } from "../src/camera-placement.js";
import { nadirCameraBounds, nadirCameraParts } from "../src/nadir-camera-bounds.js";

// Use the bundled controller and production scene methods unchanged except for
// import wiring. The DOM surface and renderer sizing are the only boundary ports.
const orbitSource = (await readFile(new URL("../../vendor/three/0.180.0/examples/jsm/controls/OrbitControls.js", import.meta.url), "utf8"))
  .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\r?\n/gm, "")
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, "");
const OrbitControls = new Function(...Object.keys(THREE), `${orbitSource}\nreturn OrbitControls;`)(...Object.values(THREE));
const source = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const ports = { ...i18n, THREE, fitPerspectivePoints, collectCameraParts, selectCameraSubjectParts, isInteriorLayer, nadirCameraBounds, nadirCameraParts };
const TrailScene = new Function(...Object.keys(ports), `${source}\nreturn TrailScene;`)(...Object.values(ports));

class Surface extends EventTarget {
  emit(name, properties = {}) {
    const event = new Event(name, { cancelable: true });
    Object.assign(event, properties);
    this.dispatchEvent(event);
    return event;
  }
}

function fixture(t, { width = 1600, height = 900, heightScale = 2.5 } = {}) {
  const document = new Surface();
  document.defaultView = new Surface();
  const canvas = new Surface();
  canvas.ownerDocument = document;
  canvas.getRootNode = () => document;
  canvas.parentElement = { clientWidth: width, clientHeight: height };
  canvas.style = {};
  canvas.tagName = "CANVAS";
  const attributes = new Map();
  canvas.getAttribute = (name) => attributes.get(name) ?? null;
  canvas.setAttribute = (name, value) => attributes.set(name, String(value));
  canvas.removeAttribute = (name) => attributes.delete(name);
  canvas.focus = () => { document.activeElement = canvas; };
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  Object.defineProperty(canvas, "clientHeight", { get: () => canvas.parentElement.clientHeight });
  Object.defineProperty(canvas, "clientWidth", { get: () => canvas.parentElement.clientWidth });
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 20000);
  camera.position.set(65, 85, 75);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.screenSpacePanning = false;
  controls.minDistance = 2;
  controls.maxDistance = 12000;
  controls.maxPolarAngle = Math.PI * 0.495;
  const scene = Object.create(TrailScene.prototype);
  const freeCamera = new ReplayCamera({ THREE, camera, controls, canvas,
    onModeChange: () => { scene.surveyPreset = null; } });
  const sizing = [];
  Object.assign(scene, { canvas, camera, controls, freeCamera,
    renderer: { setSize: (...args) => sizing.push(args) },
    origin: new THREE.Vector3(100, 150, 300), heightScale,
    activeSegment: 0, useMap: true, surveyPreset: null, followTargetId: null,
    viewIntent: null, cameraSelectionRevision: 0, terrainRoot: new THREE.Group(),
    mapPack: { layers: [{ segment: 0, biome: "Shore", name: "Shore_Segment",
      minX: 120, maxX: 400, minY: 170, maxY: 500, minZ: 400, maxZ: 1600 }] },
  });
  t.after(() => { freeCamera.dispose(); controls.dispose(); });
  return { scene, camera, controls, canvas, sizing };
}

function assertFramed(scene) {
  scene.camera.updateMatrixWorld(true);
  const projected = scene.cameraFitPoints().map((point) => new THREE.Vector3().fromArray(point).project(scene.camera));
  const limit = 1 / 1.02;
  for (const axis of ["x", "y"]) {
    const min = Math.min(...projected.map((point) => point[axis]));
    const max = Math.max(...projected.map((point) => point[axis]));
    assert.ok(min >= -limit - 1e-7 && max <= limit + 1e-7, `${axis} retains the requested screen margin (${min}, ${max})`);
    assert.ok(Math.abs(min + max) < 1e-7, `${axis} silhouette remains centered (${min}, ${max})`);
  }
  for (const point of projected) assert.ok(point.z > -1 && point.z < 1, "all points stay between clipping planes");
}

function pose(scene) {
  return { position: scene.camera.position.toArray(), quaternion: scene.camera.quaternion.toArray(),
    target: scene.controls.target.toArray(), near: scene.camera.near, far: scene.camera.far };
}

function assertPoseClose(actual, expected) {
  for (const key of ["position", "quaternion", "target"]) {
    actual[key].forEach((value, axis) => assert.ok(Math.abs(value - expected[key][axis]) < 1e-7, `${key}[${axis}] remains stable`));
  }
  assert.equal(actual.near, expected.near);
  assert.equal(actual.far, expected.far);
}

test("default and top presets fit height-scaled, origin-relative, Z-reflected bounds", (t) => {
  const { scene, camera, controls } = fixture(t);
  const points = scene.cameraFitPoints();
  assert.equal(points.length, 8);
  assert.deepEqual(points[0], [20, 50, -100]);
  assert.deepEqual(points[7], [300, 875, -1300]);
  scene.fitView();
  assert.equal(scene.surveyPreset, "overview");
  assertFramed(scene);
  scene.topView();
  assert.equal(scene.surveyPreset, "top");
  assertFramed(scene);
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).y < -0.99999);
  const topPose = pose(scene);
  controls.update();
  assertPoseClose(pose(scene), topPose);
});

for (const name of ["Shore_Segment", "Temple_Segment", "Volcano_Segment"]) {
test(`loaded ${name} fits its main subject while retaining distant objects and source bounds`, (t) => {
  const { scene } = fixture(t);
  scene.mapPack.identityVersion = 3;
  const layer = scene.mapPack.layers[0];
  layer.name = name;
  const originalLayer = structuredClone(layer);
  const world = new THREE.Group();
  world.scale.z = -1;
  world.add(scene.terrainRoot);
  scene.terrainRoot.scale.y = scene.heightScale;
  const chapter = new THREE.Group();
  chapter.userData = { loaded: true, mapLayer: layer };
  scene.terrainRoot.add(chapter);
  const model = new THREE.Group();
  model.position.copy(scene.origin).negate();
  chapter.add(model);
  const material = new THREE.MeshBasicMaterial();
  const bodyGeometry = new THREE.BoxGeometry(10, 10, 10);
  const strayGeometry = new THREE.BoxGeometry(1, 1, 1);
  t.after(() => { material.dispose(); bodyGeometry.dispose(); strayGeometry.dispose(); });
  for (let index = 0; index < 8; index += 1) {
    const mesh = new THREE.Mesh(bodyGeometry, material);
    mesh.position.set(125 + index * 10, 200, 450);
    model.add(mesh);
  }
  const stray = new THREE.Mesh(strayGeometry, material);
  stray.position.set(2000, 2000, 2000);
  model.add(stray);
  const points = scene.cameraFitPoints();
  assert.equal(points.length, 64, "the eight connected body meshes define the composition");
  assert.deepEqual(points[0], [20, 112.5, -145]);
  assert.ok(points.every(([x]) => x <= 100));
  assert.equal(stray.parent, model, "a camera subject choice never removes the distant geometry");
  assert.equal(stray.visible, true);
  assert.deepEqual(layer, originalLayer, "source layer bounds still govern other scene behavior");
  scene.fitView();
  assertFramed(scene);
  scene.heightScale = 4;
  scene.terrainRoot.scale.y = 4;
  assert.deepEqual(scene.cameraFitPoints()[0], [20, 180, -145], "cached source bounds are scaled once for the current view");
  scene.topView();
  assertFramed(scene);
});
}

test("an adjacent enclosure landmark joins the selected subject without changing chapter bounds", (t) => {
  const { scene } = fixture(t);
  const layer = scene.mapPack.layers[0];
  layer.maxX = 8000;
  const originalBounds = structuredClone(scene.viewBounds());
  const subject = { min: [120, 170, 400], max: [200, 210, 500] };
  const context = { min: [800, 220, 1500], max: [850, 280, 1550] };
  scene.cameraSubjectParts = () => [{ bounds: subject }];
  scene.enclosureContext = { bounds: context };
  const points = scene.cameraFitPoints();
  assert.equal(points.length, 16, "subject and landmark each contribute their own eight corners");
  assert.ok(points.some(([x, y, z]) => x === 750 && y === 325 && z === -1250), "the source landmark is converted to rendered space");
  assert.ok(points.every(([x]) => x < 1000), "adding the landmark does not reintroduce distant source bounds");
  assert.deepEqual(scene.viewBounds(), originalBounds, "player and trail chapter bounds remain unchanged");
  scene.fitView();
  assertFramed(scene);
  scene.topView();
  assertFramed(scene);
});

test("automatic framing refits both presets when the canvas becomes portrait", (t) => {
  for (const preset of ["overview", "top"]) {
    const { scene, canvas, sizing } = fixture(t);
    scene.mapPack.layers[0].maxX = 800;
    scene.applySurveyPreset(preset);
    const oldPosition = scene.camera.position.clone();
    canvas.parentElement.clientWidth = 360;
    canvas.parentElement.clientHeight = 900;
    scene.resize();
    assert.equal(scene.camera.aspect, 0.4);
    assert.equal(scene.viewportWidth, 360);
    assert.equal(scene.viewportHeight, 900);
    assert.deepEqual(sizing.at(-1), [360, 900, false]);
    assert.ok(scene.camera.position.distanceTo(oldPosition) > 1);
    assert.equal(scene.surveyPreset, preset);
    assertFramed(scene);
  }
});

test("resize preserves manually positioned, free, and followed camera poses", (t) => {
  for (const mode of ["manual", "free", "follow"]) {
    const { scene, canvas } = fixture(t);
    scene.fitView();
    if (mode === "manual") {
      scene.surveyPreset = null;
      scene.camera.position.add(new THREE.Vector3(30, 20, 10));
    } else if (mode === "free") {
      scene.freeCamera.setMode("free");
      scene.surveyPreset = "overview"; // The mode guard also protects a stale remembered preset.
    } else {
      scene.followTargetId = "player";
    }
    const before = pose(scene);
    canvas.parentElement.clientWidth = 320;
    canvas.parentElement.clientHeight = 1000;
    scene.resize();
    assert.equal(scene.camera.aspect, 0.32);
    assert.deepEqual(pose(scene), before, `${mode} camera is not moved by resizing`);
  }
});

test("a preset drains real OrbitControls drag damping before setting the new camera", (t) => {
  for (const button of [0, 2]) {
    const { scene, canvas, controls, camera } = fixture(t);
    scene.fitView();
    canvas.emit("pointerdown", { pointerId: 1, pointerType: "mouse", button, clientX: 100, clientY: 100 });
    canvas.emit("pointermove", { pointerId: 1, pointerType: "mouse", button, clientX: 200, clientY: 140 });
    canvas.emit("pointerup", { pointerId: 1, pointerType: "mouse", button });
    const justDragged = camera.position.clone();
    controls.update();
    assert.ok(camera.position.distanceTo(justDragged) > 0.01, "the drag leaves genuine residual motion");
    scene.fitView();
    assert.equal(controls.enableDamping, true);
    const fitted = pose(scene);
    for (let frame = 0; frame < 10; frame += 1) controls.update();
    assertPoseClose(pose(scene), fitted);
    assertFramed(scene);
  }
});

test("Void presets fit oriented terrain vertices while retaining the audited 5km water and source bounds", (t) => {
  const { scene } = fixture(t, { width: 1800, height: 600 });
  const layer = { segment: 5, biome: "Void", name: "Void_Segment",
    minX: -2400, maxX: 2600, minY: 702.6, maxY: 1100, minZ: -2300, maxZ: 2700 };
  scene.mapPack = { identityVersion: 3, gameBuildId: "25739797", layers: [layer] };
  scene.activeSegment = 5;
  const originalBounds = structuredClone(scene.viewBounds());
  const world = new THREE.Group(); world.scale.z = -1; world.add(scene.terrainRoot);
  scene.terrainRoot.scale.y = scene.heightScale;
  const chapter = new THREE.Group(); chapter.userData = { loaded: true, mapLayer: layer };
  scene.terrainRoot.add(chapter);
  const model = new THREE.Group(); model.position.copy(scene.origin).negate(); chapter.add(model);
  const terrainGeometry = new THREE.BoxGeometry(4, 4, 600), terrainMaterial = new THREE.MeshBasicMaterial({ name: "M_Petrified_Stone" });
  const terrain = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrain.position.set(100, 900, 350); terrain.rotation.set(0.14, Math.PI / 4, 0);
  model.add(terrain);
  const waterGeometry = new THREE.PlaneGeometry(5000, 5000), waterMaterial = new THREE.MeshBasicMaterial();
  waterMaterial.userData.peakTerrain = { sourceMaterial: "M_Void Water", sourceColors: { shader: "GD/Water-GD" } };
  const water = new THREE.Mesh(waterGeometry, waterMaterial);
  water.rotation.x = -Math.PI / 2; water.position.set(100, 702.6, 200); model.add(water);
  t.after(() => { terrainGeometry.dispose(); terrainMaterial.dispose(); waterGeometry.dispose(); waterMaterial.dispose(); });
  const sourceTerrain = collectCameraParts(THREE, chapter, scene.origin).find((part) => part.materials[0].name === "M_Petrified_Stone");
  const display = ([x, y, z]) => [x - scene.origin.x, (y - scene.origin.y) * scene.heightScale, -(z - scene.origin.z)];
  const expected = sourceTerrain.points.map(display);
  const globalBoxPoints = [];
  for (const x of [sourceTerrain.bounds.min[0], sourceTerrain.bounds.max[0]]) for (const y of [sourceTerrain.bounds.min[1], sourceTerrain.bounds.max[1]]) for (const z of [sourceTerrain.bounds.min[2], sourceTerrain.bounds.max[2]]) {
    globalBoxPoints.push(display([x, y, z]));
  }
  assert.notDeepEqual(expected, globalBoxPoints, "the rotated mesh has a tighter oriented box than its world-axis box");
  scene.cameraSubjectParts = () => { throw new Error("verified Void framing must use its filtered oriented parts"); };
  assert.deepEqual(scene.cameraFitPoints(), expected, "framing uses the retained terrain's original oriented points, without the water or a global box");
  const retained = scene.nadirGeometryParts();
  assert.equal(retained.length, 1);
  assert.equal(scene.nadirGeometryParts()[0].points, retained[0].points, "cached source fit points retain their identity");
  assert.deepEqual(scene.nadirGeometryBounds(), sourceTerrain.bounds, "legacy camera bounds retain their original meaning");
  for (const preset of ["overview", "top"]) {
    scene.applySurveyPreset(preset);
    assertFramed(scene);
    const position = terrainGeometry.getAttribute("position"), index = terrainGeometry.getIndex();
    for (let offset = 0; offset < index.count; offset++) {
      const projected = new THREE.Vector3().fromBufferAttribute(position, index.getX(offset)).applyMatrix4(terrain.matrixWorld).project(scene.camera);
      assert.ok(Math.abs(projected.x) <= 1 / 1.02 + 1e-7, `${preset} contains actual rendered vertex X`);
      assert.ok(Math.abs(projected.y) <= 1 / 1.02 + 1e-7, `${preset} contains actual rendered vertex Y`);
      assert.ok(projected.z > -1 && projected.z < 1, `${preset} contains actual rendered vertex depth`);
    }
    if (preset === "overview") {
      const globalFit = fitPerspectivePoints(globalBoxPoints, { aspect: scene.camera.aspect, fov: scene.camera.fov, padding: 1.02 });
      assert.ok(scene.camera.position.distanceTo(scene.controls.target) < globalFit.distance * 0.99, "default Void framing moves closer than the global terrain AABB");
    }
    assert.equal(water.parent, model, "camera filtering keeps the authored water in the scene");
    assert.equal(water.visible, true);
    assert.deepEqual(scene.viewBounds(), originalBounds, "source bounds remain available for players and trail clipping");
  }
});
