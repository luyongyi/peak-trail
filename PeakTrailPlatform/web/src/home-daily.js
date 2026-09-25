import { selectDailyMapPack } from "./protocol.js";
import { normalizeRoute, routeSegmentName } from "./map-route.js";

const BIOMES = {
  shore: { title: "海岸", theme: "shore" },
  roots: { title: "森蕈", theme: "roots" },
  tropics: { title: "雨林", theme: "tropics" },
  alpine: { title: "雪山", theme: "alpine" },
  mesa: { title: "台地", theme: "mesa" },
  volcano: { title: "火山", theme: "volcano" },
  swamp: { title: "雾沼", theme: "swamp" },
};

function timestamp(value) {
  return typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
}

function observationIsValid(daily) {
  if (daily?.schemaVersion !== 1 || daily.versionOkay !== true
      || !Number.isInteger(daily.levelIndex) || !Number.isInteger(daily.mapCount) || daily.mapCount < 1
      || !Number.isInteger(daily.mapSlot) || daily.mapSlot < 0 || daily.mapSlot >= daily.mapCount
      || daily.sceneName !== `Level_${daily.mapSlot}`) return false;
  return ((daily.levelIndex % daily.mapCount) + daily.mapCount) % daily.mapCount === daily.mapSlot;
}

function localTimestamp(value, timeZone) {
  if (!Number.isFinite(value)) return null;
  // This is the observation's local date, not a guessed date-to-map rotation.
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(value);
  } catch {
    return new Date(value).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

function sameIdentity(mapPack, entry, daily) {
  return Boolean(mapPack && entry
    && mapPack.mapPackId === entry.mapPackId
    && String(mapPack.gameBuildId ?? "").trim() === String(entry.gameBuildId).trim()
    && mapPack.sceneName === daily.sceneName
    && Number.isInteger(mapPack.mapSlot) && mapPack.mapSlot === daily.mapSlot
    && Array.isArray(mapPack.layers));
}

function pendingCard(segment) {
  return {
    segment, ordinal: String(segment + 1).padStart(2, "0"),
    title: `第${["一", "二", "三", "四"][segment]}关`, theme: "unknown",
    biome: null, sourceName: null, layerId: null, layer: null,
    available: false, ending: null,
  };
}

function layerForSegment(mapPack, segment) {
  // Duplicate chapter assignments are ambiguous; do not select whichever came first.
  const layers = mapPack.layers.filter((layer) => layer?.segment === segment);
  return layers.length === 1 ? layers[0] : null;
}

function chapterCards(mapPack) {
  const route = normalizeRoute(mapPack.route);
  const branchKnown = route && route.branch !== "unknown";
  const fourth = layerForSegment(mapPack, 3);
  const ending = layerForSegment(mapPack, 4);
  const fourthRoute = route?.segments.find((segment) => segment.index === 3);
  const endingRoute = route?.segments.find((segment) => segment.index === 4);
  // A known pair is indivisible: never infer the finale from the date, slot parity,
  // matching colours, or a fourth chapter whose layer contradicts route evidence.
  const branchMatches = branchKnown && fourth && ending
    && String(fourth.biome).toLowerCase() === fourthRoute?.biome.toLowerCase()
    && String(ending.biome).toLowerCase() === endingRoute?.biome.toLowerCase();
  return Array.from({ length: 4 }, (_, segment) => {
    const card = pendingCard(segment);
    const layer = layerForSegment(mapPack, segment);
    if (!layer || (segment === 3 && !branchMatches)) {
      if (segment === 3) card.title = "第四关 · 分支待确认";
      return card;
    }
    const biome = String(layer.biome || "").toLowerCase();
    const known = BIOMES[biome];
    return {
      ...card,
      title: segment === 3 ? routeSegmentName(route, 3) : known?.title || layer.name || card.title,
      theme: known?.theme || "unknown", biome,
      sourceName: String(layer.name || layer.biome || ""), layerId: layer.id || null, layer,
      available: true,
      ending: segment === 3 ? {
        segment: 4, title: routeSegmentName(route, 4), layerId: ending.id || null,
        branch: route.branch, layer: ending,
      } : null,
    };
  });
}

/**
 * Pure home-page view model. Supply the observed daily record, the published
 * catalog, and only the map pack fetched for its exact selected catalog entry.
 * Expired observations may be presented as an archive, never as today's map.
 * Calling again at the deadline demotes it immediately without forecasting a slot.
 */
export function buildHomeDailyView({ daily = null, catalog = null, mapPack = null, now = Date.now(), timeZone = "Asia/Shanghai" } = {}) {
  const currentTime = now instanceof Date ? now.getTime() : Number(now);
  const fetched = timestamp(daily?.fetchedAtUtc);
  const deadline = timestamp(daily?.nextChangeAtUtc);
  const valid = observationIsValid(daily) && Number.isFinite(currentTime)
    && Number.isFinite(fetched) && Number.isFinite(deadline)
    && fetched <= currentTime && deadline >= fetched;
  const freshness = !valid ? "unavailable" : currentTime < deadline ? "current" : "stale";
  const remainingSeconds = freshness === "current" ? Math.ceil((deadline - currentTime) / 1000) : null;
  const observedLabel = valid ? localTimestamp(fetched, timeZone) : null;
  const rotationLabel = valid ? localTimestamp(deadline, timeZone) : null;
  let entry = null;
  if (valid) {
    try { entry = selectDailyMapPack(catalog, daily); } catch { /* Catalog not loaded or invalid. */ }
  }
  const identityMatched = valid && sameIdentity(mapPack, entry, daily);
  const cards = identityMatched ? chapterCards(mapPack) : Array.from({ length: 4 }, (_, segment) => pendingCard(segment));
  const mapStatus = !valid ? "waiting-observation" : !entry ? "missing-build"
    : !mapPack ? "waiting-pack" : !identityMatched ? "identity-mismatch"
      : cards.every((card) => card.available) ? "ready" : "route-unconfirmed";
  const countdownLabel = remainingSeconds === null
    ? freshness === "stale" ? "等待新一轮确认" : "尚未同步轮换"
    : `${String(Math.floor(remainingSeconds / 3600)).padStart(2, "0")}:${String(Math.floor(remainingSeconds % 3600 / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  return {
    freshness, isCurrent: freshness === "current",
    statusLabel: freshness === "current" ? "今日四关" : freshness === "stale" ? "上次确认的四关" : "等待轮换确认",
    sceneName: valid ? daily.sceneName : null, mapSlot: valid ? daily.mapSlot : null,
    observedLabel, rotationLabel, remainingSeconds, countdownLabel,
    fetchedAtUtc: valid ? daily.fetchedAtUtc : null,
    nextChangeAtUtc: valid ? daily.nextChangeAtUtc : null,
    mapEntry: entry, mapStatus, cards,
  };
}
