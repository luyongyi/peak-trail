import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCommunityMapPanel } from "../src/community-map-panel.js";

const ids = ["appShell", "communityToggle", "communityLayerControl", "communityMode", "communityPanel", "communityRefresh", "communityStatus", "communityFilters",
  "communityGroupField", "communityGroup", "communityDifficulty", "communityHeight", "communityLegend", "communityPlayers", "communityCollapse", "communitySearchForm", "communityMemberSearch", "communitySearchScope",
  "communitySearchButton", "communityTeamSearchStatus", "communityTeamResults", "communityTeamClear", "communityCountBy", "communityReference", "communityMembersControls", "communityAllPlayers"];
const hash = character => character.repeat(64);
const alignment = () => ({ status: "verified", id: hash("9"), method: "identity", landmarkCount: 3, maxErrorCm: 0 });
const route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
function map() {
  return { mapPackId: `sha256-${hash("a")}`, gameBuildId: "25306743", sceneName: "Level_8",
    route: { branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) },
    layers: route.map((_, segment) => ({ segment })) };
}
function group(id = hash("b"), layoutKey = hash("c")) {
  return { id, mapPackId: map().mapPackId, mapCompatibility: "matched", mapAlignment: alignment(),
    map: { buildId: "25306743", scene: "Level_8", layoutKey, levelIndex: 81, route, stages: route.map((name, index) => ({ index, name })) },
    stageSummaries: route.map((name, index) => ({ index, name, routeCount: 2 })),
    difficulties: [{ key: "ascent3", label: "登山 3" }] };
}
function node(tagName = "div") {
  const listeners = new Map(), classes = new Set();
  return { tagName, hidden: false, value: "", textContent: "", className: "", disabled: false, children: [], checked: false,
    dataset: {}, style: {}, attributes: {},
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of [...listeners.get(type) || []]) listener({ target: this }); },
    setAttribute(key, value) { this.attributes[key] = value; },
    replaceChildren(...children) { this.children = [...children]; }, append(...children) { this.children.push(...children); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function response(value) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }
function stageResponse(id, stageIndex, heat = false) {
  const common = { groupId: id, stageIndex, mapCompatibility: "matched", mapPackId: map().mapPackId,
    mapAlignment: alignment(), coordinateSpace: "canonical-map-world-cm", totalRouteCount: 2 };
  return heat ? { ...common, routeCount: 2, cellSizeCm: 200, heightBandCm: 200, cells: [[0, 0, 0, 1], [1, 1, 1, 1]] }
    : { ...common, truncated: false, routes: [{ id: "one", name: '<img src=x onerror="alert(1)">',
      points: [[0, 0, 100, 0], [100, 100, 300, 100]], breaks: [] },
      { id: "two", name: "登山者", points: [[0, 200, 100, 0], [100, 300, 100, 100]], breaks: [] }] };
}
function fixture({ groups = [group()], enabled = true, stageIndex = 0, deferStage = null, inspectionRouteStates = null, teams = [], navigateTeams = false, teamRouteStates = null } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, node()]));
  const heatOption = node("option");
  elements.communityMode.querySelector = selector => selector === 'option[value="heatmap"]' ? heatOption : null;
  const root = { getElementById: id => elements[id], createElement: node };
  const calls = [], deferred = [], openedTeams = [], firstScene = { overlays: [], setCommunityOverlay(value) { this.overlays.push(value); } };
  let context = { enabled, mapPack: map(), stageIndex }, scene = firstScene;
  const fetchImpl = async (path, options) => {
    calls.push({ path, ...options });
    if (path === "/api/route-groups") return response({ groups });
    if (path.startsWith("/api/route-teams?")) return response({ teams });
    const teamMatch = path.match(/^\/api\/route-teams\/([a-f0-9]{64})\/stages\/(\d+)\/routes$/);
    if (teamMatch) {
      const selected = teams.find(team => team.id === teamMatch[1]);
      const body = stageResponse(selected.groupId, Number(teamMatch[2]));
      return response({ ...body, teamId: selected.id, routes: body.routes.map((route, index) => ({ ...route,
        playerKey: selected.members[index].playerKey, name: selected.members[index].name, completed: index === 0, gameCompleted: index === 0,
        ...(teamRouteStates?.[index] || {}) })) });
    }
    const inspectionMatch = path.match(/\/([a-f0-9]{64})\/uploads\/([a-f0-9]{64})\/stages\/(\d+)\/inspection/);
    if (inspectionMatch) {
      const body = stageResponse(inspectionMatch[1], Number(inspectionMatch[3]));
      const routes = inspectionRouteStates ? inspectionRouteStates.map((state, index) => ({ ...body.routes[index % body.routes.length],
        id: `inspection-${index}`, name: "Mylu", completion: "partial", completed: false, gameCompleted: null, ...state }))
        : body.routes.map(route => ({ ...route, completion: "partial", completed: false, gameCompleted: null }));
      return response({ ...body, inspection: true, uploadId: inspectionMatch[2], excludedFromAggregation: true,
        totalRouteCount: routes.length, routes });
    }
    const match = path.match(/\/([a-f0-9]{64})\/stages\/(\d+)\/(routes|heatmap)/);
    assert.ok(match, `unexpected API path ${path}`);
    const body = stageResponse(match[1], Number(match[2]), match[3] === "heatmap");
    if (Number(match[2]) === deferStage) return new Promise(resolve => deferred.push({ options, resolve: () => resolve(response(body)) }));
    return response(body);
  };
  const panel = createCommunityMapPanel({ root, getContext: () => context, getScene: () => scene, fetchImpl, onOpenTeam: navigateTeams ? team => openedTeams.push(team) : null });
  async function change(id, value) { elements[id].value = value; elements[id].dispatch("change"); await settle(); }
  async function toggle() { elements.communityToggle.dispatch("click"); await settle(); }
  async function open() { panel.sync(); await toggle(); }
  return { elements, heatOption, calls, deferred, openedTeams, panel, firstScene, change, toggle, open,
    get context() { return context; }, set context(value) { context = value; }, get scene() { return scene; }, set scene(value) { scene = value; } };
}

