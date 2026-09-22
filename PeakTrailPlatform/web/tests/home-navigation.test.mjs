import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildHomeDailyView } from "../src/home-daily.js";
import { assessCompatibility, isDailyMapFresh, ProtocolError, selectTraceMapPack } from "../src/protocol.js";

// Exercise the actual application transitions without starting the page, network,
// animation loop, or WebGL. Only DOM/IO boundaries are replaced with small ports.
const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
function appFunction(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `app.js still declares ${name}`);
  return match[0];
}
const names = [
  "openHomeChapter", "enterModeFromGate", "resetSegmentNavigation", "populateSegmentControls",
  "syncSegmentToPlayback", "setSourceMode", "disconnectLive", "selectTraceSession", "syncMapForTrace", "openLiveStream",
];
const now = Date.parse("2026-09-22T02:00:00.000Z");
const todayId = `sha256-${"a".repeat(64)}`;
const archiveId = `sha256-${"b".repeat(64)}`;
const build = "25306743";
function makeMap(id = todayId, gameBuildId = build) {
  const biomes = ["Shore", "Roots", "Alpine", "Swamp", "Swamp"];
  const biomeIds = { Shore: 0, Roots: 7, Alpine: 2, Swamp: 8 };
  return {
    schemaVersion: 1, identityVersion: 3, mapPackId: id, sceneName: "Level_3", mapSlot: 3,
    gameBuildId, gameVersion: "2.4.c", coordinateSpace: "unity-world-meters", projectionVersion: 1,
    route: { authority: "serialized-map-handler", branch: "swamp-temple", segments: biomes.map((biome, index) => ({ index, biome, biomeId: biomeIds[biome], name: `${biome}_Segment` })) },
    layers: biomes.map((biome, segment) => ({ id: `segment-${segment}`, segment, biome, name: biome })),
    disposed: 0, disposeAssets() { this.disposed++; },
  };
}
function node() {
  const classes = new Set();
  return {
    hidden: false, value: "", textContent: "", children: [], attributes: {},
    classList: { remove: (name) => classes.delete(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); },
  };
}
function fixture() {
  const today = makeMap();
  // A historical game build with the SAME slot must not be laid on today's map.
  const archivedMap = makeMap(archiveId, "24000000");
  const trace = {
    manifest: { ...archivedMap, sessionId: "local-second-session" },
    events: [], tracks: new Map(), participants: [], warnings: [],
  };
  delete trace.manifest.layers;
  delete trace.manifest.route;
  delete trace.manifest.disposeAssets;
  const firstTrace = { ...trace, manifest: { ...trace.manifest, sessionId: "local-first-session" } };
  const archive = { sessions: [firstTrace, trace], days: [{ date: "2026-09-20", sessions: [firstTrace, trace] }], warnings: [] };
  const catalog = { schemaVersion: 1, activeGameBuildId: build, mapPacks: [today, archivedMap].map((map) => ({
    mapPackId: map.mapPackId, identityVersion: 3, sceneName: map.sceneName, mapSlot: map.mapSlot,
    gameBuildId: map.gameBuildId, projectionVersion: 1, enabled: true, path: `./packs/${map.mapPackId}/map-pack.json`,
  })) };
  const state = {
    daily: { schemaVersion: 1, versionOkay: true, levelIndex: 465, mapCount: 21, mapSlot: 3, sceneName: "Level_3", fetchedAtUtc: "2026-09-21T17:01:00.000Z", nextChangeAtUtc: "2026-09-22T17:00:00.000Z" },
    mapCatalog: catalog, trace, traceCollection: archive, replayCollection: archive,
    mapPack: archivedMap, mapSourceKind: "archive", sourceLoadingCounts: { trace: 0, map: 0 }, manualMapLoads: 0,
    traceSelectionRevision: 3, mapRequestRevision: 7, currentTime: 42, lastEventTime: 41,
    selectedSegment: 2, segmentSelectionMode: "auto", segmentTimeline: [{ t: 0, segment: 2 }],
    segmentMapStatuses: new Map([["2", { status: "ready" }]]), segmentOptions: [], toastTimer: 77, playing: true,
    live: { es: null, code: null, trace: null, timer: 0, demoTimer: 0, pollTimer: 0, dirty: false, lastSeq: 0, reconnectAttempts: 0 },
  };
  const elements = Object.fromEntries(["liveStateRow", "eventToast", "modeReplay", "modeLive", "replaySource", "liveSource", "modeChip", "liveUrl", "layerSelect", "homeEvidence"].map((key) => [key, node()]));
  const calls = { renders: [], assets: [], urls: [], clearedIntervals: [], errors: [], loading: [], statuses: [], compatibility: [], archive: 0, dismissed: 0, daily: 0, liveRefreshes: 0, attached: 0 };
  const streams = [];
  class FakeEventSource {
    static CLOSED = 2;
    constructor(url) { this.url = url; this.listeners = new Map(); this.readyState = 1; this.closed = false; streams.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.closed = true; }
  }
  let api;
  const ports = {
    state, elements, $: (id) => elements[id], document: { createElement: node }, URL, EventSource: FakeEventSource,
    buildHomeDailyView: (input) => buildHomeDailyView({ ...input, now }),
    assessCompatibility, selectTraceMapPack, ProtocolError,
    isDailyMapFresh: (daily) => isDailyMapFresh(daily, now),
    buildSegmentTimeline: (selected) => selected ? [{ t: 0, segment: 2 }] : [],
    collectSegmentOptions: () => state.mapPack?.layers || [],
    defaultSegment: () => state.segmentTimeline[0]?.segment ?? 0,
    segmentDisplayName: (option) => option.biome, renderSegmentNavigation() {},
    chooseSegment: (segment, mode) => { state.selectedSegment = segment; state.segmentSelectionMode = mode; },
    setPlaying: (playing) => { state.playing = playing; },
    clearTimeout() {}, clearInterval: (id) => calls.clearedIntervals.push(id),
    setInterval: () => 901, setTimeout: () => 902,
    syncWakeLock() {}, defaultRelayUrl: () => "https://relay.invalid",
    refreshLiveRuns: () => { calls.liveRefreshes++; },
    dismissGate: () => { calls.dismissed++; },
    syncGameAssetsForTrace: (selected, revision) => calls.assets.push({ trace: selected, revision }),
    renderData: async () => { api.populateSegmentControls(); calls.renders.push({ trace: state.trace, map: state.mapPack, segment: state.selectedSegment }); },
    updateTraceUI() {}, updateMapUI() {}, updateCompatibilityUI: (showMismatch) => calls.compatibility.push(showMismatch),
    populateTraceArchive: () => { calls.archive++; },
    syncDailyMap: async () => { calls.daily++; },
    ensureMapCatalog: async () => ({ catalog: state.mapCatalog, baseUrl: "https://site.invalid/data/maps/catalog.json" }),
    loadMapPackUrl: async (url) => { calls.urls.push(url); return archivedMap; },
    setSourceLoading: (kind, active) => calls.loading.push({ kind, active }),
    clearAutomaticMap: async () => { state.mapPack = null; state.mapSourceKind = null; },
    describeError: (error) => ({ title: "error", message: error.message }),
    showError: (...args) => calls.errors.push(args),
    setLiveStatus: (status) => calls.statuses.push(status),
    createLiveTrace: () => ({ manifest: { sessionId: "live-new" }, warnings: [] }),
    attachLiveTrace: () => { calls.attached++; },
    appendLiveRecord: () => true, liveWatchdog() {}, liveFlush() {}, performance: { now: () => 0 },
  };
  api = new Function(...Object.keys(ports), `${names.map(appFunction).join("\n")}\nreturn { ${names.join(",")} };`)(...Object.values(ports));
  const view = (map = today) => buildHomeDailyView({ daily: state.daily, catalog, mapPack: map, now });
  return { api, state, elements, calls, streams, today, archivedMap, trace, archive, view };
}

