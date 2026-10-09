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
function fixture({ groups = [group()], loaded = map(), catalog = null } = {}) {
  const calls = [];
  const exact = { identityVersion: 3, mapPackId: packId, gameBuildId: "25739797", sceneName: "Level_8", path: `./packs/${packId}/map-pack.json` };
  const ports = {
    readGroups: async () => { calls.push("groups"); return { groups }; },
    readCatalog: async () => { calls.push("catalog"); return { catalog: catalog || { schemaVersion: 1, activeGameBuildId: "30000000", mapPacks: [exact] }, baseUrl: "https://peak.mylus.cn/data/maps/catalog.json" }; },
    loadMapPack: async url => { calls.push(url); return loaded; },
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

test("inspection data proves both public identities and preserves partial paths and break timestamps", () => {
  const body = { inspection: true, excludedFromAggregation: true, groupId: hash("b"), uploadId: hash("d"), stageIndex: 3,
    mapPackId: packId, mapCompatibility: "matched", mapAlignment: group().mapAlignment, coordinateSpace: "canonical-map-world-cm",
    totalRouteCount: 1, routes: [{ id: "partial", name: "玩家", points: [[0, 0, 100, 0], [100, 0, 100, 100], [200, 8000, 200, 100]],
      breaks: [200], completion: "partial", completed: false }] };
  const result = normalizeHistoricalInspection(body, group(), map(), 3, hash("d"));
  assert.deepEqual(result.routes[0].points, body.routes[0].points); assert.deepEqual(result.routes[0].breaks, [200]);
  assert.equal(result.routes[0].completed, false); assert.equal(result.heatmap, null); assert.equal(result.inspectionLoaded, true);
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
