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
import { classifyRouteSegment, resolveReplayRoute, routeSegmentName } from "./map-route.js";
import { worldTelemetryNote } from "./world-timeline.js";
import { createTrailEstimator, liveChaseTarget, LIVE_TRAIL_S } from "./live-follow.js";
import { createWakeLock } from "./wake-lock.js";
import { createFullscreen } from "./fullscreen.js";
import { HomePage } from "./home-page.js";
import { buildHomeDailyView } from "./home-daily.js";
import { defaultLiveRelay } from "./live-endpoint.js";
import { createDailyRefreshClock, createDailySourceReader, dailySourceUrls } from "./daily-refresh.js";
import { bindCameraTouchControls } from "./camera-touch.js";
import { FEATURES, shouldPollLive } from "./features.js";
import { createCommunityMapPanel } from "./community-map-panel.js";
import { createMapLootPanel } from "./map-loot-panel.js";
import { createItemEventPanel } from "./item-event-panel.js";
import { historicalRouteTitle, historicalRouteUrl, loadHistoricalRouteLink, parseHistoricalRouteLink } from "./historical-route-link.js";
import { getLocale, tr, onLocaleChange, biomeName, gameItemName, formatNumber } from "./i18n.js";
import { initLanguageControls } from "./i18n-dom.js";
import { WatchClient, parseWatchId, parseWatchCode, normalizeWatchInput, resolveWatchInput, watchSharePayload, watchCodeFromState } from "./watch-client.js";
import { trimWatchTrace, isWatchMilestone, watchProgressLabel } from "./watch-window.js";
import { watchText } from "./watch-text.js";
import { createWatchChrome } from "./watch-chrome.js";

initLanguageControls();

const $ = (id) => document.getElementById(id);
const elements = {
  appShell: document.querySelector(".app-shell"),
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
  fullscreenButton: $("fullscreenButton"),
  fullscreenHomeExit: $("fullscreenHomeExit"),
  fullscreenMessage: $("fullscreenMessage"),
  screenFeedback: $("screenFeedback"),
  wakeLockRetry: $("wakeLockRetry"),
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
  mapLootMenu: $("mapLootMenu"),
  mapLootFocus: $("mapLootFocus"),
  mapLootFocusName: $("mapLootFocusName"),
  mapLootFocusReturn: $("mapLootFocusReturn"),
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
  phonePanelButton: $("phonePanelButton"),
  topViewButton: $("topViewButton"),
  fitViewButton: $("fitViewButton"),
  freeCameraButton: $("freeCameraButton"),
  cinematicButton: $("cinematicButton"),
  interiorViewButton: $("interiorViewButton"),
  cameraHelp: $("cameraHelp"),
  cameraTouchControls: $("cameraTouchControls"),
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
  dailyCard: $("dailyCard"),
};

const state = {
  workspaceMode: "home",
  mapPack: null,
  historicalRoute: null,
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
  errorPresentation: null,
  daily: null,
  dailyRequestInFlight: null,
  dailyMapStatus: null,
  dailyMapErrorKey: null,
  mapSourceKind: null,
  mapRequestRevision: 0,
  manualMapLoads: 0,
  sourceLoadingCounts: { map: 0, trace: 0 },
  expiredDailyKey: null,
  mapCatalog: null,
  mapCatalogBaseUrl: null,
  gameAssetPack: null,
  gameAssetStatus: "idle",
  gameAssetError: null,
  segmentOptions: [],
  segmentTimeline: [],
  selectedSegment: undefined,
  mapViewIntent: null,
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
  watchJoin: { revision: 0, controller: null, pending: false, error: null, retryAt: 0 },
  watch: { active: false, id: null, client: null, timer: null, trace: null, status: "connecting",
    connection: "connecting", lastRecordAt: null, following: true, dirty: false, records: 0,
    playerKey: "", epoch: null, initializing: false, awaitingRun: false },
};

const gameAssetLoads = new Map();
const homePage = new HomePage({ root: elements.modeGate, loadCatalog: () => ensureMapCatalog(),
  loadMapPack: loadMapPackUrl, onExplore: (map, segment, view, intent) => {
    cancelWatchJoin();
    void openHomeChapter(map, segment, view, intent).catch(error => {
      const detail = describeError(error); showError(detail.title, detail.message);
    });
  },
  onRefresh: () => loadDailyStatus() });

