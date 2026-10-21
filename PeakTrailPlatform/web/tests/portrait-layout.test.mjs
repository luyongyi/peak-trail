import assert from "node:assert/strict";
import test from "node:test";
import { layoutPortraitLabels, clusterPlayerEntries, GROUP_RADIUS_METERS, portraitScreenSize } from "../src/portrait-layout.js";

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

test("players within the group radius merge into one cluster, farther ones stay apart", () => {
  assert.equal(GROUP_RADIUS_METERS, 4);
  const clusters = clusterPlayerEntries([
    { id: "near-a", pos: [0, 10, 0] },
    { id: "near-b", pos: [3, 10, 1] },
    { id: "far", pos: [0, 10, 40] },
  ]);
  assert.equal(clusters.length, 2);
  const near = clusters.find((cluster) => cluster.length === 2);
  assert.deepEqual(near.map((entry) => entry.id).sort(), ["near-a", "near-b"]);
  assert.deepEqual(clusters.find((cluster) => cluster.length === 1).map((entry) => entry.id), ["far"]);
});

test("a chain cannot merge players beyond the group's real diameter, regardless of input order", () => {
  const entries = [
    { id: "a", pos: [0, 0, 0] },
    { id: "b", pos: [3, 0, 0] },
    { id: "c", pos: [6, 0, 0] },
  ];
  const clusters = clusterPlayerEntries(entries);
  assert.deepEqual(clusters.map(group => group.map(entry => entry.id)), [["a", "b"], ["c"]]);
  assert.deepEqual(clusterPlayerEntries([...entries].reverse()), clusters);
});

test("players just beyond the radius and boundary coordinates stay ungrouped", () => {
  const clusters = clusterPlayerEntries([
    { id: "a", pos: [0, 0, 0] },
    { id: "b", pos: [10.1, 0, 0] },
    { id: "c", pos: [25.5, 0, 0] },
    { id: "d", pos: [40, 0, 0] },
  ], 10);
  assert.ok(clusters.every((cluster) => cluster.length === 1));
  const exact = clusterPlayerEntries([
    { id: "a", pos: [0, 0, 0] },
    { id: "b", pos: [0, 0, 10] },
  ], 10);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].length, 2);
});

test("entries without a finite world position keep their own cluster", () => {
  const clusters = clusterPlayerEntries([
    { id: "ok", pos: [0, 0, 0] },
    { id: "broken", pos: [0, 0, 2] },
    { id: "nan", pos: [Number.NaN, 0, 0] },
    { id: "short", pos: [1, 2] },
    { id: "none" },
  ]);
  const sizes = clusters.map((cluster) => cluster.length).sort((a, b) => b - a);
  assert.deepEqual(sizes, [2, 1, 1, 1]);
  assert.equal(clusters.flat().length, 5);
  assert.deepEqual(clusterPlayerEntries([]), []);
});

test("zoom separates close players when their portraits no longer overlap", () => {
  const entries = [
    { id: "a", pos: [0, 0, 0], x: 200, y: 200, size: 14 },
    { id: "b", pos: [3, 0, 0], x: 210, y: 200, size: 14 },
  ];
  assert.equal(clusterPlayerEntries(entries).length, 1);
  assert.equal(clusterPlayerEntries([entries[0], { ...entries[1], x: 250, size: 32 }]).length, 2);
  assert.equal(clusterPlayerEntries([entries[0], { ...entries[1], pos: [0, 0, 30], x: 200 }]).length, 2,
    "aligned screen positions must never merge physically distant players");
});

test("portrait size follows projected distance and zoom within compact limits", () => {
  assert.equal(portraitScreenSize(10, 720), 32);
  assert.equal(portraitScreenSize(10000, 720), 14);
  const mid = portraitScreenSize(120, 720);
  assert.ok(mid > 14 && mid < 32);
  assert.ok(portraitScreenSize(100, 720) > mid);
  assert.ok(portraitScreenSize(120, 720, { zoom: 1.2 }) > mid);
  assert.ok(portraitScreenSize(120, 900) > mid);
  for (const depth of [null, NaN, Infinity, -1, 0]) assert.ok(Number.isFinite(portraitScreenSize(depth, NaN)));
});

test("bounded collision avoidance never pulls distant overlapping players away from their positions", () => {
  const anchors = ["a", "b", "c", "d"].map(id => ({ id, x: 320, y: 240, width: 14, height: 14 }));
  const result = layoutPortraitLabels(anchors, viewport, { gap: 4, anchorGap: 4, maxDisplacement: 20 });
  for (const item of result) assert.ok(Math.hypot(item.left - 313, item.top - 222) <= 20.000001);
  assertInside(result);
  const edge = layoutPortraitLabels(anchors.map(a => ({ ...a, x: 0, y: 0 })), viewport, { maxDisplacement: 20 });
  assertInside(edge);
});
