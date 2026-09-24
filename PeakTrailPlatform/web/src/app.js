import {
  appendLiveRecord,
  createLiveTrace,
  FileBundle,
  finalizeLiveFlush,
  ProtocolError,
  assessCompatibility,
  eventPresentation,
  formatTime,
  isDailyMapFresh,
  loadMapPackBundle,
  loadMapPackUrl,
  loadTraceCollection,
  selectDailyMapPack,
  selectTraceMapPack,
  tracePlayerStateAtTime,
} from "./protocol.js";
import { collectDroppedFiles } from "./file-intake.js";
import { loadGameAssetPack } from "./game-assets.js";
import { createPlayerCard, updatePlayerCard } from "./player-card.js";
import { resolveReplayRoute, routeSegmentName } from "./map-route.js";
import { worldTelemetryNote } from "./world-timeline.js";
import { createTrailEstimator, liveChaseTarget, LIVE_TRAIL_S } from "./live-follow.js";
import { createWakeLock } from "./wake-lock.js";
import { HomePage } from "./home-page.js";
import { buildHomeDailyView } from "./home-daily.js";

const $ = (id) => document.getElementById(id);
const elements = {
  mapInput: $("mapInput"),
  traceInput: $("traceInput"),
  traceFolderInput: $("traceFolderInput"),
  mapSourceButton: $("mapSourceButton"),
  traceSourceButton: $("traceSourceButton"),
  mapSourceName: $("mapSourceName"),
  mapSourceMeta: $("mapSourceMeta"),
  mapSourceState: $("mapSourceState"),
  traceSourceName: $("traceSourceName"),
  traceSourceMeta: $("traceSourceMeta"),
  traceSourceState: $("traceSourceState"),
  liveUrl: $("liveUrl"),
  liveRefresh: $("liveRefresh"),
  liveRunList: $("liveRunList"),
  liveDisconnect: $("liveDisconnect"),
  liveStateRow: $("liveStateRow"),
  liveStatus: $("liveStatus"),
  wakeLockChip: $("wakeLockChip"),
  liveFollow: $("liveFollow"),
  modeReplay: $("modeReplay"),
  modeLive: $("modeLive"),
  replaySource: $("replaySource"),
  liveSource: $("liveSource"),
  modeGate: $("modeGate"),
  gateReplay: $("gateReplay"),
  gateLive: $("gateLive"),
  gateLiveHint: $("gateLiveHint"),
  gateLiveList: $("gateLiveList"),
  backToGate: $("backToGate"),
  modeChip: $("modeChip"),
  importMenu: $("importMenu"),
  gateDebug: $("gateDebug"),
  compatibilityPill: $("compatibilityPill"),
  compatibilityText: $("compatibilityText"),
  emptyState: $("emptyState"),
  dropOverlay: $("dropOverlay"),
  sceneCanvas: $("sceneCanvas"),
  sceneName: $("sceneName"),
  sampleCount: $("sampleCount"),
  altitudeRange: $("altitudeRange"),
  layerSelect: $("layerSelect"),
  segmentNavigator: $("segmentNavigator"),
  previousSegmentButton: $("previousSegmentButton"),
  nextSegmentButton: $("nextSegmentButton"),
  segmentOrdinal: $("segmentOrdinal"),
  segmentName: $("segmentName"),
  segmentOriginalName: $("segmentOriginalName"),
  routeSummary: $("routeSummary"),
  followSegmentButton: $("followSegmentButton"),
  segmentOverviewButton: $("segmentOverviewButton"),
  segmentLoadStatus: $("segmentLoadStatus"),
  heightScale: $("heightScale"),
  heightScaleValue: $("heightScaleValue"),
  trackToggle: $("trackToggle"),
  markerToggle: $("markerToggle"),
  playerCount: $("playerCount"),
  playerList: $("playerList"),
  dateSelect: $("dateSelect"),
  sessionSelect: $("sessionSelect"),
  archiveSummary: $("archiveSummary"),
  eventCount: $("eventCount"),
  eventList: $("eventList"),
  playButton: $("playButton"),
  timeline: $("timeline"),
  timelineMarkers: $("timelineMarkers"),
  currentTime: $("currentTime"),
  totalTime: $("totalTime"),
  speedSelect: $("speedSelect"),
  topViewButton: $("topViewButton"),
  fitViewButton: $("fitViewButton"),
  freeCameraButton: $("freeCameraButton"),
  cinematicButton: $("cinematicButton"),
  interiorViewButton: $("interiorViewButton"),
  cameraHelp: $("cameraHelp"),
  cameraPlacement: $("cameraPlacement"),
  followHud: $("followHud"),
  followHudText: $("followHudText"),
  worldToggle: $("worldToggle"),
  worldTelemetryNote: $("worldTelemetryNote"),
  worldSummary: $("worldSummary"),
  mapFogNote: $("mapFogNote"),
  worldAlerts: $("worldAlerts"),
  eventToast: $("eventToast"),
  eventToastIcon: $("eventToastIcon"),
  eventToastTitle: $("eventToastTitle"),
  eventToastMeta: $("eventToastMeta"),
  errorBanner: $("errorBanner"),
  errorTitle: $("errorTitle"),
  errorMessage: $("errorMessage"),
  dismissError: $("dismissError"),
  dailyScene: $("dailyScene"),
  dailyCountdown: $("dailyCountdown"),
};

const state = {
  mapPack: null,
  trace: null,
  traceCollection: null,
  replayCollection: null,
  lastReplaySessionId: null,
  traceSelectionRevision: 0,
  lastRenderSignature: null,
  compatibility: null,
  currentTime: 0,
  playing: false,
  speed: 1,
  lastPlaybackFrame: 0,
  lastTelemetryAt: 0,
  lastEventTime: -1,
  toastTimer: null,
  errorTimer: null,
  daily: null,
  dailyRequestInFlight: false,
  dailyMapStatus: null,
  dailyMapErrorKey: null,
  mapSourceKind: null,
  mapRequestRevision: 0,
  manualMapLoads: 0,
  sourceLoadingCounts: { map: 0, trace: 0 },
  expiredDailyKey: null,
  dailyExpiryTimer: null,
  dailySource: null,
  dailyBackendDownUntil: 0,
  mapCatalog: null,
  mapCatalogBaseUrl: null,
  gameAssetPack: null,
  gameAssetStatus: "idle",
  gameAssetError: null,
  segmentOptions: [],
  segmentTimeline: [],
  selectedSegment: undefined,
  segmentSelectionMode: "auto",
  segmentMapStatuses: new Map(),
  segmentMapKey: null,
  usingCompatibleMap: false,
  routeView: null,
  eventRows: new Map(),
  eventWindowFrame: 0,
  live: {
    baseUrl: null,
    code: null,
    es: null,
    trace: null,
    timer: 0,
    dirty: false,
    lastParticipants: 0,
    pollTimer: 0,
    lastSeq: 0,
    lastRefreshSamples: -1,
    lastSseAt: 0,
    reconnectAttempts: 0,
    trail: null,
    demoTimer: 0,
  },
  gateDiag: null,
};

const gameAssetLoads = new Map();
const homePage = new HomePage({ root: elements.modeGate, loadCatalog: () => ensureMapCatalog(),
  loadMapPack: loadMapPackUrl, onExplore: (map, segment, view) => {
    void openHomeChapter(map, segment, view).catch(error => {
      const detail = describeError(error); showError(detail.title, detail.message);
    });
  },
  onRefresh: () => loadDailyStatus() });

const SEGMENT_NAMES_ZH = new Map([
  ["shore", "海岸"],
  ["roots", "森蕈"],
  ["tropics", "热带雨林"],
  ["alpine", "雪山"],
  ["mesa", "台地"],
  ["volcano", "火山"],
  ["swamp", "沼泽"],
  ["void", "虚空"],
]);

function asSegment(value) {
  if (value === null || value === undefined || value === "") return null;
  const segment = Number(value);
  return Number.isInteger(segment) ? segment : null;
}

function collapseSegmentTimeline(entries) {
  const byTime = [];
  for (const entry of [...entries].sort((a, b) => a.t - b.t || a.priority - b.priority)) {
    const lastAtTime = byTime.at(-1);
    if (lastAtTime?.t === entry.t) byTime[byTime.length - 1] = entry;
    else byTime.push(entry);
  }

  const collapsed = [];
  for (const entry of byTime) {
    if (collapsed.at(-1)?.segment !== entry.segment) collapsed.push(entry);
  }
  return collapsed;
}

function buildSegmentTimeline(trace) {
  const eventEntries = (trace?.events || []).flatMap((event) => {
    if (event.type !== "segment_change") return [];
    const segment = asSegment(event.activeSegment ?? event.segment);
    return segment === null ? [] : [{ t: event.t, segment, priority: 2 }];
  });
  const sampleEntries = [];
  for (const samples of trace?.tracks?.values?.() || []) {
    for (const sample of samples) {
      const segment = asSegment(sample.activeSegment);
      if (segment !== null) sampleEntries.push({ t: sample.t, segment, priority: 1 });
    }
  }

  if (!eventEntries.length) return collapseSegmentTimeline(sampleEntries);
  const firstEventTime = Math.min(...eventEntries.map((entry) => entry.t));
  const firstSample = sampleEntries.sort((a, b) => a.t - b.t).find((entry) => entry.t <= firstEventTime);
  return collapseSegmentTimeline(firstSample ? [firstSample, ...eventEntries] : eventEntries);
}