const SEGMENT_NAMES_ZH = new Map([
  ["shore", "海岸"],
  ["roots", "森蕈"],
  ["tropics", "雨林"],
  ["alpine", "雪山"],
  ["mesa", "方山"],
  ["volcano", "火山"],
  ["swamp", "雾沼"],
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
  const route = state.routeView?.route;
  const routed = routeSegmentName(route, option?.segment);
  if (routed) {
    const routeBuild = state.routeView?.source === "recorded"
      ? state.trace?.manifest?.gameBuildId : state.mapPack?.gameBuildId;
    // These source-audited builds share the summit with the final regular layer.
    // The label describes an available area, not a recorded summit arrival.
    return ["25306743", "25739797"].includes(String(routeBuild)) && option?.segment === 4
      && ["volcano-kiln", "swamp-temple"].includes(route?.branch)
      && classifyRouteSegment(route.segments.find((entry) => entry.index === 4)).kind === "chapter"
      ? `${biomeName(option?.segment === 4 ? (route.branch === "swamp-temple" ? "citadel" : "kiln") : option?.biome, routed)} · ${tr("含顶峰", "includes PEAK")}`
      : routed;
  }
  const special = classifyRouteSegment(option);
  if (special.name) return biomeName(special.kind === "nadir" ? "nadir" : special.kind === "summit" ? "peak" : option?.biome, special.name);
  if ([3, 4].includes(option?.segment)) return option.segment === 3 ? tr("第四关（分支未确认）", "Stage 4 (route unconfirmed)") : tr("第五关（分支未确认）", "Stage 5 (route unconfirmed)");
  const source = String(option?.biome || option?.name || "").trim();
  if (["void", "nadir", "peak"].includes(source.toLowerCase())) return option?.name || tr(`分区 ${option?.segment ?? "?"}`, `Area ${option?.segment ?? "?"}`);
  return biomeName(source, SEGMENT_NAMES_ZH.get(source.toLowerCase()) || option?.name || tr(`分区 ${option?.segment ?? "?"}`, `Area ${option?.segment ?? "?"}`));
}

function segmentDisplayName(option) {
  if (!option) return tr("等待关卡", "Waiting for a stage");
  const base = segmentChineseBase(option);
  const matches = state.segmentOptions.filter((candidate) => segmentChineseBase(candidate) === base);
  if (matches.length < 2) return base;
  const index = matches.findIndex((candidate) => candidate.segment === option.segment);
  if (matches.length === 2) return tr(`${base}（${index === 0 ? "下段" : "上段"}）`, `${base} (${index === 0 ? "lower section" : "upper section"})`);
  return tr(`${base}（第 ${index + 1} 段）`, `${base} (section ${formatNumber(index + 1)})`);
}

function collectSegmentOptions() {
  const bySegment = new Map();
  for (const layer of state.usingCompatibleMap ? state.mapPack?.layers || [] : []) {
    const segment = asSegment(layer.segment);
    if (segment === null) continue;
    bySegment.set(segment, {
      segment,
      name: String(layer.name || `Segment ${segment}`),
      biome: String(layer.biome || ""),
      biomeId: layer.biomeId,
      isVoid: classifyRouteSegment(layer).kind === "nadir",
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
      biome: entry.biome, biomeId: entry.biomeId, isVoid: classifyRouteSegment(entry).kind === "nadir",
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
  return state.segmentOptions.filter((option) => !option.isVoid && !state.routeView?.hiddenSegments.has(option.segment));
}

function adjacentSegment(options, selected, direction) {
  const chapters = options.filter((option) => !option.isVoid);
  const ordered = [...chapters, ...options.filter((option) => option.isVoid)];
  const index = ordered.findIndex((option) => option.segment === selected);
  // Overview returns to the mountain. From its final chapter the next control
  // opens Nadir, which remains outside the five-chapter count.
  if (index < 0) return direction < 0 ? chapters.at(-1) || ordered.at(-1) : ordered[0];
  return ordered[index + (direction < 0 ? -1 : 1)];
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
    setSegmentLoadStatus("loading", segment, tr("正在加载 PEAK 真实关卡网格", "Loading PEAK map geometry"));
  } else {
    setSegmentLoadStatus("ready", segment, tr("兼容高度场底图已就绪", "Compatible height map ready"));
  }
}

function selectedSegmentStatus() {
  if (state.selectedSegment !== null && state.routeView?.hiddenSegments.has(state.selectedSegment)) {
    return { status: "muted", text: tr("本关底图与实际分支不符 · 仅显示足迹", "Map route differs from this run · trails only"), message: state.routeView.message };
  }
  if (!state.usingCompatibleMap) {
    return state.mapPack
      ? { status: "muted", text: tr("底图版本不匹配 · 仅回放足迹", "Map build differs · trails only"), message: "" }
      : { status: "muted", text: tr("无同版本底图 · 仅回放足迹", "No map for this build · trails only"), message: "" };
  }

  if (state.selectedSegment !== null) {
    const value = state.segmentMapStatuses.get(segmentStatusKey(state.selectedSegment));
    if (value?.status === "loading") return { status: "loading", text: tr("正在加载本关底图…", "Loading this stage…"), message: value.message };
    if (value?.status === "ready") return { status: "ready", text: tr("本关底图已就绪", "Stage map ready"), message: value.message };
    if (value?.status === "error") return { status: "error", text: tr("本关底图失败 · 足迹仍可回放", "Stage map unavailable · trails remain available"), message: value.message };
    return { status: "muted", text: tr("底图按关加载", "Maps load by stage"), message: "" };
  }

  const statuses = overviewSegmentOptions().map((option) => state.segmentMapStatuses.get(segmentStatusKey(option.segment)));
  const failed = statuses.filter((value) => value?.status === "error").length;
  const loading = statuses.filter((value) => value?.status === "loading").length;
  const ready = statuses.filter((value) => value?.status === "ready").length;
  if (failed) return { status: "error", text: tr(`${failed} 关底图失败 · 足迹仍可回放`, `${formatNumber(failed)} stage maps unavailable · trails remain available`), message: "" };
  if (loading) return { status: "loading", text: tr(`正在加载 ${loading} 关底图…`, `Loading ${formatNumber(loading)} stage maps…`), message: "" };
  if (ready === statuses.length && statuses.length) return { status: "ready", text: tr("所有关底图已就绪", "All stage maps ready"), message: "" };
  return { status: "muted", text: tr("概览会按需加载所有关", "Overview loads stages as needed"), message: "" };
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
  elements.routeSummary.textContent = [state.historicalRoute?.title, state.routeView?.message || tr("关卡分支未确认", "Route unconfirmed")].filter(Boolean).join(" · ");
  elements.segmentOrdinal.textContent = isOverview
    ? tr(`共 ${chapters.length} 关`, `${formatNumber(chapters.length)} stages`)
    : active?.isVoid ? tr("额外区域 · 天底", "Extra area · NADIR") : tr(`第 ${activeIndex + 1} / ${chapters.length} 关`, `Stage ${formatNumber(activeIndex + 1)} / ${formatNumber(chapters.length)}`);
  elements.segmentName.textContent = isOverview ? tr("所有关概览", "All chapters") : segmentDisplayName(active);
  elements.segmentOriginalName.textContent = isOverview
    ? tr("仅在手动选择时加载", "Loads when selected")
    : `${active?.name || tr("未知", "Unknown")} · Segment ${active?.segment ?? "?"}`;

  // 收起状态下换关：短暂展开提示 2.6s 再收起（用户手动展开过则保持）。
  const navName = JSON.stringify([state.mapPack?.mapPackId ?? null, state.selectedSegment ?? "overview"]);
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

  const previous = adjacentSegment(options, state.selectedSegment, -1);
  const next = adjacentSegment(options, state.selectedSegment, 1);
  elements.previousSegmentButton.disabled = !previous;
  elements.nextSegmentButton.disabled = !next;
  elements.previousSegmentButton.title = previous ? tr(`浏览上一区域：${segmentDisplayName(previous)}`, `Previous area: ${segmentDisplayName(previous)}`) : tr("已到第一个区域", "First area reached");
  elements.nextSegmentButton.title = next?.isVoid ? tr("浏览额外区域：天底（并非固定下一关）", "Explore extra area: NADIR")
    : next ? tr(`浏览下一区域：${segmentDisplayName(next)}`, `Next area: ${segmentDisplayName(next)}`) : tr("已到最后一个区域", "Last area reached");
  elements.previousSegmentButton.setAttribute("aria-label", elements.previousSegmentButton.title);
  elements.nextSegmentButton.setAttribute("aria-label", elements.nextSegmentButton.title);
  elements.followSegmentButton.classList.toggle("is-active", state.segmentSelectionMode === "auto");
  elements.followSegmentButton.setAttribute("aria-pressed", String(state.segmentSelectionMode === "auto"));
  elements.segmentOverviewButton.classList.toggle("is-active", isOverview);
  elements.segmentOverviewButton.setAttribute("aria-pressed", String(isOverview));

  const status = selectedSegmentStatus();
  elements.segmentLoadStatus.className = `segment-load-status is-${status.status}`;
  elements.segmentLoadStatus.textContent = status.text;
  elements.segmentLoadStatus.title = getLocale() === "en" && /\p{Script=Han}/u.test(status.message || "")
    ? status.text : status.message || status.text;
  if (state.workspaceMode === "explore") {
    elements.compatibilityText.textContent = status.status === "loading" ? tr("地图加载中…", "Loading map…")
      : status.status === "error" ? tr("地图加载失败", "Map unavailable") : tr("地图浏览", "Map explorer");
  }

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
  allOption.textContent = tr("所有关概览", "All chapters");
  elements.layerSelect.append(allOption);
  let chapterOrdinal = 0;
  state.segmentOptions.forEach((option) => {
    const selectOption = document.createElement("option");
    selectOption.value = String(option.segment);
    const ordinal = option.isVoid ? null : ++chapterOrdinal;
    selectOption.textContent = `${option.isVoid ? tr("额外区域", "Extra area") : tr(`第 ${ordinal} 关`, `Stage ${formatNumber(ordinal)}`)} · ${segmentDisplayName(option)} / ${option.name}`;
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
  const clearedViewIntent = state.mapViewIntent !== null;
  state.mapViewIntent = null;
  state.segmentSelectionMode = mode;
  state.selectedSegment = normalized;
  if (state.historicalRoute && normalized !== null) updateHistoricalRouteUrl(normalized);
  renderSegmentNavigation();
  updateSceneMeta();
  if ((changed || clearedViewIntent) && viewer) {
    viewer.setViewIntent(null);
    if (changed) {
      markSegmentTransition(normalized);
      viewer.setActiveSegment(normalized);
    }
    updateWorldTelemetry();
  }
  syncCommunityContext();
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
  state.mapViewIntent = null;
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
let itemEventPanel, communitySnapshot = null;
const watchChrome = createWatchChrome({
  shell: elements.appShell, menu: $("watchMenu"),
  groups: [
    { slot: $("watchMenuCamera"), controls: [$("followHud"), $("watchCamera")] },
    { slot: $("watchMenuLayers"), controls: [document.querySelector(".viewport-layer-actions"), $("itemEventsToggle")] },
    { slot: $("watchMenuSharing"), controls: [$("watchShare"), $("watchShareLink")] },
    { slot: $("watchMenuSystem"), controls: [document.querySelector(".top-actions > [data-language-toggle]"), $("backToGate")] },
  ],
  onClosePanel: kind => kind === "players" ? toggleWatchPlayers(false) : toggleWatchReplay(false),
});
const communityMapPanel = createCommunityMapPanel({
  getContext: () => ({ enabled: state.workspaceMode === "explore", mapPack: state.mapPack, stageIndex: state.selectedSegment,
    routeGroupId: state.historicalRoute?.group.id || null, inspectionId: state.historicalRoute?.inspectionId || null,
    teamId: state.historicalRoute?.teamId || null }),
  getScene: () => viewer,
  onOpenTeam: openCommunityTeam,
  onSnapshot: snapshot => { communitySnapshot = snapshot; itemEventPanel?.sync(); },
});
const mapLootPanel = createMapLootPanel({
  getContext: () => ({ enabled: state.workspaceMode !== "home" && state.usingCompatibleMap,
    mapPack: state.mapPack, layers: state.routeView?.layers || state.mapPack?.layers, stageIndex: state.selectedSegment }),
  getScene: () => viewer,
});
itemEventPanel = createItemEventPanel({ getScene: () => viewer, getContext: () => {
  if (state.watch.active && state.workspaceMode === "watch") return { enabled: Boolean(state.watch.trace), live: true,
    trace: state.watch.trace, participants: state.watch.trace?.participants, stageIndex: state.selectedSegment,
    gameBuildId: state.watch.trace?.manifest.gameBuildId, timeMs: state.currentTime * 1000,
    fallbackPack: state.gameAssetPack, persistence: state.watch.persistence };
  const snapshot = communitySnapshot;
  return { enabled: state.workspaceMode === "explore" && Boolean(snapshot?.teamId) && !snapshot?.inspectionId,
    ready: ["ready", "empty"].includes(snapshot?.status) && Boolean(snapshot?.teamRevision)
      && snapshot?.stageIndex === state.selectedSegment && snapshot?.mapPackId === state.mapPack?.mapPackId, live: false,
    teamId: snapshot?.teamId, groupId: snapshot?.group?.id, stageIndex: state.selectedSegment,
    teamRevision: snapshot?.teamRevision, alignmentId: snapshot?.group?.mapAlignment?.id,
    mapPackId: state.mapPack?.mapPackId, gameBuildId: state.mapPack?.gameBuildId,
    visiblePlayers: new Set(snapshot?.players.filter(player => player.visible).map(player => player.playerKey) || []),
    fallbackPack: state.gameAssetPack };
} });
function syncCommunityContext(options) { communityMapPanel.sync(options); mapLootPanel.sync(); itemEventPanel?.sync(); }
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
    showError(tr("地图视图未能启动", "Map view could not start"), tr(`请检查网络与浏览器的 WebGL 支持后刷新。${error.message}`, `Check your connection and WebGL support, then refresh. ${error.message}`), 0);
  }
}

function describeError(error) {
  if (error instanceof ProtocolError) {
    return { title: errorUiText(error.message, "Unable to read this map or recording"),
      message: errorUiText(error.detail || tr("请检查所选文件。", "Check the selected files.")) };
  }
  return { title: tr("无法读取文件", "Unable to read files"), message: errorUiText(error?.message || String(error)) };
}

function errorUiText(value, fallback = "Unable to read this map or recording. Check that the files are complete and compatible.") {
  const text = String(value || "");
  return getLocale() === "en" && /\p{Script=Han}/u.test(text) ? fallback : text;
}

function showError(title, message, timeout = 9000) {
  clearTimeout(state.errorTimer);
  state.errorPresentation = { title, message };
  renderErrorUi();
  elements.errorBanner.classList.add("is-visible");
  if (timeout) {
    state.errorTimer = setTimeout(() => elements.errorBanner.classList.remove("is-visible"), timeout);
  }
}

function renderErrorUi() {
  if (!state.errorPresentation) return;
  const { title, message } = state.errorPresentation;
  elements.errorTitle.textContent = errorUiText(title, "Unable to complete this action");
  elements.errorMessage.textContent = errorUiText(message);
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
    ? tr("读取中", "Loading")
    : button.classList.contains("is-loaded")
      ? kind === "map" && ["daily", "archive"].includes(state.mapSourceKind) ? tr("内嵌", "Built in") : tr("已载入", "Loaded")
      : tr("选择", "Choose");
}

async function importMap(files) {
  if (!FEATURES.legacyReplayVisible) return;
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
  if (!FEATURES.legacyReplayVisible) return;
  if (!files || (files instanceof FileBundle ? !files.files.length : !files.length)) {
    showError(tr("所选目录没有可读取的文件", "No readable files in this folder"), tr("请选择 PeakTrailRecordings 总目录，或直接导入其中的 PeakTrailHistory.ndjson。", "Choose the PeakTrailRecordings folder or its PeakTrailHistory.ndjson file."));
    return;
  }
  setSourceLoading("trace", true);
  try {
    const collection = await loadTraceCollection(files);
    disconnectLive(true);
    elements.liveStateRow.hidden = true;
    state.workspaceMode = "replay";
    setSourceMode("replay");
    state.traceCollection = collection;
    state.replayCollection = collection;
    populateTraceArchive();
    const firstSession = collection.days[0]?.sessions[0] || collection.sessions[0];
    await selectTraceSession(firstSession?.manifest.sessionId, false);
    dismissGate();
    if (collection.warnings.length) {
      showError(tr("足迹已载入，请注意数据说明", "Trails loaded · review the data notes"), collection.warnings.join(tr("；", "; ")), 9000);
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
  return defaultLiveRelay(location);
}

function setSourceMode(mode) {
  if (mode === "live" && !FEATURES.liveVisible) mode = "replay";
  const live = mode === "live";
  elements.modeReplay?.classList.toggle("is-active", !live);
  elements.modeLive?.classList.toggle("is-active", live);
  elements.modeReplay?.setAttribute("aria-selected", String(!live));
  elements.modeLive?.setAttribute("aria-selected", String(live));
  elements.replaySource.hidden = live || !FEATURES.legacyReplayVisible;
  elements.liveSource.hidden = !live;
  elements.modeChip.textContent = live ? tr("直播", "Live") : FEATURES.legacyReplayVisible ? tr("回放", "Replay") : tr("地图", "Map");
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
  state.workspaceMode = "home";
  syncWorkspaceState();
  elements.modeGate.hidden = false;
  document.body.classList.add("gate-open");
  document.querySelector('.app-shell').inert = true;
  homePage.setVisible(true);
  if (FEATURES.liveVisible) void refreshGateRuns();
}

function dismissGate() {
  elements.modeGate.hidden = true;
  document.body.classList.remove("gate-open");
  document.querySelector('.app-shell').inert = false;
  homePage.setVisible(false);
}

let gateRuns = [];
async function refreshGateRuns() {
  if (!FEATURES.liveVisible) return;
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
  url.textContent = tr(`中继地址：${diag.base || "(未设置)"}`, `Relay: ${diag.base || "(not set)"}`);
  const status = document.createElement("p");
  status.className = diag.ok === false ? "is-error" : "is-ok";
  status.textContent = diag.ok === false
    ? tr(`连接失败：${diag.error || "未知错误"}`, `Connection failed: ${diag.error || "Unknown error"}`)
    : tr(`连接正常${diag.at ? ` · ${new Date(diag.at).toLocaleTimeString()} 检测` : ""}`, `Connected${diag.at ? ` · checked ${new Date(diag.at).toLocaleTimeString(getLocale())}` : ""}`);
  const tip = document.createElement("p");
  tip.className = "gate-diag-tip";
  tip.textContent = tr("列表为空 = 当前没有对局在推流。进游戏并保持 PEAK Trail 的 Live 开启，约 1 秒内直播卡会自动点亮。", "No runs are streaming. Enable Live in PEAK Trail while playing; a live card should appear within a second.");
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "gate-live-row";
  retry.textContent = tr("重新检测", "Check again");
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
  $("homeLiveCount").textContent = gateRuns.length ? tr(`${gateRuns.length} 场`, `${formatNumber(gateRuns.length)} runs`) : "";
  if (live.code) {
    const connected = gateRuns.find((run) => run.code === live.code);
    elements.gateLiveHint.textContent = tr(`正在观看 ${live.code}${connected?.sceneName ? " · " + connected.sceneName : ""} — 点击返回`, `Watching ${live.code}${connected?.sceneName ? " · " + connected.sceneName : ""} — return`);
  } else if (!gateRuns.length) {
    // 压暗 ≠ 黑箱：一行摘要 + 点击卡片展开诊断（中继可达性/错误/最后检测时间）。
    const diag = state.gateDiag;
    const ago = diag?.at ? Math.max(0, Math.round((Date.now() - diag.at) / 1000)) : null;
    elements.gateLiveHint.textContent = diag?.ok === false
      ? tr("中继不可达 · 点击查看详情", "Relay unavailable · view details")
      : tr(`暂无直播中的对局${ago !== null ? ` · 中继已连接（${ago}s 前检测）` : ""}`, `No live runs${ago !== null ? ` · relay connected (checked ${formatNumber(ago)}s ago)` : ""}`);
  } else if (gateRuns.length === 1) {
    elements.gateLiveHint.textContent = tr(`${gateRuns[0].code} · ${gateRuns[0].sceneName ?? "未知场景"} · 点击进入`, `${gateRuns[0].code} · ${gateRuns[0].sceneName ?? "Unknown scene"} · join`);
  } else {
    elements.gateLiveHint.textContent = tr(`${gateRuns.length} 场对局直播中 · 点击选择`, `${formatNumber(gateRuns.length)} live runs · choose a run`);
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
      run.participants ? tr(`${run.participants} 人`, `${formatNumber(run.participants)} players`) : null,
      run.code === live.code ? tr("观看中", "Watching") : tr("直播中", "Live"),
    ].filter(Boolean).join(" · ");
    row.append(name, meta);
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      enterLive(run.code);
    });
    elements.gateLiveList.append(row);
  }
}

// ============ 全屏与屏幕常亮 ============
const fullscreen = createFullscreen({ onChange: () => syncWakeLock() });
const wakeLock = createWakeLock({ onChange: syncWakeLockChip });
document.addEventListener("visibilitychange", () => wakeLock.handleVisibilityChange());
elements.fullscreenButton.addEventListener("click", () => void fullscreen.toggle());
elements.fullscreenHomeExit.addEventListener("click", () => void fullscreen.toggle());
elements.wakeLockRetry.addEventListener("click", () => wakeLock.retry());
syncWakeLockChip();

/** Fullscreen includes airport waiting; leaving it restores the existing playback policy. */
function syncWakeLock() {
  wakeLock.setDesired(Boolean(fullscreen.active || (state.watch?.active && state.watch.trace && !state.watch.awaitingRun && state.watch.status !== "ended") || state.live?.es || state.live?.demoTimer || state.playing));
  syncWakeLockChip();
}

function syncWakeLockChip() {
  const button = elements.fullscreenButton;
  const active = fullscreen.active;
  button.textContent = active ? tr("退出全屏", "Exit fullscreen") : tr("全屏", "Fullscreen");
  button.setAttribute("aria-label", active ? tr("退出全屏", "Exit fullscreen") : tr("进入全屏", "Enter fullscreen"));
  button.setAttribute("aria-pressed", String(active));
  button.disabled = fullscreen.pending;
  elements.fullscreenHomeExit.textContent = tr("退出全屏", "Exit fullscreen");
  elements.fullscreenHomeExit.setAttribute("aria-label", tr("退出全屏", "Exit fullscreen"));
  elements.fullscreenHomeExit.hidden = !active;
  elements.fullscreenHomeExit.disabled = fullscreen.pending;
  const message = elements.fullscreenMessage;
  message.textContent = fullscreen.error === "unsupported" ? tr("当前浏览器不支持网页全屏", "Page fullscreen is unavailable in this browser")
    : fullscreen.error === "request-denied" ? tr("未能进入全屏，请再次点击重试", "Could not enter fullscreen. Click again to retry.")
    : fullscreen.error === "exit-denied" ? tr("未能退出全屏，请重试或按 Esc", "Could not exit fullscreen. Retry or press Esc.") : "";
  message.hidden = !message.textContent;
  const chip = elements.wakeLockChip;
  chip.hidden = !wakeLock.desired;
  chip.classList.toggle("is-unavailable", wakeLock.desired && !wakeLock.held);
  if (wakeLock.held) {
    chip.textContent = tr("屏幕常亮已开启", "Screen kept awake");
  } else if (wakeLock.desired && !wakeLock.supported()) {
    chip.textContent = window.isSecureContext ? tr("当前浏览器不支持防熄屏", "Keep-awake is unavailable in this browser") : tr("需 HTTPS 才能防熄屏", "HTTPS is required to keep the screen awake");
  } else {
    chip.textContent = wakeLock.status === "pending" ? tr("正在申请屏幕常亮", "Requesting keep-awake")
      : wakeLock.status === "suspended" ? tr("页面在后台，常亮已暂停", "Keep-awake paused while this page is hidden")
      : wakeLock.status === "released" ? tr("系统已暂停常亮，屏幕可能熄灭", "Keep-awake was released; the screen may sleep")
      : tr("未能保持常亮，屏幕可能熄灭", "Keep-awake was denied; the screen may sleep");
  }
  elements.wakeLockRetry.textContent = tr("重试常亮", "Retry keep-awake");
  elements.wakeLockRetry.hidden = !wakeLock.desired || !wakeLock.supported() || !["denied", "released"].includes(wakeLock.status);
  elements.screenFeedback.hidden = message.hidden && (chip.hidden || state.watch?.active && wakeLock.held);
}

function enterLive(code) {
  if (!FEATURES.liveVisible) return;
  const base = state.live.baseUrl || defaultRelayUrl();
  state.workspaceMode = "live";
  syncWorkspaceState();
  dismissGate();
  setSourceMode("live");
  void connectLiveRun(base, code);
}

async function enterModeFromGate(mode) {
  if (mode === "live" && !FEATURES.liveVisible) return;
  if (mode === "replay" && !FEATURES.legacyReplayVisible) return;
  state.workspaceMode = mode;
  syncWorkspaceState();
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
    } else {
      // “我的足迹”是记录优先的入口。即使首页已预载今日地图，空态也不能
      // 被地图占位；地图只在选中一局记录后按该局构建自动匹配。
      ++state.mapRequestRevision;
      const previous = state.mapPack;
      state.mapPack = null;
      state.mapSourceKind = null;
      state.dailyMapStatus = null;
      state.compatibility = assessCompatibility(null, null);
      resetSegmentNavigation(null);
      await renderData();
      if (previous) previous.disposeAssets?.();
      updateMapUI();
      updateTraceUI();
      updateCompatibilityUI(false);
    }
  } catch (error) { const detail = describeError(error); showError(detail.title, detail.message); }
}

async function openHomeChapter(map, segment, presentedView, intent = null) {
  // File import owns navigation until parsing completes. Do not race a directory import.
  if (state.sourceLoadingCounts.trace || state.manualMapLoads) {
    return;
  }
  const current = buildHomeDailyView({ daily: state.daily, catalog: state.mapCatalog, mapPack: map });
  const destination = intent?.destinationId
    ? current.destinations?.find((entry) => entry.id === intent.destinationId) : null;
  const available = current.cards.some((card) => card.segment === segment && card.available)
    || current.cards.some((card) => card.ending?.segment === segment)
    || current.destinations?.some((entry) => entry.segment === segment && entry.available);
  if (!available || current.mapEntry?.mapPackId !== presentedView.mapEntry?.mapPackId) return;
  if (intent?.destinationId && (!destination?.available || destination.segment !== segment
      || (destination.viewIntent || null) !== (intent.viewIntent || null))) return;
  if (state.historicalRoute) { state.historicalRoute = null; clearHistoricalRouteUrl(); updateDailyCountdown(); }
  const revision = ++state.traceSelectionRevision;
  ++state.mapRequestRevision;
  if (state.trace && state.traceCollection === state.replayCollection) state.lastReplaySessionId = state.trace.manifest.sessionId;
  disconnectLive(true);
  elements.liveStateRow.hidden = true;
  state.workspaceMode = "explore";
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
  state.mapViewIntent = destination?.viewIntent || null;
  state.segmentSelectionMode = "manual";
  state.compatibility = assessCompatibility(null, map);
  syncGameAssetsForTrace(null, revision);
  // Clear old-session labels before async geometry loading reveals the viewer.
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
  // Switch map controls before awaiting streamed geometry, so replay panels
  // never flash while entering a map and early layer choices are retained.
  syncWorkspaceState();
  dismissGate();
  // Re-entering the same chapter is a fresh homepage navigation. Its data
  // signature may be cached, but its old panned/free camera is not the default.
  viewer?.resize();
  viewer?.fitView();
  await renderData();
  if (revision !== state.traceSelectionRevision) return;
  if (previous !== map) previous?.disposeAssets?.();
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
}

// Historical shares resolve independently of today's card availability. Every
// map and overlay request is pinned to this group's verified original layout.
async function openHistoricalRoute(destination, revision) {
  const { group, mapPack: map, stageIndex, title, baseTitle, inspectionId, teamId } = destination;
  if (revision !== state.mapRequestRevision) { if (!destination.reusedMapPack && map !== state.mapPack) map.disposeAssets?.(); return; }
  const previous = state.mapPack;
  const preserveView = previous === map && state.workspaceMode === "explore" && !state.trace && state.selectedSegment === stageIndex;
  const selectionRevision = ++state.traceSelectionRevision;
  disconnectLive(true);
  elements.liveStateRow.hidden = true;
  state.workspaceMode = "explore";
  setSourceMode("replay");
  setPlaying(false);
  clearTimeout(state.toastTimer);
  elements.eventToast.classList.remove("is-visible");
  state.trace = null;
  state.traceCollection = state.replayCollection;
  state.currentTime = 0;
  state.lastEventTime = -1;
  state.mapPack = map;
  state.mapSourceKind = "historical-route";
  state.historicalRoute = { group, title, baseTitle, inspectionId, teamId: teamId || null };
  updateDailyCountdown();
  state.dailyMapStatus = null;
  if (!preserveView) resetSegmentNavigation(null);
  state.selectedSegment = stageIndex;
  state.segmentSelectionMode = "manual";
  state.compatibility = assessCompatibility(null, map);
  syncGameAssetsForTrace(null, selectionRevision);
  updateTraceUI(); updateMapUI(); updateCompatibilityUI(false);
  syncWorkspaceState(); dismissGate();
  viewer?.resize();
  if (!preserveView) viewer?.fitView();
  await renderData();
  if (previous !== map && previous !== state.mapPack) previous?.disposeAssets?.();
  if (selectionRevision !== state.traceSelectionRevision || revision !== state.mapRequestRevision || state.mapPack !== map) return;
  updateHistoricalRouteUrl(stageIndex);
  await communityMapPanel.openHistorical();
}

function updateHistoricalRouteUrl(stageIndex) {
  if (!state.historicalRoute) return;
  window.history.replaceState(null, "", historicalRouteUrl(window.location.href, state.historicalRoute.group.id, stageIndex,
    state.historicalRoute.inspectionId || null, state.historicalRoute.teamId || null));
}

function clearHistoricalRouteUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("routeGroup"); url.searchParams.delete("stage");
  url.searchParams.delete("inspection");
  url.searchParams.delete("team");
  window.history.replaceState(null, "", url.href);
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
  if (!FEATURES.liveVisible) return;
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
    days: [{ date: tr("直播", "Live"), sessions: [trace] }],
    warnings: trace.warnings,
  };
  // 预铺 40 秒历史：一进门就有轨迹可看，不用干等。
  for (let t = 0; t <= 40_000; t += 200) demoEmit(trace, t);
  setLiveStatus(tr("调试模式 · 演示数据（未连接中继）", "Debug mode · demo data (no relay connection)"));
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
  if (!FEATURES.liveVisible) return;
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
      empty.textContent = tr(`中继不可达（${String(error?.message || error)}）`, `Relay unavailable (${String(error?.message || error)})`);
      elements.liveRunList.append(empty);
    }
  }
}