test("opening a home chapter retains the local archive but removes old-build tracks before rendering", async () => {
  const f = fixture();
  await f.api.openHomeChapter(f.today, 3, f.view());
  assert.equal(f.state.trace, null);
  assert.equal(f.state.traceCollection, f.archive);
  assert.equal(f.state.replayCollection, f.archive);
  assert.equal(f.state.lastReplaySessionId, f.trace.manifest.sessionId);
  assert.equal(f.state.mapPack, f.today);
  assert.equal(f.state.mapSourceKind, "daily");
  assert.equal(f.state.currentTime, 0);
  assert.equal(f.state.lastEventTime, -1);
  assert.equal(f.state.playing, false);
  assert.equal(f.state.traceSelectionRevision, 4);
  assert.equal(f.state.mapRequestRevision, 8);
  assert.deepEqual(f.state.segmentTimeline, []);
  assert.equal(f.state.segmentMapStatuses.size, 0);
  assert.deepEqual(f.calls.renders, [{ trace: null, map: f.today, segment: 3 }]);
  assert.deepEqual(f.calls.assets, [{ trace: null, revision: 4 }]);
  assert.equal(f.archivedMap.disposed, 1);
  assert.equal(f.today.disposed, 0);
  assert.deepEqual(f.calls.errors, []);
});

