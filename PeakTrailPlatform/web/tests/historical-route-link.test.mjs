import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { historicalRouteTitle, historicalRouteUrl, loadHistoricalRouteLink, normalizeHistoricalInspection, parseHistoricalRouteLink } from "../src/historical-route-link.js";

const hash = character => character.repeat(64);
const packId = `sha256-${hash("a")}`;
const route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
function group(overrides = {}) {
  return { id: hash("b"), mapPackId: packId, mapCompatibility: "matched",
    mapAlignment: { status: "verified", id: hash("9"), method: "rigid", landmarkCount: 12, maxErrorCm: 2 },
    map: { scene: "Level_8", buildId: "25739797", levelIndex: 481, layoutKey: hash("c"), route,
      stages: route.map((name, index) => ({ index, name })) },
    stageSummaries: route.map((name, index) => ({ index, name, routeCount: index < 4 ? 2 : 0 })),
    firstStartedUtc: "2026-10-08T14:00:00Z", lastStartedUtc: "2026-10-08T15:00:00Z", ...overrides };
}
function map(overrides = {}) {
  return { mapPackId: packId, gameBuildId: "25739797", sceneName: "Level_8",
    route: { branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) },
    layers: route.map((_, segment) => ({ segment })), disposed: 0, disposeAssets() { this.disposed++; }, ...overrides };
}
function team(overrides = {}) {
  return { id: hash("d"), groupId: hash("b"), startedUtc: "2026-10-08T14:00:00Z", lastStartedUtc: "2026-10-08T15:00:00Z",
    map: { scene: "Level_8", buildId: "25739797", levelIndex: 481 }, mapPackId: packId, mapCompatibility: "matched",
    mapAlignment: group().mapAlignment, members: [{ playerKey: hash("1"), name: "Mylu" }],
    stageSummaries: route.map((name, index) => ({ index, name, memberCount: index <= 3 ? 1 : 0, completedCount: 0 })), ...overrides };
}
function fixture({ groups = [group()], loaded = map(), catalog = null, selectedTeam = team(), currentMapPack = null } = {}) {
  const calls = [];
  const exact = { identityVersion: 3, mapPackId: packId, gameBuildId: "25739797", sceneName: "Level_8", path: `./packs/${packId}/map-pack.json` };
  const ports = {
    readGroups: async () => { calls.push("groups"); return { groups }; },
    readCatalog: async () => { calls.push("catalog"); return { catalog: catalog || { schemaVersion: 1, activeGameBuildId: "30000000", mapPacks: [exact] }, baseUrl: "https://peak.mylus.cn/data/maps/catalog.json" }; },
    loadMapPack: async url => { calls.push(url); return loaded; },
    readTeam: async id => { calls.push(`team:${id}`); return { team: selectedTeam }; },
    currentMapPack,
  };
  return { calls, ports, loaded, exact };
}

test("ordinary homepage queries never opt into historical route navigation", () => {
  for (const value of ["", "?stage=3", "?mapPack=https://elsewhere.invalid/pack.json"]) assert.equal(parseHistoricalRouteLink(value), null);
  assert.deepEqual(parseHistoricalRouteLink(`?routeGroup=${hash("b")}&stage=3`), { groupId: hash("b"), stageIndex: 3 });
  assert.deepEqual(parseHistoricalRouteLink(`?routeGroup=${hash("b")}`), { groupId: hash("b"), stageIndex: null });
  for (const value of [`?routeGroup=today`, `?routeGroup=${hash("b")}&routeGroup=${hash("c")}`, `?routeGroup=${hash("b")}&stage=-1`,
    `?routeGroup=${hash("b")}&stage=3.0`, `?routeGroup=${hash("b")}&stage=3&stage=0`]) assert.throws(() => parseHistoricalRouteLink(value));
});

