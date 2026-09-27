import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { classifyRouteSegment, normalizeRoute, routeSegmentName } from "../src/map-route.js";

// Run the production navigation functions with small DOM/viewer ports, without
// booting the page, downloading assets or creating a WebGL context.
const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const names = ["asSegment", "segmentChineseBase", "segmentDisplayName", "collectSegmentOptions",
  "defaultSegment", "overviewSegmentOptions", "adjacentSegment", "renderSegmentNavigation",
  "populateSegmentControls", "chooseSegment", "syncSegmentToPlayback"];
function appFunction(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `app.js declares ${name}`);
  return match[0];
}
function node() {
  const classes = new Set();
  return {
    hidden: false, value: "", textContent: "", children: [],
    classList: { contains: (name) => classes.has(name), remove: (name) => classes.delete(name),
      add: (name) => classes.add(name), toggle: (name, active) => active ? classes.add(name) : classes.delete(name) },
    setAttribute() {}, replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
  };
}
function fixture(branch = "swamp-temple") {
  const finale = branch === "swamp-temple" ? "Swamp" : "Volcano";
  const ids = { Shore: 0, Roots: 7, Alpine: 2, Swamp: 8, Volcano: 3, Void: 17 };
  const layers = ["Shore", "Roots", "Alpine", finale, finale, "Void"].map((biome, segment) => ({
    segment, biome, biomeId: ids[biome], name: `${biome}_Segment`,
  }));
  const route = normalizeRoute({ branch, segments: layers.map((layer) => ({ ...layer, index: layer.segment })) });
  const state = {
    mapPack: { mapPackId: "map", gameBuildId: "25306743", layers }, usingCompatibleMap: true,
    routeView: { route, source: "map", hiddenSegments: new Set() },
    segmentOptions: [], segmentTimeline: [], selectedSegment: 4, segmentSelectionMode: "manual",
    segmentMapStatuses: new Map(), currentTime: 0, trace: null,
  };
  const elements = Object.fromEntries(["segmentNavigator", "segmentOrdinal", "segmentName", "segmentOriginalName",
    "routeSummary", "previousSegmentButton", "nextSegmentButton", "followSegmentButton", "segmentOverviewButton",
    "segmentLoadStatus", "layerSelect"].map((key) => [key, node()]));
  const selected = [];
  const ports = {
    state, elements, classifyRouteSegment, routeSegmentName, document: { createElement: node },
    viewer: { setActiveSegment: (segment) => selected.push(segment), setViewIntent() {} },
    segmentAtTime: () => state.segmentTimeline[0]?.segment ?? null,
    selectedSegmentStatus: () => ({ status: "ready", text: "已就绪" }),
    updateSceneMeta() {}, markSegmentTransition() {}, updateWorldTelemetry() {}, clearTimeout() {}, setTimeout() {},
  };
  const labels = source.match(/const SEGMENT_NAMES_ZH = new Map\(\[[^]*?\]\);/)[0];
  const api = new Function(...Object.keys(ports), `${labels}\nlet segmentNavLastName = null, segmentNavFlashTimer = 0;\n${names.map(appFunction).join("\n")}\nreturn { ${names.join(",")} };`)(...Object.values(ports));
  api.populateSegmentControls();
  return { api, state, elements, selected };
}

test("both verified branch finales identify their shared summit without creating a new layer", () => {
  for (const [branch, expected] of [["swamp-temple", "城塞 · 含顶峰"], ["volcano-kiln", "熔炉 · 含顶峰"]]) {
    const f = fixture(branch);
    assert.equal(f.elements.segmentName.textContent, expected);
    assert.equal(f.elements.segmentOrdinal.textContent, "第 5 / 5 关");
    assert.deepEqual(f.state.segmentOptions.map((entry) => entry.segment), [0, 1, 2, 3, 4, 5]);
    assert.equal(f.elements.nextSegmentButton.disabled, false);
    assert.equal(f.elements.nextSegmentButton.title, "浏览额外区域：天底（并非固定下一关）");
    assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 4, 1).segment, 5);
  }
});

