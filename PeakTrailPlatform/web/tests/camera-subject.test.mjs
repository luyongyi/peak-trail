import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "../../vendor/three/0.180.0/build/three.module.js";
import { collectCameraParts, selectCameraSubjectParts } from "../src/camera-subject.js";
import { fitPerspectivePoints } from "../src/camera-framing.js";

const part = (min, max, name = "part") => ({ name, bounds: { min, max } });
const mountain = () => Array.from({ length: 20 }, (_, index) => {
  const x = index % 5 * 20, z = Math.floor(index / 5) * 20;
  return part([x, 0, z], [x + 21, 30, z + 21], `terrain-${index}`);
});

test("small distant fragments do not move the dense subject, while nearby detached landmarks remain", () => {
  const main = mountain();
  const camp = part([108, 28, 65], [110, 30, 67], "camp");
  const highRock = part([60, 250, 60], [63, 253, 63], "high rock");
  const belowRock = part([-200, -100, 30], [-197, -97, 33], "below rock");
  const input = [...main, camp, highRock, belowRock], before = structuredClone(input);
  const selected = selectCameraSubjectParts(input);
  assert.deepEqual(selected, [...main, camp]);
  assert.deepEqual(input, before);
  assert.equal(selected[0], input[0]);
  assert.equal(selected.at(-1), camp);
});

test("connected tall thin towers and long bridges remain whole", () => {
  const main = mountain();
  const tower = part([40, 25, 40], [41, 180, 41], "tower");
  const bridge = part([80, 15, 40], [240, 16, 41], "bridge");
  const rock = part([30, 450, 30], [32, 452, 32]);
  assert.deepEqual(selectCameraSubjectParts([...main, tower, bridge, rock]), [...main, tower, bridge]);
});

test("a low chapter preserves a nearby horizontal exit without granting the same vertical tolerance", () => {
  const main = mountain();
  const exit = part([110, 20, 40], [112, 22, 42], "exit");
  const floating = part([40, 40, 40], [41, 41, 41], "floating fragment");
  assert.deepEqual(selectCameraSubjectParts([...main, exit, floating]), [...main, exit]);
});

test("a substantial separate island and a thin detached landmark are protected", () => {
  const main = mountain();
  // Even low surface weight cannot discard a tall authored structure.
  const mast = part([300, 0, 0], [300.1, 60, 0.1], "mast");
  const island = part([400, 0, 0], [420, 1, 20], "island");
  const rock = part([900, 300, 900], [901, 301, 901]);
  assert.deepEqual(selectCameraSubjectParts([...main, mast, island, rock]), [...main, mast, island]);
});

test("multiple major islands and a sparse ambiguous scene retain all geometry", () => {
  const a = mountain(), b = mountain().map((p) => part(p.bounds.min.map((v, i) => v + (i === 0 ? 400 : 0)),
    p.bounds.max.map((v, i) => v + (i === 0 ? 400 : 0))));
  const input = [...a, ...b, part([10, 500, 10], [11, 501, 11])];
  assert.deepEqual(selectCameraSubjectParts(input), input);
  const sparse = [part([0, 0, 0], [50, 0, 50]), part([200, 0, 0], [201, 1, 1])];
  assert.deepEqual(selectCameraSubjectParts(sparse), sparse);
});

test("empty, malformed, reversed, and point-only bounds fail conservatively", () => {
  assert.deepEqual(selectCameraSubjectParts(null), []);
  assert.deepEqual(selectCameraSubjectParts({}), []);
  assert.deepEqual(selectCameraSubjectParts([]), []);
  for (const invalid of [null, {}, part([0, 0, 0], [NaN, 0, 0]), part([1, 0, 0], [0, 0, 0])]) {
    const input = [...mountain(), invalid];
    assert.deepEqual(selectCameraSubjectParts(input), input);
  }
  const points = Array.from({ length: 12 }, (_, index) => part([index, 0, 0], [index, 0, 0]));
  assert.deepEqual(selectCameraSubjectParts(points), points);
});