test("manual home chapter survives rebuilding controls and playback sync without jumping to Shore", async () => {
  const f = fixture();
  await f.api.openHomeChapter(f.today, 2, f.view());
  f.api.populateSegmentControls();
  f.api.syncSegmentToPlayback();
  assert.equal(f.state.selectedSegment, 2);
  assert.equal(f.state.segmentSelectionMode, "manual");
  assert.equal(f.elements.layerSelect.children.length, 6);
});

test("directory import and manual map import each block home navigation without changing current data", async () => {
  for (const importing of ["trace", "map"]) {
    const f = fixture();
    if (importing === "trace") f.state.sourceLoadingCounts.trace = 1;
    else f.state.manualMapLoads = 1;
    await f.api.openHomeChapter(f.today, 1, f.view());
    assert.equal(f.state.trace, f.trace);
    assert.equal(f.state.mapPack, f.archivedMap);
    assert.equal(f.state.traceSelectionRevision, 3);
    assert.equal(f.state.mapRequestRevision, 7);
    assert.equal(f.calls.dismissed, 0);
    assert.equal(f.calls.renders.length, 0);
    assert.match(f.elements.homeEvidence.textContent, /正在读取文件/);
  }
});

test("wrong map identity, stale presented identity and nonexistent chapters cannot replace a replay", async () => {
  for (const mutation of [{ gameBuildId: "999" }, { sceneName: "Level_4" }, { mapSlot: 4 }, { mapPackId: archiveId }]) {
    const f = fixture();
    await f.api.openHomeChapter({ ...f.today, ...mutation }, 1, f.view());
    assert.equal(f.state.trace, f.trace, JSON.stringify(mutation));
    assert.equal(f.state.mapPack, f.archivedMap);
    assert.equal(f.calls.renders.length, 0);
  }
  for (const [segment, presentedId] of [[1, archiveId], [-1, todayId], [5, todayId]]) {
    const f = fixture();
    await f.api.openHomeChapter(f.today, segment, { ...f.view(), mapEntry: { mapPackId: presentedId } });
    assert.equal(f.state.trace, f.trace);
    assert.equal(f.calls.renders.length, 0);
  }
});

test("expired daily observation is explored only as an explicitly historical map", async () => {
  const f = fixture();
  f.state.daily = { ...f.state.daily, fetchedAtUtc: "2026-09-20T17:01:00.000Z", nextChangeAtUtc: "2026-09-21T17:00:00.000Z" };
  await f.api.openHomeChapter(f.today, 3, f.view());
  assert.equal(f.state.mapSourceKind, "archive");
  assert.equal(f.state.trace, null);
  assert.equal(f.state.selectedSegment, 3);
});

test("opening home exits SSE/demo sessions and polling without losing the imported archive", async () => {
  const f = fixture();
  f.api.openLiveStream("https://relay.invalid", "LIVE");
  const stream = f.streams[0];
  const liveTrace = { manifest: { sessionId: "live-not-an-archive" } };
  Object.assign(f.state.live, { code: "LIVE", trace: liveTrace, demoTimer: 71, pollTimer: 72, dirty: true, lastSeq: 99, reconnectAttempts: 2 });
  f.state.trace = liveTrace;
  f.state.traceCollection = { sessions: [liveTrace], days: [] };
  f.state.lastReplaySessionId = f.trace.manifest.sessionId;
  await f.api.openHomeChapter(f.today, 1, f.view());
  assert.equal(stream.closed, true);
  for (const key of ["es", "code", "trace"]) assert.equal(f.state.live[key], null);
  for (const key of ["timer", "demoTimer", "pollTimer", "lastSeq", "reconnectAttempts"]) assert.equal(f.state.live[key], 0);
  assert.equal(f.state.live.dirty, false);
  assert.deepEqual(f.calls.clearedIntervals, [901, 71, 72]);
  assert.equal(f.state.traceCollection, f.archive);
  assert.equal(f.state.lastReplaySessionId, f.trace.manifest.sessionId);
  assert.equal(f.elements.liveStateRow.hidden, true);
  assert.equal(f.elements.liveSource.hidden, true);
  assert.equal(f.elements.replaySource.hidden, false);
});

