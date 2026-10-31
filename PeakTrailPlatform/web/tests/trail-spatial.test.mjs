import assert from "node:assert/strict";
import test from "node:test";
import { clipTrailSegment, pointInBounds, markerInDisplayBounds } from "../src/trail-spatial.js";

const bounds = { min: [0, 10, 20], max: [10, 20, 30] };
const point = (pos, t = 0, extra = {}) => ({ pos, t, ...extra });

test("native campfire handoff retains the team's actual marker outside the next mesh", () => {
  const nextChapter = { min: [-253.1417, 130.7132, 104.3791], max: [255.1493, 589.4510, 612.6702] };
  const atFire = point([-9.35997, 285.80337, 100.15952], 118, { segment: null, activeSegment: 1 });
  const before = JSON.stringify(atFire);
  assert.equal(pointInBounds(atFire.pos, nextChapter), false);
  assert.equal(markerInDisplayBounds(atFire, nextChapter, 1), true);
  assert.equal(markerInDisplayBounds(atFire, nextChapter, 2), false);
  assert.equal(JSON.stringify(atFire), before, "display must not move the recorded player");
  assert.equal(clipTrailSegment(atFire, { ...atFire, t: 119, pos: [-8, 285, 101] }, nextChapter), null,
    "current-team markers must not disable trail clipping");
});

test("marker handoff does not override explicit player chapters or unknown legacy samples", () => {
  const outside = point([-5, 15, 25], 0, { activeSegment: 1 });
  assert.equal(markerInDisplayBounds({ ...outside, segment: 0 }, bounds, 1), false);
  assert.equal(markerInDisplayBounds({ ...outside, activeSegment: null }, bounds, 1), false);
  assert.equal(markerInDisplayBounds(point([5, 15, 25]), bounds, 1), true);
  assert.equal(markerInDisplayBounds(outside, null, null), true);
  assert.equal(markerInDisplayBounds({ ...outside, pos: [NaN, 0, 0] }, bounds, 1), false);
  assert.equal(markerInDisplayBounds(outside, {}, 1), false);
});

test("point selection uses actual XYZ on all axes with inclusive boundaries", () => {
  assert.equal(pointInBounds([5, 15, 25], bounds), true);
  assert.equal(pointInBounds(bounds.min, bounds), true);
  assert.equal(pointInBounds(bounds.max, bounds), true);
  for (const pos of [[-1, 15, 25], [5, 21, 25], [5, 15, 31]]) assert.equal(pointInBounds(pos, bounds), false);
  assert.equal(pointInBounds([5, 15, 25], { minX: 0, maxX: 10, minY: 10, maxY: 20, minZ: 20, maxZ: 30 }), true);
});

test("an interior edge keeps exact observed coordinates and timestamps", () => {
  const result = clipTrailSegment(point([1, 12, 23], 3), point([8, 17, 29], 4), bounds);
  assert.deepEqual(result, { startPos: [1, 12, 23], endPos: [8, 17, 29], startT: 3, endT: 4, visibleAt: 4 });
});

test("entering edge is clipped spatially with interpolated entry time", () => {
  const result = clipTrailSegment(point([-5, 15, 25], 10), point([5, 15, 25], 12), bounds);
  assert.deepEqual(result, { startPos: [0, 15, 25], endPos: [5, 15, 25], startT: 11, endT: 12, visibleAt: 12 });
});

test("exiting edge retains original end time for conservative playback visibility", () => {
  const result = clipTrailSegment(point([5, 15, 25], 10), point([15, 15, 25], 12), bounds);
  assert.deepEqual(result, { startPos: [5, 15, 25], endPos: [10, 15, 25], startT: 10, endT: 11, visibleAt: 12 });
  assert.ok(result.visibleAt > result.endT, "clipped geometry must not suddenly appear ahead of the recorded ending sample");
});

test("outside-to-outside crossing keeps only the exact in-box portion", () => {
  const result = clipTrailSegment(point([-5, 15, 25], 0), point([15, 15, 25], 4), bounds);
  assert.deepEqual(result, { startPos: [0, 15, 25], endPos: [10, 15, 25], startT: 1, endT: 3, visibleAt: 4 });
});

