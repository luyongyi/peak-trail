// BiomeType is reused for the last two chapters. A branch is evidence from a
// resolved MapHandler, never a choice computed from the date or level parity.
const BRANCHES = new Set(["volcano-kiln", "swamp-temple"]);
const NAMES = { "volcano-kiln": ["火山", "熔炉"], "swamp-temple": ["雾沼", "城塞"] };
const SPECIAL_STAGES = [
  { biome: "peak", biomeId: 5, stageId: "peak", name: "顶峰", kind: "summit" },
  { biome: "void", biomeId: 17, stageId: "nadir", name: "天底", kind: "nadir" },
];

/**
 * Classify recorded biomes, never Segment enum values or route array indices.
 * In the current game Peak shares the final chapter at array index 4; it is not
 * a separately exported layer. Explicit Peak biome support is for other/custom
 * route evidence. Void is appended at array index 5. Neither a route entry nor
 * this label proves a player visited it.
 */
export function classifyRouteSegment(entry) {
  const biome = typeof entry?.biome === "string" ? entry.biome.trim().toLowerCase() : "";
  const biomeId = Number.isInteger(entry?.biomeId) ? entry.biomeId : null;
  const stage = SPECIAL_STAGES.find((candidate) => (biome || biomeId !== null)
    && (!biome || biome === candidate.biome)
    && (biomeId === null || biomeId === candidate.biomeId));
  return stage
    ? { stageId: stage.stageId, name: stage.name, kind: stage.kind }
    : { stageId: null, name: null, kind: "chapter" };
}

function biomeKey(segment) {
  const value = String(segment?.biome || "").toLowerCase();
  if (segment?.biomeId === 3 || value === "volcano") return "volcano";
  if (segment?.biomeId === 8 || value === "swamp") return "swamp";
  const special = classifyRouteSegment(segment);
  if (special.kind === "summit") return "peak";
  if (special.kind === "nadir") return "void";
  return value;
}

export function normalizeRoute(raw) {
  if (!raw || !Array.isArray(raw.segments) || !raw.segments.length || raw.segments.length > 64) return null;
  const seen = new Set();
  const segments = [];
  for (const entry of raw.segments) {
    if (!Number.isInteger(entry?.index) || entry.index < 0 || seen.has(entry.index)) return null;
    seen.add(entry.index);
    segments.push({
      index: entry.index,
      biome: typeof entry.biome === "string" ? entry.biome : "",
      biomeId: Number.isInteger(entry.biomeId) ? entry.biomeId : null,
      name: typeof entry.name === "string" ? entry.name : "",
    });
  }
  segments.sort((a, b) => a.index - b.index);
  const branchBiome = biomeKey(segments.find((entry) => entry.index === 3));
  const endingBiome = biomeKey(segments.find((entry) => entry.index === 4));
  const derived = branchBiome === endingBiome
    ? branchBiome === "volcano" ? "volcano-kiln" : branchBiome === "swamp" ? "swamp-temple" : "unknown"
    : "unknown";
  const inconsistent = segments.some((entry) => {
    const name = entry.biome.toLowerCase();
    return (entry.biomeId === 3 && name !== "volcano") || (entry.biomeId === 8 && name !== "swamp")
      || (name === "volcano" && entry.biomeId !== null && entry.biomeId !== 3)
      || (name === "swamp" && entry.biomeId !== null && entry.biomeId !== 8);
  });
  const branch = inconsistent || (raw.branch !== undefined && (!BRANCHES.has(raw.branch) || raw.branch !== derived)) ? "unknown" : derived;
  return { branch, authority: String(raw.authority || "unknown"), segments };
}

export function routeAtTime(trace, seconds) {
  if (trace?.routeTracks?.length) {
    return trace.routeTracks.findLast((entry) => entry.t <= seconds)?.route || null;
  }
  return normalizeRoute(trace?.manifest?.route);
}

export function routeSegmentName(route, index) {
  const special = classifyRouteSegment(route?.segments?.find((entry) => entry.index === index));
  if (special.name) return special.name;
  return index === 3 || index === 4 ? NAMES[route?.branch]?.[index - 3] || null : null;
}

export function resolveReplayRoute(mapPack, trace, seconds = 0) {
  const mapped = normalizeRoute(mapPack?.route);
  const recorded = routeAtTime(trace, seconds);
  const route = recorded || mapped;
  const source = recorded ? "recorded" : mapped ? "map" : "unknown";
  const hiddenSegments = new Set();
  for (const layer of mapPack?.layers || []) {
    const actual = recorded?.segments.find((segment) => segment.index === layer.segment);
    if (recorded && actual && biomeKey(actual) !== biomeKey(layer)) hiddenSegments.add(layer.segment);
    if (recorded && [3, 4].includes(layer.segment)
        && (recorded.branch === "unknown" || !mapped || mapped.branch !== recorded.branch)) {
      hiddenSegments.add(layer.segment);
    }
  }
  const pair = NAMES[route?.branch];
  const label = pair ? pair.join(" → ") : "关卡分支未确认";
  const provenance = source === "recorded" ? "DLL 本局记录"
    : source === "map" ? trace ? "旧日志未记录分支 · 同版本地图配置" : "同版本地图配置"
      : "没有可靠分支记录";
  const key = JSON.stringify([route, [...hiddenSegments]]);
  return {
    route, source, hiddenSegments, key, label,
    message: `${label} · ${provenance}${hiddenSegments.size ? " · 分支不匹配的底图已隐藏，保留足迹" : ""}`,
    layers: (mapPack?.layers || []).filter((layer) => !hiddenSegments.has(layer.segment)),
  };
}
