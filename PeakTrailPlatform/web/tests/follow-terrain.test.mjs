import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { FollowTerrainQuery } from "../src/follow-terrain.js";
import { createSectionPlane, orientSectionPlane } from "../src/section-plane.js";

const vec = (x, y, z) => new THREE.Vector3(x, y, z);
const material = (options = {}) => new THREE.MeshBasicMaterial(options);
function triangle({ indexed = true, material: surface = material() } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-2, -2, 0, 2, -2, 0, 0, 2, 0], 3));
  if (indexed) geometry.setIndex([0, 1, 2]);
  return new THREE.Mesh(geometry, surface);
}
function close(actual, expected, epsilon = 1e-7) {
  if (actual?.isVector3) actual = actual.toArray();
  if (expected?.isVector3) expected = expected.toArray();
  if (Array.isArray(actual)) return actual.forEach((value, index) => close(value, expected[index], epsilon));
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test("indexed and non-indexed casts hit actual triangle faces, never the empty part of an AABB", () => {
  for (const indexed of [true, false]) {
    const mesh = triangle({ indexed }), query = new FollowTerrainQuery(THREE).setRoots([mesh]);
    const hit = query.cast(vec(0, 0, 10), vec(0, 0, -1), 20);
    close(hit.distance, 10); close(hit.point, [0, 0, 0]); close(hit.normal, [0, 0, 1]);
    assert.equal(hit.mesh, mesh); assert.equal(hit.instanceId, null);
    assert.equal(query.cast(vec(1.9, 1.9, 10), vec(0, 0, -1), 20), null, "bounds include space outside the triangle");
  }
});

test("terrain is queried from both sides, with normals facing back toward the camera ray origin", () => {
  const mesh = triangle({ material: material({ side: THREE.FrontSide }) });
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const front = query.cast(vec(0, 0, 10), vec(0, 0, -1), 10);
  const back = query.cast(vec(0, 0, -10), vec(0, 0, 1), 10);
  close(front.normal, [0, 0, 1]); close(back.normal, [0, 0, -1]);
  assert.equal(mesh.material.side, THREE.FrontSide, "query must not mutate rendering materials");
});

test("the fade ignores culled faces and geometry before the near plane but recognizes visible foliage", () => {
  const near = triangle(), leaves = triangle();
  near.position.z = 9.95;
  leaves.material.userData.peakTerrain = { sourceColors: { shader: "GD/FoliageGD" } };
  leaves.scale.x = -1;
  const query = new FollowTerrainQuery(THREE).setRoots([near, leaves]);
  const options = { renderedFacesOnly: true, minimumDistance: 0.08 };
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 20, null, options).distance, 10);
  assert.equal(query.cast(vec(0, 0, -1), vec(0, 0, 1), 20, null, options), null);
  leaves.material.side = THREE.DoubleSide;
  close(query.cast(vec(0, 0, -1), vec(0, 0, 1), 20, null, options).distance, 1);
});

test("maxDistance is exact in world metres and ray origins may be on a surface or inside bounds", () => {
  const query = new FollowTerrainQuery(THREE).setRoots([triangle()]);
  assert.equal(query.cast(vec(0, 0, 10), vec(0, 0, -1), 9.999), null);
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 10).distance, 10);
  close(query.cast(vec(0, 0, 0), vec(0, 0, -1), 0).distance, 0);
  assert.equal(query.cast(vec(0, 0, 10), vec(1, 0, 0), 100), null);
});

test("source origin, nested Y height scale, Z reflection and arbitrary shear preserve true hit points and normals", () => {
  const root = new THREE.Group(); root.scale.z = -1;
  const terrain = new THREE.Group(); terrain.scale.y = 2.5; root.add(terrain);
  const source = new THREE.Group(); source.position.set(-120, -300, -410); terrain.add(source);
  const mesh = triangle(); mesh.matrixAutoUpdate = false;
  mesh.matrix.set(2, 0.7, 0.4, 127, 0.3, 1.7, 0.1, 315, 0.4, 0.5, 2, 423, 0, 0, 0, 1);
  source.add(mesh);
  const before = Array.from(mesh.geometry.attributes.position.array);
  const query = new FollowTerrainQuery(THREE).setRoots([terrain]);
  const point = vec(0, 0, 0).applyMatrix4(mesh.matrixWorld);
  const a = vec(-2, -2, 0).applyMatrix4(mesh.matrixWorld);
  const b = vec(2, -2, 0).applyMatrix4(mesh.matrixWorld);
  const c = vec(0, 2, 0).applyMatrix4(mesh.matrixWorld);
  const normal = b.sub(a).cross(c.sub(a)).normalize();
  const origin = point.clone().addScaledVector(normal, 17);
  assert.equal(query.cast(origin, normal.clone().negate(), 16.999), null);
  const hit = query.cast(origin, normal.clone().negate(), 17.001);
  close(hit.point, point); close(hit.distance, 17); close(hit.normal, normal);
  assert.deepEqual(Array.from(mesh.geometry.attributes.position.array), before);
  assert.equal(mesh.geometry.boundingBox, null, "query caches stay outside renderer geometry");
});

