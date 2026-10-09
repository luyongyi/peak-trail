import { matchesCommunityGroup, pendingCommunityMessage } from "./community-route-model.js";
import { heightBands, normalizeRouteGroups, normalizeRoutes } from "./route-collection-model.js";
import { selectTraceMapPack } from "./protocol.js";

const HASH = /^[a-f0-9]{64}$/;
const PACK_ID = /^sha256-[a-f0-9]{64}$/;

export function parseHistoricalRouteLink(search) {
  const params = new URLSearchParams(search);
  const groupId = params.get("routeGroup");
  if (groupId === null) return null;
  if (params.getAll("routeGroup").length !== 1 || !HASH.test(groupId)) throw new Error("历史路线链接的地图组无效。");
  const stage = params.get("stage");
  if (params.getAll("stage").length > 1 || (stage !== null && !/^(?:0|[1-9]\d?)$/.test(stage))) {
    throw new Error("历史路线链接的关卡无效。");
  }
  const inspectionId = params.get("inspection");
  if (params.getAll("inspection").length > 1 || (inspectionId !== null && !HASH.test(inspectionId))) throw new Error("历史验收预览的投稿身份无效。");
  return { groupId, stageIndex: stage === null ? null : Number(stage), ...(inspectionId ? { inspectionId } : {}) };
}

export function historicalRouteTitle(group) {
  const dates = [group?.firstStartedUtc, group?.lastStartedUtc].filter(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map(value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)));
  const date = [...new Set(dates)].join(" – ");
  const level = Number.isInteger(group?.map?.levelIndex) ? `轮换 ${group.map.levelIndex}` : group?.map?.scene || "";
  return ["历史路线", date, level].filter(Boolean).join(" · ");
}

// Only a public group selects its original pack. The daily rotation, date and
// Level_N alone never choose a replacement map or relax the alignment checks.
export async function loadHistoricalRouteLink(link, { readGroups, readCatalog, loadMapPack } = {}) {
  const groups = normalizeRouteGroups(await readGroups());
  const group = groups.find(value => value.id === link.groupId);
  if (!group) throw new Error("这个历史路线组尚未公开或已下线，请确认上传结果。");
  if (group.mapCompatibility !== "matched" || !PACK_ID.test(group.mapPackId || "")) {
    throw new Error(pendingCommunityMessage([group.mapAlignment?.reason]));
  }
  const { catalog, baseUrl } = await readCatalog();
  const entry = selectTraceMapPack(catalog, { mapPackId: group.mapPackId, sceneName: group.map.scene, gameBuildId: group.map.buildId });
  if (!entry || entry.mapPackId !== group.mapPackId || String(entry.gameBuildId) !== String(group.map.buildId)
    || entry.sceneName !== group.map.scene) throw new Error("历史路线对应的原版地图尚未发布，暂时无法检查匹配。");
  const stageIndex = link.stageIndex ?? group.stageSummaries.filter(stage => stage.routeCount > 0).at(-1)?.index;
  if (!Number.isInteger(stageIndex) || !group.stageSummaries.some(stage => stage.index === stageIndex)) {
    throw new Error("历史路线组中没有这个关卡。");
  }
  const mapPack = await loadMapPack(new URL(entry.path, baseUrl).href);
  if (!matchesCommunityGroup(group, mapPack)) {
    mapPack?.disposeAssets?.();
    throw new Error("历史路线与原地图的版本、关卡或地标不匹配，暂不叠加。");
  }
  return { group, mapPack, stageIndex, inspectionId: link.inspectionId || null,
    title: `${historicalRouteTitle(group)}${link.inspectionId ? " · 验收预览" : ""}` };
}

export function historicalRouteUrl(value, groupId, stageIndex, inspectionId = null) {
  if (!HASH.test(groupId) || !Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 99) throw new Error("历史路线链接参数无效。");
  if (inspectionId !== null && !HASH.test(inspectionId)) throw new Error("历史验收预览的投稿身份无效。");
  const url = new URL(value);
  // A shared public URL carries only the map group and chapter, never an
  // unrelated local-import parameter or a private upload/admin token.
  url.search = "";
  url.hash = "";
  url.searchParams.set("routeGroup", groupId);
  url.searchParams.set("stage", String(stageIndex));
  if (inspectionId) url.searchParams.set("inspection", inspectionId);
  return url.href;
}

export function normalizeHistoricalInspection(raw, group, mapPack, stageIndex, inspectionId) {
  if (raw?.inspection !== true || raw.excludedFromAggregation !== true || raw.uploadId !== inspectionId || raw.groupId !== group.id || raw.stageIndex !== stageIndex
    || raw.coordinateSpace !== "canonical-map-world-cm" || raw.mapAlignment?.id !== group.mapAlignment?.id
    || !group.stageSummaries.some(stage => stage.index === stageIndex)
    || !matchesCommunityGroup({ ...group, mapPackId: raw.mapPackId, mapCompatibility: raw.mapCompatibility, mapAlignment: raw.mapAlignment }, mapPack)) {
    throw new Error("验收预览与当前投稿、原地图或关卡不一致，暂不展示。");
  }
  const response = normalizeRoutes(raw);
  if (response.routes.some(route => !["complete", "partial", "unknown"].includes(route.completion)
    || typeof route.completed !== "boolean" || route.completed !== (route.completion === "complete"))) {
    throw new Error("验收预览的关卡完成状态无效。");
  }
  return { routes: response.routes, heatmap: null, totalRouteCount: response.totalRouteCount, truncated: Boolean(response.truncated),
    heightBands: heightBands(response.routes, null, 200), inspectionLoaded: true };
}