test("the public share URL carries only the exact group and chapter", () => {
  const link = historicalRouteUrl("https://peak.mylus.cn/?mapPack=old&adminToken=private&uploadToken=private#secret", hash("b"), 3);
  assert.equal(link, `https://peak.mylus.cn/?routeGroup=${hash("b")}&stage=3`);
  assert.throws(() => historicalRouteUrl("https://peak.mylus.cn/", "today", 3));
  const inspection = historicalRouteUrl("https://peak.mylus.cn/?privateToken=secret", hash("b"), 3, hash("d"));
  assert.equal(inspection, `https://peak.mylus.cn/?routeGroup=${hash("b")}&stage=3&inspection=${hash("d")}`);
  assert.deepEqual(parseHistoricalRouteLink(new URL(inspection).search), { groupId: hash("b"), stageIndex: 3, inspectionId: hash("d") });
  assert.throws(() => parseHistoricalRouteLink(`?routeGroup=${hash("b")}&inspection=private`));
  assert.throws(() => parseHistoricalRouteLink(`?routeGroup=${hash("b")}&inspection=${hash("d")}&inspection=${hash("e")}`));
});

test("team links share only public identifiers and reject conflicting, repeated and invalid selectors", () => {
  const url = historicalRouteUrl("https://peak.mylus.cn/?adminToken=private&inspection=old#secret", hash("b"), 3, null, hash("d"));
  assert.equal(url, `https://peak.mylus.cn/?routeGroup=${hash("b")}&stage=3&team=${hash("d")}`);
  assert.deepEqual(parseHistoricalRouteLink(new URL(url).search), { groupId: hash("b"), stageIndex: 3, teamId: hash("d") });
  assert.deepEqual(parseHistoricalRouteLink(`?routeGroup=${hash("b")}&team=${hash("d")}`), { groupId: hash("b"), stageIndex: null, teamId: hash("d") });
  for (const suffix of ["team=", "team=player-name", `team=${hash("d")}&team=${hash("e")}`,
    `team=${hash("d")}&inspection=${hash("e")}`]) assert.throws(() => parseHistoricalRouteLink(`?routeGroup=${hash("b")}&${suffix}`));
  assert.throws(() => historicalRouteUrl("https://peak.mylus.cn/", hash("b"), 3, null, "player-name"));
  assert.throws(() => historicalRouteUrl("https://peak.mylus.cn/", hash("b"), 3, hash("e"), hash("d")));
  assert.equal(historicalRouteUrl(url, hash("b"), 2), `https://peak.mylus.cn/?routeGroup=${hash("b")}&stage=2`,
    "clearing a selected team removes it from the share URL");
});

test("a team with only partial paths opens its latest observed chapter independently of public completion totals", async () => {
  const partial = group({ stageSummaries: group().stageSummaries.map(stage => ({ ...stage, routeCount: 0 })) });
  const selectedTeam = team({ stageSummaries: team().stageSummaries.map(stage => ({ ...stage, memberCount: 1 })) });
  const f = fixture({ groups: [partial], selectedTeam });
  const result = await loadHistoricalRouteLink({ groupId: hash("b"), teamId: hash("d"), stageIndex: null }, f.ports);
  assert.equal(result.stageIndex, 4);
  assert.equal(result.teamId, hash("d")); assert.equal(result.inspectionId, null);
  assert.match(result.title, /团队路线$/);
  assert.deepEqual(f.calls, ["groups", `team:${hash("d")}`, "catalog", `https://peak.mylus.cn/data/maps/packs/${packId}/map-pack.json`]);
});

test("a selected team must prove the requested public group and its original map identity", async () => {
  for (const changes of [{ id: hash("f") }, { groupId: hash("f") }, { mapPackId: `sha256-${hash("f")}` },
    { mapAlignment: { ...group().mapAlignment, id: hash("f") } },
    { mapCompatibility: "waiting-map" }, { map: { ...team().map, scene: "Level_9" } },
    { map: { ...team().map, buildId: "25306743" } }]) {
    const f = fixture({ selectedTeam: team(changes) });
    await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), teamId: hash("d"), stageIndex: 3 }, f.ports), /不属于/);
    assert.deepEqual(f.calls, ["groups", `team:${hash("d")}`], "a mismatched team cannot fetch or replace any model");
  }
  const absent = fixture({ selectedTeam: undefined });
  absent.ports.readTeam = async () => { throw new Error("HTTP 404"); };
  await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), teamId: hash("d"), stageIndex: 3 }, absent.ports), /404/);
});

