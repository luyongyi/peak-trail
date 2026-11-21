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

/** The Citadel and Kiln are source-authored landmarks at their preceding exits.
 * A single-chapter view can draw its neighbor without changing which chapter
 * owns the geometry or the players. Overview loads each shell with its own chapter. */
export function chapterEnclosures(mapPack, layer, { includeContext = false } = {}) {
  if (!Number.isInteger(layer?.segment)
      || !mapPack?.layers?.some(entry => entry.segment === layer.segment)) return [];
  const enclosures = normalizeMapEnclosures(mapPack.mapEnclosures, mapPack)?.enclosures || [];
  const own = enclosures.filter(entry => entry.segment === layer.segment);
  const route = mapPack.route;
  // 3.1 static-source equivalence: data/maps/verified-builds/26542162/equivalence.json.
  // Every shell still binds to its own build, scene and source digest above.
  if (!includeContext || mapPack.identityVersion !== 3 || !['25306743', '25739797', '26134529', '26155610', '26542162'].includes(String(mapPack.gameBuildId))
      || route?.authority !== 'serialized-map-handler' || layer.segment !== 3) return own;
  const current = route.segments?.find(entry => entry.index === 3);
  const next = route.segments?.find(entry => entry.index === 4);
  const terminal = mapPack.layers.find(entry => entry.segment === 4);
  const citadel = route.branch === 'swamp-temple' && current?.stageId === 'swamp' && current.name === 'Swamp_Segment'
    && next?.stageId === 'temple' && next.name === 'Temple_Segment';
  const kiln = route.branch === 'volcano-kiln' && current?.stageId === 'caldera' && current.name === 'Caldera_Segment'
    && next?.stageId === 'kiln' && next.name === 'Volcano_Segment';
  if (!citadel && !kiln) return own;
  const biome = kiln ? 'volcano' : 'swamp';
  if (![current, next, layer, terminal].every(part => String(part?.biome).toLowerCase() === biome)) return own;
  return [...own, ...enclosures.filter(entry => entry.segment === 4 && (citadel
    ? entry.sourceRootName === 'Gloom Temple'
    : entry.sourceRootName === 'VolcanoModel' && entry.sourceModelName === 'Pipe'
      && Array.isArray(entry.sourceHierarchy) && entry.sourceHierarchy.join('/') === 'Map/Biome_4/Caldera/VolcanoModel'))];
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
