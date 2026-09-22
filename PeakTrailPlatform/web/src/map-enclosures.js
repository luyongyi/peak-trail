const finiteVector = (value) => Array.isArray(value) && value.length === 3
  && value.every(number => Number.isFinite(number) && Math.abs(number) <= 100000);

/** Source enclosure geometry is an additive, exact-scene correction. It does
 * not change the legacy terrain identity or manufacture a wall from bounds. */
export function normalizeMapEnclosures(raw, mapPack) {
  if (!raw || raw.schemaVersion !== 1 || raw.authority !== 'serialized-map-enclosure'
    || String(raw.gameBuildId) !== String(mapPack?.gameBuildId)
    || raw.mapPackId !== mapPack?.mapPackId || raw.sceneName !== mapPack?.sceneName
    || raw.mapSlot !== mapPack?.mapSlot
    || raw.sourceSceneSha256 !== mapPack?.source?.sceneSha256
    || !/^[a-f0-9]{64}$/.test(raw.sourceSceneSha256 || '')
    || !Array.isArray(raw.enclosures) || raw.enclosures.length > 8) return null;
  const ids = new Set(), enclosures = [];
  for (const entry of raw.enclosures) {
    if (!entry || typeof entry.objectId !== 'string' || !entry.objectId.startsWith('map-enclosure:')
      || ids.has(entry.objectId) || !Number.isInteger(entry.segment)
      || !mapPack.layers?.some(layer => layer.segment === entry.segment)
      || !Number.isInteger(entry.sourceRootPathId) || entry.sourceRootPathId <= 0
      || typeof entry.sourceRootName !== 'string' || !entry.sourceRootName
      || !/^[a-f0-9]{64}$/.test(entry.geometrySha256 || '')
      || entry.geometry !== `${entry.geometrySha256}.glb.gz`
      || entry.geometryFormat !== 'glb-instanced-v1+gzip'
      || !finiteVector(entry.meshBounds?.min) || !finiteVector(entry.meshBounds?.max)
      || entry.meshBounds.min.some((min, axis) => min >= entry.meshBounds.max[axis])
      || !finiteVector(entry.interiorReference) || entry.interiorReferenceSource !== 'source-model-axis'
      || [0, 2].some(axis => entry.interiorReference[axis] < entry.meshBounds.min[axis]
        || entry.interiorReference[axis] > entry.meshBounds.max[axis])) return null;
    ids.add(entry.objectId);
    enclosures.push({ ...entry, interiorReference: [...entry.interiorReference],
      meshBounds: { min: [...entry.meshBounds.min], max: [...entry.meshBounds.max] } });
  }
  return { ...raw, enclosures };
}

export function enclosureGeometryReference(entry) {
  return `../../enclosures/${entry.geometry}`;
}

/** Select a chapter only when source coordinates disambiguate it. In overview,
 * shared progression is not evidence of an individual player's current room. */
export function followLayerAtPosition(mapPack, selectedSegment, unityPosition) {
  if (!mapPack || !finiteVector(unityPosition)) return null;
  const contains = layer => unityPosition[0] >= layer.minX && unityPosition[0] <= layer.maxX
    && unityPosition[1] >= layer.minY && unityPosition[1] <= layer.maxY
    && unityPosition[2] >= layer.minZ && unityPosition[2] <= layer.maxZ;
  if (Number.isInteger(selectedSegment)) return mapPack.layers?.find(layer => layer.segment === selectedSegment) || null;
  const candidates = (mapPack.layers || []).filter(layer => String(layer.biome).toLowerCase() !== 'void' && contains(layer));
  return candidates.length === 1 ? candidates[0] : null;
}
