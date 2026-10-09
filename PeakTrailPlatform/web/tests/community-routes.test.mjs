import assert from "node:assert/strict";
import test from "node:test";
import { communityGroupLabel, communityMapIdentity, communityPlayers, mapRouteStages, matchesCommunityGroup, normalizeCommunityStage, normalizeCommunityTeams, normalizeCommunityTeamStage } from "../src/community-route-model.js";
import { createCommunityRoutes } from "../src/community-routes.js";

const hash = character => character.repeat(64);
const alignment = () => ({ status: "verified", id: hash("9"), method: "identity", landmarkCount: 3, maxErrorCm: 0 });
function map(overrides = {}) {
  return { mapPackId: `sha256-${hash("a")}`, gameBuildId: "25306743", sceneName: "Level_8", route: {
    branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) },
  layers: ["Shore", "Roots", "Alpine", "Volcano", "Volcano", "Void"].map((biome, segment) => ({ segment, biome })), ...overrides };
}
function group(overrides = {}) {
  const route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
  return { id: hash("b"), mapCompatibility: "matched", mapPackId: map().mapPackId, mapAlignment: alignment(),
    map: { buildId: "25306743", scene: "Level_8", levelIndex: 81, layoutKey: hash("c"), route,
      stages: route.map((name, index) => ({ index, name, enterZCm: index * 1000, exitZCm: (index + 1) * 1000 })) },
    stageSummaries: route.map((name, index) => ({ index, name, routeCount: 2 })),
    difficulties: [{ key: "a:0;c:false;m:false", label: "登山 0" }, { key: "a:3;c:false;m:false", label: "登山 3" }], ...overrides };
}
function routeBody(chosen = group(), stageIndex = 0, overrides = {}) {
  return { groupId: chosen.id, stageIndex, mapCompatibility: "matched", mapPackId: chosen.mapPackId, mapAlignment: chosen.mapAlignment,
    coordinateSpace: "canonical-map-world-cm", totalRouteCount: 2, truncated: false,
    routes: [{ id: "first", playerKey: hash("1"), name: "同名登山者", points: [[0, 100, 100, 100], [100, 200, 300, 200]], breaks: [] },
      { id: "second", playerKey: hash("2"), name: "同名登山者", points: [[0, 500, -100, 100], [100, 600, 100, 200]], breaks: [] }], ...overrides };
}
function heatBody(chosen = group(), stageIndex = 0, overrides = {}) {
  return { groupId: chosen.id, stageIndex, mapCompatibility: "matched", mapPackId: chosen.mapPackId, mapAlignment: chosen.mapAlignment,
    coordinateSpace: "canonical-map-world-cm", routeCount: 2,
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

test("inspection reads only its approved upload, keeps partial paths separate and never requests heatmap aggregates", async () => {
  const calls = [], chosen = group(), uploadId = hash("d");
  const fetchImpl = async path => {
    calls.push(path);
    if (path === "/api/route-groups") return response({ groups: [chosen] });
    const match = path.match(new RegExp(`^/api/route-groups/${chosen.id}/uploads/${uploadId}/stages/(\\d+)/inspection`));
    assert.ok(match, `only inspection requests are permitted: ${path}`);
    return response({ ...routeBody(chosen, Number(match[1])), inspection: true, uploadId, excludedFromAggregation: true,
      routes: [{ id: "partial", name: "Mylu", completion: "partial", completed: false, gameCompleted: true,
        points: [[0, 0, 100, 0], [100, 100, 100, 100], [200, 9000, 100, 100]], breaks: [200] }] });
  };
  const controller = createCommunityRoutes({ fetchImpl });
  await controller.enterMap(map(), { stageIndex: 3, groupId: chosen.id, inspectionId: uploadId, mode: "routes" });
  assert.equal(controller.getSnapshot().inspectionId, uploadId); assert.equal(controller.getSnapshot().mode, "routes");
  assert.equal(controller.getSnapshot().routes[0].completed, false); assert.deepEqual(controller.getSnapshot().routes[0].breaks, [200]);
  assert.equal(controller.getSnapshot().heatmap, null);
  assert.equal(controller.getSnapshot().routes[0].gameCompleted, true);
  assert.match(controller.getSnapshot().message, /验收预览.*已完成本关 · 线路有断点/);
  const count = calls.length; await controller.setMode("heatmap");
  assert.equal(controller.getSnapshot().mode, "routes"); assert.equal(calls.length, count);
  await controller.setDifficulty("a:3;c:false;m:false");
  assert.equal(controller.getSnapshot().difficulty, ""); assert.equal(calls.length, count);
  await controller.setMode("off"); await controller.setMode("routes"); assert.equal(calls.length, count);
  await controller.setStage(1); await controller.refresh();
  assert.equal(controller.getSnapshot().inspectionId, uploadId);
  assert.ok(calls.filter(path => path !== "/api/route-groups").every(path => path.includes(uploadId) && path.includes("/inspection")));
  controller.dispose();
});

test("historical navigation pins one public group across refresh and stage changes", async () => {
  const historic = group(), other = group({ id: hash("e") });
  const fake = server([other, historic]), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 3, groupId: historic.id, mode: "routes" });
  assert.equal(controller.getSnapshot().pinnedGroupId, historic.id);
  assert.equal(controller.getSnapshot().group.id, historic.id);
  assert.equal(controller.getSnapshot().mode, "routes");
  assert.equal(controller.getSnapshot().routes.length, 2);
  await controller.selectGroup(other.id);
  await controller.setStage(1); await controller.refresh();
  assert.equal(controller.getSnapshot().group.id, historic.id);
  assert.deepEqual(controller.getSnapshot().groups.map(value => value.id), [historic.id]);
  assert.ok(fake.calls.filter(value => value.path !== "/api/route-groups").every(value => value.path.includes(historic.id)));
  controller.dispose();
});