test("the integrated panel stays hidden and performs no requests on the homepage or in replay", async () => {
  const f = fixture({ enabled: false }); f.panel.sync(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.elements.communityLayerControl.hidden, true); assert.equal(f.elements.communityPanel.hidden, true);
  f.context = { ...f.context, enabled: true }; f.panel.sync(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.elements.communityMode.value, "off"); assert.equal(f.elements.communityPanel.hidden, true);
  assert.equal(f.elements.communityToggle.hidden, false); assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "false");
  await f.toggle();
  assert.equal(f.calls.length, 1); assert.equal(f.elements.communityPanel.hidden, false);
  assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "true");
  assert.equal(f.elements.appShell.classList.contains("community-panel-open"), true);
  await f.change("communityMode", "routes");
  assert.equal(f.scene.overlays.at(-1).mode, "routes");
  for (const mode of ["home", "replay"]) {
    const before = f.calls.length;
    f.context = { ...f.context, enabled: false, workspaceMode: mode }; f.panel.sync(); await settle();
    assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityToggle.hidden, true); assert.equal(f.scene.overlays.at(-1).mode, "off");
    assert.equal(f.scene.overlays.at(-1).routes.length, 0); assert.equal(f.calls.length, before);
  }
  f.panel.dispose();
});

test("inspection UI preserves unknown progress and disables the heatmap option without changing normal map defaults", async () => {
  const f = fixture({ stageIndex: 3 });
  f.context = { ...f.context, routeGroupId: group().id, inspectionId: hash("d") };
  await f.panel.openHistorical();
  assert.equal(f.elements.communityMode.value, "routes"); assert.equal(f.heatOption.disabled, true); assert.equal(f.heatOption.hidden, true);
  assert.equal(f.elements.communityDifficulty.disabled, true);
  assert.match(f.elements.communityStatus.textContent, /验收预览.*缺少原生切关证据/);
  assert.match(f.elements.communityLegend.textContent, /不参与公开路线与热力统计/);
  assert.match(f.elements.communityPlayers.children[0].children[2].textContent, /线路未完整（缺少原生切关证据）/);
  const requests = f.calls.length; await f.change("communityMode", "heatmap");
  assert.equal(f.calls.length, requests); assert.equal(f.scene.overlays.at(-1).mode, "routes");
  assert.equal(f.elements.communityMode.value, "routes");
  f.context = { ...f.context, inspectionId: null, routeGroupId: null }; f.panel.sync(); await settle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.heatOption.hidden, false); assert.equal(f.heatOption.disabled, false);
  assert.equal(f.elements.communityDifficulty.disabled, false);
  f.panel.dispose();
});

