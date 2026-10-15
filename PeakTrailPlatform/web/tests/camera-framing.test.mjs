import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "../../vendor/three/0.180.0/build/three.module.js";
import { fitPerspectivePoints } from "../src/camera-framing.js";

const corners = (min, max) => [min[0], max[0]].flatMap((x) =>
  [min[1], max[1]].flatMap((y) => [min[2], max[2]].map((z) => [x, y, z])));

function verifyFrame(points, options = {}) {
  const frame = fitPerspectivePoints(points, options);
  assert.ok(frame);
  assert.ok(frame.distance >= (options.minDistance ?? 25));
  assert.ok(frame.near > 0 && frame.far > frame.near);
  for (const key of ["position", "target", "up"]) assert.ok(frame[key].every(Number.isFinite));
  const camera = new PerspectiveCamera(options.fov ?? 38, options.aspect ?? 1, frame.near, frame.far);
  camera.position.fromArray(frame.position);
  camera.up.fromArray(frame.up);
  camera.lookAt(new Vector3().fromArray(frame.target));
  camera.updateMatrixWorld(true);
  const projected = points.map((point) => new Vector3().fromArray(point).project(camera));
  const limit = 1 / (options.padding ?? 1.14);
  for (const axis of ["x", "y"]) {
    const min = Math.min(...projected.map((point) => point[axis]));
    const max = Math.max(...projected.map((point) => point[axis]));
    assert.ok(min >= -limit - 1e-8 && max <= limit + 1e-8, `${axis} fits the padded viewport: ${min}, ${max}`);
    assert.ok(Math.abs(min + max) < 1e-8, `${axis} projected bounds are centered: ${min}, ${max}`);
  }
  for (const point of projected) assert.ok(point.z > -1 && point.z < 1, "near and far planes contain all geometry");
  return { frame, projected };
}

test("long diagonal terrain fits and centers its depth-dependent silhouette", () => {
  const angle = Math.PI / 4;
  const terrain = corners([-750, -20, -70], [750, 150, 70]).map(([x, y, z]) => [
    -2500 + x * Math.cos(angle) - z * Math.sin(angle),
    y + 160,
    8000 + x * Math.sin(angle) + z * Math.cos(angle),
  ]);
  terrain.push([-2500, 500, 8000]);
  const { projected } = verifyFrame(terrain, { aspect: 16 / 9 });
  assert.ok(Math.max(...projected.flatMap(({ x, y }) => [Math.abs(x), Math.abs(y)])) > 0.87,
    "the limiting dimension fills the available frame");
});

test("a tall tower fits vertically in both landscape and portrait viewports", () => {
  const points = corners([-40, 0, -25], [40, 1600, 25]);
  verifyFrame(points, { aspect: 3 });
  verifyFrame(points, { aspect: 0.45 });
});

test("flat terrain fits horizontally in portrait as well as wide viewports", () => {
  const points = corners([-600, 40, -150], [600, 40, 150]);
  const wide = verifyFrame(points, { aspect: 3 }).frame;
  const portrait = verifyFrame(points, { aspect: 0.45 }).frame;
  assert.ok(portrait.distance > wide.distance, "a narrower viewport pulls back to preserve the horizontal extent");
});

test("top view preserves north-up framing without a singular camera basis", () => {
  verifyFrame(corners([-120, -50, -600], [120, 500, 600]), {
    aspect: 9 / 16, direction: [0, 1, 0.000001], up: [0, 0, -1], padding: 1.2,
  });
});

test("a single point remains centered with finite clipping planes and minimum distance", () => {
  const point = [[1200, -45, 930]];
  const { frame } = verifyFrame(point, { minDistance: 80 });
  assert.deepEqual(frame.target, point[0]);
  assert.ok(Math.abs(frame.distance - 80) < 1e-8);
  verifyFrame([[0, 0, 0]], { minDistance: 0 });
});

test("screen centering and distance are stable under world-space translation", () => {
  const points = corners([-100, -20, -300], [200, 230, 150]);
  const offset = [100000, -200000, 300000];
  const original = verifyFrame(points).frame;
  const translated = verifyFrame(points.map((point) => point.map((value, axis) => value + offset[axis]))).frame;
  assert.ok(Math.abs(original.distance - translated.distance) < 1e-8);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(translated.target[axis] - original.target[axis] - offset[axis]) < 1e-8);
  }
});

test("invalid points and camera parameters fail without producing a broken pose", () => {
  for (const points of [null, [], [[1, 2]], [[1, NaN, 3]], [[Infinity, 0, 0]], [[1, 2, 3], null]]) {
    assert.equal(fitPerspectivePoints(points), null);
  }
  for (const options of [
    { aspect: 0 }, { aspect: Infinity }, { fov: 0 }, { fov: 180 }, { padding: 0 },
    { minDistance: NaN }, { minDistance: -1 }, { direction: [0, 0, 0] },
    { up: [0, 0, 0] }, { direction: [0, 1, 0], up: [0, 1, 0] },
  ]) assert.equal(fitPerspectivePoints([[0, 0, 0]], options), null);
});
