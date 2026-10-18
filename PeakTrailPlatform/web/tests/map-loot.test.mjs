import assert from "node:assert/strict";
import test from "node:test";
import { createMapLootLoader, lootForLayers, normalizeMapLoot } from "../src/map-loot.js";
import { createMapLootPanel } from "../src/map-loot-panel.js";

const pack = (character = "a") => ({ mapPackId: `sha256-${character.repeat(64)}`, mapSlot: 0, sceneName: "Level_0",
  gameBuildId: "25306743", source: { sceneSha256: "f".repeat(64) }, layers: [
    { id: "shore", segment: 0, biome: "Shore" }, { id: "roots", segment: 1, biome: "Roots" }, { id: "void", segment: 5, biome: "Void" }] });
const marker = (id, type, segment = 0, layerId = "shore") => ({ id, type, category: type === "berry" ? "item" : "chest",
  name: type, pos: [2, 3, 4], segment, layerId, placement: "fixed" });
function catalog(map = pack()) {
  return { schemaVersion: 1, gameBuildId: map.gameBuildId, types: [
    { id: "small", name: "小行李箱", category: "chest" }, { id: "large", name: "大行李箱", category: "chest" },
    { id: "berry", name: "浆果", category: "item" }], maps: [{ mapPackId: map.mapPackId, mapSlot: map.mapSlot,
    sceneName: map.sceneName, sourceSceneSha256: map.source.sceneSha256,
    markers: [marker("a", "small"), marker("b", "large", 1, "roots"), marker("c", "berry"), marker("d", "small", 5, "void")] }] };
}

test("supply surveys require exact pack, build, source scene, slot and layer ownership", () => {
  const map = pack(), raw = catalog();
  assert.equal(normalizeMapLoot(raw, map).markers.length, 4);
  for (const change of [value => value.gameBuildId = "25739797", value => value.maps[0].mapPackId = pack("b").mapPackId,
    value => value.maps[0].sourceSceneSha256 = "0".repeat(64), value => value.maps[0].sceneName = "Level_2",
    value => value.maps[0].mapSlot = 2, value => value.maps[0].markers[0].layerId = "roots",
    value => value.maps[0].markers[0].source = { geometrySha256: "0".repeat(64) },
    value => value.maps.push(value.maps[0])]) {
    const altered = structuredClone(raw); change(altered); assert.equal(normalizeMapLoot(altered, map), null);
  }
});

test("malformed or ambiguous markers cannot become visible supplies", () => {
  for (const change of [value => value.pos[1] = Infinity, value => value.pos = [1, 2], value => value.type = "unknown",
    value => value.category = "item", value => value.placement = "guaranteed-random-loot", value => value.segment = -1]) {
    const raw = catalog(); change(raw.maps[0].markers[0]); assert.equal(normalizeMapLoot(raw, pack()), null);
  }
  const duplicate = catalog(); duplicate.maps[0].markers.push(duplicate.maps[0].markers[0]);
  assert.equal(normalizeMapLoot(duplicate, pack()), null);
});

test("overview and chapter supplies follow the rendered branch and exclude the separate Void", () => {
  const raw = normalizeMapLoot(catalog(), pack());
  assert.deepEqual(lootForLayers(raw.markers, pack().layers).map(marker => marker.id), ["a", "b", "c"]);
  assert.deepEqual(lootForLayers(raw.markers, pack().layers, 5).map(marker => marker.id), ["d"]);
  assert.deepEqual(lootForLayers(raw.markers, [pack().layers[0]], 1), []);
});

test("loader caches completed build surveys, verifies each selected map, and never caches a cancelled read", async () => {
  let calls = 0;
  const read = createMapLootLoader({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(catalog())); } });
  assert.equal((await read(pack())).markers.length, 4);
  assert.equal(await read(pack("b")), null); assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = createMapLootLoader({ fetchImpl: async () => { calls++; controller.abort(); return new Response(JSON.stringify(catalog())); } });
  assert.equal(await cancelled(pack(), { signal: controller.signal }), null);
  await cancelled(pack()); assert.equal(calls, 3);
});

