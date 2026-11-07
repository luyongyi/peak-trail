const ROOT = "/api/packet-replay";
const NAV_ROOT = "/api/navigation";
const NAV_HISTORY_KEY = "peak-navigation:history";
const STORAGE_KEY = "peak-packet-replay:last-capture";
const PENDING_KEY = "peak-packet-replay:pending-start";
const ACTIVE = new Set(["connecting", "recording", "stopping"]);
const NAVIGATION_ART = Object.freeze({
  active: "/data/game-assets/26155610/icons/Compass-resources-assets-717.png",
  saved: "/data/game-assets/26155610/icons/Guidebook-resources-assets-841.png",
});
const STATUS = Object.freeze({
  connecting: ["等待加入", "正在连接房间，尚未开始录制。"],
  recording: ["正在录制", "已加入房间，正在保存收到的游戏数据。"],
  stopping: ["正在保存", "正在退出房间并整理录像，请稍候。"],
  completed: ["录像已保存", "录像已保存。"],
  cancelled: ["已取消", "加入房间前已取消，没有生成录像。"],
  failed: ["录制失败", "本次未生成可下载的完整文件。"],
  interrupted: ["录制中断", "服务中断，本次没有可下载的完整文件。"],
  expired: ["录像已清理", "这份录像已超过保留期限，或已被该房主更新的录像替换。"],
});
const ERRORS = Object.freeze({
  not_authenticated: "管理登录已过期，请重新输入访问码。",
  invalid_access_code: "访问码不正确，请重新输入。",
  collector_unavailable: "录制服务暂不可用，请稍后重试或联系管理员。",
  collector_auth_failed: "录制服务配置需要管理员检查。",
  rate_limited: "操作过于频繁，请稍候再试。",
  forbidden_origin: "请求来源校验失败，请从本站重新打开录制页面。",
  invalid_request: "填写内容不正确，请检查后重试。",
  invalid_room_code: "请输入有效的六位联机码。",
  invalid_identity: "请输入有效的联机码和 20 位特征码。",
  upstream_timeout: "录制服务响应超时，请重试查询。",
  upstream_invalid_response: "暂时无法读取录制状态，请稍后重试。",
  capture_worker_busy: "服务暂时无法接入这个房间，请稍后重试。",
  capture_capacity: "同时导航的房间数已满，请稍后重试；已在导航的房间仍可共享。",
  capture_busy: "采集器正在使用中，请稍后再试。",
  idempotency_conflict: "这次请求与之前的录制不一致，请刷新页面后查询录像。",
  room_full: "房间已满，请预留一个玩家名额后重新录制。",
  room_not_found: "没有找到房间，请检查联机码及房间是否仍开放。",
  authentication_failed: "采集账号认证失败，请联系管理员重新登录 Steam。",
  steam_playing_blocked: "采集账号正在其他地方使用，请先结束该账号的游戏会话。",
  steam_refresh_token_missing: "采集账号尚未登录，请联系管理员。",
  steam_refresh_token_invalid: "采集账号需要重新扫码登录。",
  steam_login_failed: "采集账号登录失败，请联系管理员检查。",
  steam_login_timeout: "Steam 登录超时，请稍后重试。",
  steam_ticket_failed: "无法取得游戏认证，请检查采集账号的 PEAK 授权。",
  steam_ticket_timeout: "游戏认证超时，请稍后重试。",
  steam_session_disconnected: "采集账号的 Steam 连接已断开。",
  steam_session_busy: "采集账号的 Steam 会话被占用或暂时禁止连接，请联系管理员检查账号会话。",
  steam_login_required: "采集账号需要重新登录 Steam，请联系管理员完成扫码登录。",
  steam_broker_timeout: "共享 Steam 认证服务响应超时，请稍后重试。",
  steam_broker_ended: "共享 Steam 认证会话已结束，请稍后重新接入房间。",
  steam_broker_protocol: "账号认证服务通信异常，请联系管理员检查服务版本与运行状态。",
  steam_ticket_reused: "这份游戏认证票据已被使用，请重新开始本房间导航。",
  steam_ticket_capacity: "Steam 认证槽已满或仍在回收，请稍后重试；可继续查看已有导航。",
  capture_configuration_invalid: "游戏版本配置需要更新，请联系管理员。",
  room_closed: "房间已关闭，请让房主重新开放后再试。",
  join_failed: "未能加入房间，请检查联机码和房间状态。",
  connection_failed: "无法连接游戏服务，请稍后重试。",
  capture_failed: "本次录制未完成，请联系管理员检查。",
  capture_storage_unavailable: "录像存储暂不可用，请联系管理员。",
  capture_not_active: "这次录制已经结束，请刷新状态。",
  capture_in_progress: "录像仍在采集中，请停止并保存后下载。",
  service_stopping: "录制服务正在停止，请稍后再试。",
  capture_not_completed: "这次录制尚未生成可下载文件。",
  archive_not_ready: "录像仍在整理，请稍后下载。",
  archive_unavailable: "这份录像暂时无法下载。",
  archive_missing: "这份录像文件已不存在，请联系管理员。",
  archive_expired: "这份录像已按保留规则清理，无法继续下载。",
  capture_expired: "这份录像已按保留规则清理，无法继续下载。",
  live_unavailable: "这次采集暂时没有可显示的地图数据。",
  archive_unreadable: "暂时无法读取录像文件，请联系管理员。",
  archive_finalization_failed: "录像保存失败，请联系管理员。",
  capture_interrupted: "录像已中断，本次没有可下载的完整文件。",
  steam_broker_configuration: "采集账号尚未配置完成，请联系管理员。",
  steam_broker_unavailable: "账号认证服务暂不可用，请联系管理员。",
  steam_refresh_token_permissions: "采集账号配置无法读取，请联系管理员。",
  steam_ticket_invalid: "游戏认证未通过，请联系管理员检查采集账号。",
  not_found: "没有找到这份录像，请检查联机码和特征码。",
  capture_not_found: "没有找到这份录像，请检查联机码和特征码。",
  replay_unavailable: "这份录像暂时无法下载。",
  network_error: "暂时无法连接服务。若刚提交开始录制，请使用同一联机码重试。",
  pending_start: "上一次开始请求尚未确认，请使用原联机码重试。",
  navigation_not_authorized: "此浏览器尚未获得这个房间的导航权限，请重新输入房间号。",
  navigation_capacity: "当前使用人数较多，请稍后再试。",
  navigation_unavailable: "导航服务暂不可用，请稍后再试。",
  forbidden: "此浏览器不能查看这次导航，请重新输入房间号。",
});
const END_NOTES = Object.freeze({
  room_empty: "",
  host_kicked: "已被移出房间。",
  master_role_unsupported: "房主已变更，导航结束。",
  disconnected: "房间连接已断开。",
  left_room: "已离开房间。",
  size_limit: "录像已达大小上限。",
  service_shutdown: "服务已停止。",
});