function renderLiveRuns(base, runs) {
  elements.liveRunList.replaceChildren();
  if (!runs.length) {
    const empty = document.createElement("p");
    empty.className = "live-run-empty";
    empty.textContent = tr("暂无活跃对局 · 游戏内开启 Live 后自动出现", "No active runs · enable Live in game to appear here");
    elements.liveRunList.append(empty);
    return;
  }
  for (const run of runs) {
    const connected = run.code === state.live.code;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `live-run-card${connected ? " is-connected" : ""}`;
    const title = document.createElement("strong");
    title.textContent = `${run.code} · ${run.sceneName ?? tr("未知场景", "Unknown scene")}`;
    const meta = document.createElement("small");
    meta.textContent = [
      tr(`${run.producers} 源 · ${run.records} 条`, `${formatNumber(run.producers)} sources · ${formatNumber(run.records)} records`),
      run.participants ? tr(`${run.participants} 人`, `${formatNumber(run.participants)} players`) : null,
      connected ? tr("正在观看", "Watching") : run.alive === false ? tr("宽限中", "Grace period") : tr("直播中", "Live"),
    ].filter(Boolean).join(" · ");
    card.append(title, meta);
    card.addEventListener("click", () => {
      if (!connected) void connectLiveRun(base, run.code);
    });
    elements.liveRunList.append(card);
  }
}

async function connectLiveRun(base, code) {
  if (!FEATURES.liveVisible) return;
  disconnectLive(true);
  state.live.baseUrl = base;
  state.live.code = code;
  state.live.trace = null;
  state.live.lastParticipants = 0;
  setLiveStatus(tr(`连接 run ${code}…`, `Connecting to run ${code}…`));
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
  if (!FEATURES.liveVisible) return;
  const es = new EventSource(`${base}/api/runs/${code}/stream`);
  state.live.es = es;
  syncWakeLock();
  state.live.lastSseAt = Date.now();
  // Reconnections resume from Last-Event-ID (the relay replays only the missed
  // records), so the growing trace is kept as-is and appends simply continue.
  es.onopen = () => {
    if (state.live.es !== es) return;
    state.live.lastSseAt = Date.now();
    if (state.live.trace) setLiveStatus(tr(`直播中 · ${code}（已续传）`, `Live · ${code} (resumed)`));
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
      setLiveStatus(tr(`直播中 · ${code}（已续传）`, `Live · ${code} (resumed)`));
      return;
    }
    const trace = createLiveTrace(hello.manifest, { code, runId: hello.runId });
    state.live.trace = trace;
    state.live.lastSeq = 0;
    state.traceCollection = {
      sessions: [trace],
      days: [{ date: tr("直播", "Live"), sessions: [trace] }],
      warnings: trace.warnings,
    };
    setLiveStatus(tr(`直播中 · ${code}`, `Live · ${code}`));
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
        setLiveStatus(tr("直播已结束或中继不可达", "Run ended or relay unavailable"));
        disconnectLive(false);
        return;
      }
      setLiveStatus(tr(`连接中断，重连中…（${state.live.reconnectAttempts}）`, `Disconnected · reconnecting… (${formatNumber(state.live.reconnectAttempts)})`));
      const live = state.live;
      setTimeout(() => {
        if (state.live.es === es && live.code) openLiveStream(live.baseUrl, live.code);
      }, 2000);
    } else {
      setLiveStatus(tr("连接中断，自动重连…", "Disconnected · reconnecting…"));
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
    setLiveStatus(tr("直播已结束或中继不可达", "Run ended or relay unavailable"));
    disconnectLive(false);
    return;
  }
  setLiveStatus(tr(`连接中断，重连中…（${live.reconnectAttempts}）`, `Disconnected · reconnecting… (${formatNumber(live.reconnectAttempts)})`));
  live.es.close();
  openLiveStream(live.baseUrl, live.code);
}

