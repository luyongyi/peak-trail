import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { lootTypeStyle, MAP_LOOT_MAX_BEAM_HEIGHT } from "../src/map-loot-style.js";

const source = (await readFile(new URL("../src/map-loot-overlay.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "")
  .replace(/^export \{.*;\r?\n/gm, "")
  .replace("export class MapLootOverlay", "class MapLootOverlay");
const MapLootOverlay = new Function("THREE", "lootTypeStyle", "MAP_LOOT_MAX_BEAM_HEIGHT", `${source}\nreturn MapLootOverlay;`)(THREE, lootTypeStyle, MAP_LOOT_MAX_BEAM_HEIGHT);
const sceneSource = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const TrailScene = new Function("THREE", `${sceneSource}\nreturn TrailScene;`)(THREE);

const marker = (overrides = {}) => ({ id: "crate-1", type: "luggage", category: "chest", pos: [101, 202, 303], segment: 1, layerId: "shore", ...overrides });
const matrixAt = (mesh, index = 0) => { const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix); return matrix; };
const positionAt = (attribute, index = 0) => [attribute.getX(index), attribute.getY(index), attribute.getZ(index)];
const close = (actual, expected) => actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.0001, `${actual} != ${expected}`));

test("anchors follow real Unity coordinates, one Z mirror and height scaling; beams stay finite", () => {
  const overlay = new MapLootOverlay();
  const input = [marker()], before = structuredClone(input);
  const world = new THREE.Group(); world.scale.z = -1; world.add(overlay.root);
  overlay.setData(input).setContext({ origin: new THREE.Vector3(100, 200, 300), heightScale: 5, activeSegment: 1 });
  const { beam, capPositions } = overlay.resources;
  world.updateMatrixWorld(true);
  const matrix = new THREE.Matrix4().multiplyMatrices(beam.matrixWorld, matrixAt(beam));
  const base = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix);
  const top = new THREE.Vector3(0, 1, 0).applyMatrix4(matrix);
  close(base.toArray(), [1, 10.12, -3]);
  close(top.toArray(), [1, 22.12, -3]);
  assert.ok(top.y - base.y <= MAP_LOOT_MAX_BEAM_HEIGHT);
  close(positionAt(capPositions), [1, 22.12, 3]);
  overlay.setContext({ heightScale: 0.2 });
  close(new THREE.Vector3().setFromMatrixPosition(matrixAt(beam)).toArray(), [1, 0.52, 3]);
  assert.equal(new THREE.Vector3().setFromMatrixScale(matrixAt(beam)).y, 12);
  assert.equal(overlay.root.scale.y, 1);
  assert.deepEqual(input, before);
  overlay.dispose();
});

test("type, chapter and layer filters compact all shared batches without reallocating geometry", () => {
  const overlay = new MapLootOverlay();
  overlay.setData([marker(), marker({ id: "rare", type: "ancient_chest", layerId: "roots" }), marker({ id: "fixed", type: "campfire", category: "item", layerId: "roots" }), marker({ id: "other-chapter", segment: 2 })]);
  const resources = overlay.resources;
  overlay.setContext({ activeSegment: 1, selectedLayerId: "roots" });
  assert.deepEqual(overlay.visibleMarkers.map(item => item.id), ["rare", "fixed"]);
  overlay.setFilters({ types: new Set(["ancient_chest"]) });
  assert.deepEqual(overlay.visibleMarkers.map(item => item.id), ["rare"]);
  assert.equal(overlay.resources, resources);
  assert.equal(resources.beam.count, 1);
  assert.equal(resources.beamXray.count, 1);
  assert.equal(resources.ring.count, 1);
  assert.equal(resources.cap.geometry.drawRange.count, 1);
  overlay.setFilters({ types: [] });
  assert.equal(overlay.root.visible, false);
  assert.equal(resources.beam.count, 0);
  assert.equal(resources.cap.geometry.drawRange.count, 0);
  overlay.setContext({ activeSegment: null, selectedLayerId: null }).setFilters({ types: null, enabled: true });
  assert.equal(overlay.visibleMarkers.length, 4);
  overlay.setFilters({ enabled: false });
  assert.equal(overlay.visibleMarkers.length, 0);
  overlay.clear().setFilters({ enabled: true });
  assert.equal(overlay.root.visible, false);
  overlay.dispose();
});