export const normalizeRoom = value => String(value ?? "").trim().toUpperCase();
export const normalizeFeature = value => String(value ?? "").trim().toUpperCase();
export const validRoom = value => /^[A-P][A-Z0-9]{5}$/.test(value);
export const validFeature = value => /^[A-F0-9]{20}$/.test(value);
export const isActiveCapture = capture => Boolean(capture && ACTIVE.has(capture.status));
const emptyNavigationAttempt = capture => ["failed", "cancelled", "interrupted"].includes(capture?.status) && capture.events === 0 && !capture.archiveAvailable;
const endedRoomCode = code => ["room_not_found", "room_closed", "room_empty"].includes(code);
const captureKey = capture => `${capture.roomCode}.${capture.featureCode}`;
const startedLabel = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "开始时间待确认";
export const errorMessage = code => ERRORS[code] ?? "操作未完成，请稍后重试或联系管理员。";
export function formatBytes(value) {
  const bytes = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
export function parseCapture(value) {
  if (!value || !validRoom(value.roomCode) || !validFeature(value.featureCode) ||
      !Object.hasOwn(STATUS, value.status) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      !Number.isSafeInteger(value.events) || value.events < 0) throw new RecorderError("upstream_invalid_response");
  // Only bounded display names and known metadata reach the DOM, always as text.
  return { roomCode: value.roomCode, featureCode: value.featureCode, status: value.status,
    bytes: value.bytes, events: value.events,
    hostKey: typeof value.hostKey === "string" ? value.hostKey.slice(0, 128) : null,
    hostName: typeof value.hostName === "string" ? value.hostName.slice(0, 100) : null,
    archiveAvailable: value.archiveAvailable === true,
    zipBytes: Number.isSafeInteger(value.zipBytes) && value.zipBytes >= 0 ? value.zipBytes : 0,
    expiresUtc: Number.isFinite(Date.parse(value.expiresUtc)) ? value.expiresUtc : null,
    startedUtc: typeof value.startedUtc === "string" && Number.isFinite(Date.parse(value.startedUtc)) ? value.startedUtc : null,
    completedUtc: typeof value.completedUtc === "string" && Number.isFinite(Date.parse(value.completedUtc)) ? value.completedUtc : null,
    errorCode: Object.hasOwn(ERRORS, value.errorCode) ? value.errorCode : null,
    endReason: Object.hasOwn(END_NOTES, value.endReason) ? value.endReason : null };
}
export function capturePresentation(capture, { operator = true } = {}) {
  let [title, description] = STATUS[capture.status] ?? ["状态未知", "请重新查询录像。"];
  if (!operator && ["failed", "interrupted"].includes(capture.status)) {
    title = "暂时无法接入导航";
    description = "这次导航没有可下载的完整录像，请查看下方原因后重试。";
  }
  return { title, description, note: capture.errorCode ? errorMessage(capture.errorCode) : END_NOTES[capture.endReason] ?? "",
    map: `./index.html?capture=${capture.roomCode}.${capture.featureCode}${operator ? "&operator=1" : ""}`,
    download: capture.status === "completed" && capture.archiveAvailable ? `${operator ? ROOT : NAV_ROOT}/replays/${capture.roomCode}/${capture.featureCode}/archive.zip` : null,
    rawDownload: operator && capture.status === "completed" ? `${ROOT}/replays/${capture.roomCode}/${capture.featureCode}/file` : null };
}
export function groupHistory(captures, now = Date.now()) {
  const groups = new Map();
  const recordedAt = capture => Date.parse(capture.completedUtc ?? capture.startedUtc) || 0;
  for (const capture of [...captures].sort((a, b) => recordedAt(b) - recordedAt(a))) {
    if (capture.status !== "completed" || !capture.archiveAvailable || !capture.expiresUtc || Date.parse(capture.expiresUtc) <= now) continue;
    const key = capture.hostKey || `${capture.roomCode}.${capture.featureCode}`;
    if (!groups.has(key)) groups.set(key, { name: capture.hostName || "房主尚未识别", captures: [] });
    const group = groups.get(key);
    if (group.captures.length < 2) group.captures.push(capture);
  }
  return [...groups.values()];
}
class RecorderError extends Error { constructor(code, status = null) { super(errorMessage(code)); this.code = code; this.status = status; } }

export class PacketRecorder {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), storage = null,
    makeId = () => globalThis.crypto.randomUUID(), onChange = () => {},
    setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = timer => globalThis.clearTimeout(timer), libraryEnabled = false, apiRoot = ROOT } = {}) {
    this.fetch = fetchImpl; this.storage = storage; this.makeId = makeId; this.onChange = onChange;
    this.setTimer = setTimer; this.clearTimer = clearTimer; this.requests = new Set();
    this.pollTimer = null; this.disposed = false; this.pendingStart = null;
    this.libraryEnabled = libraryEnabled;
    if (![ROOT, NAV_ROOT].includes(apiRoot)) throw new Error("Unsupported capture API");
    this.apiRoot = apiRoot;
    this.storageKey = apiRoot === ROOT ? STORAGE_KEY : "peak-navigation:last-capture";
    this.pendingKey = apiRoot === ROOT ? PENDING_KEY : "peak-navigation:pending-start";
    this.state = { checking: true, configured: false, authenticated: false, busy: false, capture: null, active: null, activeCaptures: [], history: [], hasMore: false, libraryLoaded: false, error: "", pendingRoom: null };
  }
  emit() { if (!this.disposed) this.onChange({ ...this.state }); }
  fail(error) {
    if (this.disposed || error?.name === "AbortError") return;
    const code = error instanceof RecorderError ? error.code : "network_error";
    if (code === "not_authenticated") { this.state.authenticated = false; this.clearPoll(); }
    this.state.error = errorMessage(code); this.emit();
  }
  async request(path, { method = "GET", body, headers = {} } = {}) {
    if (this.disposed) throw new DOMException("Disposed", "AbortError");
    const controller = new AbortController(); this.requests.add(controller);
    const deadline = this.setTimer(() => controller.abort(), 15_000);
    try {
      const response = await this.fetch(`${this.apiRoot}${path}`, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      let value;
      try { value = await response.json(); } catch { throw new RecorderError("upstream_invalid_response"); }
      if (!response.ok) throw new RecorderError(response.status === 401 && path !== "/session" ? "not_authenticated" : value?.code ?? "unknown", response.status);
      if (this.disposed) throw new DOMException("Disposed", "AbortError");
      return value;
    } catch (error) {
      if (controller.signal.aborted && !this.disposed) throw new RecorderError("network_error");
      throw error;
    } finally { this.clearTimer(deadline); this.requests.delete(controller); }
  }
  async initialize() {
    try {
      const value = await this.request("/session");
      if (typeof value?.configured !== "boolean" || typeof value?.authenticated !== "boolean") throw new RecorderError("upstream_invalid_response");
      this.state.configured = value.configured; this.state.authenticated = value.configured && value.authenticated;
    } catch (error) { this.fail(error); }
    finally { this.state.checking = false; this.emit(); }
    if (this.state.authenticated) await this.restore();
    if (this.libraryEnabled && this.state.authenticated) { await this.refreshLibrary(); this.schedulePoll(); }
  }
  async action(work) {
    if (this.disposed || this.state.busy) return false;
    this.state.busy = true; this.state.error = ""; this.clearPoll(); this.emit();
    try { await work(); return true; } catch (error) { this.fail(error); return false; }
    finally {
      if (this.libraryEnabled && this.state.authenticated) await this.refreshLibrary();
      this.state.busy = false; this.emit(); this.schedulePoll();
    }
  }
  async login(accessCode) {
    return this.action(async () => {
      const value = await this.request("/session", { method: "POST", body: { accessCode } });
      if (value?.authenticated !== true) throw new RecorderError("invalid_access_code");
      this.state.authenticated = true; this.state.configured = true;
      if (this.restorePending()) return;
      const identity = this.savedIdentity();
      if (identity) this.accept(await this.request(`/captures/${identity.roomCode}/${identity.featureCode}`));
    });
  }
  async logout() {
    return this.action(async () => {
      await this.request("/session", { method: "DELETE" });
      this.state.authenticated = false; this.state.capture = null; this.state.active = null; this.state.activeCaptures = []; this.state.history = [];
    });
  }
  async start(roomInput) {
    const roomCode = normalizeRoom(roomInput);
    return this.action(async () => {
      if (!this.state.authenticated) throw new RecorderError("not_authenticated");
      if (!validRoom(roomCode)) throw new RecorderError("invalid_room_code");
      if (this.pendingStart && this.pendingStart.roomCode !== roomCode) throw new RecorderError("pending_start");
      this.pendingStart ??= { roomCode, key: this.makeId() }; this.state.pendingRoom = roomCode;
      try { this.storage?.setItem(this.pendingKey, JSON.stringify(this.pendingStart)); } catch { /* In-memory retries still use the same key. */ }
      try {
        this.accept(await this.request("/captures", { method: "POST", body: { roomCode }, headers: { "Idempotency-Key": this.pendingStart.key } }));
      } catch (error) {
        // An explicit rejection did not create a job. Unknown outcomes retain
        // the key so retrying cannot accidentally create a second recording.
        if (error.code === "capture_capacity" || error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) {
          this.clearPending();
        }
        throw error;
      }
      this.clearPending();
    });
  }
  async lookup(roomInput, featureInput) {
    const roomCode = normalizeRoom(roomInput), featureCode = normalizeFeature(featureInput);
    return this.action(async () => {
      if (!this.state.authenticated) throw new RecorderError("not_authenticated");
      if (!validRoom(roomCode) || !validFeature(featureCode)) throw new RecorderError("invalid_identity");
      // A lookup cannot prove which job an unacknowledged start created.
      // Recover that start using its idempotency key before changing targets.
      if (this.pendingStart) throw new RecorderError("pending_start");
      const capture = parseCapture(await this.request(`/captures/${roomCode}/${featureCode}`));
      if (capture.roomCode !== roomCode || capture.featureCode !== featureCode) throw new RecorderError("upstream_invalid_response");
      this.accept(capture);
    });
  }
  async stop() {
    if (!this.state.authenticated || !isActiveCapture(this.state.capture) || this.state.capture.status === "stopping") return false;
    const { roomCode, featureCode } = this.state.capture;
    return this.action(async () => this.accept(await this.request(`/captures/${roomCode}/${featureCode}/stop`, { method: "POST" })));
  }
  accept(value) {
    const capture = parseCapture(value); this.state.capture = capture;
    try { this.storage?.setItem(this.storageKey, JSON.stringify({ roomCode: capture.roomCode, featureCode: capture.featureCode })); } catch { /* Storage may be disabled. */ }
    this.emit();
  }
  savedIdentity() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.storageKey) ?? "null");
      if (value && validRoom(value.roomCode) && validFeature(value.featureCode)) return { roomCode: value.roomCode, featureCode: value.featureCode };
    } catch { /* Invalid or blocked storage does not prevent recording. */ }
    return null;
  }
  clearPending() {
    this.pendingStart = null; this.state.pendingRoom = null;
    try { this.storage?.removeItem(this.pendingKey); } catch { }
  }
  restorePending() {
    try {
      const value = JSON.parse(this.storage?.getItem(this.pendingKey) ?? "null");
      if (value && validRoom(value.roomCode) && typeof value.key === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.key)) {
        this.pendingStart = { roomCode: value.roomCode, key: value.key };
        this.state.pendingRoom = value.roomCode;
      }
    } catch { /* Keep an in-memory pending start even when storage is blocked. */ }
    if (this.pendingStart) {
      this.state.error = "上一次开始请求尚未确认，请点击“重试开始”找回录制状态。";
      this.emit(); return true;
    }
    return false;
  }
  async restore() { if (this.restorePending()) return; const identity = this.savedIdentity(); if (identity) await this.lookup(identity.roomCode, identity.featureCode); }
  async refreshLibrary() {
    if (this.disposed || !this.state.authenticated || this.libraryRequest) return;
    this.libraryRequest = true;
    try {
      const value = await this.request("/captures");
      if (!value || !Array.isArray(value.history) || value.history.length > 100 || typeof value.hasMore !== "boolean") throw new RecorderError("upstream_invalid_response");
      const active = value.active === null ? null : parseCapture(value.active);
      const supplied = value.activeCaptures === undefined ? (active ? [active] : []) : value.activeCaptures;
      if (!Array.isArray(supplied) || supplied.length > 16) throw new RecorderError("upstream_invalid_response");
      const activeCaptures = supplied.map(parseCapture), rooms = new Set();
      for (const capture of activeCaptures) {
        if (!isActiveCapture(capture) || rooms.has(capture.roomCode)) throw new RecorderError("upstream_invalid_response");
        rooms.add(capture.roomCode);
      }
      const first = activeCaptures[0] ?? null;
      if (Boolean(active) !== Boolean(first) || active && (active.roomCode !== first.roomCode ||
        active.featureCode !== first.featureCode || active.status !== first.status)) throw new RecorderError("upstream_invalid_response");
      const history = value.history.map(parseCapture);
      Object.assign(this.state, { active, activeCaptures, history, hasMore: value.hasMore, libraryLoaded: true });
      // A pending start must still be resolved with its original idempotency key.
      // Preserve the selected room as other rooms start, stop or finish.
      if (!this.pendingStart && this.state.capture) {
        const current = this.state.capture;
        const updated = [...activeCaptures, ...history].find(item => item.roomCode === current.roomCode && item.featureCode === current.featureCode);
        if (updated) this.accept(updated);
      } else if (!this.pendingStart && active) this.accept(active);
      this.emit();
    } catch (error) { this.fail(error); }
    finally { this.libraryRequest = false; }
  }
  clearPoll() { if (this.pollTimer !== null) this.clearTimer(this.pollTimer); this.pollTimer = null; }
  schedulePoll() {
    this.clearPoll();
    if (this.disposed || !this.state.authenticated || !this.libraryEnabled && !isActiveCapture(this.state.capture)) return;
    this.pollTimer = this.setTimer(() => { this.pollTimer = null; return this.poll(); }, this.state.error ? 5_000 : isActiveCapture(this.state.capture) || this.state.activeCaptures.length ? 2_000 : 10_000);
  }
  async poll() {
    if (this.disposed || this.state.busy || !this.state.authenticated) return;
    const identity = this.state.capture;
    try {
      if (isActiveCapture(identity)) {
        const value = await this.request(`/captures/${identity.roomCode}/${identity.featureCode}`);
        if (this.state.capture === identity && !this.state.busy) { this.state.error = ""; this.accept(value); }
      }
      if (this.libraryEnabled) await this.refreshLibrary();
    } catch (error) { this.fail(error); }
    finally { this.schedulePoll(); }
  }
  dispose() { this.disposed = true; this.clearPoll(); for (const controller of this.requests) controller.abort(); this.requests.clear(); }
}

