import { getLocale, tr } from './i18n.js';

const idPattern = /^[a-z][a-z0-9_-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const packPattern = /^sha256-[a-f0-9]{64}$/;
const categories = new Set(["chest", "item", "animal"]);
// 3.0.0 has 208 native scenes; retain a finite bound for malformed indexes.
const MAX_SURVEY_MAPS = 512;

/** Scene placements are a build-specific survey; they never describe live loot. */
export function normalizeMapLoot(raw, mapPack) {
  if (!mapPack || raw?.schemaVersion !== 1 || String(raw.gameBuildId) !== String(mapPack.gameBuildId)
      || !Array.isArray(raw.maps) || raw.maps.length > MAX_SURVEY_MAPS || !Array.isArray(raw.types) || raw.types.length > 256) return null;
  const maps = raw.maps.filter(entry => entry?.mapPackId === mapPack.mapPackId);
  if (maps.length !== 1) return null;
  const entry = maps[0];
  if (!packPattern.test(entry.mapPackId) || entry.sceneName !== mapPack.sceneName
      || entry.mapSlot !== mapPack.mapSlot || !hashPattern.test(entry.sourceSceneSha256 || "")
      || entry.sourceSceneSha256 !== mapPack.source?.sceneSha256
      || !Array.isArray(entry.markers) || entry.markers.length > 50000) return null;
  const types = [], definitions = new Map();
  for (const type of raw.types) {
    if (!idPattern.test(type?.id || "") || definitions.has(type.id) || !categories.has(type.category)
        || typeof type.name !== "string" || !type.name.trim() || type.name.length > 100
        || type.nameEn !== undefined && (typeof type.nameEn !== "string" || !type.nameEn.trim() || type.nameEn.length > 128)) return null;
    const normalized = { id: type.id, category: type.category, name: type.name,
      ...(type.nameEn !== undefined ? { nameEn: type.nameEn } : {}),
      ...(typeof type.color === "string" && /^#[a-f0-9]{6}$/i.test(type.color) ? { color: type.color } : {}) };
    types.push(normalized); definitions.set(type.id, normalized);
  }
  const ids = new Set(), markers = [];
  const layers = new Map((mapPack.layers || []).map(layer => [layer.id, layer]));
  if (entry.layers && (!Array.isArray(entry.layers) || entry.layers.some(layer => {
    const mapped = layers.get(layer.id);
    return !mapped || mapped.segment !== layer.segment || mapped.geometrySha256 !== layer.geometrySha256;
  }))) return null;
  for (const marker of entry.markers) {
    const type = definitions.get(marker?.type);
    const layer = layers.get(marker?.layerId);
    const global = marker?.scope === "global";
    if (!type || marker.category !== type.category || typeof marker.id !== "string" || !marker.id || marker.id.length > 180
        || ids.has(marker.id) || !Array.isArray(marker.pos) || marker.pos.length !== 3
        || !marker.pos.every(value => Number.isFinite(value) && Math.abs(value) <= 100000)
        || !["fixed", "randomized-candidate"].includes(marker.placement)
        || marker.type === "item-scout-statue-reward" && marker.source?.sourceKind !== "serialized-scene-component"
        || marker.scope !== undefined && !["layer", "global"].includes(marker.scope)
        || (global ? marker.category !== "item" || marker.segment !== -1 || marker.layerId !== "global"
          || marker.source?.sourceKind !== "serialized-scene-component" || marker.source.scopeRoot !== "MapHandler.globalParent"
          || marker.source.geometrySha256 !== undefined
          : !Number.isInteger(marker.segment) || marker.segment < 0 || marker.segment > 63
            || !layer || layer.segment !== marker.segment
            || marker.source?.geometrySha256 && marker.source.geometrySha256 !== layer.geometrySha256)
        || marker.source?.sceneSha256 && marker.source.sceneSha256 !== entry.sourceSceneSha256) return null;
    if (marker.source?.sourceKind === "serialized-scene-component") {
      const source = marker.source;
      const reward = marker.type === "item-scout-statue-reward";
      if (!hashPattern.test(source.sceneSha256 || "")
          || typeof source.component !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(source.component)
          || typeof source.componentPathId !== "string" || !/^-?[1-9]\d{0,19}$/.test(source.componentPathId)
          || (reward ? global || source.component !== "ScoutStatue" || source.anchor !== "referenced-transform-world-position"
            || source.transformField !== "gemSpot" || typeof source.transformPathId !== "string"
            || !/^-?[1-9]\d{0,19}$/.test(source.transformPathId) || marker.placement !== "randomized-candidate"
            : source.component === "ScoutStatue" || source.anchor !== "component-world-position")) return null;
    }
    ids.add(marker.id);
    markers.push({ ...marker, name: typeof marker.name === "string" ? marker.name.slice(0, 100) : type.name, pos: [...marker.pos] });
  }
  return { mapPackId: entry.mapPackId, sceneName: entry.sceneName, sourceSceneSha256: entry.sourceSceneSha256,
    gameBuildId: String(raw.gameBuildId), types, markers,
    itemCoverage: raw.source?.componentCoverage ? "expanded"
      : raw.source?.kind === "canonical-map-geometry-survey" ? "partial" : null };
}

export function lootTypeName(type, locale = getLocale()) {
  return locale === 'en' && type?.nameEn ? type.nameEn : type?.name || '';
}

export function lootForLayers(markers, layers, segment = null) {
  const displayed = (layers || []).filter(layer => segment === null
    ? String(layer.biome).toLowerCase() !== "void" : layer.segment === segment);
  const allowed = new Set(displayed.map(layer => layer.id));
  return markers.filter(marker => {
    if (marker.scope !== "global") return allowed.has(marker.layerId) && (segment === null || marker.segment === segment);
    // Global spawners retain their native scope. A chapter only displays the
    // global points inside its original XYZ bounds; this does not assign them
    // a fabricated chapter. The mountain overview includes all global sites.
    const mountain = displayed.filter(layer => String(layer.biome).toLowerCase() !== "void");
    return segment === null ? mountain.length > 0 : mountain.some(layer => ["X", "Y", "Z"].every((axis, index) =>
      Number.isFinite(layer[`min${axis}`]) && Number.isFinite(layer[`max${axis}`])
        && marker.pos[index] >= layer[`min${axis}`] && marker.pos[index] <= layer[`max${axis}`]));
  });
}

export function createMapLootLoader({ fetchImpl = globalThis.fetch, baseUrl = new URL("../../data/maps/", import.meta.url) } = {}) {
  const cache = new Map(), mapCache = new Map();
  async function readSurvey(path, signal) {
    const response = await fetchImpl(new URL(path, baseUrl), { signal, cache: "no-cache" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(tr("物资点位暂时无法读取", "Map markers are temporarily unavailable."));
    const body = await response.text();
    if (body.length > 24 * 1024 * 1024) throw new Error(tr("物资点位数据超过上限", "Map marker data exceeds the size limit."));
    return signal?.aborted ? null : JSON.parse(body);
  }
  return async (mapPack, { signal } = {}) => {
    const build = String(mapPack?.gameBuildId || "");
    if (!/^\d{1,20}$/.test(build)) return null;
    // Share only completed responses. A cancelled request must never poison a later map selection.
    let raw = cache.get(build);
    if (!raw) {
      raw = await readSurvey(`loot.${build}.json`, signal);
      if (!raw || signal?.aborted) return null;
      cache.set(build, raw);
    }
    if (raw.kind === "map-loot-index") {
      if (raw.schemaVersion !== 1 || String(raw.gameBuildId) !== build
          || !Array.isArray(raw.maps) || raw.maps.length > MAX_SURVEY_MAPS || !packPattern.test(mapPack.mapPackId || "")) return null;
      const entries = raw.maps.filter(entry => entry?.mapPackId === mapPack.mapPackId);
      const entry = entries[0], path = `loot/${build}/${mapPack.mapPackId}.json`;
      if (entries.length !== 1 || entry.path !== path || entry.sceneName !== mapPack.sceneName
          || entry.mapSlot !== mapPack.mapSlot || entry.sourceSceneSha256 !== mapPack.source?.sceneSha256) return null;
      if (signal?.aborted) return null;
      let mapRaw = mapCache.get(path);
      if (!mapRaw) {
        mapRaw = await readSurvey(path, signal);
        if (!mapRaw || signal?.aborted) return null;
        mapCache.set(path, mapRaw);
      }
      raw = mapRaw;
    }
    return normalizeMapLoot(raw, mapPack);
  };
}
