import assert from "node:assert/strict";
import test from "node:test";
import { positiveInstanceTransform } from "../src/geometry-matrices.js";

const determinant = (m) => m[0] * (m[5] * m[10] - m[9] * m[6])
  - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
const point = (m, p) => [0, 1, 2].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);

test("negative-scale and sheared instances factor into positive determinant instances without moving a vertex", () => {
  const matrices = [
    [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 17, -23, 41, 1],
    [2, 0, 0, 0, 1.5, -3, 0, 0, 0.2, 0.6, 4, 0, -17, 2, 41, 1],
    [0, -2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 0, 8, 0, 1],
  ];
  for (const input of matrices) {
    const before = [...input];
    const { reflected, matrix } = positiveInstanceTransform(input);
    assert.equal(reflected, true);
    assert.ok(determinant(input) < 0);
    assert.ok(determinant(matrix) > 0);
    for (const position of [[0, 0, 0], [1, 2, 3], [-7, 0.25, 9]]) {
      const local = point(matrix, position);
      const world = [-local[0], local[1], local[2]];
      const expected = point(input, position);
      world.forEach((value, index) => assert.equal(Math.abs(value - expected[index]), 0));
    }
    assert.deepEqual(input, before);
  }
});

test("positive-determinant instances preserve every serialized matrix element", () => {
  const input = [2, 0, 0, 0, 0.75, 3, 0, 0, 0.2, 0.6, 4, 0, 17, 2, 41, 1];
  assert.deepEqual(positiveInstanceTransform(input), { reflected: false, matrix: input });
  assert.throws(() => positiveInstanceTransform([1, 2, 3]), /Invalid/);
});