/** A room plus its unique feature identifies one navigation session, never another reuse of the room code. */
export class NavigationClient extends PacketRecorder {
  constructor(options = {}) {
    super({ ...options, libraryEnabled: false, apiRoot: NAV_ROOT });
    this.state.reused = false;
    this.state.navigationHistory = [];
    this.state.roomResult = null;
    this.roomLookup = null;
    this.lookupRevision = 0;
    this.historyIdentities = this.loadHistory();
    this.forgotten = new Set();
  }
  fail(error) {
    if (endedRoomCode(error?.code)) {
      if (!this.disposed) { this.state.error = "房间已结束或未开放。"; this.emit(); }
      return;
    }
    if ([401, 403].includes(error?.status) && !["forbidden_origin"].includes(error.code)) {
      this.clearPoll(); this.state.capture = null;
      error = new RecorderError("navigation_not_authorized", error.status);
    }
    super.fail(error);
  }
  async initialize() {
    try {
      const value = await this.request("/session");
      if (typeof value?.configured !== "boolean") throw new RecorderError("upstream_invalid_response");
      this.state.configured = value.configured;
      // This internal readiness flag only gates polling; public navigation does
      // not authenticate with, persist or expose the administrator's access code.
      this.state.authenticated = value.configured;
    } catch (error) { this.fail(error); }
    finally { this.state.checking = false; this.emit(); }
    if (!this.state.configured) return;
    const pending = this.restorePending();
    const saved = this.savedIdentity();
    if (!pending && saved) await this.lookup(saved.roomCode, saved.featureCode);
    await this.refreshHistory();
  }
  async findRoom(roomInput) {
    if (this.disposed || this.state.busy && this.roomLookup === null) return false;
    if (this.pendingStart) return this.start(roomInput);
    const roomCode = normalizeRoom(roomInput);
    if (!this.state.configured || !validRoom(roomCode)) {
      this.fail(new RecorderError(!this.state.configured ? "navigation_unavailable" : "invalid_room_code")); return false;
    }
    const revision = ++this.lookupRevision;
    this.roomLookup = revision; this.clearPoll();
    Object.assign(this.state, { busy: true, error: "", capture: null, roomResult: null, reused: false }); this.emit();
    try {
      const value = await this.request("/rooms/lookup", { method: "POST", body: { roomCode } });
      if (this.disposed || revision !== this.lookupRevision) return false;
      if (value?.roomCode !== roomCode || !Array.isArray(value.history) || value.history.length > 20 || typeof value.hasMore !== "boolean")
        throw new RecorderError("upstream_invalid_response");
      const active = value.active === null ? null : parseCapture(value.active);
      if (active && (active.roomCode !== roomCode || !isActiveCapture(active))) throw new RecorderError("upstream_invalid_response");
      const history = value.history.map(parseCapture), seen = new Set(active ? [captureKey(active)] : []);
      for (const capture of history) {
        const key = captureKey(capture);
        if (capture.roomCode !== roomCode || capture.status !== "completed" || !capture.archiveAvailable || seen.has(key))
          throw new RecorderError("upstream_invalid_response");
        seen.add(key);
      }
      history.sort((a, b) => (Date.parse(b.completedUtc ?? b.startedUtc) || 0) - (Date.parse(a.completedUtc ?? a.startedUtc) || 0));
      this.state.roomResult = { roomCode, active, history, hasMore: value.hasMore };
      for (const capture of [...history].reverse()) { this.forgotten.delete(captureKey(capture)); this.remember(capture); }
      if (active || history.length) {
        const selected = active ?? history[0]; this.forgotten.delete(captureKey(selected));
        this.accept(selected); this.state.reused = Boolean(active); return true;
      }
      // A code with retained recordings is read-only until the explicit new
      // game button is pressed. Only a completely empty lookup may auto-join.
      this.roomLookup = null; this.state.busy = false;
      return await this.start(roomCode);
    } catch (error) {
      if (revision === this.lookupRevision) this.fail(error);
      return false;
    } finally {
      if (revision === this.lookupRevision && this.roomLookup === revision) {
        this.roomLookup = null; this.state.busy = false; this.emit(); this.schedulePoll();
      }
    }
  }
  async start(roomInput) {
    const roomCode = normalizeRoom(roomInput);
    return this.action(async () => {
      if (!this.state.configured) throw new RecorderError("navigation_unavailable");
      if (!validRoom(roomCode)) throw new RecorderError("invalid_room_code");
      if (this.pendingStart && this.pendingStart.roomCode !== roomCode) throw new RecorderError("pending_start");
      if (!this.pendingStart && isActiveCapture(this.state.capture) && this.state.capture.roomCode === roomCode) {
        this.forgotten.delete(`${this.state.capture.roomCode}.${this.state.capture.featureCode}`);
        this.remember(this.state.capture); this.state.reused = true; return;
      }
      this.pendingStart ??= { roomCode, key: this.makeId() };
      this.state.pendingRoom = roomCode;
      try { this.storage?.setItem(this.pendingKey, JSON.stringify(this.pendingStart)); } catch { }
      let value;
      try {
        value = await this.request("/rooms", { method: "POST", body: { roomCode }, headers: { "Idempotency-Key": this.pendingStart.key } });
        if (typeof value?.reused !== "boolean") throw new RecorderError("upstream_invalid_response");
        const capture = parseCapture(value.capture);
        if (capture.roomCode !== roomCode) throw new RecorderError("upstream_invalid_response");
        this.forgotten.delete(`${capture.roomCode}.${capture.featureCode}`);
        this.accept(capture); this.state.reused = value.reused;
      } catch (error) {
        if (error.code === "capture_capacity" || error.status >= 400 && error.status < 500 && ![401, 403, 408, 429].includes(error.status)) this.clearPending();
        throw error;
      }
      this.clearPending();
    });
  }
  async lookup(roomInput, featureInput) {
    const roomCode = normalizeRoom(roomInput), featureCode = normalizeFeature(featureInput);
    return this.action(async () => {
      if (!this.state.configured) throw new RecorderError("navigation_unavailable");
      if (!validRoom(roomCode) || !validFeature(featureCode)) throw new RecorderError("invalid_identity");
      const capture = parseCapture(await this.request(`/captures/${roomCode}/${featureCode}`));
      if (capture.roomCode !== roomCode || capture.featureCode !== featureCode) throw new RecorderError("upstream_invalid_response");
      this.accept(capture);
    });
  }
  loadHistory() {
    try {
      const raw = JSON.parse(this.storage?.getItem(NAV_HISTORY_KEY) ?? "[]");
      if (!Array.isArray(raw)) return [];
      const seen = new Set();
      return raw.slice(0, 30).filter(item => {
        if (!validRoom(item?.roomCode) || !validFeature(item?.featureCode)) return false;
        const key = `${item.roomCode}.${item.featureCode}`;
        if (seen.has(key)) return false; seen.add(key); return true;
      }).map(item => ({ roomCode: item.roomCode, featureCode: item.featureCode,
        hostName: typeof item.hostName === "string" ? item.hostName.slice(0, 100) : null,
        startedUtc: typeof item.startedUtc === "string" && Number.isFinite(Date.parse(item.startedUtc)) ? item.startedUtc : null }));
    } catch { return []; }
  }
  remember(capture) {
    if (emptyNavigationAttempt(capture)) return;
    const key = `${capture.roomCode}.${capture.featureCode}`;
    if (this.forgotten.has(key)) return;
    const item = { roomCode: capture.roomCode, featureCode: capture.featureCode, hostName: capture.hostName, startedUtc: capture.startedUtc };
    this.historyIdentities = [item, ...this.historyIdentities.filter(old => `${old.roomCode}.${old.featureCode}` !== key)].slice(0, 30);
    this.state.navigationHistory = [capture, ...this.state.navigationHistory.filter(old => `${old.roomCode}.${old.featureCode}` !== key)].slice(0, 30);
    try { this.storage?.setItem(NAV_HISTORY_KEY, JSON.stringify(this.historyIdentities)); } catch { }
  }
  accept(value) {
    const capture = parseCapture(value);
    if (emptyNavigationAttempt(capture)) {
      this.removeHistoryIdentity(capture);
      if (this.state.roomResult?.active && captureKey(this.state.roomResult.active) === captureKey(capture)) this.state.roomResult.active = null;
      this.state.capture = null;
      this.state.error = endedRoomCode(capture.errorCode) || endedRoomCode(capture.endReason)
        ? "房间已结束或未开放。" : errorMessage(capture.errorCode ?? capture.endReason ?? "capture_failed");
      this.emit(); return;
    }
    if (this.state.roomResult?.roomCode === capture.roomCode) {
      if (isActiveCapture(capture)) this.state.roomResult.active = capture;
      else if (this.state.roomResult.active && captureKey(this.state.roomResult.active) === captureKey(capture)) this.state.roomResult.active = null;
      if (capture.status === "completed" && capture.archiveAvailable)
        this.state.roomResult.history = [capture, ...this.state.roomResult.history.filter(item => captureKey(item) !== captureKey(capture))].slice(0, 20);
    }
    if (this.forgotten.has(`${capture.roomCode}.${capture.featureCode}`)) { this.state.capture = capture; this.emit(); return; }
    this.remember(capture); super.accept(capture);
  }
  persistHistory() {
    try {
      if (this.historyIdentities.length) this.storage?.setItem(NAV_HISTORY_KEY, JSON.stringify(this.historyIdentities));
      else this.storage?.removeItem(NAV_HISTORY_KEY);
    } catch { }
  }
  removeHistoryIdentity(capture) {
    const key = captureKey(capture);
    this.historyIdentities = this.historyIdentities.filter(item => captureKey(item) !== key);
    this.state.navigationHistory = this.state.navigationHistory.filter(item => captureKey(item) !== key);
    const saved = this.savedIdentity();
    if (saved && captureKey(saved) === key) try { this.storage?.removeItem(this.storageKey); } catch { }
    this.persistHistory();
  }
  async refreshHistory() {
    if (this.disposed || !this.state.configured || this.historyRequest) return;
    this.historyRequest = true;
    const identities = [...this.historyIdentities], next = new Array(identities.length);
    let index = 0;
    try {
      const worker = async () => {
        while (index < identities.length) {
          const position = index++, item = identities[position];
          try {
            const capture = parseCapture(await this.request(`/captures/${item.roomCode}/${item.featureCode}`));
            if (capture.roomCode !== item.roomCode || capture.featureCode !== item.featureCode) throw new RecorderError("upstream_invalid_response");
            next[position] = capture;
          } catch {
            next[position] = { ...item, status: "unavailable", archiveAvailable: false };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, identities.length) }, worker));
      if (!this.disposed) {
        const keyOf = item => `${item.roomCode}.${item.featureCode}`;
        const originals = new Map(identities.map(item => [keyOf(item), item]));
        const refreshed = new Map(next.map(item => [keyOf(item), item]));
        const current = new Map(this.state.navigationHistory.map(item => [keyOf(item), item]));
        const visible = [];
        // Merge into the identities that still exist now. A clear, new start or
        // newer poll during this request must not be undone by its older result.
        this.historyIdentities = this.historyIdentities.filter(item => !this.forgotten.has(keyOf(item))).slice(0, 30).flatMap(item => {
          const key = keyOf(item), snapshot = originals.get(key) === item ? refreshed.get(key) : null;
          if (snapshot && emptyNavigationAttempt(snapshot)) {
            const saved = this.savedIdentity();
            if (saved && keyOf(saved) === key) try { this.storage?.removeItem(this.storageKey); } catch { }
            return [];
          }
          visible.push(snapshot ?? current.get(key) ?? { ...item, status: "unavailable", archiveAvailable: false });
          return [snapshot && snapshot.status !== "unavailable"
            ? { roomCode: item.roomCode, featureCode: item.featureCode, hostName: snapshot.hostName, startedUtc: snapshot.startedUtc }
            : item];
        });
        this.state.navigationHistory = visible;
        // Clearing history removes its storage key; an in-flight refresh must
        // leave that choice intact, including when its old replies now arrive.
        this.persistHistory();
      }
    } finally { this.historyRequest = false; this.emit(); }
  }
  clearHistory() {
    for (const item of this.historyIdentities) this.forgotten.add(`${item.roomCode}.${item.featureCode}`);
    this.historyIdentities = []; this.state.navigationHistory = [];
    try { this.storage?.removeItem(NAV_HISTORY_KEY); this.storage?.removeItem(this.storageKey); } catch { }
    this.emit();
  }
  async login() { return false; }
  async logout() { return false; }
  async stop() { return false; }
  async refreshLibrary() { return false; }
}

