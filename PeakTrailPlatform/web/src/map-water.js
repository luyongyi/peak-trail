const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);

/** Optional ocean metadata is tied to a verified scene, never inferred from
 * biome names or a player's height. It does not change signed terrain bounds. */
export function normalizeMapWater(raw, mapPack) {
  if (!raw || raw.schemaVersion !== 1 || raw.authority !== 'serialized-map-baseline'
    || String(raw.gameBuildId) !== String(mapPack?.gameBuildId)
    || raw.mapPackId !== mapPack?.mapPackId || raw.sceneName !== mapPack?.sceneName
    || raw.sourceSceneSha256 !== mapPack?.source?.sceneSha256
    || !/^[a-f0-9]{64}$/.test(raw.sourceSceneSha256 || '')
    || !Array.isArray(raw.surfaces) || raw.surfaces.length > 8) return null;
  const ids = new Set(), surfaces = [];
  for (const source of raw.surfaces) {
    const material = source?.material;
    if (!source || typeof source.objectId !== 'string' || !source.objectId.startsWith('map-water:') || ids.has(source.objectId)
      || source.kind !== 'ocean' || source.source !== 'serialized-global-water-renderer'
      || !Number.isInteger(source.sourceRendererPathId) || source.sourceRendererPathId <= 0
      || !Number.isInteger(source.segment) || !mapPack.layers?.some(layer => layer.segment === source.segment && layer.biome === 'Shore')
      || !Array.isArray(source.corners) || source.corners.length !== 4 || !source.corners.every(point => vector(point, 3) && point.every(v => Math.abs(v) <= 100000))
      || !material || material.shader !== 'GD/Water-GD' || material.colorProperty !== '_WaterColorPrimary'
      || typeof material.name !== 'string' || !material.name || typeof material.asset !== 'string' || !material.asset
      || !Number.isInteger(material.pathId) || material.pathId <= 0
      || !vector(material.linearColor, 3) || !material.linearColor.every(v => v >= 0 && v <= 64)
      || !vector(material.storedColor, 4)) return null;
    const [a, b, c, d] = source.corners;
    // Horizontal source rectangle/parallelogram, consistently ordered. Do not
    // silently turn malformed metadata into a triangle across another chapter.
    if (source.corners.some(point => Math.abs(point[1] - a[1]) > 1e-5)
      || [0, 2].some(axis => Math.abs(a[axis] + c[axis] - b[axis] - d[axis]) > 1e-4)
      || Math.abs((b[0] - a[0]) * (d[2] - a[2]) - (b[2] - a[2]) * (d[0] - a[0])) < 1e-4) return null;
    ids.add(source.objectId);
    surfaces.push({ ...source, corners: source.corners.map(point => [...point]),
      material: { ...material, linearColor: [...material.linearColor], storedColor: [...material.storedColor] } });
  }
  return { ...raw, surfaces };
}

export function sourceWaterVisible(surface, segment) {
  return segment === null || surface.segment === segment;
}