test("removed historical groups clear their overlay without substituting another matching layout", async () => {
  const historic = group(), other = group({ id: hash("e") });
  const groups = [historic, other], fake = server(groups), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 3, groupId: historic.id, mode: "routes" });
  groups.shift(); const count = fake.calls.length; await controller.refresh();
  assert.equal(controller.getSnapshot().group, null); assert.equal(controller.getSnapshot().routes.length, 0);
  assert.match(controller.getSnapshot().message, /历史路线组暂不可用/);
  assert.deepEqual(fake.calls.slice(count).map(value => value.path), ["/api/route-groups"]);
  await controller.enterMap(map(), { stageIndex: 3 });
  assert.equal(controller.getSnapshot().pinnedGroupId, null); assert.equal(controller.getSnapshot().group.id, other.id);
  assert.equal(controller.getSnapshot().mode, "off"); controller.dispose();
});

test("community identity requires a verified map build, scene, pack and canonical branch", () => {
  assert.ok(communityMapIdentity(map()));
  assert.deepEqual(mapRouteStages(map()).map(stage => stage.name), ["Shore", "Roots", "Alpine", "Volcano", "Kiln", "Void"]);
  for (const changed of [map({ route: null }), map({ mapPackId: "Level_8" }), map({ gameBuildId: "" }), map({ route: { ...map().route, branch: "swamp-temple" } })]) {
    assert.equal(communityMapIdentity(changed), null);
  }
  assert.equal(matchesCommunityGroup(group(), map()), true);
  assert.equal(matchesCommunityGroup(group({ mapAlignment: { ...alignment(), method: "legacy-layout-key" } }), map()), true,
    "a source-proven older recording can still overlay the original model");
});

test("the same Level_N cannot overlay an old build, a different map pack or waiting-map data", () => {
  const original = group();
  const changed = [group({ map: { ...original.map, buildId: "25739797" } }), group({ mapPackId: `sha256-${hash("f")}` }),
    group({ mapCompatibility: "waiting-map" }), group({ map: { ...original.map, layoutKey: undefined } }),
    group({ map: { ...original.map, scene: "Level_7" } }), group({ mapAlignment: undefined }),
    group({ mapAlignment: { ...alignment(), status: "pending" } }), group({ mapAlignment: { ...alignment(), maxErrorCm: 5.01 } })];
  for (const value of changed) assert.equal(matchesCommunityGroup(value, map()), false);
});