test("nearest real triangle wins independent of root order and a far box does not count as an obstruction", () => {
  const near = triangle(), far = triangle(); near.position.z = 3; far.position.z = -20;
  const query = new FollowTerrainQuery(THREE).setRoots([far, near]);
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 100).distance, 7);
  query.setRoots([far]);
  assert.equal(query.cast(vec(0, 0, 10), vec(0, 0, -1), 29.99), null);
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 30).distance, 30);
});

test("castAll retains every foreground instance, with one nearest hit per instance and no farther geometry", () => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(3, 3, 2), material(), 4);
  for (const [index, z] of [0, 5, -12, 15].entries()) mesh.setMatrixAt(index, new THREE.Matrix4().makeTranslation(0, 0, z));
  const ordinary = triangle(); ordinary.position.z = 2;
  const query = new FollowTerrainQuery(THREE).setRoots([mesh, ordinary]);
  const origin = vec(0, 0, 10), direction = vec(0, 0, -2);
  const hits = query.castAll(origin, direction, 10);
  assert.deepEqual(hits.map(hit => hit.distance), [4, 8, 9]);
  assert.deepEqual(hits.map(hit => hit.instanceId), [1, null, 0]);
  assert.deepEqual(hits.map(hit => hit.mesh), [mesh, ordinary, mesh]);
  assert.equal(query.cast(origin, direction, 10).instanceId, 1, "nearest-only API retains its original semantics");
  assert.deepEqual(query.castAll(origin, direction, 3), []);
});

test("castAll applies near-plane, source effect, culling and protected-passage filters without changing collision casts", () => {
  const beforeNear = triangle(), protectedPassage = triangle(), fog = triangle(), backFacing = triangle(), rock = triangle();
  beforeNear.position.z = 9.95;
  protectedPassage.position.z = 8; protectedPassage.userData.followOcclusionProtected = true;
  fog.position.z = 6; fog.material.userData.peakSourceEffect = { kind: "fog" };
  backFacing.position.z = 4; backFacing.rotation.y = Math.PI;
  const parent = new THREE.Group(); parent.add(rock);
  const query = new FollowTerrainQuery(THREE).setRoots([beforeNear, protectedPassage, fog, backFacing, parent]);
  const origin = vec(0, 0, 10), direction = vec(0, 0, -1), options = { renderedFacesOnly: true, minimumDistance: 0.08 };
  assert.deepEqual(query.castAll(origin, direction, 20, null, options).map(hit => hit.mesh), [rock]);
  assert.equal(query.cast(origin, direction, 20, null, options).mesh, rock);
  assert.deepEqual(query.castAll(origin, direction, 20, null, { minimumDistance: 0.08 }).map(hit => hit.mesh),
    [protectedPassage, backFacing, rock], "protected passages remain real collision surfaces");
  parent.visible = false;
  assert.deepEqual(query.castAll(origin, direction, 20, null, options), []);
  parent.visible = true; rock.material.visible = false;
  assert.deepEqual(query.castAll(origin, direction, 20, null, options), []);
});

