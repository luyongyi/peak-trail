import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "../../vendor/three/0.180.0/build/three.module.js";
import { chooseOverviewDirection, fitPerspectivePoints } from "../src/camera-framing.js";

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
  const padding = options.padding ?? 1.14;
  const viewport = options.frame ?? { left: -1, right: 1, bottom: -1, top: 1 };
  const axes = [["x", viewport.left, viewport.right], ["y", viewport.bottom, viewport.top]];
  for (const [axis, lower, upper] of axes) {
    const midpoint = (lower + upper) / 2;
    const paddedLower = midpoint + (lower - midpoint) / padding;
    const paddedUpper = midpoint + (upper - midpoint) / padding;
    const min = Math.min(...projected.map((point) => point[axis]));
    const max = Math.max(...projected.map((point) => point[axis]));
    assert.ok(min >= paddedLower - 1e-8 && max <= paddedUpper + 1e-8, `${axis} fits the padded viewport: ${min}, ${max}`);
    assert.ok(Math.abs(min + max - 2 * midpoint) < 1e-8, `${axis} projected bounds are centered: ${min}, ${max}`);
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

test("asymmetric frames keep all geometry below a toolbar and centered inside the padded safe area", () => {
  const points = corners([-320, -40, -600], [440, 380, 400]);
  points.push([200, 680, 100], [-430, 120, -200]);
  const frame = { left: -0.94, right: 0.82, bottom: -0.92, top: 0.68 };
  for (const aspect of [16 / 9, 9 / 16]) {
    const { projected } = verifyFrame(points, { aspect, padding: 1.04, frame });
    assert.ok(Math.max(...projected.map((point) => point.y)) < frame.top);
  }
});

test("an off-center single-point frame can place the camera target beyond the point bounds", () => {
  for (const frame of [
    { left: -1, right: -0.2, bottom: -0.9, top: -0.1 },
    { left: 0.2, right: 1, bottom: 0.1, top: 0.9 },
  ]) {
    const { frame: fit } = verifyFrame([[1200, -45, 930]], { frame, minDistance: 80 });
    assert.notDeepEqual(fit.target, [1200, -45, 930]);
  }
});

test("asymmetric framing is translation-stable and an explicit full frame preserves default behavior", () => {
  const points = corners([-100, -20, -300], [200, 230, 150]);
  const options = { aspect: 16 / 9, padding: 1.04, frame: { left: -0.8, right: 0.95, bottom: -0.9, top: 0.7 } };
  const offset = [100000, -200000, 300000];
  const original = verifyFrame(points, options).frame;
  const translated = verifyFrame(points.map((point) => point.map((value, axis) => value + offset[axis])), options).frame;
  assert.ok(Math.abs(original.distance - translated.distance) < 1e-8);
  for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(translated.target[axis] - original.target[axis] - offset[axis]) < 1e-8);
  assert.deepEqual(fitPerspectivePoints(points), fitPerspectivePoints(points, { frame: { left: -1, right: 1, bottom: -1, top: 1 } }));
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
  for (const frame of [
    null, [], {}, { left: -1, right: 1, bottom: -1 },
    { left: -1.01, right: 1, bottom: -1, top: 1 },
    { left: -1, right: 1.01, bottom: -1, top: 1 },
    { left: 0.2, right: 0.2, bottom: -1, top: 1 },
    { left: 1, right: -1, bottom: -1, top: 1 },
    { left: -1, right: 1, bottom: -1.01, top: 1 },
    { left: -1, right: 1, bottom: -1, top: 1.01 },
    { left: -1, right: 1, bottom: 0, top: 0 },
    { left: -1, right: 1, bottom: 1, top: -1 },
    { left: -1, right: 1, bottom: -1, top: NaN },
  ]) assert.equal(fitPerspectivePoints([[0, 0, 0]], { frame }), null);
});

const originalOverview = [0.52, 0.85, 0.62];
const climbingTerrain = () => [
  ...corners([-100, 0, 300], [100, 60, 600]),
  ...corners([-140, 300, -600], [140, 450, -300]),
];

