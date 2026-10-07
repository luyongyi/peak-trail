import assert from "node:assert/strict";
import test from "node:test";
import { communityGroupLabel, communityMapIdentity, mapRouteStages, matchesCommunityGroup, normalizeCommunityStage } from "../src/community-route-model.js";
import { createCommunityRoutes } from "../src/community-routes.js";

const hash = character => character.repeat(64);
function map(overrides = {}) {
  return { mapPackId: `sha256-${hash("a")}`, gameBuildId: "25306743", sceneName: "Level_8", route: {
    branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) },
  layers: ["Shore", "Roots", "Alpine", "Volcano", "Volcano", "Void"].map((biome, segment) => ({ segment, biome })), ...overrides };
}
function group(overrides = {}) {
  const route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
  return { id: hash("b"), mapCompatibility: "matched", mapPackId: map().mapPackId,
    map: { buildId: "25306743", scene: "Level_8", levelIndex: 81, layoutKey: hash("c"), route,
      stages: route.map((name, index) => ({ index, name, enterZCm: index * 1000, exitZCm: (index + 1) * 1000 })) },
    stageSummaries: route.map((name, index) => ({ index, name, routeCount: 2 })),
    difficulties: [{ key: "a:0;c:false;m:false", label: "登山 0" }, { key: "a:3;c:false;m:false", label: "登山 3" }], ...overrides };
}
function routeBody(chosen = group(), stageIndex = 0, overrides = {}) {
  return { groupId: chosen.id, stageIndex, mapCompatibility: "matched", mapPackId: chosen.mapPackId, totalRouteCount: 2, truncated: false,
    routes: [{ id: "first", playerKey: hash("1"), name: "同名登山者", points: [[0, 100, 100, 100], [100, 200, 300, 200]], breaks: [] },
      { id: "second", playerKey: hash("2"), name: "同名登山者", points: [[0, 500, -100, 100], [100, 600, 100, 200]], breaks: [] }], ...overrides };
}
function heatBody(chosen = group(), stageIndex = 0, overrides = {}) {
  return { groupId: chosen.id, stageIndex, mapCompatibility: "matched", mapPackId: chosen.mapPackId, routeCount: 2,
    cellSizeCm: 200, heightBandCm: 200, cells: [[0, 0, 0, 1], [1, 1, 1, 1], [2, -1, 0, 1]], ...overrides };
}
function response(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function server(groups = [group()]) {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, ...options });
    if (path === "/api/route-groups") return response({ groups });
    const parts = path.match(/\/([a-f0-9]{64})\/stages\/(\d+)\/(routes|heatmap)/);
    assert.ok(parts, `unexpected API path ${path}`);
    const chosen = groups.find(value => value.id === parts[1]);
    return response(parts[3] === "routes" ? routeBody(chosen, Number(parts[2])) : heatBody(chosen, Number(parts[2])));
  };
  return { calls, fetchImpl };
}

test("community identity requires a verified map build, scene, pack and canonical branch", () => {
  assert.ok(communityMapIdentity(map()));
  assert.deepEqual(mapRouteStages(map()).map(stage => stage.name), ["Shore", "Roots", "Alpine", "Volcano", "Kiln", "Void"]);
  for (const changed of [map({ route: null }), map({ mapPackId: "Level_8" }), map({ gameBuildId: "" }), map({ route: { ...map().route, branch: "swamp-temple" } })]) {
    assert.equal(communityMapIdentity(changed), null);
  }
  assert.equal(matchesCommunityGroup(group(), map()), true);
});

test("the same Level_N cannot overlay an old build, a different map pack or waiting-map data", () => {
  const original = group();
  const changed = [group({ map: { ...original.map, buildId: "25739797" } }), group({ mapPackId: `sha256-${hash("f")}` }),
    group({ mapCompatibility: "waiting-map" }), group({ map: { ...original.map, layoutKey: undefined } }),
    group({ map: { ...original.map, scene: "Level_7" } })];
  for (const value of changed) assert.equal(matchesCommunityGroup(value, map()), false);
});