test("three-dimensional diagonal clipping uses one consistent interpolation fraction", () => {
  const result = clipTrailSegment(point([-5, 5, 15], 10), point([15, 25, 35], 30), bounds);
  assert.deepEqual(result, { startPos: [0, 10, 20], endPos: [10, 20, 30], startT: 15, endT: 25, visibleAt: 30 });
});

test("reverse direction and vertical edges preserve travel direction", () => {
  assert.deepEqual(clipTrailSegment(point([15, 15, 25], 0), point([-5, 15, 25], 4), bounds),
    { startPos: [10, 15, 25], endPos: [0, 15, 25], startT: 1, endT: 3, visibleAt: 4 });
  assert.deepEqual(clipTrailSegment(point([5, 5, 25], 0), point([5, 25, 25], 4), bounds),
    { startPos: [5, 10, 25], endPos: [5, 20, 25], startT: 1, endT: 3, visibleAt: 4 });
});

test("parallel outside, nonintersecting and zero-length edges are omitted", () => {
  for (const [start, end] of [[[11, 11, 21], [11, 19, 29]], [[-5, 15, 25], [-1, 15, 25]],
    [[5, 15, 25], [5, 15, 25]], [[-1, 11, 25], [1, 9, 25]]]) {
    assert.equal(clipTrailSegment(point(start, 0), point(end, 1), bounds), null);
  }
});

test("global progression and nullable chapter assignments never override spatial evidence", () => {
  const a = point([-5, 15, 25], 0, { segment: null, activeSegment: 0 });
  const b = point([15, 15, 25], 4, { segment: null, activeSegment: 4 });
  assert.deepEqual(clipTrailSegment(a, b, bounds),
    { startPos: [0, 15, 25], endPos: [10, 15, 25], startT: 1, endT: 3, visibleAt: 4 });
  assert.equal(clipTrailSegment(point([-5, 15, 25], 0, { segment: 4 }), point([-1, 15, 25], 1, { segment: 4 }), bounds), null);
});

test("spatial overlap is not misrepresented as exclusive chapter membership", () => {
  const overlap = { min: [5, 15, 25], max: [15, 25, 35] };
  const start = point([6, 16, 26], 1), end = point([9, 19, 29], 2);
  assert.ok(clipTrailSegment(start, end, bounds));
  assert.ok(clipTrailSegment(start, end, overlap));
  assert.equal(pointInBounds(start.pos, bounds), true);
  assert.equal(pointInBounds(start.pos, overlap), true);
});

test("unbounded overview preserves XYZ while malformed inputs fail closed", () => {
  const start = point([-5, 15, 25], 0), end = point([15, 15, 25], 1);
  assert.deepEqual(clipTrailSegment(start, end, null), { startPos: [-5, 15, 25], endPos: [15, 15, 25], startT: 0, endT: 1, visibleAt: 1 });
  assert.equal(pointInBounds(start.pos, null), true);
  for (const invalid of [{}, { min: [0, 0, 0], max: [NaN, 1, 1] }, { min: [10, 10, 10], max: [0, 0, 0] }]) {
    assert.equal(clipTrailSegment(start, end, invalid), null);
    assert.equal(pointInBounds(start.pos, invalid), false);
  }
  assert.equal(pointInBounds([NaN, 0, 0], null), false);
  assert.equal(clipTrailSegment(point([NaN, 0, 0], 0), end, null), null);
  assert.equal(clipTrailSegment(start, point([1, 2, 3], -1), bounds), null);
  assert.equal(clipTrailSegment(point([1, 2, 3], 2), point([2, 3, 4], 1), null), null);
});

test("clipping does not mutate samples or return aliased source coordinates", () => {
  const a = point([1, 12, 23], 1), b = point([5, 15, 25], 2);
  const before = JSON.stringify([a, b, bounds]);
  const result = clipTrailSegment(a, b, bounds);
  result.startPos[0] = 999;
  assert.equal(JSON.stringify([a, b, bounds]), before);
});