function segmentAtTime(seconds) {
  const timeline = state.segmentTimeline;
  if (!timeline.length) return null;
  let low = 0;
  let high = timeline.length - 1;
  let answer = timeline[0].segment;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].t <= seconds) {
      answer = timeline[middle].segment;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function segmentChineseBase(option) {
  const routed = routeSegmentName(state.routeView?.route, option?.segment);
  if (routed) return routed;
  if ([3, 4].includes(option?.segment)) return option.segment === 3 ? "第四关（分支未确认）" : "终关（分支未确认）";
  const source = String(option?.biome || option?.name || "").trim();
  return SEGMENT_NAMES_ZH.get(source.toLowerCase()) || option?.name || `分区 ${option?.segment ?? "?"}`;
}

function segmentDisplayName(option) {
  if (!option) return "等待关卡";
  const base = segmentChineseBase(option);
  const matches = state.segmentOptions.filter((candidate) => segmentChineseBase(candidate) === base);
  if (matches.length < 2) return base;
  const index = matches.findIndex((candidate) => candidate.segment === option.segment);
  if (matches.length === 2) return `${base}（${index === 0 ? "下段" : "上段"}）`;
  return `${base}（第 ${index + 1} 段）`;
}

function collectSegmentOptions() {
  const bySegment = new Map();
  for (const layer of state.usingCompatibleMap ? state.mapPack?.layers || [] : []) {
    const segment = asSegment(layer.segment);
    if (segment === null) continue;
    bySegment.set(segment, {
      segment,
      name: String(layer.name || `Segment ${segment}`),
      biome: String(layer.biome || layer.name || ""),
      isVoid: String(layer.biome || layer.name || "").toLowerCase() === "void",
    });
  }
  for (const entry of state.segmentTimeline) {
    if (!bySegment.has(entry.segment)) {
      bySegment.set(entry.segment, {
        segment: entry.segment,
        name: `Segment ${entry.segment}`,
        biome: "",
        isVoid: false,
      });
    }
  }
  for (const entry of state.routeView?.route?.segments || []) {
    const option = bySegment.get(entry.index);
    bySegment.set(entry.index, {
      ...option,
      segment: entry.index, name: entry.name || entry.biome,
      biome: entry.biome, isVoid: entry.biome.toLowerCase() === "void",
    });
  }
  for (const samples of state.trace?.tracks?.values?.() || []) {
    for (const sample of samples) {
      const segment = asSegment(sample.segment);
      if (segment !== null && !bySegment.has(segment)) {
        bySegment.set(segment, {
          segment,
          name: `Segment ${segment}`,
          biome: "",
          isVoid: false,
        });
      }
    }
  }
  return [...bySegment.values()].sort((a, b) => a.segment - b.segment);
}

function defaultSegment() {
  const fromTimeline = segmentAtTime(state.currentTime);
  if (state.segmentOptions.some((option) => option.segment === fromTimeline)) return fromTimeline;
  return state.segmentOptions.find((option) => !option.isVoid)?.segment
    ?? state.segmentOptions[0]?.segment
    ?? null;
}

function segmentStatusKey(segment) {
  return segment === null ? "all" : String(segment);
}

function overviewSegmentOptions() {
  const mountain = state.segmentOptions.filter((option) => !option.isVoid && !state.routeView?.hiddenSegments.has(option.segment));
  return mountain.length ? mountain : state.segmentOptions;
}

function setSegmentLoadStatus(status, segment, message = "") {
  if (!state.usingCompatibleMap) return;
  if (segment === null) {
    for (const option of overviewSegmentOptions()) {
      state.segmentMapStatuses.set(segmentStatusKey(option.segment), { status, message });
    }
  } else {
    state.segmentMapStatuses.set(segmentStatusKey(segment), { status, message });
  }
  renderSegmentNavigation();
}

function markSegmentTransition(segment) {
  if (!state.usingCompatibleMap) return;
  if (state.mapPack?.identityVersion === 3) {
    setSegmentLoadStatus("loading", segment, "正在加载 PEAK 真实关卡网格");
  } else {
    setSegmentLoadStatus("ready", segment, "兼容高度场底图已就绪");
  }
}

function selectedSegmentStatus() {
  if (state.selectedSegment !== null && state.routeView?.hiddenSegments.has(state.selectedSegment)) {
    return { status: "muted", text: "本关底图与实际分支不符 · 仅显示足迹", message: state.routeView.message };
  }
  if (!state.usingCompatibleMap) {
    return state.mapPack
      ? { status: "muted", text: "底图版本不匹配 · 仅回放足迹", message: "" }
      : { status: "muted", text: "无同版本底图 · 仅回放足迹", message: "" };
  }

  if (state.selectedSegment !== null) {
    const value = state.segmentMapStatuses.get(segmentStatusKey(state.selectedSegment));
    if (value?.status === "loading") return { status: "loading", text: "正在加载本关底图…", message: value.message };
    if (value?.status === "ready") return { status: "ready", text: "本关底图已就绪", message: value.message };
    if (value?.status === "error") return { status: "error", text: "本关底图失败 · 足迹仍可回放", message: value.message };
    return { status: "muted", text: "底图按关加载", message: "" };
  }

  const statuses = overviewSegmentOptions().map((option) => state.segmentMapStatuses.get(segmentStatusKey(option.segment)));
  const failed = statuses.filter((value) => value?.status === "error").length;
  const loading = statuses.filter((value) => value?.status === "loading").length;
  const ready = statuses.filter((value) => value?.status === "ready").length;
  if (failed) return { status: "error", text: `${failed} 关底图失败 · 足迹仍可回放`, message: "" };
  if (loading) return { status: "loading", text: `正在加载 ${loading} 关底图…`, message: "" };
  if (ready === statuses.length && statuses.length) return { status: "ready", text: "所有关底图已就绪", message: "" };
  return { status: "muted", text: "概览会按需加载所有关", message: "" };
}

let segmentNavLastName = null;
let segmentNavFlashTimer = 0;
function renderSegmentNavigation() {
  const options = state.segmentOptions;
  const chapters = options.filter((option) => !option.isVoid);
  elements.segmentNavigator.hidden = options.length === 0;
  if (!options.length) return;

  const activeIndex = chapters.findIndex((option) => option.segment === state.selectedSegment);
  const active = options.find((option) => option.segment === state.selectedSegment);
  const isOverview = state.selectedSegment === null;
  elements.routeSummary.textContent = state.routeView?.message || "关卡分支未确认";
  elements.segmentOrdinal.textContent = isOverview
    ? `共 ${chapters.length} 关`
    : active?.isVoid ? "额外区域 · 非登山终关" : `第 ${activeIndex + 1} / ${chapters.length} 关`;
  elements.segmentName.textContent = isOverview ? "所有关概览" : segmentDisplayName(active);
  elements.segmentOriginalName.textContent = isOverview
    ? "仅在手动选择时加载"
    : `${active?.name || "未知"} · Segment ${active?.segment ?? "?"}`;

  // 收起状态下换关：短暂展开提示 2.6s 再收起（用户手动展开过则保持）。
  const navName = `${elements.segmentOrdinal.textContent}|${elements.segmentName.textContent}`;
  if (segmentNavLastName !== null && segmentNavLastName !== navName
    && elements.segmentNavigator.classList.contains("is-collapsed")
    ) {
    elements.segmentNavigator.classList.remove("is-collapsed");
    clearTimeout(segmentNavFlashTimer);
    segmentNavFlashTimer = setTimeout(() => {
      elements.segmentNavigator.classList.add("is-collapsed");
    }, 2600);
  }
  segmentNavLastName = navName;

  elements.previousSegmentButton.disabled = !options.length || (activeIndex === 0 && !isOverview);
  elements.nextSegmentButton.disabled = !chapters.length || active?.isVoid || activeIndex === chapters.length - 1;
  elements.followSegmentButton.classList.toggle("is-active", state.segmentSelectionMode === "auto");
  elements.followSegmentButton.setAttribute("aria-pressed", String(state.segmentSelectionMode === "auto"));
  elements.segmentOverviewButton.classList.toggle("is-active", isOverview);
  elements.segmentOverviewButton.setAttribute("aria-pressed", String(isOverview));

  const status = selectedSegmentStatus();
  elements.segmentLoadStatus.className = `segment-load-status is-${status.status}`;
  elements.segmentLoadStatus.textContent = status.text;
  elements.segmentLoadStatus.title = status.message || status.text;

  const desiredSelectValue = isOverview ? "all" : String(state.selectedSegment);
  if (elements.layerSelect.value !== desiredSelectValue) elements.layerSelect.value = desiredSelectValue;
}

function populateSegmentControls() {
  state.segmentOptions = collectSegmentOptions();
  const nextMapKey = String(state.mapPack?.mapPackId || "no-map");
  if (state.segmentMapKey !== nextMapKey) {
    state.segmentMapKey = nextMapKey;
    state.segmentMapStatuses.clear();
  }

  const validSelection = state.selectedSegment === null
    || state.segmentOptions.some((option) => option.segment === state.selectedSegment);
  if (state.segmentSelectionMode === "auto" || state.selectedSegment === undefined || !validSelection) {
    state.segmentSelectionMode = "auto";
    state.selectedSegment = defaultSegment();
  }

  elements.layerSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "所有关概览（手动）";
  elements.layerSelect.append(allOption);
  state.segmentOptions.forEach((option, index) => {
    const selectOption = document.createElement("option");
    selectOption.value = String(option.segment);
    selectOption.textContent = `${option.isVoid ? "额外区域" : `第 ${index + 1} 关`} · ${segmentDisplayName(option)} / ${option.name}`;
    elements.layerSelect.append(selectOption);
  });
  elements.layerSelect.disabled = state.segmentOptions.length === 0;
  renderSegmentNavigation();
  return state.selectedSegment;
}

function chooseSegment(segment, mode = "manual") {
  const normalized = segment === null ? null : asSegment(segment);
  if (normalized !== null && !state.segmentOptions.some((option) => option.segment === normalized)) return;
  const changed = normalized !== state.selectedSegment;
  state.segmentSelectionMode = mode;
  state.selectedSegment = normalized;
  renderSegmentNavigation();
  updateSceneMeta();
  if (changed && viewer) {
    markSegmentTransition(normalized);
    viewer.setActiveSegment(normalized);
    updateWorldTelemetry();
  }
}

function syncSegmentToPlayback() {
  if (state.segmentSelectionMode !== "auto" || !state.segmentOptions.length) return;
  const segment = defaultSegment();
  if (segment !== state.selectedSegment) chooseSegment(segment, "auto");
}

function resetSegmentNavigation(trace) {
  state.segmentTimeline = buildSegmentTimeline(trace);
  state.segmentSelectionMode = "auto";
  state.selectedSegment = undefined;
  state.segmentMapStatuses.clear();
}

function cachedGameAssetPack(gameBuildId) {
  const key = String(gameBuildId || "").trim();
  if (!key) return Promise.resolve(null);
  if (!gameAssetLoads.has(key)) {
    gameAssetLoads.set(key, loadGameAssetPack(key).catch((error) => {
      gameAssetLoads.delete(key);
      throw error;
    }));
  }
  return gameAssetLoads.get(key);
}

function syncGameAssetsForTrace(trace, selectionRevision) {
  const buildId = String(trace?.manifest?.gameBuildId || "").trim();
  state.gameAssetPack = null;
  viewer?.setGameAssetPack(null);
  state.gameAssetError = null;
  state.gameAssetStatus = buildId ? "loading" : "missing";
  if (!buildId) return;
  void cachedGameAssetPack(buildId).then((pack) => {
    if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
    state.gameAssetPack = pack;
    viewer?.setGameAssetPack(pack);
    state.gameAssetStatus = pack ? "ready" : "missing";
    updatePlayerTelemetry();
  }).catch((error) => {
    if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
    state.gameAssetPack = null;
    state.gameAssetStatus = "error";
    state.gameAssetError = error;
    updatePlayerTelemetry();
  });
}

let viewer;
async function initializeViewer() {
  try {
    // File selection and replay controls must work even when the 3D dependency is slow
    // or unavailable. Load it after the local import handlers have been installed.
    const { TrailScene } = await import("./scene.js");
    viewer = new TrailScene($("sceneCanvas"));
    window.viewer = viewer; // debug/QA hook: camera scripts and console tooling
    window.__ptState = state; // debug/QA hook: playback/live diagnostics
    await renderData();
  } catch (error) {
    showError("2.5D 视图未能启动", `足迹仍可导入并查看事件、物品和体力。请检查网络与浏览器的 WebGL 支持后刷新。${error.message}`, 0);
  }
}

function describeError(error) {
  if (error instanceof ProtocolError) {
    return { title: error.message, message: error.detail || "请检查所选文件。" };
  }
  return { title: "无法读取文件", message: error?.message || String(error) };
}

function showError(title, message, timeout = 9000) {
  clearTimeout(state.errorTimer);
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  elements.errorBanner.classList.add("is-visible");
  if (timeout) {
    state.errorTimer = setTimeout(() => elements.errorBanner.classList.remove("is-visible"), timeout);
  }
}

function hideError() {
  clearTimeout(state.errorTimer);
  elements.errorBanner.classList.remove("is-visible");
}

function setSourceLoading(kind, loading) {
  state.sourceLoadingCounts[kind] = Math.max(
    0,
    state.sourceLoadingCounts[kind] + (loading ? 1 : -1),
  );
  const isLoading = state.sourceLoadingCounts[kind] > 0;
  const button = kind === "map" ? elements.mapSourceButton : elements.traceSourceButton;
  const stateLabel = kind === "map" ? elements.mapSourceState : elements.traceSourceState;
  button.disabled = isLoading;
  stateLabel.textContent = isLoading
    ? "读取中"
    : button.classList.contains("is-loaded")
      ? kind === "map" && ["daily", "archive"].includes(state.mapSourceKind) ? "内嵌" : "已载入"
      : "选择";
}

async function importMap(files) {
  const requestRevision = ++state.mapRequestRevision;
  state.manualMapLoads += 1;
  setSourceLoading("map", true);
  try {
    const nextMap = await loadMapPackBundle(files);
    if (requestRevision !== state.mapRequestRevision) {
      nextMap.disposeAssets?.();
      return;
    }
    const previous = state.mapPack;
    state.mapPack = nextMap;
    state.mapSourceKind = "manual";
    state.dailyMapStatus = null;
    state.compatibility = assessCompatibility(state.trace?.manifest, state.mapPack);
    await renderData();
    previous?.disposeAssets?.();
    updateMapUI();
    updateCompatibilityUI(true);
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  } finally {
    state.manualMapLoads = Math.max(0, state.manualMapLoads - 1);
    setSourceLoading("map", false);
    elements.mapInput.value = "";
  }
}

async function importTrace(files) {
  if (!files || (files instanceof FileBundle ? !files.files.length : !files.length)) {
    showError("所选目录没有可读取的文件", "请选择 PeakTrailRecordings 总目录，或直接导入其中的 PeakTrailHistory.ndjson。");
    return;
  }
  setSourceLoading("trace", true);
  try {
    const collection = await loadTraceCollection(files);
    disconnectLive(true);
    elements.liveStateRow.hidden = true;
    setSourceMode("replay");
    state.traceCollection = collection;
    state.replayCollection = collection;
    populateTraceArchive();
    const firstSession = collection.days[0]?.sessions[0] || collection.sessions[0];
    await selectTraceSession(firstSession?.manifest.sessionId, false);
    dismissGate();
    if (collection.warnings.length) {
      showError("足迹已载入，请注意数据说明", collection.warnings.join("；"), 9000);
    }
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  } finally {
    setSourceLoading("trace", false);
    elements.traceInput.value = "";
    elements.traceFolderInput.value = "";
  }
}

function setLiveStatus(text) {
  elements.liveStatus.textContent = text;
}

function defaultRelayUrl() {
  // The relay conventionally lives on :8787 of the same host serving this page,
  // so a tablet on the LAN never has to type an address.
  if (!location.hostname) return "";
  return `${location.protocol}//${location.hostname}:8787`;
}

function setSourceMode(mode) {
  const live = mode === "live";
  elements.modeReplay.classList.toggle("is-active", !live);
  elements.modeLive.classList.toggle("is-active", live);
  elements.modeReplay.setAttribute("aria-selected", String(!live));
  elements.modeLive.setAttribute("aria-selected", String(live));
  elements.replaySource.hidden = live;
  elements.liveSource.hidden = !live;
  elements.modeChip.textContent = live ? "直播" : "回放";
  if (live) {
    if (!elements.liveUrl.value) elements.liveUrl.value = defaultRelayUrl();
    void refreshLiveRuns();
    if (!state.live.pollTimer) state.live.pollTimer = setInterval(() => void refreshLiveRuns(), 5000);
  } else if (state.live.pollTimer) {
    clearInterval(state.live.pollTimer);
    state.live.pollTimer = 0;
  }
}

// ============ 每日路线首页与足迹入口 ============
function gateOpen() {
  return !elements.modeGate.hidden;
}

function showGate() {
  elements.modeGate.hidden = false;
  document.body.classList.add("gate-open");
  document.querySelector('.app-shell').inert = true;
  homePage.setVisible(true);
  void refreshGateRuns();
}

function dismissGate() {
  elements.modeGate.hidden = true;
  document.body.classList.remove("gate-open");
  document.querySelector('.app-shell').inert = false;
  homePage.setVisible(false);
}

let gateRuns = [];
async function refreshGateRuns() {
  const base = elements.liveUrl.value.trim().replace(/\/+$/, "") || defaultRelayUrl();
  if (base) state.live.baseUrl = base;
  try {
    const response = await fetch(`${base}/api/runs`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    gateRuns = (await response.json()).runs || [];
    state.gateDiag = { base, ok: true, error: null, at: Date.now() };
  } catch (error) {
    gateRuns = [];
    state.gateDiag = { base, ok: false, error: String(error?.message || error), at: Date.now() };
  }
  renderGateRuns();
}

function buildGateDiagPanel() {
  const diag = state.gateDiag || {};
  const box = document.createElement("div");
  box.className = "gate-diag";
  const url = document.createElement("p");
  url.textContent = `中继地址：${diag.base || "(未设置)"}`;
  const status = document.createElement("p");
  status.className = diag.ok === false ? "is-error" : "is-ok";
  status.textContent = diag.ok === false
    ? `连接失败：${diag.error || "未知错误"}`
    : `连接正常${diag.at ? ` · ${new Date(diag.at).toLocaleTimeString()} 检测` : ""}`;
  const tip = document.createElement("p");
  tip.className = "gate-diag-tip";
  tip.textContent = "列表为空 = 当前没有对局在推流。进游戏并保持 PEAK Trail 的 Live 开启，约 1 秒内直播卡会自动点亮。";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "gate-live-row";
  retry.textContent = "重新检测";
  retry.addEventListener("click", (event) => {
    event.stopPropagation();
    void refreshGateRuns();
  });
  box.append(url, status, tip, retry);
  return box;
}

function renderGateRuns() {
  const live = state.live;
  const card = elements.gateLive;
  card.classList.toggle("has-runs", gateRuns.length > 0);
  card.classList.toggle("is-empty", gateRuns.length === 0);
  $("homeLiveCount").textContent = gateRuns.length ? `${gateRuns.length} 场` : "";
  if (live.code) {
    const connected = gateRuns.find((run) => run.code === live.code);
    elements.gateLiveHint.textContent = `正在观看 ${live.code}${connected?.sceneName ? " · " + connected.sceneName : ""} — 点击返回`;
  } else if (!gateRuns.length) {
    // 压暗 ≠ 黑箱：一行摘要 + 点击卡片展开诊断（中继可达性/错误/最后检测时间）。
    const diag = state.gateDiag;
    const ago = diag?.at ? Math.max(0, Math.round((Date.now() - diag.at) / 1000)) : null;
    elements.gateLiveHint.textContent = diag?.ok === false
      ? "中继不可达 · 点击查看详情"
      : `暂无直播中的对局${ago !== null ? ` · 中继已连接（${ago}s 前检测）` : ""}`;
  } else if (gateRuns.length === 1) {
    elements.gateLiveHint.textContent = `${gateRuns[0].code} · ${gateRuns[0].sceneName ?? "未知场景"} · 点击进入`;
  } else {
    elements.gateLiveHint.textContent = `${gateRuns.length} 场对局直播中 · 点击选择`;
  }
  const showDiag = gateRuns.length === 0 && card.classList.contains("gate-diag-open");
  const showList = gateRuns.length > 1 || Boolean(live.code);
  const open = card.classList.contains("gate-diag-open");
  $("homeLivePopover").hidden = !open;
  card.setAttribute("aria-expanded", String(open));
  elements.gateLiveList.hidden = !(showDiag || showList);
  elements.gateLiveList.replaceChildren();
  if (showDiag) {
    elements.gateLiveList.append(buildGateDiagPanel());
    return;
  }
  if (!showList) return;
  for (const run of gateRuns) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `gate-live-row${run.code === live.code ? " is-connected" : ""}`;
    const name = document.createElement("span");
    name.textContent = `${run.code} · ${run.sceneName ?? "?"}`;
    const meta = document.createElement("small");
    meta.textContent = [
      run.participants ? `${run.participants} 人` : null,
      run.code === live.code ? "观看中" : "直播中",
    ].filter(Boolean).join(" · ");
    row.append(name, meta);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      enterLive(run.code);
    });
    elements.gateLiveList.append(row);
  }
}