test("group chapter titles must match the actual branch and native selected indices", () => {
  const original = group();
  const swapped = ["Shore", "Roots", "Alpine", "Swamp", "Temple"];
  assert.equal(matchesCommunityGroup(group({ map: { ...original.map, route: swapped, stages: swapped.map((name, index) => ({ name, index })) } }), map()), false);
  assert.equal(matchesCommunityGroup(group({ stageSummaries: [{ index: 4, name: "Volcano", routeCount: 1 }] }), map()), false);
  const swampMap = map({ route: { branch: "swamp-temple", segments: ["Shore", "Roots", "Alpine", "Swamp", "Swamp"].map((biome, index) => ({ index, biome })) } });
  const temple = ["Shore", "Roots", "Alpine", "Swamp", "Citadel"];
  assert.equal(matchesCommunityGroup(group({ map: { ...original.map, route: temple, stages: temple.map((name, index) => ({ name, index })) },
    stageSummaries: temple.map((name, index) => ({ name, index, routeCount: 1 })) }), swampMap), true);
});

test("the landing page and default map view do not fetch trajectory payloads", async () => {
  const fake = server(), states = [];
  const controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl, onChange: state => states.push(state) });
  assert.equal(fake.calls.length, 0);
  assert.equal(controller.getSnapshot().mode, "off");
  await controller.enterMap(map(), { stageIndex: 0 });
  assert.deepEqual(fake.calls.map(call => call.path), ["/api/route-groups"]);
  assert.equal(controller.getSnapshot().group.id, group().id);
  assert.equal(controller.getSnapshot().routes.length, 0);
  assert.equal(controller.getSnapshot().mapPackId, map().mapPackId);
  assert.ok(states.some(state => state.status === "loading"));
  assert.ok(fake.calls.every(call => !call.method || call.method === "GET"));
});

test("explicit route mode fetches one stage; heat mode reuses data and preserves independent same-name players", async () => {
  const fake = server(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 1 });
  await controller.setMode("routes");
  let state = controller.getSnapshot();
  assert.equal(state.status, "ready");
  assert.equal(state.routes.length, 2);
  assert.equal(state.players.length, 2);
  assert.equal(new Set(state.players.map(player => player.id)).size, 2);
  assert.deepEqual(state.heightBands, [-1, 0, 1]);
  assert.equal(fake.calls.length, 3);
  controller.setPlayerVisible("first", false);
  assert.equal(controller.getSnapshot().players[0].visible, false);
  assert.equal(controller.getSnapshot().players[1].visible, true);
  controller.setHeightBand(-1);
  await controller.setMode("heatmap");
  state = controller.getSnapshot();
  assert.equal(fake.calls.length, 3);
  assert.equal(state.heatmap.routeCount, 2);
  assert.equal(state.heightBand, -1);
  controller.setHeightBand(99);
  assert.equal(controller.getSnapshot().heightBand, null);
});