test("inspection snapshots distinguish game completion from continuous route coverage and keep short Kiln paths visible", async () => {
  const cases = [
    { gameCompleted: true, completed: false, completion: "partial", breaks: [100], text: "已完成本关 · 线路有断点", stageIndex: 3 },
    { gameCompleted: true, completed: true, completion: "complete", text: "已完成本关 · 完整线路", stageIndex: 3 },
    { gameCompleted: false, completed: false, completion: "partial", text: "本关尚未完成", stageIndex: 4,
      points: [[1912400, 0, 86100, 195700], [1917700, -350, 86200, 195920]] },
    { gameCompleted: null, completed: false, completion: "partial", text: "线路未完整（缺少原生切关证据）", stageIndex: 3 },
    { gameCompleted: null, completed: true, completion: "complete", text: "完整线路（缺少原生切关证据）", stageIndex: 3 },
  ];
  for (const { text, stageIndex, ...state } of cases) {
    const f = fixture({ stageIndex, inspectionRouteStates: [state] });
    f.context = { ...f.context, routeGroupId: group().id, inspectionId: hash("d") };
    await f.panel.openHistorical();
    const player = f.elements.communityPlayers.children[0];
    assert.equal(player.children[2].textContent, `Mylu（${text}）`);
    assert.equal(player.children[0].checked, true);
    assert.equal(f.elements.communityStatus.textContent,
      `验收预览 · 1 条玩家轨迹 · ${text} · 不计入公开路线或热力统计。`);
    const overlay = f.scene.overlays.at(-1);
    assert.equal(overlay.mode, "routes"); assert.equal(overlay.stageIndex, stageIndex);
    assert.equal(overlay.routes[0].gameCompleted, state.gameCompleted);
    assert.equal(overlay.routes[0].completed, state.completed);
    assert.deepEqual(overlay.routes[0].breaks, state.breaks || []);
    assert.deepEqual(overlay.routes[0].points, state.points || stageResponse(group().id, stageIndex).routes[0].points);
    assert.ok(f.calls.every(call => !call.path.includes("/heatmap")), "inspection makes no aggregation requests");
    f.panel.dispose();
  }
});

test("default map exploration stays closed and makes no group or stage requests until the topbar toggle is opened", async () => {
  const f = fixture(); f.panel.sync(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityLayerControl.hidden, true);
  assert.equal(f.elements.appShell.classList.contains("community-panel-open"), false);
  f.context = { ...f.context, stageIndex: 2 }; f.panel.sync({ restore: true });
  await f.change("communityMode", "heatmap"); f.elements.communityRefresh.dispatch("click"); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.scene.overlays.at(-1).mode, "off");
  await f.toggle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, "/api/route-groups");
  assert.equal(f.elements.communityMode.value, "off"); assert.equal(f.elements.communityLayerControl.hidden, false);
  assert.equal(f.scene.overlays.at(-1).mode, "off"); assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "true");
  f.panel.dispose();
});

test("an explicit historical context opens routes pinned to its group while normal exploration stays closed", async () => {
  const historic = group(), other = group(hash("d"), hash("e"));
  const f = fixture({ groups: [other, historic], stageIndex: 3 });
  f.context = { ...f.context, routeGroupId: historic.id };
  await f.panel.openHistorical();
  assert.equal(f.elements.communityPanel.hidden, false);
  assert.equal(f.elements.communityMode.value, "routes");
  assert.equal(f.elements.communityGroup.value, historic.id); assert.equal(f.elements.communityGroup.disabled, true);
  assert.equal(f.scene.overlays.at(-1).mode, "routes"); assert.equal(f.scene.overlays.at(-1).stageIndex, 3);
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync(); await settle();
  assert.equal(f.scene.overlays.at(-1).stageIndex, 1);
  assert.ok(f.calls.filter(value => value.path !== "/api/route-groups").every(value => value.path.includes(historic.id)));
  f.context = { ...f.context, routeGroupId: null }; f.panel.sync(); await settle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityMode.value, "off");
  assert.equal(f.scene.overlays.at(-1).mode, "off");
  f.panel.dispose();
});

