const API = "/api/navigation";
const ROOM = /^[A-P][A-Z0-9]{5}$/;
const FEATURE = /^[A-F0-9]{20}$/;
const ARTWORK = "/data/game-assets/26155610/icons/Guidebook-resources-assets-841.png";
const ERRORS = Object.freeze({
  invalid_host_name: "请输入完整的房主昵称。",
  rate_limited: "查询较频繁，请稍后再试。",
  collector_unavailable: "录像服务暂不可用，请稍后再试。",
  search_unavailable: "录像服务暂不可用，请稍后再试。",
  upstream_invalid_response: "暂时无法读取录像列表，请稍后重试。",
  network_error: "暂时无法连接，请稍后重试。",
});
const date = value => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const identity = item => `${item.roomCode}.${item.featureCode}`;

export function normalizeReplayHost(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  const name = value.normalize("NFC").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const characters = Array.from(name);
  return name && characters.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) &&
    !characters.some(character => character.length === 1 && /[\ud800-\udfff]/.test(character)) ? name : null;
}

const replayNameKey = name => Array.from(name, character => {
  const upper = character.toUpperCase();
  return Array.from(upper).length === 1 ? upper : character;
}).join("");

export function parseReplaySearch(value, expectedName) {
  if (!value || normalizeReplayHost(value.hostName) !== expectedName || !Array.isArray(value.history) ||
      value.history.length > 100 || typeof value.hasMore !== "boolean") throw new Error("upstream_invalid_response");
  const seen = new Set();
  const history = value.history.map(raw => {
    const hostName = normalizeReplayHost(raw?.hostName), startedUtc = date(raw?.startedUtc), completedUtc = date(raw?.completedUtc);
    const expiresUtc = raw?.expiresUtc == null ? null : date(raw.expiresUtc);
    if (!raw || !ROOM.test(raw.roomCode) || !FEATURE.test(raw.featureCode) || raw.status !== "completed" || raw.archiveAvailable !== true ||
        !hostName || replayNameKey(hostName) !== replayNameKey(expectedName) || !startedUtc || !completedUtc || raw.expiresUtc != null && !expiresUtc || seen.has(identity(raw)))
      throw new Error("upstream_invalid_response");
    seen.add(identity(raw));
    // Never carry upstream credentials, hostKey or arbitrary URLs into the UI.
    return { hostName, roomCode: raw.roomCode, featureCode: raw.featureCode, startedUtc, completedUtc, expiresUtc, downloadState: "ready" };
  });
  return { hostName: expectedName, history, hasMore: value.hasMore };
}

export class ReplaySearch {
  constructor({ fetchImpl = globalThis.fetch, onChange = () => {}, now = Date.now, timeoutMs = 15000 } = {}) {
    this.fetch = fetchImpl; this.onChange = onChange; this.now = now; this.timeoutMs = timeoutMs;
    this.generation = 0; this.requests = new Set(); this.closed = false;
    this.state = { phase: "idle", hostName: "", history: [], hasMore: false, error: "" };
  }
  emit(fields) { this.state = { ...this.state, ...fields }; this.onChange(this.state); }
  clear() {
    this.generation++;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.emit({ phase: "idle", hostName: "", history: [], hasMore: false, error: "" });
  }
  async request(path, options = {}) {
    const controller = new AbortController(); this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    try {
      const response = await this.fetch(path, { ...options, signal: controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error" });
      if (response.status === 404 || response.status === 410) { await response.body?.cancel(); return { response, value: null }; }
      let value;
      try { value = await response.json(); }
      catch { throw new Error(response.ok ? "upstream_invalid_response" : "search_unavailable"); }
      return { response, value };
    } finally { clearTimeout(timer); this.requests.delete(controller); }
  }
  async search(input) {
    if (this.closed) return false;
    this.clear();
    const generation = this.generation, hostName = normalizeReplayHost(input);
    if (!hostName) { this.emit({ phase: "error", error: ERRORS.invalid_host_name }); return false; }
    this.emit({ phase: "loading", hostName });
    try {
      const { response, value } = await this.request(`${API}/replays/search`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostName }),
      });
      if (generation !== this.generation || this.closed) return false;
      if (!response.ok) throw new Error(ERRORS[value?.code] ? value.code : response.status === 429 ? "rate_limited" : "search_unavailable");
      this.emit({ ...parseReplaySearch(value, hostName), phase: "ready", error: "" });
      return true;
    } catch (error) {
      if (generation !== this.generation || this.closed) return false;
      this.emit({ phase: "error", history: [], hasMore: false, error: ERRORS[error.message] ?? ERRORS.network_error });
      return false;
    }
  }
  expired(item) { return item.expiresUtc != null && Date.parse(item.expiresUtc) <= this.now(); }
  updateItem(key, state) {
    this.emit({ history: this.state.history.map(item => identity(item) === key ? { ...item, downloadState: state } : item) });
  }
  async prepareDownload(item) {
    if (this.closed || this.state.phase !== "ready") return null;
    const key = identity(item), current = this.state.history.find(entry => identity(entry) === key);
    if (!current || ["checking", "expired", "missing"].includes(current.downloadState)) return null;
    if (this.expired(current)) { this.updateItem(key, "expired"); return null; }
    const generation = this.generation;
    this.updateItem(key, "checking");
    try {
      const { response, value: raw } = await this.request(`${API}/captures/${item.roomCode}/${item.featureCode}`, { method: "GET" });
      if (generation !== this.generation || this.closed) return null;
      if (response.status === 410 || response.status === 404) {
        this.updateItem(key, response.status === 410 ? "expired" : "missing"); return null;
      }
      if (!response.ok) throw new Error("download_unavailable");
      if (generation !== this.generation || this.closed) return null;
      if (raw?.roomCode !== item.roomCode || raw?.featureCode !== item.featureCode) throw new Error("invalid_response");
      if (raw.status !== "completed" || raw.archiveAvailable !== true || raw.expiresUtc != null && (!date(raw.expiresUtc) || Date.parse(raw.expiresUtc) <= this.now())) {
        this.updateItem(key, raw.status === "expired" ? "expired" : "missing"); return null;
      }
      this.updateItem(key, "ready");
      // Let the browser stream the attachment; never buffer a large ZIP in RAM.
      return `${API}/replays/${item.roomCode}/${item.featureCode}/archive.zip`;
    } catch {
      if (generation === this.generation && !this.closed) this.updateItem(key, "error");
      return null;
    }
  }
  dispose() { this.clear(); this.closed = true; }
}