// ============ 屏幕常亮：直播会话或回放播放期间防止熄屏 ============
const wakeLock = createWakeLock({ onChange: syncWakeLockChip });
document.addEventListener("visibilitychange", () => wakeLock.handleVisibilityChange());

/** 直播会话存在（SSE 或演示定时器）或回放播放中 → 请求屏幕常亮；暂停/断开即允许熄屏。 */
function syncWakeLock() {
  wakeLock.setDesired(Boolean(state.live?.es || state.live?.demoTimer || state.playing));
  syncWakeLockChip();
}

function syncWakeLockChip() {
  const chip = elements.wakeLockChip;
  if (!chip) return;
  const liveActive = Boolean(state.live?.es || state.live?.demoTimer);
  if (wakeLock.held) {
    chip.textContent = "常亮";
    chip.hidden = false;
    chip.classList.remove("is-unavailable");
  } else if (liveActive && !wakeLock.supported()) {
    // 局域网 HTTP 或老浏览器拿不到 Wake Lock API：明说，而不是默默失效。
    chip.textContent = window.isSecureContext ? "当前浏览器不支持防熄屏" : "需 HTTPS 才能防熄屏";
    chip.hidden = false;
    chip.classList.add("is-unavailable");
  } else {
    chip.hidden = true;
  }
}

function enterLive(code) {
  const base = state.live.baseUrl || defaultRelayUrl();
  dismissGate();
  setSourceMode("live");
  void connectLiveRun(base, code);
}

async function enterModeFromGate(mode) {
  dismissGate();
  if (mode === "replay" && (state.live.code || state.live.es || state.live.demoTimer)) {
    disconnectLive(true);
    elements.liveStateRow.hidden = true;
    state.trace = null;
    state.traceCollection = state.replayCollection;
  }
  setSourceMode(mode);
  if (mode !== "replay" || state.trace) return;
  try {
    if (state.replayCollection?.sessions.length) {
      state.traceCollection = state.replayCollection;
      populateTraceArchive();
      const id = state.lastReplaySessionId || state.traceCollection.sessions[0].manifest.sessionId;
      await selectTraceSession(id, false);
    } else if (isDailyMapFresh(state.daily)) await syncDailyMap(state.daily);
  } catch (error) { const detail = describeError(error); showError(detail.title, detail.message); }
}

async function openHomeChapter(map, segment, presentedView) {
  // File import owns navigation until parsing completes. Do not race a directory import.
  if (state.sourceLoadingCounts.trace || state.manualMapLoads) {
    $("homeEvidence").textContent = "正在读取文件，请完成后再打开首页关卡。";
    return;
  }
  const current = buildHomeDailyView({ daily: state.daily, catalog: state.mapCatalog, mapPack: map });
  if (!current.cards[segment]?.available || current.mapEntry?.mapPackId !== presentedView.mapEntry?.mapPackId) return;
  const revision = ++state.traceSelectionRevision;
  ++state.mapRequestRevision;
  if (state.trace && state.traceCollection === state.replayCollection) state.lastReplaySessionId = state.trace.manifest.sessionId;
  disconnectLive(true);
  elements.liveStateRow.hidden = true;
  setSourceMode("replay");
  setPlaying(false);
  clearTimeout(state.toastTimer);
  elements.eventToast.classList.remove("is-visible");
  state.trace = null;
  state.traceCollection = state.replayCollection;
  state.currentTime = 0;
  state.lastEventTime = -1;
  const previous = state.mapPack;
  state.mapPack = map;
  // Historical observations may be explored, but must never become today's map.
  state.mapSourceKind = current.isCurrent ? "daily" : "archive";
  state.dailyMapStatus = null;
  resetSegmentNavigation(null);
  state.selectedSegment = segment;
  state.segmentSelectionMode = "manual";
  state.compatibility = assessCompatibility(null, map);
  syncGameAssetsForTrace(null, revision);
  // Clear old-session labels before async geometry loading reveals the viewer.
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
  dismissGate();
  await renderData();
  if (revision !== state.traceSelectionRevision) return;
  if (previous !== map) previous?.disposeAssets?.();
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
}

// ============ 调试模式：客户端自产演示数据，进入完整直播界面 ============
const DEMO_PLAYERS = [
  { id: "demo-climber", nickname: "登山者", platform: "Windows" },
  { id: "demo-peak", nickname: "小峰", platform: "Windows" },
  { id: "demo-scout", nickname: "侦察兵", platform: "Windows" },
];
const DEMO_ITEMS = [
  { id: "27", name: "Energy Drink" },
  { id: "77", name: "Scoutmaster's Bugle" },
  { id: "12", name: "Cure-all" },
  { id: "43", name: "Rope" },
];

function demoTerrainY(playerIndex, x, z, fallback) {
  // 演示玩家要贴着地形走，否则跟随相机的遮挡拉近会把镜头怼进玩家脸里。
  const height = viewer?.sampleTerrainHeight?.(x, z);
  return Number.isFinite(height) ? height + 0.9 : fallback;
}