test("whole-map overview clears the previous stage without inventing combined statistics", async () => {
  const fake = server(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("heatmap");
  await controller.setStage(null);
  assert.equal(fake.calls.length, 3);
  const state = controller.getSnapshot();
  assert.equal(state.stageIndex, null); assert.equal(state.totalRouteCount, 0); assert.equal(state.heatmap, null);
  assert.equal(state.routes.length, 0); assert.match(state.message, /选择一个关卡/);
  await controller.setStage(4);
  assert.equal(fake.calls.length, 5); assert.equal(controller.getSnapshot().stageIndex, 4);
});

test("compatible layouts stay selectable and are never mixed automatically", async () => {
  const first = group(), second = group({ id: hash("d"), map: { ...first.map, layoutKey: hash("e"), levelIndex: 82 } });
  const fake = server([first, second]), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("routes");
  assert.equal(controller.getSnapshot().groups.length, 2); assert.equal(controller.getSnapshot().group.id, first.id);
  assert.equal(controller.getSnapshot().routes.length, 2);
  await controller.selectGroup(second.id);
  assert.equal(controller.getSnapshot().group.id, second.id); assert.equal(controller.getSnapshot().routes.length, 2);
  assert.ok(fake.calls.slice(-2).every(call => call.path.includes(second.id)));
  assert.match(communityGroupLabel(second, 1), /轮换 82 · 记录组 2/);
  assert.ok(!communityGroupLabel(second).includes("eeeeeeee"));
});

test("difficulty filters are encoded and retained only when the chosen layout supports them", async () => {
  const first = group(), second = group({ id: hash("d"), map: { ...first.map, layoutKey: hash("e") }, difficulties: [] });
  const fake = server([first, second]), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 2 }); await controller.setMode("routes");
  const key = first.difficulties[1].key;
  await controller.setDifficulty(key);
  assert.equal(controller.getSnapshot().difficulty, key);
  assert.ok(fake.calls.slice(-2).every(call => call.path.endsWith(`?difficulty=${encodeURIComponent(key)}`)));
  await controller.selectGroup(second.id);
  assert.equal(controller.getSnapshot().difficulty, "");
  assert.ok(fake.calls.slice(-2).every(call => !call.path.includes("?")));
});

test("only mismatch data never reaches a route or heatmap endpoint", async () => {
  const fake = server([group({ mapCompatibility: "waiting-map" })]), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("heatmap");
  assert.equal(controller.getSnapshot().status, "mismatch"); assert.equal(fake.calls.length, 1);
  assert.equal(controller.getSnapshot().routes.length, 0); assert.match(controller.getSnapshot().message, /暂不叠加/);
});

test("routes from other Level_N scenes do not imply a mismatch for the current map", async () => {
  const original = group();
  const fake = server([group({ map: { ...original.map, scene: "Level_3" }, mapCompatibility: "waiting-map" })]);
  const controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 });
  assert.equal(controller.getSnapshot().status, "empty"); assert.equal(controller.getSnapshot().unavailableCount, 0);
  assert.match(controller.getSnapshot().message, /当前地图还没有/);
});

