import { createCommunityRoutes } from "./community-routes.js";
import { communityGroupLabel, communityTeamLabel } from "./community-route-model.js";
import { historicalInspectionRouteStatus } from "./historical-route-link.js";

// The same map/camera remains in place while a small history layer is selected.
// This panel never enters replay, opens sockets, or creates a render loop.
export function createCommunityMapPanel({ getContext, getScene, root = document, fetchImpl, onOpenTeam = null } = {}) {
  const $ = id => root.getElementById(id);
  const elements = Object.fromEntries(["appShell", "communityToggle", "communityLayerControl", "communityMode", "communityPanel", "communityRefresh",
    "communityStatus", "communityFilters", "communityGroupField", "communityGroup", "communityDifficulty",
    "communityHeight", "communityLegend", "communityPlayers", "communityCollapse", "communitySearchForm", "communityMemberSearch", "communitySearchScope",
    "communitySearchButton", "communityTeamSearchStatus", "communityTeamResults", "communityTeamClear", "communityCountBy", "communityReference",
    "communityMembersControls", "communityAllPlayers"].map(id => [id, $(id)]));
  let contextMap = null, contextStage, contextGroup = null, contextInspection = null, contextTeam = null, opened = false, disposed = false;
  const listeners = [];
  const controller = createCommunityRoutes({ onChange: render, fetchImpl });
  function option(value, text) {
    const element = root.createElement("option"); element.value = String(value); element.textContent = text; return element;
  }
  function listen(element, event, fn) { if (!element) return; element.addEventListener(event, fn); listeners.push(() => element.removeEventListener(event, fn)); }
  function enabledContext() {
    const context = getContext();
    return Boolean(context.enabled && context.mapPack);
  }
  function interactive() { return !disposed && opened && enabledContext(); }
  function visibility() {
    const enabled = enabledContext();
    const shown = enabled && opened;
    elements.communityToggle.hidden = !enabled;
    elements.communityToggle.setAttribute("aria-expanded", String(shown));
    elements.communityLayerControl.hidden = elements.communityPanel.hidden = !shown;
    elements.appShell.classList.toggle("community-panel-open", shown);
  }
  function close({ clear = false } = {}) {
    opened = false; visibility();
    if (clear) controller.clear();
  }
  function applyOverlay(snapshot) {
    const context = getContext();
    const ready = context.enabled && context.mapPack?.mapPackId === snapshot.mapPackId && context.stageIndex === snapshot.stageIndex
      && ["ready", "empty"].includes(snapshot.status) && snapshot.group;
    getScene()?.setCommunityOverlay({ mode: ready ? snapshot.mode : "off", mapPackId: snapshot.mapPackId,
      stageIndex: snapshot.stageIndex, routes: snapshot.routes, heatmap: snapshot.heatmap,
      visiblePlayers: new Set(snapshot.players.filter(player => player.visible).map(player => player.playerKey)), heightBand: snapshot.heightBand,
      referencePlayerKey: snapshot.referencePlayerKey, teamId: snapshot.teamId });
  }
  function render(snapshot) {
    if (disposed) return;
    visibility();
    elements.communityMode.value = snapshot.mode;
    const heatOption = elements.communityMode.querySelector?.('option[value="heatmap"]');
    if (heatOption) { heatOption.disabled = Boolean(snapshot.inspectionId); heatOption.hidden = Boolean(snapshot.inspectionId); }
    const teamOption = elements.communityMode.querySelector?.('option[value="team"]');
    if (teamOption) { teamOption.disabled = !snapshot.teamId || Boolean(snapshot.inspectionId); teamOption.hidden = Boolean(snapshot.inspectionId); }
    const routesOption = elements.communityMode.querySelector?.('option[value="routes"]');
    if (routesOption) routesOption.textContent = snapshot.teamId ? "成员路线" : "大家的路线";
    const active = opened && snapshot.mode !== "off";
    elements.communityStatus.dataset.state = snapshot.status;
    elements.communityStatus.textContent = active ? snapshot.message || "选择一个关卡查看大家的路线。"
      : "切换线路图层，查看大家完成本关的路线与热力。";
    elements.communityRefresh.disabled = snapshot.status === "loading";
    elements.communityFilters.hidden = !active || !snapshot.group;
    elements.communityGroupField.hidden = snapshot.groups.length < 2;
    elements.communityGroup.disabled = Boolean(snapshot.pinnedGroupId);
    elements.communityGroup.replaceChildren(...snapshot.groups.map((group, index) => option(group.id, communityGroupLabel(group, index))));
    elements.communityGroup.value = snapshot.group?.id || "";
    elements.communityDifficulty.replaceChildren(option("", "全部难度"), ...snapshot.difficulties.map(value => option(value.key, value.label || "难度未知")));
    elements.communityDifficulty.value = snapshot.difficulty;
    elements.communityDifficulty.disabled = Boolean(snapshot.inspectionId || snapshot.teamId);
    const difficultyField = elements.communityDifficulty.closest?.("label");
    if (difficultyField) difficultyField.hidden = Boolean(snapshot.inspectionId);
    elements.communityHeight.replaceChildren(option("", "全部高度"), ...snapshot.heightBands.map(band => {
      const step = (snapshot.heatmap?.heightBandCm || 200) / 100;
      return option(band, `${band * step}–${(band + 1) * step} 米`);
    }));
    elements.communityHeight.value = snapshot.heightBand === null ? "" : String(snapshot.heightBand);
    elements.communityLegend.hidden = !active || !snapshot.totalRouteCount;
    const visible = snapshot.players.filter(player => player.visible).length;
    elements.communityLegend.textContent = snapshot.mode === "heatmap"
      ? `按${snapshot.countBy === "team" ? "队伍" : "成员"}统计 · 同一${snapshot.countBy === "team" ? "队伍" : "成员"}在同一空间格只计一次\n浅黄 → 深红：经过${snapshot.countBy === "team" ? "队伍" : "人数"}逐渐增多\n仅完整线路 · 可按高度层筛选`
      : `${snapshot.inspectionId ? "验收预览 · " : snapshot.teamId ? "本队 · " : ""}${visible} / ${snapshot.players.length} 位可见成员 · ${snapshot.mode === "team" ? "共享路段合并，独走段保留 · " : ""}断点不连接${snapshot.inspectionId ? " · 不参与公开路线与热力统计" : ""}`;
    if (elements.communitySearchForm) elements.communitySearchForm.hidden = Boolean(snapshot.inspectionId);
    if (elements.communitySearchButton) elements.communitySearchButton.disabled = snapshot.teamSearchStatus === "loading";
    if (elements.communityTeamSearchStatus) { elements.communityTeamSearchStatus.hidden = Boolean(snapshot.inspectionId); elements.communityTeamSearchStatus.textContent = snapshot.teamSearchMessage || "输入成员名字，查找他参与的队伍。"; }
    if (elements.communityTeamResults) {
      elements.communityTeamResults.replaceChildren();
      if (!snapshot.inspectionId) for (const team of snapshot.teams) {
        const button = root.createElement("button"); button.type = "button"; button.className = "community-team-result";
        button.textContent = communityTeamLabel(team); button.setAttribute("aria-pressed", String(team.id === snapshot.teamId));
        button.addEventListener("click", () => {
          if (!interactive()) return;
          if (typeof onOpenTeam === "function") { void onOpenTeam(team); return; }
          if (team.groupId !== snapshot.group?.id) return;
          void controller.selectTeam(team.id);
        });
        elements.communityTeamResults.append(button);
      }
    }
    if (elements.communityTeamClear) elements.communityTeamClear.hidden = !snapshot.teamId || Boolean(snapshot.inspectionId);
    if (elements.communityCountBy) { elements.communityCountBy.value = snapshot.countBy; elements.communityCountBy.closest?.("label")?.toggleAttribute?.("hidden", snapshot.mode !== "heatmap"); }
    if (elements.communityMembersControls) elements.communityMembersControls.hidden = !active || !["routes", "team"].includes(snapshot.mode) || !snapshot.players.length;
    if (elements.communityAllPlayers) { elements.communityAllPlayers.checked = Boolean(snapshot.players.length) && visible === snapshot.players.length; elements.communityAllPlayers.indeterminate = visible > 0 && visible < snapshot.players.length; }
    if (elements.communityReference) {
      elements.communityReference.replaceChildren(option("", "不指定参考队长"), ...snapshot.players.map(player => option(player.playerKey, player.name)));
      elements.communityReference.value = snapshot.referencePlayerKey || "";
      elements.communityReference.closest?.("label")?.toggleAttribute?.("hidden", snapshot.mode !== "team");
    }
    elements.communityPlayers.replaceChildren();
    if (active && ["routes", "team"].includes(snapshot.mode)) for (const player of snapshot.players) {
      const label = root.createElement("label"); label.className = "community-player";
      const check = root.createElement("input"); check.type = "checkbox"; check.checked = player.visible;
      check.setAttribute("aria-label", `显示 ${player.name} 的路线`);
      check.addEventListener("change", () => { if (interactive()) controller.setPlayerVisible(player.id, check.checked); });
      const dot = root.createElement("i"); dot.style.backgroundColor = player.color; dot.setAttribute("aria-hidden", "true");
      const name = root.createElement("span");
      const recordedRoute = snapshot.inspectionId || snapshot.teamId ? snapshot.routes.find(route => (route.playerKey || route.id) === player.id) : null;
      name.textContent = `${player.name}${!player.hasPoints ? "（本关无记录）" : recordedRoute ? `（${historicalInspectionRouteStatus(recordedRoute)}）` : ""}`;
      label.append(check, dot, name); elements.communityPlayers.append(label);
    }
    applyOverlay(snapshot);
  }
  listen(elements.communityToggle, "click", () => {
    if (disposed || !enabledContext()) return;
    // A context change may precede the application's normal sync callback.
    sync();
    if (opened) { close(); return; }
    opened = true; visibility(); render(controller.getSnapshot());
    const context = getContext();
    const snapshot = controller.getSnapshot();
    if (snapshot.mapPackId !== context.mapPack.mapPackId || snapshot.stageIndex !== context.stageIndex) {
      void controller.enterMap(context.mapPack, { stageIndex: context.stageIndex, groupId: context.routeGroupId || null, inspectionId: context.inspectionId || null, teamId: context.teamId || null });
    }
  });
  listen(elements.communityCollapse, "click", () => { if (!disposed) close(); });
  listen(elements.communitySearchForm, "submit", event => {
    event.preventDefault?.(); if (!interactive()) return;
    void controller.searchTeams({ member: elements.communityMemberSearch?.value || "", allMaps: elements.communitySearchScope?.value === "all" });
  });
  listen(elements.communityTeamClear, "click", () => {
    if (!interactive()) return;
    if (typeof onOpenTeam === "function") void onOpenTeam(null); else void controller.selectTeam(null);
  });
  listen(elements.communityCountBy, "change", () => { if (interactive()) void controller.setCountBy(elements.communityCountBy.value); });
  listen(elements.communityReference, "change", () => { if (interactive()) controller.setReferencePlayer(elements.communityReference.value || null); });
  listen(elements.communityAllPlayers, "change", () => { if (interactive()) controller.setAllPlayersVisible(elements.communityAllPlayers.checked); });
  listen(elements.communityMode, "change", () => {
    if (!interactive()) return;
    if (getContext().inspectionId && elements.communityMode.value === "heatmap") {
      elements.communityMode.value = controller.getSnapshot().mode; return;
    }
    void controller.setMode(elements.communityMode.value);
  });
  listen(elements.communityRefresh, "click", () => { if (interactive()) void controller.refresh(); });
  listen(elements.communityGroup, "change", () => { if (interactive()) void controller.selectGroup(elements.communityGroup.value); });
  listen(elements.communityDifficulty, "change", () => { if (interactive()) void controller.setDifficulty(elements.communityDifficulty.value); });
  listen(elements.communityHeight, "change", () => { if (interactive()) controller.setHeightBand(elements.communityHeight.value === "" ? null : Number(elements.communityHeight.value)); });
  function sync({ restore = false } = {}) {
    if (disposed) return;
    const context = getContext();
    const enabled = Boolean(context.enabled && context.mapPack);
    if (!enabled) {
      if (contextMap !== null || opened) { contextMap = null; contextStage = undefined; contextGroup = contextInspection = contextTeam = null; close({ clear: true }); }
      else { visibility(); if (restore) getScene()?.setCommunityOverlay({ mode: "off" }); }
      return;
    }
    if (context.mapPack.mapPackId !== contextMap || (context.routeGroupId || null) !== contextGroup || (context.inspectionId || null) !== contextInspection || (context.teamId || null) !== contextTeam) {
      contextMap = context.mapPack.mapPackId; contextStage = context.stageIndex; contextGroup = context.routeGroupId || null; contextInspection = context.inspectionId || null; contextTeam = context.teamId || null;
      close({ clear: true });
    } else if (context.stageIndex !== contextStage) {
      contextStage = context.stageIndex;
      if (controller.getSnapshot().mapPackId) void controller.setStage(contextStage);
      else if (restore) getScene()?.setCommunityOverlay({ mode: "off" });
    } else if (restore) applyOverlay(controller.getSnapshot());
    visibility();
  }
  async function openHistorical() {
    if (disposed || !enabledContext() || !getContext().routeGroupId) return;
    sync();
    opened = true; visibility(); render(controller.getSnapshot());
    const context = getContext();
    await controller.enterMap(context.mapPack, { stageIndex: context.stageIndex, groupId: context.routeGroupId, inspectionId: context.inspectionId || null, teamId: context.teamId || null,
      mode: context.teamId ? "team" : "routes" });
  }
  function dispose() {
    if (disposed) return;
    close({ clear: true });
    elements.communityToggle.hidden = true;
    disposed = true; listeners.forEach(remove => remove()); controller.dispose();
  }
  return { sync, openHistorical, dispose };
}