function node() {
  const events = new Map();
  return { hidden: false, open: false, checked: false, value: "", type: "", textContent: "", children: [], dataset: {},
    style: { setProperty() {} }, classList: { toggle() {} },
    setAttribute() {}, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
    dispatch(type, target = this) { for (const fn of events.get(type) || []) fn({ target }); } };
}
function fixture(load) {
  const elements = Object.fromEntries(["mapLootMenu", "mapLootCount", "mapLootStatus", "mapLootEnabled", "mapLootTypes",
    "mapLootItems", "mapLootItemTypes", "mapLootItemCount", "mapLootAnimalSection", "mapLootAnimalTypes", "mapLootAnimalCount",
    "mapLootAll", "mapLootNone", "mapLootRetry"].map(id => [id, node()]));
  let context = { enabled: true, mapPack: pack(), stageIndex: 0 };
  const overlays = [];
  const panel = createMapLootPanel({ root: { getElementById: id => elements[id], createElement: node },
    getContext: () => context, getScene: () => ({ setMapLoot: overlay => overlays.push({ ...overlay, types: new Set(overlay.types) }) }),
    load: load || (async map => normalizeMapLoot(catalog(map), map)) });
  return { elements, overlays, panel, get context() { return context; }, set context(value) { context = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("panel defaults to all chest types, preserves focused rows and selection across chapters, and toggles fixed items", async () => {
  const f = fixture(); f.panel.sync(); await settle();
  assert.equal(f.elements.mapLootCount.textContent, "1"); assert.equal(f.overlays.at(-1).markers.length, 2);
  const row = f.elements.mapLootTypes.children[0], input = row.children[0];
  input.checked = false; f.elements.mapLootTypes.dispatch("change", input);
  assert.equal(f.elements.mapLootTypes.children[0], row); assert.equal(f.elements.mapLootCount.textContent, "0");
  f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch("change");
  assert.equal(f.elements.mapLootCount.textContent, "1"); assert.ok(f.overlays.at(-1).types.has("berry"));
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.elements.mapLootCount.textContent, "1"); assert.deepEqual(f.overlays.at(-1).markers.map(marker => marker.id), ["b"]);
  f.context = { ...f.context, stageIndex: 0 }; f.panel.sync();
  assert.equal(f.elements.mapLootTypes.children[0].children[0].checked, false);
  f.elements.mapLootNone.dispatch("click"); assert.equal(f.elements.mapLootCount.textContent, "0");
  f.elements.mapLootAll.dispatch("click"); assert.equal(f.elements.mapLootCount.textContent, "2");
  f.panel.dispose(); assert.equal(f.overlays.at(-1).enabled, false);
});

test("late supply requests cannot restore markers after another map or home navigation", async () => {
  const requests = [], f = fixture((map, { signal }) => new Promise(resolve => requests.push({ map, signal, resolve })));
  f.panel.sync(); await settle();
  f.context = { ...f.context, mapPack: pack("b") }; f.panel.sync(); await settle();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(normalizeMapLoot(catalog(), pack())); await settle();
  assert.equal(f.overlays.at(-1).enabled, false);
  f.context = { ...f.context, enabled: false }; f.panel.sync();
  requests[1].resolve(normalizeMapLoot(catalog(pack("b")), pack("b"))); await settle();
  assert.equal(f.elements.mapLootMenu.hidden, true); assert.equal(f.overlays.at(-1).enabled, false);
  f.panel.dispose();
});

test("capybaras have their own default-on animal filter and never join fixed-item selection", async () => {
  const raw = catalog();
  raw.types.push({ id: "animal-capybara", category: "animal", name: "豚豚崽", color: "#e6ac69" });
  raw.maps[0].markers.push({ ...marker("capybara", "animal-capybara"), category: "animal", name: "豚豚崽" });
  const normalized = normalizeMapLoot(raw, pack()); assert.ok(normalized);
  const f = fixture(async () => normalized); f.panel.sync(); await settle();
  assert.equal(f.elements.mapLootCount.textContent, "2");
  assert.equal(f.elements.mapLootAnimalCount.textContent, "1");
  assert.equal(f.elements.mapLootAnimalSection.hidden, false);
  assert.equal(f.elements.mapLootItems.checked, false);
  const input = f.elements.mapLootAnimalTypes.children[0].children[0];
  assert.equal(input.checked, true);
  input.checked = false; f.elements.mapLootAnimalTypes.dispatch("change", input);
  assert.equal(f.elements.mapLootCount.textContent, "1");
  f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch("change");
  assert.equal(f.overlays.at(-1).types.has("animal-capybara"), false);
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.elements.mapLootAnimalSection.hidden, true);
  f.context = { ...f.context, stageIndex: 0 }; f.panel.sync();
  assert.equal(f.elements.mapLootAnimalTypes.children[0].children[0].checked, false);
  f.panel.dispose();
});
