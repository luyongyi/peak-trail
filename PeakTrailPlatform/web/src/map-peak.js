function finiteBounds(value) {
  if (!value || !Array.isArray(value.min) || !Array.isArray(value.max)
      || value.min.length !== 3 || value.max.length !== 3) return null;
  const min = value.min.map(Number), max = value.max.map(Number);
  return min.every(Number.isFinite) && max.every(Number.isFinite)
    && min.every((entry, index) => entry < max[index]) ? { min, max } : null;
}

/** Verify source PeakHandler evidence after it has been bound to a map pack. */
export function normalizeMapPeak(value, mapPack) {
  if (!value || value.schemaVersion !== 1 || value.authority !== "serialized-peak-handler"
      || String(value.gameBuildId) !== String(mapPack?.gameBuildId)
      || value.mapPackId !== mapPack?.mapPackId || value.sceneName !== mapPack?.sceneName
      || value.sourceSceneSha256 !== mapPack?.source?.sceneSha256
      || value.mapSlot !== mapPack?.mapSlot || value.segment !== 4
      || !Number.isInteger(value.rootGameObject) || value.rootGameObject <= 0
      || !Number.isInteger(value.peakHandler) || value.peakHandler <= 0
      || !(value.gateGameObject === null || (Number.isInteger(value.gateGameObject) && value.gateGameObject > 0))) return null;
  const layer = mapPack.layers?.filter((entry) => entry.segment === value.segment);
  if (layer?.length !== 1 || layer[0].geometrySha256 !== value.geometrySha256
      || String(layer[0].biome) !== String(value.biome)) return null;
  const bounds = finiteBounds(value.bounds);
  const cameraBounds = finiteBounds(value.collisionBounds);
  if (!bounds || !cameraBounds || cameraBounds.min.some((entry, index) => entry < bounds.min[index] - 1e-4)
      || cameraBounds.max.some((entry, index) => entry > bounds.max[index] + 1e-4)) return null;
  return { ...value, bounds, collisionBounds: cameraBounds };
}
