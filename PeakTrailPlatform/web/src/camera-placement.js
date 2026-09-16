const INTERIOR_ROOTS = new Set(["temple_segment", "volcano_segment"]);
const EXTERIOR_ROOTS = new Set(["caldera_segment", "swamp_segment"]);
const LIFE_EVENTS = new Set(["join", "leave", "death", "revive"]);

function rootTokens(value) {
  return typeof value === "string" ? value.split(/[\\/|]/).map((part) =>
    part.trim().replace(/\s*\(clone\)$/i, "").toLowerCase()) : [];
}

/**
 * Serialized names are not interchangeable with BiomeType: Caldera_Segment is
 * the outdoor volcano chapter; Volcano_Segment is the enclosed final Kiln.
 * Temple_Segment is the final Citadel, whereas Swamp_Segment is outdoor fog.
 */
export function isInteriorLayer(layer, route = null) {
  if (!layer || typeof layer !== "object") return false;
  const fields = ["name", "rootName", "root", "sourceRoot", "sourcePath", "path", "gameObjectName"];
  const tokens = fields.flatMap((field) => [...rootTokens(layer[field]), ...rootTokens(layer.source?.[field])]);
  if (tokens.some((token) => EXTERIOR_ROOTS.has(token))) return false;
  if (tokens.some((token) => INTERIOR_ROOTS.has(token))) return true;

  const entry = route?.segments?.find((item) => item.index === layer.segment);
  const routeTokens = rootTokens(entry?.name);
  if (routeTokens.some((token) => EXTERIOR_ROOTS.has(token))) return false;
  if (routeTokens.some((token) => INTERIOR_ROOTS.has(token))) return true;
  if (layer.segment !== 4 || !entry) return false;
  // Older canonical packs retain only the reused biome label. Require a
  // resolved branch plus its terminal route entry; biome alone proves nothing.
  const expectedBiome = route.branch === "volcano-kiln" ? "volcano"
    : route.branch === "swamp-temple" ? "swamp" : null;
  return Boolean(expectedBiome && String(entry.biome).toLowerCase() === expectedBiome
    && String(layer.biome).toLowerCase() === expectedBiome);
}

function validPosition(pos) {
  return Array.isArray(pos) && pos.length >= 3 && pos.slice(0, 3).every(Number.isFinite);
}

function normalizedBounds(layer) {
  if (!layer || typeof layer !== "object") return null;
  const min = Array.isArray(layer.min) ? layer.min : [layer.minX, layer.minY, layer.minZ];
  const max = Array.isArray(layer.max) ? layer.max : [layer.maxX, layer.maxY, layer.maxZ];
  return validPosition(min) && validPosition(max) && min.slice(0, 3).every((v, axis) => v <= max[axis])
    ? { min, max } : null;
}

function inside(pos, bounds) {
  return validPosition(pos) && bounds.min.every((min, axis) => pos[axis] >= min && pos[axis] <= bounds.max[axis]);
}

function lifeAt(events, seconds) {
  let present = true;
  let alive = true;
  for (const event of events) {
    if (event.t > seconds) break;
    if (event.type === "leave") present = false;
    else if (event.type === "join") { present = true; alive = true; }
    else if (event.type === "death") alive = false;
    else if (event.type === "revive") alive = true;
  }
  return present && alive;
}

function choose(candidates, preferredPlayerId) {
  candidates.sort((a, b) => Number(b.playerId === preferredPlayerId) - Number(a.playerId === preferredPlayerId)
    || b.t - a.t || String(a.playerId).localeCompare(String(b.playerId)));
  const selected = candidates[0];
  return selected ? { pos: selected.pos.slice(0, 3), yaw: Number.isFinite(selected.yaw) ? selected.yaw : 0,
    t: selected.t, playerId: selected.playerId } : null;
}

/**
 * Picks an observed Unity-world position in this layer, never a future sample
 * or an interpolated point. activeSegment is shared progression, not a player's
 * location. Caller applies origin / height scale and the camera eye offset.
 * Hidden players are excluded when playerVisibility is supplied as a Map.
 */
export function chooseRecordedInteriorPose(trace, currentTime, layerOrBounds,
  { playerVisibility = null, preferredPlayerId = null } = {}) {
  const bounds = normalizedBounds(layerOrBounds);
  if (!bounds || !Number.isFinite(currentTime) || !(trace?.tracks instanceof Map)) return null;
  const sampleHz = Number(trace.manifest?.sampleHz);
  const freshFor = Math.max(1.5, 2.5 / (Number.isFinite(sampleHz) && sampleHz > 0 ? sampleHz : 5));
  const current = [];
  const past = [];
  for (const [playerId, samples] of trace.tracks) {
    if (playerVisibility?.get(playerId) === false || !Array.isArray(samples)) continue;
    const events = (trace.events || []).filter((event) => event.playerId === playerId
      && LIFE_EVENTS.has(event.type) && Number.isFinite(event.t) && event.t <= currentTime)
      .sort((a, b) => a.t - b.t);
    let latest = null;
    let historical = null;
    for (const sample of samples) {
      if (!sample || !Number.isFinite(sample.t) || sample.t > currentTime || !validPosition(sample.pos)) continue;
      if (!latest || sample.t >= latest.t) latest = sample;
      if ((!historical || sample.t >= historical.t) && inside(sample.pos, bounds) && lifeAt(events, sample.t)) {
        historical = sample;
      }
    }
    if (latest && currentTime - latest.t <= freshFor && inside(latest.pos, bounds)
        && lifeAt(events, latest.t) && lifeAt(events, currentTime)) current.push({ ...latest, playerId });
    if (historical) past.push({ ...historical, playerId });
  }
  // Preference applies only among genuinely current players. A preferred
  // player's stale old visit never overrides someone currently in this room.
  return choose(current, preferredPlayerId) || choose(past, null);
}