test("castAll looks past section-cut and undrawn triangles within each output mesh", () => {
  const rock = material({ side: THREE.DoubleSide }); rock.userData.peakSectionPlane = true;
  const mesh = triangle({ indexed: false, material: [rock, material({ side: THREE.DoubleSide })] });
  mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -2, -2, 2, 2, -2, 2, 0, 2, 2, -2, -2, 7, 2, -2, 7, 0, 2, 7,
  ], 3));
  mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
  const behind = triangle({ material: material({ side: THREE.DoubleSide }) }); behind.position.z = 9;
  const query = new FollowTerrainQuery(THREE).setRoots([mesh, behind]);
  const section = createSectionPlane(THREE); section.axisZ = -1;
  orientSectionPlane(section, 0, 1, vec(0, 2, 10));
  const cast = () => query.castAll(vec(0, 0, 0), vec(0, 0, 1), 10, section, { renderedFacesOnly: true });
  assert.deepEqual(cast().map(hit => hit.distance), [7, 9]);
  mesh.geometry.setDrawRange(0, 3);
  assert.deepEqual(cast().map(hit => hit.mesh), [behind]);
  mesh.geometry.setDrawRange(3, 3);
  assert.deepEqual(cast().map(hit => hit.distance), [7, 9]);
});

test("whole-module section queries use the supplied probe plane and keep neighboring instances independent", () => {
  const source = triangle(), mesh = new THREE.InstancedMesh(source.geometry, source.material, 3);
  source.material.userData.peakSectionPlane = true; source.material.userData.peakSectionMode = "module";
  const centres = [-3, 0, 3];
  centres.forEach((x, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0)));
  mesh.geometry.setAttribute("peakSectionModule", new THREE.InstancedBufferAttribute(new Float32Array(
    centres.flatMap(x => [x, 0, 0, 1])), 4));
  mesh.geometry.setAttribute("peakSectionExtent", new THREE.InstancedBufferAttribute(new Float32Array(
    centres.flatMap(() => [2, 2, 0])), 3));
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const section = createSectionPlane(THREE); section.value.set(1, 0, 0, 1);
  const probe = createSectionPlane(THREE); probe.value.set(-1, 0, 0, 1);
  const cast = (x, plane) => query.cast(vec(x, 0, 10), vec(0, 0, -1), 20, plane, { renderedFacesOnly: true });
  assert.equal(cast(-3, section).instanceId, 0);
  assert.equal(cast(3, section), null);
  assert.equal(cast(-3, probe), null);
  assert.equal(cast(3, probe).instanceId, 2, "candidate plane is independent of current render state");
  assert.equal(cast(-.5, section), null, "a point on the rear half of a crossing module also disappears");
  section.value.w = 0;
  assert.equal(cast(3, section).instanceId, 2);
  assert.equal(cast(0, section).instanceId, 1);
  assert.equal(query.castAll(vec(3, 0, 10), vec(0, 0, -1), 20, probe)[0].instanceId, 2);
});

test("contact-protected module queries retain every face rather than applying the old per-point cut", () => {
  const source = triangle(), mesh = new THREE.InstancedMesh(source.geometry, source.material, 1);
  source.material.userData.peakSectionPlane = true; source.material.userData.peakSectionMode = "module";
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(3, 0, 0));
  mesh.geometry.setAttribute("peakSectionModule", new THREE.InstancedBufferAttribute(new Float32Array([3, 0, 0, 1]), 4));
  mesh.geometry.setAttribute("peakSectionExtent", new THREE.InstancedBufferAttribute(new Float32Array([2, 2, 0]), 3));
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const section = createSectionPlane(THREE); section.value.set(1, 0, 0, 1); section.footing.value.set(3, 0, 0, .1);
  const cast = () => query.castAll(vec(3.75, 0, 10), vec(0, 0, -1), 20, section, { renderedFacesOnly: true });
  assert.equal(cast()[0].instanceId, 0, "the sampled face lies outside the local footing patch but its whole module is protected");
  section.footing.value.w = 0;
  assert.deepEqual(cast(), []);
  mesh.geometry.getAttribute("peakSectionModule").setW(0, 0);
  assert.equal(cast()[0].instanceId, 0, "ineligible modules do not fall back to fragment sectioning");
});