test("malformed coordinates never enter GPU buffers and supplied type colors match the legend", () => {
  const overlay = new MapLootOverlay();
  overlay.setData({ types: [{ id: "special", category: "chest", color: "#abcdef" }], markers: [
    marker({ type: "special", category: undefined }), marker({ id: "object-position", pos: undefined, position: { x: 1, y: 2, z: 3 }, type: "plant", category: "item" }),
    marker({ pos: [NaN, 2, 3] }), marker({ pos: [1, Infinity, 3] }), marker({ pos: [1, 2] }), marker({ pos: [1e20, 2, 3] }), null,
  ] });
  assert.equal(overlay.visibleMarkers.length, 2);
  const expected = new THREE.Color("#abcdef");
  close(positionAt(overlay.resources.capColors), [expected.r, expected.g, expected.b]);
  assert.equal(overlay.resources.capKinds.getX(0), 1);
  assert.equal(overlay.resources.capKinds.getX(1), 0);
  for (const object of overlay.root.children) {
    if (object.isInstancedMesh) assert.ok([...object.instanceMatrix.array].every(Number.isFinite));
    else assert.ok([...object.geometry.attributes.position.array].every(Number.isFinite));
  }
  assert.deepEqual(lootTypeStyle("special", "chest", "#abcdef").color, "#abcdef");
  assert.equal(lootTypeStyle("special", "chest", "url(bad)").color.startsWith("#"), true);
  overlay.dispose();
});

test("large marker collections use six draws, shared geometry and restrained depth-aware xray", () => {
  const overlay = new MapLootOverlay();
  overlay.setData(Array.from({ length: 1000 }, (_, index) => marker({ id: `${index}`, pos: [index, 2, 3] })));
  const { beam, beamXray, ring, ringXray, cap, capXray } = overlay.resources;
  assert.equal(overlay.root.children.length, 6);
  assert.equal(beam.count, 1000);
  assert.equal(beam.geometry, beamXray.geometry);
  assert.equal(beam.instanceMatrix, beamXray.instanceMatrix);
  assert.equal(ring.geometry, ringXray.geometry);
  assert.equal(ring.instanceColor, ringXray.instanceColor);
  assert.equal(cap.geometry, capXray.geometry);
  for (const object of [beamXray, ringXray, capXray]) {
    assert.equal(object.material.depthTest, true);
    assert.equal(object.material.depthFunc, THREE.GreaterDepth);
    assert.equal(object.material.depthWrite, false);
  }
  assert.ok(beamXray.material.uniforms.opacity.value < beam.material.uniforms.opacity.value / 4);
  overlay.setPixelRatio(2);
  assert.equal(cap.material.uniforms.pixelRatio.value, 2);
  overlay.dispose();
});

test("capybara markers retain their animal category, warm finite beacons and a distinct paw badge", () => {
  const overlay = new MapLootOverlay();
  const animal = marker({ id: "capybara-1", type: "animal-capybara", category: undefined, name: "豚豚崽", pos: [103, 204, 305] });
  overlay.setData({ types: [{ id: "animal-capybara", category: "animal", name: "豚豚崽" }], markers: [
    marker(), animal, marker({ id: "plant", type: "item-napberry", category: "item" }),
  ] });
  assert.equal(overlay.visibleMarkers[1].category, "animal");
  assert.equal(overlay.resources.capKinds.getX(0), 1);
  assert.equal(overlay.resources.capKinds.getX(1), 2);
  assert.equal(overlay.resources.capKinds.getX(2), 0);
  const style = lootTypeStyle({ id: "animal-capybara", category: "animal" });
  assert.equal(style.kind, "animal");
  assert.equal(style.color, "#f2ba91");
  assert.equal(style.beamHeight, 12);
  assert.equal(lootTypeStyle("future-animal", "animal").kind, "animal");
  assert.equal(lootTypeStyle("animal-capybara", "animal", "#abcdef").color, "#abcdef");
  const color = new THREE.Color(style.color);
  close(positionAt(overlay.resources.capColors, 1), [color.r, color.g, color.b]);
  close(positionAt(overlay.resources.capPositions, 1), [103, 216.12, 305]);
  close(new THREE.Vector3().setFromMatrixScale(matrixAt(overlay.resources.beam, 1)).toArray(), [0.8, 12, 1]);
  close(new THREE.Vector3().setFromMatrixScale(matrixAt(overlay.resources.ring, 1)).toArray(), [1.1, 1.1, 1.1]);
  assert.match(overlay.resources.cap.material.fragmentShader, /float pawPad/);
  assert.match(overlay.resources.cap.material.fragmentShader, /mix\(mix\(item, chest, isChest\), paw, isAnimal\)/);
  assert.doesNotMatch(overlay.resources.cap.material.fragmentShader, /mix\([^;]*, vKind\)/);
  assert.doesNotMatch(overlay.resources.cap.material.vertexShader, /mix\([^;]*, markerKind\)/);
  const resources = overlay.resources;
  const version = resources.capKinds.version;
  overlay.setData({ types: [{ id: "animal-capybara", category: "animal" }], markers: [marker(), { ...animal, name: "Latest capybara" }, marker({ id: "plant", type: "item-napberry", category: "item" })] });
  assert.equal(resources.capKinds.version, version);
  overlay.setFilters({ types: ["animal-capybara"] });
  assert.deepEqual(overlay.visibleMarkers.map(entry => entry.id), ["capybara-1"]);
  assert.equal(resources.capKinds.getX(0), 2);
  assert.equal(resources.beam.count, 1);
  assert.equal(overlay.root.children.length, 6);
  assert.equal(overlay.resources, resources);
  overlay.dispose();
});

