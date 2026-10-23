import assert from "node:assert/strict";
import test from "node:test";
import { createMapLootLoader, lootForLayers, normalizeMapLoot } from "../src/map-loot.js";
import { createMapLootPanel } from "../src/map-loot-panel.js";
import { getLocale, setLocale } from '../src/i18n.js';

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

test("serialized item sites retain their scene identity and distinguish a candidate from a live pickup", () => {
  const raw = catalog();
  const site = raw.maps[0].markers.find(value => value.type === "berry");
  site.placement = "randomized-candidate";
  site.source = { sourceKind: "serialized-scene-component", sceneSha256: pack().source.sceneSha256,
    component: "BerryBush", componentPathId: "9223372036854775807", anchor: "component-world-position" };
  const normalized = normalizeMapLoot(raw, pack());
  assert.equal(normalized.markers.find(value => value.id === site.id).placement, "randomized-candidate");
  assert.equal(normalized.markers.find(value => value.id === site.id).source.componentPathId, site.source.componentPathId);
  for (const [field, value] of [["sceneSha256", "0".repeat(64)], ["sceneSha256", ""],
    ["componentPathId", Number(site.source.componentPathId)], ["componentPathId", "0"],
    ["component", ""], ["anchor", "assumed-final-item-position"]]) {
    const changed = structuredClone(raw);
    changed.maps[0].markers.find(value => value.type === "berry").source[field] = value;
    assert.equal(normalizeMapLoot(changed, pack()), null, field);
  }
});

test("overview and chapter supplies follow the rendered branch and exclude the separate Void", () => {
  const raw = normalizeMapLoot(catalog(), pack());
  assert.deepEqual(lootForLayers(raw.markers, pack().layers).map(marker => marker.id), ["a", "b", "c"]);
  assert.deepEqual(lootForLayers(raw.markers, pack().layers, 5).map(marker => marker.id), ["d"]);
  assert.deepEqual(lootForLayers(raw.markers, [pack().layers[0]], 1), []);
});

test("the statue reward uses only its authenticated gemSpot reference and remains conditional", () => {
  const raw = catalog();
  raw.types.push({ id: "item-scout-statue-reward", category: "item", name: "终局雕像奖励点" });
  const site = { ...marker("reward", "berry"), type: "item-scout-statue-reward", placement: "randomized-candidate",
    source: { sourceKind: "serialized-scene-component", sceneSha256: pack().source.sceneSha256,
      component: "ScoutStatue", componentPathId: "123", anchor: "referenced-transform-world-position",
      transformField: "gemSpot", transformPathId: "456" } };
  raw.maps[0].markers.push(site);
  assert.ok(normalizeMapLoot(raw, pack()));
  for (const change of [marker => marker.source.transformField = "guessed",
    marker => marker.source.transformPathId = "0", marker => marker.source.component = "SingleItemSpawner",
    marker => marker.source.anchor = "component-world-position", marker => marker.placement = "fixed",
    marker => marker.source.sourceKind = "unknown", marker => delete marker.source.sourceKind,
    marker => marker.type = "berry",
    marker => { marker.type = "berry"; marker.source.anchor = "component-world-position"; },
    marker => { marker.scope = "global"; marker.segment = -1; marker.layerId = "global";
      marker.source.scopeRoot = "MapHandler.globalParent"; }]) {
    const changed = structuredClone(raw); change(changed.maps[0].markers.at(-1));
    assert.equal(normalizeMapLoot(changed, pack()), null);
  }
});