test("future or missing build evidence does not extend the verified shared-summit mapping", () => {
  for (const gameBuildId of ["999", undefined]) {
    const f = fixture();
    f.state.mapPack.gameBuildId = gameBuildId;
    f.api.renderSegmentNavigation();
    assert.equal(f.elements.segmentName.textContent, "城塞");
  }
});

test("recorded route uses its recording build, independently of the loaded map build", () => {
  const f = fixture();
  f.state.routeView.source = "recorded";
  f.state.trace = { manifest: { gameBuildId: "999" } };
  f.api.renderSegmentNavigation();
  assert.equal(f.elements.segmentName.textContent, "城塞");
  f.state.trace.manifest.gameBuildId = "25306743";
  f.state.mapPack.gameBuildId = "999";
  f.api.renderSegmentNavigation();
  assert.equal(f.elements.segmentName.textContent, "城塞 · 含顶峰");
});

test("Nadir can be selected and navigated back from while staying outside the mountain overview", () => {
  const f = fixture();
  f.api.chooseSegment(5, "manual");
  assert.deepEqual(f.selected, [5]);
  assert.equal(f.elements.segmentName.textContent, "天底");
  assert.equal(f.elements.segmentOrdinal.textContent, "额外区域 · 天底");
  assert.equal(f.elements.previousSegmentButton.disabled, false);
  assert.equal(f.elements.nextSegmentButton.disabled, true);
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 5, -1).segment, 4);
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 5, 1), undefined);
  assert.deepEqual(f.api.overviewSegmentOptions().map((entry) => entry.segment), [0, 1, 2, 3, 4]);
  assert.match(f.elements.layerSelect.children.find((option) => option.value === "5").textContent, /^额外区域 · 天底/);
});

test("automatic selection follows recorded Nadir data and does not infer arrival from the route", () => {
  const f = fixture();
  f.state.segmentSelectionMode = "auto";
  f.state.segmentTimeline = [{ t: 0, segment: 4 }];
  f.api.syncSegmentToPlayback();
  assert.equal(f.state.selectedSegment, 4);
  f.state.segmentTimeline = [{ t: 0, segment: 5 }];
  f.api.syncSegmentToPlayback();
  assert.equal(f.state.selectedSegment, 5);
  assert.equal(f.elements.segmentName.textContent, "天底");
});

test("extra-area classification uses actual biomes and keeps chapter ordinals correct at any array position", () => {
  const f = fixture();
  f.state.routeView.route = null;
  f.state.mapPack.layers = [
    { segment: 0, biome: "Void", biomeId: 17, name: "Void" },
    { segment: 5, biome: "Shore", biomeId: 0, name: "Shore" },
    { segment: 6, biome: "Roots", biomeId: 7, name: "Roots" },
  ];
  f.state.selectedSegment = 5;
  f.api.populateSegmentControls();
  assert.deepEqual(f.state.segmentOptions.map((entry) => entry.isVoid), [true, false, false]);
  assert.match(f.elements.layerSelect.children[2].textContent, /^第 1 关 · 海岸/);
  assert.equal(f.elements.segmentOrdinal.textContent, "第 1 / 2 关");
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 6, 1).segment, 0);
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 0, -1).segment, 6);
});

test("unknown branch and contradictory biome metadata do not claim a summit or Nadir", () => {
  const f = fixture();
  f.state.routeView.route = normalizeRoute({ segments: [{ index: 4, biome: "Swamp", biomeId: 3, name: "Unknown" }] });
  assert.equal(f.api.segmentChineseBase({ segment: 4, biome: "Swamp" }), "第五关（分支未确认）");
  f.state.routeView.route = null;
  f.state.mapPack.layers = [{ segment: 5, biome: "Void", biomeId: 5, name: "Unknown" }];
  f.api.populateSegmentControls();
  assert.equal(f.state.segmentOptions[0].isVoid, false);
  assert.doesNotMatch(f.elements.segmentName.textContent, /天底|顶峰/);
});

test("overview previous/next return to mountain endpoints and empty navigation stays empty", () => {
  const f = fixture();
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, null, -1).segment, 4);
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, null, 1).segment, 0);
  assert.equal(f.api.adjacentSegment(f.state.segmentOptions, 0, -1), undefined);
  assert.equal(f.api.adjacentSegment([], null, 1), undefined);
});
