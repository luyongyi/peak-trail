import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCommunityMapPanel } from "../src/community-map-panel.js";

const ids = ["appShell", "communityToggle", "communityLayerControl", "communityMode", "communityPanel", "communityRefresh", "communityStatus", "communityFilters",
  "communityGroupField", "communityGroup", "communityDifficulty", "communityHeight", "communityLegend", "communityPlayers"];
const hash = character => character.repeat(64);
const route = ["Shore", "Roots", "Alpine", "Volcano", "Kiln"];
function map() {
  return { mapPackId: `sha256-${hash("a")}`, gameBuildId: "25306743", sceneName: "Level_8",
    route: { branch: "volcano-kiln", segments: ["Shore", "Roots", "Alpine", "Volcano", "Volcano"].map((biome, index) => ({ index, biome })) },
    layers: route.map((_, segment) => ({ segment })) };
}
function group(id = hash("b"), layoutKey = hash("c")) {
  return { id, mapPackId: map().mapPackId, mapCompatibility: "matched",
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
  const common = { groupId: id, stageIndex, mapCompatibility: "matched", mapPackId: map().mapPackId, totalRouteCount: 2 };
  return heat ? { ...common, routeCount: 2, cellSizeCm: 200, heightBandCm: 200, cells: [[0, 0, 0, 1], [1, 1, 1, 1]] }
    : { ...common, truncated: false, routes: [{ id: "one", name: '<img src=x onerror="alert(1)">',
      points: [[0, 0, 100, 0], [100, 100, 300, 100]], breaks: [] },
      { id: "two", name: "登山者", points: [[0, 200, 100, 0], [100, 300, 100, 100]], breaks: [] }] };
}
function fixture({ groups = [group()], enabled = true, stageIndex = 0, deferStage = null } = {}) {
  const elements = Object.fromEntries(ids.map(id => [id, node()]));
  const root = { getElementById: id => elements[id], createElement: node };
  const calls = [], deferred = [], firstScene = { overlays: [], setCommunityOverlay(value) { this.overlays.push(value); } };
  let context = { enabled, mapPack: map(), stageIndex }, scene = firstScene;
  const fetchImpl = async (path, options) => {
    calls.push({ path, ...options });
    if (path === "/api/route-groups") return response({ groups });
    const match = path.match(/\/([a-f0-9]{64})\/stages\/(\d+)\/(routes|heatmap)/);
    assert.ok(match, `unexpected API path ${path}`);
    const body = stageResponse(match[1], Number(match[2]), match[3] === "heatmap");
    if (Number(match[2]) === deferStage) return new Promise(resolve => deferred.push({ options, resolve: () => resolve(response(body)) }));
    return response(body);
  };
  const panel = createCommunityMapPanel({ root, getContext: () => context, getScene: () => scene, fetchImpl });
  async function change(id, value) { elements[id].value = value; elements[id].dispatch("change"); await settle(); }
  async function toggle() { elements.communityToggle.dispatch("click"); await settle(); }
  async function open() { panel.sync(); await toggle(); }
  return { elements, calls, deferred, panel, firstScene, change, toggle, open,
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

test("closing the panel aborts route reads immediately, stays closed across scene restore and reopens without automatic routes", async () => {
  const f = fixture({ deferStage: 0 }); await f.open();
  f.elements.communityMode.value = "heatmap"; f.elements.communityMode.dispatch("change");
  assert.equal(f.deferred.length, 2); assert.equal(f.elements.communityPanel.hidden, false);
  await f.toggle();
  assert.equal(f.elements.communityPanel.hidden, true); assert.equal(f.elements.communityLayerControl.hidden, true);
  assert.equal(f.elements.communityMode.value, "off"); assert.equal(f.elements.communityToggle.attributes["aria-expanded"], "false");
  assert.equal(f.elements.appShell.classList.contains("community-panel-open"), false);
  assert.equal(f.scene.overlays.at(-1).mode, "off"); assert.ok(f.deferred.every(value => value.options.signal.aborted));
  const replacement = { overlays: [], setCommunityOverlay(value) { this.overlays.push(value); } }; f.scene = replacement;
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync({ restore: true });
  assert.equal(replacement.overlays.at(-1).mode, "off");
  for (const pending of f.deferred) pending.resolve(); await settle();
  assert.equal(replacement.overlays.at(-1).mode, "off"); assert.equal(f.elements.communityPanel.hidden, true);
  const requests = f.calls.length; await f.toggle();
  assert.equal(f.calls.length, requests); assert.equal(f.elements.communityMode.value, "off");
  assert.equal(replacement.overlays.at(-1).mode, "off"); assert.equal(f.elements.communityPanel.hidden, false);
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
