import { communityMapIdentity, communityPlayers, matchingCommunityGroups, normalizeCommunityStage, pendingCommunityMessage } from "./community-route-model.js";
import { normalizeHistoricalInspection } from "./historical-route-link.js";

const MAX_RESPONSE_BYTES = 30_000_000;
const displayError = error => error?.message || "大家的路线暂时无法读取，请稍后刷新。";

// The controller is activated only by enterMap. There are no timers, sockets,
// upload calls, or requests from the landing page.
export function createCommunityRoutes({ fetchImpl = globalThis.fetch?.bind(globalThis), onChange = () => {}, apiBase = "/api/route-groups" } = {}) {
  let disposed = false, revision = 0, request = null, requestKind = null, mapPack = null;
  let hidden = new Set();
  let state = freshState();

  function freshState() {
    return { status: "idle", groups: [], group: null, pinnedGroupId: null, inspectionId: null, inspectionLoaded: false,
      stageIndex: null, difficulty: "", difficulties: [],
      routes: [], heatmap: null, players: [], heightBands: [], heightBand: null, mode: "off",
      totalRouteCount: 0, truncated: false, unavailableCount: 0, message: "" };
  }
  function getSnapshot() { return { ...state, mapPackId: mapPack?.mapPackId || null, players: communityPlayers(state.routes, hidden) }; }
  function emit() { if (!disposed) onChange(getSnapshot()); }
  function invalidate() { request?.abort(); request = null; requestKind = null; revision++; }
  function begin(kind) { invalidate(); request = new AbortController(); requestKind = kind; return { revision, signal: request.signal }; }
  function clearData() {
    hidden = new Set();
    Object.assign(state, { routes: [], heatmap: null, players: [], heightBands: [], heightBand: null, totalRouteCount: 0, truncated: false, inspectionLoaded: false });
  }
  function active(token) { return !disposed && token.revision === revision && mapPack !== null; }
  async function readApi(path, signal) {
    if (typeof fetchImpl !== "function") throw new Error("浏览器无法读取大家的路线。");
    const response = await fetchImpl(path, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`大家的路线暂不可用（HTTP ${response.status}）`);
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("路线服务尚未启用，请稍后再试。");
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) throw new Error("路线响应过大，请选择更具体的难度。");
    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) throw new Error("路线响应过大，请选择更具体的难度。");
    return JSON.parse(body);
  }
  function fail(error, token) {
    if (!active(token) || error?.name === "AbortError") return;
    invalidate();
    clearData(); state.status = "error"; state.message = displayError(error); emit();
  }
  function describeData() {
    state.status = state.totalRouteCount ? "ready" : "empty";
    if (state.inspectionId) {
      state.message = state.totalRouteCount ? `验收预览 · ${state.routes.length} 条玩家轨迹 · 未完整关卡不计公开路线或热力。`
        : "验收预览 · 当前关卡没有录制轨迹；未完整关卡不计公开路线或热力。";
      return;
    }
    state.message = state.totalRouteCount ? state.truncated
      ? `本页展示 ${state.routes.length} / ${state.totalRouteCount} 条路线，热力统计全部有效路线。` : `${state.totalRouteCount} 条审核通过的完整关卡路线。`
      : "当前关卡和难度还没有公开的完整路线。";
  }
  async function loadStage() {
    if (disposed || !mapPack) return;
    const token = begin("stage");
    clearData();
    const group = state.group;
    const stage = state.stageIndex;
    if (!group) { emit(); return; }
    if (stage === null || !group.stageSummaries.some(value => value.index === stage)) {
      state.status = "empty"; state.message = "选择一个关卡即可查看大家的路线。"; emit(); return;
    }
    if (state.mode === "off") {
      state.status = "ready"; state.message = "选择大家的路线或热力图即可查看。"; emit(); return;
    }
    state.status = "loading"; state.message = "正在读取当前关卡的路线…"; emit();
    const base = `${apiBase}/${encodeURIComponent(group.id)}/stages/${stage}`;
    const filter = state.difficulty ? `?difficulty=${encodeURIComponent(state.difficulty)}` : "";
    try {
      if (state.inspectionId) {
        const body = await readApi(`${apiBase}/${encodeURIComponent(group.id)}/uploads/${state.inspectionId}/stages/${stage}/inspection`, token.signal);
        if (!active(token)) return;
        Object.assign(state, normalizeHistoricalInspection(body, group, mapPack, stage, state.inspectionId));
        describeData(); emit(); return;
      }
      const [routes, heat] = await Promise.all([readApi(`${base}/routes${filter}`, token.signal), readApi(`${base}/heatmap${filter}`, token.signal)]);
      if (!active(token)) return;
      Object.assign(state, normalizeCommunityStage(routes, heat, group, mapPack, stage));
      describeData();
      emit();
    } catch (error) { fail(error, token); }
  }
  async function refresh() {
    if (disposed || !mapPack) return;
    const previousId = state.group?.id, previousDifficulty = state.difficulty;
    const token = begin("groups");
    clearData(); state.groups = []; state.group = null; state.difficulties = [];
    state.status = "loading"; state.message = "正在读取当前地图的公开路线…"; emit();
    try {
      const { matching, unavailableCount, pendingReasons } = matchingCommunityGroups(await readApi(apiBase, token.signal), mapPack);
      if (!active(token)) return;
      state.groups = state.pinnedGroupId ? matching.filter(group => group.id === state.pinnedGroupId) : matching;
      state.unavailableCount = unavailableCount;
      // Select one recorded layout, never concatenate several layouts merely
      // because their scene and game build share a name.
      state.group = state.groups.find(group => group.id === previousId) || state.groups[0] || null;
      state.difficulties = state.group?.difficulties || [];
      state.difficulty = state.difficulties.some(value => value.key === previousDifficulty) ? previousDifficulty : "";
      if (!state.group) {
        state.status = unavailableCount ? "mismatch" : "empty";
        state.message = state.pinnedGroupId ? "这个历史路线组暂不可用，未切换到其他记录或今日路线。"
          : unavailableCount ? pendingCommunityMessage(pendingReasons) : "当前地图还没有审核通过的完整关卡路线。";
        emit(); return;
      }
      await loadStage();
    } catch (error) { fail(error, token); }
  }
  async function enterMap(nextMapPack, { stageIndex = null, groupId = null, inspectionId = null, mode = null } = {}) {
    if (disposed) return;
    if (groupId !== null && !/^[a-f0-9]{64}$/.test(groupId)) throw new Error("历史路线组无效。");
    if (inspectionId !== null && (!groupId || !/^[a-f0-9]{64}$/.test(inspectionId))) throw new Error("历史验收投稿无效。");
    const identity = communityMapIdentity(nextMapPack);
    if (!identity) {
      invalidate(); mapPack = nextMapPack || null; state = freshState(); state.status = "mismatch";
      state.message = "当前地图缺少可靠的版本或关卡分支信息，暂不叠加玩家路线。"; emit(); return;
    }
    if (identity === communityMapIdentity(mapPack) && groupId === state.pinnedGroupId && inspectionId === state.inspectionId) {
      mapPack = nextMapPack;
      await setStage(stageIndex);
      if (mode !== null) await setMode(mode);
      return;
    }
    invalidate(); mapPack = nextMapPack; hidden = new Set(); state = freshState();
    state.pinnedGroupId = groupId;
    state.inspectionId = inspectionId;
    if (mode === "routes" || (!inspectionId && mode === "heatmap")) state.mode = mode;
    state.stageIndex = Number.isInteger(stageIndex) && stageIndex >= 0 ? stageIndex : null;
    await refresh();
  }
  async function selectGroup(id) {
    if (disposed || !mapPack) return;
    const group = state.groups.find(value => value.id === id);
    if (state.pinnedGroupId && id !== state.pinnedGroupId) return;
    if (!group || group === state.group) return;
    state.group = group; state.difficulties = group.difficulties;
    if (!group.difficulties.some(value => value.key === state.difficulty)) state.difficulty = "";
    await loadStage();
  }
  async function setStage(value) {
    if (disposed || !mapPack) return;
    const stage = Number.isInteger(value) && value >= 0 ? value : null;
    if (stage === state.stageIndex) return;
    state.stageIndex = stage;
    if (state.group) await loadStage(); else emit();
  }
  async function setDifficulty(value) {
    if (disposed || !mapPack || state.inspectionId) return;
    const key = value === "" || state.difficulties.some(difficulty => difficulty.key === value) ? value : "";
    if (key === state.difficulty) return;
    state.difficulty = key; await loadStage();
  }
  async function setMode(value) {
    if (disposed || !["off", "routes", "heatmap"].includes(value) || state.mode === value) return;
    if (state.inspectionId && value === "heatmap") return;
    state.mode = value;
    if (value === "off" && requestKind !== "groups") {
      const wasLoading = state.status === "loading";
      invalidate();
      if (wasLoading) clearData();
      if (state.group) {
        state.status = state.stageIndex === null ? "empty" : "ready";
        state.message = state.stageIndex === null ? "选择一个关卡即可查看大家的路线。" : "选择大家的路线或热力图即可查看。";
      }
      emit(); return;
    }
    if (state.group && (state.heatmap !== null || state.inspectionLoaded)) { describeData(); emit(); }
    else if (state.group && state.status !== "loading") await loadStage();
    else emit();
  }
  function setHeightBand(value) {
    if (disposed) return;
    const band = value === null || state.heightBands.includes(value) ? value : null;
    if (state.heightBand === band) return;
    state.heightBand = band; emit();
  }
  function setPlayerVisible(id, visible) {
    if (disposed || !state.routes.some(route => route.id === id)) return;
    if (visible) hidden.delete(id); else hidden.add(id);
    emit();
  }
  function clear() { if (disposed) return; invalidate(); mapPack = null; state = freshState(); hidden = new Set(); emit(); }
  function dispose() { if (disposed) return; invalidate(); mapPack = null; disposed = true; state = freshState(); hidden = new Set(); }
  return { enterMap, refresh, selectGroup, setStage, setDifficulty, setMode, setHeightBand, setPlayerVisible, clear, dispose, getSnapshot };
}
