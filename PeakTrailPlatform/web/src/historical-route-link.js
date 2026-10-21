import { runOutcomeLabel } from "./route-milestones.js";
import { getLocale, tr } from "./i18n.js";
import { communityRouteError, matchesCommunityGroup, normalizeCommunityTeams, pendingCommunityMessage } from "./community-route-model.js";
import { heightBands, normalizeRouteGroups, normalizeRoutes } from "./route-collection-model.js";
import { selectTraceMapPack } from "./protocol.js";

const HASH = /^[a-f0-9]{64}$/;
const PACK_ID = /^sha256-[a-f0-9]{64}$/;

export function parseHistoricalRouteLink(search) {
  const params = new URLSearchParams(search);
  const groupId = params.get("routeGroup");
  if (groupId === null) return null;
  if (params.getAll("routeGroup").length !== 1 || !HASH.test(groupId)) throw communityRouteError("历史路线链接的地图组无效。", "Invalid historical route group link.");
  const stage = params.get("stage");
  if (params.getAll("stage").length > 1 || (stage !== null && !/^(?:0|[1-9]\d?)$/.test(stage))) {
    throw communityRouteError("历史路线链接的关卡无效。", "Invalid chapter in the historical route link.");
  }
  const inspectionId = params.get("inspection");
  if (params.getAll("inspection").length > 1 || (inspectionId !== null && !HASH.test(inspectionId))) throw communityRouteError("历史验收预览的投稿身份无效。", "Invalid submission identity for the review preview.");
  const teamId = params.get("team");
  if (params.getAll("team").length > 1 || (teamId !== null && !HASH.test(teamId))) throw communityRouteError("历史路线链接的队伍身份无效。", "Invalid team identity in the historical route link.");
  if (teamId && inspectionId) throw communityRouteError("队伍路线与单次投稿预览不能同时选择。", "Choose a team route or a single submission preview.");
  return { groupId, stageIndex: stage === null ? null : Number(stage), ...(inspectionId ? { inspectionId } : {}), ...(teamId ? { teamId } : {}) };
}

export function historicalRouteTitle(group) {
  const dates = [group?.firstStartedUtc, group?.lastStartedUtc].filter(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map(value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)));
  const date = [...new Set(dates)].join(" – ");
  const level = Number.isInteger(group?.map?.levelIndex) ? tr(`轮换 ${group.map.levelIndex}`, `Rotation ${group.map.levelIndex}`) : group?.map?.scene || "";
  return [tr("历史路线", "Historical routes"), date, level].filter(Boolean).join(" · ");
}

// Only a public group selects its original pack. The daily rotation, date and
// Level_N alone never choose a replacement map or relax the alignment checks.
export async function loadHistoricalRouteLink(link, { readGroups, readCatalog, loadMapPack, readTeam, currentMapPack = null } = {}) {
  if (!HASH.test(link?.groupId || "") || link.teamId && (!HASH.test(link.teamId) || link.inspectionId)) throw communityRouteError("历史路线链接参数无效。", "Invalid historical route link.");
  const groups = normalizeRouteGroups(await readGroups());
  const group = groups.find(value => value.id === link.groupId);
  if (!group) throw communityRouteError("这个历史路线组尚未公开或已下线，请确认上传结果。", "This route group is not public or has been removed. Check the upload result.");
  if (group.mapCompatibility !== "matched" || !PACK_ID.test(group.mapPackId || "")) {
    throw new Error(pendingCommunityMessage([group.mapAlignment?.reason]));
  }
  let team = null;
  if (link.teamId) {
    if (!readTeam) throw communityRouteError("队伍路线服务暂不可用。", "Team routes are temporarily unavailable.");
    const body = await readTeam(link.teamId);
    team = normalizeCommunityTeams({ teams: [body?.team] }).teams[0];
    if (team.id !== link.teamId || team.groupId !== group.id || team.map.scene !== group.map.scene
        || String(team.map.buildId) !== String(group.map.buildId) || team.mapCompatibility !== "matched"
        || team.mapPackId !== group.mapPackId || team.mapAlignment?.id !== group.mapAlignment?.id) throw communityRouteError("这支队伍不属于链接指定的原地图，请重新打开队伍。", "This team does not belong to the linked map. Open the team again.");
    if (team.stageSummaries.length > 64 || team.stageSummaries.some(stage => !Number.isSafeInteger(stage?.index)
        || !Number.isSafeInteger(stage.memberCount) || stage.memberCount < 0
        || !group.stageSummaries.some(value => value.index === stage.index))) throw communityRouteError("队伍的关卡记录无效。", "Invalid team chapter records.");
  }
  const { catalog, baseUrl } = await readCatalog();
  const entry = selectTraceMapPack(catalog, { mapPackId: group.mapPackId, sceneName: group.map.scene, gameBuildId: group.map.buildId });
  if (!entry || entry.mapPackId !== group.mapPackId || String(entry.gameBuildId) !== String(group.map.buildId)
    || entry.sceneName !== group.map.scene) throw communityRouteError("历史路线对应的原版地图尚未发布，暂时无法检查匹配。", "The original map for these routes has not been published yet.");
  const stageIndex = link.stageIndex ?? (team
    ? team.stageSummaries.filter(stage => stage.memberCount > 0).sort((a, b) => a.index - b.index).at(-1)?.index
    : group.stageSummaries.filter(stage => stage.routeCount > 0).at(-1)?.index);
  if (!Number.isInteger(stageIndex) || !group.stageSummaries.some(stage => stage.index === stageIndex)) {
    throw communityRouteError("历史路线组中没有这个关卡。", "This route group has no such chapter.");
  }
  const reusedMapPack = Boolean(currentMapPack && matchesCommunityGroup(group, currentMapPack));
  const mapPack = reusedMapPack ? currentMapPack : await loadMapPack(new URL(entry.path, baseUrl).href);
  if (!matchesCommunityGroup(group, mapPack)) {
    if (!reusedMapPack) mapPack?.disposeAssets?.();
    throw communityRouteError("历史路线与原地图的版本、关卡或地标不匹配，暂不叠加。", "These routes do not match the original map build, chapters or landmarks.");
  }
  return { group, mapPack, stageIndex, inspectionId: link.inspectionId || null, teamId: team?.id || null, team, reusedMapPack,
    baseTitle: historicalRouteTitle(group), title: `${historicalRouteTitle(group)}${link.inspectionId ? tr(" · 验收预览", " · Review preview") : team ? tr(" · 团队路线", " · Team routes") : ""}` };
}

