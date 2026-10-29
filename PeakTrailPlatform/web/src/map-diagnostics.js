import { tr } from "./i18n.js";

// Local-only, bounded diagnostics. Never retain URLs, room codes or error text.
const STORAGE_KEY = "peaktrail.map-diagnostics.v1";
const PHASES = new Set(["initializing", "download", "hash", "decompress", "parse", "batch", "ready"]);
const MAP_STATES = new Set(["idle", "loading", "ready", "error"]);
const RENDER_STATES = new Set(["initializing", "ready", "context-lost", "context-restored", "render-error"]);
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "InvalidStateError", "OperationError", "ShaderError"]);
const NUMERIC_METRICS = ["drawingWidth", "drawingHeight", "viewportWidth", "viewportHeight", "pixelRatio", "pixelBudget", "samples", "maxTextureSize", "maxRenderbufferSize", "contextLossCount", "contextRestoreCount", "geometryCount", "textureCount", "programCount", "fogDepthWidth", "fogDepthHeight"];
const BOOLEAN_METRICS = ["coarsePointer", "antialias", "contextLost"];
const PHASE_LABELS = { initializing: ["准备地图", "Preparing map"], download: ["下载模型", "Downloading model"], hash: ["校验模型", "Verifying model"], decompress: ["解压模型", "Decompressing model"], parse: ["解析模型", "Parsing model"], batch: ["整理网格", "Preparing geometry"], ready: ["地图已加载", "Map loaded"] };
const bounded = (value, maximum = 1_000_000_000) => Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;

export function sanitizeRenderDiagnostics(value = {}) {
  const result = {};
  if (RENDER_STATES.has(value.status)) result.status = value.status;
  if (ERROR_NAMES.has(value.errorName)) result.errorName = value.errorName;
  for (const key of NUMERIC_METRICS) {
    const number = bounded(value[key]);
    if (number !== null) result[key] = number;
  }
  for (const key of BOOLEAN_METRICS) if (typeof value[key] === "boolean") result[key] = value[key];
  return result;
}

export function sanitizeMapDiagnostics(value = {}) {
  const result = { schemaVersion: 1,
    mapStatus: MAP_STATES.has(value.mapStatus) ? value.mapStatus : "idle",
    phase: PHASES.has(value.phase) ? value.phase : "initializing",
    elapsedMs: bounded(value.elapsedMs, 86_400_000) ?? 0,
    maxTickGapMs: bounded(value.maxTickGapMs, 86_400_000) ?? 0,
    rendering: sanitizeRenderDiagnostics(value.rendering),
  };
  if (Number.isInteger(value.segment) && value.segment >= 0 && value.segment <= 32) result.segment = value.segment;
  for (const key of ["loadedBytes", "totalBytes"]) {
    if (Number.isSafeInteger(value[key]) && bounded(value[key], 134_217_728) !== null) result[key] = value[key];
  }
  return result;
}