function demoPosition(playerIndex, tMs) {
  const base = [
    [-36, 197.5, -3],
    [-29, 198, 3],
    [-48, 199.5, -12],
  ][playerIndex];
  const wobble = [3000, 3500, 6000][playerIndex];
  const drift = [0.5, 0.4, 0.9][playerIndex];
  // 单向行进 + 轻微摆动：模拟真实登山（往复路径会让相机被玩家穿过）。
  const x = base[0] + Math.sin(tMs / wobble) * 4 + (tMs / 1000) * drift;
  const z = base[2] + Math.cos(tMs / (wobble * 1.6)) * 3 + (tMs / 1000) * drift * 1.4;
  return [x, demoTerrainY(playerIndex, x, z, base[1]), z];
}

function demoEmit(trace, tMs) {
  for (const [index, player] of DEMO_PLAYERS.entries()) {
    appendLiveRecord(trace, {
      type: "sample",
      t: tMs,
      playerId: player.id,
      pos: demoPosition(index, tMs),
      yaw: (tMs / 30) % 360,
      stamina01: 0.55 + Math.sin(tMs / 9000 + index) * 0.4,
      stamina: 0.55 + Math.sin(tMs / 9000 + index) * 0.4,
      capacityReady: true,
      activeSegment: 0,
    });
    // 第一位玩家每 8 秒换一次手持，给"手持物品"widget 活数据。
    if (index === 0 && (tMs / 200) % 40 === 0) {
      const item = DEMO_ITEMS[(tMs / 8000) % DEMO_ITEMS.length | 0];
      appendLiveRecord(trace, {
        type: "inventory",
        t: tMs,
        playerId: player.id,
        inventoryReady: true,
        authority: "demo",
        selectedSlotKnown: true,
        selectedSlot: 0,
        heldPresent: true,
        held: item,
        backpackContentsPresent: true,
        backpackContentsReady: true,
        slots: [{ location: "inventory", container: "Inventory", index: 0, slotId: "0", item }],
        activeSegment: 0,
        source: "demo",
      });
    }
  }
}

function startDemoLive() {
  disconnectLive(true);
  const manifest = {
    schemaVersion: 1,
    sessionId: "demo-session",
    runId: "demo-run",
    startedAtUtc: new Date(Date.now() - 40_000).toISOString(),
    status: "recording",
    gameVersion: "2.4.c",
    gameBuildId: 25306743,
    recorderVersion: "demo",
    sceneName: "Level_20",
    coordinateSpace: "unity-world-meters",
    positionAuthority: "xyz",
    levelIndex: 461,
    mapSlot: 20,
    projectionVersion: 1,
    sampleHz: 5,
    coordinateSpace: "unity-world-meters",
    positionAuthority: "xyz",
    timeUnit: "milliseconds",
    identityMode: "platform-user-id",
    participants: DEMO_PLAYERS.map((player, index) => ({
      playerId: player.id,
      nickname: player.nickname,
      platform: player.platform,
      actorNumber: index + 1,
      firstSeenAtMs: 0,
    })),
  };
  const trace = createLiveTrace(manifest, { code: "demo", runId: "demo-run" });
  // 演示聚焦在人物与 widget：默认关闭世界/雾层（海岸出生点在雾体积里，会糊满画面）。
  elements.worldToggle.checked = false;
  state.live.code = "demo";
  state.live.trace = trace;
  state.live.es = null;
  state.live.lastSeq = 0;
  state.live.lastParticipants = 0;
  state.live.lastRefreshSamples = -1;
  state.traceCollection = {
    sessions: [trace],
    days: [{ date: "直播", sessions: [trace] }],
    warnings: trace.warnings,
  };
  // 预铺 40 秒历史：一进门就有轨迹可看，不用干等。
  for (let t = 0; t <= 40_000; t += 200) demoEmit(trace, t);
  setLiveStatus("调试模式 · 演示数据（未连接中继）");
  elements.liveStateRow.hidden = false;
  void refreshLiveRuns();
  void attachLiveTrace(trace);
  if (!state.live.timer) state.live.timer = setInterval(() => { liveWatchdog(); liveFlush(); }, 1000);
  state.live.demoTimer = setInterval(() => {
    const trace2 = state.live.trace;
    if (trace2) {
      demoEmit(trace2, Math.round(trace2.duration * 1000) + 200);
      state.live.dirty = true;
    }
  }, 250);
  syncWakeLock();
}

async function refreshLiveRuns() {
  const base = elements.liveUrl.value.trim().replace(/\/+$/, "");
  if (!base) return;
  state.live.baseUrl = base;
  try {
    const response = await fetch(`${base}/api/runs`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderLiveRuns(base, data.runs || []);
  } catch (error) {
    if (!state.live.code) {
      elements.liveRunList.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "live-run-empty";
      empty.textContent = `中继不可达（${String(error?.message || error)}）`;
      elements.liveRunList.append(empty);
    }
  }
}

function renderLiveRuns(base, runs) {
  elements.liveRunList.replaceChildren();
  if (!runs.length) {
    const empty = document.createElement("p");
    empty.className = "live-run-empty";
    empty.textContent = "暂无活跃对局 · 游戏内开启 Live 后自动出现";
    elements.liveRunList.append(empty);
    return;
  }
  for (const run of runs) {
    const connected = run.code === state.live.code;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `live-run-card${connected ? " is-connected" : ""}`;
    const title = document.createElement("strong");
    title.textContent = `${run.code} · ${run.sceneName ?? "未知场景"}`;
    const meta = document.createElement("small");
    meta.textContent = [
      `${run.producers} 源 · ${run.records} 条`,
      run.participants ? `${run.participants} 人` : null,
      connected ? "正在观看" : run.alive === false ? "宽限中" : "直播中",
    ].filter(Boolean).join(" · ");
    card.append(title, meta);
    card.addEventListener("click", () => {
      if (!connected) void connectLiveRun(base, run.code);
    });
    elements.liveRunList.append(card);
  }
}

async function connectLiveRun(base, code) {
  disconnectLive(true);
  state.live.baseUrl = base;
  state.live.code = code;
  state.live.trace = null;
  state.live.lastParticipants = 0;
  setLiveStatus(`连接 run ${code}…`);
  elements.liveStateRow.hidden = false;
  state.live.lastSeq = 0;
  state.live.lastRefreshSamples = -1;
  state.live.trail = createTrailEstimator();
  openLiveStream(base, code);
}

/** Opens the SSE stream for the current run. Reconnections (browser retry or
 * the stall watchdog) call this without resetting the trace: the relay replays
 * only the records after our Last-Event-ID cursor. */
function openLiveStream(base, code) {
  const es = new EventSource(`${base}/api/runs/${code}/stream`);
  state.live.es = es;
  syncWakeLock();
  state.live.lastSseAt = Date.now();
  // Reconnections resume from Last-Event-ID (the relay replays only the missed
  // records), so the growing trace is kept as-is and appends simply continue.
  es.onopen = () => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
    if (state.live.trace) setLiveStatus(`直播中 · ${code}（已续传）`);
  };
  es.addEventListener("ping", () => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
  });
  es.addEventListener("hello", (event) => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
    const hello = JSON.parse(event.data);
    // A hello on an established trace means the relay lost its buffer (restart):
    // our sequence is ahead of its, so rebuild from the fresh snapshot.
    if (state.live.trace && hello.lastSeq >= state.live.lastSeq) {
      setLiveStatus(`直播中 · ${code}（已续传）`);
      return;
    }
    const trace = createLiveTrace(hello.manifest, { code, runId: hello.runId });
    state.live.trace = trace;
    state.live.lastSeq = 0;
    state.traceCollection = {
      sessions: [trace],
      days: [{ date: "直播", sessions: [trace] }],
      warnings: trace.warnings,
    };
    setLiveStatus(`直播中 · ${code}`);
    void refreshLiveRuns();
    void attachLiveTrace(trace);
  });
  es.addEventListener("record", (event) => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
    const entry = JSON.parse(event.data);
    const trace = state.live.trace;
    if (trace && appendLiveRecord(trace, entry.record)) {
      state.live.lastSeq = Math.max(state.live.lastSeq, entry.seq);
      state.live.dirty = true;
      // The adaptive trail sizes itself to the observed sample cadence.
      if (entry.record.type === "sample") state.live.trail?.observe(performance.now());
    }
  });
  es.onerror = () => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
    if (es.readyState === EventSource.CLOSED) {
      // Fatal (relay unreachable or run gone): the browser will not retry.
      state.live.reconnectAttempts += 1;
      if (state.live.reconnectAttempts > 3) {
        setLiveStatus("直播已结束或中继不可达");
        disconnectLive(false);
        return;
      }
      setLiveStatus(`连接中断，重连中…（${state.live.reconnectAttempts}）`);
      const live = state.live;
      setTimeout(() => {
        if (state.live.es === es && live.code) openLiveStream(live.baseUrl, live.code);
      }, 2000);
    } else {
      setLiveStatus("连接中断，自动重连…");
    }
  };
  if (!state.live.timer) state.live.timer = setInterval(() => { liveWatchdog(); liveFlush(); }, 1000);
}

const LIVE_STALL_RECONNECT_MS = 20_000;
/** EventSource never times out an idle stream: a silently-dead socket (tablet
 * Wi-Fi power save is the classic case) stays "OPEN" forever with no error and
 * no retry, freezing the page on a stale timeline. The relay's ping events make
 * liveness observable; silence past this window forces a resume-reconnect. */
function liveWatchdog() {
  const live = state.live;
  if (!live.es || !live.code) return;
  if (Date.now() - live.lastSseAt <= LIVE_STALL_RECONNECT_MS) {
    live.reconnectAttempts = 0;
    return;
  }
  if (live.es.readyState === EventSource.CLOSED) return; // fatal path handled by onerror
  live.reconnectAttempts += 1;
  if (live.reconnectAttempts > 3) {
    setLiveStatus("直播已结束或中继不可达");
    disconnectLive(false);
    return;
  }
  setLiveStatus(`连接中断，重连中…（${live.reconnectAttempts}）`);
  live.es.close();
  openLiveStream(live.baseUrl, live.code);
}

async function attachLiveTrace(trace) {
  const selectionRevision = ++state.traceSelectionRevision;
  state.trace = trace;
  resetSegmentNavigation(trace);
  syncGameAssetsForTrace(trace, selectionRevision);
  // Start just behind the live edge so the follow chase interpolates smoothly
  // instead of pinning to the newest sample.
  state.currentTime = Math.max(0, trace.duration - LIVE_TRAIL_S);
  state.lastEventTime = -1;
  setPlaying(false);
  try {
    await syncMapForTrace(trace);
  } catch (error) {
    if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
    await clearAutomaticMap();
  }
  if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
  state.compatibility = assessCompatibility(trace.manifest, state.mapPack);
  await renderData();
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
}

function liveFlush() {
  const live = state.live;
  const trace = live.trace;
  if (!trace || !live.dirty) return;
  live.dirty = false;
  finalizeLiveFlush(trace);
  if (trace.participants.length !== live.lastParticipants) {
    live.lastParticipants = trace.participants.length;
    updatePlayers();
  }
  if (state.trace !== trace) return;
  elements.timeline.max = String(trace.duration);
  elements.totalTime.textContent = formatTime(trace.duration);
  elements.sampleCount.textContent = trace.sampleCount.toLocaleString("zh-CN");
  elements.eventCount.textContent = String(trace.events.length);
  // Trail geometry only changes when samples arrive; status/state records must
  // not trigger a full rebuild every second as the session grows.
  if (trace.sampleCount !== state.live.lastRefreshSamples) {
    state.live.lastRefreshSamples = trace.sampleCount;
    viewer?.refreshTracks();
  }
  // The playhead itself is advanced every frame by the playback loop's chase
  // (see isLiveFollowing) — a once-per-second jump here made markers teleport
  // and delayed held-item/status display by up to a full tick.
  // While following is off, nudge the user toward the live edge instead of
  // leaving what looks like a frozen stream.
  elements.liveFollow.closest("label")?.classList.toggle(
    "is-behind",
    Boolean(state.live.es) && !isLiveFollowing() && trace.duration - state.currentTime > 10,
  );
}