test("subject selection is independent of input order and coordinate scale", () => {
  const input = [...mountain(), part([600, 500, 600], [603, 503, 603], "outlier")];
  for (const scale of [0.001, 1, 10000]) {
    const scaled = input.map((p) => part(p.bounds.min.map((v) => v * scale), p.bounds.max.map((v) => v * scale), p.name));
    const expected = new Set(scaled.slice(0, -1).map((p) => p.name));
    assert.deepEqual(new Set(selectCameraSubjectParts(scaled.toReversed()).map((p) => p.name)), expected);
  }
});

test("interior composition omits extremely distant repeated small rocks despite their combined surface weight", () => {
  const main = [...mountain(), ...mountain().map((entry) => part(entry.bounds.min.map((value, axis) => value + (axis === 2 ? 80 : 0)),
    entry.bounds.max.map((value, axis) => value + (axis === 2 ? 80 : 0)), `rear-${entry.name}`))];
  const rocks = Array.from({ length: 9 }, (_, index) => part([1600, 10, 1600], [1608.8, 18.8, 1608.8], `repeated-rock-${index}`));
  const input = [...main, ...rocks], before = structuredClone(input);
  const area = (entry) => {
    const [x, y, z] = entry.bounds.max.map((value, axis) => value - entry.bounds.min[axis]);
    return x * y + y * z + z * x;
  };
  const fragmentWeight = rocks.reduce((sum, entry) => sum + area(entry), 0) / input.reduce((sum, entry) => sum + area(entry), 0);
  assert.ok(fragmentWeight > 0.025 && fragmentWeight < 0.035, "nine copies contribute roughly 3% of the total surface weight");
  assert.deepEqual(selectCameraSubjectParts(input), input, "ordinary outdoor composition still protects weighted detached components");
  const selected = selectCameraSubjectParts(input, { interior: true });
  assert.deepEqual(selected, main);
  assert.equal(selected[0], input[0], "selected entries remain the original objects");
  assert.deepEqual(input, before, "subject filtering never changes geometry bounds");
});

test("interior composition protects sizeable distant islands, near exits and nearby weighted fragments", () => {
  const main = [...mountain(), ...mountain().map((entry) => part(entry.bounds.min.map((value, axis) => value + (axis === 2 ? 80 : 0)),
    entry.bounds.max.map((value, axis) => value + (axis === 2 ? 80 : 0)), `rear-${entry.name}`))];
  const rocks = Array.from({ length: 9 }, (_, index) => part([1600, 10, 1600], [1608.8, 18.8, 1608.8], `repeated-rock-${index}`));
  const exit = part([113, 20, 70], [115, 22, 72], "exit");
  const island = part([700, 0, 0], [740, 3, 30], "separate island");
  assert.deepEqual(selectCameraSubjectParts([...main, ...rocks, exit, island], { interior: true }), [...main, exit, island]);
  const nearbyRocks = rocks.map((entry) => part([220, 10, 100], [228.8, 18.8, 108.8], entry.name));
  assert.deepEqual(selectCameraSubjectParts([...main, ...nearbyRocks], { interior: true }), [...main, ...nearbyRocks],
    "a weighted small component within one main-subject diagonal is protected");
});

test("interior filtering keeps every part when multiple substantial subjects make the scene ambiguous", () => {
  const main = mountain();
  const other = mountain().map((entry) => part(entry.bounds.min.map((value, axis) => value + (axis === 0 ? 500 : 0)),
    entry.bounds.max.map((value, axis) => value + (axis === 0 ? 500 : 0)), `other-${entry.name}`));
  const rocks = Array.from({ length: 9 }, (_, index) => part([1600, 10, 1600], [1608.8, 18.8, 1608.8], `repeated-rock-${index}`));
  const input = [...main, ...other, ...rocks];
  assert.deepEqual(selectCameraSubjectParts(input, { interior: true }), input);
});