test("unchanged context, filter sets and fresh equal placement arrays do not upload GPU buffers", () => {
  const overlay = new MapLootOverlay();
  overlay.setData([marker()]).setFilters({ types: new Set(["luggage"]) });
  const resources = overlay.resources;
  const attributes = [resources.beam.instanceMatrix, resources.ring.instanceMatrix, resources.tint, resources.capPositions, resources.capColors, resources.capKinds];
  const versions = attributes.map(attribute => attribute.version);
  overlay.setContext({ origin: new THREE.Vector3(), heightScale: 1, activeSegment: null, selectedLayerId: null });
  overlay.setData([marker({ name: "Latest metadata" })]);
  overlay.setFilters({ enabled: true, types: new Set(["luggage"]) });
  assert.deepEqual(attributes.map(attribute => attribute.version), versions);
  assert.equal(overlay.visibleMarkers[0].name, "Latest metadata");
  overlay.setData([marker({ pos: [101, 203, 303] })]);
  assert.ok(resources.capPositions.version > versions[3]);
  overlay.dispose();
});

test("caps can identify a marker through the parent world reflection", () => {
  const overlay = new MapLootOverlay(), world = new THREE.Group();
  world.scale.z = -1; world.add(overlay.root);
  overlay.setData([marker({ pos: [0, 0, 3] })]);
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 12.12, 10), new THREE.Vector3(0, 0, -1));
  assert.equal(overlay.pick(raycaster).id, "crate-1");
  overlay.setFilters({ enabled: false });
  assert.equal(overlay.pick(raycaster), null);
  overlay.dispose();
});

test("growth and disposal release each shared GPU resource exactly once and detach the root", () => {
  const overlay = new MapLootOverlay(), world = new THREE.Group(); world.add(overlay.root);
  overlay.setData([marker()]);
  const resources = new Set();
  overlay.root.traverse(object => { if (object.geometry) resources.add(object.geometry); if (object.material) resources.add(object.material); });
  const counts = new Map([...resources].map(resource => [resource, 0]));
  for (const resource of resources) resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource) + 1));
  overlay.setData(Array.from({ length: 17 }, (_, index) => marker({ id: `${index}` })));
  assert.ok([...counts.values()].every(count => count === 1));
  assert.equal(overlay.capacity, 32);
  const current = overlay.resources;
  let released = 0;
  current.beam.geometry.addEventListener("dispose", () => released++);
  overlay.dispose(); overlay.dispose();
  assert.equal(released, 1);
  assert.equal(overlay.root.parent, null);
  assert.equal(overlay.root.children.length, 0);
  assert.equal(overlay.resources, null);
  overlay.setData([marker()]).setContext({ heightScale: 2 }).setFilters({ enabled: true });
  assert.equal(overlay.root.visible, false);
});

test("scene integration clears wrong-map markers and synchronizes chapter and exaggerated height", () => {
  const scene = Object.create(TrailScene.prototype);
  const mapPackId = `sha256-${"a".repeat(64)}`;
  const layers = [{ id: "shore", segment: 1, biome: "shore" }, { id: "roots", segment: 2, biome: "roots" }];
  Object.assign(scene, { useMap: true, mapPack: { mapPackId, layers }, activeSegment: 1, origin: new THREE.Vector3(100, 200, 300), heightScale: 1,
    mapLootOverlay: new MapLootOverlay(), terrainRoot: new THREE.Group(), trailRoot: new THREE.Group(), worldRenderer: { root: new THREE.Group() } });
  for (const layer of layers) { const group = new THREE.Group(); group.userData = { segment: layer.segment, mapLayer: layer }; scene.terrainRoot.add(group); }
  const markers = [marker(), marker({ id: "second", segment: 2, layerId: "roots" })];
  assert.equal(scene.setMapLoot({ mapPackId, markers, enabled: true }), true);
  assert.deepEqual(scene.mapLootOverlay.visibleMarkers.map(entry => entry.id), ["crate-1"]);
  scene.activeSegment = 2; scene.applyLayerVisibility();
  assert.deepEqual(scene.mapLootOverlay.visibleMarkers.map(entry => entry.id), ["second"]);
  scene.heightScale = 3; scene.applyHeightScale();
  close(new THREE.Vector3().setFromMatrixPosition(matrixAt(scene.mapLootOverlay.resources.beam)).toArray(), [1, 6.12, 3]);
  assert.equal(scene.mapLootOverlay.root.scale.y, 1);
  assert.equal(scene.setMapLoot({ mapPackId: "another-map", markers, enabled: true }), false);
  assert.equal(scene.mapLootOverlay.root.visible, false);
  assert.equal(scene.mapLootOverlay.markers.length, 0);
  scene.useMap = false;
  assert.equal(scene.setMapLoot({ mapPackId, markers, enabled: true }), false);
  scene.mapLootOverlay.dispose();
});