test("a team on an already verified map reuses the current pack and never disposes or downloads it", async () => {
  const current = map();
  const f = fixture({ currentMapPack: current });
  const result = await loadHistoricalRouteLink({ groupId: hash("b"), teamId: hash("d"), stageIndex: 3 }, f.ports);
  assert.equal(result.mapPack, current); assert.equal(result.reusedMapPack, true); assert.equal(current.disposed, 0);
  assert.deepEqual(f.calls, ["groups", `team:${hash("d")}`, "catalog"]);
  const oldBuild = map({ gameBuildId: "25306743" });
  const other = fixture({ currentMapPack: oldBuild });
  const loaded = await loadHistoricalRouteLink({ groupId: hash("b"), teamId: hash("d"), stageIndex: 3 }, other.ports);
  assert.notEqual(loaded.mapPack, oldBuild); assert.equal(loaded.reusedMapPack, false);
  assert.equal(oldBuild.disposed, 0, "the resolver does not dispose the currently displayed pack");
  assert.equal(other.calls.length, 4, "same scene from another build is not reused");
});

test("inspection data proves both public identities and preserves partial paths and break timestamps", () => {
  const body = { inspection: true, excludedFromAggregation: true, groupId: hash("b"), uploadId: hash("d"), stageIndex: 3,
    mapPackId: packId, mapCompatibility: "matched", mapAlignment: group().mapAlignment, coordinateSpace: "canonical-map-world-cm",
    totalRouteCount: 1, routes: [{ id: "partial", name: "玩家", points: [[0, 0, 100, 0], [100, 0, 100, 100], [200, 8000, 200, 100]],
      breaks: [200], completion: "partial", completed: false }] };
  const result = normalizeHistoricalInspection(body, group(), map(), 3, hash("d"));
  assert.deepEqual(result.routes[0].points, body.routes[0].points); assert.deepEqual(result.routes[0].breaks, [200]);
  assert.equal(result.routes[0].completed, false); assert.equal(result.heatmap, null); assert.equal(result.inspectionLoaded, true);
  assert.equal(result.routes[0].gameCompleted, null, "older uploads with no native progress evidence remain unknown");
  for (const gameCompleted of [true, false, null]) {
    const normalized = normalizeHistoricalInspection({ ...body, routes: [{ ...body.routes[0], gameCompleted }] }, group(), map(), 3, hash("d"));
    assert.equal(normalized.routes[0].gameCompleted, gameCompleted);
    assert.equal(normalized.routes[0].completed, false, "native progress cannot change the continuous-route result");
    assert.deepEqual(normalized.routes[0].points, body.routes[0].points);
    assert.deepEqual(normalized.routes[0].breaks, [200]);
  }
  for (const gameCompleted of ["true", 1, {}, []]) {
    assert.throws(() => normalizeHistoricalInspection({ ...body, routes: [{ ...body.routes[0], gameCompleted }] }, group(), map(), 3, hash("d")), /完成状态/);
  }
  for (const changes of [{ uploadId: hash("e") }, { groupId: hash("f") }, { stageIndex: 2 }, { inspection: false }, { excludedFromAggregation: false },
    { coordinateSpace: "recording-world-cm" }, { mapAlignment: { ...body.mapAlignment, id: hash("8") } }, { mapPackId: `sha256-${hash("e")}` }]) {
    assert.throws(() => normalizeHistoricalInspection({ ...body, ...changes }, group(), map(), 3, hash("d")), /不一致/);
  }
  assert.throws(() => normalizeHistoricalInspection({ ...body, routes: [{ ...body.routes[0], completed: true }] }, group(), map(), 3, hash("d")), /完成状态/);
});

test("history labels use real server recording dates in Beijing, independent of today's date", () => {
  assert.equal(historicalRouteTitle(group()), "历史路线 · 2026-10-08 · 轮换 481");
  assert.equal(historicalRouteTitle(group({ firstStartedUtc: "2026-10-08T15:59:00Z", lastStartedUtc: "2026-10-08T16:01:00Z" })),
    "历史路线 · 2026-10-08 – 2026-10-09 · 轮换 481");
  assert.equal(historicalRouteTitle(group({ firstStartedUtc: undefined, lastStartedUtc: "invalid" })), "历史路线 · 轮换 481");
});