test("pending map evidence distinguishes an unavailable game version from an older recording lacking landmarks", async () => {
  for (const [changed, pattern] of [
    [group({ mapCompatibility: "waiting-map", mapAlignment: { status: "pending", reason: "map-build-unavailable" } }), /游戏版本/],
    [group({ mapCompatibility: "waiting-map", mapAlignment: { status: "pending", reason: "recording-landmarks-missing" } }), /旧录像.*地标/],
    [group({ mapCompatibility: "waiting-map", mapAlignment: { status: "pending", reason: "source-landmarks-missing" } }), /地图模型的地标/],
  ]) {
    const fake = server([changed]), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
    await controller.enterMap(map(), { stageIndex: 0 }); await controller.setMode("routes");
    assert.equal(controller.getSnapshot().status, "mismatch"); assert.match(controller.getSnapshot().message, pattern);
    assert.deepEqual(fake.calls.map(value => value.path), ["/api/route-groups"]); controller.dispose();
  }
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
  assert.ok(fake.calls.slice(-2).every(call => new URL(call.path, "https://example.invalid").searchParams.get("difficulty") === key));
  assert.equal(new URL(fake.calls.at(-1).path, "https://example.invalid").searchParams.get("countBy"), "team");
  await controller.selectGroup(second.id);
  assert.equal(controller.getSnapshot().difficulty, "");
  assert.ok(fake.calls.slice(-2).every(call => !new URL(call.path, "https://example.invalid").searchParams.has("difficulty")));
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
  for (const invalid of [{ groupId: hash("e") }, { stageIndex: 1 }, { mapPackId: `sha256-${hash("f")}` }, { mapCompatibility: "waiting-map" },
    { mapAlignment: { ...alignment(), id: hash("8") } }, { coordinateSpace: "recording-world-cm" }]) {
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

function team(overrides = {}) {
  return { id: hash("6"), groupId: group().id, startedUtc: "2026-10-08T13:44:03Z", lastStartedUtc: "2026-10-08T13:44:03Z",
    difficulty: "登山 0", map: { buildId: map().gameBuildId, scene: map().sceneName, levelIndex: 480 },
    members: [{ playerKey: hash("1"), name: "Mylu" }, { playerKey: hash("2"), name: "队友" }], stageSummaries: [], ...overrides };
}
function teamStage(stageIndex = 0, overrides = {}) {
  return { ...routeBody(group(), stageIndex), teamId: team().id,
    routes: routeBody().routes.map((route, index) => ({ ...route, completed: index === 0, completion: index === 0 ? "complete" : "partial", gameCompleted: index === 0 })), ...overrides };
}
function teamServer() {
  const basic = server(), calls = basic.calls;
  return { calls, fetchImpl: async (path, options) => {
    if (path.startsWith("/api/route-teams?")) { calls.push({ path, ...options }); return response({ teams: [team()], truncated: false }); }
    const match = path.match(/^\/api\/route-teams\/([a-f0-9]{64})\/stages\/(\d+)\/routes$/);
    if (match) { calls.push({ path, ...options }); return response(teamStage(Number(match[2]))); }
    return basic.fetchImpl(path, options);
  } };
}

test("member search is explicitly submitted, scoped to a layout, encoded and separate from route loading", async () => {
  const fake = teamServer(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 });
  assert.equal(fake.calls.filter(call => call.path.startsWith("/api/route-teams")).length, 0);
  await controller.searchTeams({ member: " My lu & 队友 ", allMaps: false });
  const request = new URL(fake.calls.at(-1).path, "https://example.invalid");
  assert.equal(request.searchParams.get("member"), "My lu & 队友"); assert.equal(request.searchParams.get("group"), group().id);
  assert.equal(controller.getSnapshot().teams.length, 1); assert.equal(controller.getSnapshot().mode, "off");
  await controller.searchTeams({ member: "Mylu", allMaps: true });
  assert.equal(new URL(fake.calls.at(-1).path, "https://example.invalid").searchParams.has("group"), false);
  assert.equal(fake.calls.filter(call => call.path.includes("/stages/")).length, 0);
  controller.dispose();
});

test("selected team includes partial members, exposes independent stable keys and only requests heat on demand", async () => {
  const fake = teamServer(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { stageIndex: 0 }); await controller.searchTeams({ member: "Mylu" }); await controller.selectTeam(team().id);
  let snapshot = controller.getSnapshot();
  assert.equal(snapshot.teamId, team().id); assert.equal(snapshot.mode, "team"); assert.equal(snapshot.routes.length, 2);
  assert.equal(snapshot.routes[1].completed, false); assert.equal(snapshot.heatmap, null);
  assert.equal(fake.calls.filter(call => call.path.includes("/heatmap")).length, 0);
  controller.setReferencePlayer(hash("2")); controller.setPlayerVisible(hash("1"), false);
  assert.equal(controller.getSnapshot().referencePlayerKey, hash("2")); assert.equal(controller.getSnapshot().players[0].visible, false);
  const requestCount = fake.calls.length; await controller.setMode("routes");
  assert.equal(fake.calls.length, requestCount); assert.equal(controller.getSnapshot().players[0].visible, false);
  controller.setAllPlayersVisible(false); assert.equal(controller.getSnapshot().players.some(player => player.visible), false);
  controller.setAllPlayersVisible(true); assert.equal(controller.getSnapshot().players.every(player => player.visible), true);
  await controller.setMode("heatmap");
  assert.equal(new URL(fake.calls.at(-1).path, "https://example.invalid").searchParams.get("team"), team().id);
  await controller.setCountBy("player");
  assert.equal(new URL(fake.calls.at(-1).path, "https://example.invalid").searchParams.get("countBy"), "player");
  await controller.selectTeam(null); snapshot = controller.getSnapshot();
  assert.equal(snapshot.teamId, null); assert.equal(snapshot.referencePlayerKey, null);
  controller.dispose();
});

test("member toggles unify several recordings of one person but never merge identical names", () => {
  const routes = routeBody().routes;
  const players = communityPlayers([routes[0], { ...routes[0], id: "another-session" }, routes[1]], new Set([hash("1")]));
  assert.equal(players.length, 2); assert.equal(players[0].visible, false); assert.equal(players[1].visible, true);
  assert.equal(players[0].pointCount, 4); assert.equal(players[0].hasPoints, true);
  const empty = communityPlayers([{ ...routes[0], points: [] }])[0];
  assert.equal(empty.pointCount, 0); assert.equal(empty.hasPoints, false);
  assert.equal(players[0].color, communityPlayers([routes[1], routes[0]])[1].color);
});

test("team direct links preserve original map identity and never combine with inspection routes", async () => {
  const fake = teamServer(), controller = createCommunityRoutes({ fetchImpl: fake.fetchImpl });
  await controller.enterMap(map(), { groupId: group().id, teamId: team().id, stageIndex: 3, mode: "team" });
  assert.equal(controller.getSnapshot().teamId, team().id); assert.equal(controller.getSnapshot().stageIndex, 3);
  assert.equal(controller.getSnapshot().routes.length, 2); assert.equal(controller.getSnapshot().referencePlayerKey, null);
  await controller.setStage(4); assert.equal(controller.getSnapshot().teamId, team().id);
  assert.ok(fake.calls.filter(call => call.path.includes("/stages/")).every(call => call.path.startsWith(`/api/route-teams/${team().id}`)));
  await assert.rejects(controller.enterMap(map(), { groupId: group().id, teamId: team().id, inspectionId: hash("d") }), /队伍链接/);
  controller.dispose();
});

test("slow member searches cannot replace later results or revive a cleared map", async () => {
  const pending = [], fake = server(), controller = createCommunityRoutes({ fetchImpl: (path, options) => path.startsWith("/api/route-teams?")
    ? new Promise(resolve => pending.push({ options, resolve })) : fake.fetchImpl(path, options) });
  await controller.enterMap(map(), { stageIndex: 0 });
  const first = controller.searchTeams({ member: "old" }); const second = controller.searchTeams({ member: "new" });
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(response({ teams: [team({ id: hash("7") })] })); await second;
  pending[0].resolve(response({ teams: [team()] })); await first;
  assert.equal(controller.getSnapshot().teams[0].id, hash("7"));
  const late = controller.searchTeams({ member: "late" }); controller.clear();
  pending[2].resolve(response({ teams: [team()] })); await late;
  assert.equal(controller.getSnapshot().teams.length, 0); assert.equal(controller.getSnapshot().mapPackId, null);
  controller.dispose();
});

test("team data rejects stale maps and malformed player identity before overlaying the model", () => {
  for (const change of [{ teamId: hash("7") }, { groupId: hash("d") }, { stageIndex: 4 },
    { mapPackId: `sha256-${hash("d")}` }, { coordinateSpace: "recording-world-cm" }, { mapAlignment: { ...alignment(), id: hash("7") } }]) {
    assert.throws(() => normalizeCommunityTeamStage(teamStage(0, change), group(), map(), 0, team().id), /不一致/);
  }
  assert.throws(() => normalizeCommunityTeams({ teams: [team({ members: [{ playerKey: "Mylu", name: "Mylu" }] })] }), /队员身份/);
  assert.throws(() => normalizeCommunityTeamStage(teamStage(0, { routes: [{ ...teamStage().routes[0], playerKey: "name-only" }] }), group(), map(), 0, team().id), /队员路线/);
});

test("team capacity limits are disclosed instead of presenting truncated observations as the whole team", async () => {
  const fake = teamServer(), controller = createCommunityRoutes({ fetchImpl: (path, options) =>
    /^\/api\/route-teams\/[a-f0-9]{64}\/stages\//.test(path)
      ? Promise.resolve(response(teamStage(0, { truncated: true }))) : fake.fetchImpl(path, options) });
  await controller.enterMap(map(), { groupId: group().id, teamId: team().id, stageIndex: 0, mode: "team" });
  assert.equal(controller.getSnapshot().truncated, true);
  assert.match(controller.getSnapshot().message, /部分成员或轨迹尚未显示/);
  controller.dispose();
});
