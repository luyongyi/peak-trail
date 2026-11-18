const REFRESH_MS = 45_000;
const TIMEOUT_MS = 8_000;
const numberFormat = new Intl.NumberFormat("zh-CN");
const byteFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

function formatStorageBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${byteFormat.format(bytes)} ${units[unit]}`;
}

export function storagePresentation(value) {
  if (!value || !nonnegativeInteger(value.recordingBytes) || typeof value.canStart !== "boolean" ||
      value.estimatedRemainingCaptures != null && !nonnegativeInteger(value.estimatedRemainingCaptures)) {
    return { state: "unavailable", estimate: "暂无法读取", used: "", title: "" };
  }

  const used = `录像已占用 ${formatStorageBytes(value.recordingBytes)}`;
  if (!value.canStart) {
    return { state: "limited", estimate: "空间不足，暂缓新录制", used, title: "当前余量不足以为新录像预留空间。" };
  }
  const remaining = value.estimatedRemainingCaptures;
  const estimate = remaining == null ? "暂无局数估算" : remaining === 0 ? "余量不足一局的平均大小"
    : `预计还能存约 ${numberFormat.format(remaining)} 局`;
  const title = value.sampleSize > 0 ? "按近期录像的平均大小估算。"
    : nonnegativeInteger(value.averageCaptureBytes) && value.averageCaptureBytes > 0
      ? `按每局 ${formatStorageBytes(value.averageCaptureBytes)} 估算。` : "按每局录像大小估算。";
  return { state: "available", estimate, used, title: remaining == null ? "" : title };
}

export function mountNavigationStorage(document, window) {
  const panel = document.getElementById("navigationStorage");
  const estimate = document.getElementById("navigationStorageEstimate");
  const used = document.getElementById("navigationStorageUsed");
  let timer, request, active = true;

  const render = value => {
    const state = storagePresentation(value);
    panel.dataset.state = state.state;
    if (estimate.textContent !== state.estimate) estimate.textContent = state.estimate;
    if (used.textContent !== state.used) used.textContent = state.used;
    estimate.title = state.title;
    used.hidden = !state.used;
    panel.hidden = false;
  };

  async function refresh() {
    if (!active || document.hidden || request) return;
    const controller = new AbortController();
    request = controller;
    const timeout = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    let value = null;
    try {
      const response = await window.fetch("/api/navigation/storage", {
        signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error",
      });
      if (response.ok) value = await response.json();
    } catch { }
    finally { window.clearTimeout(timeout); }
    if (request !== controller) return;
    request = null;
    if (!active || document.hidden) return;
    render(value);
    timer = window.setTimeout(refresh, REFRESH_MS);
  }

  function pause() {
    window.clearTimeout(timer);
    request?.abort();
    request = null;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else void refresh();
  });
  window.addEventListener("pagehide", () => { active = false; pause(); });
  window.addEventListener("pageshow", event => {
    if (event.persisted) { active = true; void refresh(); }
  });
  void refresh();
}

if (typeof document !== "undefined" && document.getElementById("navigationStorage")) mountNavigationStorage(document, window);