test("collapsing only hides settings; pending routes finish and remain visible across scene restore", async () => {
  const f = fixture({ deferStage: 0 }); await f.open();
  f.elements.communityMode.value = "heatmap"; f.elements.communityMode.dispatch("change");
  assert.equal(f.deferred.length, 2); assert.equal(f.elements.communityPanel.hidden, false);
  await f.toggle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityLayerControl.hidden, true);
  assert.equal(f.elements.communityMode.value, "heatmap"); assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "false");
  assert.equal(f.elements.appShell.classList.contains("community-panel-open"), false);
  assert.equal(f.scene.overlays.at(-1).mode, "off"); assert.ok(f.deferred.every(value => !value.options.signal.aborted));
  for (const pending of f.deferred) pending.resolve(); await settle();
  assert.equal(f.scene.overlays.at(-1).mode, "heatmap"); assert.equal(f.elements.communityPanel.hidden, true);
  const replacement = { overlays: [], setCommunityOverlay(value) { this.overlays.push(value); } }; f.scene = replacement;
  f.panel.sync({ restore: true });
  assert.equal(replacement.overlays.at(-1).mode, "heatmap");
  const requests = f.calls.length; await f.toggle();
  assert.equal(f.calls.length, requests); assert.equal(f.elements.communityMode.value, "heatmap");
  assert.equal(replacement.overlays.at(-1).mode, "heatmap"); assert.equal(f.elements.communityPanel.hidden, false);
  await f.change("communityMode", "off");
  assert.equal(replacement.overlays.at(-1).mode, "off");
  f.panel.dispose();
});

test("the dedicated mobile collapse button preserves members and selected layer, including hidden chapter changes", async () => {
  const f = fixture(); await f.open(); await f.change("communityMode", "routes");
  f.elements.communityCollapse.dispatch("click"); await settle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.scene.overlays.at(-1).mode, "routes");
  f.context = { ...f.context, stageIndex: 2 }; f.panel.sync(); await settle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.scene.overlays.at(-1).mode, "routes");
  assert.equal(f.scene.overlays.at(-1).stageIndex, 2);
  f.panel.dispose();
});

test("changing map identity closes the panel, clears its layer and waits for another explicit open", async () => {
  const f = fixture({ deferStage: 0 }); await f.open();
  f.elements.communityMode.value = "routes"; f.elements.communityMode.dispatch("change");
  const requests = f.calls.length;
  f.context = { ...f.context, mapPack: { ...map(), mapPackId: `sha256-${hash("f")}`, sceneName: "Level_9" } };
  f.panel.sync();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityMode.value, "off");
  assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "false"); assert.equal(f.calls.length, requests);
  assert.equal(f.scene.overlays.at(-1).mode, "off"); assert.equal(f.scene.overlays.at(-1).routes.length, 0);
  assert.ok(f.deferred.every(value => value.options.signal.aborted));
  for (const pending of f.deferred) pending.resolve(); await settle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.scene.overlays.at(-1).mode, "off");
  await f.toggle();
  assert.equal(f.calls.length, requests + 1); assert.equal(f.calls.at(-1).path, "/api/route-groups");
  assert.equal(f.elements.communityPanel.hidden, false); assert.equal(f.elements.communityMode.value, "off");
  f.panel.dispose();
});

