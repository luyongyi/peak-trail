import assert from "node:assert/strict";
import test from "node:test";
import { fitMapAlignment, validateMapAlignment, alignedRoutePoints } from "../../server/map-alignment.mjs";

function evidence() {
  return { version: 1, coordinateSpace: "unity-world-cm", landmarks: [
    { key: "segment-root:0", kind: "segment-root", stageIndex: 0, name: "Shore", positionCm: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1] },
    { key: "segment-root:1", kind: "segment-root", stageIndex: 1, name: "Roots", positionCm: [12000,2000,45000], rotation: [0,0,0,1], scale: [1,1,1] },
    { key: "progress-point:0", kind: "progress-point", stageIndex: 0, name: "Beach Entry", positionCm: [1500,100,0] },
    { key: "progress-point:1", kind: "progress-point", stageIndex: 1, name: "Roots Entry", positionCm: [-700,23000,48000] },
    { key: "progress-point:peak", kind: "progress-point", name: "Peak", positionCm: [20000,52000,69000] },
  ] };
}

test("native map evidence is a bounded whitelist with native stage keys and complete root transforms", () => {
  const input = evidence(); assert.equal(validateMapAlignment(input).landmarks.length, 5);
  for (const mutate of [v => { v.inventory = []; }, v => { v.coordinateSpace = "screen"; },
    v => { v.landmarks[0].steamId = "private"; }, v => { v.landmarks[0].stageIndex = 3; },
    v => { v.landmarks[0].positionCm[0] = .5; }, v => { v.landmarks[0].rotation = [0,0,0,2]; },
    v => { delete v.landmarks[0].scale; }, v => { v.landmarks[2].scale = [1,1,1]; },
    v => { v.landmarks.push(v.landmarks[0]); }, v => { v.landmarks = Array(17).fill(v.landmarks[0]); }]) {
    const changed = structuredClone(input); mutate(changed); assert.throws(() => validateMapAlignment(changed));
  }
});

test("identity uses original map landmarks, independent of arbitrary player spawn and input order", () => {
  const actual = evidence(), source = evidence(); actual.landmarks.reverse();
  const result = fitMapAlignment(actual, source);
  assert.equal(result.status, "verified"); assert.equal(result.method, "identity"); assert.equal(result.landmarkCount, 5);
  assert.deepEqual(alignedRoutePoints([[0,999999,12345,-77777]], result), [[0,999999,12345,-77777]]);
});

test("a proven global translation maps route coordinates back to the source world without modifying recording data", () => {
  const source = evidence(), actual = evidence(), offset = [2300,-600,7400];
  actual.landmarks.forEach(item => { item.positionCm = item.positionCm.map((value, axis) => value + offset[axis]); });
  const result = fitMapAlignment(actual, source), route = [[100,3300,1400,10400]], before = structuredClone(route);
  assert.equal(result.status, "verified"); assert.equal(result.method, "rigid");
  assert.deepEqual(alignedRoutePoints(route, result), [[100,1000,2000,3000]]); assert.deepEqual(route, before);
});

test("proper rigid orientation and translation also verify source root rotations", () => {
  const source = evidence(), actual = evidence(), offset = [4000,-7000,2300];
  // Recording world is a +90 degree rotation about Y of the source world.
  actual.landmarks.forEach(item => { const [x,y,z] = item.positionCm; item.positionCm = [z+offset[0],y+offset[1],-x+offset[2]];
    if (item.rotation) item.rotation = [0,Math.SQRT1_2,0,Math.SQRT1_2]; });
  const result = fitMapAlignment(actual, source);
  assert.equal(result.status, "verified"); assert.ok(result.maxErrorCm < 1e-6);
  assert.deepEqual(alignedRoutePoints([[0,7000,-5000,1300]], result), [[0,1000,2000,3000]]);
});

test("centimeter quantization is accepted but one displaced chapter, changed scaling and reflection are not", () => {
  const source = evidence(), rounded = evidence(); rounded.landmarks[0].positionCm[0]++;
  assert.equal(fitMapAlignment(rounded, source).status, "verified");
  const displaced = evidence(); displaced.landmarks[1].positionCm[0] += 500;
  assert.equal(fitMapAlignment(displaced, source).reason, "non-rigid-layout");
  const scaled = evidence(); scaled.landmarks[0].scale = [2,1,1];
  assert.equal(fitMapAlignment(scaled, source).reason, "root-transform-mismatch");
  const reflection = evidence(); reflection.landmarks.forEach(item => { item.positionCm[0] *= -1; });
  assert.equal(fitMapAlignment(reflection, source).reason, "non-rigid-layout");
});

test("missing, repeated, collinear or narrowly clustered landmarks never prove alignment", () => {
  const source = evidence(), two = evidence(); two.landmarks = two.landmarks.slice(0,2);
  assert.equal(fitMapAlignment(two, source).reason, "insufficient-landmarks");
  const missing = evidence(); missing.landmarks.pop(); assert.equal(fitMapAlignment(missing, source).reason, "landmark-identity-mismatch");
  const wrong = evidence(); wrong.landmarks[0].name = "Different biome"; assert.equal(fitMapAlignment(wrong, source).reason, "landmark-identity-mismatch");
  const line = evidence(); line.landmarks.forEach((item, index) => { item.positionCm = [0,0,index * 2000]; });
  assert.equal(fitMapAlignment(line, line).reason, "landmarks-not-dispersed");
  const cluster = evidence(); cluster.landmarks.forEach((item, index) => { item.positionCm = [index*10,index*index,0]; });
  assert.equal(fitMapAlignment(cluster, cluster).reason, "landmarks-not-dispersed");
});
