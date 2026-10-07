import { createCommunityRoutes } from "./community-routes.js";
import { communityGroupLabel } from "./community-route-model.js";

// The same map/camera remains in place while a small history layer is selected.
// This panel never enters replay, opens sockets, or creates a render loop.
export function createCommunityMapPanel({ getContext, getScene, root = document, fetchImpl } = {}) {
  const $ = id => root.getElementById(id);
  const elements = Object.fromEntries(["appShell", "communityToggle", "communityLayerControl", "communityMode", "communityPanel", "communityRefresh",
    "communityStatus", "communityFilters", "communityGroupField", "communityGroup", "communityDifficulty",
    "communityHeight", "communityLegend", "communityPlayers"].map(id => [id, $(id)]));
  let contextMap = null, contextStage, opened = false, disposed = false;
  const listeners = [];
  const controller = createCommunityRoutes({ onChange: render, fetchImpl });
  function option(value, text) {
    const element = root.createElement("option"); element.value = String(value); element.textContent = text; return element;
  }
  function listen(element, event, fn) { element.addEventListener(event, fn); listeners.push(() => element.removeEventListener(event, fn)); }
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
    getScene()?.setCommunityOverlay({ mode: "off" });
    if (clear) controller.clear(); else void controller.setMode("off");
  }
  function applyOverlay(snapshot) {
    const context = getContext();
    const ready = opened && context.enabled && context.mapPack?.mapPackId === snapshot.mapPackId && context.stageIndex === snapshot.stageIndex
      && ["ready", "empty"].includes(snapshot.status) && snapshot.group;
    getScene()?.setCommunityOverlay({ mode: ready ? snapshot.mode : "off", mapPackId: snapshot.mapPackId,
      stageIndex: snapshot.stageIndex, routes: snapshot.routes, heatmap: snapshot.heatmap,
      visiblePlayers: new Set(snapshot.players.filter(player => player.visible).map(player => player.id)), heightBand: snapshot.heightBand });
  }
  function render(snapshot) {
    if (disposed) return;
    visibility();
    elements.communityMode.value = snapshot.mode;
    const active = opened && snapshot.mode !== "off";
    elements.communityStatus.dataset.state = snapshot.status;
    elements.communityStatus.textContent = active ? snapshot.message || "选择一个关卡查看大家的路线。"
      : "切换线路图层，查看大家完成本关的路线与热力。";
    elements.communityRefresh.disabled = snapshot.status === "loading";
    elements.communityFilters.hidden = !active || !snapshot.group;
    elements.communityGroupField.hidden = snapshot.groups.length < 2;
    elements.communityGroup.replaceChildren(...snapshot.groups.map((group, index) => option(group.id, communityGroupLabel(group, index))));
    elements.communityGroup.value = snapshot.group?.id || "";
    elements.communityDifficulty.replaceChildren(option("", "全部难度"), ...snapshot.difficulties.map(value => option(value.key, value.label || "难度未知")));
    elements.communityDifficulty.value = snapshot.difficulty;
    elements.communityHeight.replaceChildren(option("", "全部高度"), ...snapshot.heightBands.map(band => {
      const step = (snapshot.heatmap?.heightBandCm || 200) / 100;
      return option(band, `${band * step}–${(band + 1) * step} 米`);
    }));
    elements.communityHeight.value = snapshot.heightBand === null ? "" : String(snapshot.heightBand);
    elements.communityLegend.hidden = !active || !snapshot.totalRouteCount;
    const visible = snapshot.players.filter(player => player.visible).length;
    elements.communityLegend.textContent = snapshot.mode === "heatmap"
      ? `${snapshot.totalRouteCount} 条完整路线 · 每条路线在同一空间格只计一次\n浅黄 → 深红：经过路线逐渐增多\n透视展示 · 可按高度层筛选`
      : `${visible} / ${snapshot.players.length} 条可见路线 · 断点不连接`;
    elements.communityPlayers.replaceChildren();
    if (active && snapshot.mode === "routes") for (const player of snapshot.players) {
      const label = root.createElement("label"); label.className = "community-player";
      const check = root.createElement("input"); check.type = "checkbox"; check.checked = player.visible;
      check.setAttribute("aria-label", `显示 ${player.name} 的路线`);
      check.addEventListener("change", () => { if (interactive()) controller.setPlayerVisible(player.id, check.checked); });
      const dot = root.createElement("i"); dot.style.backgroundColor = player.color; dot.setAttribute("aria-hidden", "true");
      const name = root.createElement("span"); name.textContent = player.name;
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
    void controller.enterMap(context.mapPack, { stageIndex: context.stageIndex });
  });
  listen(elements.communityMode, "change", () => { if (interactive()) void controller.setMode(elements.communityMode.value); });
  listen(elements.communityRefresh, "click", () => { if (interactive()) void controller.refresh(); });
  listen(elements.communityGroup, "change", () => { if (interactive()) void controller.selectGroup(elements.communityGroup.value); });
  listen(elements.communityDifficulty, "change", () => { if (interactive()) void controller.setDifficulty(elements.communityDifficulty.value); });
  listen(elements.communityHeight, "change", () => { if (interactive()) controller.setHeightBand(elements.communityHeight.value === "" ? null : Number(elements.communityHeight.value)); });
  function sync({ restore = false } = {}) {
    if (disposed) return;
    const context = getContext();
    const enabled = Boolean(context.enabled && context.mapPack);
    if (!enabled) {
      if (contextMap !== null || opened) { contextMap = null; contextStage = undefined; close({ clear: true }); }
      else { visibility(); if (restore) getScene()?.setCommunityOverlay({ mode: "off" }); }
      return;
    }
    if (context.mapPack.mapPackId !== contextMap) {
      contextMap = context.mapPack.mapPackId; contextStage = context.stageIndex;
      close({ clear: true });
    } else if (context.stageIndex !== contextStage) {
      contextStage = context.stageIndex;
      if (opened) void controller.setStage(contextStage);
    } else if (restore && opened) applyOverlay(controller.getSnapshot());
    if (restore && !opened) getScene()?.setCommunityOverlay({ mode: "off" });
    visibility();
  }
  function dispose() {
    if (disposed) return;
    close({ clear: true });
    elements.communityToggle.hidden = true;
    disposed = true; listeners.forEach(remove => remove()); controller.dispose();
  }
  return { sync, dispose };
}
