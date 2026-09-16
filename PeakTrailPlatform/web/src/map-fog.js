const vector = (value, n) => Array.isArray(value) && value.length === n && value.every(Number.isFinite);

/** Geometry identity is unchanged; this optional, source-checked metadata is
 * bound to the same build, scene and canonical pack. Never accept water as fog. */
export function normalizeMapFog(raw, mapPack) {
  if (!raw || raw.schemaVersion !== 1 || raw.authority !== 'serialized-map-baseline'
    || String(raw.gameBuildId) !== String(mapPack?.gameBuildId)
    || raw.mapPackId !== mapPack?.mapPackId || raw.sceneName !== mapPack?.sceneName
    || raw.sourceSceneSha256 !== mapPack?.source?.sceneSha256
    || !/^[a-f0-9]{64}$/.test(raw.sourceSceneSha256 || '') || !Array.isArray(raw.volumes)) return null;
  const ids = new Set(), volumes = [];
  for (const value of raw.volumes) {
    if (!value || typeof value.objectId !== 'string' || !value.objectId.startsWith('map-fog:') || ids.has(value.objectId)
      || value.kind !== 'sleep_fog' || value.authority !== 'map-baseline' || value.source !== 'serialized-map-StatusFieldGloom'
      || value.surfaceMaterial !== 'FogSurface' || value.surfaceShader !== 'GD/FogSurface'
      || !vector(value.pos, 3) || !vector(value.size, 3) || !value.size.every((v) => v > 0 && v <= 10000)
      || !Number.isFinite(value.topY) || Math.abs(value.pos[1] + value.size[1] / 2 - value.topY) > 1e-4
      || !Number.isInteger(value.segment) || !mapPack.layers?.some((layer) => layer.segment === value.segment && layer.biome === 'Swamp')) return null;
    ids.add(value.objectId);
    volumes.push({ ...value, pos: [...value.pos], size: [...value.size], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      active: true, activity: 'source-baseline', radius: null, activationRadius: null, warningRadius: null });
  }
  return { ...raw, volumes };
}

export function mapFogStateAtTime(mapFog, timeline, time, segment = null) {
  // A complete recorded empty world is meaningful. A baseline must never fill
  // holes in telemetry, precede a future sample, or double up recorded fog.
  if (timeline?.captured) return { mode: 'recorded', objects: [], count: 0,
    note: time < timeline.firstTime ? '实录雾尚未采样；不提前展示后续雾区。' : '实录动态雾：按日志的高度与灯光保护区回放。' };
  const objects = (mapFog?.volumes || []).filter((object) => segment === null || object.segment === segment);
  if (!objects.length) return { mode: 'unavailable', objects: [], count: 0, note: '此关无已核实的地图基础雾。' };
  return { mode: 'map-baseline', objects, count: objects.length,
    note: '地图基础雾（源地图初始配置）：无本局世界实录，实际雾高度、上升过程及灯光开关未知；不是实录动态雾。' };
}