export function historicalRouteUrl(value, groupId, stageIndex, inspectionId = null, teamId = null) {
  if (!HASH.test(groupId) || !Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex > 99) throw communityRouteError("历史路线链接参数无效。", "Invalid historical route link.");
  if (inspectionId !== null && !HASH.test(inspectionId)) throw communityRouteError("历史验收预览的投稿身份无效。", "Invalid submission identity for the review preview.");
  if (teamId !== null && !HASH.test(teamId)) throw communityRouteError("历史路线链接的队伍身份无效。", "Invalid team identity in the historical route link.");
  if (teamId && inspectionId) throw communityRouteError("队伍路线与单次投稿预览不能同时选择。", "Choose a team route or a single submission preview.");
  const url = new URL(value);
  // A shared public URL carries only the map group and chapter, never an
  // unrelated local-import parameter or a private upload/admin token.
  url.search = "";
  url.hash = "";
  url.searchParams.set("routeGroup", groupId);
  url.searchParams.set("stage", String(stageIndex));
  if (inspectionId) url.searchParams.set("inspection", inspectionId);
  if (teamId) url.searchParams.set("team", teamId);
  if (getLocale() === "en") url.searchParams.set("lang", "en");
  return url.href;
}

export function normalizeHistoricalInspection(raw, group, mapPack, stageIndex, inspectionId) {
  if (raw?.inspection !== true || raw.excludedFromAggregation !== true || raw.uploadId !== inspectionId || raw.groupId !== group.id || raw.stageIndex !== stageIndex
    || raw.coordinateSpace !== "canonical-map-world-cm" || raw.mapAlignment?.id !== group.mapAlignment?.id
    || !group.stageSummaries.some(stage => stage.index === stageIndex)
    || !matchesCommunityGroup({ ...group, mapPackId: raw.mapPackId, mapCompatibility: raw.mapCompatibility, mapAlignment: raw.mapAlignment }, mapPack)) {
    throw communityRouteError("验收预览与当前投稿、原地图或关卡不一致，暂不展示。", "The preview does not match this submission, original map or chapter.");
  }
  const response = normalizeRoutes(raw);
  if (response.routes.some(route => !["complete", "partial", "unknown"].includes(route.completion)
    || typeof route.completed !== "boolean" || route.completed !== (route.completion === "complete")
    || route.gameCompleted !== null && route.gameCompleted !== undefined && typeof route.gameCompleted !== "boolean")) {
    throw communityRouteError("验收预览的关卡完成状态无效。", "Invalid chapter completion status in the preview.");
  }
  const routes = response.routes.map(route => ({ ...route, gameCompleted: route.gameCompleted ?? null }));
  return { routes, heatmap: null, totalRouteCount: response.totalRouteCount, truncated: Boolean(response.truncated),
    heightBands: heightBands(response.routes, null, 200), inspectionLoaded: true };
}

// Native game progress and a continuous recorded path are independent facts.
// Missing evidence must never be presented as a player failing the chapter.
export function historicalInspectionRouteStatus(route) {
  const outcome = runOutcomeLabel(route);
  if (outcome) return outcome + " · " + (route.completed ? tr("完整线路", "Complete path") : tr("线路有断点", "Path has gaps"));
  if (route.gameCompleted === true) return route.completed ? tr("已完成本关 · 完整线路", "Chapter completed · Complete path") : tr("已完成本关 · 线路有断点", "Chapter completed · Path has gaps");
  if (route.gameCompleted === false) return tr("本关尚未完成", "Chapter not yet completed");
  return tr(`${route.completed ? "完整线路" : "线路未完整"}（缺少原生切关证据）`, `${route.completed ? "Complete path" : "Partial path"} (native chapter-transition evidence missing)`);
}

export function historicalInspectionStatus(routes) {
  if (routes.length === 1) return historicalInspectionRouteStatus(routes[0]);
  const completed = routes.filter(route => route.gameCompleted === true).length;
  const unfinished = routes.filter(route => route.gameCompleted === false).length;
  const unknown = routes.length - completed - unfinished;
  const full = routes.filter(route => route.completed).length;
  return [completed && tr(`已完成本关 ${completed} 人`, `${completed} members completed this chapter`), unfinished && tr(`本关尚未完成 ${unfinished} 人`, `${unfinished} members have not completed this chapter`),
    unknown && tr(`${unknown} 人缺少原生切关证据`, `${unknown} members lack native chapter-transition evidence`), full && tr(`${full} 条完整线路`, `${full} complete paths`),
    routes.length - full && tr(`仅有部分线路 ${routes.length - full} 条`, `${routes.length - full} partial paths`)].filter(Boolean).join(" · ");
}
