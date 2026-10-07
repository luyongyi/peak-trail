import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { normalizeRoutes, normalizeHeatmap, routeEdges, routeColor } from "../src/route-collection-model.js";

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
const source = (await readFile(new URL("../src/community-route-overlay.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class CommunityRouteOverlay", "class CommunityRouteOverlay");
const ports = { THREE, LineSegmentsGeometry, LineMaterial, LineSegments2, normalizeRoutes, normalizeHeatmap, routeEdges, routeColor };
const CommunityRouteOverlay = new Function(...Object.keys(ports), `${source}\nreturn CommunityRouteOverlay;`)(...Object.values(ports));
const sceneSource = (await readFile(new URL("../src/scene.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace("export class TrailScene", "class TrailScene");
const TrailScene = new Function("THREE", "CommunityRouteOverlay", `${sceneSource}\nreturn TrailScene;`)(THREE, CommunityRouteOverlay);
const mapPackId = `sha256-${"a".repeat(64)}`;
const routes = () => [{ id: "route-a", playerKey: "player-a", name: "Mylu", points: [
  [0, 10100, 20200, 30300], [100, 10200, 20300, 30400], [200, 10300, 20400, 30500],
  [300, 10400, 20500, 30600], [2000, 10500, 20600, 30700], [2100, 10600, 20700, 30800],
], breaks: [200] }];
const origin = () => new THREE.Vector3(100, 200, 300);
const dto = overrides => ({ mode: "routes", mapPackId, stageIndex: 1, routes: routes(), heightBand: null, ...overrides });
function sceneFixture() {
  const scene = Object.create(TrailScene.prototype);
  scene.worldRoot = new THREE.Group();
  scene.worldRoot.scale.z = -1;
  Object.assign(scene, { useMap: true, activeSegment: 1, mapPack: { mapPackId, layers: [{ segment: 1 }, { segment: 2 }] },
    origin: origin(), heightScale: 1, viewportWidth: 900, viewportHeight: 600,
    terrainRoot: new THREE.Group(), trailRoot: new THREE.Group(), worldRenderer: { root: new THREE.Group() } });
  return scene;
}
function position(attribute, index) { return [attribute.getX(index), attribute.getY(index), attribute.getZ(index)]; }

test("approved-map layer uses real centimeter XYZ, one world Z mirror, and the scene's height scale", () => {
  const scene = sceneFixture(), input = dto(), before = structuredClone(input.routes);
  assert.equal(scene.setCommunityOverlay(input), true);
  const overlay = scene.communityOverlay;
  assert.equal(overlay.root.parent, scene.worldRoot);
  const [occluded, visible, endpoints] = overlay.players.get("route-a").group.children;
  assert.ok(visible instanceof LineSegments2);
  assert.equal(visible.geometry.attributes.instanceStart.count, 3, "break and 1.7s gap are not drawn across");
  assert.deepEqual(position(visible.geometry.attributes.instanceStart, 0), [1, 2, 3]);
  assert.deepEqual(position(visible.geometry.attributes.instanceEnd, 0), [2, 3, 4]);
  assert.equal(occluded.geometry, visible.geometry);
  assert.equal(occluded.material.depthFunc, THREE.GreaterDepth);
  assert.equal(visible.material.depthFunc, THREE.LessEqualDepth);
  assert.equal(visible.material.depthWrite, false);
  assert.equal(endpoints.material.sizeAttenuation, false);
  scene.heightScale = 2;
  scene.applyHeightScale();
  scene.worldRoot.updateMatrixWorld(true);
  assert.deepEqual(new THREE.Vector3(1, 2, 3).applyMatrix4(visible.matrixWorld).toArray(), [1, 4, -3]);
  assert.deepEqual(input.routes, before, "source coordinates are never rewritten or snapped");
  overlay.dispose();
});

test("per-player visibility updates in place without allocating new geometry or altering heatmap statistics", () => {
  const overlay = new CommunityRouteOverlay(), input = dto();
  input.routes.push({ ...input.routes[0], id: "route-b", playerKey: "player-b" });
  overlay.setData(input, origin());
  const geometry = overlay.players.get("route-a").group.children[0].geometry;
  overlay.setData({ ...input, visiblePlayers: new Set(["route-b"]) }, origin());
  assert.equal(overlay.players.get("route-a").group.visible, false);
  assert.equal(overlay.players.get("route-b").group.visible, true);
  assert.equal(overlay.players.get("route-a").group.children[0].geometry, geometry);
  overlay.setVisiblePlayers(new Set());
  assert.ok([...overlay.players.values()].every(entry => !entry.group.visible));
  overlay.setVisiblePlayers(null);
  assert.ok([...overlay.players.values()].every(entry => entry.group.visible));
  overlay.dispose();
});

test("3D heat voxels preserve stacked height bands and cell centers in the exact world coordinate space", () => {
  const overlay = new CommunityRouteOverlay();
  const heatmap = { routeCount: 4, cellSizeCm: 200, heightBandCm: 400, cells: [[50, 50, 150, 2], [50, 51, 150, 4]] };
  overlay.setData(dto({ mode: "heatmap", heatmap, routes: [] }), origin());
  const mesh = overlay.root.children[0], matrix = new THREE.Matrix4();
  assert.ok(mesh.isInstancedMesh);
  assert.equal(mesh.count, 2, "same X/Z at different heights must not merge");
  mesh.getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [1, 2, 1]);
  mesh.getMatrixAt(1, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [1, 6, 1]);
  assert.equal(mesh.geometry.parameters.width, 2);
  assert.equal(mesh.geometry.parameters.height, 4);
  assert.equal(mesh.material.depthWrite, false);
  overlay.setData(dto({ mode: "heatmap", heatmap, routes: [], heightBand: 51 }), origin());
  assert.equal(overlay.root.children[0].count, 1);
  overlay.root.children[0].getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).toArray(), [1, 6, 1]);
  overlay.dispose();
});

test("heat remains visible through terrain in mirrored world space while route depth cues remain unchanged", () => {
  const scene = sceneFixture();
  const heatmap = { routeCount: 2, cellSizeCm: 200, heightBandCm: 400, cells: [[50, 50, 150, 1], [50, 51, 150, 2]] };
  assert.equal(scene.setCommunityOverlay(dto({ mode: "heatmap", heatmap, routes: [] })), true);
  const mesh = scene.communityOverlay.root.children[0];
  assert.equal(scene.communityOverlay.root.children.length, 1, "one instanced mesh, without another render pass");
  assert.equal(mesh.material.depthTest, false, "recorded cells inside terrain are a visible spatial overlay");
  assert.equal(mesh.material.depthWrite, false, "heat cannot occlude map or route geometry");
  assert.equal(mesh.material.toneMapped, false, "map lighting cannot wash out the data colors");
  assert.ok(mesh.material.opacity >= .5 && mesh.material.opacity < 1, "heat stays translucent and readable");
  const matrix = new THREE.Matrix4(), color = new THREE.Color();
  mesh.getMatrixAt(0, matrix);
  assert.ok(matrix.determinant() > 0, "instance transform contains no unsupported negative scale");
  scene.worldRoot.updateMatrixWorld(true);
  assert.ok(mesh.matrixWorld.determinant() < 0, "only the existing world-root mirror reverses winding");
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld).toArray(), [1, 2, -1]);
  mesh.getColorAt(0, color);
  assert.ok(color.g > .1 && color.r > color.g && color.g > color.b, "lower frequency remains a warmer yellow-orange");
  mesh.getColorAt(1, color);
  assert.ok(color.r > .9 && color.g < .1 && color.b < .1, "highest frequency reaches red rather than sand-colored orange");
  assert.equal(scene.setCommunityOverlay(dto()), true);
  const [occluded, visible] = scene.communityOverlay.players.get("route-a").group.children;
  assert.equal(occluded.material.depthTest, true);
  assert.equal(occluded.material.depthFunc, THREE.GreaterDepth);
  assert.equal(visible.material.depthTest, true);
  assert.equal(visible.material.depthFunc, THREE.LessEqualDepth);
  scene.communityOverlay.dispose();
});