async function attachLiveTrace(trace) {
  const selectionRevision = ++state.traceSelectionRevision;
  state.workspaceMode = "live";
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
  elements.sampleCount.textContent = trace.sampleCount.toLocaleString(getLocale());
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
    setLiveStatus(tr("已断开", "Disconnected"));
    void refreshLiveRuns();
  }
}

// V2 observation is a separate link-only workspace. The legacy public-run gate
// remains off and this path never requests the retired /api/runs endpoints.
function stopWatch() {
  const watch = state.watch;
  if (watch.active) setPlaying(false);
  watch.client?.stop();
  clearInterval(watch.timer);
  watch.client = null;
  watch.timer = null;
  watch.active = false;
  watch.trace = null;
  watch.awaitingRun = false;
  watch.code = null;
  watch.copiedUntil = 0;
  watchChrome.reset();
  ++state.traceSelectionRevision;
  elements.appShell.classList.remove("watch-players-open");
  elements.appShell.classList.remove("watch-loading");
  elements.appShell.classList.remove("watch-empty");
  for (const id of ["watchStatus", "watchShare", "watchShareLink", "watchCamera", "watchTimebar", "watchNotice", "watchMenu"]) $(id).hidden = true;
  elements.timeline.min = "0";
  syncWakeLock();
}

function updateWatchStatus() {
  const watch = state.watch;
  if (!watch.active) return;
  updateWatchShareUI();
  const empty = !watch.trace;
  elements.appShell?.classList.toggle("watch-empty", empty);
  $("watchCamera").hidden = empty;
  $("watchTimebar").hidden = empty;
  $("watchMenuLayers").hidden = empty;
  $("watchReplay").disabled = empty;
  $("watchPlayers").disabled = empty;
  const labels = { waiting: watchText("等待主播入图"), live: watchText("直播中"), reconnecting: watchText("主播重连中"),
    ended: watch.awaitingRun ? watchText("等待已结束") : watchText("直播已结束") };
  const text = watch.connection === "error" ? watchText("无法打开直播")
    : watch.status === "ended" ? labels.ended
    : watch.connection === "reconnecting" ? watchText("观看连接重连中")
    : watch.connection === "connecting" ? watchText("正在连接直播")
    : watch.trace && !watch.following ? tr("回看中", "Replaying") : labels[watch.status] || watchText("等待游戏数据");
  $("watchStatusText").textContent = [text, watchProgressLabel(watch.trace)].filter(Boolean).join(" · ");
  $("watchStatus").dataset.status = watch.status === "ended" ? "ended" : watch.connection === "error" ? "error" : watch.status;
  const age = Number.isFinite(watch.lastRecordAt) ? Math.max(0, Math.floor((Date.now() - watch.lastRecordAt) / 1000)) : null;
  $("watchFreshness").textContent = watch.awaitingRun
    ? watch.status === "ended" ? watchText("本次尚未开始攀登") : watchText("机场准备中 · 入图后自动显示")
    : `${state.trace?.manifest?.sceneName || watch.sceneName || watchText("等待地图")} · ${age === null ? watchText("等待游戏数据") : age === 0 ? watchText("刚刚更新") : tr(`${age} 秒前更新`, `Updated ${age}s ago`)}`;
  const notice = watch.initializing || !watch.trace || !watch.trace.sampleCount || watch.connection === "error";
  $("watchNotice").hidden = !notice;
  $("watchNoticeText").textContent = watchText(watch.message) || (watch.initializing ? watchText("正在匹配本局地图…")
    : watch.awaitingRun ? watch.status === "ended" ? watchText("等待已结束，本次尚未开始攀登") : watchText("主播已在机场，等待进入关卡。入图后会自动开始观战。")
    : watch.status === "ended" ? watchText("直播已结束，本次没有可显示的路径")
    : watch.trace ? watchText("已连接，等待玩家位置…") : watchText("正在连接直播…"));
  $("watchRetry").hidden = !["error", "reconnecting"].includes(watch.connection);
  const behind = Math.max(0, (watch.trace?.duration || 0) - state.currentTime);
  $("watchTimeStatus").textContent = empty ? "" : watch.status === "ended"
    ? watchText("直播已结束 · 可回看保留的路径")
    : watch.following ? watchText("实时 · 最近 2 分钟可回看") : tr(`正在回看 · 落后 ${Math.round(behind)} 秒`, `Replaying · ${Math.round(behind)}s behind`);
  if (!empty && watch.persistence === "durable") $("watchTimeStatus").textContent += watchText(" · 轨迹自动保存");
  $("watchGoLive").textContent = watch.status === "ended" ? watchText("回到最后") : watchText("回到实时");
  $("watchGoLive").disabled = !watch.trace || (watch.following && watch.status !== "ended");
  const running = !empty && (state.playing || watch.following && watch.status !== "ended");
  elements.playButton.classList.toggle("is-playing", running);
  elements.playButton.setAttribute("aria-label", running ? watchText("暂停观看") : watchText("播放回看"));
}

async function applyEmptyWatchSnapshot(snapshot) {
  const watch = state.watch;
  if (!watch.active) return;
  ++state.traceSelectionRevision;
  ++state.mapRequestRevision;
  Object.assign(watch, { trace: null, epoch: 0, awaitingRun: true, status: snapshot.status,
    initializing: false, dirty: false, playerKey: "", lastRecordAt: null, sceneName: null });
  state.trace = null;
  state.traceCollection = null;
  state.currentTime = 0;
  state.lastRenderSignature = null;
  setPlaying(false);
  viewer?.setFollowTarget(null);
  elements.appShell.classList.add("watch-loading");
  elements.appShell.classList.remove("watch-players-open");
  elements.appShell.classList.remove("watch-replay-open");
  $("watchPlayers").setAttribute("aria-expanded", "false");
  $("watchReplay").setAttribute("aria-expanded", "false");
  updateWatchStatus();
  syncWakeLock();
  await renderData();
}

async function applyWatchSnapshot(snapshot, trace) {
  const watch = state.watch;
  if (!watch.active) return;
  const revision = ++state.traceSelectionRevision;
  finalizeLiveFlush(trace);
  trimWatchTrace(trace);
  finalizeLiveFlush(trace);
  trace.warnings = [watchText("观战页面可回看最近约 2 分钟的路径；玩家身份只在本次会话内有效。")];
  watch.trace = trace;
  watch.awaitingRun = false;
  watch.epoch = snapshot.epoch;
  watch.initializing = true;
  elements.appShell.classList.add("watch-loading");
  watch.dirty = true;
  watch.playerKey = "";
  state.trace = trace;
  state.compatibility = null;
  state.usingCompatibleMap = false;
  state.lastRenderSignature = null;
  state.traceCollection = { sessions: [trace], days: [], warnings: trace.warnings };
  state.workspaceMode = "watch";
  resetSegmentNavigation(trace);
  viewer?.setFollowTarget(null);
  state.currentTime = Math.max(trace.windowStart || 0, trace.duration - (watch.status === "ended" ? 0 : LIVE_TRAIL_S));
  setPlaying(false);
  syncGameAssetsForTrace(trace, revision);
  try { await syncMapForTrace(trace); }
  catch {
    if (revision !== state.traceSelectionRevision || state.trace !== trace) return;
    await clearAutomaticMap();
  }
  if (revision !== state.traceSelectionRevision || !watch.active || state.trace !== trace) return;
  state.compatibility = assessCompatibility(trace.manifest, state.mapPack);
  await renderData();
  if (revision !== state.traceSelectionRevision || !watch.active || state.trace !== trace) return;
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(false);
  state.currentTime = Math.max(trace.windowStart || 0, trace.duration - (watch.status === "ended" ? 0 : LIVE_TRAIL_S));
  watch.initializing = false;
  elements.appShell.classList.remove("watch-loading");
  flushWatch();
  updatePlaybackTime(state.currentTime, false);
}

function flushWatch() {
  const watch = state.watch, trace = watch.trace;
  if (!watch.active || !trace || watch.initializing || state.trace !== trace) return;
  if (watch.dirty) {
    watch.dirty = false;
    finalizeLiveFlush(trace);
    trimWatchTrace(trace);
    finalizeLiveFlush(trace);
    state.segmentTimeline = buildSegmentTimeline(trace);
    // Keep the user's selected camera/chapter while updating the growing data.
    viewer?.refreshTracks();
    const playerKey = trace.participants.filter(p => trace.tracks.get(p.id)?.length).map(p => `${p.id}:${p.nickname}`).join("|");
    if (playerKey !== watch.playerKey) { watch.playerKey = playerKey; updatePlayers(); }
    const scroll = elements.eventList.scrollTop;
    updateEvents();
    elements.eventList.scrollTop = scroll;
    elements.timeline.min = String(trace.windowStart || 0);
    elements.timeline.max = String(trace.duration);
    elements.totalTime.textContent = formatTime(trace.duration);
    elements.sampleCount.textContent = formatNumber(trace.sampleCount);
    if (state.currentTime < (trace.windowStart || 0)) updatePlaybackTime(trace.windowStart, false);
    syncSegmentToPlayback();
    updatePlayerTelemetry();
  }
  itemEventPanel?.sync();
  updateWatchStatus();
}

async function startWatch(id, { replaceUrl = true, watchCode = null } = {}) {
  if (!parseWatchId(id)) return;
  cancelWatchJoin();
  stopWatch();
  disconnectLive(true);
  const watch = state.watch;
  Object.assign(watch, { active: true, id, trace: null, status: "connecting", connection: "connecting",
    lastRecordAt: null, following: true, dirty: false, records: 0, playerKey: "", epoch: null,
    initializing: false, awaitingRun: false, message: "", sceneName: null, persistence: null, code: parseWatchCode(watchCode), copiedUntil: 0, copiedKind: null });
  state.trace = null;
  state.historicalRoute = null;
  state.traceCollection = null;
  state.compatibility = null;
  state.usingCompatibleMap = false;
  state.mapSourceKind = state.mapPack ? "archive" : null;
  state.workspaceMode = "watch";
  elements.appShell.classList.add("watch-loading");
  setPlaying(false);
  state.lastRenderSignature = null;
  resetSegmentNavigation(null);
  viewer?.setFollowTarget(null);
  syncWorkspaceState();
  dismissGate();
  void renderData();
  elements.modeChip.textContent = watchText("观战");
  for (const key of ["watchStatus", "watchShare", "watchCamera", "watchTimebar"]) $(key).hidden = false;
  if (replaceUrl) {
    const url = new URL(location.href);
    url.search = new URLSearchParams({ watch: id }).toString();
    url.hash = "";
    history.replaceState(null, "", url);
  }
  updateWatchStatus();
  const client = new WatchClient({
    watchId: id,
    onSnapshot: data => {
      if (!watch.active || state.watch.client !== client) return;
      // Parsing is synchronous before the first await: malformed snapshots throw
      // into the controller's recovery path instead of accepting a bad cursor.
      let promise;
      if (data.epoch === 0) promise = applyEmptyWatchSnapshot(data);
      else {
        const trace = createLiveTrace({ ...data.manifest, sessionId: data.sessionId }, {
          code: data.watchId, sessionId: `${data.sessionId}:${data.epoch}`,
        });
        for (const entry of data.snapshot.records) appendLiveRecord(trace, entry.record);
        promise = applyWatchSnapshot(data, trace);
      }
      promise.catch(error => {
        if (state.watch.client !== client) return;
        watch.message = tr(`直播数据无法显示：${error.message}`, `Unable to display live data: ${error.message}`);
        watch.connection = "error";
        updateWatchStatus();
      });
    },
    onRecord: data => {
      if (!watch.active || state.watch.client !== client || !watch.trace) return;
      if (appendLiveRecord(watch.trace, data.record)) {
        watch.dirty = true;
        watch.lastRecordAt = Date.now();
        if (data.record.type === "sample") state.live.trail?.observe(performance.now());
      }
    },
    onState: data => {
      if (!watch.active || state.watch.client !== client) return;
      if (data.status) watch.status = data.status;
      if (data.epoch === 0 && data.manifest === null) watch.awaitingRun = true;
      if (data.persistence) watch.persistence = data.persistence;
      watch.code = watchCodeFromState(watch.code, data);
      if (data.manifest?.sceneName) watch.sceneName = data.manifest.sceneName;
      const time = typeof data.lastRecordAt === "number" ? data.lastRecordAt : Date.parse(data.lastRecordAt);
      if (Number.isFinite(time)) watch.lastRecordAt = time;
      if (data.status === "ended") {
        watch.code = null;
        watch.copiedUntil = 0;
        watch.message = "";
        if (watch.trace && !watch.initializing && watch.following) updatePlaybackTime(watch.trace.duration, false);
      }
      updateWatchStatus();
      syncWakeLock();
    },
    onConnection: (connection, message) => {
      if (!watch.active || state.watch.client !== client) return;
      watch.connection = connection;
      watch.message = message || "";
      updateWatchStatus();
      syncWakeLock();
    },
  });
  watch.client = client;
  state.live.trail = createTrailEstimator();
  watch.timer = setInterval(flushWatch, 1000);
  syncWakeLock();
  await client.start();
}

