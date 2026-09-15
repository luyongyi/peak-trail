import {
  FileBundle,
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
  traceSelectionRevision: 0,
  compatibility: null,
  currentTime: 0,
  playing: false,
  speed: 1,
  lastPlaybackFrame: 0,
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
};

const gameAssetLoads = new Map();

const SEGMENT_NAMES_ZH = new Map([
  ["shore", "海岸"],
  ["roots", "根系"],
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
  for (const layer of state.mapPack?.layers || []) {
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
  const mountain = state.segmentOptions.filter((option) => !option.isVoid);
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

function renderSegmentNavigation() {
  const options = state.segmentOptions;
  elements.segmentNavigator.hidden = options.length === 0;
  if (!options.length) return;

  const activeIndex = options.findIndex((option) => option.segment === state.selectedSegment);
  const active = activeIndex >= 0 ? options[activeIndex] : null;
  const isOverview = state.selectedSegment === null;
  elements.segmentOrdinal.textContent = isOverview
    ? `共 ${options.length} 关`
    : `第 ${activeIndex + 1} / ${options.length} 关`;
  elements.segmentName.textContent = isOverview ? "所有关概览" : segmentDisplayName(active);
  elements.segmentOriginalName.textContent = isOverview
    ? "仅在手动选择时加载"
    : `${active?.name || "未知"} · Segment ${active?.segment ?? "?"}`;

  elements.previousSegmentButton.disabled = !options.length || (activeIndex === 0 && !isOverview);
  elements.nextSegmentButton.disabled = !options.length || activeIndex === options.length - 1;
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
    selectOption.textContent = `第 ${index + 1} 关 · ${segmentDisplayName(option)} / ${option.name}`;
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
  state.gameAssetError = null;
  state.gameAssetStatus = buildId ? "loading" : "missing";
  if (!buildId) return;
  void cachedGameAssetPack(buildId).then((pack) => {
    if (selectionRevision !== state.traceSelectionRevision || state.trace !== trace) return;
    state.gameAssetPack = pack;
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
    state.traceCollection = collection;
    populateTraceArchive();
    const firstSession = collection.days[0]?.sessions[0] || collection.sessions[0];
    await selectTraceSession(firstSession?.manifest.sessionId, false);
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

async function renderData() {
  const useMap = Boolean(state.mapPack && (!state.trace || state.compatibility?.compatible));
  state.usingCompatibleMap = useMap;
  const activeSegment = populateSegmentControls();
  if (viewer) {
    if (useMap) markSegmentTransition(activeSegment);
    await viewer.setData({ mapPack: state.mapPack, trace: state.trace, useMap, activeSegment });
    viewer.setHeightScale(elements.heightScale.value);
    viewer.setTrackVisibility(elements.trackToggle.checked);
    viewer.setMarkerVisibility(elements.markerToggle.checked);
    viewer.setTime(state.currentTime);
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
  const layers = useMapBounds ? state.mapPack.layers.filter((layer) => state.selectedSegment === null
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
  updatePlayerTelemetry();
}

function updatePlayerTelemetry() {
  for (const row of elements.playerList.querySelectorAll(".player-row")) {
    const playerState = tracePlayerStateAtTime(state.trace, row.dataset.playerId, state.currentTime);
    updatePlayerCard(row, playerState, {
      assetPack: state.gameAssetPack,
      assetStatus: state.gameAssetStatus,
      assetError: state.gameAssetError,
    });
  }
}

function updateEvents() {
  elements.eventList.replaceChildren();
  elements.timelineMarkers.replaceChildren();
  const events = state.trace?.events || [];
  elements.eventCount.textContent = String(events.length);
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "inline-empty";
    empty.textContent = "死亡、复活、传送和分区变化会显示在这里。";
    elements.eventList.append(empty);
    return;
  }

  const duration = Math.max(0.001, state.trace.duration);
  for (const event of events) {
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
    elements.eventList.append(button);

    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.style.left = `${Math.min(100, Math.max(0, (event.t / duration) * 100))}%`;
    marker.style.setProperty("--marker-color", presentation.color);
    elements.timelineMarkers.append(marker);
  }
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

function updatePlaybackTime(nextTime, detectEvents = true) {
  const duration = state.trace?.duration || 0;
  const previous = state.currentTime;
  state.currentTime = Math.min(duration, Math.max(0, Number(nextTime) || 0));
  elements.timeline.value = String(state.currentTime);
  elements.currentTime.textContent = formatTime(state.currentTime);
  const percent = duration ? (state.currentTime / duration) * 100 : 0;
  elements.timeline.style.background = `linear-gradient(90deg, var(--accent) ${percent}%, rgba(255, 255, 255, 0.12) ${percent}%)`;
  syncSegmentToPlayback();
  viewer?.setTime(state.currentTime);
  updatePlayerTelemetry();

  if (detectEvents && state.currentTime >= previous) {
    const crossed = state.trace?.events.filter((event) => event.t > previous && event.t <= state.currentTime).at(-1);
    if (crossed) showEventToast(crossed);
  }
}

function setPlaying(playing) {
  state.playing = Boolean(playing && state.trace);
  state.lastPlaybackFrame = performance.now();
  elements.playButton.classList.toggle("is-playing", state.playing);
  elements.playButton.setAttribute("aria-label", state.playing ? "暂停" : "播放");
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

async function loadDailyStatus() {
  if (state.dailyRequestInFlight) return;
  state.dailyRequestInFlight = true;
  try {
    const response = await fetch("./data/daily/current.json", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const daily = await response.json();
    state.daily = daily;
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
elements.heightScale.addEventListener("input", () => {
  elements.heightScaleValue.textContent = `${Number(elements.heightScale.value).toFixed(1)}×`;
  updateRangeFill(elements.heightScale);
  viewer?.setHeightScale(elements.heightScale.value);
});
elements.layerSelect.addEventListener("change", () => {
  chooseSegment(elements.layerSelect.value === "all" ? null : Number(elements.layerSelect.value), "manual");
});
elements.previousSegmentButton.addEventListener("click", () => {
  if (!state.segmentOptions.length) return;
  const index = state.segmentOptions.findIndex((option) => option.segment === state.selectedSegment);
  const previous = index < 0 ? state.segmentOptions.at(-1) : state.segmentOptions[index - 1];
  if (previous) chooseSegment(previous.segment, "manual");
});
elements.nextSegmentButton.addEventListener("click", () => {
  if (!state.segmentOptions.length) return;
  const index = state.segmentOptions.findIndex((option) => option.segment === state.selectedSegment);
  const next = index < 0 ? state.segmentOptions[0] : state.segmentOptions[index + 1];
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
elements.timeline.addEventListener("input", () => updatePlaybackTime(elements.timeline.value, false));
elements.playButton.addEventListener("click", () => {
  if (!state.trace) return;
  if (!state.playing && state.currentTime >= state.trace.duration) updatePlaybackTime(0, false);
  setPlaying(!state.playing);
});
elements.speedSelect.addEventListener("change", () => {
  state.speed = Number(elements.speedSelect.value) || 1;
});

document.addEventListener("keydown", (event) => {
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