test("castAll keeps render-hidden instances detectable but refreshes actual mine transforms", () => {
  const source = triangle(), mesh = new THREE.InstancedMesh(source.geometry, source.material, 2);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 4));
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 2));
  const mask = new THREE.InstancedBufferAttribute(new Float32Array(2), 1);
  mesh.geometry.setAttribute("peakFollowHidden", mask);
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const cast = () => query.castAll(vec(0, 0, 10), vec(0, 0, -1), 20, null, { renderedFacesOnly: true });
  const entries = query.entries, matrixVersion = mesh.instanceMatrix.version;
  assert.deepEqual(cast().map(hit => hit.instanceId), [0, 1]);
  mask.setX(0, 1); mask.needsUpdate = true;
  assert.deepEqual(cast().map(hit => hit.instanceId), [0, 1], "GPU-only hiding cannot erase ray evidence");
  assert.equal(query.entries, entries); assert.equal(mesh.instanceMatrix.version, matrixVersion);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); mesh.instanceMatrix.needsUpdate = true;
  assert.deepEqual(cast().map(hit => hit.instanceId), [1], "recorded mine hiding still changes real geometry");
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 7)); mesh.instanceMatrix.needsUpdate = true;
  assert.deepEqual(cast().map(hit => hit.distance), [3, 8]);
  mesh.count = 1;
  assert.deepEqual(cast().map(hit => hit.instanceId), [0]);
});

test("section placement looks through the near half, retaining the far wall, a same-batch prop and the tracked footing", () => {
  const rock = material(); rock.userData.peakSectionPlane = true;
  const mesh = triangle({ indexed: false, material: [rock, material()] });
  mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -2, -2, 2, 2, -2, 2, 0, 2, 2, -2, -2, 7, 2, -2, 7, 0, 2, 7,
  ], 3));
  mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
  const floor = triangle({ material: rock });
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1;
  const query = new FollowTerrainQuery(THREE).setRoots([mesh, floor]);
  const origin = vec(0, 0, 0);
  const section = createSectionPlane(THREE); section.axisZ = -1;
  orientSectionPlane(section, 0, 1, vec(0, 2, 10));
  section.footing.value.set(0, 0.15, 0, 3);
  close(query.cast(origin, vec(0, 0, 1), 10).distance, 2);
  close(query.cast(origin, vec(0, 0, 1), 10, section).distance, 7);
  close(query.cast(origin, vec(0, -1, 0), 10, section).distance, 1);
  section.footing.value.w = 0;
  assert.equal(query.cast(origin, vec(0, -1, 0), 10, section), null);
  orientSectionPlane(section, 0, -1, vec(0, 2, -10));
  close(query.cast(origin, vec(0, 0, 1), 10, section).distance, 2);
});

test("all ancestor visibility and material visibility are checked dynamically without rebuilding", () => {
  const outer = new THREE.Group(), inner = new THREE.Group(), mesh = triangle();
  outer.add(inner); inner.add(mesh);
  const query = new FollowTerrainQuery(THREE).setRoots([inner]);
  const cast = () => query.cast(vec(0, 0, 10), vec(0, 0, -1), 20);
  assert.ok(cast());
  for (const node of [outer, inner, mesh, mesh.material]) {
    node.visible = false; assert.equal(cast(), null);
    node.visible = true; assert.ok(cast());
  }
});

test("source water and fog, translucent effect meshes and invisible materials are not solid camera walls", () => {
  for (const kind of ["water", "fog"]) {
    const surface = material(); surface.userData.peakSourceEffect = { kind };
    const mesh = triangle({ material: surface });
    assert.equal(new FollowTerrainQuery(THREE).setRoots([mesh]).cast(vec(0, 0, 10), vec(0, 0, -1), 20), null);
  }
  for (const options of [{ transparent: true, depthWrite: false }, { transparent: true, opacity: 0.3 }, { opacity: 0 }]) {
    const mesh = triangle({ material: material(options) });
    assert.equal(new FollowTerrainQuery(THREE).setRoots([mesh]).cast(vec(0, 0, 10), vec(0, 0, -1), 20), null);
  }
  const opaqueHazard = material(); opaqueHazard.userData.peakSourceEffect = { kind: "hazard" };
  assert.ok(new FollowTerrainQuery(THREE).setRoots([triangle({ material: opaqueHazard })]).cast(vec(0, 0, 10), vec(0, 0, -1), 20));
});