function disconnectLive(silent = false) {
  const live = state.live;
  if (live.es) {
    live.es.close();
    live.es = null;
  }
  if (live.timer) {
    clearInterval(live.timer);
    live.timer = 0;
  }
  if (live.demoTimer) {
    clearInterval(live.demoTimer);
    live.demoTimer = 0;
  }
  live.code = null;
  live.trace = null;
  live.dirty = false;
  live.lastSeq = 0;
  live.reconnectAttempts = 0;
  syncWakeLock();
  if (!silent) {
    elements.liveStateRow.hidden = true;
    setLiveStatus("已断开");
    void refreshLiveRuns();
  }
}

function formatSessionLabel(trace) {
  const started = new Date(trace.manifest.startedAtUtc);
  const time = Number.isFinite(started.getTime())
    ? started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "时间未知";
  const players = trace.participants.filter((participant) => trace.tracks.has(participant.id)).length;
  const isPartial = trace.manifest.status === "recording"
    || String(trace.manifestFileName || "").toLowerCase().includes("partial");
  const lifecycle = isPartial
    ? "未完整结束"
    : trace.manifest.endReason
      ? `结束 ${trace.manifest.endReason}`
      : trace.manifest.status && trace.manifest.status !== "complete"
        ? trace.manifest.status
        : null;
  return [
    time,
    trace.manifest.sceneName,
    `${players} 人`,
    formatTime(trace.duration),
    lifecycle,
  ].filter(Boolean).join(" · ");
}

function populateTraceArchive(preferredDate = null) {
  const collection = state.traceCollection;
  const previousDate = preferredDate || elements.dateSelect.value;
  elements.dateSelect.replaceChildren();
  for (const day of collection?.days || []) {
    const option = document.createElement("option");
    option.value = day.date;
    option.textContent = `${day.date} · ${day.sessions.length} 局`;
    elements.dateSelect.append(option);
  }
  elements.dateSelect.disabled = !collection?.days.length;
  const hasPrevious = collection?.days.some((day) => day.date === previousDate);
  elements.dateSelect.value = hasPrevious ? previousDate : collection?.days[0]?.date || "";
  populateSessionSelect();
  const sessionCount = collection?.sessions.length || 0;
  const dayCount = collection?.days.length || 0;
  elements.archiveSummary.textContent = sessionCount
    ? `${dayCount} 天 · ${sessionCount} 局 · 本地解析`
    : "等待导入足迹目录";
}

function populateSessionSelect(preferredSessionId = null) {
  const day = state.traceCollection?.days.find((entry) => entry.date === elements.dateSelect.value);
  elements.sessionSelect.replaceChildren();
  for (const trace of day?.sessions || []) {
    const option = document.createElement("option");
    option.value = trace.manifest.sessionId;
    option.textContent = formatSessionLabel(trace);
    elements.sessionSelect.append(option);
  }
  elements.sessionSelect.disabled = !day?.sessions.length;
  const hasPreferred = day?.sessions.some((trace) => trace.manifest.sessionId === preferredSessionId);
  elements.sessionSelect.value = hasPreferred
    ? preferredSessionId
    : day?.sessions[0]?.manifest.sessionId || "";
}

async function selectTraceSession(sessionId, showMismatch = true) {
  const trace = state.traceCollection?.sessions.find(
    (candidate) => candidate.manifest.sessionId === sessionId,
  );
  if (!trace) return;
  if (state.traceCollection === state.replayCollection) state.lastReplaySessionId = trace.manifest.sessionId;
  const selectionRevision = ++state.traceSelectionRevision;
  state.trace = trace;
  resetSegmentNavigation(trace);
  syncGameAssetsForTrace(trace, selectionRevision);
  state.currentTime = 0;
  state.lastEventTime = -1;
  clearTimeout(state.toastTimer);
  elements.eventToast.classList.remove("is-visible");
  setPlaying(false);
  try {
    await syncMapForTrace(trace);
  } catch (error) {
    if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
    await clearAutomaticMap();
    const detail = describeError(error);
    state.dailyMapStatus = {
      title: `${trace.manifest.sceneName} 内嵌地图未载入`,
      detail: detail.message,
    };
    showError(detail.title, `${detail.message}。该局仍可在无底图模式回放。`, 9000);
  }
  if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
  state.compatibility = assessCompatibility(trace.manifest, state.mapPack);
  await renderData();
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(showMismatch);
}

async function importMixed(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const names = list.map((file) => file.name.toLowerCase());
  const hasStream = names.some((name) => name.includes("stream") && (name.includes("ndjson") || name.endsWith("partial")));
  const hasJournal = names.some(
    (name) => /^peaktrailhistory(?:\.partial)?\.ndjson(?:\.partial)?$/.test(name),
  );
  const hasNdjson = names.some((name) => /\.ndjson(?:\.partial)?$/.test(name));
  const hasMapAssets = names.some((name) => name.endsWith(".f32") || name.endsWith(".raw") || name.endsWith(".png"));
  const likelyMapJson = names.some((name) => name === "map-pack.json" || name.includes("map-pack"));

  const tasks = [];
  if (hasStream || hasJournal || hasNdjson) tasks.push(importTrace(list));
  if (hasMapAssets || likelyMapJson) tasks.push(importMap(list));
  if (!tasks.length) {
    const bundle = new FileBundle(list);
    try {
      const jsonFiles = list.filter((file) => file.name.toLowerCase().endsWith(".json"));
      const payloads = await Promise.all(
        jsonFiles.map(async (file) => {
          try {
            return JSON.parse(await file.text());
          } catch {
            return null;
          }
        }),
      );
      if (payloads.some((value) => value?.mapPackId && Array.isArray(value?.layers))) tasks.push(importMap(bundle));
      if (payloads.some((value) => value?.sessionId && value?.sceneName)) tasks.push(importTrace(bundle));
    } catch {
      // The dedicated import functions will provide a more useful error below.
    }
  }
  if (!tasks.length) {
    showError("未识别这些文件", "请选择地图包，或 manifest.json 与 stream.ndjson。", 7000);
    return;
  }
  await Promise.allSettled(tasks);
}

// setData is not reentrant: a second renderData whose state snapshot lacks the
// map (the boot race between initializeViewer's first render and the daily map
// load) lands while terrain is streaming, aborts every in-flight chapter, and
// leaves the page stuck on "正在加载本关底图" with nothing left to retry. Serialize
// all renders; each run reads the live state when it actually runs, so the last
// writer always wins instead of interleaving.
let renderChain = Promise.resolve();
function renderData() {
  const run = renderChain.then(renderDataNow, renderDataNow);
  renderChain = run.then(() => {}, () => {});
  return run;
}

async function renderDataNow() {
  const useMap = Boolean(state.mapPack && (!state.trace || state.compatibility?.compatible));
  state.routeView = resolveReplayRoute(useMap ? state.mapPack : null, state.trace, state.currentTime);
  state.usingCompatibleMap = useMap;
  const activeSegment = populateSegmentControls();
  if (viewer) {
    // The same data re-rendered (5-minute daily refresh, live connect adopting
    // the already-loaded pack) would tear down and refetch every chapter.
    const signature = [
      state.mapPack?.mapPackId ?? null,
      state.trace?.manifest?.sessionId ?? null,
      useMap ? state.routeView.layers.map((layer) => layer.id).join(",") : null,
      useMap, activeSegment,
    ].join("|");
    if (signature !== state.lastRenderSignature) {
      if (useMap) markSegmentTransition(activeSegment);
      const displayMap = state.mapPack ? { ...state.mapPack, layers: state.routeView.layers } : null;
      await viewer.setData({ mapPack: displayMap, trace: state.trace, useMap, activeSegment });
      state.lastRenderSignature = signature;
    }
    viewer.setGameAssetPack(state.gameAssetPack);
    viewer.setWorldVisibility(elements.worldToggle.checked);
    viewer.setHeightScale(elements.heightScale.value);
    viewer.setTrackVisibility(elements.trackToggle.checked);
    viewer.setMarkerVisibility(elements.markerToggle.checked);
    viewer.setTime(state.currentTime);
    updatePlayerTelemetry();
  }
  updateEmptyState();
  updateSceneMeta();
}

function updateEmptyState() {
  elements.emptyState.classList.toggle("is-hidden", Boolean(state.trace || state.mapPack));
}

function updateMapUI() {
  const pack = state.mapPack;
  const automatic = ["daily", "archive"].includes(state.mapSourceKind);
  elements.mapSourceButton.classList.toggle("is-loaded", Boolean(pack));
  elements.mapSourceName.textContent = pack
    ? pack.sceneName
    : state.dailyMapStatus?.title || "尚未导入地图";
  elements.mapSourceMeta.textContent = pack
    ? `${automatic ? "Pages 内嵌 · " : "开发导入 · "}${pack.mapPackId} · ${pack.layers.length} 层 · build ${pack.gameBuildId || "未知"}`
    : state.dailyMapStatus?.detail || "按所选局次从 Pages catalog 自动匹配";
  elements.mapSourceState.textContent = pack ? (automatic ? "内嵌" : "开发") : "自动";
  updateSceneMeta();
}

function updateTraceUI() {
  const trace = state.trace;
  const sessionCount = state.traceCollection?.sessions.length || (trace ? 1 : 0);
  const dayCount = state.traceCollection?.days.length || (trace ? 1 : 0);
  elements.traceSourceButton.classList.toggle("is-loaded", Boolean(trace));
  elements.traceSourceName.textContent = trace ? `${dayCount} 天 · ${sessionCount} 局足迹` : "尚未导入足迹";
  elements.traceSourceMeta.textContent = trace
    ? `当前 ${trace.manifest.sceneName} · ${trace.sampleCount.toLocaleString("zh-CN")} 个采样`
    : "选择足迹总目录（可含多天、多局）";
  elements.traceSourceState.textContent = trace ? "已载入" : "选择";
  elements.playButton.disabled = !trace;
  elements.timeline.disabled = !trace;
  elements.speedSelect.disabled = !trace;
  elements.timeline.max = trace?.duration || 0;
  elements.totalTime.textContent = formatTime(trace?.duration || 0);
  updatePlayers();
  updateEvents();
  updatePlaybackTime(0, false);
  updateSceneMeta();
}

function updateCompatibilityUI(showMismatchDetail = false) {
  const result = assessCompatibility(state.trace?.manifest, state.mapPack);
  state.compatibility = result;
  elements.compatibilityPill.classList.remove("is-neutral", "is-good", "is-error");
  elements.compatibilityPill.classList.add(`is-${result.status}`);
  elements.compatibilityText.textContent = result.message;
  if (showMismatchDetail && result.status === "error" && result.reasons.length) {
    showError("地图与足迹不匹配", `${result.reasons.join("；")}。轨迹仍可在无底图模式回放。`, 12000);
  }
}

function updateSceneMeta() {
  const scene = state.trace?.manifest.sceneName || state.mapPack?.sceneName || "—";
  elements.sceneName.textContent = scene;
  elements.sampleCount.textContent = state.trace ? state.trace.sampleCount.toLocaleString("zh-CN") : "0";

  const useMapBounds = state.mapPack && (!state.trace || state.compatibility?.compatible);
  const layers = useMapBounds ? (state.routeView?.layers || state.mapPack.layers).filter((layer) => state.selectedSegment === null
    ? String(layer.biome).toLowerCase() !== "void" : layer.segment === state.selectedSegment) : [];
  const bounds = layers.length ? {
    min: [0, Math.min(...layers.map((layer) => layer.minY)), 0],
    max: [0, Math.max(...layers.map((layer) => layer.maxY)), 0],
  } : state.trace?.bounds || state.mapPack?.bounds;
  elements.altitudeRange.textContent = bounds
    ? `${Math.round(bounds.min[1])}–${Math.round(bounds.max[1])} m`
    : "—";
}

function participantName(playerId) {
  if (!playerId) return "全局事件";
  return state.trace?.participants.find((participant) => participant.id === playerId)?.nickname || playerId;
}

function eventSegmentLabel(event) {
  if (event.segment !== null) return `所属分层 ${event.segment}`;
  if (event.activeSegment !== null) return `全局活动分区 ${event.activeSegment}`;
  return null;
}