test("authenticated global resources keep their source scope and use chapter bounds only for display", () => {
  const map = pack();
  Object.assign(map.layers[0], { minX: -10, maxX: 10, minY: -10, maxY: 10, minZ: -10, maxZ: 10 });
  Object.assign(map.layers[1], { minX: 100, maxX: 200, minY: 100, maxY: 200, minZ: 100, maxZ: 200 });
  const raw = catalog(map);
  const global = { ...marker("global", "berry", -1, "global"), scope: "global",
    source: { sourceKind: "serialized-scene-component", component: "SingleItemSpawner", componentPathId: "321",
      anchor: "component-world-position", sceneSha256: map.source.sceneSha256, scopeRoot: "MapHandler.globalParent" } };
  raw.maps[0].markers.push(global);
  const normalized = normalizeMapLoot(raw, map);
  assert.ok(normalized);
  assert.equal(normalized.markers.at(-1).segment, -1);
  assert.ok(lootForLayers(normalized.markers, map.layers, 0).some(marker => marker.id === "global"));
  assert.ok(!lootForLayers(normalized.markers, map.layers, 1).some(marker => marker.id === "global"));
  assert.ok(!lootForLayers(normalized.markers, map.layers, 5).some(marker => marker.id === "global"));
  assert.ok(lootForLayers(normalized.markers, map.layers).some(marker => marker.id === "global"));
  for (const change of [marker => marker.source.scopeRoot = "guessed-from-height",
    marker => marker.source.geometrySha256 = "a".repeat(64), marker => marker.segment = 0,
    marker => marker.source.sceneSha256 = "0".repeat(64), marker => marker.source.sourceKind = "unknown"]) {
    const changed = structuredClone(raw); change(changed.maps[0].markers.at(-1));
    assert.equal(normalizeMapLoot(changed, map), null);
  }
});

test("partial resource coverage remains visible as a version limitation", async () => {
  const raw = catalog(); raw.source = { kind: "canonical-map-geometry-survey" };
  const normalized = normalizeMapLoot(raw, pack());
  assert.equal(normalized.itemCoverage, "partial");
  const f = fixture(async () => normalized); f.panel.sync(); await settle();
  assert.match(f.elements.mapLootStatus.textContent, /部分物品点待整理/);
  f.panel.dispose();
  raw.source.componentCoverage = "Authenticated serialized item and plant controllers.";
  assert.equal(normalizeMapLoot(raw, pack()).itemCoverage, "expanded");
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

test('localized names stay optional for legacy surveys and reject malformed English metadata', () => {
  const raw = catalog();
  raw.types[0].nameEn = 'LUGGAGE';
  assert.equal(normalizeMapLoot(raw, pack()).types[0].nameEn, 'LUGGAGE');
  for (const invalid of ['', ' ', 5, 'x'.repeat(129)]) {
    const changed = structuredClone(raw); changed.types[0].nameEn = invalid;
    assert.equal(normalizeMapLoot(changed, pack()), null);
  }
  delete raw.types[0].nameEn;
  assert.ok(normalizeMapLoot(raw, pack()));
});

function indexedCatalog(maps = [pack(), pack("b")]) {
  return { schemaVersion: 1, kind: "map-loot-index", gameBuildId: maps[0].gameBuildId,
    maps: maps.map(map => ({ mapPackId: map.mapPackId, sceneName: map.sceneName, mapSlot: map.mapSlot,
      sourceSceneSha256: map.source.sceneSha256, path: `loot/${map.gameBuildId}/${map.mapPackId}.json` })) };
}

test("indexed surveys download only the selected map and reuse completed map responses", async () => {
  const calls = [], index = indexedCatalog();
  const read = createMapLootLoader({ fetchImpl: async url => {
    calls.push(url.pathname);
    const map = url.pathname.includes(pack("b").mapPackId) ? pack("b") : pack();
    return new Response(JSON.stringify(url.pathname.endsWith("loot.25306743.json") ? index : catalog(map)));
  } });
  assert.equal((await read(pack())).markers.length, 4);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith(index.maps[0].path));
  await read(pack("b")); assert.equal(calls.length, 3);
  await read(pack()); assert.equal(calls.length, 3);
  assert.equal(await read(pack("c")), null); assert.equal(calls.length, 3);
});

test("a 208-map index reads only the selected scene and still bounds oversized indexes", async () => {
  const maps = Array.from({ length: 208 }, (_, slot) => ({ ...pack(), gameBuildId: "26134529",
    mapPackId: `sha256-${slot.toString(16).padStart(64, "0")}`, sceneName: `Level_${slot}`, mapSlot: slot }));
  const selected = maps[207], index = indexedCatalog(maps), calls = [];
  const read = createMapLootLoader({ fetchImpl: async url => {
    calls.push(url.pathname);
    return new Response(JSON.stringify(calls.length === 1 ? index : catalog(selected)));
  } });
  assert.equal((await read(selected)).markers.length, 4);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith(index.maps[207].path));
  const oversized = { ...index, maps: [...index.maps, ...index.maps, ...index.maps] };
  const reject = createMapLootLoader({ fetchImpl: async () => new Response(JSON.stringify(oversized)) });
  assert.equal(await reject(selected), null);
});