test("replay entry restores the remembered archive session and loads its exact old build, not today's same slot", async () => {
  const f = fixture();
  await f.api.openHomeChapter(f.today, 3, f.view());
  await f.api.enterModeFromGate("replay");
  assert.equal(f.state.traceCollection, f.archive);
  assert.equal(f.state.trace, f.trace);
  assert.equal(f.state.mapPack, f.archivedMap);
  assert.equal(f.state.mapSourceKind, "archive");
  assert.equal(f.state.compatibility.compatible, true);
  assert.equal(f.state.mapPack.gameBuildId, f.trace.manifest.gameBuildId);
  assert.notEqual(f.state.mapPack.gameBuildId, f.today.gameBuildId);
  assert.deepEqual(f.calls.urls, [`https://site.invalid/data/maps/packs/${archiveId}/map-pack.json`]);
  assert.deepEqual(f.calls.loading, [{ kind: "map", active: true }, { kind: "map", active: false }]);
  assert.deepEqual(f.calls.renders.at(-1), { trace: f.trace, map: f.archivedMap, segment: 2 });
  assert.equal(f.calls.archive, 1);
  assert.equal(f.calls.daily, 0);
  assert.equal(f.calls.compatibility.at(-1), false);
  assert.deepEqual(f.calls.errors, []);
});

test("replay entry from a live demo restores the archive, falling back to its first session if none was remembered", async () => {
  const f = fixture();
  f.state.trace = { manifest: { sessionId: "demo-only" } };
  f.state.traceCollection = { sessions: [f.state.trace], days: [] };
  Object.assign(f.state.live, { demoTimer: 71, code: "DEMO", trace: f.state.trace });
  await f.api.enterModeFromGate("replay");
  assert.equal(f.state.traceCollection, f.archive);
  assert.equal(f.state.trace, f.archive.sessions[0]);
  assert.equal(f.state.live.demoTimer, 0);
  assert.equal(f.state.live.trace, null);
  assert.equal(f.state.lastReplaySessionId, f.archive.sessions[0].manifest.sessionId);
  assert.equal(f.calls.daily, 0);
});

test("missing historical build clears the automatic map rather than overlaying its log on today's geometry", async () => {
  const f = fixture();
  await f.api.openHomeChapter(f.today, 1, f.view());
  f.state.mapCatalog = { ...f.state.mapCatalog, mapPacks: f.state.mapCatalog.mapPacks.filter((entry) => entry.mapPackId !== archiveId) };
  await f.api.enterModeFromGate("replay");
  assert.equal(f.state.trace, f.trace);
  assert.equal(f.state.mapPack, null);
  assert.equal(f.state.compatibility.compatible, false);
  assert.match(f.state.dailyMapStatus.title, /尚无匹配底图/);
  assert.deepEqual(f.calls.urls, []);
  assert.equal(f.calls.renders.at(-1).map, null);
});

test("late open/ping/hello/record/error callbacks from a closed SSE cannot overwrite home or restart streaming", async () => {
  const f = fixture();
  f.api.openLiveStream("https://relay.invalid", "OLD");
  const old = f.streams[0];
  await f.api.openHomeChapter(f.today, 2, f.view());
  f.state.live.lastSseAt = 123;
  old.readyState = 2;
  const callsBefore = JSON.stringify(f.calls);
  old.onopen();
  old.listeners.get("ping")();
  // Invalid JSON deliberately proves the identity guard happens before parsing.
  old.listeners.get("hello")({ data: "must-not-parse" });
  old.listeners.get("record")({ data: "must-not-parse" });
  old.onerror();
  assert.equal(f.state.live.lastSseAt, 123);
  assert.equal(f.state.trace, null);
  assert.equal(f.state.traceCollection, f.archive);
  assert.equal(f.state.mapPack, f.today);
  assert.equal(f.state.live.reconnectAttempts, 0);
  assert.equal(f.streams.length, 1);
  assert.equal(JSON.stringify(f.calls), callsBefore);
});

test("SSE identity guards also reject replaced connections while accepting the current connection", () => {
  const f = fixture();
  f.api.openLiveStream("https://relay.invalid", "OLD");
  f.api.openLiveStream("https://relay.invalid", "NEW");
  f.streams[0].listeners.get("hello")({ data: "must-not-parse" });
  f.streams[1].listeners.get("hello")({ data: JSON.stringify({ manifest: {}, lastSeq: 0 }) });
  assert.equal(f.state.live.trace.manifest.sessionId, "live-new");
  assert.equal(f.state.traceCollection.sessions[0], f.state.live.trace);
  assert.equal(f.state.replayCollection, f.archive);
  assert.equal(f.calls.attached, 1);
});
