import { normalizeRoute } from "./map-route.js";
import { heightBands, normalizeHeatmap, normalizeRouteGroups, normalizeRoutes, routeColor } from "./route-collection-model.js";

const HASH = /^[a-f0-9]{64}$/;
const PACK_ID = /^sha256-[a-f0-9]{64}$/;
const canonicalName = value => value === "Citadel" ? "Temple" : String(value || "");
function verifiedAlignment(value) {
  return value?.status === "verified" && HASH.test(value.id || "") && ["identity", "rigid", "legacy-layout-key"].includes(value.method)
    && Number.isInteger(value.landmarkCount) && value.landmarkCount >= 3 && value.landmarkCount <= 16
    && Number.isFinite(value.maxErrorCm) && value.maxErrorCm >= 0 && value.maxErrorCm <= 5;
}

export function mapRouteStages(mapPack) {
  const route = normalizeRoute(mapPack?.route);
  if (!route || route.branch === "unknown") return [];
  const stages = route.segments.map(segment => ({ index: segment.index, name: segment.index === 4
    ? route.branch === "volcano-kiln" ? "Kiln" : "Temple" : canonicalName(segment.biome) }));
  // The separate Nadir layer is actual map evidence; it is not inferred from a
  // date, a Level_N number, or an array index without a matching biome.
  for (const layer of mapPack.layers || []) {
    if ((String(layer.biome).toLowerCase() === "void" || layer.biomeId === 17)
      && Number.isInteger(layer.segment) && !stages.some(stage => stage.index === layer.segment)) {
      stages.push({ index: layer.segment, name: "Void" });
    }
  }
  return stages.sort((a, b) => a.index - b.index);
}

export function communityMapIdentity(mapPack) {
  return mapPack && PACK_ID.test(mapPack.mapPackId || "") && String(mapPack.gameBuildId || "").trim()
    && typeof mapPack.sceneName === "string" && mapRouteStages(mapPack).length
    ? JSON.stringify([mapPack.mapPackId, String(mapPack.gameBuildId), mapPack.sceneName, mapRouteStages(mapPack)]) : null;
}

export function matchesCommunityGroup(group, mapPack) {
  if (!communityMapIdentity(mapPack) || group?.mapCompatibility !== "matched" || !verifiedAlignment(group.mapAlignment)
    || group.mapPackId !== mapPack.mapPackId || String(group.map?.buildId) !== String(mapPack.gameBuildId)
    || group.map?.scene !== mapPack.sceneName || !HASH.test(group.map?.layoutKey || "")
    || !Array.isArray(group.map?.route) || !Array.isArray(group.map?.stages)) return false;
  const actualStages = mapRouteStages(mapPack);
  const recorded = group.map.route;
  // A recording may omit the optional Nadir branch, but it must prove every
  // ordinary chapter and exactly match the chosen native terminal branch.
  if (actualStages.some(stage => stage.name !== "Void" && canonicalName(recorded[stage.index]) !== stage.name)) return false;
  if (!recorded.length || recorded.some((name, index) => !actualStages.some(stage => stage.index === index && stage.name === canonicalName(name)))) return false;
  if (group.map.stages.length !== recorded.length || group.map.stages.some((stage, index) => stage.index !== index
    || canonicalName(stage.name) !== canonicalName(recorded[index]))) return false;
  return group.stageSummaries.every(stage => Number.isInteger(stage.index) && stage.index >= 0
    && stage.index < recorded.length && canonicalName(stage.name) === canonicalName(recorded[stage.index])
    && Number.isSafeInteger(stage.routeCount) && stage.routeCount >= 0);
}

export function matchingCommunityGroups(value, mapPack) {
  const groups = normalizeRouteGroups(value);
  const sameScene = groups.filter(group => group.map.scene === mapPack?.sceneName);
  const matching = sameScene.filter(group => matchesCommunityGroup(group, mapPack));
  return { matching, unavailableCount: sameScene.length - matching.length,
    pendingReasons: [...new Set(sameScene.filter(group => !matchesCommunityGroup(group, mapPack)).map(group =>
      String(group.map?.buildId) !== String(mapPack.gameBuildId) ? "map-build-unavailable" : group.mapAlignment?.reason || "alignment-unproven"))] };
}

export function pendingCommunityMessage(reasons = []) {
  if (reasons.includes("map-build-unavailable")) return "已有路线与当前底图的游戏版本不同，暂时不能显示在这张地图上。";
  if (reasons.includes("recording-landmarks-missing")) return "旧录像未记录地图地标，路线已保留；需要验证原地图布局后才能显示。";
  if (reasons.includes("source-landmarks-missing")) return "路线已保留，正在等待当前地图模型的地标数据，验证对齐后才能显示。";
  return "已有路线的布局、地标或关卡分支尚未通过对齐验证，暂不叠加到地图。";
}

export function normalizeCommunityStage(rawRoutes, rawHeatmap, group, mapPack, stageIndex) {
  for (const value of [rawRoutes, rawHeatmap]) {
    if (value?.groupId !== group.id || value.stageIndex !== stageIndex || value.mapCompatibility !== "matched"
      || value.mapPackId !== mapPack.mapPackId || !verifiedAlignment(value.mapAlignment)
      || value.mapAlignment.id !== group.mapAlignment?.id || value.coordinateSpace !== "canonical-map-world-cm") throw new Error("返回的路线与当前地图或关卡不一致，请刷新。");
  }
  if (!matchesCommunityGroup(group, mapPack) || !group.stageSummaries.some(stage => stage.index === stageIndex)) {
    throw new Error("当前地图没有这个关卡的已核验路线。");
  }
  const response = normalizeRoutes(rawRoutes);
  const heatmap = normalizeHeatmap(rawHeatmap);
  return { routes: response.routes, heatmap, totalRouteCount: response.totalRouteCount,
    truncated: Boolean(response.truncated), heightBands: heightBands(response.routes, heatmap, heatmap.heightBandCm) };
}

export function communityPlayers(routes, hidden = new Set()) {
  return routes.map((route, index) => ({ id: route.id, playerKey: route.playerKey, name: route.name,
    color: routeColor(index), visible: !hidden.has(route.id), difficulty: route.difficulty || null }));
}

export function communityGroupLabel(group, index = 0) {
  const number = Number.isInteger(group.map?.levelIndex) ? `轮换 ${group.map.levelIndex} · ` : "";
  const count = (group.stageSummaries || []).reduce((total, stage) => total + (stage.routeCount || 0), 0);
  return `${number}记录组 ${index + 1} · ${count} 条完整关卡路线`;
}
