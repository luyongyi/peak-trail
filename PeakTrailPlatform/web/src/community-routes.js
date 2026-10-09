import { communityMapIdentity, communityPlayers, matchingCommunityGroups, normalizeCommunityStage, normalizeCommunityTeams, normalizeCommunityTeamStage, pendingCommunityMessage } from "./community-route-model.js";
import { historicalInspectionStatus, normalizeHistoricalInspection } from "./historical-route-link.js";
import { heightBands } from "./route-collection-model.js";

const MAX_RESPONSE_BYTES = 30_000_000;
const displayError = error => error?.message || "大家的路线暂时无法读取，请稍后刷新。";
function waitForRetry(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("Aborted", "AbortError")); };
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// The controller is activated only by enterMap. There are no timers, sockets,
// upload calls, or requests from the landing page.
export function createCommunityRoutes({ fetchImpl = globalThis.fetch?.bind(globalThis), onChange = () => {}, apiBase = "/api/route-groups", teamApiBase = "/api/route-teams", retryDelay = waitForRetry } = {}) {
  let disposed = false, revision = 0, request = null, requestKind = null, mapPack = null;
  let searchRequest = null, searchRevision = 0;
  let hidden = new Set();
  let state = freshState();

  function freshState() {
    return { status: "idle", groups: [], group: null, pinnedGroupId: null, inspectionId: null, inspectionLoaded: false,
      stageIndex: null, difficulty: "", difficulties: [],
      routes: [], heatmap: null, players: [], heightBands: [], heightBand: null, mode: "off",
      teamId: null, teamLoaded: false, teams: [], teamSearchStatus: "idle", teamSearchMessage: "", searchMember: "", searchAllMaps: false,
      countBy: "team", referencePlayerKey: null, summitCompleted: false, stageCompleted: false, finisherKeys: [],
      totalRouteCount: 0, truncated: false, unavailableCount: 0, message: "" };
  }
  function getSnapshot() { return { ...state, mapPackId: mapPack?.mapPackId || null, players: communityPlayers(state.routes, hidden) }; }
  function emit() { if (!disposed) onChange(getSnapshot()); }
  function invalidate() { request?.abort(); request = null; requestKind = null; revision++; }
  function begin(kind) { invalidate(); request = new AbortController(); requestKind = kind; return { revision, signal: request.signal }; }
  function clearData() {
    Object.assign(state, { routes: [], heatmap: null, players: [], heightBands: [], heightBand: null, totalRouteCount: 0, truncated: false, inspectionLoaded: false, teamLoaded: false, summitCompleted: false, stageCompleted: false, finisherKeys: [] });
  }
  function active(token) { return !disposed && token.revision === revision && mapPack !== null; }
  async function readApi(path, signal, { retryRate = false } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("浏览器无法读取大家的路线。");
    let response;
    for (let retries = 0; ; retries++) {
      response = await fetchImpl(path, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
      if (response.status !== 429 || !retryRate || retries >= 8) break;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const header = response.headers.get("retry-after");
      const seconds = header?.trim() && Number.isFinite(Number(header)) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
      const milliseconds = Math.ceil(Math.max(1, Math.min(300, Number.isFinite(seconds) ? seconds : 60)) * 1000);
      await response.body?.cancel();
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      state.message = `路线服务繁忙，${Math.ceil(milliseconds / 1000)} 秒后继续读取本队轨迹…`; emit();
      await retryDelay(milliseconds, signal);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    }
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
      state.message = state.totalRouteCount ? `验收预览 · ${state.routes.length} 条玩家轨迹 · ${historicalInspectionStatus(state.routes)} · 不计入公开路线或热力统计。`
        : "验收预览 · 当前关卡没有录制轨迹；不计入公开路线或热力统计。";
      return;
    }
    if (state.teamId) {
      const members = communityPlayers(state.routes), recorded = members.filter(player => player.hasPoints);
      state.status = recorded.length ? "ready" : "empty";
      state.message = recorded.length ? `本队 ${members.length} 位队员 · ${recorded.length} 位有本关轨迹 · ${historicalInspectionStatus(state.routes.filter(route => route.points.length))} · 不完整线路不计入热力。`
        : `本队 ${members.length} 位队员 · 本关暂无录制轨迹。`;
      if (state.summitCompleted) state.message += " 本队已登顶（任一队员完成即全队完成）。";
      if (state.truncated) state.message += " 已达到显示上限，部分成员或轨迹尚未显示。";
      return;
    }
    state.message = state.totalRouteCount ? state.truncated
      ? `本页展示 ${state.routes.length} / ${state.totalRouteCount} 条路线，热力统计全部有效路线。` : `${state.totalRouteCount} 条审核通过的完整关卡路线。`
      : "当前关卡和难度还没有公开的完整路线。";
  }
  async function loadWholeTeamStage(group, stage, token) {
    const path = `${teamApiBase}/${state.teamId}/stages/${stage}/routes`;
    const routes = [], ids = new Set(), cursors = new Set();
    let cursor = null, first = null;
    for (;;) {
      const body = await readApi(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token.signal, { retryRate: true });
      if (!active(token)) return null;
      // Each page is bounded by bytes/points, never by lobby size. Validate map
      // and member identity before combining pages into the complete team.
      normalizeCommunityTeamStage(body, group, mapPack, stage, state.teamId);
      if (!first) first = body;
      else if (body.teamRevision !== first.teamRevision || body.totalRouteCount !== first.totalRouteCount || body.summitCompleted !== first.summitCompleted || body.stageCompleted !== first.stageCompleted
        || JSON.stringify(body.finisherKeys || []) !== JSON.stringify(first.finisherKeys || [])) throw new Error("队伍记录已更新，请刷新后重新读取。");
      for (const route of body.routes) {
        if (ids.has(route.id)) throw new Error("队员路线分页重复，请刷新后重新读取。");
        ids.add(route.id); routes.push(route);
      }
      if (routes.length > first.totalRouteCount) throw new Error("队伍记录已更新，请刷新后重新读取。");
      if (body.nextCursor === null || body.nextCursor === undefined) break;
      if (!/^[a-f0-9]{64}$/.test(body.nextCursor) || cursors.has(body.nextCursor)
        || body.routes.at(-1)?.playerKey !== body.nextCursor) throw new Error("队员路线分页无效，请刷新后重新读取。");
      cursor = body.nextCursor; cursors.add(cursor);
      state.message = `正在读取本队全部轨迹…（${routes.length} / ${first.totalRouteCount} 位队员）`; emit();
    }
    if (!first.truncated && Number.isSafeInteger(first.totalRouteCount) && routes.length !== first.totalRouteCount) throw new Error("队员路线尚未完整返回，请刷新后重新读取。");
    return { ...first, routes, nextCursor: null };
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
    const parameters = new URLSearchParams();
    if (state.difficulty) parameters.set("difficulty", state.difficulty);
    if (state.teamId) parameters.set("team", state.teamId);
    const filter = parameters.size ? `?${parameters}` : "";
    const heatParameters = new URLSearchParams(parameters); heatParameters.set("countBy", state.countBy);
    const heatFilter = `?${heatParameters}`;
    try {
      if (state.inspectionId) {
        const body = await readApi(`${apiBase}/${encodeURIComponent(group.id)}/uploads/${state.inspectionId}/stages/${stage}/inspection`, token.signal);
        if (!active(token)) return;
        Object.assign(state, normalizeHistoricalInspection(body, group, mapPack, stage, state.inspectionId));
        describeData(); emit(); return;
      }
      if (state.teamId) {
        const body = await loadWholeTeamStage(group, stage, token);
        if (!active(token) || !body) return;
        Object.assign(state, normalizeCommunityTeamStage(body, group, mapPack, stage, state.teamId, { maximumPoints: Infinity }));
        if (state.mode === "heatmap") {
          const heat = await readApi(`${base}/heatmap${heatFilter}`, token.signal);
          if (!active(token)) return;
          const normalized = normalizeCommunityStage({ ...body, routes: [] }, heat, group, mapPack, stage);
          state.heatmap = normalized.heatmap; state.heightBands = heightBands(state.routes, normalized.heatmap, normalized.heatmap.heightBandCm);
        }
        if (!state.routes.some(route => route.playerKey === state.referencePlayerKey)) state.referencePlayerKey = null;
        describeData(); emit(); return;
      }
      const [routes, heat] = await Promise.all([readApi(`${base}/routes${filter}`, token.signal), readApi(`${base}/heatmap${heatFilter}`, token.signal)]);
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
  async function enterMap(nextMapPack, { stageIndex = null, groupId = null, inspectionId = null, teamId = null, mode = null } = {}) {
    if (disposed) return;
    if (groupId !== null && !/^[a-f0-9]{64}$/.test(groupId)) throw new Error("历史路线组无效。");
    if (inspectionId !== null && (!groupId || !/^[a-f0-9]{64}$/.test(inspectionId))) throw new Error("历史验收投稿无效。");
    if (teamId !== null && (!groupId || inspectionId || !/^[a-f0-9]{64}$/.test(teamId))) throw new Error("队伍链接无效。");
    const identity = communityMapIdentity(nextMapPack);
    if (!identity) {
      invalidate(); invalidateSearch(); mapPack = nextMapPack || null; state = freshState(); state.status = "mismatch";
      state.message = "当前地图缺少可靠的版本或关卡分支信息，暂不叠加玩家路线。"; emit(); return;
    }
    if (identity === communityMapIdentity(mapPack) && groupId === state.pinnedGroupId && inspectionId === state.inspectionId && teamId === state.teamId) {
      mapPack = nextMapPack;
      await setStage(stageIndex);
      if (mode !== null) await setMode(mode);
      return;
    }
    invalidate(); invalidateSearch(); mapPack = nextMapPack; hidden = new Set(); state = freshState();
    state.pinnedGroupId = groupId;
    state.inspectionId = inspectionId;
    state.teamId = teamId;
    if (mode === "routes" || (!inspectionId && mode === "heatmap") || (teamId && mode === "team")) state.mode = mode;
    state.stageIndex = Number.isInteger(stageIndex) && stageIndex >= 0 ? stageIndex : null;
    await refresh();
  }
  async function selectGroup(id) {
    if (disposed || !mapPack) return;
    const group = state.groups.find(value => value.id === id);
    if (state.pinnedGroupId && id !== state.pinnedGroupId) return;
    if (!group || group === state.group) return;
    state.group = group; state.difficulties = group.difficulties;
    state.teamId = null; state.referencePlayerKey = null; if (state.mode === "team") state.mode = "routes";
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
    if (disposed || !mapPack || state.inspectionId || state.teamId) return;
    const key = value === "" || state.difficulties.some(difficulty => difficulty.key === value) ? value : "";
    if (key === state.difficulty) return;
    state.difficulty = key;
    invalidateSearch(); state.teams = []; state.teamSearchStatus = "idle"; state.teamSearchMessage = "难度已更新，可重新搜索队伍。";
    await loadStage();
  }
  async function setMode(value) {
    if (disposed || !["off", "routes", "heatmap", "team"].includes(value) || state.mode === value) return;
    if (value === "team" && (!state.teamId || state.inspectionId)) return;
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
    if (state.group && (state.heatmap !== null || state.inspectionLoaded || (state.teamLoaded && value !== "heatmap"))) { describeData(); emit(); }
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
    const route = state.routes.find(route => (route.playerKey || route.id) === id || route.id === id);
    if (disposed || !route) return;
    const key = route.playerKey || route.id;
    if (visible) hidden.delete(key); else hidden.add(key);
    emit();
  }
  function setAllPlayersVisible(visible) {
    if (disposed) return;
    for (const player of communityPlayers(state.routes)) { if (visible) hidden.delete(player.id); else hidden.add(player.id); }
    emit();
  }
  function setReferencePlayer(value) {
    if (disposed || (value !== null && !communityPlayers(state.routes).some(player => player.id === value))) return;
    state.referencePlayerKey = value; emit();
  }
  async function setCountBy(value) {
    if (disposed || state.inspectionId || !["team", "player"].includes(value) || state.countBy === value) return;
    state.countBy = value;
    if (state.mode !== "off") await loadStage(); else { state.heatmap = null; emit(); }
  }
  function invalidateSearch() { searchRequest?.abort(); searchRequest = null; searchRevision++; }
  async function searchTeams({ member = state.searchMember, allMaps = state.searchAllMaps } = {}) {
    if (disposed || !mapPack || state.inspectionId) return;
    invalidateSearch(); const current = searchRevision; searchRequest = new AbortController();
    state.searchMember = String(member || "").trim().slice(0, 80); state.searchAllMaps = Boolean(allMaps);
    const parameters = new URLSearchParams({ limit: "50" });
    if (state.searchMember) parameters.set("member", state.searchMember);
    if (!allMaps && state.group) parameters.set("group", state.group.id);
    if (!allMaps && !state.group) { state.teams = []; state.teamSearchStatus = "empty"; state.teamSearchMessage = "当前地图还没有队伍记录，可切换全部地图搜索。"; emit(); return; }
    if (state.difficulty) parameters.set("difficulty", state.difficulty);
    state.teamSearchStatus = "loading"; state.teamSearchMessage = "正在查找队伍…"; emit();
    try {
      const body = normalizeCommunityTeams(await readApi(`${teamApiBase}?${parameters}`, searchRequest.signal));
      if (disposed || current !== searchRevision || !mapPack) return;
      state.teams = body.teams; state.teamSearchStatus = body.teams.length ? "ready" : "empty";
      state.teamSearchMessage = body.teams.length ? `${body.teams.length} 支队伍${body.truncated ? " · 结果较多，请缩小名字范围" : ""}` : "没有找到相关队伍。";
      emit();
    } catch (error) {
      if (disposed || current !== searchRevision || error?.name === "AbortError") return;
      state.teams = []; state.teamSearchStatus = "error"; state.teamSearchMessage = displayError(error); emit();
    }
  }
  async function selectTeam(id) {
    if (disposed || !mapPack || state.inspectionId || (id !== null && !/^[a-f0-9]{64}$/.test(id))) return;
    const team = state.teams.find(value => value.id === id);
    if (id !== null && (!team || team.groupId !== state.group?.id)) return;
    state.teamId = id; state.referencePlayerKey = null; hidden = new Set();
    state.difficulty = "";
    state.mode = id ? "team" : state.mode === "team" ? "routes" : state.mode;
    await loadStage();
  }
  function clear() { if (disposed) return; invalidate(); invalidateSearch(); mapPack = null; state = freshState(); hidden = new Set(); emit(); }
  function dispose() { if (disposed) return; invalidate(); invalidateSearch(); mapPack = null; disposed = true; state = freshState(); hidden = new Set(); }
  return { enterMap, refresh, searchTeams, selectTeam, selectGroup, setStage, setDifficulty, setMode, setHeightBand, setPlayerVisible, setAllPlayersVisible, setReferencePlayer, setCountBy, clear, dispose, getSnapshot };
}
