import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  heightBands, mapCompatibilityNote, mapGroupLabel, normalizeHeatmap, normalizeRouteGroups,
  normalizeRoutes, projectedHeatmap, projectPoint, routeEdges, viewBounds,
} from "../src/route-collection-model.js";
import { FEATURES, shouldPollLive } from "../src/features.js";

function route(points, breaks = []) { return normalizeRoutes({ routes: [{ id: "one", name: "Mylu", points, breaks }] }).routes[0]; }

test("live is hidden and cannot poll by default; explicitly reenabled mode retains the gate rule", () => {
  assert.equal(FEATURES.liveVisible, false);
  assert.equal(FEATURES.legacyReplayVisible, false);
  assert.equal(shouldPollLive({ pageOpen: true }), false);
  assert.equal(shouldPollLive({ visible: true, pageOpen: false }), false);
  assert.equal(shouldPollLive({ visible: true, pageOpen: true }), true);
});

test("live and demo controls remain hidden while community layers belong to the existing map view", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="gateLive"[^>]*\bhidden/);
  assert.match(html, /id="modeLive"[^>]*\bhidden/);
  assert.match(html, /id="gateReplay"[^>]*\bhidden\b[^>]*\bdisabled\b/);
  for (const id of ["mapInput", "traceInput", "traceFolderInput"]) {
    const input = html.match(new RegExp(`<input\\s[^>]*id="${id}"[^>]*>`))[0];
    assert.match(input, /\bhidden\b/);
    assert.match(input, /\bdisabled\b/);
  }
  assert.match(html, /id="importMenu"[^>]*\bhidden/);
  assert.match(html, /<details hidden><summary>开发工具/);
  assert.doesNotMatch(html, /href="\.\/routes\.html"/);
  assert.match(html, /id="communityMode"/);
  assert.match(html, /<option value="off">/);
  assert.match(html, /<option value="routes">大家的路线/);
  assert.match(html, /<option value="heatmap">热力图/);
  assert.match(html, /id="communityPanel"[^>]*\bhidden/);
  const stage = await readFile(new URL("../../tools/stage-site.mjs", import.meta.url), "utf8");
  assert.match(stage, /cp\(resolve\(webDirectory, "src"\),[^\n]*recursive: true/);
});

test("collection validates per-player integer centimeter coordinates without replacing or projecting them", () => {
  const points = [[0, -127, 6001, 102], [100, -120, 6002, 108]];
  const result = route(points);
  assert.deepEqual(result.points, points);
  assert.deepEqual(projectPoint(result.points[0], "xz"), [-1.27, 1.02]);
  assert.deepEqual(projectPoint(result.points[0], "xy"), [-1.27, 60.01]);
  for (const bad of [[[0, 1, NaN, 2]], [[0, 1, "2", 3]], [[-1, 1, 2, 3]], [[0, 1, 2, 3], [0, 4, 5, 6]], [[100, 1, 2, 3], [99, 4, 5, 6]]]) {
    assert.throws(() => route(bad), /时间或坐标/);
  }
  assert.throws(() => normalizeRoutes({ routes: [{ id: "same", points: [] }, { id: "same", points: [] }] }), /身份/);
});

test("route edges preserve break and missing-observation gaps, and clip by real altitude", () => {
  const result = route([[0, 0, -100, 0], [100, 100, 100, 0], [200, 200, 300, 0], [2100, 300, 400, 0], [2200, 400, 500, 0]], [200]);
  assert.equal(routeEdges(result).length, 2);
  const clipped = routeEdges(result, { band: 0 });
  assert.equal(clipped.length, 1);
  assert.deepEqual(clipped[0][0], [50, 50, 0, 0]);
  assert.deepEqual(clipped[0][1], [100, 100, 100, 0]);
  const negative = route([[0, 0, -150, 0], [100, 100, -50, 0]]);
  assert.equal(routeEdges(negative, { band: -1 }).length, 1);
  assert.equal(routeEdges(negative, { band: 0 }).length, 0);
});

test("2m cells keep height bands separate; projected overlaps use maximum rather than inflated sums", () => {
  const heatmap = normalizeHeatmap({ routeCount: 5, cellSizeCm: 200, heightBandCm: 200,
    cells: [[1, -1, 2, 2], [1, 0, 2, 3], [1, 0, 3, 4]] });
  assert.deepEqual(heightBands([], heatmap), [-1, 0]);
  assert.deepEqual(projectedHeatmap(heatmap, { band: -1 }), [{ x: 2, y: 4, width: 2, height: 2, count: 2 }]);
  assert.deepEqual(projectedHeatmap(heatmap), [
    { x: 2, y: 4, width: 2, height: 2, count: 3 }, { x: 2, y: 6, width: 2, height: 2, count: 4 },
  ]);
  assert.deepEqual(projectedHeatmap(heatmap, { projection: "xy", band: 0 }), [{ x: 2, y: 0, width: 2, height: 2, count: 4 }]);
  assert.throws(() => normalizeHeatmap({ ...heatmap, cells: [[1, 0, 2, 6]] }), /计数/);
  assert.throws(() => normalizeHeatmap({ ...heatmap, heightBandCm: 0 }), /精度/);
});

test("waiting-map and historical grouping are explicit, and a map group never derives from today", () => {
  const group = normalizeRouteGroups({ groups: [{ id: "historical", map: { scene: "Level_8", buildId: "25667990", levelIndex: 470, route: { branch: "swamp-temple" } }, stageSummaries: [{ index: 0, routeCount: 2 }] }] })[0];
  assert.equal(mapGroupLabel(group), "Level_8 · 轮换 470 · 雾沼 / 城塞 · 构建 25667990");
  assert.match(mapCompatibilityNote(group), /等待对应构建.*未叠加其他版本/);
  assert.match(mapCompatibilityNote({ mapCompatibility: "matched" }), /无底图坐标视图/);
  assert.deepEqual(viewBounds([]), { minX: -5, maxX: 5, minY: -5, maxY: 5 });
  const singleton = viewBounds([[12, -9]]);
  assert.ok(singleton.maxX > singleton.minX && singleton.maxY > singleton.minY);
});

test("player nickname is preserved as data, including HTML-shaped text", () => {
  const name = '<img src=x onerror="alert(1)">';
  const result = normalizeRoutes({ routes: [{ id: "one", name, points: [[0, 1, 2, 3], [100, 2, 3, 4]] }] });
  assert.equal(result.routes[0].name, name);
});