function formatSessionLabel(trace) {
  const started = new Date(trace.manifest.startedAtUtc);
  const time = Number.isFinite(started.getTime())
    ? started.toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" })
    : tr("时间未知", "Unknown time");
  const players = trace.participants.filter((participant) => trace.tracks.has(participant.id)).length;
  const isPartial = trace.manifest.status === "recording"
    || String(trace.manifestFileName || "").toLowerCase().includes("partial");
  const lifecycle = isPartial
    ? tr("未完整结束", "Incomplete session")
    : trace.manifest.endReason
      ? tr(`结束 ${trace.manifest.endReason}`, `Ended: ${trace.manifest.endReason}`)
      : trace.manifest.status && trace.manifest.status !== "complete"
        ? trace.manifest.status
        : null;
  return [
    time,
    trace.manifest.sceneName,
    tr(`${players} 人`, `${formatNumber(players)} players`),
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
    option.textContent = tr(`${day.date} · ${day.sessions.length} 局`, `${day.date} · ${formatNumber(day.sessions.length)} runs`);
    elements.dateSelect.append(option);
  }
  elements.dateSelect.disabled = !collection?.days.length;
  const hasPrevious = collection?.days.some((day) => day.date === previousDate);
  elements.dateSelect.value = hasPrevious ? previousDate : collection?.days[0]?.date || "";
  populateSessionSelect();
  const sessionCount = collection?.sessions.length || 0;
  const dayCount = collection?.days.length || 0;
  elements.archiveSummary.textContent = sessionCount
    ? tr(`${dayCount} 天 · ${sessionCount} 局 · 本地解析`, `${formatNumber(dayCount)} days · ${formatNumber(sessionCount)} runs · parsed locally`)
    : tr("等待导入足迹目录", "Choose a recordings folder");
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
  if (!FEATURES.legacyReplayVisible) return;
  const trace = state.traceCollection?.sessions.find(
    (candidate) => candidate.manifest.sessionId === sessionId,
  );
  if (!trace) return;
  state.workspaceMode = "replay";
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
      title: tr(`${trace.manifest.sceneName} 内嵌地图未载入`, `${trace.manifest.sceneName} published map was not loaded`),
      detail: detail.message,
    };
    showError(detail.title, tr(`${detail.message}。该局仍可在无底图模式回放。`, `${detail.message}. This run can still replay without a map.`), 9000);
  }
  if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
  state.compatibility = assessCompatibility(trace.manifest, state.mapPack);
  await renderData();
  updateTraceUI();
  updateMapUI();
  updateCompatibilityUI(showMismatch);
}

async function importMixed(files) {
  if (!FEATURES.legacyReplayVisible) return;
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
    showError(tr("未识别这些文件", "Files not recognized"), tr("请选择地图包，或 manifest.json 与 stream.ndjson。", "Choose a map pack, or manifest.json with stream.ndjson."), 7000);
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
  // A reserved watch room has no game world yet. Keep any cached map metadata
  // for later matching, but never mount it as this room's map or fetch geometry.
  if (state.workspaceMode === "watch" && !state.trace) {
    state.usingCompatibleMap = false;
    state.routeView = resolveReplayRoute(null, null);
    state.segmentOptions = [];
    elements.segmentNavigator.hidden = true;
    if (viewer && state.lastRenderSignature !== "watch-empty") {
      await viewer.setData({ mapPack: null, trace: null, useMap: false, activeSegment: null });
      state.lastRenderSignature = "watch-empty";
    }
    updateEmptyState();
    syncCommunityContext();
    return;
  }
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
      state.mapViewIntent,
    ].join("|");
    if (signature !== state.lastRenderSignature) {
      if (useMap) markSegmentTransition(activeSegment);
      const displayMap = state.mapPack ? { ...state.mapPack, layers: state.routeView.layers } : null;
      await viewer.setData({ mapPack: displayMap, trace: state.trace, useMap, activeSegment,
        viewIntent: state.mapViewIntent });
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
  syncCommunityContext({ restore: true });
}

function updateEmptyState() {
  syncWorkspaceState();
  elements.emptyState.classList.toggle("is-hidden", state.workspaceMode !== "replay" || Boolean(state.trace));
}

function syncWorkspaceState() {
  const shell = elements.appShell;
  if (!shell) return;
  const replayEmpty = state.workspaceMode === "replay" && !state.trace;
  shell.classList.toggle("is-empty-replay", replayEmpty);
  shell.classList.toggle("has-trace", Boolean(state.trace));
  shell.dataset.workspaceMode = state.workspaceMode;
  watchChrome.setActive(state.workspaceMode === "watch");
  shell.dataset.replayState = replayEmpty ? "empty" : state.trace ? "ready" : "explore";
  if (state.workspaceMode === "explore") elements.modeChip.textContent = state.historicalRoute
    ? state.historicalRoute.inspectionId ? tr("验收预览", "Review preview") : state.historicalRoute.teamId ? tr("团队路线", "Team route") : tr("历史路线", "Historical route") : tr("地图", "Map");
  else if (state.workspaceMode === "watch") elements.modeChip.textContent = tr("观战", "Watch");
  else elements.modeChip.textContent = state.workspaceMode === "live" ? tr("直播", "Live")
    : FEATURES.legacyReplayVisible ? tr("回放", "Replay") : tr("地图", "Map");
  syncCommunityContext();
}

function updateMapUI() {
  const pack = state.mapPack;
  const automatic = ["daily", "archive", "historical-route"].includes(state.mapSourceKind);
  elements.mapSourceButton.classList.toggle("is-loaded", Boolean(pack));
  elements.mapSourceName.textContent = pack
    ? pack.sceneName
    : errorUiText(state.dailyMapStatus?.title, "Map temporarily unavailable") || tr("尚未导入地图", "No map loaded");
  elements.mapSourceMeta.textContent = pack
    ? tr(`${automatic ? "Pages 内嵌 · " : "开发导入 · "}${pack.mapPackId} · ${pack.layers.length} 层 · build ${pack.gameBuildId || "未知"}`, `${automatic ? "Published · " : "Development import · "}${pack.mapPackId} · ${formatNumber(pack.layers.length)} layers · build ${pack.gameBuildId || "Unknown"}`)
    : errorUiText(state.dailyMapStatus?.detail, "Checking the published map catalog. Your current map remains available.") || tr("按所选局次从 Pages catalog 自动匹配", "Matches this run against the published map catalog");
  elements.mapSourceState.textContent = pack ? (automatic ? tr("内嵌", "Built in") : tr("开发", "Development")) : tr("自动", "Automatic");
  updateSceneMeta();
}

function updateTraceSourceLabels() {
  const trace = state.trace;
  const sessionCount = state.traceCollection?.sessions.length || (trace ? 1 : 0);
  const dayCount = state.traceCollection?.days.length || (trace ? 1 : 0);
  elements.traceSourceButton.classList.toggle("is-loaded", Boolean(trace));
  elements.traceSourceName.textContent = trace ? tr(`${dayCount} 天 · ${sessionCount} 局足迹`, `${formatNumber(dayCount)} days · ${formatNumber(sessionCount)} recordings`) : tr("尚未导入足迹", "No trails loaded");
  elements.traceSourceMeta.textContent = trace
    ? tr(`当前 ${trace.manifest.sceneName} · ${trace.sampleCount.toLocaleString(getLocale())} 个采样`, `${trace.manifest.sceneName} · ${formatNumber(trace.sampleCount)} samples`)
    : tr("选择足迹总目录（可含多天、多局）", "Choose a recordings folder with one or more days and runs");
  elements.traceSourceState.textContent = trace ? tr("已载入", "Loaded") : tr("选择", "Choose");
}

function updateTraceUI() {
  const trace = state.trace;
  updateTraceSourceLabels();
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
  elements.compatibilityText.textContent = state.workspaceMode === "explore" && state.mapPack
    ? tr("地图浏览", "Map explorer") : errorUiText(result.message, result.compatible ? "Map and recording match" : state.trace ? "Trails available without a matching map" : "Choose a recording");
  if (showMismatchDetail && result.status === "error" && result.reasons.length) {
    showError(tr("地图与足迹不匹配", "Map and recording differ"), tr(`${result.reasons.join("；")}。轨迹仍可在无底图模式回放。`, `${result.reasons.join("; ")}. Trails remain available without a map.`), 12000);
  }
}

function updateSceneMeta() {
  const scene = state.trace?.manifest.sceneName || state.mapPack?.sceneName || "—";
  elements.sceneName.textContent = scene;
  elements.sampleCount.textContent = state.trace ? state.trace.sampleCount.toLocaleString(getLocale()) : "0";

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
  if (!playerId) return tr("全局事件", "Global event");
  return state.trace?.participants.find((participant) => participant.id === playerId)?.nickname || playerId;
}

function eventSegmentLabel(event) {
  if (event.segment !== null) return tr(`所属分层 ${event.segment}`, `Recorded stage ${event.segment}`);
  if (event.activeSegment !== null) return tr(`全局活动分区 ${event.activeSegment}`, `Active world area ${event.activeSegment}`);
  return null;
}

function eventItemLabel(event) {
  if (!event.item) return null;
  const name = gameItemName(event.item.name || event.item.id);
  return tr(`物品 ${name}`, `Item ${name}`);
}