function eventItemLabel(event) {
  if (!event.item) return null;
  return `物品 ${event.item.name || event.item.id}`;
}

function eventMovementLabel(event) {
  if (event.fromLocation && event.toLocation) return `${event.fromLocation} → ${event.toLocation}`;
  return event.toLocation || event.fromLocation || null;
}

function updatePlayers() {
  elements.playerList.replaceChildren();
  const participants = (state.trace?.participants || []).filter(
    (participant) => (state.trace.tracks.get(participant.id) || []).length > 0,
  );
  elements.playerCount.textContent = String(participants.length);
  if (!participants.length) {
    const empty = document.createElement("p");
    empty.className = "inline-empty";
    empty.textContent = "导入足迹后，可单独显示或隐藏玩家。";
    elements.playerList.append(empty);
    return;
  }

  for (const participant of participants) {
    const color = viewer?.getPlayerColor(participant.id) || "#efb74e";
    const row = createPlayerCard(
      participant,
      color,
      (visible) => viewer?.setPlayerVisibility(participant.id, visible),
    );
    elements.playerList.append(row);
  }
  syncFollowHud();
  updatePlayerTelemetry();
}

function updatePlayerTelemetry() {
  updateWorldTelemetry();
  const trace = state.trace;
  for (const row of elements.playerList.querySelectorAll(".player-row")) {
    const playerState = tracePlayerStateAtTime(state.trace, row.dataset.playerId, state.currentTime);
    updatePlayerCard(row, playerState, {
      assetPack: state.gameAssetPack,
      assetStatus: state.gameAssetStatus,
      assetError: state.gameAssetError,
      onPortrait: (url) => {
        if (state.trace === trace && row.isConnected) viewer?.setPlayerPortrait(row.dataset.playerId, url);
      },
    });
    const head = row.querySelector(".player-head-image");
    viewer?.setPlayerPortrait(row.dataset.playerId, head?.hidden ? null : head?.getAttribute("src"));
  }
}

function updateWorldTelemetry() {
  elements.worldTelemetryNote.textContent = state.trace ? worldTelemetryNote(state.trace.worldTimeline, state.currentTime) : "等待导入世界记录";
  const world = viewer?.worldRenderer;
  const fog = world?.fogState;
  elements.mapFogNote.hidden = !fog?.count;
  elements.mapFogNote.textContent = fog?.mode === "map-baseline" ? "地图基础雾 · 初始配置，非本局实录" : "本局实录雾 · 随时间线回放";
  elements.mapFogNote.title = fog?.note || "";
  const objects = world?.objects || [];
  elements.worldSummary.textContent = [state.trace?.worldTimeline?.captured ? `此刻记录 ${objects.length} 个世界对象 · 采样状态，不预测中间运动` : "", fog?.count ? fog.note : ""].filter(Boolean).join("\n");
  const alerts = (world?.alerts || []).sort((a, b) => a.distance - b.distance).slice(0, 8);
  const key = JSON.stringify(alerts.map((alert) => [alert.object.objectId, Math.round(alert.distance), alert.active]));
  if (elements.worldAlerts.dataset.key === key) return;
  elements.worldAlerts.dataset.key = key;
  elements.worldAlerts.replaceChildren();
  for (const alert of alerts) {
    const row = document.createElement("p");
    row.className = alert.active ? "world-alert is-danger" : "world-alert";
    row.textContent = `${alert.object.kind.includes("zombie") ? "蘑菇僵尸" : "危险物"} · ${Math.round(alert.distance)}m · ${alert.active ? "已激活" : "接近预警"}`;
    row.title = `记录状态：${alert.object.activity}；提示距离 ${alert.range}m（游戏激活还可能依赖朝向、视线等条件）`;
    elements.worldAlerts.append(row);
  }
}

function createEventButton(event) {
  const presentation = eventPresentation(event.type);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "event-button";
  button.style.setProperty("--event-color", presentation.color);
  button.title = [event.source, event.confidence].filter(Boolean).join(" · ");
  button.addEventListener("click", () => {
    setPlaying(false);
    updatePlaybackTime(event.t, true);
    showEventToast(event);
    viewer?.focusWorldEvent(event);
  });

  const symbol = document.createElement("span");
  symbol.className = "event-symbol";
  symbol.textContent = presentation.symbol;
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = event.label || presentation.label;
  const meta = document.createElement("small");
  meta.textContent = [
    participantName(event.playerId),
    eventItemLabel(event),
    eventMovementLabel(event),
    eventSegmentLabel(event),
  ]
    .filter(Boolean)
    .join(" · ");
  copy.append(title, meta);
  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = formatTime(event.t);
  button.append(symbol, copy, time);
  return button;
}

/** Renders only the rows around the list's scroll position. A 107-minute party
 * session carries thousands of item events; keeping them all in the DOM made every
 * layout pass — and therefore every replay frame — an order of magnitude slower. */
function renderEventWindow() {
  const events = state.trace?.events || [];
  const list = elements.eventList;
  if (!events.length) return;
  const viewport = list.clientHeight || 400;
  const first = Math.max(0, Math.floor(list.scrollTop / EVENT_ROW_STRIDE) - EVENT_WINDOW_OVERSCAN);
  const last = Math.min(events.length,
    first + Math.ceil(viewport / EVENT_ROW_STRIDE) + EVENT_WINDOW_OVERSCAN * 2);
  for (const [index, node] of state.eventRows) {
    if (index >= first && index < last) continue;
    node.remove();
    state.eventRows.delete(index);
  }
  for (let index = first; index < last; index += 1) {
    if (state.eventRows.has(index)) continue;
    const button = createEventButton(events[index]);
    button.style.top = `${index * EVENT_ROW_STRIDE}px`;
    list.append(button);
    state.eventRows.set(index, button);
  }
}

function scheduleEventWindow() {
  if (state.eventWindowFrame) return;
  state.eventWindowFrame = requestAnimationFrame(() => {
    state.eventWindowFrame = 0;
    renderEventWindow();
  });
}

function updateEvents() {
  elements.eventList.replaceChildren();
  state.eventRows.clear();
  elements.timelineMarkers.replaceChildren();
  elements.eventList.scrollTop = 0;
  const events = state.trace?.events || [];
  elements.eventCount.textContent = String(events.length);
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "inline-empty";
    empty.textContent = "死亡、复活、传送和分区变化会显示在这里。";
    elements.eventList.append(empty);
    return;
  }

  // Absolutely positioned rows cannot grow the scroller by themselves; this
  // spacer carries the full session height so the scrollbar stays truthful.
  const spacer = document.createElement("div");
  spacer.className = "event-list-spacer";
  spacer.style.height = `${events.length * EVENT_ROW_STRIDE}px`;
  elements.eventList.append(spacer);

  const duration = Math.max(0.001, state.trace.duration);
  const markerFragment = document.createDocumentFragment();
  // Overlapping ticks at this width are indistinguishable, and a long session can
  // carry thousands of events. Bucketing keeps the timeline strip at a few hundred
  // nodes instead of tens of thousands, whose layout cost dominated every frame.
  const markers = new Map();
  for (const event of events) {
    const percent = Math.min(100, Math.max(0, (event.t / duration) * 100));
    const bucket = Math.round(percent / TIMELINE_MARKER_STEP);
    // The latest event in a bucket wins, so tick colors stay chronological.
    markers.set(bucket, { left: Math.min(100, bucket * TIMELINE_MARKER_STEP),
      color: eventPresentation(event.type).color });
  }
  for (const marker of markers.values()) {
    const tick = document.createElement("span");
    tick.className = "timeline-marker";
    tick.style.left = `${marker.left}%`;
    tick.style.setProperty("--marker-color", marker.color);
    markerFragment.append(tick);
  }
  elements.timelineMarkers.append(markerFragment);
  renderEventWindow();
}

function showEventToast(event) {
  clearTimeout(state.toastTimer);
  const presentation = eventPresentation(event.type);
  elements.eventToastIcon.textContent = presentation.symbol;
  elements.eventToastIcon.style.color = presentation.color;
  elements.eventToastTitle.textContent = event.label || presentation.label;
  elements.eventToastMeta.textContent = [
    participantName(event.playerId),
    eventItemLabel(event),
    eventMovementLabel(event),
    eventSegmentLabel(event),
    formatTime(event.t),
  ].filter(Boolean).join(" · ");
  elements.eventToast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => elements.eventToast.classList.remove("is-visible"), 3200);
}

const TELEMETRY_UPDATE_INTERVAL_MS = 125;
// One timeline tick per ~0.12 % of the session, capped at ~850 ticks total.
const TIMELINE_MARKER_STEP = Math.max(0.12, 100 / 850);
// .event-button is a fixed 41 px box with a 5 px gap between rows.
const EVENT_ROW_STRIDE = 46;
const EVENT_WINDOW_OVERSCAN = 6;

function updatePlaybackTime(nextTime, detectEvents = true) {
  const duration = state.trace?.duration || 0;
  const previous = state.currentTime;
  state.currentTime = Math.min(duration, Math.max(0, Number(nextTime) || 0));
  const eligibleMap = !state.trace || state.compatibility?.compatible ? state.mapPack : null;
  const nextRoute = resolveReplayRoute(eligibleMap, state.trace, state.currentTime);
  if (nextRoute.key !== state.routeView?.key) {
    void renderData().catch((error) => showError("关卡分支更新失败", error.message));
  }
  elements.timeline.value = String(state.currentTime);
  // The live edge grows between flush ticks; a stale max makes the browser
  // clamp the slider so it visibly freezes and then jumps once per second.
  if (duration > Number(elements.timeline.max)) elements.timeline.max = String(duration);
  elements.currentTime.textContent = formatTime(state.currentTime);
  const percent = duration ? (state.currentTime / duration) * 100 : 0;
  elements.timeline.style.background = `linear-gradient(90deg, var(--accent) ${percent}%, rgba(255, 255, 255, 0.12) ${percent}%)`;
  syncSegmentToPlayback();
  viewer?.setTime(state.currentTime);
  // The 3D scene needs a per-frame update; sidebar cards are DOM text and do not.
  // Refreshing them at ~8 Hz during playback and live-follow keeps long
  // multiplayer sessions smooth; pausing and scrubbing refresh immediately.
  const steady = state.playing || isLiveFollowing();
  const nowMs = performance.now();
  if (!steady || nowMs - state.lastTelemetryAt >= TELEMETRY_UPDATE_INTERVAL_MS) {
    state.lastTelemetryAt = nowMs;
    updatePlayerTelemetry();
  }

  if (detectEvents && state.currentTime >= previous) {
    const crossed = state.trace?.events.filter((event) => event.t > previous && event.t <= state.currentTime).at(-1);
    if (crossed) showEventToast(crossed);
  }
}

function setPlaying(playing) {
  state.playing = Boolean(playing && state.trace);
  state.lastPlaybackFrame = performance.now();
  // Start and pause moments must refresh the sidebar immediately, not on the next throttle tick.
  state.lastTelemetryAt = 0;
  if (!state.playing) updatePlayerTelemetry();
  elements.playButton.classList.toggle("is-playing", state.playing);
  elements.playButton.setAttribute("aria-label", state.playing ? "暂停" : "播放");
  syncWakeLock();
}

/** Live-follow: the playback loop continuously chases a point just behind the
 * newest record (smooth interpolation, prompt state), snapping forward after a
 * stall. Only while the live trace is the one on display. */
function isLiveFollowing() {
  const live = state.live;
  // 演示模式没有 SSE（es 为 null，demoTimer 供数），同样参与跟随。
  return Boolean((live?.es || live?.demoTimer) && live.trace && state.trace === live.trace && elements.liveFollow.checked);
}

