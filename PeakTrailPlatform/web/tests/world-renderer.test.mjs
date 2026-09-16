import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { resolveGameAssetUrl, resolveItemAsset } from "../src/game-assets.js";
import {
  buildWorldTimeline, normalizeWorldRecord, worldObjectsAtTime, worldObjectVisible,
  worldObjectInBounds, worldWarning, worldEffectsAtTime,
} from "../src/world-timeline.js";
import { getSourceEffectMaterial } from "../src/source-materials.js";

// Exercise the real renderer and bundled Three CPU scene graph, replacing only browser
// DOM/network ports. No WebGL context, remote textures or proprietary assets are needed.
const worldSource = (await readFile(new URL("../src/world-renderer.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export class /gm, "class ");
const fogSource = (await readFile(new URL("../src/fog-material.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export function /gm, "function ");
const createReplayFogMaterial = new Function("THREE", `${fogSource}\nreturn createReplayFogMaterial;`)(THREE);

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentElement = null; this.hidden = false;
    this.style = {}; this.dataset = {}; this.attributes = {}; this.className = "";
    const classes = new Set();
    this.classList = { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) };
  }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
}

function createHarness(fetchImpl = async () => ({ ok: true, json: async () => modelFixture() })) {
  const WorldRenderer = new Function(
    "THREE", "resolveGameAssetUrl", "resolveItemAsset", "worldObjectsAtTime", "worldObjectVisible", "worldObjectInBounds", "worldWarning", "worldEffectsAtTime", "createReplayFogMaterial", "getSourceEffectMaterial", "document", "fetch",
    `${worldSource}\nreturn WorldRenderer;`,
  )(THREE, resolveGameAssetUrl, resolveItemAsset, worldObjectsAtTime, worldObjectVisible, worldObjectInBounds, worldWarning, worldEffectsAtTime,
    createReplayFogMaterial, getSourceEffectMaterial, { createElement: (tag) => new Element(tag) }, fetchImpl);
  const parent = new Element("section"), canvas = new Element("canvas");
  parent.append(canvas); canvas.clientWidth = 800; canvas.clientHeight = 600;
  return { renderer: new WorldRenderer(canvas), parent, canvas };
}

function modelFixture() {
  return {
    coordinateSpace: "unity-prefab-local-meters",
    // Deliberately off-center and below local Y=0: recentering a model would lose
    // the game's deployable anchor and make it float when composed with log poses.
    parts: [{ name: "Shelf", positions: [4, -2, 6, 6, -2, 6, 4, 1, 6], uv: [0, 0, 1, 0, 0, 1],
      groups: [{ indices: [0, 1, 2], material: { color: [0.2, 0.4, 0.6, 1], colorSpace: "linear" } }] }],
  };
}

function assetPack(build = "test-build") {
  return {
    gameBuildId: build, catalogUrl: new URL(`https://example.test/data/game-assets/${build}/catalog.json`), itemIndex: new Map(),
    catalog: { worldObjects: [{ prefabName: "ShelfShroomSpawn", kind: "placed_object", name: "Shelf mushroom", worldModel: "models/shelf.json" }] },
  };
}

function objectFixture(overrides = {}) {
  return { objectId: "placed:1", kind: "placed_object", prefabName: "ShelfShroomSpawn", pos: [11, 22, 33],
    rot: [0, 0, 0, 1], scale: [1, 1, 1], active: true, activity: "placed", source: "recorded-instance", ...overrides };
}

function traceFixture(objects, after = [], events = []) {
  return { events, worldTimeline: buildWorldTimeline([
    normalizeWorldRecord({ type: "world_snapshot", complete: true, objects }, 0),
    ...after.map((record) => normalizeWorldRecord(record, record.t)),
  ]) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
function nearly(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= tolerance, `${value} != ${expected[i]} at ${i}`));
}

test("world models preserve prefab-local XYZ and compose recorded world position, rotation and scale", async () => {
  const { renderer } = createHarness(), pack = assetPack();
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const object = objectFixture({ rot: rotation.toArray(), scale: [2, 3, -4] });
  const origin = new THREE.Vector3(10, 20, 30);
  renderer.setData(traceFixture([object]), pack, origin); renderer.update(0, { heightScale: 1.5 });
  const template = await renderer.template(renderer.resolveAsset(object).modelUrl); await settle();
  assert.ok(template);
  const entry = renderer.entries.get(object.objectId), clone = entry.group.children[0], mesh = clone.children[0];
  assert.equal(entry.owned, false, "template owns shared geometry/materials");
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), modelFixture().parts[0].positions);
  assert.deepEqual(clone.position.toArray(), [0, 0, 0], "must not translate local geometry to its bounding-box center");
  nearly(entry.group.position.toArray(), [1, 2, 3]); nearly(entry.group.quaternion.toArray(), rotation.toArray());
  nearly(entry.group.scale.toArray(), [2, 3, -4]);
  renderer.root.updateMatrixWorld(true);
  const actual = new THREE.Vector3(4, -2, 6).applyMatrix4(mesh.matrixWorld);
  const expected = new THREE.Vector3(4, -2, 6).multiply(new THREE.Vector3(2, 3, -4)).applyQuaternion(rotation).add(new THREE.Vector3(1, 2, 3));
  expected.y *= 1.5; nearly(actual.toArray(), expected.toArray());
  renderer.dispose(); await settle();
});

test("late model completion cannot resurrect an object removed from the replay", async () => {
  const request = deferred(), { renderer } = createHarness(() => request.promise), object = objectFixture(), pack = assetPack();
  renderer.setData(traceFixture([object], [{ type: "world_delta", t: 1, upserts: [], removed: [object.objectId] }]), pack, new THREE.Vector3());
  renderer.update(0); const old = renderer.entries.get(object.objectId);
  const pending = renderer.template(renderer.resolveAsset(object).modelUrl);
  renderer.update(1); assert.equal(renderer.entries.size, 0); assert.equal(old.group.parent, null);
  request.resolve({ ok: true, json: async () => modelFixture() });
  await pending; await settle();
  assert.equal(renderer.entries.size, 0); assert.equal(old.group.children.length, 0); assert.equal(old.label.parentElement, null);
  assert.deepEqual(renderer.root.children, [renderer.effectRoot]);
  renderer.dispose(); await settle();
});

test("late model completion after dispose is discarded and does not restore DOM or scene nodes", async () => {
  const request = deferred(), { renderer, parent } = createHarness(() => request.promise), object = objectFixture(), pack = assetPack();
  renderer.setData(traceFixture([object]), pack, new THREE.Vector3()); renderer.update(0);
  const pending = renderer.template(renderer.resolveAsset(object).modelUrl);
  const revision = renderer.revision;
  renderer.dispose(); assert.ok(renderer.revision > revision);
  request.resolve({ ok: true, json: async () => modelFixture() });
  assert.equal(await pending, null); await settle();
  assert.equal(renderer.entries.size, 0); assert.equal(renderer.templates.size, 0); assert.equal(renderer.root.children.length, 0);
  assert.equal(parent.children.length, 1, "only original canvas remains");
});

test("changing asset pack disposes each shared template resource once and abandons old clones", async () => {
  const { renderer } = createHarness(), firstPack = assetPack(), object = objectFixture();
  const trace = traceFixture([object, objectFixture({ objectId: "placed:2", pos: [15, 22, 33] })]);
  renderer.setData(trace, firstPack, new THREE.Vector3()); renderer.update(0);
  const template = await renderer.template(renderer.resolveAsset(object).modelUrl); await settle();
  const geometry = template.children[0].geometry, material = template.children[0].material;
  let disposedGeometry = 0, disposedMaterial = 0;
  geometry.addEventListener("dispose", () => disposedGeometry++); material.addEventListener("dispose", () => disposedMaterial++);
  const clones = [...renderer.entries.values()].map((entry) => entry.group);
  renderer.setData(trace, assetPack("other-build"), new THREE.Vector3()); await settle();
  assert.equal(disposedGeometry, 1); assert.equal(disposedMaterial, 1);
  assert.equal(renderer.templates.size, 0); assert.equal(renderer.entries.size, 0);
  assert.ok(clones.every((clone) => clone.parent === null));
  renderer.dispose(); await settle();
  assert.equal(disposedGeometry, 1); assert.equal(disposedMaterial, 1, "dispose after reset must not double-release old resources");
});

test("legacy player throws, damage and death never fabricate world objects or explosion effects", () => {
  const { renderer } = createHarness();
  renderer.setData({ events: [
    { type: "item_thrown", t: 0, pos: [1, 2, 3], itemId: 79 },
    { type: "died", t: 0, pos: [1, 2, 3] },
    { type: "damage", t: 0, pos: [1, 2, 3] },
  ] }, assetPack(), new THREE.Vector3());
  renderer.update(1);
  assert.equal(renderer.entries.size, 0); assert.equal(renderer.templates.size, 0); assert.equal(renderer.effectRoot.children.length, 0);
  assert.deepEqual(renderer.alerts, []); renderer.dispose();
});

test("fog boxes retain recorded extent and feed only lit protection spheres in Unity coordinates", () => {
  const { renderer } = createHarness(), origin = new THREE.Vector3(100, 200, 300);
  const fog = objectFixture({ objectId: "fog:1", kind: "sleep_fog", prefabName: "SleepyFog", pos: [110, 220, 330],
    shape: "box", size: [80, 40, 60], activity: "emitting", source: "StatusFieldGloom.Drowsy", statusEnabled: false });
  const safe = objectFixture({ objectId: "lamp:1", kind: "fog_safe_zone", pos: [112, 215, 325], radius: 7, activity: "lit" });
  const dark = objectFixture({ objectId: "lamp:2", kind: "fog_safe_zone", pos: [110, 220, 330], radius: 20, active: false, activity: "unlit" });
  renderer.setData(traceFixture([fog, safe, dark]), assetPack(), origin); renderer.update(3, { heightScale: 2 });
  const entry = renderer.entries.get(fog.objectId), uniforms = entry.fogMaterial.uniforms, volume = entry.group.children[0];
  nearly(entry.group.position.toArray(), [10, 20, 30]); nearly(entry.group.scale.toArray(), [40, 20, 30]);
  assert.equal(uniforms.sphere.value, false); assert.equal(uniforms.safeCount.value, 1);
  nearly(uniforms.safeZones.value[0].toArray(), [112, 215, 325, 7]); nearly(uniforms.worldOrigin.value.toArray(), origin.toArray());
  assert.equal(uniforms.heightScale.value, 2); assert.equal(uniforms.replayTime.value, 3);
  assert.match(entry.text.textContent, /昏睡关闭/); assert.equal(renderer.entries.has(dark.objectId), false);
  renderer.root.updateMatrixWorld(true); volume.onBeforeRender();
  const product = new THREE.Matrix4().multiplyMatrices(uniforms.inverseWorld.value, volume.matrixWorld);
  nearly(product.elements, new THREE.Matrix4().elements);
  const bounds = new THREE.Box3().setFromObject(volume);
  nearly(bounds.getSize(new THREE.Vector3()).toArray(), [80, 80, 60], 1e-5);
  assert.equal(entry.fogMaterial.depthWrite, false); assert.equal(entry.fogMaterial.side, THREE.DoubleSide);
  assert.equal(entry.fogMaterial.forceSinglePass, true);
  volume.onBeforeRender(null, null, { position: new THREE.Vector3(10, 40, 30) });
  assert.equal(entry.fogMaterial.depthTest, false, 'inside fog must not vanish behind an underground exit face');
  volume.onBeforeRender(null, null, { position: new THREE.Vector3(1000, 40, 30) });
  assert.equal(entry.fogMaterial.depthTest, true, 'outside view tests the entry surface against foreground geometry');
  assert.match(entry.fogMaterial.fragmentShader, /gl_FrontFacing/);
  assert.match(entry.fogMaterial.fragmentShader, /wp\.y\/heightScale/);
  assert.match(entry.fogMaterial.fragmentShader, /if\(safe\) continue/);
  renderer.dispose();
});

test("confirmed mine effects animate at recorded location and rewind out cleanly", () => {
  const { renderer } = createHarness(), event = { type: "mine_explosion", t: 5, objectId: "mine:1", pos: [14, 26, 38], radius: 6 };
  renderer.setData(traceFixture([], [], [event]), assetPack(), new THREE.Vector3(10, 20, 30));
  renderer.update(4); assert.equal(renderer.effectRoot.children.length, 0);
  renderer.update(5.5); const burst = renderer.effectRoot.children[0];
  nearly(burst.position.toArray(), [4, 6.15, 8]); const firstScale = burst.scale.x;
  renderer.update(6); assert.ok(burst.scale.x > firstScale); assert.ok(burst.children[0].material.opacity < 0.8);
  let disposed = 0; burst.children[0].geometry.addEventListener("dispose", () => disposed++);
  renderer.update(4); assert.equal(renderer.effectRoot.children.length, 0); assert.equal(disposed, 1);
  renderer.update(8); assert.equal(renderer.effectRoot.children.length, 0);
  renderer.dispose();
});