test("verified foliage shader is soft while rock, tree trunks and unknown source metadata stay solid", () => {
  const foliage = material(); foliage.name = "M_Foliage Generic_Red";
  foliage.userData.peakTerrain = { sourceColors: { shader: "GD/FoliageGD" } };
  const leaf = triangle({ material: foliage }); leaf.position.z = 9.99;
  const trunk = triangle(); trunk.material.name = "Tree_Trunk";
  trunk.material.userData.peakTerrain = { sourceColors: { shader: "W/Peak_Rock" } };
  const query = new FollowTerrainQuery(THREE).setRoots([leaf, trunk]);
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 20).distance, 10, 1e-7);
  assert.equal(leaf.visible, true); assert.equal(foliage.visible, true);
  assert.equal(foliage.transparent, false, "a query must not change how the original leaves render");
  for (const shader of [undefined, "Unknown/Foliage", "GD/FoliageGD-other", "W/Peak_Rock"]) {
    const surface = material(); surface.name = "M_Foliage Generic_Red";
    if (shader) surface.userData.peakTerrain = { sourceColors: { shader } };
    assert.ok(new FollowTerrainQuery(THREE).setRoots([triangle({ material: surface })])
      .cast(vec(0, 0, 10), vec(0, 0, -1), 20), `unverified shader ${shader} must not be excluded by material name`);
  }
});

test("material groups and drawRange exclude unrendered triangles without excluding an opaque neighbour", () => {
  const mesh = triangle({ indexed: false });
  mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -2, -2, 3, 2, -2, 3, 0, 2, 3, -2, -2, 0, 2, -2, 0, 0, 2, 0,
  ], 3));
  mesh.material = [material({ transparent: true, opacity: 0.3 }), material()];
  mesh.geometry.addGroup(0, 3, 0); mesh.geometry.addGroup(3, 3, 1);
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const cast = () => query.cast(vec(0, 0, 10), vec(0, 0, -1), 20);
  close(cast().distance, 10);
  mesh.geometry.setDrawRange(0, 3); assert.equal(cast(), null);
  mesh.geometry.setDrawRange(3, 3); close(cast().distance, 10);
  mesh.material[1].visible = false; assert.equal(cast(), null);
});

test("batch wrappers share one triangle tree while their draw ranges and material groups remain independent", () => {
  for (const indexed of [false, true]) {
    const position = new THREE.Float32BufferAttribute([
      -2, -2, 4, 2, -2, 4, 0, 2, 4, -2, -2, 0, 2, -2, 0, 0, 2, 0,
    ], 3);
    const index = indexed ? new THREE.Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1) : null;
    function wrapper(start, materialIndex) {
      const geometry = new THREE.BufferGeometry().setAttribute("position", position).setIndex(index);
      geometry.addGroup(0, 3, 0); geometry.addGroup(3, 3, 1);
      geometry.setDrawRange(start, 3);
      const materials = [material(), material()]; materials[materialIndex].visible = false;
      return new THREE.Mesh(geometry, materials);
    }
    const near = wrapper(0, 1), far = wrapper(3, 0);
    const query = new FollowTerrainQuery(THREE).setRoots([near, far]);
    assert.equal(query.entries[0].geometry, query.entries[1].geometry, "visibility wrappers reuse the immutable triangle tree");
    assert.equal(query.stats.geometries, 1, "diagnostics count unique triangle trees, not wrappers");
    const cast = () => query.castAll(vec(0, 0, 10), vec(0, 0, -1), 20, null, { renderedFacesOnly: true });
    assert.deepEqual(cast().map(hit => [hit.mesh, hit.distance]), [[near, 6], [far, 10]]);
    near.geometry.setDrawRange(3, 3);
    assert.deepEqual(cast().map(hit => hit.mesh), [far], "the near wrapper's far material is independently hidden");
    far.geometry.setDrawRange(0, 3);
    assert.deepEqual(cast(), [], "the far wrapper's near material is independently hidden");
    near.geometry.setDrawRange(0, 3);
    assert.deepEqual(cast().map(hit => hit.mesh), [near]);
    const original = query.entries[0].geometry;
    for (let i = 0; i < 3; i++) position.setZ(i, 7);
    position.needsUpdate = true; query.setRoots([near, far]);
    assert.notEqual(query.entries[0].geometry, original);
    assert.equal(query.entries[0].geometry, query.entries[1].geometry, "one version change refreshes both wrappers to one new tree");
    close(cast()[0].distance, 3);
  }
});