function playbackLoop(timestamp) {
  if (state.playing && state.trace) {
    const delta = Math.min(0.25, (timestamp - state.lastPlaybackFrame) / 1000);
    const next = state.currentTime + delta * state.speed;
    if (next >= state.trace.duration) {
      updatePlaybackTime(state.trace.duration, true);
      setPlaying(false);
    } else {
      updatePlaybackTime(next, true);
    }
  } else if (isLiveFollowing() && state.trace) {
    const delta = Math.min(0.25, (timestamp - state.lastPlaybackFrame) / 1000);
    const next = liveChaseTarget({
      currentTime: state.currentTime,
      edge: state.trace.duration,
      deltaSeconds: delta,
      trailSeconds: (state.live.trail?.trailMs() ?? LIVE_TRAIL_S * 1000) / 1000,
    });
    if (next !== null && next > state.currentTime) updatePlaybackTime(next, true);
  }
  state.lastPlaybackFrame = timestamp;
  requestAnimationFrame(playbackLoop);
}

function updateRangeFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  const percent = ((value - min) / (max - min)) * 100;
  input.style.background = `linear-gradient(90deg, var(--accent) ${percent}%, rgba(255, 255, 255, 0.11) ${percent}%)`;
}

/** Daily-rotation sources, best first: the relay proxies PEAK's login API with no
 * GitHub Action dependency; the static snapshot backs Pages deployments and
 * relay outages. A down relay is skipped for a while instead of timing out. */
function dailySources() {
  const list = [];
  const backend = defaultRelayUrl();
  if (backend && !list.includes(`${backend}/api/daily`)) list.push(`${backend}/api/daily`);
  if (state.dailySource) list.push(state.dailySource);
  list.push("./data/daily/current.json");
  return [...new Set(list)];
}

async function fetchDailyData() {
  const now = Date.now();
  let stale = null;
  for (const url of dailySources()) {
    if (url.endsWith("/api/daily") && now < state.dailyBackendDownUntil) continue;
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const data = await response.json();
      const freshness = buildHomeDailyView({ daily: data, now: Date.now() }).freshness;
      if (freshness === "unavailable") continue;
      if (freshness === "current") { state.dailySource = url; return data; }
      stale ||= data;
    } catch { /* try the next source */ }
  }
  if (dailySources().some((url) => url.endsWith("/api/daily"))) {
    state.dailyBackendDownUntil = now + 10 * 60_000;
  }
  return stale;
}

async function loadDailyStatus() {
  if (state.dailyRequestInFlight) return;
  state.dailyRequestInFlight = true;
  try {
    const daily = await fetchDailyData();
    if (!daily) {
      if (!state.daily) {
        elements.dailyScene.textContent = "本地模式";
        elements.dailyCountdown.textContent = "未同步轮换";
      }
      return;
    }
    state.daily = daily;
    void homePage.update(daily);
    clearTimeout(state.dailyExpiryTimer);
    state.dailyExpiryTimer = null;
    elements.dailyScene.textContent = daily.sceneName || `Level ${daily.mapSlot ?? daily.levelIndex ?? "?"}`;
    if (!isDailyMapFresh(daily)) {
      elements.dailyCountdown.textContent = Number.isFinite(Date.parse(daily.nextChangeAtUtc))
        ? "轮换数据已过期"
        : "更新时间无效";
      await expireDailyStatus(daily);
      return;
    }
    state.expiredDailyKey = null;
    scheduleDailyExpiry(daily);
    updateDailyCountdown();
    if (gateOpen()) return; // The home owns its lightweight manifest and four previews.
    try {
      if (state.trace) {
        const trace = state.trace;
        await syncMapForTrace(trace, true);
        // A catalog refresh can make a previously missing historical map available while
        // this page stays open. Commit that asynchronously loaded map to the scene only if
        // the user is still looking at the same session.
        if (state.trace === trace) {
          state.compatibility = assessCompatibility(trace.manifest, state.mapPack);
          await renderData();
          updateMapUI();
          updateCompatibilityUI(false);
        }
      } else {
        await syncDailyMap(daily, true);
      }
      state.dailyMapErrorKey = null;
    } catch (error) {
      const targetScene = state.trace?.manifest.sceneName || daily.sceneName;
      const key = `${targetScene}:${error?.message}`;
      if (state.trace) await clearAutomaticMap();
      else if (state.mapSourceKind === "daily") await clearDailyMap();
      state.dailyMapStatus = {
        title: `${targetScene} 地图暂不可用`,
        detail: error?.message || "无法读取地图目录",
      };
      updateMapUI();
      if (state.dailyMapErrorKey !== key) {
        state.dailyMapErrorKey = key;
        showError("今日地图未载入", state.dailyMapStatus.detail, 7000);
      }
    }
  } catch {
    if (!state.daily) {
      elements.dailyScene.textContent = "本地模式";
      elements.dailyCountdown.textContent = "未同步轮换";
    }
  } finally {
    state.dailyRequestInFlight = false;
    if (!state.daily) void homePage.update(null);
  }
}

async function clearDailyMap() {
  if (state.mapSourceKind !== "daily") return;
  const previous = state.mapPack;
  state.mapPack = null;
  state.mapSourceKind = null;
  state.compatibility = assessCompatibility(state.trace?.manifest, null);
  await renderData();
  previous?.disposeAssets?.();
  updateMapUI();
  updateCompatibilityUI();
}

async function clearAutomaticMap() {
  if (!["daily", "archive"].includes(state.mapSourceKind)) return;
  const previous = state.mapPack;
  state.mapPack = null;
  state.mapSourceKind = null;
  state.compatibility = assessCompatibility(state.trace?.manifest, null);
  await renderData();
  previous?.disposeAssets?.();
  updateMapUI();
  updateCompatibilityUI();
}

async function ensureMapCatalog(force = false) {
  if (!force && state.mapCatalog && state.mapCatalogBaseUrl) {
    return { catalog: state.mapCatalog, baseUrl: state.mapCatalogBaseUrl };
  }
  const response = await fetch("./data/maps/catalog.json", { cache: "no-store" });
  if (!response.ok) throw new ProtocolError("无法读取地图目录", `HTTP ${response.status}`);
  const catalog = await response.json();
  // Selection performs the strict catalog shape check before any entry is used.
  state.mapCatalog = catalog;
  state.mapCatalogBaseUrl = response.url;
  return { catalog, baseUrl: response.url };
}

async function syncMapForTrace(trace, refreshCatalog = false) {
  if (!trace || state.manualMapLoads > 0 || ["manual", "query"].includes(state.mapSourceKind)) return;
  const requestRevision = ++state.mapRequestRevision;
  let catalogInfo;
  try {
    catalogInfo = await ensureMapCatalog(refreshCatalog);
  } catch (error) {
    if (requestRevision !== state.mapRequestRevision || state.trace !== trace) return;
    await clearAutomaticMap();
    state.dailyMapStatus = {
      title: `${trace.manifest.sceneName} 内嵌地图不可用`,
      detail: error.message || "无法读取 Pages 地图目录",
    };
    return;
  }
  if (requestRevision !== state.mapRequestRevision || state.trace !== trace) return;
  const entry = selectTraceMapPack(catalogInfo.catalog, trace.manifest);
  if (!entry) {
    await clearAutomaticMap();
    state.dailyMapStatus = {
      title: `${trace.manifest.sceneName} 尚无匹配底图`,
      detail: trace.manifest.mapPackId
        ? `catalog 中没有 ${trace.manifest.mapPackId}`
        : `需要同 build ${trace.manifest.gameBuildId || "未知"} 与投影版本的内嵌地图`,
    };
    updateMapUI();
    return;
  }
  if (state.mapSourceKind === "archive" && state.mapPack?.mapPackId === entry.mapPackId) {
    state.dailyMapStatus = null;
    return;
  }

  setSourceLoading("map", true);
  try {
    const nextMap = await loadMapPackUrl(new URL(entry.path, catalogInfo.baseUrl).href);
    if (requestRevision !== state.mapRequestRevision || state.trace !== trace) {
      nextMap.disposeAssets?.();
      return;
    }
    const compatibility = assessCompatibility(trace.manifest, nextMap);
    if (!compatibility.compatible) {
      nextMap.disposeAssets?.();
      throw new ProtocolError("内嵌地图与该局足迹不匹配", compatibility.reasons.join("；"));
    }
    const previous = state.mapPack;
    state.mapPack = nextMap;
    state.mapSourceKind = "archive";
    state.dailyMapStatus = null;
    state.compatibility = compatibility;
    previous?.disposeAssets?.();
  } finally {
    setSourceLoading("map", false);
  }
}

async function syncDailyMap(daily, refreshCatalog = false) {
  if (state.manualMapLoads > 0 || (state.mapSourceKind && state.mapSourceKind !== "daily")) return;
  const startingRevision = state.mapRequestRevision;
  if (state.mapSourceKind === "daily" && state.mapPack?.sceneName !== daily.sceneName) {
    await clearDailyMap();
  }

  const { catalog, baseUrl } = await ensureMapCatalog(refreshCatalog);
  if (state.manualMapLoads > 0
      || state.mapRequestRevision !== startingRevision
      || (state.mapSourceKind && state.mapSourceKind !== "daily")) return;
  const entry = selectDailyMapPack(catalog, daily);

  if (!entry) {
    await clearDailyMap();
    const activeBuild = catalog.activeGameBuildId ? `build ${catalog.activeGameBuildId}` : "尚未指定当前构建";
    state.dailyMapStatus = {
      title: `${daily.sceneName} 地图包未发布`,
      detail: `${activeBuild} · 可继续导入本地地图包`,
    };
    updateMapUI();
    return;
  }

  const currentPackMatches = state.mapSourceKind === "daily"
    && state.mapPack?.mapPackId === String(entry.mapPackId)
    && state.mapPack?.sceneName === daily.sceneName
    && Number(state.mapPack?.mapSlot) === Number(daily.mapSlot)
    && String(state.mapPack?.gameBuildId).trim() === String(catalog.activeGameBuildId).trim();
  if (currentPackMatches) {
    state.dailyMapStatus = null;
    return;
  }

  if (state.mapSourceKind === "daily") await clearDailyMap();

  const packUrl = new URL(entry.path, baseUrl).href;
  const requestRevision = ++state.mapRequestRevision;
  setSourceLoading("map", true);
  try {
    const nextMap = await loadMapPackUrl(packUrl);
    if (!isDailyMapFresh(daily)) {
      nextMap.disposeAssets?.();
      await expireDailyStatus(daily);
      return;
    }
    if (requestRevision !== state.mapRequestRevision
        || state.manualMapLoads > 0
        || (state.mapSourceKind && state.mapSourceKind !== "daily")) {
      nextMap.disposeAssets?.();
      return;
    }
    const conflicts = [];
    if (nextMap.mapPackId !== String(entry.mapPackId)) conflicts.push("mapPackId");
    if (nextMap.sceneName !== daily.sceneName) conflicts.push("sceneName");
    if (Number(nextMap.mapSlot) !== Number(daily.mapSlot)) conflicts.push("mapSlot");
    if (String(nextMap.gameBuildId).trim() !== String(catalog.activeGameBuildId).trim()) conflicts.push("gameBuildId");
    if (conflicts.length) {
      nextMap.disposeAssets?.();
      throw new ProtocolError("地图目录与地图包不一致", `冲突字段：${conflicts.join(", ")}`);
    }

    const previous = state.mapPack;
    state.mapPack = nextMap;
    state.mapSourceKind = "daily";
    state.dailyMapStatus = null;
    state.compatibility = assessCompatibility(state.trace?.manifest, state.mapPack);
    await renderData();
    previous?.disposeAssets?.();
    updateMapUI();
    updateCompatibilityUI(true);
  } catch (error) {
    throw error;
  } finally {
    setSourceLoading("map", false);
  }
}