test("map mismatch, disabled map, invalid route, and null chapter clear existing GPU objects fail closed", () => {
  const scene = sceneFixture();
  assert.equal(scene.setCommunityOverlay(dto()), true);
  assert.equal(scene.setCommunityOverlay(dto({ mapPackId: `sha256-${"b".repeat(64)}` })), false);
  assert.equal(scene.communityOverlay.root.children.length, 0);
  assert.equal(scene.setCommunityOverlay(dto()), true);
  assert.equal(scene.setCommunityOverlay(dto({ stageIndex: 2 })), false);
  assert.equal(scene.communityOverlay.root.visible, false);
  assert.equal(scene.setCommunityOverlay(dto()), true);
  assert.equal(scene.setCommunityOverlay(dto({ stageIndex: null })), true);
  assert.equal(scene.communityOverlay.root.children.length, 0);
  assert.equal(scene.setCommunityOverlay(dto()), true);
  scene.useMap = false;
  assert.equal(scene.setCommunityOverlay(dto()), false);
  scene.useMap = true;
  assert.equal(scene.setCommunityOverlay(dto({ routes: [{ id: "bad", points: [[0, 0, NaN, 0]] }] })), false);
  assert.equal(scene.communityOverlay.root.children.length, 0);
  scene.communityOverlay.dispose();
});

test("clearing and replacing overlays dispose shared line geometry and every owned material exactly once", () => {
  const overlay = new CommunityRouteOverlay();
  overlay.setData(dto(), origin());
  let geometryDisposals = 0, materialDisposals = 0, pointDisposals = 0;
  const [occluded, visible, endpoints] = overlay.players.get("route-a").group.children;
  visible.geometry.addEventListener("dispose", () => geometryDisposals++);
  endpoints.geometry.addEventListener("dispose", () => pointDisposals++);
  for (const child of [occluded, visible, endpoints]) child.material.addEventListener("dispose", () => materialDisposals++);
  overlay.setData({ mode: "off" }, origin());
  overlay.clear();
  assert.equal(geometryDisposals, 1);
  assert.equal(pointDisposals, 1);
  assert.equal(materialDisposals, 3);
  assert.equal(overlay.lineMaterials.size, 0);
  assert.equal(overlay.root.children.length, 0);
  assert.equal(overlay.players.size, 0);
  overlay.dispose();
});

test("resize changes only screen-width line uniforms and creates no clocks, callbacks, network or avatar dependencies", () => {
  const overlay = new CommunityRouteOverlay();
  overlay.setData(dto(), origin());
  const geometry = overlay.players.get("route-a").group.children[0].geometry;
  overlay.setViewport(1200, 800);
  for (const material of overlay.lineMaterials) assert.deepEqual(material.resolution.toArray(), [1200, 800]);
  assert.equal(overlay.players.get("route-a").group.children[0].geometry, geometry);
  assert.doesNotMatch(source, /requestAnimationFrame|setInterval|fetch\(|document\.|gameAsset|avatar/);
  overlay.dispose();
});