test("changing the selected chapter clears the old scene overlay while waiting for actual stage data", async () => {
  const f = fixture({ deferStage: 1 }); await f.open(); await f.change("communityMode", "routes");
  assert.equal(f.scene.overlays.at(-1).stageIndex, 0); assert.equal(f.scene.overlays.at(-1).mode, "routes");
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  const waiting = f.scene.overlays.at(-1);
  assert.equal(waiting.mode, "off"); assert.equal(waiting.stageIndex, 1); assert.equal(waiting.routes.length, 0); assert.equal(waiting.heatmap, null);
  assert.equal(f.elements.communityStatus.dataset.state, "loading");
  assert.equal(f.elements.communityPanel.hidden, false); assert.equal(f.elements.communityMode.value, "routes");
  for (const pending of f.deferred) pending.resolve(); await settle();
  assert.equal(f.scene.overlays.at(-1).mode, "routes"); assert.equal(f.scene.overlays.at(-1).stageIndex, 1);
  f.panel.dispose();
});

test("whole-map overview removes the overlay and does not claim or fetch combined chapter statistics", async () => {
  const f = fixture(); await f.open(); await f.change("communityMode", "heatmap");
  const requests = f.calls.length;
  f.context = { ...f.context, stageIndex: null }; f.panel.sync(); await settle();
  assert.equal(f.calls.length, requests); assert.equal(f.scene.overlays.at(-1).stageIndex, null);
  assert.equal(f.scene.overlays.at(-1).routes.length, 0); assert.equal(f.scene.overlays.at(-1).heatmap, null);
  assert.match(f.elements.communityStatus.textContent, /选择一个关卡/); assert.equal(f.elements.communityLegend.hidden, true);
  f.panel.dispose();
});

test("restore reapplies the cached overlay to a reconstructed scene without refetching data or changing selection", async () => {
  const f = fixture(); await f.open(); await f.change("communityMode", "heatmap");
  await f.change("communityHeight", "1");
  const prior = f.scene.overlays.at(-1), requests = f.calls.length;
  const replacement = { overlays: [], setCommunityOverlay(value) { this.overlays.push(value); } }; f.scene = replacement;
  f.panel.sync({ restore: true }); await settle();
  assert.equal(f.calls.length, requests); assert.equal(replacement.overlays.length, 1);
  assert.equal(replacement.overlays[0].mode, "heatmap"); assert.equal(replacement.overlays[0].heatmap, prior.heatmap);
  assert.equal(replacement.overlays[0].routes, prior.routes); assert.equal(replacement.overlays[0].heightBand, 1);
  assert.equal(f.elements.communityHeight.value, "1");
  f.panel.dispose();
});

test("player checkbox updates retain group, difficulty and altitude selections and preserve other player visibility", async () => {
  const f = fixture({ groups: [group(), group(hash("d"), hash("e"))] });
  await f.open(); await f.change("communityMode", "routes"); await f.change("communityGroup", hash("d"));
  await f.change("communityDifficulty", "ascent3"); await f.change("communityHeight", "1");
  const requests = f.calls.length, originalRoutes = f.scene.overlays.at(-1).routes;
  assert.equal(f.elements.communityPlayers.children[0].children[2].textContent, '<img src=x onerror="alert(1)">');
  let checkbox = f.elements.communityPlayers.children[0].children[0]; checkbox.checked = false; checkbox.dispatch("change");
  assert.deepEqual([...f.scene.overlays.at(-1).visiblePlayers], ["two"]);
  assert.equal(f.elements.communityGroup.value, hash("d")); assert.equal(f.elements.communityDifficulty.value, "ascent3");
  assert.equal(f.elements.communityHeight.value, "1"); assert.equal(f.calls.length, requests); assert.equal(f.scene.overlays.at(-1).routes, originalRoutes);
  assert.equal(f.elements.communityPlayers.children[0].children[0].checked, false); assert.equal(f.elements.communityPlayers.children[1].children[0].checked, true);
  checkbox = f.elements.communityPlayers.children[1].children[0]; checkbox.checked = false; checkbox.dispatch("change");
  assert.deepEqual([...f.scene.overlays.at(-1).visiblePlayers], []);
  assert.equal(f.elements.communityPlayers.children[0].children[0].checked, false);
  await f.change("communityMode", "heatmap"); await f.change("communityMode", "routes");
  assert.equal(f.calls.length, requests); assert.equal(f.elements.communityPlayers.children[0].children[0].checked, false);
  assert.equal(f.elements.communityPlayers.children[1].children[0].checked, false);
  f.panel.dispose();
});