test("historical route lookup loads the recorded pack despite a different active game build", async () => {
  const f = fixture();
  const result = await loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, f.ports);
  assert.equal(result.group.id, hash("b")); assert.equal(result.stageIndex, 3); assert.equal(result.mapPack, f.loaded);
  assert.deepEqual(f.calls, ["groups", "catalog", `https://peak.mylus.cn/data/maps/packs/${packId}/map-pack.json`]);
  assert.equal(result.title, "历史路线 · 2026-10-08 · 轮换 481");
});

test("a missing stage chooses the latest actually completed chapter, not the unfinished terminal chapter", async () => {
  const f = fixture();
  assert.equal((await loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: null }, f.ports)).stageIndex, 3);
  const g = fixture();
  await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 9 }, g.ports), /没有这个关卡/);
  assert.deepEqual(g.calls, ["groups", "catalog"]);
});

test("absent, private or unaligned historical groups cannot borrow a different group or today's map", async () => {
  const absent = fixture({ groups: [group({ id: hash("d") })] });
  await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, absent.ports), /尚未公开/);
  assert.deepEqual(absent.calls, ["groups"]);
  const waiting = fixture({ groups: [group({ mapCompatibility: "waiting-map", mapPackId: null, mapAlignment: { status: "pending", reason: "recording-landmarks-missing" } })] });
  await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, waiting.ports), /地标/);
  assert.deepEqual(waiting.calls, ["groups"]);
});

test("only an exact catalog identity is accepted, including its build and scene", async () => {
  const f = fixture();
  for (const entry of [{ ...f.exact, mapPackId: `sha256-${hash("e")}`, supersedesMapPackIds: [packId], path: `./packs/sha256-${hash("e")}/map-pack.json` },
    { ...f.exact, gameBuildId: "25306743" }, { ...f.exact, sceneName: "Level_9" }, { ...f.exact, enabled: false }]) {
    const changed = fixture({ catalog: { schemaVersion: 1, activeGameBuildId: "30000000", mapPacks: [entry] } });
    await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, changed.ports), /原版地图/);
    assert.deepEqual(changed.calls, ["groups", "catalog"]);
  }
});

test("loaded pack content must prove the original build, pack, branch and landmark alignment", async () => {
  for (const loaded of [map({ mapPackId: `sha256-${hash("f")}` }), map({ gameBuildId: "25306743" }), map({ sceneName: "Level_9" }),
    map({ route: { branch: "swamp-temple", segments: ["Shore", "Roots", "Alpine", "Swamp", "Swamp"].map((biome, index) => ({ index, biome })) } })]) {
    const f = fixture({ loaded });
    await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, f.ports), /地标不匹配/);
    assert.equal(loaded.disposed, 1);
  }
  const f = fixture({ groups: [group({ mapAlignment: { ...group().mapAlignment, maxErrorCm: 5.01 } })] });
  await assert.rejects(loadHistoricalRouteLink({ groupId: hash("b"), stageIndex: 3 }, f.ports), /地标不匹配/);
});

test("today's refresh and expiry cannot overwrite an explicit historical route map", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const appFunction = name => source.match(new RegExp(`^async function ${name}\\([^]*?^\\}`, "m"))?.[0];
  const original = map();
  const state = { mapPack: original, mapSourceKind: "historical-route", manualMapLoads: 0 };
  for (const name of ["syncDailyMap", "expireDailyStatus"]) {
    const implementation = appFunction(name); assert.ok(implementation, name);
    const fn = new Function("state", `${implementation}; return ${name};`)(state);
    // No IO port exists: a call past the historical guard would fail this test.
    await fn({ sceneName: "Level_9", nextChangeAtUtc: "2000-01-01T00:00:00Z" });
    assert.equal(state.mapPack, original); assert.equal(state.mapSourceKind, "historical-route");
  }
});