test("source partitions use distinct index trees and an index version change refreshes every matching wrapper", () => {
  const position = new THREE.Float32BufferAttribute([
    -2, -2, 4, 2, -2, 4, 0, 2, 4, -2, -2, 0, 2, -2, 0, 0, 2, 0,
  ], 3);
  const nearIndex = new THREE.Uint16BufferAttribute([0, 1, 2], 1);
  const farIndex = new THREE.Uint16BufferAttribute([3, 4, 5], 1);
  const make = index => new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", position).setIndex(index), material());
  const near = make(nearIndex), far = make(farIndex), farWrapper = make(farIndex);
  const query = new FollowTerrainQuery(THREE).setRoots([near, far, farWrapper]);
  const [nearTree, farTree] = query.entries.map(entry => entry.geometry);
  assert.notEqual(nearTree, farTree);
  assert.equal(farTree, query.entries[2].geometry);
  assert.equal(query.stats.geometries, 2);
  const cast = () => query.castAll(vec(0, 0, 10), vec(0, 0, -1), 20);
  assert.deepEqual(cast().map(hit => hit.distance), [6, 10, 10]);
  farIndex.array.set([0, 1, 2]); farIndex.needsUpdate = true;
  query.setRoots([near, far, farWrapper]);
  assert.equal(query.entries[0].geometry, nearTree, "an unrelated index partition remains cached");
  assert.notEqual(query.entries[1].geometry, farTree);
  assert.equal(query.entries[1].geometry, query.entries[2].geometry);
  assert.deepEqual(cast().map(hit => hit.distance), [6, 6, 6]);
});

test("instanced triangles retain world reflections and nonuniform scale without per-instance geometry copies", () => {
  const source = triangle(), instances = new THREE.InstancedMesh(source.geometry, source.material, 3);
  const matrix = new THREE.Matrix4();
  instances.setMatrixAt(0, matrix.makeTranslation(30, 0, 5));
  instances.setMatrixAt(1, matrix.makeScale(-2, 3, 0.5).setPosition(0, 0, 4));
  instances.setMatrixAt(2, matrix.makeScale(0, 0, 0));
  const root = new THREE.Group(); root.scale.z = -1; root.add(instances);
  const query = new FollowTerrainQuery(THREE).setRoots([root]);
  const hit = query.cast(vec(0, 0, -10), vec(0, 0, 1), 20);
  close(hit.distance, 6); close(hit.point, [0, 0, -4]); close(hit.normal, [0, 0, -1]);
  assert.equal(hit.mesh, instances); assert.equal(hit.instanceId, 1);
  assert.equal(query.stats.instances, 2); assert.equal(query.stats.geometries, 1);
  assert.equal(instances.geometry, source.geometry);
});

test("instance zero-scale hiding, restoring on rewind and movement refresh through needsUpdate", () => {
  const source = triangle(), mesh = new THREE.InstancedMesh(source.geometry, source.material, 1);
  const original = new THREE.Matrix4().makeTranslation(0, 0, 2), hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  mesh.setMatrixAt(0, original);
  const query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const cast = () => query.cast(vec(0, 0, 10), vec(0, 0, -1), 20);
  close(cast().distance, 8);
  mesh.setMatrixAt(0, hidden); mesh.instanceMatrix.needsUpdate = true; assert.equal(cast(), null);
  mesh.setMatrixAt(0, original); mesh.instanceMatrix.needsUpdate = true; close(cast().distance, 8);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(50, 0, 2)); mesh.instanceMatrix.needsUpdate = true;
  assert.equal(cast(), null);
  close(query.cast(vec(50, 0, 10), vec(0, 0, -1), 20).distance, 8);
});

test("a geometry attribute version change rebuilds its weak cache on the next explicit setRoots", () => {
  const mesh = triangle(), query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const position = mesh.geometry.attributes.position;
  for (let i = 0; i < position.count; i++) position.setZ(i, 4);
  position.needsUpdate = true;
  query.setRoots([mesh]);
  close(query.cast(vec(0, 0, 10), vec(0, 0, -1), 20).distance, 6);
});

