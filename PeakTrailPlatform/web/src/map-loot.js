const idPattern = /^[a-z][a-z0-9_-]{0,79}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const packPattern = /^sha256-[a-f0-9]{64}$/;
const categories = new Set(["chest", "item", "animal"]);

/** Scene placements are a build-specific survey; they never describe live loot. */
export function normalizeMapLoot(raw, mapPack) {
  if (!mapPack || raw?.schemaVersion !== 1 || String(raw.gameBuildId) !== String(mapPack.gameBuildId)
      || !Array.isArray(raw.maps) || raw.maps.length > 128 || !Array.isArray(raw.types) || raw.types.length > 256) return null;
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
        || typeof type.name !== "string" || !type.name.trim() || type.name.length > 100) return null;
    const normalized = { id: type.id, category: type.category, name: type.name,
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
    if (!type || marker.category !== type.category || typeof marker.id !== "string" || !marker.id || marker.id.length > 180
        || ids.has(marker.id) || !Array.isArray(marker.pos) || marker.pos.length !== 3
        || !marker.pos.every(value => Number.isFinite(value) && Math.abs(value) <= 100000)
        || !Number.isInteger(marker.segment) || marker.segment < 0 || marker.segment > 63
        || !["fixed", "randomized-candidate"].includes(marker.placement)
        || !layer || layer.segment !== marker.segment
        || marker.source?.geometrySha256 && marker.source.geometrySha256 !== layer.geometrySha256) return null;
    ids.add(marker.id);
    markers.push({ ...marker, name: typeof marker.name === "string" ? marker.name.slice(0, 100) : type.name, pos: [...marker.pos] });
  }
  return { mapPackId: entry.mapPackId, sceneName: entry.sceneName, sourceSceneSha256: entry.sourceSceneSha256,
    gameBuildId: String(raw.gameBuildId), types, markers };
}

export function lootForLayers(markers, layers, segment = null) {
  const allowed = new Set((layers || []).filter(layer => segment !== null || String(layer.biome).toLowerCase() !== "void")
    .map(layer => layer.id));
  return markers.filter(marker => allowed.has(marker.layerId) && (segment === null || marker.segment === segment));
}

export function createMapLootLoader({ fetchImpl = globalThis.fetch, baseUrl = new URL("../../data/maps/", import.meta.url) } = {}) {
  const cache = new Map();
  return async (mapPack, { signal } = {}) => {
    const build = String(mapPack?.gameBuildId || "");
    if (!/^\d{1,20}$/.test(build)) return null;
    // Share only completed responses. A cancelled request must never poison a later map selection.
    let raw = cache.get(build);
    if (!raw) {
      const response = await fetchImpl(new URL(`loot.${build}.json`, baseUrl), { signal, cache: "no-cache" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("物资点位暂时无法读取");
      const body = await response.text();
      if (body.length > 24 * 1024 * 1024) throw new Error("物资点位数据超过上限");
      raw = JSON.parse(body);
      if (signal?.aborted) return null;
      cache.set(build, raw);
    }
    return normalizeMapLoot(raw, mapPack);
  };
}