export function mountMapDiagnostics(canvas, { getRenderDiagnostics = () => ({}) } = {}) {
  const document = canvas.ownerDocument;
  const view = document?.defaultView;
  if (!document || !view || !canvas.parentElement) return { dispose() {} };
  let disposed = false, startedAt = Date.now(), lastTick = startedAt, slowShown = false;
  let state = sanitizeMapDiagnostics({});
  let previous = null;
  try {
    const text = view.sessionStorage.getItem(STORAGE_KEY);
    if (text && text.length <= 4096) {
      const saved = sanitizeMapDiagnostics(JSON.parse(text));
      if (saved.mapStatus === "loading" || saved.mapStatus === "error" || ["context-lost", "render-error"].includes(saved.rendering.status)) previous = saved;
    }
  } catch { /* Private browsing and disabled storage must not affect the map. */ }

  const panel = document.createElement("details"), summary = document.createElement("summary");
  const description = document.createElement("p"), output = document.createElement("pre"), copy = document.createElement("button");
  panel.className = "map-loading-diagnostics";
  Object.assign(panel.style, { position: "absolute", left: "12px", bottom: "12px", zIndex: "15", maxWidth: "min(28rem, calc(100% - 24px))", maxHeight: "45%", overflow: "auto", color: "#e4e8db", background: "#10201ded", border: "1px solid #64725e", borderRadius: "8px", padding: "7px 10px", fontSize: "12px", pointerEvents: "auto" });
  summary.textContent = tr("加载诊断", "Loading diagnostics");
  summary.style.cursor = "pointer";
  description.textContent = tr("若地图卡住，可复制此信息。诊断只保存在本机，不含房间号或账号信息。", "If the map stalls, copy this information. Diagnostics stay on this device and contain no room or account details.");
  description.style.maxWidth = "26rem";
  Object.assign(output.style, { whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text", fontSize: "11px" });
  copy.type = "button";
  copy.textContent = tr("复制诊断", "Copy diagnostics");
  panel.append(summary, description, output, copy);
  canvas.parentElement.append(panel);

  function refresh() {
    if (disposed) return;
    state.elapsedMs = Math.min(86_400_000, Math.max(0, Date.now() - startedAt));
    try { state.rendering = sanitizeRenderDiagnostics(getRenderDiagnostics()); } catch { /* A lost context may reject queries. */ }
    const snapshot = sanitizeMapDiagnostics(state);
    output.textContent = JSON.stringify(previous ? { ...snapshot, previousInterruptedLoad: previous } : snapshot, null, 2);
    try { view.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* Best effort only. */ }
    const graphicsInterrupted = ["context-lost", "render-error"].includes(state.rendering.status);
    summary.textContent = graphicsInterrupted ? tr("图形暂未就绪 · 加载诊断", "Graphics interrupted · diagnostics")
      : state.mapStatus === "error" ? tr("地图暂未就绪 · 加载诊断", "Map unavailable · diagnostics")
      : state.mapStatus === "loading" ? `${tr(...PHASE_LABELS[state.phase])} · ${tr("加载诊断", "diagnostics")}` : tr("加载诊断", "Loading diagnostics");
    if (graphicsInterrupted || state.mapStatus === "error") panel.open = true;
  }
  const listeners = [
    ["peaktrail-map-status", event => {
      const status = event.detail?.status;
      if (!MAP_STATES.has(status)) return;
      if (status === "loading" && (state.mapStatus !== "loading" || state.segment !== event.detail.segment)) {
        state = sanitizeMapDiagnostics({ mapStatus: "loading", segment: event.detail.segment });
        startedAt = Date.now(); slowShown = false;
      }
      state.mapStatus = status;
      if (status === "ready") state.phase = "ready";
      refresh();
    }],
    ["peaktrail-geometry-progress", event => {
      const detail = event.detail;
      if (state.mapStatus !== "loading" || !PHASES.has(detail?.stage)) return;
      const phaseChanged = state.phase !== detail.stage;
      state.phase = detail.stage;
      // Byte counts belong to their stage; never show stale compressed totals.
      delete state.loadedBytes; delete state.totalBytes;
      Object.assign(state, sanitizeMapDiagnostics({ ...state, ...detail, phase: detail.stage }));
      // Streams may emit hundreds of chunks. Keep only the latest counters;
      // the one-second timer paints them without synchronous storage per chunk.
      if (phaseChanged) refresh();
    }],
    ["peaktrail-render-status", event => {
      if (!RENDER_STATES.has(event.detail?.status)) return;
      state.rendering = sanitizeRenderDiagnostics({ ...event.detail.diagnostics, status: event.detail.status });
      refresh();
    }],
  ];
  for (const [name, listener] of listeners) canvas.addEventListener(name, listener);
  const onCopy = async () => {
    refresh();
    try {
      await view.navigator.clipboard.writeText(output.textContent);
      copy.textContent = tr("已复制", "Copied");
    } catch {
      copy.textContent = tr("请长按下方诊断文字复制", "Select the diagnostics below to copy");
      const selection = view.getSelection?.(), range = document.createRange();
      range.selectNodeContents(output); selection?.removeAllRanges(); selection?.addRange(range);
    }
  };
  copy.addEventListener("click", onCopy);
  panel.addEventListener("toggle", refresh);
  const onVisibilityChange = () => { lastTick = Date.now(); };
  document.addEventListener?.("visibilitychange", onVisibilityChange);
  const interval = view.setInterval(() => {
    const now = Date.now();
    if (document.visibilityState !== "hidden" && (state.mapStatus === "loading" || panel.open)) {
      state.maxTickGapMs = Math.min(86_400_000, Math.max(state.maxTickGapMs, now - lastTick));
      refresh();
      if (!slowShown && state.mapStatus === "loading" && state.elapsedMs >= 15_000) {
        slowShown = true; panel.open = true;
      }
    }
    lastTick = now;
  }, 1000);
  refresh();
  return { dispose() {
    if (disposed) return;
    disposed = true;
    view.clearInterval(interval);
    for (const [name, listener] of listeners) canvas.removeEventListener(name, listener);
    copy.removeEventListener("click", onCopy);
    panel.removeEventListener("toggle", refresh);
    document.removeEventListener?.("visibilitychange", onVisibilityChange);
    panel.remove();
  } };
}