test("accelerated hits match Three's native triangle raycast over seeded sheared and mirrored instances", () => {
  let seed = 170923;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const root = new THREE.Group(); root.scale.set(1, 2.2, -1); root.position.set(-12, 20, 41);
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(3, 4, 5), material({ side: THREE.DoubleSide }), 80);
  root.add(mesh);
  for (let i = 0; i < mesh.count; i++) {
    const scale = i % 3 === 0 ? -1.8 : 1.4;
    mesh.setMatrixAt(i, new THREE.Matrix4().set(scale, random() * 0.4, 0.3, random() * 80 - 40,
      0.2, 0.8 + random(), 0.5, random() * 30 - 15,
      -0.1, 0.2, 0.7 + random(), random() * 80 - 40, 0, 0, 0, 1));
  }
  const query = new FollowTerrainQuery(THREE).setRoots([root]);
  const raycaster = new THREE.Raycaster(); raycaster.far = 180;
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const origin = vec(random() * 100 - 60, random() * 80, random() * 100);
    const direction = vec(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    raycaster.set(origin, direction);
    const nativeHits = raycaster.intersectObject(root, true), native = nativeHits[0] || null;
    const accelerated = query.cast(origin, direction, 180);
    assert.equal(Boolean(accelerated), Boolean(native));
    if (native) {
      hits++; close(accelerated.distance, native.distance, 1e-6); close(accelerated.point, native.point, 1e-6);
      assert.ok(accelerated.normal.dot(direction) <= 0); close(accelerated.normal.length(), 1);
    }
    const expected = new Map();
    for (const hit of nativeHits) if (!expected.has(hit.instanceId)) expected.set(hit.instanceId, hit);
    const all = query.castAll(origin, direction, 180);
    assert.equal(all.length, expected.size);
    for (const hit of all) {
      const expectedHit = expected.get(hit.instanceId);
      assert.equal(hit.mesh, mesh); assert.ok(expectedHit);
      close(hit.distance, expectedHit.distance, 1e-6); close(hit.point, expectedHit.point, 1e-6);
    }
  }
  assert.ok(hits > 10, `seed must exercise real intersections, got ${hits}`);
});

test("invalid, degenerate and empty geometry or invalid ray input never manufacture hits", () => {
  const mesh = triangle(); mesh.geometry.attributes.position.array.fill(0);
  const query = new FollowTerrainQuery(THREE).setRoots([mesh, new THREE.Mesh(new THREE.BufferGeometry(), material())]);
  for (const [origin, direction, limit] of [[vec(0, 0, 1), vec(0, 0, -1), 10], [vec(NaN, 0, 0), vec(0, 0, 1), 10],
    [vec(), vec(0, 0, 0), 10], [vec(), vec(0, 0, 1), -1], [vec(), vec(0, 0, 1), Infinity]]) {
    assert.equal(query.cast(origin, direction, limit), null);
    assert.deepEqual(query.castAll(origin, direction, limit), []);
  }
  query.dispose(); assert.equal(query.cast(vec(0, 0, 1), vec(0, 0, -1), 10), null);
  assert.deepEqual(query.castAll(vec(0, 0, 1), vec(0, 0, -1), 10), []);
});

test("two-level BVH bounds both instance candidates and triangle work for a large shared mesh", (t) => {
  // 20,000 triangles, repeated in 625 separate map props. A naive raycast would
  // inspect 12.5 million triangles; these assertions test work, not machine speed.
  const geometry = new THREE.PlaneGeometry(100, 100, 100, 100);
  const mesh = new THREE.InstancedMesh(geometry, material(), 625);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < 625; i++) mesh.setMatrixAt(i, matrix.makeTranslation((i % 25) * 120, Math.floor(i / 25) * 120, 0));
  const start = performance.now(), query = new FollowTerrainQuery(THREE).setRoots([mesh]);
  const buildMs = performance.now() - start;
  const rayStart = performance.now();
  for (let i = 0; i < 250; i++) {
    assert.ok(query.cast(vec(1200.25, 1200.25, 55), vec(0, 0, -1), 60));
    assert.ok(query.lastStats.instances <= 2, `${query.lastStats.instances} instance candidates`);
    assert.ok(query.lastStats.triangles < 50, `${query.lastStats.triangles} triangle candidates`);
  }
  t.diagnostic(`20k triangles × 625 instances: build ${buildMs.toFixed(1)} ms; 250 casts ${(performance.now() - rayStart).toFixed(1)} ms; last ${JSON.stringify(query.lastStats)}`);
  assert.equal(query.castAll(vec(1200.25, 1200.25, 55), vec(0, 0, -1), 60).length, 1);
  assert.ok(query.lastStats.instances <= 2);
  assert.ok(query.lastStats.triangles < 50, "all-hit queries retain both levels of BVH pruning");
  assert.equal(query.stats.geometries, 1);
});
