import assert from "node:assert/strict";
import test from "node:test";
import { fitSurveyCamera } from "../src/survey-camera-fit.js";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
const normalize = value => { const length = Math.hypot(...value); return value.map(part => part / length); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const bounds = (min, max) => ({ min, max });

// Independently project world corners from the returned camera pose rather than
// comparing the distance with the implementation's fitting expression.
function assertInFrustum(input, fit = fitSurveyCamera(input)) {
  assert.ok(fit, "camera fit should exist");
  const origin = input.origin || [0, 0, 0], height = input.heightScale ?? 1;
  const forward = normalize(subtract(fit.target, fit.position));
  const right = normalize(cross(forward, fit.up)), up = cross(right, forward);
  const tangentV = Math.tan((input.verticalFovDegrees ?? 45) * Math.PI / 360);
  const padding = input.padding ?? 1.08;
  let maximum = 0;
  for (const x of input.bounds.min[0] === input.bounds.max[0] ? [input.bounds.min[0]] : [input.bounds.min[0], input.bounds.max[0]])
    for (const y of [input.bounds.min[1], input.bounds.max[1]]) for (const z of [input.bounds.min[2], input.bounds.max[2]]) {
      const display = [x - origin[0], (y - origin[1]) * height, -(z - origin[2])];
      const relative = subtract(display, fit.position), depth = dot(relative, forward);
      assert.ok(depth > fit.near && depth < fit.far, `corner depth ${depth} must be between clipping planes`);
      const horizontal = Math.abs(dot(relative, right)) / (depth * tangentV * input.aspect);
      const vertical = Math.abs(dot(relative, up)) / (depth * tangentV);
      assert.ok(horizontal <= 1 / padding + 1e-10, `horizontal NDC ${horizontal} must preserve padding`);
      assert.ok(vertical <= 1 / padding + 1e-10, `vertical NDC ${vertical} must preserve padding`);
      maximum = Math.max(maximum, horizontal, vertical);
    }
  assert.ok(fit.minDistance > 0 && fit.minDistance < fit.distance && fit.maxDistance > fit.distance);
  return maximum;
}

test("all eight corners fit oblique survey views on landscape, portrait and very narrow screens", () => {
  for (const shape of [bounds([-30, -20, -2000], [30, 20, 2000]), bounds([-30, -1500, -20], [30, 1500, 20]),
    bounds([-800, 0, -300], [800, 900, 300]), bounds([-900, -50, -800], [900, 50, 800])]) {
    for (const aspect of [16 / 9, 1, 9 / 16, .12]) {
      const input = { bounds: shape, aspect, verticalFovDegrees: 55 };
      assertInFrustum(input);
    }
  }
});

test("angular padding sets the minimum fitted distance instead of an oversized sphere estimate", () => {
  for (const aspect of [2, .4]) for (const padding of [1, 1.08, 1.2]) {
    const input = { bounds: bounds([-30, -15, -600], [30, 15, 600]), aspect, padding };
    const fit = fitSurveyCamera(input);
    const maximum = assertInFrustum(input, fit);
    assert.ok(Math.abs(maximum - 1 / padding) < 1e-10, "a limiting corner should fill the requested padded frustum");
    assert.ok(fit.distance > fitSurveyCamera({ ...input, padding: Math.max(1, padding - .01) }).distance || padding === 1);
    const closer = { ...fit, position: fit.target.map((value, axis) => value + (fit.position[axis] - value) * .99) };
    assert.throws(() => assertInFrustum(input, closer), /NDC/);
  }
});

test("source origin, vertical exaggeration and a single Z mirror produce the correct displayed center", () => {
  const source = { bounds: bounds([100, 200, 300], [500, 1000, 2300]), origin: [70, 90, 170],
    heightScale: 2.5, aspect: .35, direction: [.52, .7, .62] };
  const before = structuredClone(source), fit = fitSurveyCamera(source);
  assert.deepEqual(fit.target, [230, 1275, -1130]);
  assert.deepEqual(fit.up, [0, 1, 0], "orbit keeps the original world up axis");
  assertInFrustum(source, fit);
  assert.deepEqual(source, before);
  const shifted = fitSurveyCamera({ ...source, origin: [170, 190, 270] });
  assert.deepEqual(shifted.target, [130, 1025, -1030]);
  assert.equal(shifted.distance, fit.distance, "changing display origin does not change framing");
});

test("exact overhead views use the supplied north-facing up and cover both horizontal axes", () => {
  for (const aspect of [2, .6, .1]) for (const heightScale of [.2, 1, 5]) {
    const input = { bounds: bounds([-40, 400, 900], [40, 1800, 3200]), aspect, heightScale,
      direction: [0, 1, 0], up: [0, 0, -1] };
    const fit = fitSurveyCamera(input);
    assert.deepEqual(fit.up, [0, 0, -1]);
    assert.equal(fit.position[0], fit.target[0]);
    assert.equal(fit.position[2], fit.target[2]);
    assertInFrustum(input, fit);
  }
});

// Representative exact canonical bounds from build 25739797 map-pack manifests:
// Level_17 Shore/Tropics/Alpine/Swamp/Temple/Void and Level_0 Mesa/Volcano.
// These fixtures remain self-contained; tests do not need private game assets.
const nativeBounds = [
  bounds([-378.0893249511719, -127.34547424316406, -479.1436462402344], [365.5124206542969, 295.37060546875, 264.4580993652344]),
  bounds([-261.5227966308594, 133.5384063720703, 104.37908935546875], [249.17762756347656, 570.8381958007812, 615.0795288085938]),
  bounds([-392.919677734375, 414.1266174316406, 542.4268798828125], [391.8365478515625, 872.4484252929688, 1327.18310546875]),
  bounds([-669.1478271484375, 654.3543701171875, 1216.75], [645.9749145507812, 907.9946899414062, 2531.872802734375]),
  bounds([-121.16606140136719, 720.6624145507812, 2014.52490234375], [184.63668823242188, 1233.1920166015625, 2320.32763671875]),
  bounds([-2505, -272.47381591796875, -2294.124267578125], [2505, 1015.9666137695312, 2715.875732421875]),
  bounds([-425.2794189453125, 234.31460571289062, 522.7149047851562], [461.3868408203125, 881.3670043945312, 1409.3812255859375]),
  bounds([-420.9540100097656, 531.4979248046875, 1233.3375244140625], [391.90277099609375, 1146.9178466796875, 2046.1943359375]),
];
test("new native map layer ranges fit without clipping at every supported height scale and orientation", () => {
  for (const shape of nativeBounds) for (const aspect of [16 / 9, 9 / 16, .15]) for (const heightScale of [.2, 1, 5]) {
    const input = { bounds: shape, aspect, heightScale, origin: [17, 500, 1200] };
    assertInFrustum(input);
    assertInFrustum({ ...input, direction: [0, 1, 0], up: [0, 0, -1] });
  }
});

test("invalid bounds, viewport, field of view and camera frames fail closed", () => {
  const valid = { bounds: bounds([-10, -20, -30], [10, 20, 30]), aspect: 1 };
  for (const input of [null, [], {}, { ...valid, bounds: null }, { ...valid, bounds: bounds([NaN, 0, 0], [1, 1, 1]) },
    { ...valid, bounds: bounds([2, 0, 0], [1, 1, 1]) }, { ...valid, origin: [0, 0] }, { ...valid, origin: [Infinity, 0, 0] },
    ...[0, -1, NaN, Infinity, "1"].map(aspect => ({ ...valid, aspect })),
    ...[0, -1, NaN, Infinity, "1"].map(heightScale => ({ ...valid, heightScale })),
    ...[0, -1, 180, NaN, Infinity, "45"].map(verticalFovDegrees => ({ ...valid, verticalFovDegrees })),
    ...[0, .9, Infinity, "1"].map(padding => ({ ...valid, padding })),
    { ...valid, direction: [0, 0, 0] }, { ...valid, direction: [0, 1, 0] }, { ...valid, up: [0, 0, 0] },
    { ...valid, direction: [0, 1, 0], up: [0, 1, 1e-10] },
    { ...valid, bounds: bounds([-1e308, 0, 0], [1e308, 10, 20]) }]) {
    assert.equal(fitSurveyCamera(input), null);
  }
});

test("flat or point-sized valid bounds still yield finite clipping planes and usable orbit limits", () => {
  for (const shape of [bounds([0, 0, 0], [0, 0, 0]), bounds([-50, 700, 0], [50, 700, 5000])]) {
    assertInFrustum({ bounds: shape, aspect: .25 });
  }
});