test("late chapter requests cannot restore the overlay after the panel is disabled", async () => {
  const f = fixture({ stageIndex: 1, deferStage: 1 }); await f.open();
  f.elements.communityMode.value = "heatmap"; f.elements.communityMode.dispatch("change");
  assert.equal(f.deferred.length, 2);
  f.context = { ...f.context, enabled: false }; f.panel.sync();
  assert.ok(f.deferred.every(value => value.options.signal.aborted));
  const overlays = f.scene.overlays.length;
  for (const pending of f.deferred) pending.resolve(); await settle();
  assert.equal(f.scene.overlays.length, overlays); assert.equal(f.scene.overlays.at(-1).mode, "off");
  assert.equal(f.elements.communityPanel.hidden, true);
  f.panel.dispose();
});

test("panel disposal clears the scene and detaches all UI event ports", async () => {
  const f = fixture(); await f.open(); await f.change("communityMode", "routes");
  f.panel.dispose(); const before = f.calls.length, overlays = f.scene.overlays.length;
  assert.equal(f.scene.overlays.at(-1).mode, "off");
  for (const id of ["communityMode", "communityGroup", "communityDifficulty", "communityHeight"]) await f.change(id, "ignored");
  f.elements.communityRefresh.dispatch("click"); await f.toggle(); f.panel.sync({ restore: true }); await settle();
  assert.equal(f.calls.length, before); assert.equal(f.scene.overlays.length, overlays);
});

test("panel hidden attributes remain effective against its flex and grid presentation rules", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const hiddenRule = css.match(/\.community-layer-control\[hidden\][^{}]*\{[^}]+\}/)?.[0];
  assert.ok(hiddenRule, "the integrated panel has an explicit hidden-state CSS rule");
  for (const selector of [".community-layer-control[hidden]", ".community-section[hidden]", ".community-filters[hidden]",
    ".community-filters label[hidden]", ".community-legend[hidden]"]) assert.ok(hiddenRule.includes(selector), selector);
  assert.match(hiddenRule, /display\s*:\s*none/);
});

function sampleTeam(overrides = {}) {
  return { id: hash("6"), groupId: group().id, startedUtc: "2026-10-08T13:44:03Z", difficulty: { label: "登山 0" },
    map: { buildId: map().gameBuildId, scene: map().sceneName, levelIndex: 480 },
    members: [{ playerKey: hash("1"), name: "Mylu" }, { playerKey: hash("2"), name: "队友" }], stageSummaries: [], ...overrides };
}

test("team search requires form submission, displays safe member text and can open the full team", async () => {
  const selected = sampleTeam({ members: [{ playerKey: hash("1"), name: '<script>alert("name")</script>' }, { playerKey: hash("2"), name: "Mylu" }] });
  const f = fixture({ teams: [selected] }); await f.open();
  f.elements.communityMemberSearch.value = "Mylu"; f.elements.communityMemberSearch.dispatch("input"); await settle();
  assert.equal(f.calls.filter(call => call.path.startsWith("/api/route-teams?")).length, 0);
  f.elements.communitySearchForm.dispatch("submit"); await settle();
  assert.equal(f.elements.communityTeamResults.children.length, 1);
  const result = f.elements.communityTeamResults.children[0];
  assert.match(result.textContent, /登山 0/); assert.match(result.textContent, /<script>/); assert.equal(result.children.length, 0);
  result.dispatch("click"); await settle();
  assert.equal(f.scene.overlays.at(-1).mode, "team"); assert.equal(f.scene.overlays.at(-1).teamId, selected.id);
  assert.deepEqual([...f.scene.overlays.at(-1).visiblePlayers], [hash("1"), hash("2")]);
  assert.equal(f.elements.communityPlayers.children.length, 2); assert.match(f.elements.communityPlayers.children[1].children[2].textContent, /本关尚未完成/);
  await f.change("communityReference", hash("2")); assert.equal(f.scene.overlays.at(-1).referencePlayerKey, hash("2"));
  f.elements.communityAllPlayers.checked = false; f.elements.communityAllPlayers.dispatch("change");
  assert.equal(f.scene.overlays.at(-1).visiblePlayers.size, 0);
  f.elements.communityCollapse.dispatch("click");
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.scene.overlays.at(-1).mode, "team");
  assert.equal(f.scene.overlays.at(-1).visiblePlayers.size, 0);
  f.panel.dispose();
});

