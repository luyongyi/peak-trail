import assert from "node:assert/strict";
import test from "node:test";
import { layoutPortraitLabels } from "../src/portrait-layout.js";

const viewport = { width: 640, height: 480 };
function assertInside(placements, bounds = viewport) {
  for (const item of placements) {
    assert.ok(item.left >= 0 && item.top >= 0);
    assert.ok(item.left + item.width <= bounds.width);
    assert.ok(item.top + item.height <= bounds.height);
  }
}
function assertSeparated(placements) {
  for (let i = 0; i < placements.length; i++) for (let j = i + 1; j < placements.length; j++) {
    const a = placements[i];
    const b = placements[j];
    assert.ok(a.left + a.width <= b.left || b.left + b.width <= a.left
      || a.top + a.height <= b.top || b.top + b.height <= a.top, `${a.id} overlaps ${b.id}`);
  }
}

test("four coincident player heads separate gently while keeping their real anchors", () => {
  const anchors = ["d", "b", "a", "c"].map((id) => ({ id, x: 320, y: 240, width: 72, height: 64 }));
  const result = layoutPortraitLabels(anchors, viewport);
  assert.deepEqual(result.map((entry) => entry.id), ["a", "b", "c", "d"]);
  assertSeparated(result);
  assertInside(result);
  for (const item of result) {
    assert.equal(item.anchorX, 320);
    assert.equal(item.anchorY, 240);
    assert.ok(Math.abs(item.left + item.width / 2 - 320) <= 160);
    assert.ok(Math.abs(item.top + item.height + 8 - 240) <= 80);
  }
  assert.deepEqual(layoutPortraitLabels([...anchors].reverse(), viewport), result);
});

test("labels near every viewport corner remain visible and non-overlapping", () => {
  for (const [x, y] of [[0, 0], [640, 0], [0, 480], [640, 480]]) {
    const anchors = ["1", "2", "3", "4"].map((id) => ({ id, x, y, width: 120, height: 60 }));
    const result = layoutPortraitLabels(anchors, viewport);
    assertSeparated(result);
    assertInside(result);
    assert.ok(result.every((item) => item.anchorX === x && item.anchorY === y));
  }
});

test("separated labels retain their natural above-player position", () => {
  const result = layoutPortraitLabels([
    { id: "left", x: 100, y: 200, width: 50, height: 60 },
    { id: "right", x: 500, y: 200, width: 50, height: 60 },
  ], viewport);
  assert.deepEqual(result.map(({ left, top }) => ({ left, top })), [{ left: 75, top: 132 }, { left: 475, top: 132 }]);
});

test("mixed label sizes and small viewports never produce offscreen or nonfinite boxes", () => {
  const narrow = { width: 240, height: 180 };
  const anchors = [
    { id: "a", x: 110, y: 120, width: 110, height: 60 },
    { id: "b", x: 111, y: 121, width: 60, height: 68 },
    { id: "c", x: 112, y: 122, width: 80, height: 50 },
    { id: "d", x: 113, y: 123, width: 54, height: 64 },
  ];
  const result = layoutPortraitLabels(anchors, narrow);
  assertInside(result, narrow);
  assertSeparated(result);
  const tiny = layoutPortraitLabels(anchors, { width: 20, height: 20 });
  assertInside(tiny, { width: 20, height: 20 });
  assert.deepEqual(layoutPortraitLabels([], viewport), []);
});