export function mountNavigation(document, window) {
  const byId = id => document.getElementById(id);
  const artwork = capture => NAVIGATION_ART[isActiveCapture(capture) ? "active" : "saved"];
  const artworkFallback = event => {
    const image = event.currentTarget;
    image.hidden = true;
    image.parentElement?.classList.add("is-fallback");
  };
  byId("navigationArtwork").addEventListener("error", artworkFallback);
  const renderRows = (list, captures) => {
    list.replaceChildren();
    for (const item of captures) {
      const row = document.createElement("div"); row.className = "history-row navigation-history-row navigation-record-row"; row.dataset.status = item.status;
      const art = document.createElement("div"); art.className = "navigation-art"; art.setAttribute("aria-hidden", "true");
      const image = document.createElement("img"); image.src = artwork(item); image.alt = ""; image.width = 76; image.height = 76;
      image.loading = "lazy"; image.decoding = "async"; image.addEventListener("error", artworkFallback); art.append(image); row.append(art);
      const content = document.createElement("div"); content.className = "navigation-record-content";
      const info = document.createElement("div"); info.className = "navigation-record-copy";
      const name = document.createElement("p"); name.className = "navigation-record-name";
      const host = document.createElement("strong"); host.textContent = item.hostName || "未知房主"; host.title = host.textContent;
      const room = document.createElement("span"); room.className = "navigation-room-tag"; room.textContent = item.roomCode;
      name.append(host, room);
      const meta = document.createElement("div"); meta.className = "navigation-record-meta";
      const started = document.createElement("time"); started.className = "navigation-history-started";
      started.textContent = startedLabel(item.startedUtc);
      if (item.startedUtc) started.dateTime = item.startedUtc;
      const status = document.createElement("span"); status.className = "navigation-history-status";
      status.textContent = item.status === "expired" ? "录像已到期清理" : item.status === "unavailable" ? "录像已不存在或暂不可用"
        : item.status === "recording" ? "导航进行中" : item.status === "connecting" ? "正在接入" : capturePresentation(item, { operator: false }).title;
      meta.append(status, started); info.append(name, meta); content.append(info);
      const actions = document.createElement("div"); actions.className = "history-actions navigation-record-actions";
      const view = capturePresentation(item, { operator: false });
      if (isActiveCapture(item) || item.status === "completed") {
        const map = document.createElement("a"); map.className = "quiet-link"; map.href = view.map; map.textContent = "地图 ↗"; actions.append(map);
      }
      if (view.download) {
        const zip = document.createElement("a"); zip.className = "button secondary"; zip.href = view.download; zip.textContent = "下载 ZIP"; actions.append(zip);
      }
      content.append(actions); row.append(content); list.append(row);
    }
  };
  let storage = null; try { storage = window.localStorage; } catch { }
  const client = new NavigationClient({ storage, onChange: state => {
    byId("navigationStatus").textContent = state.checking ? "正在连接 Peak导航服务…"
      : !state.configured ? "导航服务暂不可用，请稍后再试。" : "输入房间号查询导航或录像";
    byId("navigationStatus").hidden = !state.checking && state.configured;
    byId("navigationError").hidden = !state.error; byId("navigationError").textContent = state.error;
    byId("navigationStart").disabled = state.busy || state.checking || !state.configured;
    byId("navigationStart").textContent = state.pendingRoom ? "重试接入" : "查询房间";
    byId("navigationRoom").disabled = state.busy || Boolean(state.pendingRoom);
    if (state.pendingRoom) byId("navigationRoom").value = state.pendingRoom;
    const list = byId("navigationHistoryList");
    byId("navigationHistoryPanel").hidden = state.navigationHistory.length === 0;
    byId("navigationHistoryEmpty").hidden = state.navigationHistory.length > 0;
    byId("navigationHistoryRefresh").disabled = state.checking || !state.configured || state.busy;
    byId("navigationHistoryClear").disabled = state.navigationHistory.length === 0;
    renderRows(list, state.navigationHistory);
    const result = state.roomResult;
    byId("navigationRoomHistory").hidden = !result?.history.length;
    byId("navigationRoomHistoryCode").textContent = result?.roomCode ?? "";
    byId("navigationRoomHistoryMore").hidden = !result?.hasMore;
    renderRows(byId("navigationRoomHistoryList"), result?.history ?? []);
    byId("navigationNewGame").hidden = !result?.history.length || Boolean(result?.active);
    byId("navigationNewGame").disabled = state.busy || Boolean(state.pendingRoom);
    byId("navigationNewGameHint").hidden = byId("navigationNewGame").hidden;
    const capture = state.capture;
    byId("navigationCapture").hidden = !capture;
    if (!capture) return;
    const view = capturePresentation(capture, { operator: false });
    byId("navigationCapture").dataset.status = capture.status;
    byId("navigationTitle").textContent = capture.status === "recording" ? "导航进行中" : capture.status === "connecting" ? "正在接入房间" : capture.status === "completed" ? "导航已结束" : view.title;
    byId("navigationDescription").textContent = capture.status === "recording" ? "正在同步队伍位置。" : view.description;
    byId("navigationDescription").hidden = ["completed", "recording"].includes(capture.status);
    byId("navigationShared").hidden = !state.reused || !isActiveCapture(capture);
    byId("navigationCaptureRoom").textContent = capture.roomCode;
    byId("navigationCaptureHost").textContent = capture.hostName || "等待识别房主";
    byId("navigationCaptureHost").title = capture.hostName || "等待识别房主";
    byId("navigationStarted").textContent = startedLabel(capture.startedUtc);
    if (capture.startedUtc) byId("navigationStarted").dateTime = capture.startedUtc;
    const image = byId("navigationArtwork"), source = artwork(capture);
    if (image.getAttribute("src") !== source) {
      image.hidden = false; image.parentElement.classList.remove("is-fallback"); image.src = source;
    }
    byId("navigationFeature").textContent = capture.featureCode;
    byId("navigationNote").hidden = !view.note; byId("navigationNote").textContent = view.note;
    byId("navigationMap").href = view.map;
    byId("navigationMap").hidden = !isActiveCapture(capture) && capture.status !== "completed";
    byId("navigationRefresh").disabled = state.busy;
    byId("navigationZip").hidden = !view.download;
    if (view.download) byId("navigationZip").href = view.download;
    else byId("navigationZip").removeAttribute("href");
  } });
  const initialRoom = normalizeRoom(new URL(window.location.href).searchParams.get("room"));
  if (validRoom(initialRoom)) byId("navigationRoom").value = initialRoom;
  byId("navigationForm").addEventListener("submit", event => { event.preventDefault(); void client.findRoom(byId("navigationRoom").value); });
  byId("navigationNewGame").addEventListener("click", () => { const result = client.state.roomResult; if (result && !result.active) void client.start(result.roomCode); });
  byId("navigationRefresh").addEventListener("click", () => { const capture = client.state.capture; if (capture) void client.lookup(capture.roomCode, capture.featureCode); });
  byId("navigationHistoryRefresh").addEventListener("click", () => { void client.refreshHistory(); });
  byId("navigationHistoryClear").addEventListener("click", () => client.clearHistory());
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
  void client.initialize();
  return client;
}

