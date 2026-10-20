import { createMapLootLoader, lootForLayers, lootTypeName } from "./map-loot.js";
import { lootTypeStyle } from "./map-loot-style.js";
import { getLocale, tr, onLocaleChange, formatNumber } from './i18n.js';

export function createMapLootPanel({ getContext, getScene, root = document, load = createMapLootLoader() } = {}) {
  const $ = id => root.getElementById(id);
  const elements = Object.fromEntries(["mapLootMenu", "mapLootCount", "mapLootStatus", "mapLootEnabled", "mapLootTypes",
    "mapLootItems", "mapLootItemTypes", "mapLootItemCount", "mapLootAnimalSection", "mapLootAnimalTypes", "mapLootAnimalCount",
    "mapLootAll", "mapLootNone", "mapLootRetry"].map(id => [id, $(id)]));
  const listeners = [];
  let source = null, mapKey = null, controller = null, pending = null, error = "", disposed = false;
  let enabled = true;
  let allItems = false;
  const selected = new Set(), known = new Set();
  const typeInputs = new Map();
  let rowSource = null, rowKey = null, appliedSource = null, appliedKey = null, appliedMarkers = [];
  function listen(element, event, handler) { element.addEventListener(event, handler); listeners.push(() => element.removeEventListener(event, handler)); }
  function make(tag, className, text) {
    const element = root.createElement(tag); if (className) element.className = className;
    if (text !== undefined) element.textContent = text; return element;
  }
  function apply() {
    const context = getContext();
    const valid = context.enabled && source && context.mapPack?.mapPackId === source.mapPackId;
    const key = `${getLocale()}|${context.stageIndex ?? "all"}|${(context.layers || context.mapPack?.layers || []).map(layer => layer.id).join(",")}`;
    if (source !== appliedSource || key !== appliedKey) {
      const colors = new Map((source?.types || []).map(type => [type.id, type.color]));
      const names = new Map((source?.types || []).map(type => [type.id, lootTypeName(type)]));
      appliedMarkers = valid ? lootForLayers(source.markers, context.layers || context.mapPack.layers, context.stageIndex ?? null)
        .map(marker => ({ ...marker, name: names.get(marker.type) || marker.name, color: colors.get(marker.type) })) : [];
      appliedSource = source; appliedKey = key;
    }
    getScene()?.setMapLoot({ mapPackId: valid ? source.mapPackId : null, enabled: Boolean(valid && enabled),
      markers: valid ? appliedMarkers : [], types: selected });
  }
  function render() {
    if (disposed) return;
    const context = getContext();
    elements.mapLootMenu.hidden = !context.enabled || !context.mapPack;
    elements.mapLootEnabled.checked = enabled;
    elements.mapLootMenu.classList.toggle("has-markers", enabled && Boolean(source));
    const markers = source ? lootForLayers(source.markers, context.layers || context.mapPack?.layers, context.stageIndex ?? null) : [];
    const counts = new Map();
    for (const marker of markers) counts.set(marker.type, (counts.get(marker.type) || 0) + 1);
    const visible = enabled ? markers.filter(marker => selected.has(marker.type)).length : 0;
    elements.mapLootCount.textContent = String(visible);
    elements.mapLootCount.hidden = !source;
    elements.mapLootStatus.dataset.state = error ? "error" : pending ? "loading" : source ? "ready" : "missing";
    elements.mapLootStatus.textContent = error ? tr("地图标记加载失败，可重试。", "Unable to load map markers. Please retry.")
      : (pending ? tr("正在读取本图标记…", "Loading this map's markers…") : !source ? tr("此地图版本尚无标记数据。", "No markers are available for this map version yet.")
        : markers.length ? tr(`${context.stageIndex == null ? "整张地图" : "当前分区"} · 已显示 ${visible} / ${markers.length} 处`,
          `${context.stageIndex == null ? 'Whole map' : 'Current chapter'} · ${formatNumber(visible)} / ${formatNumber(markers.length)} shown`)
          : tr("当前分区没有已确认的地图标记", "No verified markers in this chapter."))
      + (!error && !pending && source?.itemCoverage === "partial" ? tr("\n此版本仍有部分物品点待整理", "\nSome item sites for this version are still being documented.") : "");
    elements.mapLootRetry.hidden = !error;
    elements.mapLootEnabled.disabled = !source;
    elements.mapLootAll.disabled = elements.mapLootNone.disabled = !source;
    const nextRowKey = `${getLocale()}|${context.stageIndex ?? "all"}|${(context.layers || context.mapPack?.layers || []).map(layer => layer.id).join(",")}`;
    if (rowSource !== source || rowKey !== nextRowKey) {
      rowSource = source; rowKey = nextRowKey; typeInputs.clear();
      const chestRows = [], itemRows = [], animalRows = [];
      for (const type of source?.types || []) {
        const count = counts.get(type.id) || 0;
        if (!count) continue;
        const label = make("label", "map-loot-type");
        const displayName = lootTypeName(type);
        label.title = displayName;
        label.style.setProperty("--loot-color", type.color || lootTypeStyle(type.id, type.category).color);
        const input = make("input"); input.type = "checkbox"; input.checked = selected.has(type.id); input.value = type.id;
        input.setAttribute("aria-label", displayName);
        typeInputs.set(type.id, input);
        const swatch = make("i", `map-loot-swatch is-${type.category}`); swatch.setAttribute("aria-hidden", "true");
        const name = make("span", "map-loot-type-name", displayName), number = make("span", "map-loot-type-count", String(count));
        label.append(input, swatch, name, number);
        (type.category === "chest" ? chestRows : type.category === "animal" ? animalRows : itemRows).push(label);
      }
      elements.mapLootTypes.replaceChildren(...chestRows);
      elements.mapLootItemTypes.replaceChildren(...itemRows);
      elements.mapLootAnimalTypes.replaceChildren(...animalRows);
    }
    for (const [type, input] of typeInputs) input.checked = selected.has(type);
    const itemTypes = (source?.types || []).filter(type => type.category === "item" && counts.has(type.id));
    elements.mapLootItems.checked = itemTypes.length > 0 && itemTypes.every(type => selected.has(type.id));
    elements.mapLootItems.indeterminate = itemTypes.some(type => selected.has(type.id)) && !elements.mapLootItems.checked;
    elements.mapLootItems.disabled = !itemTypes.length;
    elements.mapLootItemCount.textContent = String(markers.filter(marker => marker.category === "item").length);
    const animalCount = markers.filter(marker => marker.category === "animal").length;
    elements.mapLootAnimalSection.hidden = animalCount === 0;
    elements.mapLootAnimalCount.textContent = String(animalCount);
    apply();
  }
  async function request(map) {
    controller?.abort(); const abort = controller = new AbortController();
    source = null; error = "";
    const task = pending = Promise.resolve().then(() => load(map, { signal: abort.signal }));
    render();
    try {
      const data = await task;
      if (disposed || abort.signal.aborted || controller !== abort) return;
      source = data;
      for (const type of source?.types || []) if (!known.has(type.id)) {
        known.add(type.id); if (type.category === "animal" || type.category === "item" && allItems) selected.add(type.id);
      }
    } catch (exception) {
      if (disposed || abort.signal.aborted || controller !== abort) return;
      error = true;
    } finally {
      if (!disposed && controller === abort) { pending = null; render(); }
    }
  }
  function sync() {
    const context = getContext();
    if (!context.enabled || !context.mapPack) {
      controller?.abort(); controller = null; pending = null; mapKey = null; source = null;
      elements.mapLootMenu.open = false; render(); return;
    }
    if (mapKey !== context.mapPack.mapPackId) {
      mapKey = context.mapPack.mapPackId; void request(context.mapPack);
    } else render();
  }
  listen(elements.mapLootEnabled, "change", () => { enabled = elements.mapLootEnabled.checked; render(); });
  const changeType = event => {
    const input = event.target;
    if (input?.type !== "checkbox" || !known.has(input.value)) return;
    if (input.checked) selected.add(input.value); else selected.delete(input.value); render();
  };
  listen(elements.mapLootTypes, "change", changeType);
  listen(elements.mapLootItemTypes, "change", changeType);
  listen(elements.mapLootAnimalTypes, "change", changeType);
  listen(elements.mapLootItems, "change", () => {
    allItems = elements.mapLootItems.checked;
    for (const type of source?.types || []) if (type.category === "item") {
      if (allItems) selected.add(type.id); else selected.delete(type.id);
    }
    render();
  });
  for (const [key, checked] of [["mapLootAll", true], ["mapLootNone", false]]) listen(elements[key], "click", () => {
    allItems = checked;
    for (const type of source?.types || []) { if (checked) selected.add(type.id); else selected.delete(type.id); }
    enabled = true; render();
  });
  listen(elements.mapLootRetry, "click", () => { const context = getContext(); if (context.enabled && context.mapPack) void request(context.mapPack); });
  listen(elements.mapLootMenu, "keydown", event => {
    if (event.key === "Escape") { elements.mapLootMenu.open = false; elements.mapLootMenu.querySelector("summary")?.focus(); }
  });
  const unsubscribeLocale = onLocaleChange(render);
  return { sync, dispose() { disposed = true; unsubscribeLocale(); controller?.abort(); for (const remove of listeners) remove(); getScene()?.setMapLoot({ enabled: false }); } };
}