function fixture() {
  const root = new THREE.Group(); root.scale.set(1, 3, -1);
  const chapter = new THREE.Group(); root.add(chapter);
  const origin = new THREE.Vector3(10, 400, 70);
  const model = new THREE.Group(); model.position.copy(origin).negate(); chapter.add(model);
  return { root, chapter, origin, model };
}

test("collection removes display origin, height scale, and reflection but keeps exact instance transforms", () => {
  const { chapter, origin, model } = fixture();
  const geometry = new THREE.BoxGeometry(2, 4, 6), material = new THREE.MeshBasicMaterial();
  material.userData.peakTerrain = { sourceMaterial: "rock", sourceColors: { shader: "W/Peak_Rock" } };
  const mesh = new THREE.InstancedMesh(geometry, material, 2);
  const transform = new THREE.Matrix4().set(2, 0.5, 0, 100, 0, 3, 0, 800, 0, 0, -1, 300, 0, 0, 0, 1);
  mesh.setMatrixAt(0, transform); mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(120, 810, 320));
  model.add(mesh);
  const original = Array.from(mesh.instanceMatrix.array);
  const result = collectCameraParts(THREE, chapter, origin);
  assert.deepEqual(result.map((p) => p.bounds), [
    { min: [97, 794, 297], max: [103, 806, 303] },
    { min: [119, 808, 317], max: [121, 812, 323] },
  ]);
  assert.deepEqual(result[0].materials, [{ name: "rock", shader: "W/Peak_Rock" }]);
  assert.equal(result[0].points.length, 8);
  assert.deepEqual(result[0].points[0], [97, 794, 303]);
  for (const part of result) {
    assert.deepEqual(new THREE.Box3().setFromPoints(part.points.map((point) => new THREE.Vector3().fromArray(point))).min.toArray(), part.bounds.min);
    assert.deepEqual(new THREE.Box3().setFromPoints(part.points.map((point) => new THREE.Vector3().fromArray(point))).max.toArray(), part.bounds.max);
  }
  assert.deepEqual(Array.from(mesh.instanceMatrix.array), original);
  assert.equal(mesh.geometry.boundingBox, null);
  geometry.dispose(); material.dispose();
});

test("oriented local corners frame a rotated slender mesh closer while containing its rendered indexed vertices", () => {
  const { chapter, origin, model } = fixture();
  const geometry = new THREE.BoxGeometry(4, 4, 600), material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(160, 100, 220); mesh.rotation.y = Math.PI / 4;
  model.add(mesh);
  const [part] = collectCameraParts(THREE, chapter, origin);
  const display = ([x, y, z]) => [x - origin.x, (y - origin.y) * 3, -(z - origin.z)];
  const oriented = part.points.map(display);
  const axisAligned = [];
  for (const x of [part.bounds.min[0], part.bounds.max[0]]) for (const y of [part.bounds.min[1], part.bounds.max[1]]) for (const z of [part.bounds.min[2], part.bounds.max[2]]) {
    axisAligned.push(display([x, y, z]));
  }
  const options = { aspect: 3, padding: 1.04 };
  const fit = fitPerspectivePoints(oriented, options), previous = fitPerspectivePoints(axisAligned, options);
  assert.ok(fit.distance < previous.distance * 0.8, "removing rotated world-box inflation moves the camera at least 20% closer");
  for (const aspect of [3, 16 / 9, 9 / 16]) {
    const frame = fitPerspectivePoints(oriented, { ...options, aspect });
    const camera = new THREE.PerspectiveCamera(38, aspect, frame.near, frame.far);
    camera.position.fromArray(frame.position); camera.up.fromArray(frame.up);
    camera.lookAt(new THREE.Vector3().fromArray(frame.target)); camera.updateMatrixWorld(true);
    const position = geometry.getAttribute("position"), index = geometry.getIndex();
    for (let offset = 0; offset < index.count; offset++) {
      const projected = new THREE.Vector3().fromBufferAttribute(position, index.getX(offset)).applyMatrix4(mesh.matrixWorld).project(camera);
      assert.ok(Math.abs(projected.x) <= 1 / options.padding + 1e-8, `rendered vertex X fits at aspect ${aspect}`);
      assert.ok(Math.abs(projected.y) <= 1 / options.padding + 1e-8, `rendered vertex Y fits at aspect ${aspect}`);
      assert.ok(projected.z > -1 && projected.z < 1, "actual geometry remains between the clipping planes");
    }
  }
  assert.equal(geometry.boundingBox, null);
  geometry.dispose(); material.dispose();
});