function eventTitle(event) {
  const chinese = event.label || eventPresentation(event.type).label;
  const english = {
    mine_explosion: "Mine explosion", mine_exploded: "Mine explosion", zombie_activated: "Zombie activated", zombie_woke: "Zombie woke",
    world_spawn: "World object appeared", world_despawn: "World object disappeared", fog_activated: "Drowsy fog activated",
    fog_enabled: "Drowsy fog appeared", fog_disabled: "Drowsy fog cleared", zombie_state: "Zombie state changed",
    join: "Joined the climb", leave: "Left the climb", passed_out: "Passed out", recovered: "Regained consciousness",
    death: "Death", revive: "Revived", warp: "Warped", segment_change: "Entered a new area", run_end: "Climb ended",
    summit: "Summit reached", checkpoint: "Chapter completed", native_checkpoint: "Chapter completed", nadir_ready: "Nadir items ready", nadir_entry: "Entered Nadir",
    nadir_wall: "Nadir barrier changed", nadir_chase: "Nadir chase changed", nadir: "Nadir completed",
    item_pickup: "Picked up item", item_drop: "Dropped item", item_use: "Used item", item_acquired: "Acquired item",
    item_lost: "Lost item", item_moved: "Moved item", item_state_changed: "Item state changed", item_consumed: "Consumed item",
    item_thrown: "Threw item", item_equipped: "Equipped item", item_unequipped: "Stowed item", equip: "Equipped item",
    unequip: "Stowed item", stamina_empty: "Out of stamina", event: "Event",
  }[event.type] || String(event.type || "Event").replaceAll("_", " ");
  return tr(chinese, english);
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
    empty.textContent = tr("导入足迹后，可单独显示或隐藏玩家。", "Import a recording to show or hide individual players.");
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
  elements.worldTelemetryNote.textContent = state.trace ? worldTelemetryNote(state.trace.worldTimeline, state.currentTime) : tr("等待导入世界记录", "Waiting for world telemetry");
  const world = viewer?.worldRenderer;
  const fog = world?.fogState;
  const showFogNote = Boolean(fog?.count && fog.mode !== "map-baseline");
  elements.mapFogNote.hidden = !showFogNote;
  elements.mapFogNote.textContent = showFogNote ? tr("本局实录雾 · 随时间线回放", "Recorded fog · follows the replay timeline") : "";
  elements.mapFogNote.title = showFogNote ? fog.note || "" : "";
  const objects = world?.objects || [];
  elements.worldSummary.textContent = [state.trace?.worldTimeline?.captured ? tr(`此刻记录 ${objects.length} 个世界对象 · 采样状态，不预测中间运动`, `${formatNumber(objects.length)} recorded world objects · sampled state`) : "", showFogNote ? fog.note : ""].filter(Boolean).join("\n");
  const alerts = (world?.alerts || []).sort((a, b) => a.distance - b.distance).slice(0, 8);
  const key = JSON.stringify([getLocale(), alerts.map((alert) => [alert.object.objectId, Math.round(alert.distance), alert.active])]);
  if (elements.worldAlerts.dataset.key === key) return;
  elements.worldAlerts.dataset.key = key;
  elements.worldAlerts.replaceChildren();
  for (const alert of alerts) {
    const row = document.createElement("p");
    row.className = alert.active ? "world-alert is-danger" : "world-alert";
    row.textContent = tr(`${alert.object.kind.includes("zombie") ? "蘑菇僵尸" : "危险物"} · ${Math.round(alert.distance)}m · ${alert.active ? "已激活" : "接近预警"}`, `${alert.object.kind.includes("zombie") ? "Mushroom zombie" : "Hazard"} · ${formatNumber(Math.round(alert.distance))}m · ${alert.active ? "Active" : "Proximity alert"}`);
    row.title = tr(`记录状态：${alert.object.activity}；提示距离 ${alert.range}m（游戏激活还可能依赖朝向、视线等条件）`, `Recorded state: ${alert.object.activity}; alert range ${formatNumber(alert.range)}m (activation may also depend on facing and visibility)`);
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
  if (state.watch?.active && event.t < (state.trace?.windowStart || 0)) {
    button.disabled = true;
    button.title = tr("关键节点已保留，位置已超出近期回看窗口", "Milestone retained; its position is outside the recent replay window");
  }
  button.addEventListener("click", () => {
    if (state.watch?.active) { state.watch.following = false; toggleWatchReplay(true); }
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
  title.textContent = eventTitle(event);
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
  const events = (state.trace?.events || []).filter(event => !state.watch?.active || (event.t >= (state.trace.windowStart || 0) || isWatchMilestone(event)));
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
  const events = (state.trace?.events || []).filter(event => !state.watch?.active || (event.t >= (state.trace.windowStart || 0) || isWatchMilestone(event)));
  elements.eventCount.textContent = formatNumber(events.length);
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "inline-empty";
    empty.textContent = tr("死亡、复活、传送和分区变化会显示在这里。", "Deaths, revives, warps and stage changes appear here.");
    elements.eventList.append(empty);
    return;
  }

  // Absolutely positioned rows cannot grow the scroller by themselves; this
  // spacer carries the full session height so the scrollbar stays truthful.
  const spacer = document.createElement("div");
  spacer.className = "event-list-spacer";
  spacer.style.height = `${events.length * EVENT_ROW_STRIDE}px`;
  elements.eventList.append(spacer);

  const windowStart = state.watch?.active ? state.trace.windowStart || 0 : 0;
  const duration = Math.max(0.001, state.trace.duration - windowStart);
  const markerFragment = document.createDocumentFragment();
  // Overlapping ticks at this width are indistinguishable, and a long session can
  // carry thousands of events. Bucketing keeps the timeline strip at a few hundred
  // nodes instead of tens of thousands, whose layout cost dominated every frame.
  const markers = new Map();
  for (const event of events) {
    if (event.t < windowStart) continue;
    const percent = Math.min(100, Math.max(0, ((event.t - windowStart) / duration) * 100));
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
  elements.eventToastTitle.textContent = eventTitle(event);
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
  const windowStart = state.watch?.active ? state.trace?.windowStart || 0 : 0;
  state.currentTime = Math.min(duration, Math.max(windowStart, Number(nextTime) || 0));
  const eligibleMap = !state.trace || state.compatibility?.compatible ? state.mapPack : null;
  const nextRoute = resolveReplayRoute(eligibleMap, state.trace, state.currentTime);
  if (nextRoute.key !== state.routeView?.key) {
    void renderData().catch((error) => showError(tr("关卡分支更新失败", "Route update failed"), error.message));
  }
  elements.timeline.value = String(state.currentTime);
  // The live edge grows between flush ticks; a stale max makes the browser
  // clamp the slider so it visibly freezes and then jumps once per second.
  if (duration > Number(elements.timeline.max)) elements.timeline.max = String(duration);
  elements.currentTime.textContent = formatTime(state.currentTime);
  const percent = duration > windowStart ? ((state.currentTime - windowStart) / (duration - windowStart)) * 100 : 0;
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
  elements.playButton.setAttribute("aria-label", state.playing ? tr("暂停", "Pause") : tr("播放", "Play"));
  syncWakeLock();
}

/** Live-follow: the playback loop continuously chases a point just behind the
 * newest record (smooth interpolation, prompt state), snapping forward after a
 * stall. Only while the live trace is the one on display. */
function isLiveFollowing() {
  const watch = state.watch;
  if (watch?.active) return Boolean(watch.trace && state.trace === watch.trace && watch.following && !watch.initializing && watch.status !== "ended");
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

/** Daily rotation stays available independently of the hidden live feature. */
function dailySources() {
  return dailySourceUrls({ location, relayUrl: defaultRelayUrl() });
}

const dailyReader = createDailySourceReader({
  sources: dailySources,
  freshness: (daily, now) => buildHomeDailyView({ daily, now }).freshness,
});
const dailyClock = createDailyRefreshClock({ refresh: loadDailyStatus, expire: expireDailyStatus });

function loadDailyStatus() {
  if (!state.dailyRequestInFlight) state.dailyRequestInFlight = applyDailyStatus();
  return state.dailyRequestInFlight;
}

async function applyDailyStatus() {
  try {
    const daily = await dailyReader.read();
    if (!daily) {
      if (!state.daily && !updateDailyCard()) {
        elements.dailyScene.textContent = tr("本地模式", "Local mode");
        elements.dailyCountdown.textContent = tr("未同步轮换", "Rotation not synchronized");
      }
      return;
    }
    const incomingFetchedAt = Date.parse(daily.fetchedAtUtc);
    const currentFetchedAt = Date.parse(state.daily?.fetchedAtUtc);
    if (state.daily && Number.isFinite(currentFetchedAt)
        && (!Number.isFinite(incomingFetchedAt) || incomingFetchedAt < currentFetchedAt)) {
      return; // A stale fallback must never replace a newer in-memory observation.
    }
    state.daily = daily;
    void homePage.update(daily);
    updateDailyCard();
    if (!isDailyMapFresh(daily)) {
      if (!state.historicalRoute) elements.dailyCountdown.textContent = Number.isFinite(Date.parse(daily.nextChangeAtUtc))
        ? tr("轮换数据已过期", "Rotation data expired") : tr("更新时间无效", "Invalid update time");
      await expireDailyStatus(daily);
      return;
    }
    state.expiredDailyKey = null;
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
      } else if (state.workspaceMode !== "replay") {
        await syncDailyMap(daily, true);
      }
      state.dailyMapErrorKey = null;
    } catch (error) {
      const targetScene = state.trace?.manifest.sceneName || daily.sceneName;
      const key = `${targetScene}:${error?.message}`;
      if (state.trace) await clearAutomaticMap();
      else if (state.mapSourceKind === "daily") await clearDailyMap();
      state.dailyMapStatus = {
        title: tr(`${targetScene} 地图暂不可用`, `${targetScene} map is temporarily unavailable`),
        detail: error?.message || tr("无法读取地图目录", "Unable to read the map catalog"),
      };
      updateMapUI();
      if (state.dailyMapErrorKey !== key) {
        state.dailyMapErrorKey = key;
        showError(tr("今日地图未载入", "Current map was not loaded"), state.dailyMapStatus.detail, 7000);
      }
    }
  } catch {
    if (!state.daily && !updateDailyCard()) {
      elements.dailyScene.textContent = tr("本地模式", "Local mode");
      elements.dailyCountdown.textContent = tr("未同步轮换", "Rotation not synchronized");
    }
  } finally {
    state.dailyRequestInFlight = null;
    dailyClock.schedule(state.daily, dailyReader.retryAt);
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
  if (!response.ok) throw new ProtocolError(tr("无法读取地图目录", "Unable to read the map catalog"), `HTTP ${response.status}`);
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
      title: tr(`${trace.manifest.sceneName} 内嵌地图不可用`, `${trace.manifest.sceneName} published map is unavailable`),
      detail: error.message || tr("无法读取 Pages 地图目录", "Unable to read the published map catalog"),
    };
    return;
  }
  if (requestRevision !== state.mapRequestRevision || state.trace !== trace) return;
  const entry = selectTraceMapPack(catalogInfo.catalog, trace.manifest);
  if (!entry) {
    await clearAutomaticMap();
    state.dailyMapStatus = {
      title: tr(`${trace.manifest.sceneName} 尚无匹配底图`, `No matching map for ${trace.manifest.sceneName}`),
      detail: trace.manifest.mapPackId
        ? tr(`catalog 中没有 ${trace.manifest.mapPackId}`, `Catalog has no map ${trace.manifest.mapPackId}`)
        : tr(`需要同 build ${trace.manifest.gameBuildId || "未知"} 与投影版本的内嵌地图`, `A published map with the same build ${trace.manifest.gameBuildId || "Unknown"} and projection version is required`),
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
      throw new ProtocolError(tr("内嵌地图与该局足迹不匹配", "Published map does not match this run"), compatibility.reasons.join(tr("；", "; ")));
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
  if (state.workspaceMode === "watch") return;
  if (state.workspaceMode === "replay" && !state.trace) return;
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
    const activeBuild = catalog.activeGameBuildId ? `build ${catalog.activeGameBuildId}` : tr("尚未指定当前构建", "Current build is not specified");
    state.dailyMapStatus = {
      title: tr(`${daily.sceneName} 地图包未发布`, `${daily.sceneName} map pack is not published`),
      detail: tr(`${activeBuild} · 可继续导入本地地图包`, `${activeBuild} · a local map pack can still be imported`),
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
      throw new ProtocolError(tr("地图目录与地图包不一致", "Map catalog and pack differ"), tr(`冲突字段：${conflicts.join(", ")}`, `Conflicting fields: ${conflicts.join(", ")}`));
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

function updateDailyCard() {
  const mapLabel = scene => {
    const number = /^Level_(\d+)$/.exec(scene || "")?.[1];
    return number !== undefined ? tr(`地图 ${number}`, `Map ${number}`) : tr("地图", "Map");
  };
  const history = state.historicalRoute;
  if (history) {
    const formatter = new Intl.DateTimeFormat(getLocale(), { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
    const dates = [...new Set([history.group.firstStartedUtc, history.group.lastStartedUtc]
      .filter(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
      .map(value => formatter.format(new Date(value))))];
    const rotation = Number.isInteger(history.group.map.levelIndex) ? tr(`轮换 ${history.group.map.levelIndex}`, `Rotation ${formatNumber(history.group.map.levelIndex)}`) : "";
    elements.dailyCard?.setAttribute("title", tr("历史录制地图", "Recorded map"));
    elements.dailyScene.textContent = tr(`历史${mapLabel(history.group.map.scene)}`, `Recorded ${mapLabel(history.group.map.scene)}`);
    elements.dailyCountdown.hidden = false;
    elements.dailyCountdown.textContent = [dates.join(" – "), rotation].filter(Boolean).join(" · ") || tr("历史录制地图", "Recorded map");
    return true;
  }
  elements.dailyCard?.setAttribute("title", tr("今日轮换", "Current rotation"));
  elements.dailyScene.textContent = state.daily
    ? mapLabel(state.daily.sceneName || `Level_${state.daily.mapSlot ?? ""}`) : tr("正在获取…", "Loading…");
  elements.dailyCountdown.hidden = true;
  elements.dailyCountdown.textContent = "";
  return false;
}

function updateDailyCountdown() {
  if (updateDailyCard()) return;
  if (!state.daily?.nextChangeAtUtc) return;
  const remaining = new Date(state.daily.nextChangeAtUtc).getTime() - Date.now();
  if (!Number.isFinite(remaining)) {
    elements.dailyCountdown.textContent = tr("更新时间无效", "Invalid update time");
    void expireDailyStatus(state.daily);
    return;
  }
  if (remaining <= 0) {
    elements.dailyCountdown.textContent = tr("轮换数据已过期", "Rotation data expired");
    void expireDailyStatus(state.daily);
    return;
  }
}

async function expireDailyStatus(daily) {
  if (state.mapSourceKind === "historical-route") return;
  // A boundary callback may still hold the previous observation while a manual
  // refresh has already installed the next one. Never clear that newer map.
  if (daily !== state.daily || isDailyMapFresh(daily)) return;
  const expiryKey = `${daily?.fetchedAtUtc || "unknown"}:${daily?.nextChangeAtUtc || "invalid"}`;
  if (state.expiredDailyKey === expiryKey) return;
  state.expiredDailyKey = expiryKey;
  if (state.trace) return;
  // Keep the last confirmed automatic map visible while the network recovers.
  // It is labelled as an archive below and can no longer claim to be today's map.
  if (daily !== state.daily || isDailyMapFresh(daily) || state.trace) return;
  state.dailyMapStatus = {
    title: tr(`${daily?.sceneName || "今日"} 地图状态已过期`, `${daily?.sceneName || "Current"} map status has expired`),
    detail: tr("保留上次确认的地图，正在自动确认本轮地图；接口恢复后会自动更新", "Keeping the last verified map while checking this rotation. It will update when the service is available."),
  };
  updateMapUI();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void dailyClock.wake();
});

elements.eventList.addEventListener("scroll", scheduleEventWindow, { passive: true });
elements.modeReplay?.addEventListener("click", () => void enterModeFromGate("replay"));
elements.gateReplay.addEventListener("click", () => enterModeFromGate("replay"));
elements.gateLive.addEventListener("click", () => {
  if (!FEATURES.liveVisible) return;
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
  if (state.watch?.active) {
    stopWatch();
    state.trace = null;
    state.traceCollection = state.replayCollection;
    const url = new URL(location.href);
    url.searchParams.delete("watch");
    history.replaceState(null, "", url);
  }
  elements.importMenu.open = false;
  if (state.historicalRoute) { state.historicalRoute = null; clearHistoricalRouteUrl(); updateDailyCountdown(); }
  showGate();
});
elements.gateDebug.addEventListener("click", () => {
  if (!FEATURES.liveVisible) return;
  state.workspaceMode = "live";
  syncWorkspaceState();
  dismissGate();
  setSourceMode("live");
  startDemoLive();
});
if (FEATURES.liveVisible) setInterval(() => {
  if (shouldPollLive({ pageOpen: gateOpen() })) void refreshGateRuns();
}, 5000);
// 侧栏手风琴：标题点击折叠/展开
document.querySelectorAll(".inspector-section:not(.community-section) .section-heading").forEach((heading) => {
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
  const identityButton = event.target.closest(".player-identity");
  if (event.target.closest("button, label, input, select, summary") && !identityButton) return;
  const row = event.target.closest(".player-row");
  if (!row) return;
  const expanded = row.classList.toggle("is-expanded");
  row.setAttribute("aria-expanded", String(expanded));
  identityButton?.setAttribute("aria-expanded", String(expanded));
  identityButton?.setAttribute(
    "aria-label",
    tr(`${expanded ? "收起" : "展开"} ${row.dataset.playerName} 的生命、体力与手持信息`, `${expanded ? "Collapse" : "Expand"} health, stamina and held item for ${row.dataset.playerName}`),
  );
});

// ===== 跟随相机：HUD + 快捷键 =====
function syncFollowHud(detail) {
  const active = Boolean(detail?.active ?? (viewer?.followTargetId != null));
  elements.followHud.hidden = !active;
  if (active) {
    const auto = detail?.autoRotate ?? viewer?.followAutoRotate ?? false;
    const viewMode = detail?.viewMode ?? viewer?.followViewMode;
    const name = detail?.name ?? (viewer?.followTargetId != null ? participantName(viewer.followTargetId) : "");
    elements.followHudText.textContent = state.watch?.active ? tr(`跟随 · ${name}`, `Following · ${name}`)
      : tr(`${viewMode === "interior" ? "关内向外观测" : "外侧观测"} · ${name} · ${auto ? "自动轮换 60s" : "已锁定"}`, `${viewMode === "interior" ? "Interior observation" : "Exterior observation"} · ${name} · ${auto ? "Auto cycle · 60s" : "Locked"}`);
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
  } else if (event.key === "Tab" && !state.watch?.active && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const target = event.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (!state.trace) return;
    event.preventDefault();
    viewer.cycleFollowTarget();
  }
});
// 直播只从首页“现场观测”进入；回放工作台不再维护第二个直播入口。
elements.liveRefresh.addEventListener("click", () => void refreshLiveRuns());
elements.liveDisconnect.addEventListener("click", () => disconnectLive());
elements.mapInput.addEventListener("change", () => importMap(elements.mapInput.files));
elements.traceInput.addEventListener("change", () => importTrace(elements.traceInput.files));
elements.traceFolderInput.addEventListener("change", () => importTrace(elements.traceFolderInput.files));
elements.traceSourceButton.addEventListener("click", () => {
  if (FEATURES.legacyReplayVisible) elements.traceInput.click();
});
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
// Canvas gestures belong to the camera. Keep a separate, reachable route to
// the stacked inspector so touch users never have to find a tiny scroll margin.
const replayInspector = document.querySelector(".inspector");
const isAtPhoneInspector = () => replayInspector.getBoundingClientRect().top < window.innerHeight / 2;
function updatePhonePanelButton() {
  if (state.watch?.active) {
    elements.phonePanelButton.textContent = tr("玩家", "Players");
    elements.phonePanelButton.setAttribute("aria-label", tr("展开玩家面板", "Open players"));
    return;
  }
  const atInspector = isAtPhoneInspector();
  elements.phonePanelButton.textContent = atInspector ? tr("地图 ↑", "Map ↑") : tr("玩家 ↓", "Players ↓");
  elements.phonePanelButton.setAttribute("aria-label", atInspector ? tr("回到地图", "Back to map") : tr("跳到玩家状态与回放设置", "Go to player status and replay settings"));
}
elements.phonePanelButton.addEventListener("click", () => {
  if (state.watch?.active) { toggleWatchPlayers(); return; }
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (isAtPhoneInspector()) document.querySelector(".app-shell").scrollIntoView({ block: "start", behavior });
  else replayInspector.scrollIntoView({ block: "start", behavior });
});
function toggleWatchPlayers(open = !elements.appShell.classList.contains("watch-players-open")) {
  elements.appShell.classList.toggle("watch-players-open", open);
  $("watchPlayers").setAttribute("aria-expanded", String(open));
  if (open) { toggleWatchReplay(false); watchChrome.closeMenu(); }
}
function toggleWatchReplay(open = !elements.appShell.classList.contains("watch-replay-open")) {
  elements.appShell.classList.toggle("watch-replay-open", open);
  $("watchReplay").setAttribute("aria-expanded", String(open));
  if (open) { toggleWatchPlayers(false); watchChrome.closeMenu(); }
}
function updateWatchJoinUI() {
  const join = state.watchJoin;
  $("watchJoinForm").setAttribute("aria-busy", String(join.pending));
  $("watchJoinButton").disabled = join.pending;
  $("watchJoinButton").textContent = watchText(join.pending ? "查找中…" : "观看");
  $("watchLinkInput").setAttribute("aria-invalid", String(["invalid-watch-input", "unknown-watch-code"].includes(join.error)));
  const messages = {
    "invalid-watch-input": "请输入 4 位英文字母直播码，或粘贴观战链接",
    "unknown-watch-code": "直播码不存在或已过期，请向主播确认",
    "watch-service-unavailable": "暂时无法连接直播服务",
    network: "网络不可用，请重试",
  };
  if (join.error === "rate-limited") {
    const seconds = Math.max(0, Math.ceil((join.retryAt - Date.now()) / 1000));
    $("watchJoinHint").textContent = tr("请求过于频繁，请 " + seconds + " 秒后重试", "Too many attempts. Try again in " + seconds + "s");
  } else $("watchJoinHint").textContent = watchText(join.pending ? "正在查找直播…" : messages[join.error] || "输入直播码即可观看，无需登录");
}

function cancelWatchJoin() {
  const join = state.watchJoin;
  ++join.revision;
  join.controller?.abort();
  join.controller = null;
  join.pending = false;
  join.error = null;
  updateWatchJoinUI();
}

async function joinWatchFromInput(value) {
  const join = state.watchJoin;
  if (join.pending) return;
  // A local cooldown respects the API's failed-attempt limit without extra requests.
  if (join.retryAt > Date.now() && !parseWatchId(value, location.href)) {
    join.error = "rate-limited"; updateWatchJoinUI(); return;
  }
  cancelWatchJoin();
  const revision = join.revision;
  const controller = new AbortController();
  join.controller = controller;
  join.pending = true;
  updateWatchJoinUI();
  try {
    const target = await resolveWatchInput(value, { base: location.href, signal: controller.signal });
    if (revision !== join.revision || controller.signal.aborted) return;
    await startWatch(target.watchId, { watchCode: target.watchCode });
  } catch (error) {
    if (revision !== join.revision || controller.signal.aborted) return;
    join.error = ["invalid-watch-input", "unknown-watch-code", "watch-service-unavailable", "rate-limited"].includes(error.code) ? error.code : "network";
    if (join.error === "rate-limited") join.retryAt = Date.now() + error.retryAfterMs;
  } finally {
    if (revision === join.revision) { join.pending = false; join.controller = null; updateWatchJoinUI(); }
  }
}

$("watchLinkInput").addEventListener("input", event => {
  if (event.isComposing) return;
  const input = event.currentTarget;
  const normalized = normalizeWatchInput(input.value);
  if (normalized !== input.value) input.value = normalized;
  cancelWatchJoin();
});
$("watchJoinForm").closest("details").addEventListener("toggle", event => {
  if (!event.currentTarget.open) cancelWatchJoin();
});
$("watchJoinForm").addEventListener("submit", event => {
  event.preventDefault();
  void joinWatchFromInput($("watchLinkInput").value);
});
$("watchRetry").addEventListener("click", () => void startWatch(state.watch.id));
$("watchGoLive").addEventListener("click", () => {
  if (!state.watch.trace) return;
  state.watch.following = true;
  setPlaying(false);
  updatePlaybackTime(state.watch.status === "ended" ? state.trace.duration : state.trace.duration - LIVE_TRAIL_S, false);
  updateWatchStatus();
});
$("watchAllPlayers").addEventListener("click", () => { viewer?.setFollowTarget(null); viewer?.fitView(); watchChrome.closeMenu(true); });
$("watchNextPlayer").addEventListener("click", () => { viewer?.cycleFollowTarget(); watchChrome.closeMenu(true); });
$("watchPlayers").addEventListener("click", () => { toggleWatchPlayers(); $("watchClosePlayers").focus(); });
$("watchClosePlayers").addEventListener("click", () => { toggleWatchPlayers(false); $("watchMenu").querySelector("summary").focus(); });
$("watchReplay").addEventListener("click", () => { toggleWatchReplay(); $("watchCloseReplay").focus(); });
$("watchCloseReplay").addEventListener("click", () => { toggleWatchReplay(false); $("watchMenu").querySelector("summary").focus(); });
function updateWatchShareUI() {
  const watch = state.watch;
  if (!watch.active) return;
  const hasCode = watch.status !== "ended" && Boolean(parseWatchCode(watch.code));
  const copied = watch.copiedUntil > Date.now();
  $("watchShare").textContent = copied && watch.copiedKind === (hasCode ? "code" : "link")
    ? watchText(hasCode ? "直播码已复制" : "已复制链接")
    : hasCode ? watchText("复制直播码") + " " + watch.code : watchText("复制观战链接");
  $("watchShareLink").hidden = !hasCode;
  $("watchShareLink").textContent = watchText(copied && watch.copiedKind === "link" ? "已复制链接" : "复制链接");
}

async function copyWatchShare(kind = "code") {
  const watch = state.watch;
  const id = watch.id;
  const payload = watchSharePayload(watch, location.href, kind);
  const current = () => watch.active && watch.id === id;
  try {
    await navigator.clipboard.writeText(payload.text);
    if (!current() || payload.kind === "code" && payload.text !== watch.code) return;
    watch.copiedKind = payload.kind;
    watch.copiedUntil = Date.now() + 2000;
    updateWatchShareUI();
    setTimeout(() => { if (current()) updateWatchShareUI(); }, 2100);
  } catch {
    if (!current()) return;
    if (payload.kind === "code") showError(watchText("请手动复制直播码"), payload.text);
    else showError(watchText("请复制地址栏链接"), watchText("当前浏览器未允许自动复制，地址栏中的链接可直接分享。"));
  }
}
$("watchShare").addEventListener("click", () => void copyWatchShare());
$("watchShareLink").addEventListener("click", () => void copyWatchShare("link"));
window.addEventListener("scroll", updatePhonePanelButton, { passive: true, capture: true });
elements.topViewButton.addEventListener("click", () => viewer?.topView());
elements.fitViewButton.addEventListener("click", () => viewer?.fitView());
elements.freeCameraButton.addEventListener("click", () => viewer?.toggleFreeCamera());
function bindMapLootFocusUi({ canvas, card, name, restoreButton, menu, getViewer }) {
  if (!canvas || !card || !name || !restoreButton) return () => {};
  let active = false;
  const render = (event) => {
    const detail = event.detail || {};
    const changedMarker = !active || card.dataset.markerId !== String(detail.markerId || "");
    active = detail.active === true;
    if (active && changedMarker && menu) menu.open = false;
    card.hidden = !active;
    card.dataset.markerId = active ? String(detail.markerId || "") : "";
    name.textContent = active ? String(detail.name || tr("地图标记", "Map marker")) : "";
    name.title = name.textContent;
  };
  const restore = () => {
    if (!active) return;
    getViewer()?.restoreMapLootView();
    canvas.focus({ preventScroll: true });
  };
  const escape = (event) => {
    if (!active || event.key !== "Escape" || event.defaultPrevented) return;
    if (event.target?.closest?.("input, select, textarea, [contenteditable='true']")) return;
    event.preventDefault();
    event.stopPropagation();
    restore();
  };
  canvas.addEventListener("peaktrail-loot-focus", render);
  canvas.addEventListener("keydown", escape);
  card.addEventListener("keydown", escape);
  restoreButton.addEventListener("click", restore);
  return () => {
    canvas.removeEventListener("peaktrail-loot-focus", render);
    canvas.removeEventListener("keydown", escape);
    card.removeEventListener("keydown", escape);
    restoreButton.removeEventListener("click", restore);
    card.hidden = true;
  };
}
const disposeMapLootFocus = bindMapLootFocusUi({
  canvas: elements.sceneCanvas, card: elements.mapLootFocus,
  name: elements.mapLootFocusName, restoreButton: elements.mapLootFocusReturn,
  menu: elements.mapLootMenu,
  getViewer: () => viewer,
});
const disposeCameraTouch = bindCameraTouchControls({
  root: elements.cameraTouchControls, canvas: elements.sceneCanvas,
  getCamera: () => viewer?.freeCamera,
});
elements.interiorViewButton.addEventListener("click", () => viewer?.enterInteriorView());
elements.worldToggle.addEventListener("change", () => {
  viewer?.setWorldVisibility(elements.worldToggle.checked);
  updateWorldTelemetry();
});
elements.sceneCanvas.addEventListener("cameramodechange", (event) => {
  const free = event.detail.mode === "free";
  elements.freeCameraButton.setAttribute("aria-pressed", String(free));
  elements.cameraHelp.hidden = !free;
  elements.cameraHelp.textContent = event.detail.help;
  elements.cameraTouchControls.hidden = !free;
  elements.sceneCanvas.setAttribute("aria-label", free ? event.detail.help : tr("地图回放，可切换自由相机", "Map replay · free camera available"));
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
  const previous = adjacentSegment(state.segmentOptions, state.selectedSegment, -1);
  if (previous) chooseSegment(previous.segment, "manual");
});
elements.nextSegmentButton.addEventListener("click", () => {
  const next = adjacentSegment(state.segmentOptions, state.selectedSegment, 1);
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
  if (state.watch?.active) { state.watch.following = false; setPlaying(false); updateWatchStatus(); }
  // Scrubbing takes over from live-follow: the chase must not fight the user
  // dragging through the buffered records. Re-check 跟随 to resume the edge.
  if (isLiveFollowing()) elements.liveFollow.checked = false;
  updatePlaybackTime(elements.timeline.value, false);
});
elements.playButton.addEventListener("click", () => {
  if (!state.trace) return;
  if (state.watch?.active && state.watch.following && state.watch.status !== "ended") {
    state.watch.following = false; setPlaying(false); toggleWatchReplay(true); updateWatchStatus(); return;
  }
  if (!state.playing && state.currentTime >= state.trace.duration) updatePlaybackTime(state.watch?.active ? state.trace.windowStart || 0 : 0, false);
  setPlaying(!state.playing);
});
elements.speedSelect.addEventListener("change", () => {
  state.speed = Number(elements.speedSelect.value) || 1;
});

document.addEventListener("keydown", (event) => {
  if (gateOpen()) return;
  if (event.code !== "Space" || event.repeat) return;
  const target = event.target;
  if (target?.closest?.("input, select, button, summary, textarea, a, [contenteditable]:not([contenteditable='false'])")) return;
  event.preventDefault();
  elements.playButton.click();
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (state.watch?.active) { event.preventDefault(); return; }
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (!FEATURES.legacyReplayVisible) return;
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
  if (state.watch?.active) return;
  dragDepth = 0;
  elements.dropOverlay.classList.remove("is-visible");
  if (!FEATURES.legacyReplayVisible) return;
  try {
    const files = await collectDroppedFiles(event.dataTransfer);
    if (!files.length) {
      showError(tr("拖入的目录没有可读取的文件", "No readable files in this dropped folder"), tr("请选择足迹总目录，或导入其中的 PeakTrailHistory.ndjson。", "Choose the recordings folder or its PeakTrailHistory.ndjson file."));
      return;
    }
    await importMixed(files);
  } catch (error) {
    const detail = describeError(error);
    showError(detail.title, detail.message);
  }
});

window.addEventListener("beforeunload", () => {
  cancelWatchJoin();
  state.watch.client?.stop();
  disposeLocaleUi();
  window.removeEventListener("scroll", updatePhonePanelButton, true);
  disposeCameraTouch();
  disposeMapLootFocus();
  communityMapPanel.dispose();
  mapLootPanel.dispose();
  itemEventPanel.dispose();
  homePage.dispose();
  dailyClock.dispose();
  state.mapPack?.disposeAssets?.();
  viewer?.dispose();
});

async function bootstrapMapFromQuery() {
  if (!FEATURES.legacyReplayVisible) return;
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
  elements.gateLive.hidden = !FEATURES.liveVisible;
  elements.modeLive.hidden = !FEATURES.liveVisible;
  elements.gateReplay.hidden = !FEATURES.legacyReplayVisible;
  elements.gateReplay.disabled = !FEATURES.legacyReplayVisible;
  elements.modeReplay.hidden = !FEATURES.legacyReplayVisible;
  elements.replaySource.hidden = !FEATURES.legacyReplayVisible;
  elements.importMenu.hidden = !FEATURES.legacyReplayVisible;
  $("replayEmptyState").hidden = !FEATURES.legacyReplayVisible;
  for (const input of [elements.mapInput, elements.traceInput, elements.traceFolderInput]) {
    input.hidden = !FEATURES.legacyReplayVisible;
    input.disabled = !FEATURES.legacyReplayVisible;
  }
  elements.gateDebug.closest("details").hidden = !FEATURES.liveVisible;
  const watchId = parseWatchId(new URL(location.href).searchParams.get("watch"));
  if (watchId) void startWatch(watchId, { replaceUrl: false });
  else showGate();
  updateCompatibilityUI();
  updateRangeFill(elements.heightScale);
  requestAnimationFrame(playbackLoop);
  if (!watchId) {
    await bootstrapMapFromQuery();
    await bootstrapHistoricalRouteFromQuery();
  }
  await loadDailyStatus();
  setInterval(updateDailyCountdown, 30_000);
  setInterval(() => void dailyClock.wake(), 5 * 60_000);
}

async function bootstrapHistoricalRouteFromQuery() {
  let link;
  try { link = parseHistoricalRouteLink(window.location.search); }
  catch (error) { showError(tr("历史路线未打开", "Unable to open historical route"), error.message, 0); return; }
  if (!link) return;
  await navigateHistoricalRoute(link);
}

async function readHistoricalJson(path, limit = 30_000_000) {
  const response = await fetch(path, { cache: "no-store", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(tr(`历史路线服务暂不可用（HTTP ${response.status}）。`, `Historical route service is unavailable (HTTP ${response.status}).`));
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(tr("历史路线服务返回格式无效。", "Historical route service returned an invalid format."));
  if (Number(response.headers.get("content-length")) > limit) throw new Error(tr("历史路线数据过大。", "Historical route data is too large."));
  const reader = response.body?.getReader();
  let text;
  if (reader) {
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error(tr("历史路线数据过大。", "Historical route data is too large.")); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error(tr("历史路线数据过大。", "Historical route data is too large."));
  }
  return JSON.parse(text);
}

async function openCommunityTeam(team) {
  if (!team) {
    if (!state.historicalRoute?.teamId) return;
    state.historicalRoute = { ...state.historicalRoute, teamId: null,
      title: state.historicalRoute.baseTitle || historicalRouteTitle(state.historicalRoute.group) };
    if (Number.isInteger(state.selectedSegment)) updateHistoricalRouteUrl(state.selectedSegment);
    else {
      const url = new URL(window.location.href); url.searchParams.delete("team");
      window.history.replaceState(null, "", url.href);
    }
    renderSegmentNavigation(); syncWorkspaceState();
    await communityMapPanel.openHistorical();
    return;
  }
  // Search results may belong to another day, scene or game build. Resolve
  // their original verified pack before drawing any of the team's positions.
  // Search summaries carry scene/build; only the single-team lookup carries
  // the verified pack. These hints preserve a candidate chapter, while the
  // resolver still proves the exact pack before reusing any model or camera.
  const sameMap = team.map?.scene === state.mapPack?.sceneName && String(team.map?.buildId) === String(state.mapPack?.gameBuildId)
    && (!team.mapPackId || team.mapPackId === state.mapPack?.mapPackId);
  const stageIndex = (state.historicalRoute?.group.id === team.groupId || sameMap)
    && team.stageSummaries?.some(stage => stage.index === state.selectedSegment)
    ? state.selectedSegment : null;
  await navigateHistoricalRoute({ groupId: team.groupId, teamId: team.id, stageIndex });
}

async function navigateHistoricalRoute(link) {
  const revision = ++state.mapRequestRevision;
  state.manualMapLoads++;
  setSourceLoading("map", true);
  try {
    const destination = await loadHistoricalRouteLink(link, {
      readGroups: () => readHistoricalJson("/api/route-groups"),
      readTeam: id => readHistoricalJson(`/api/route-teams/${id}`, 1_000_000),
      readCatalog: () => ensureMapCatalog(), loadMapPack: loadMapPackUrl,
      currentMapPack: state.mapPack,
    });
    await openHistoricalRoute(destination, revision);
  } catch (error) { if (revision === state.mapRequestRevision) showError(tr("历史路线未打开", "Unable to open historical route"), error.message, 0); }
  finally { state.manualMapLoads--; setSourceLoading("map", false); }
}

function refreshLocaleUi() {
  // Language changes only repaint labels. They must not reset playback, choose a
  // different chapter, refit the camera, or request the map's geometry again.
  if (state.historicalRoute) {
    const history = state.historicalRoute;
    history.baseTitle = historicalRouteTitle(history.group);
    history.title = history.baseTitle + (history.inspectionId ? tr(" · 验收预览", " · Review preview")
      : history.teamId ? tr(" · 团队路线", " · Team routes") : "");
  }
  state.routeView = resolveReplayRoute(state.usingCompatibleMap ? state.mapPack : null, state.trace, state.currentTime);
  let ordinal = 0;
  for (const option of Array.from(elements.layerSelect.options || elements.layerSelect.children)) {
    if (option.value === "all") { option.textContent = tr("所有关概览", "All chapters"); continue; }
    const segment = state.segmentOptions.find(entry => String(entry.segment) === option.value);
    if (!segment) continue;
    const chapter = segment.isVoid ? null : ++ordinal;
    option.textContent = `${segment.isVoid ? tr("额外区域", "Extra area") : tr(`第 ${chapter} 关`, `Stage ${formatNumber(chapter)}`)} · ${segmentDisplayName(segment)} / ${segment.name}`;
  }
  updateMapUI();
  updateTraceSourceLabels();
  updateCompatibilityUI();
  renderSegmentNavigation();
  const sessionId = elements.sessionSelect.value;
  populateTraceArchive(elements.dateSelect.value);
  populateSessionSelect(sessionId);
  const scrollTop = elements.eventList.scrollTop;
  updateEvents();
  elements.eventList.scrollTop = scrollTop;
  renderEventWindow();
  updatePlayerTelemetry();
  syncWorkspaceState();
  syncFollowHud();
  syncWakeLockChip();
  updatePhonePanelButton();
  updateDailyCard();
  if (!state.historicalRoute && state.daily?.nextChangeAtUtc) {
    const remaining = Date.parse(state.daily.nextChangeAtUtc) - Date.now();
    if (!Number.isFinite(remaining)) elements.dailyCountdown.textContent = tr("更新时间无效", "Invalid update time");
    else if (remaining <= 0) elements.dailyCountdown.textContent = tr("轮换数据已过期", "Rotation data expired");
  }
  renderGateRuns();
  elements.playButton.setAttribute("aria-label", state.playing ? tr("暂停", "Pause") : tr("播放", "Play"));
  for (const kind of ["map", "trace"]) {
    if (state.sourceLoadingCounts[kind]) (kind === "map" ? elements.mapSourceState : elements.traceSourceState).textContent = tr("读取中", "Loading");
  }
  if (elements.errorBanner.classList.contains("is-visible")) {
    renderErrorUi();
  }
  viewer?.refreshLocaleUi();
  updateWatchJoinUI();
  updateWatchStatus();
}

const disposeLocaleUi = onLocaleChange(refreshLocaleUi);
window.dispatchEvent(new Event("peaktrail-ready"));
void initializeViewer();
void bootstrap();
