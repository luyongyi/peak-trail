import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRoute, routeAtTime, routeSegmentName, resolveReplayRoute } from "../src/map-route.js";
import { loadTraceBundle } from "../src/protocol.js";

const route = (branch) => ({ authority: "maphandler-resolved-biomes", branch, segments: [
  { index: 0, biome: "Shore", biomeId: 0, name: "Beach_Segment" },
  ...[3, 4].map((index) => ({ index, biome: branch === "volcano-kiln" ? "Volcano" : "Swamp", biomeId: branch === "volcano-kiln" ? 3 : 8, name: "source-root" })),
] });
const volcano = route("volcano-kiln");
const swamp = route("swamp-temple");
const pack = { route: volcano, layers: volcano.segments.map((segment) => ({ segment: segment.index, biome: segment.biome })) };

test("both route pairs have distinct fourth and final chapter names, not duplicate biome labels", () => {
  assert.deepEqual([3, 4].map((index) => routeSegmentName(normalizeRoute(volcano), index)), ["火山", "熔炉"]);
  assert.deepEqual([3, 4].map((index) => routeSegmentName(normalizeRoute(swamp), index)), ["雾沼", "城塞"]);
  assert.equal(routeSegmentName(normalizeRoute(swamp), 1), null);
});

test("contradictory or malformed branch evidence is never promoted to a known route", () => {
  assert.equal(normalizeRoute({ ...volcano, branch: "swamp-temple" }).branch, "unknown");
  assert.equal(normalizeRoute({ ...volcano, branch: "unknown" }).branch, "unknown");
  assert.equal(normalizeRoute({ ...volcano, segments: volcano.segments.map((entry) => ({ ...entry, biomeId: 8 })) }).branch, "unknown");
  assert.equal(normalizeRoute({ ...volcano, segments: [volcano.segments[0], volcano.segments[0]] }), null);
  assert.equal(normalizeRoute(null), null);
});

test("legacy logs use matched map evidence with explicit provenance, not a fabricated DLL record", () => {
  const view = resolveReplayRoute(pack, { manifest: {} });
  assert.equal(view.route.branch, "volcano-kiln");
  assert.equal(view.source, "map");
  assert.match(view.message, /旧日志未记录/);
  assert.equal(resolveReplayRoute(null, { manifest: {} }).source, "unknown");
});

test("a recorded alternative hides both wrong ending geometries but preserves shared chapters", () => {
  const view = resolveReplayRoute(pack, { manifest: { route: swamp } });
  assert.equal(view.label, "雾沼 → 城塞");
  assert.deepEqual([...view.hiddenSegments], [3, 4]);
  assert.deepEqual(view.layers.map((layer) => layer.segment), [0]);
  assert.match(view.message, /已隐藏/);
});

test("scrubbing routes backwards cannot reuse a later or manifest-final branch", () => {
  const trace = { manifest: { route: swamp }, routeTracks: [{ t: 2, route: volcano }, { t: 10, route: swamp }] };
  assert.equal(routeAtTime(trace, 0), null);
  assert.equal(routeAtTime(trace, 2).branch, "volcano-kiln");
  assert.equal(routeAtTime(trace, 10).branch, "swamp-temple");
  assert.equal(resolveReplayRoute(pack, trace, 5).hiddenSegments.size, 0);
  assert.equal(resolveReplayRoute(pack, trace, 10).hiddenSegments.size, 2);
});

test("new DLL route records survive trace parsing and millisecond conversion", async () => {
  const manifest = { schemaVersion: 1, sessionId: "qa-route", sceneName: "Level_16", coordinateSpace: "unity-world-meters", timeUnit: "milliseconds", segmentResolution: "unassigned", route: volcano };
  const stream = [
    { type: "route", t: 0, route: volcano },
    { type: "sample", t: 0, playerId: "qa:route", pos: [0, 0, 0] },
    { type: "route", t: 2000, route: swamp },
    { type: "sample", t: 3000, playerId: "qa:route", pos: [1, 1, 1] },
  ];
  const file = (name, contents) => ({ name, text: async () => contents });
  const trace = await loadTraceBundle([file("manifest.json", JSON.stringify(manifest)), file("stream.ndjson", stream.map((row) => JSON.stringify(row)).join("\n"))]);
  assert.equal(trace.routeTracks[1].t, 2);
  assert.equal(routeAtTime(trace, 1).branch, "volcano-kiln");
  assert.equal(routeAtTime(trace, 2).branch, "swamp-temple");
  assert.equal(trace.manifest.route.branch, "volcano-kiln");
});