test("indexed draw ranges and material groups exclude unrelated shared-buffer positions", () => {
  const { chapter, origin, model } = fixture();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0, 2, 0, 0, 0, 3, 0,
    5000, 6000, 7000, 5001, 6000, 7000, 5000, 6001, 7000,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.setDrawRange(0, 3);
  const material = new THREE.MeshBasicMaterial(), mesh = new THREE.Mesh(geometry, material); model.add(mesh);
  let collected = collectCameraParts(THREE, chapter, origin)[0];
  assert.deepEqual(collected.bounds, { min: [0, 0, 0], max: [2, 3, 0] });
  assert.ok(collected.points.every(([x, y, z]) => x >= 0 && x <= 2 && y >= 0 && y <= 3 && z === 0));
  geometry.setDrawRange(3, 3);
  collected = collectCameraParts(THREE, chapter, origin)[0];
  assert.deepEqual(collected.bounds, { min: [5000, 6000, 7000], max: [5001, 6001, 7000] });
  assert.ok(collected.points.every(([x, y, z]) => x >= 5000 && x <= 5001 && y >= 6000 && y <= 6001 && z === 7000));
  geometry.setDrawRange(0, Infinity); geometry.addGroup(0, 3, 0);
  collected = collectCameraParts(THREE, chapter, origin)[0];
  assert.deepEqual(collected.bounds, { min: [0, 0, 0], max: [2, 3, 0] });
  assert.ok(collected.points.every(([x, y, z]) => x >= 0 && x <= 2 && y >= 0 && y <= 3 && z === 0));
  geometry.getAttribute("position").setX(1, 4); geometry.getAttribute("position").needsUpdate = true;
  collected = collectCameraParts(THREE, chapter, origin)[0];
  assert.equal(collected.bounds.max[0], 4);
  assert.equal(Math.max(...collected.points.map(([x]) => x)), 4);
  geometry.dispose(); material.dispose();
});

test("collection respects hidden ancestors, nonindexed ranges, and collapsed instances", () => {
  const { chapter, origin, model } = fixture();
  const material = new THREE.MeshBasicMaterial(), geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 2, 0, 0, 0, 3, 0, 9999, 9999, 9999], 3));
  geometry.setDrawRange(0, 3);
  const visible = new THREE.Mesh(geometry, material); model.add(visible);
  const hidden = new THREE.Group(); hidden.visible = false; model.add(hidden);
  const hiddenMesh = new THREE.Mesh(geometry, material); hiddenMesh.position.setScalar(4000); hidden.add(hiddenMesh);
  const collapsed = new THREE.InstancedMesh(geometry, material, 1); collapsed.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0)); model.add(collapsed);
  assert.deepEqual(collectCameraParts(THREE, chapter, origin).map((p) => p.bounds), [{ min: [0, 0, 0], max: [2, 3, 0] }]);
  assert.deepEqual(collectCameraParts(THREE, null, origin), []);
  chapter.scale.y = 0;
  assert.deepEqual(collectCameraParts(THREE, chapter, origin), []);
  geometry.dispose(); material.dispose();
});