test("searching another map opens that team's original model instead of drawing on the current map", async () => {
  const remote = sampleTeam({ groupId: hash("7"), map: { buildId: "25739797", scene: "Level_18" } });
  const f = fixture({ teams: [remote], navigateTeams: true }); await f.open();
  f.elements.communityMemberSearch.value = "Mylu"; f.elements.communitySearchScope.value = "all";
  f.elements.communitySearchForm.dispatch("submit"); await settle();
  const parameters = new URL(f.calls.at(-1).path, "https://example.invalid").searchParams;
  assert.equal(parameters.has("group"), false);
  f.elements.communityTeamResults.children[0].dispatch("click"); await settle();
  assert.deepEqual(f.openedTeams, [remote]); assert.equal(f.scene.overlays.at(-1).mode, "off");
  assert.equal(f.calls.filter(call => call.path.includes(`/route-teams/${remote.id}/stages/`)).length, 0);
  f.panel.dispose();
});

test("same-map teams also use the shareable navigation callback and clearing the team removes the URL selection", async () => {
  const selected = sampleTeam(), f = fixture({ teams: [selected], navigateTeams: true }); await f.open();
  f.elements.communityMemberSearch.value = "Mylu"; f.elements.communitySearchForm.dispatch("submit"); await settle();
  f.elements.communityTeamResults.children[0].dispatch("click"); await settle();
  assert.deepEqual(f.openedTeams, [selected]); assert.equal(f.calls.filter(call => call.path.includes(`/route-teams/${selected.id}/stages/`)).length, 0);
  f.context = { ...f.context, routeGroupId: group().id, teamId: selected.id }; await f.panel.openHistorical();
  assert.equal(f.scene.overlays.at(-1).teamId, selected.id); assert.equal(f.scene.overlays.at(-1).mode, "team");
  f.elements.communityTeamClear.dispatch("click"); await settle();
  assert.deepEqual(f.openedTeams, [selected, null]);
  f.panel.dispose();
});

test("team member counts distinguish partial observations and empty members without inventing paths", async () => {
  const selected = sampleTeam();
  for (const allEmpty of [false, true]) {
    const f = fixture({ teams: [selected], teamRouteStates: [
      { completion: "partial", completed: false, gameCompleted: true, breaks: [100], ...(allEmpty ? { points: [] } : {}) },
      { points: [], completion: "partial", completed: false, gameCompleted: null },
    ] });
    f.context = { ...f.context, routeGroupId: group().id, teamId: selected.id }; await f.panel.openHistorical();
    assert.equal(f.elements.communityPlayers.children.length, 2);
    assert.equal(f.elements.communityPlayers.children[1].children[2].textContent, "队友（本关无记录）");
    assert.equal(f.elements.communityPlayers.children[1].children[0].checked, true, "an unrecorded member is still independently selectable");
    assert.deepEqual(f.scene.overlays.at(-1).routes[1].points, [], "empty coordinates pass through unchanged");
    if (allEmpty) {
      assert.equal(f.elements.communityStatus.textContent, "本队 2 位队员 · 本关暂无录制轨迹。");
      assert.equal(f.elements.communityStatus.dataset.state, "empty");
      assert.equal(f.elements.communityPlayers.children[0].children[2].textContent, "Mylu（本关无记录）");
      assert.ok(f.scene.overlays.at(-1).routes.every(route => !route.points.length));
    } else {
      assert.match(f.elements.communityStatus.textContent, /^本队 2 位队员 · 1 位有本关轨迹 · 已完成本关 · 线路有断点/);
      assert.equal(f.elements.communityStatus.dataset.state, "ready");
      assert.equal(f.elements.communityPlayers.children[0].children[2].textContent, "Mylu（已完成本关 · 线路有断点）");
    }
    f.panel.dispose();
  }
});