export function mountReplaySearch(document, window, options = {}) {
  const byId = id => document.getElementById(id);
  const form = byId("replaySearchForm"), input = byId("replaySearchName"), submit = byId("replaySearchSubmit");
  const results = byId("replaySearchResults"), status = byId("replaySearchStatus"), error = byId("replaySearchError"), more = byId("replaySearchMore");
  const render = state => {
    submit.disabled = state.phase === "loading";
    submit.textContent = state.phase === "loading" ? "查找中…" : "查找";
    form.setAttribute("aria-busy", String(state.phase === "loading"));
    status.textContent = state.phase === "loading" ? "正在查找录像…" : state.phase === "ready"
      ? state.history.length ? `找到 ${state.history.length} 份录像` : "没有找到保留期内的录像，请核对录制时的房主昵称。"
      : state.phase === "error" ? "" : "输入完整昵称，仅查找对应房主的录像。";
    error.hidden = !state.error; error.textContent = state.error;
    more.hidden = !state.hasMore;
    results.replaceChildren();
    for (const item of state.history) {
      const row = document.createElement("div"); row.className = "navigation-record-row";
      const art = document.createElement("div"); art.className = "navigation-art"; art.setAttribute("aria-hidden", "true");
      const image = document.createElement("img"); image.src = ARTWORK; image.alt = ""; image.width = image.height = 76; image.loading = "lazy"; image.decoding = "async";
      image.addEventListener("error", () => { image.hidden = true; art.classList.add("is-fallback"); }); art.append(image);
      const content = document.createElement("div"); content.className = "navigation-record-content";
      const copy = document.createElement("div"); copy.className = "navigation-record-copy";
      const name = document.createElement("p"); name.className = "navigation-record-name";
      const host = document.createElement("strong"); host.textContent = item.hostName; host.title = item.hostName;
      const room = document.createElement("span"); room.className = "navigation-room-tag"; room.textContent = item.roomCode; name.append(host, room);
      const meta = document.createElement("div"); meta.className = "navigation-record-meta";
      const time = document.createElement("time"); time.dateTime = item.startedUtc;
      time.textContent = new Date(item.startedUtc).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); meta.append(time);
      const expired = client.expired(item) || item.downloadState === "expired";
      if (expired || item.downloadState === "missing" || item.downloadState === "error") {
        const note = document.createElement("span"); note.textContent = expired ? "已到期清理" : item.downloadState === "missing" ? "录像已不可用" : "下载暂不可用，请重试"; meta.append(note);
      }
      copy.append(name, meta); content.append(copy);
      const actions = document.createElement("div"); actions.className = "navigation-record-actions";
      const download = document.createElement("button"); download.type = "button"; download.className = "secondary";
      download.textContent = item.downloadState === "checking" ? "检查中…" : "下载 ZIP";
      download.disabled = expired || ["checking", "missing"].includes(item.downloadState);
      download.addEventListener("click", async () => { const url = await client.prepareDownload(item); if (url) window.location.assign(url); });
      actions.append(download); content.append(actions); row.append(art, content); results.append(row);
    }
  };
  const client = new ReplaySearch({ fetchImpl: window.fetch.bind(window), ...options, onChange: render });
  form.addEventListener("submit", event => { event.preventDefault(); void client.search(input.value); });
  input.addEventListener("input", () => client.clear());
  window.addEventListener?.("pagehide", () => client.clear());
  render(client.state);
  return client;
}

if (typeof document !== "undefined" && document.querySelector("[data-replay-search]")) mountReplaySearch(document, window);