test("portrait overview fills more of the safe area while retaining the complete climbing route", () => {
  const points = climbingTerrain();
  const options = { aspect: 0.46, padding: 1.02, frame: { left: -0.95, right: 0.95, bottom: -0.92, top: 0.62 } };
  const before = verifyFrame(points, { ...options, direction: originalOverview });
  const direction = chooseOverviewDirection(points, options);
  const after = verifyFrame(points, { ...options, direction });
  const height = (projection) => Math.max(...projection.map((p) => p.y)) - Math.min(...projection.map((p) => p.y));
  assert.ok(height(after.projected) > height(before.projected) * 1.3,
    "the complete chapter occupies substantially more height, not a cropped portion");
  assert.ok(after.frame.distance < before.frame.distance);
});

test("overview adapts to viewport proportions without turning behind or directly above the mountain", () => {
  const points = climbingTerrain();
  const directions = [];
  const originalPitch = Math.atan2(originalOverview[1], Math.hypot(originalOverview[0], originalOverview[2]));
  for (const aspect of [0.46, 0.75, 1, 16 / 9, 3]) {
    const options = { aspect, padding: 1.02, frame: { left: -0.94, right: 0.82, bottom: -0.92, top: 0.68 } };
    const direction = chooseOverviewDirection(points, options);
    const azimuth = Math.atan2(direction[0], direction[2]);
    const pitch = Math.atan2(direction[1], Math.hypot(direction[0], direction[2]));
    assert.ok(azimuth >= 0 && azimuth <= 50 * Math.PI / 180 + 1e-12);
    assert.ok(Math.abs(pitch - originalPitch) < 1e-12, "overview retains its readable oblique pitch");
    assert.ok(azimuth >= 20 * Math.PI / 180, "the long route is not viewed straight end-on");
    directions.push(direction);
    verifyFrame(points, { ...options, direction });
  }
  assert.notDeepEqual(directions[0], directions.at(-1), "portrait and wide views can use different front-side angles");
});

test("overview selection preserves distant extrema and works with translated geometry", () => {
  const points = climbingTerrain();
  // A tall peak and a thin ledge both remain part of the complete chapter.
  points.push([-170, 780, -710], [210, 110, 680]);
  const source = structuredClone(points);
  const options = { aspect: 9 / 16, padding: 1.02, frame: { left: -0.9, right: 1, bottom: -0.85, top: 0.7 } };
  const direction = chooseOverviewDirection(points, options);
  verifyFrame(points, { ...options, direction });
  const shifted = points.map(([x, y, z]) => [x + 12000, y - 22000, z + 48000]);
  assert.deepEqual(chooseOverviewDirection(shifted, options), direction);
  verifyFrame(shifted, { ...options, direction });
  assert.deepEqual(points, source, "choosing a view never modifies source geometry");
});

test("a symmetric footprint retains the established overview instead of rotating on an arbitrary axis", () => {
  for (const points of [corners([-100, 0, -100], [100, 20, 100]), corners([-10, 0, -10], [10, 1600, 10])]) {
    for (const aspect of [0.46, 1, 3]) assert.deepEqual(chooseOverviewDirection(points, { aspect }), originalOverview);
  }
});

test("unusable overview inputs retain the established direction safely", () => {
  for (const points of [null, [], [[1, 2, 3]], [[1, 2, 3], null, [4, 5, 6]], [[0, 0, 0], [1, NaN, 1], [2, 2, 2]]]) {
    assert.deepEqual(chooseOverviewDirection(points), originalOverview);
  }
  for (const options of [
    { aspect: 0 }, { aspect: Infinity }, { aspect: Number.MAX_VALUE },
    { fov: 0 }, { fov: 180 }, { padding: 0 }, { minDistance: -1 },
    { frame: null }, { frame: [] }, { frame: {} },
    { frame: { left: 0, right: 0, bottom: -1, top: 1 } },
    { frame: { left: -1, right: 1, bottom: -1, top: NaN } },
  ]) assert.deepEqual(chooseOverviewDirection(climbingTerrain(), options), originalOverview);
});