export function mountPacketRecorder(document, window) {
  const byId = id => document.getElementById(id);
  if (new URL(window.location.href).searchParams.get("operator") === "1") byId("managementPanel").open = true;
  let storage = null; try { storage = window.sessionStorage; } catch { }
  const client = new PacketRecorder({ storage, libraryEnabled: true, onChange: state => {
    const capture = state.capture, active = isActiveCapture(capture);
    byId("connectionStatus").textContent = state.checking ? "正在检查录制服务…" : !state.configured ? "录制服务尚未配置，请联系管理员。" : state.authenticated ? "管理已解锁 · 采集账号由服务器管理" : "请输入访问码解锁录制管理。";
    byId("loginPanel").hidden = state.checking || !state.configured || state.authenticated;
    byId("recorderWorkspace").hidden = !state.authenticated;
    byId("recordError").hidden = !state.error; byId("recordError").textContent = state.error;
    byId("loginButton").disabled = state.busy; byId("accessCode").disabled = state.busy;
    byId("logoutButton").disabled = state.busy;
    byId("startButton").disabled = state.busy; byId("startButton").textContent = state.pendingRoom ? "重试开始" : "启动或接入房间";
    byId("roomCode").disabled = state.busy || Boolean(state.pendingRoom);
    if (state.pendingRoom) byId("roomCode").value = state.pendingRoom;
    for (const id of ["lookupButton", "lookupRoom", "lookupFeature"]) byId(id).disabled = state.busy || Boolean(state.pendingRoom);
    byId("libraryRefresh").disabled = state.busy;
    byId("activeRefresh").disabled = state.busy;
    byId("activeCount").textContent = `${state.activeCaptures.length} 个房间`;
    byId("activeEmpty").hidden = state.activeCaptures.length > 0;
    byId("activeEmpty").textContent = state.libraryLoaded ? "当前没有正在导航的房间。" : "正在读取房间…";
    const activeList = byId("activeList"); activeList.replaceChildren();
    for (const item of state.activeCaptures) {
      const selected = item.roomCode === capture?.roomCode && item.featureCode === capture?.featureCode;
      const row = document.createElement("div"); row.className = "history-row active-row"; row.dataset.selected = String(selected);
      const info = document.createElement("div"), label = document.createElement("p"), detail = document.createElement("small");
      label.textContent = `${item.roomCode} · ${item.hostName || "等待识别房主"}`;
      detail.textContent = `${capturePresentation(item).title} · ${item.featureCode}`;
      info.append(label, detail);
      const select = document.createElement("button"); select.type = "button"; select.className = "secondary";
      select.textContent = selected ? "当前房间" : "查看管理"; select.disabled = state.busy || selected || Boolean(state.pendingRoom);
      select.setAttribute("aria-pressed", String(selected));
      select.addEventListener("click", () => { void client.lookup(item.roomCode, item.featureCode); });
      row.append(info, select); activeList.append(row);
    }
    const history = byId("historyList"); history.replaceChildren();
    const groups = groupHistory(state.history);
    byId("historyEmpty").hidden = groups.length > 0;
    byId("historyEmpty").textContent = state.libraryLoaded ? "暂时没有可下载的录像。结束录制后，录像会出现在这里。" : "正在读取录像…";
    byId("historyMore").hidden = !state.hasMore;
    for (const group of groups) {
      const section = document.createElement("section"); section.className = "history-group";
      const title = document.createElement("h3"); title.textContent = group.name; section.append(title);
      for (const item of group.captures) {
        const row = document.createElement("div"); row.className = "history-row";
        const label = document.createElement("p"); label.textContent = `${item.roomCode} · ${item.featureCode}`;
        const detail = document.createElement("small"); detail.textContent = `${formatBytes(item.zipBytes)} · ${new Date(item.expiresUtc).toLocaleDateString("zh-CN")} 到期`;
        const info = document.createElement("div"); info.append(label, detail);
        const link = document.createElement("a"); link.className = "button secondary"; link.textContent = "下载 ZIP";
        link.href = capturePresentation(item).download; link.download = "";
        row.append(info, link); section.append(row);
      }
      history.append(section);
    }
    byId("capturePanel").hidden = !capture;
    if (!capture) return;
    const view = capturePresentation(capture);
    byId("captureTitle").textContent = view.title; byId("captureDescription").textContent = view.description;
    byId("captureBadge").textContent = view.title; byId("captureBadge").dataset.status = capture.status;
    byId("captureRoom").textContent = capture.roomCode; byId("captureFeature").textContent = capture.featureCode;
    byId("captureHost").textContent = capture.hostName || "等待识别房主";
    byId("captureBytes").textContent = formatBytes(capture.bytes); byId("captureEvents").textContent = capture.events.toLocaleString("zh-CN");
    byId("captureNote").hidden = !view.note; byId("captureNote").textContent = view.note;
    byId("stopButton").hidden = !active; byId("stopButton").disabled = state.busy || capture.status === "stopping";
    byId("stopButton").textContent = capture.status === "connecting" ? "取消加入" : "停止并保存";
    byId("refreshButton").disabled = state.busy;
    byId("downloadLink").hidden = !view.download; byId("playbackHint").hidden = !view.download;
    byId("mapLink").href = view.map; byId("mapLink").hidden = !active && capture.status !== "completed";
    byId("rawDownloadLink").hidden = !view.rawDownload;
    if (view.rawDownload) { byId("rawDownloadLink").href = view.rawDownload; byId("rawDownloadLink").download = `${capture.roomCode}-${capture.featureCode}.peaknet`; }
    else byId("rawDownloadLink").removeAttribute("href");
    if (view.download) { byId("downloadLink").href = view.download; byId("downloadLink").download = ""; }
    else byId("downloadLink").removeAttribute("href");
  } });
  byId("loginForm").addEventListener("submit", event => { event.preventDefault(); const code = byId("accessCode").value; byId("accessCode").value = ""; void client.login(code); });
  byId("startForm").addEventListener("submit", event => { event.preventDefault(); void client.start(byId("roomCode").value); });
  byId("lookupForm").addEventListener("submit", event => { event.preventDefault(); void client.lookup(byId("lookupRoom").value, byId("lookupFeature").value); });
  byId("stopButton").addEventListener("click", () => { void client.stop(); });
  byId("refreshButton").addEventListener("click", () => { const capture = client.state.capture; if (capture) void client.lookup(capture.roomCode, capture.featureCode); });
  byId("logoutButton").addEventListener("click", () => { void client.logout(); });
  byId("libraryRefresh").addEventListener("click", () => { void client.action(() => client.refreshLibrary()); });
  byId("activeRefresh").addEventListener("click", () => { void client.action(() => client.refreshLibrary()); });
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
  // A restored back-forward-cache page needs fresh cookies and a new polling lifecycle.
  window.addEventListener("pageshow", event => { if (event.persisted) window.location.reload(); });
  void client.initialize();
  return client;
}
if (typeof document !== "undefined" && document.querySelector("[data-packet-recorder]")) {
  mountNavigation(document, window);
  mountPacketRecorder(document, window);
}
