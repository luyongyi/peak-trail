import test from "node:test";
import assert from "node:assert/strict";
import { measureAlignment } from "../check-trace-alignment.mjs";

test("alignment respects min-z/min-x rows, NaN holes and inclusive maximum", () => {
  const layer = { segment: 0, minX: 0, maxX: 2, minZ: 0, maxZ: 2, columns: 2, rows: 2, values: [10, NaN, 30, 40] };
  const result = measureAlignment([
    { pos: [0.5, 11, 0.5] }, { pos: [1.5, 20, 0.5] },
    { pos: [0.5, 31, 1.5] }, { pos: [2, 41, 2] }, { pos: [3, 1, 3] },
  ], [layer]);
  assert.equal(result.samples, 5);
  assert.equal(result.inBounds, 4);
  assert.equal(result.supported, 3);
  assert.equal(result.signedHeightDeltaMeters.median, 1);
});

test("overlapping segments resolve by XYZ, not global active segment", () => {
  const base = { minX: 0, maxX: 1, minZ: 0, maxZ: 1, columns: 2, rows: 2 };
  const result = measureAlignment([{ pos: [0.5, 21, 0.5], activeSegment: 0 }], [
    { ...base, segment: 0, values: [0, 0, 0, 0] },
    { ...base, segment: 1, values: [20, 20, 20, 20] },
  ]);
  assert.deepEqual(result.samplesPerNearestSegment, { 1: 1 });
});