test("the normal bootstrap does no historical IO without an explicit public route group", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const implementation = source.match(/^async function bootstrapHistoricalRouteFromQuery\([^]*?^\}/m)?.[0];
  assert.ok(implementation);
  const state = { mapRequestRevision: 4 };
  const fn = new Function("state", "window", "parseHistoricalRouteLink", `${implementation}; return bootstrapHistoricalRouteFromQuery;`)
    (state, { location: { search: "" } }, parseHistoricalRouteLink);
  await fn(); assert.equal(state.mapRequestRevision, 4);
});

async function historicalDailyFixture() {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const names = ["updateDailyCard", "updateDailyCountdown", "applyDailyStatus", "expireDailyStatus", "syncDailyMap"];
  const implementations = names.map(name => {
    const implementation = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
    assert.ok(implementation, name); return implementation;
  });
  const backHandler = source.match(/^elements.backToGate.addEventListener\("click", \(\) => \{[^]*?^\}\);/m)?.[0];
  assert.ok(backHandler);
  const node = () => ({ textContent: "", attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
  let back;
  const elements = { dailyCard: node(), dailyScene: node(), dailyCountdown: node(), importMenu: { open: true },
    backToGate: { addEventListener(type, callback) { assert.equal(type, "click"); back = callback; } } };
  const history = { group: group({ map: { ...group().map, scene: "Level_18", levelIndex: 480 } }), inspectionId: hash("d") };
  const original = map({ sceneName: "Level_18" });
  const state = { historicalRoute: history, daily: null, workspaceMode: "explore", mapSourceKind: "historical-route", mapPack: original,
    manualMapLoads: 0, trace: null };
  const today = { sceneName: "Level_19", levelIndex: 481, fetchedAtUtc: "2026-10-09T09:00:00Z", nextChangeAtUtc: "2026-10-10T01:00:00Z" };
  let incoming = today;
  const calls = { homeUpdates: [], schedules: [], home: 0, urlClears: 0 };
  class FixedDate extends Date { static now() { return Date.parse("2026-10-09T10:00:00Z"); } }
  const ports = { state, elements, Date: FixedDate, Intl,
    dailyReader: { async read() { if (incoming instanceof Error) throw incoming; return incoming; }, retryAt: null },
    dailyClock: { schedule(...args) { calls.schedules.push(args); } },
    homePage: { update(value) { calls.homeUpdates.push(value); } },
    isDailyMapFresh: value => value.fresh !== false,
    gateOpen: () => state.workspaceMode === "home",
    clearHistoricalRouteUrl: () => { calls.urlClears++; },
    showGate: () => { state.workspaceMode = "home"; calls.home++; },
  };
  const api = new Function(...Object.keys(ports), `${implementations.join("\n")}\n${backHandler}\nreturn { ${names.join(", ")} };`)(...Object.values(ports));
  return { api, state, elements, original, history, today, calls, back: () => back(), set incoming(value) { incoming = value; } };
}

test("historical daily card stays on the recorded scene and date while today's state and homepage refresh normally", async () => {
  const f = await historicalDailyFixture();
  f.api.updateDailyCountdown();
  assert.equal(f.elements.dailyCard.attributes.title, "历史录制地图");
  assert.equal(f.elements.dailyScene.textContent, "历史 Level_18");
  assert.equal(f.elements.dailyCountdown.textContent, "2026-10-08 · 轮换 480");
  await f.api.applyDailyStatus();
  assert.equal(f.state.daily, f.today); assert.deepEqual(f.calls.homeUpdates, [f.today]);
  assert.equal(f.state.historicalRoute, f.history); assert.equal(f.state.mapPack, f.original);
  assert.equal(f.elements.dailyScene.textContent, "历史 Level_18"); assert.equal(f.elements.dailyCountdown.textContent, "2026-10-08 · 轮换 480");
  f.api.updateDailyCountdown(); assert.equal(f.elements.dailyCountdown.textContent, "2026-10-08 · 轮换 480");
});

test("returning home clears history and restores today's current card without modifying today's rotation", async () => {
  const f = await historicalDailyFixture();
  await f.api.applyDailyStatus();
  f.back();
  assert.equal(f.state.historicalRoute, null); assert.equal(f.state.workspaceMode, "home");
  assert.equal(f.elements.dailyCard.attributes.title, "今日轮换"); assert.equal(f.elements.dailyScene.textContent, "Level_19");
  assert.equal(f.elements.dailyCountdown.textContent, "15h 00m");
  assert.equal(f.state.daily, f.today); assert.equal(f.calls.home, 1); assert.equal(f.calls.urlClears, 1); assert.equal(f.elements.importMenu.open, false);
});

test("missing, failed or stale daily observations cannot turn the historical card into a today's countdown", async () => {
  for (const incoming of [null, new Error("offline"), { sceneName: "Level_19", fetchedAtUtc: "2026-10-09T09:00:00Z", nextChangeAtUtc: "2026-10-08T01:00:00Z", fresh: false }]) {
    const f = await historicalDailyFixture(); f.incoming = incoming;
    f.api.updateDailyCountdown(); await f.api.applyDailyStatus();
    assert.equal(f.elements.dailyCard.attributes.title, "历史录制地图");
    assert.equal(f.elements.dailyScene.textContent, "历史 Level_18"); assert.equal(f.elements.dailyCountdown.textContent, "2026-10-08 · 轮换 480");
    assert.equal(f.state.mapPack, f.original);
  }
});

async function appFunction(name) {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const implementation = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"))?.[0];
  assert.ok(implementation, name);
  return implementation;
}

async function historicalNavigationFixture({ current = map(), render = async () => {} } = {}) {
  const calls = { fit: 0, reset: 0, overlays: 0, urls: [] };
  const state = { mapPack: current, workspaceMode: "explore", trace: null, selectedSegment: 3,
    mapRequestRevision: 1, traceSelectionRevision: 4, replayCollection: null };
  const noop = () => {};
  const ports = { state, elements: { liveStateRow: {}, eventToast: { classList: { remove: noop } } },
    disconnectLive: noop, setSourceMode: noop, setPlaying: noop, updateDailyCountdown: noop,
    resetSegmentNavigation: () => { calls.reset++; }, assessCompatibility: () => ({ compatible: true }),
    syncGameAssetsForTrace: noop, updateTraceUI: noop, updateMapUI: noop, updateCompatibilityUI: noop,
    syncWorkspaceState: noop, dismissGate: noop, viewer: { resize: noop, fitView: () => { calls.fit++; } },
    renderData: () => render(state), updateHistoricalRouteUrl: stage => calls.urls.push(stage),
    communityMapPanel: { openHistorical: async () => { calls.overlays++; } } };
  const implementation = await appFunction("openHistoricalRoute");
  const open = new Function(...Object.keys(ports), `${implementation}; return openHistoricalRoute;`)(...Object.values(ports));
  return { open, state, calls, current };
}

test("choosing another team on the current chapter preserves the model object and camera", async () => {
  const f = await historicalNavigationFixture();
  await f.open({ group: group(), mapPack: f.current, stageIndex: 3, title: "团队路线", inspectionId: null,
    teamId: hash("d"), reusedMapPack: true }, 1);
  assert.equal(f.state.mapPack, f.current); assert.equal(f.current.disposed, 0);
  assert.equal(f.state.historicalRoute.teamId, hash("d"));
  assert.equal(f.calls.fit, 0); assert.equal(f.calls.reset, 0);
  assert.deepEqual(f.calls.urls, [3]); assert.equal(f.calls.overlays, 1);
});

test("cross-map team navigation fits its original model and releases the prior pack", async () => {
  const f = await historicalNavigationFixture();
  const other = map({ mapPackId: `sha256-${hash("e")}`, sceneName: "Level_9" });
  await f.open({ group: group(), mapPack: other, stageIndex: 3, title: "团队路线", teamId: hash("d") }, 1);
  assert.equal(f.state.mapPack, other); assert.equal(f.current.disposed, 1); assert.equal(other.disposed, 0);
  assert.equal(f.calls.fit, 1); assert.equal(f.calls.reset, 1);
});

test("cancelled team navigation cannot dispose a borrowed current map or alter the selected overlay", async () => {
  const f = await historicalNavigationFixture(); f.state.mapRequestRevision = 2;
  await f.open({ group: group(), mapPack: f.current, stageIndex: 3, reusedMapPack: true }, 1);
  assert.equal(f.current.disposed, 0); assert.equal(f.calls.overlays, 0); assert.equal(f.calls.fit, 0);
  const stale = map();
  await f.open({ group: group(), mapPack: stale, stageIndex: 3 }, 1);
  assert.equal(stale.disposed, 1); assert.equal(f.state.mapPack, f.current);
});

test("a map reselected while geometry streams is not disposed by an older navigation", async () => {
  const f = await historicalNavigationFixture({ render: async state => {
    state.mapPack = original;
    state.mapRequestRevision++; state.traceSelectionRevision++;
  } });
  const original = f.current, incoming = map();
  await f.open({ group: group(), mapPack: incoming, stageIndex: 3 }, 1);
  assert.equal(f.state.mapPack, original); assert.equal(original.disposed, 0);
  assert.equal(f.calls.overlays, 0); assert.deepEqual(f.calls.urls, []);
});

test("historical service JSON reads have a timeout and stop oversized chunked responses before buffering the body", async () => {
  const implementation = await appFunction("readHistoricalJson");
  let canceled = 0, options;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel() { canceled++; } });
  const oversized = new Response(body, { headers: { "content-type": "application/json" } });
  const bounded = new Function("fetch", `${implementation}; return readHistoricalJson;`)(async (_, settings) => {
    options = settings; return oversized;
  });
  await assert.rejects(bounded("/api/route-teams/public", 32), /数据过大/);
  assert.equal(canceled, 1); assert.equal(options.cache, "no-store"); assert.ok(options.signal instanceof AbortSignal);
  const good = new Function("fetch", `${implementation}; return readHistoricalJson;`)(async () => new Response('{"team":null}',
    { headers: { "content-type": "application/json" } }));
  assert.deepEqual(await good("/api/route-teams/public", 32), { team: null });
});