test("map indexes cannot redirect item requests or relabel another scene", async () => {
  for (const change of [index => index.gameBuildId = "25739797",
    index => index.maps[0].path = "https://example.com/private.json",
    index => index.maps[0].path = "../other-map.json",
    index => index.maps[0].sourceSceneSha256 = "0".repeat(64),
    index => index.maps.push(index.maps[0])]) {
    const index = indexedCatalog(); change(index); let calls = 0;
    const read = createMapLootLoader({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(index)); } });
    assert.equal(await read(pack()), null); assert.equal(calls, 1);
  }
  const index = indexedCatalog(); let calls = 0;
  const read = createMapLootLoader({ fetchImpl: async () => new Response(JSON.stringify(++calls === 1 ? index : catalog(pack("b")))) });
  assert.equal(await read(pack()), null, "a valid index cannot authenticate the wrong map payload");
});

test("cancelling a per-map read keeps the completed index but never caches that map", async () => {
  const controller = new AbortController(); let calls = 0;
  const read = createMapLootLoader({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify(indexedCatalog()));
    if (calls === 2) controller.abort();
    return new Response(JSON.stringify(catalog()));
  } });
  assert.equal(await read(pack(), { signal: controller.signal }), null);
  assert.equal((await read(pack())).markers.length, 4); assert.equal(calls, 3);
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

test('switching marker language preserves filters and positions without fetching the map again', async () => {
  const previous = getLocale(); setLocale('zh-CN', { persist: false });
  let requests = 0;
  const raw = catalog();
  raw.types[0].nameEn = 'LUGGAGE'; raw.types[2].nameEn = 'Crispberry growth site';
  const f = fixture(async () => { requests++; return normalizeMapLoot(raw, pack()); });
  try {
    f.panel.sync(); await settle();
    f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch('change');
    const chest = f.elements.mapLootTypes.children[0].children[0];
    chest.checked = true; f.elements.mapLootTypes.dispatch('change', chest);
    const before = f.overlays.at(-1);
    setLocale('en', { persist: false });
    assert.equal(f.elements.mapLootTypes.children[0].children[2].textContent, 'LUGGAGE');
    assert.equal(f.elements.mapLootItemTypes.children[0].children[2].textContent, 'Crispberry growth site');
    assert.match(f.elements.mapLootStatus.textContent, /Current chapter/);
    assert.equal(requests, 1);
    assert.deepEqual(f.overlays.at(-1).types, before.types);
    assert.deepEqual(f.overlays.at(-1).markers.map(marker => [marker.id, marker.pos]), before.markers.map(marker => [marker.id, marker.pos]));
    assert.equal(f.overlays.at(-1).markers.find(marker => marker.type === 'small').name, 'LUGGAGE');
    assert.equal(f.elements.mapLootTypes.children[0].children[0].checked, true);
    setLocale('zh-CN', { persist: false });
    assert.equal(f.elements.mapLootTypes.children[0].children[2].textContent, '小行李箱');
    f.panel.dispose();
    const count = f.overlays.length;
    setLocale('en', { persist: false });
    assert.equal(f.overlays.length, count, 'disposed panels unsubscribe from locale changes');
  } finally { f.panel.dispose(); setLocale(previous, { persist: false }); }
});