function updateDailyCountdown() {
  if (!state.daily?.nextChangeAtUtc) return;
  const remaining = new Date(state.daily.nextChangeAtUtc).getTime() - Date.now();
  if (!Number.isFinite(remaining)) {
    elements.dailyCountdown.textContent = "更新时间无效";
    void expireDailyStatus(state.daily);
    return;
  }
  if (remaining <= 0) {
    elements.dailyCountdown.textContent = "轮换数据已过期";
    void expireDailyStatus(state.daily);
    return;
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  elements.dailyCountdown.textContent = `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

async function expireDailyStatus(daily) {
  const expiryKey = `${daily?.fetchedAtUtc || "unknown"}:${daily?.nextChangeAtUtc || "invalid"}`;
  if (state.expiredDailyKey === expiryKey) return;
  state.expiredDailyKey = expiryKey;
  if (state.trace) return;
  if (state.manualMapLoads === 0 && (!state.mapSourceKind || state.mapSourceKind === "daily")) {
    state.mapRequestRevision += 1;
  }
  if (state.mapSourceKind === "daily") await clearDailyMap();
  state.dailyMapStatus = {
    title: `${daily?.sceneName || "今日"} 地图状态已过期`,
    detail: "已隐藏自动底图，等待 GitHub Action 写入下一轮数据",
  };
  updateMapUI();
}

function scheduleDailyExpiry(daily) {
  const delay = Date.parse(daily.nextChangeAtUtc) - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return;
  state.dailyExpiryTimer = setTimeout(() => {
    elements.dailyCountdown.textContent = "轮换数据已过期";
    void expireDailyStatus(daily);
  }, delay + 50);
}

elements.eventList.addEventListener("scroll", scheduleEventWindow, { passive: true });
elements.modeReplay.addEventListener("click", () => setSourceMode("replay"));
elements.gateReplay.addEventListener("click", () => enterModeFromGate("replay"));
$("homeReplayLink").addEventListener("click", () => enterModeFromGate("replay"));
elements.gateLive.addEventListener("click", () => {
  if (!gateRuns.length) {
    // 空卡不是死路：点开诊断（中继可达性/错误/检测时间），并立即重测。
    elements.gateLive.classList.toggle("gate-diag-open");
    void refreshGateRuns();
    return;
  }
  if (state.live.code) {
    dismissGate();
    return;
  }
  if (gateRuns.length === 1) enterLive(gateRuns[0].code);
  else {
    elements.gateLive.classList.toggle("gate-diag-open");
    renderGateRuns();
  }
});
elements.backToGate.addEventListener("click", () => {
  elements.importMenu.open = false;
  showGate();
});
elements.gateDebug.addEventListener("click", () => {
  dismissGate();
  setSourceMode("live");
  startDemoLive();
});
setInterval(() => {
  if (gateOpen()) void refreshGateRuns();
}, 5000);
// 侧栏手风琴：标题点击折叠/展开
document.querySelectorAll(".inspector-section .section-heading").forEach((heading) => {
  heading.addEventListener("click", () => heading.closest(".inspector-section")?.classList.toggle("is-collapsed"));
});
// 玩家卡默认极简：点击卡片展开完整细节（按钮/开关除外）
elements.playerList.addEventListener("click", (event) => {
  const followButton = event.target.closest(".player-follow-button");
  if (followButton) {
    const row = followButton.closest(".player-row");
    const playerId = row?.dataset.playerId;
    if (playerId && viewer) viewer.lockFollowTarget(viewer.followTargetId === playerId ? null : playerId);
    return;
  }
  if (event.target.closest("button, label, input, select")) return;
  event.target.closest(".player-row")?.classList.toggle("is-expanded");
});

// ===== 跟随相机：HUD + 快捷键 =====
function syncFollowHud(detail) {
  const active = Boolean(detail?.active ?? (viewer?.followTargetId != null));
  elements.followHud.hidden = !active;
  if (active) {
    const auto = detail?.autoRotate ?? viewer?.followAutoRotate ?? false;
    const viewMode = detail?.viewMode ?? viewer?.followViewMode;
    elements.followHudText.textContent = `${viewMode === "interior" ? "关内向外观测" : "外侧观测"} · ${detail?.name ?? viewer?.followTargetId ?? ""} · ${auto ? "自动轮换 60s" : "已锁定"}`;
  }
  for (const row of elements.playerList.querySelectorAll(".player-row")) {
    row.querySelector(".player-follow-button")?.classList.toggle(
      "is-following",
      viewer?.followTargetId != null && row.dataset.playerId === viewer.followTargetId,
    );
  }
}
elements.sceneCanvas.addEventListener("peaktrail-follow-status", (event) => syncFollowHud(event.detail));
elements.cinematicButton.addEventListener("click", () => {
  if (!viewer) return;
  if (viewer.followTargetId !== null) {
    viewer.setFollowTarget(null);
  } else {
    viewer.startAutoFollow();
  }
});

// ===== 关卡导航条：收起/展开 =====
elements.segmentNavigator.addEventListener("click", (event) => {
  // 面板内的功能按钮照常工作；点其它区域切换收起/展开。
  if (event.target.closest("button")) return;
  elements.segmentNavigator.classList.toggle("is-collapsed");
});
document.addEventListener("click", (event) => {
  if (event.target.closest("#segmentNavigator")) return;
  elements.segmentNavigator.classList.add("is-collapsed");
});
window.addEventListener("keydown", (event) => {
  if (gateOpen()) return;
  if (!viewer) return;
  if (event.key === "Escape" && viewer.cinematic) {
    event.preventDefault();
    viewer.exitCinematicMode();
  } else if (event.key === "Escape" && viewer.followTargetId !== null) {
    event.preventDefault();
    viewer.setFollowTarget(null);
  } else if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (!state.trace) return;
    event.preventDefault();
    viewer.cycleFollowTarget();
  }
});
elements.modeLive.addEventListener("click", () => setSourceMode("live"));
elements.liveRefresh.addEventListener("click", () => void refreshLiveRuns());
elements.liveDisconnect.addEventListener("click", () => disconnectLive());
elements.mapInput.addEventListener("change", () => importMap(elements.mapInput.files));
elements.traceInput.addEventListener("change", () => importTrace(elements.traceInput.files));
elements.traceFolderInput.addEventListener("change", () => importTrace(elements.traceFolderInput.files));
elements.traceSourceButton.addEventListener("click", () => elements.traceInput.click());
elements.dateSelect.addEventListener("change", async () => {
  populateSessionSelect();
  try {
    await selectTraceSession(elements.sessionSelect.value);
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  }
});
elements.sessionSelect.addEventListener("change", () => {
  void selectTraceSession(elements.sessionSelect.value).catch((error) => {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  });
});
elements.dismissError.addEventListener("click", hideError);
elements.topViewButton.addEventListener("click", () => viewer?.topView());
elements.fitViewButton.addEventListener("click", () => viewer?.fitView());
elements.freeCameraButton.addEventListener("click", () => viewer?.toggleFreeCamera());
elements.interiorViewButton.addEventListener("click", () => viewer?.enterInteriorView());
elements.worldToggle.addEventListener("change", () => {
  viewer?.setWorldVisibility(elements.worldToggle.checked);
  updateWorldTelemetry();
});
elements.sceneCanvas.addEventListener("cameramodechange", (event) => {
  const free = event.detail.mode === "free";
  elements.freeCameraButton.setAttribute("aria-pressed", String(free));
  elements.cameraHelp.hidden = !free;
  elements.sceneCanvas.setAttribute("aria-label", free ? event.detail.help : "地图回放，可切换自由相机");
});
elements.sceneCanvas.addEventListener("cameraplacement", (event) => { elements.cameraPlacement.textContent = event.detail.note; });
elements.heightScale.addEventListener("input", () => {
  elements.heightScaleValue.textContent = `${Number(elements.heightScale.value).toFixed(1)}×`;
  updateRangeFill(elements.heightScale);
  viewer?.setHeightScale(elements.heightScale.value);
});
elements.layerSelect.addEventListener("change", () => {
  chooseSegment(elements.layerSelect.value === "all" ? null : Number(elements.layerSelect.value), "manual");
});
elements.previousSegmentButton.addEventListener("click", () => {
  const chapters = state.segmentOptions.filter((option) => !option.isVoid);
  if (!chapters.length) return;
  const index = chapters.findIndex((option) => option.segment === state.selectedSegment);
  const previous = index < 0 ? chapters.at(-1) : chapters[index - 1];
  if (previous) chooseSegment(previous.segment, "manual");
});
elements.nextSegmentButton.addEventListener("click", () => {
  const chapters = state.segmentOptions.filter((option) => !option.isVoid);
  if (!chapters.length) return;
  const index = chapters.findIndex((option) => option.segment === state.selectedSegment);
  const next = index < 0 ? chapters[0] : chapters[index + 1];
  if (next) chooseSegment(next.segment, "manual");
});
elements.followSegmentButton.addEventListener("click", () => {
  state.segmentSelectionMode = "auto";
  chooseSegment(defaultSegment(), "auto");
});
elements.segmentOverviewButton.addEventListener("click", () => chooseSegment(null, "manual"));
elements.sceneCanvas.addEventListener("peaktrail-map-status", (event) => {
  const detail = event.detail || {};
  const segment = detail.segment === "all" ? null : asSegment(detail.segment);
  if (!["loading", "ready", "error"].includes(detail.status)) return;
  if (state.selectedSegment !== null && segment !== state.selectedSegment) return;
  const value = { status: detail.status, message: String(detail.message || "") };
  if (segment === null) {
    for (const option of overviewSegmentOptions()) {
      state.segmentMapStatuses.set(segmentStatusKey(option.segment), value);
    }
  } else {
    state.segmentMapStatuses.set(segmentStatusKey(segment), value);
  }
  renderSegmentNavigation();
});
elements.trackToggle.addEventListener("change", () => viewer?.setTrackVisibility(elements.trackToggle.checked));
elements.markerToggle.addEventListener("change", () => viewer?.setMarkerVisibility(elements.markerToggle.checked));
elements.timeline.addEventListener("input", () => {
  // Scrubbing takes over from live-follow: the chase must not fight the user
  // dragging through the buffered records. Re-check 跟随 to resume the edge.
  if (isLiveFollowing()) elements.liveFollow.checked = false;
  updatePlaybackTime(elements.timeline.value, false);
});
elements.playButton.addEventListener("click", () => {
  if (!state.trace) return;
  if (!state.playing && state.currentTime >= state.trace.duration) updatePlaybackTime(0, false);
  setPlaying(!state.playing);
});
elements.speedSelect.addEventListener("change", () => {
  state.speed = Number(elements.speedSelect.value) || 1;
});

document.addEventListener("keydown", (event) => {
  if (gateOpen()) return;
  if (event.code !== "Space" || event.repeat) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement) return;
  event.preventDefault();
  elements.playButton.click();
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  elements.dropOverlay.classList.add("is-visible");
});
window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
window.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) elements.dropOverlay.classList.remove("is-visible");
});
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.classList.remove("is-visible");
  try {
    const files = await collectDroppedFiles(event.dataTransfer);
    if (!files.length) {
      showError("拖入的目录没有可读取的文件", "请选择足迹总目录，或导入其中的 PeakTrailHistory.ndjson。");
      return;
    }
    await importMixed(files);
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  }
});

window.addEventListener("beforeunload", () => {
  homePage.dispose();
  clearTimeout(state.dailyExpiryTimer);
  state.mapPack?.disposeAssets?.();
  viewer?.dispose();
});

async function bootstrapMapFromQuery() {
  const mapPackUrl = new URLSearchParams(window.location.search).get("mapPack");
  if (!mapPackUrl) return;
  setSourceLoading("map", true);
  const requestRevision = ++state.mapRequestRevision;
  try {
    const nextMap = await loadMapPackUrl(mapPackUrl);
    if (requestRevision !== state.mapRequestRevision) {
      nextMap.disposeAssets?.();
      return;
    }
    state.mapPack = nextMap;
    state.mapSourceKind = "query";
    state.dailyMapStatus = null;
    await renderData();
    updateMapUI();
    updateCompatibilityUI();
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  } finally {
    setSourceLoading("map", false);
  }
}

async function bootstrap() {
  showGate();
  updateCompatibilityUI();
  updateRangeFill(elements.heightScale);
  requestAnimationFrame(playbackLoop);
  await bootstrapMapFromQuery();
  await loadDailyStatus();
  setInterval(updateDailyCountdown, 30_000);
  setInterval(loadDailyStatus, 5 * 60_000);
}

window.dispatchEvent(new Event("peaktrail-ready"));
void initializeViewer();
void bootstrap();