test("clearing a team preserves its current map and removes the team from subsequent chapter share links", async () => {
  const state = { selectedSegment: 3, historicalRoute: { group: group(), title: "历史路线 · 团队路线", teamId: hash("d") } };
  let url = `https://peak.mylus.cn/?routeGroup=${hash("b")}&stage=3&team=${hash("d")}`, opened = 0;
  const ports = { state, window: { location: { get href() { return url; } }, history: { replaceState(_, __, next) { url = next; } } },
    historicalRouteUrl, renderSegmentNavigation: () => {}, syncWorkspaceState: () => {},
    communityMapPanel: { openHistorical: async () => { opened++; } } };
  const source = `${await appFunction("updateHistoricalRouteUrl")}\n${await appFunction("openCommunityTeam")}`;
  const clear = new Function(...Object.keys(ports), `${source}; return openCommunityTeam;`)(...Object.values(ports));
  await clear(null);
  assert.equal(state.historicalRoute.teamId, null); assert.equal(state.historicalRoute.title, "历史路线");
  assert.equal(new URL(url).searchParams.has("team"), false); assert.equal(opened, 1);
  state.historicalRoute.teamId = hash("d"); state.selectedSegment = null;
  url += `&team=${hash("d")}`;
  await clear(null);
  assert.equal(new URL(url).searchParams.has("team"), false, "clearing also works from the overview");
});

test("a real lightweight search summary preserves the current chapter before its verified team lookup", async () => {
  const state = { mapPack: map(), selectedSegment: 0, historicalRoute: null }, links = [];
  const implementation = await appFunction("openCommunityTeam");
  const open = new Function("state", "navigateHistoricalRoute", `${implementation}; return openCommunityTeam;`)
    (state, async link => links.push(link));
  const summary = team();
  delete summary.mapPackId; delete summary.mapCompatibility; delete summary.mapAlignment;
  await open(summary);
  assert.deepEqual(links.at(-1), { groupId: summary.groupId, teamId: summary.id, stageIndex: 0 },
    "a same-map search does not jump to the team's last chapter and reset the current camera");
  await open({ ...summary, map: { ...summary.map, buildId: "25306743" } });
  assert.equal(links.at(-1).stageIndex, null, "another build must choose its own observed chapter");
  await open({ ...summary, map: { ...summary.map, scene: "Level_9" } });
  assert.equal(links.at(-1).stageIndex, null);
});
