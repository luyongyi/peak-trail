import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { FollowTerrainQuery } from "../src/follow-terrain.js";

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
    const query = new FollowTerrainQuery(THREE).setRoots([triangle({ indexed })]);
    const hit = query.cast(vec(0, 0, 10), vec(0, 0, -1), 20);
    close(hit.distance, 10); close(hit.point, [0, 0, 0]); close(hit.normal, [0, 0, 1]);
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
    const native = raycaster.intersectObject(root, true)[0] || null;
    const accelerated = query.cast(origin, direction, 180);
    assert.equal(Boolean(accelerated), Boolean(native));
    if (native) {
      hits++; close(accelerated.distance, native.distance, 1e-6); close(accelerated.point, native.point, 1e-6);
      assert.ok(accelerated.normal.dot(direction) <= 0); close(accelerated.normal.length(), 1);
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
  }
  query.dispose(); assert.equal(query.cast(vec(0, 0, 1), vec(0, 0, -1), 10), null);
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
  assert.equal(query.stats.geometries, 1);
});