test("panel leaves chests off by default, preserves manual selection across chapters, and toggles fixed items", async () => {
  const f = fixture(); f.panel.sync(); await settle();
  assert.equal(f.elements.mapLootCount.textContent, "0"); assert.equal(f.overlays.at(-1).markers.length, 2);
  assert.equal(f.overlays.at(-1).types.has("small"), false);
  assert.equal(f.overlays.at(-1).types.has("large"), false);
  const row = f.elements.mapLootTypes.children[0], input = row.children[0];
  input.checked = true; f.elements.mapLootTypes.dispatch("change", input);
  assert.equal(f.elements.mapLootTypes.children[0], row); assert.equal(f.elements.mapLootCount.textContent, "1");
  f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch("change");
  assert.equal(f.elements.mapLootCount.textContent, "2"); assert.ok(f.overlays.at(-1).types.has("berry"));
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.elements.mapLootCount.textContent, "0"); assert.deepEqual(f.overlays.at(-1).markers.map(marker => marker.id), ["b"]);
  f.context = { ...f.context, stageIndex: 0 }; f.panel.sync();
  assert.equal(f.elements.mapLootTypes.children[0].children[0].checked, true);
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

test("the resource master switch also enables item types found only in other chapters or later maps", async () => {
  const f = fixture(async map => {
    const raw = catalog(map);
    raw.types.push({ id: "backpack", name: "背包生成点", category: "item" });
    raw.maps[0].markers.push({ ...marker("backpack", "berry", 1, "roots"), type: "backpack" });
    if (map.mapPackId === pack("b").mapPackId) {
      raw.types.push({ id: "coconut", name: "椰树生长点", category: "item" });
      raw.maps[0].markers.push({ ...marker("coconut", "berry"), type: "coconut" });
    }
    return normalizeMapLoot(raw, map);
  });
  f.panel.sync(); await settle();
  f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch("change");
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.elements.mapLootItems.checked, true);
  assert.ok(f.overlays.at(-1).types.has("backpack"));
  f.context = { ...f.context, mapPack: pack("b"), stageIndex: 0 }; f.panel.sync(); await settle();
  assert.ok(f.overlays.at(-1).types.has("coconut"), "newly discovered resources follow the enabled category");
  f.elements.mapLootItems.checked = false; f.elements.mapLootItems.dispatch("change");
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.overlays.at(-1).types.has("backpack"), false);
  f.panel.dispose();
});

test("capybaras have their own default-on animal filter and never join fixed-item selection", async () => {
  const raw = catalog();
  raw.types.push({ id: "animal-capybara", category: "animal", name: "水豚", color: "#e6ac69" });
  raw.maps[0].markers.push({ ...marker("capybara", "animal-capybara"), category: "animal", name: "水豚" });
  const normalized = normalizeMapLoot(raw, pack()); assert.ok(normalized);
  const f = fixture(async () => normalized); f.panel.sync(); await settle();
  assert.equal(f.elements.mapLootCount.textContent, "1");
  assert.equal(f.elements.mapLootAnimalCount.textContent, "1");
  assert.equal(f.elements.mapLootAnimalSection.hidden, false);
  assert.equal(f.elements.mapLootItems.checked, false);
  const input = f.elements.mapLootAnimalTypes.children[0].children[0];
  assert.equal(input.checked, true);
  input.checked = false; f.elements.mapLootAnimalTypes.dispatch("change", input);
  assert.equal(f.elements.mapLootCount.textContent, "0");
  f.elements.mapLootItems.checked = true; f.elements.mapLootItems.dispatch("change");
  assert.equal(f.overlays.at(-1).types.has("animal-capybara"), false);
  f.context = { ...f.context, stageIndex: 1 }; f.panel.sync();
  assert.equal(f.elements.mapLootAnimalSection.hidden, true);
  f.context = { ...f.context, stageIndex: 0 }; f.panel.sync();
  assert.equal(f.elements.mapLootAnimalTypes.children[0].children[0].checked, false);
  f.panel.dispose();
});