test("off hides completed data immediately and returning to an overlay reuses the same stage cache", async () => {
  const fake = server(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("routes");
  const before = controller.getSnapshot();
  controller.setPlayerVisible("first", false); controller.setHeightBand(0);
  await controller.setMode("off");
  assert.equal(controller.getSnapshot().mode, "off"); assert.equal(controller.getSnapshot().heatmap, before.heatmap);
  await controller.setMode("heatmap");
  assert.equal(fake.calls.length, 3); assert.equal(controller.getSnapshot().heatmap, before.heatmap);
  assert.equal(controller.getSnapshot().heightBand, 0); assert.equal(controller.getSnapshot().players[0].visible, false);
});

test("late groups cannot repopulate a map after returning to the homepage", async () => {
  let finish;
  const states = [], controller = createCommunityRoutes({ fetchImpl: async () => new Promise(resolve => { finish = resolve; }), onChange: state => states.push(state) });
  const pending = controller.enterMap(map(), { stageIndex: 0 });
  controller.clear();
  assert.equal(states.at(-1).status, "idle");
  finish(response({ groups: [group()] })); await pending;
  assert.equal(states.at(-1).status, "idle"); assert.equal(controller.getSnapshot().groups.length, 0);
  assert.equal(controller.getSnapshot().mapPackId, null);
});

test("old stage responses cannot overwrite a newer selected chapter, even if fetch ignores abort", async () => {
  const deferred = [], fake = server();
  const controller = createCommunityRoutes({ fetchImpl: (path, options) => {
    if (path.includes("/stages/0/")) return new Promise(resolve => deferred.push({ path, options, resolve }));
    return fake.fetchImpl(path, options);
  } });
  await controller.enterMap(map(), { stageIndex: 0 });
  const pending = controller.setMode("routes");
  await controller.setStage(1);
  assert.equal(controller.getSnapshot().stageIndex, 1); assert.equal(controller.getSnapshot().status, "ready");
  assert.ok(deferred.every(call => call.options.signal.aborted));
  for (const call of deferred) call.resolve(response(call.path.endsWith("/routes") ? routeBody() : heatBody()));
  await pending;
  assert.equal(controller.getSnapshot().stageIndex, 1); assert.equal(controller.getSnapshot().status, "ready");
});

test("responses with a stale group, stage, pack or compatibility are rejected before display", () => {
  for (const invalid of [{ groupId: hash("e") }, { stageIndex: 1 }, { mapPackId: `sha256-${hash("f")}` }, { mapCompatibility: "waiting-map" }]) {
    assert.throws(() => normalizeCommunityStage(routeBody(group(), 0, invalid), heatBody(), group(), map(), 0), /不一致/);
  }
});

test("service failure is surfaced, refresh can recover, and zero complete routes remain empty", async () => {
  let failed = true;
  const fake = server(), controller = createCommunityRoutes({ fetchImpl: (path, options) => failed ? Promise.resolve(response({}, 503)) : fake.fetchImpl(path, options) });
  await controller.enterMap(map(), { stageIndex: 0 });
  assert.equal(controller.getSnapshot().status, "error"); assert.match(controller.getSnapshot().message, /503/);
  failed = false; await controller.refresh(); await controller.setMode("routes");
  assert.equal(controller.getSnapshot().status, "ready");
  const empty = createCommunityRoutes({ fetchImpl: async path => response(path === "/api/route-groups" ? { groups: [group()] }
    : path.endsWith("/routes") ? routeBody(group(), 0, { totalRouteCount: 0, routes: [] }) : heatBody(group(), 0, { routeCount: 0, cells: [] })) });
  await empty.enterMap(map(), { stageIndex: 0 }); await empty.setMode("heatmap");
  assert.equal(empty.getSnapshot().status, "empty"); assert.equal(empty.getSnapshot().totalRouteCount, 0);
});

test("off immediately cancels pending stage reads and dispose permanently prevents requests or updates", async () => {
  const deferred = [], states = [], fake = server();
  const controller = createCommunityRoutes({ fetchImpl: (path, options) => path.includes("/stages/")
    ? new Promise(resolve => deferred.push({ path, options, resolve })) : fake.fetchImpl(path, options), onChange: state => states.push(state) });
  await controller.enterMap(map(), { stageIndex: 0 });
  const pending = controller.setMode("heatmap"); await controller.setMode("off");
  assert.equal(controller.getSnapshot().mode, "off"); assert.equal(controller.getSnapshot().heatmap, null);
  assert.ok(deferred.every(call => call.options.signal.aborted));
  controller.dispose(); const count = states.length, calls = fake.calls.length;
  for (const call of deferred) call.resolve(response(call.path.endsWith("/routes") ? routeBody() : heatBody()));
  await pending; await controller.enterMap(map()); await controller.refresh(); await controller.setMode("routes");
  assert.equal(states.length, count); assert.equal(fake.calls.length, calls);
});

test("truncation is reported truthfully and a reentered identical map only changes its explicit chapter", async () => {
  const fake = server(), controller = createCommunityRoutes({ fetchImpl: (path, options) => path.endsWith("/routes")
    ? Promise.resolve(response(routeBody(group(), Number(path.match(/stages\/(\d+)/)[1]), { totalRouteCount: 7, truncated: true }))) : fake.fetchImpl(path, options) });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("routes");
  assert.equal(controller.getSnapshot().totalRouteCount, 7); assert.equal(controller.getSnapshot().truncated, true);
  assert.match(controller.getSnapshot().message, /2 \/ 7.*全部有效路线/);
  await controller.enterMap(map(), { stageIndex: null });
  assert.equal(fake.calls.filter(call => call.path === "/api/route-groups").length, 1);
  assert.equal(controller.getSnapshot().stageIndex, null); assert.equal(controller.getSnapshot().routes.length, 0);
});
