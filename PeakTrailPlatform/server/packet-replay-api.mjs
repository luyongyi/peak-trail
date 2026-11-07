import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isIP } from "node:net";

const PREFIX = "/api/packet-replay";
const NAVIGATION = "/api/navigation";
const COOKIE = "peak_packet_session";
const ROOM = /^[A-P][A-Z0-9]{5}$/;
const FEATURE = /^[A-F0-9]{20}$/;
const STATES = new Set(["connecting", "recording", "stopping", "completed", "cancelled", "failed", "interrupted", "expired"]);
const CODES = new Set([
  "invalid_room_code", "invalid_identity", "idempotency_key_required", "idempotency_conflict",
  "capture_worker_busy", "capture_busy", "capture_capacity", "capture_configuration_invalid", "capture_failed", "capture_storage_unavailable",
  "capture_not_active", "capture_in_progress", "invalid_feature_code", "service_stopping", "archive_unreadable",
  "capture_not_found", "not_found", "capture_not_completed", "archive_not_ready", "archive_unavailable", "archive_missing",
  "capture_unavailable", "capture_interrupted", "archive_finalization_failed", "unexpected_end", "local_error",
  "room_full", "room_not_found", "room_closed", "join_failed", "connection_failed", "authentication_failed",
  "disconnected", "left_room", "room_empty", "host_kicked", "master_role_unsupported", "size_limit",
  "service_shutdown", "requested", "interrupted", "error", "steam_broker_configuration", "steam_broker_unavailable",
  "steam_refresh_token_missing", "steam_refresh_token_invalid", "steam_refresh_token_permissions", "steam_login_failed",
  "steam_login_timeout", "steam_playing_blocked", "steam_ticket_failed", "steam_ticket_timeout", "steam_ticket_invalid",
  "steam_identity_invalid", "steam_session_disconnected", "steam_protocol_invalid", "steam_shutdown_timeout", "steam_broker_failed",
  "steam_session_busy", "steam_login_required", "steam_broker_timeout", "steam_broker_ended", "steam_broker_protocol",
  "steam_ticket_reused", "steam_ticket_capacity",
  "archive_expired", "capture_expired", "game_ended", "live_unavailable", "metadata_write_failed", "process_interrupted", "idempotency_capacity",
]);
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_BYTES = MAX_FILE_BYTES + 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest();
const localAddress = address => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function collectorOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function responseJson(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
  res.end(JSON.stringify(body));
}
function fail(res, status, code) { responseJson(res, status, { code, error: code, message: "采集请求未完成，请检查状态后重试。" }); }

async function requestJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new Error("invalid_request");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error("invalid_request");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!object(value)) throw new Error("invalid_request");
  return value;
}

async function upstreamJson(response, maxBytes = 32768) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel(); throw new Error("upstream_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("upstream_invalid_response");
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("upstream_invalid_response");
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(value)) throw new Error("upstream_invalid_response");
    return value;
  } catch { await reader.cancel().catch(() => {}); throw new Error("upstream_invalid_response"); }
  finally { reader.releaseLock(); }
}

function captureDto(value, expectedRoom = null, expectedFeature = null) {
  if (!object(value) || !ROOM.test(value.roomCode) || !FEATURE.test(value.featureCode) || !STATES.has(value.status) ||
    value.coverage !== "from-join" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_FILE_BYTES ||
    !Number.isSafeInteger(value.events) || value.events < 0 ||
    (expectedRoom && value.roomCode !== expectedRoom) || (expectedFeature && value.featureCode !== expectedFeature))
    throw new Error("upstream_invalid_response");
  const date = raw => typeof raw === "string" && raw.length <= 40 && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
  const startedUtc = date(value.startedUtc), completedUtc = value.completedUtc === null ? null : date(value.completedUtc);
  if (!startedUtc || value.completedUtc !== null && !completedUtc) throw new Error("upstream_invalid_response");
  const errorCode = value.errorCode === null || value.errorCode === undefined ? null : CODES.has(value.errorCode) ? value.errorCode : "capture_failed";
  const endReason = value.endReason == null || value.endReason === "" ? "" : CODES.has(value.endReason) ? value.endReason : "unexpected_end";
  return { roomCode: value.roomCode, featureCode: value.featureCode, status: value.status,
    bytes: value.bytes, events: value.events, startedUtc, completedUtc, coverage: "from-join", endReason, errorCode,
    hostKey: typeof value.hostKey === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(value.hostKey) ? value.hostKey : null,
    hostName: typeof value.hostName === "string" ? value.hostName.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 100) : null,
    archiveAvailable: value.archiveAvailable === true,
    zipBytes: Number.isSafeInteger(value.zipBytes) && value.zipBytes >= 0 && value.zipBytes <= MAX_ZIP_BYTES ? value.zipBytes : 0,
    expiresUtc: date(value.expiresUtc),
    photonReturnCode: Number.isInteger(value.photonReturnCode) && Math.abs(value.photonReturnCode) <= 2147483647 ? value.photonReturnCode : null,
    errors: errorCode ? ["采集未正常完成，请根据错误代码检查认证、房间或服务状态。"] : [],
    warnings: Array.isArray(value.warnings) && value.warnings.length ? ["本次只保存了已收到的录像片段，请查看结束原因。"] : [],
  };
}

function captureListDto(value) {
  if (!object(value) || !Array.isArray(value.history) || value.history.length > 100 || typeof value.hasMore !== "boolean")
    throw new Error("upstream_invalid_response");
  const active = value.active === null ? null : captureDto(value.active);
  const supplied = value.activeCaptures === undefined ? (active ? [active] : []) : value.activeCaptures;
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error("upstream_invalid_response");
  const activeCaptures = supplied.map(item => captureDto(item));
  const rooms = new Set();
  for (const capture of activeCaptures) {
    if (!["connecting", "recording", "stopping"].includes(capture.status) || rooms.has(capture.roomCode))
      throw new Error("upstream_invalid_response");
    rooms.add(capture.roomCode);
  }
  const first = activeCaptures[0] ?? null;
  if (Boolean(active) !== Boolean(first) || active && (active.roomCode !== first.roomCode ||
    active.featureCode !== first.featureCode || active.status !== first.status)) throw new Error("upstream_invalid_response");
  return { active, activeCaptures, history: value.history.map(item => captureDto(item)),
    hasMore: value.hasMore, retention: { maxPerHost: 2, maxAgeDays: 7 } };
}

// A caller must explicitly supply the one room code being queried. Never use
// the administrator's global capture list to implement this public lookup.
function roomCapturesDto(value, room) {
  if (!object(value) || value.roomCode !== room || !Array.isArray(value.history) ||
      value.history.length > 20 || typeof value.hasMore !== "boolean") throw new Error("upstream_invalid_response");
  const active = value.active === null ? null : captureDto(value.active, room);
  if (active && !["connecting", "recording", "stopping"].includes(active.status)) throw new Error("upstream_invalid_response");
  const features = new Set(active ? [active.featureCode] : []);
  const history = value.history.map(item => {
    const capture = captureDto(item, room);
    if (capture.status !== "completed" || !capture.archiveAvailable || !capture.completedUtc || features.has(capture.featureCode))
      throw new Error("upstream_invalid_response");
    features.add(capture.featureCode);
    return capture;
  });
  return { roomCode: room, active, history, hasMore: value.hasMore };
}

const displayName = value => typeof value === "string"
  ? Array.from(value.toWellFormed().replace(/[\u0000-\u001f\u007f-\u009f]/g, "")).slice(0, 100).join("") : "";
const count = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const playerId = value => typeof value === "string" && /^p[1-9][0-9]{0,9}$/.test(value) && Number(value.slice(1)) <= 2147483647;
const finite = (value, maximum) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= maximum;
const LIVE_WARNINGS = new Set(["unsupported_game_fingerprint", "unverified_resource_fingerprint", "room_host_identity_unavailable",
  "non_monotonic_packet_time", "invalid_packet_payload", "unsupported_record_kind", "invalid_room_snapshot",
  "character_delta_without_baseline", "character_payload_invalid", "actor_limit", "view_limit"]);

// Only the audited position projection crosses this boundary. Raw Photon objects,
// Steam IDs, authentication fields and arbitrary upstream metadata never do.
function liveDto(value, room, feature) {
  const capture = captureDto(value?.capture, room, feature), raw = value?.live;
  if (raw === null) return { capture, live: null };
  if (!object(raw) || raw.roomCode !== room || !count(raw.sceneEpoch, 2147483647) || !count(raw.lastSequence) ||
      !Array.isArray(raw.records) || raw.records.length > 10000 || !Array.isArray(raw.players) || raw.players.length > 1024 ||
      raw.coordinateSpace !== "unity-world-meters" || raw.timeUnit !== "milliseconds") throw new Error("upstream_invalid_response");
  let previous = 0;
  const records = raw.records.map(entry => {
    if (!object(entry) || !count(entry.sequence) || entry.sequence <= previous || entry.sequence > raw.lastSequence ||
        entry.sceneEpoch !== raw.sceneEpoch || !["participant", "sample"].includes(entry.type) ||
        !playerId(entry.playerId) || !finite(entry.t, 1e12) || entry.t < 0) throw new Error("upstream_invalid_response");
    previous = entry.sequence;
    const record = { type: entry.type, t: entry.t, playerId: entry.playerId };
    if (entry.type === "participant") record.nickname = displayName(entry.nickname) || entry.playerId;
    else {
      if (!Array.isArray(entry.pos) || entry.pos.length !== 3 || !entry.pos.every(number => finite(number, 1e7)))
        throw new Error("upstream_invalid_response");
      record.pos = entry.pos;
      if (finite(entry.yaw, 1e6)) record.yaw = entry.yaw;
      if (Number.isInteger(entry.activeSegment) && entry.activeSegment >= -1 && entry.activeSegment <= 1000)
        record.activeSegment = entry.activeSegment;
    }
    return { sequence: entry.sequence, record };
  });
  const participants = raw.players.filter(player => object(player) && !player.isCollector && playerId(player.playerId))
    .map(player => ({ playerId: player.playerId, nickname: displayName(player.name) || player.playerId }));
  const sceneName = typeof raw.sceneName === "string" && /^(?:Airport|MainMenu|(?:Level|Map)_[0-9]{1,6})$/.test(raw.sceneName) ? raw.sceneName : null;
  const gameBuildId = typeof raw.gameBuildId === "string" && /^[0-9]{1,20}$/.test(raw.gameBuildId) ? raw.gameBuildId : null;
  const gameVersion = typeof raw.gameVersion === "string" && /^[0-9][A-Za-z0-9.+_-]{0,39}$/.test(raw.gameVersion) ? raw.gameVersion : null;
  const projectionVersion = count(raw.projectionVersion, 1000) && raw.projectionVersion > 0 ? raw.projectionVersion : null;
  const slot = /^(?:Level|Map)_([0-9]{1,6})$/.exec(sceneName ?? "");
  const manifest = slot && gameBuildId && projectionVersion && raw.positionProjectionSupported === true ? {
    schemaVersion: 1, sessionId: `${room}.${feature}`, sceneName, gameVersion, gameBuildId, projectionVersion,
    mapSlot: Number(slot[1]), coordinateSpace: "unity-world-meters", timeUnit: "milliseconds",
    positionAuthority: "photon-character-hip", identityMode: "session-player-id", segmentResolution: "unassigned",
    startedAtUtc: capture.startedUtc, participants,
  } : null;
  return { capture, live: { sceneEpoch: raw.sceneEpoch, lastSequence: raw.lastSequence, records, manifest,
    sceneName, gameBuildId, hostName: capture.hostName, positionProjectionSupported: raw.positionProjectionSupported === true,
    positionSamples: count(raw.positionSamples) ? raw.positionSamples : 0,
    lastPacketSeconds: finite(raw.lastPacketSeconds, 1e9) && raw.lastPacketSeconds >= 0 ? raw.lastPacketSeconds : null,
    warnings: Array.isArray(raw.warnings) ? [...new Set(raw.warnings.filter(item => LIVE_WARNINGS.has(item)))].slice(0, 32) : [],
  } };
}

function zipDisposition(capture, room, feature) {
  const host = displayName(capture.hostName || "PEAK").normalize("NFC").replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, "_")
    .replace(/^[. ]+|[. ]+$/g, "").slice(0, 64) || "PEAK";
  const name = `${host}-${room}-${feature}.zip`;
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${room}-${feature}.zip"; filename*=UTF-8''${encoded}`;
}

/** Operator sessions stay in memory; Steam credentials and the collector key never reach the browser. */
export function createPacketReplayApi(options = {}) {
  const env = options.env ?? process.env;
  const operatorKey = options.operatorKey ?? env.PEAK_CAPTURE_OPERATOR_KEY ?? "";
  const apiKey = options.apiKey ?? env.PEAK_CAPTURE_API_KEY ?? "";
  const origin = collectorOrigin(options.collectorUrl ?? env.PEAK_CAPTURE_URL ?? "http://127.0.0.1:17863");
  const configured = typeof operatorKey === "string" && operatorKey.length >= 16 && operatorKey.length <= 512 &&
    typeof apiKey === "string" && apiKey.length >= 32 && apiKey.length <= 4096 && !/[\r\n]/.test(apiKey) && operatorKey !== apiKey && Boolean(origin);
  const expectedKey = digest(String(operatorKey));
  const now = options.now ?? Date.now;
  const ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 180000;
  const sessions = new Map(), attempts = new Map(), navigationAttempts = new Map(), activeRequests = new Set();
  let navigationGlobal = [];
  let globalAttempts = [], closed = false;

  function secure(req) {
    return Boolean(req.socket.encrypted || options.trustedProxy && localAddress(req.socket.remoteAddress) && req.headers["x-forwarded-proto"] === "https");
  }
  function sameOrigin(req) {
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const supplied = req.headers.origin;
    if (typeof supplied !== "string" || supplied.length > 512 || typeof req.headers.host !== "string") return false;
    try { return new URL(supplied).origin === supplied && supplied === `${secure(req) ? "https" : "http"}://${req.headers.host}`; }
    catch { return false; }
  }
  function session(req) {
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    const cookies = (req.headers.cookie ?? "").split(";").map(item => item.trim()).filter(item => item.startsWith(`${COOKIE}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const key = digest(token).toString("hex");
    return sessions.has(key) ? key : null;
  }
  function cookie(req, token, age) {
    return `${COOKIE}=${token}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${age}${secure(req) ? "; Secure" : ""}`;
  }
  function loginLimited(req) {
    const time = now(), cutoff = time - 60000;
    for (const [key, values] of attempts) { const recent = values.filter(value => value > cutoff); if (recent.length) attempts.set(key, recent); else attempts.delete(key); }
    globalAttempts = globalAttempts.filter(value => value > cutoff);
    const address = req.socket.remoteAddress ?? "unknown";
    const values = attempts.get(address) ?? [];
    if (values.length >= 6 || globalAttempts.length >= 30 || attempts.size >= 1000 && !attempts.has(address)) return true;
    values.push(time); attempts.set(address, values); globalAttempts.push(time); return false;
  }

  function navigationLimited(req) {
    const time = now(), cutoff = time - 60000;
    for (const [key, values] of navigationAttempts) {
      const recent = values.filter(value => value > cutoff);
      if (recent.length) navigationAttempts.set(key, recent); else navigationAttempts.delete(key);
    }
    navigationGlobal = navigationGlobal.filter(value => value > cutoff);
    const forwarded = req.headers["x-real-ip"];
    const address = options.trustedProxy && localAddress(req.socket.remoteAddress) && typeof forwarded === "string" && isIP(forwarded)
      ? forwarded : req.socket.remoteAddress ?? "unknown";
    const recent = navigationAttempts.get(address) ?? [];
    if (recent.length >= (options.navigationStartsPerMinute ?? 60) || navigationGlobal.length >= 300 ||
        navigationAttempts.size >= 1000 && !navigationAttempts.has(address)) return true;
    recent.push(time); navigationAttempts.set(address, recent); navigationGlobal.push(time);
    return false;
  }

  async function proxy(req, res, path, { body, room, feature, file = false, zip = false, list = false, live = false, navigationStart = false, roomLookup = false } = {}) {
    const controller = new AbortController();
    activeRequests.add(controller);
    const timer = setTimeout(() => controller.abort(), file ? downloadTimeoutMs : requestTimeoutMs);
    timer.unref?.();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const headers = { authorization: `Bearer ${apiKey}` };
      let archiveCapture;
      if (zip) {
        const metadata = await fetch(`${origin}/api/v1/captures/${room}/${feature}`, {
          headers, redirect: "error", signal: controller.signal });
        if (!metadata.ok) { await metadata.body?.cancel(); return fail(res, [404, 410].includes(metadata.status) ? metadata.status : 502, "archive_unavailable"); }
        archiveCapture = captureDto(await upstreamJson(metadata), room, feature);
        if (!archiveCapture.archiveAvailable) return fail(res, 410, "archive_unavailable");
      }
      if (body !== undefined) { headers["content-type"] = "application/json"; headers["idempotency-key"] = req.headers["idempotency-key"]; }
      if (file && req.headers.range) headers.range = req.headers.range;
      const response = await fetch(`${origin}/api/v1${path}`, { method: roomLookup ? "GET" : req.method, headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: controller.signal });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return fail(res, 502, "collector_auth_failed"); }
      if (file && (response.status === 200 || response.status === 206)) {
        const length = response.headers.get("content-length"), range = response.headers.get("content-range");
        const contentType = zip ? "application/zip" : "application/octet-stream", maximum = zip ? MAX_ZIP_BYTES : MAX_FILE_BYTES;
        if (response.headers.get("content-type")?.split(";")[0] !== contentType ||
          length !== null && (!/^\d+$/.test(length) || Number(length) > maximum) ||
          response.status === 206 && (!range || !/^bytes \d+-\d+\/\d+$/.test(range))) {
          await response.body?.cancel(); throw new Error("upstream_invalid_response");
        }
        const outputHeaders = { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-disposition": zip ? zipDisposition(archiveCapture, room, feature) : `attachment; filename="${room}-${feature}.peaknet"`, "accept-ranges": "bytes" };
        if (length !== null) outputHeaders["content-length"] = length;
        if (response.status === 206) outputHeaders["content-range"] = range;
        let total = 0;
        const limit = new Transform({ transform(chunk, encoding, done) { total += chunk.length; done(total > maximum ? new Error("file_limit") : null, chunk); } });
        if (!response.body) throw new Error("upstream_invalid_response");
        res.writeHead(response.status, outputHeaders);
        await pipeline(Readable.fromWeb(response.body), limit, res, { signal: controller.signal });
        return;
      }
      if (file && response.status === 416) {
        const range = response.headers.get("content-range");
        await response.body?.cancel();
        return responseJson(res, 416, { code: "range_not_satisfiable" }, /^bytes \*\/\d+$/.test(range ?? "") ? { "content-range": range } : {});
      }
      const value = await upstreamJson(response, live ? 4 * 1024 * 1024 : list || roomLookup ? 256 * 1024 : 32768);
      if (!response.ok) {
        const status = [400, 404, 409, 410, 413, 429, 503].includes(response.status) ? response.status : 502;
        return fail(res, status, CODES.has(value.code) ? value.code : "collector_unavailable");
      }
      if (![200, 202].includes(response.status) || file) throw new Error("upstream_invalid_response");
      if (roomLookup) {
        if (response.status !== 200) throw new Error("upstream_invalid_response");
        return responseJson(res, 200, roomCapturesDto(value, room));
      }
      if (navigationStart) {
        const created = captureDto(value, room);
        // Idempotency can return the original creation snapshot after completion.
        // Resolve its current status; never fabricate a fresh run for an old key.
        const current = await fetch(`${origin}/api/v1/captures/${room}/${created.featureCode}`, {
          headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: controller.signal });
        if (!current.ok) { await current.body?.cancel(); throw new Error("upstream_invalid_response"); }
        const capture = captureDto(await upstreamJson(current), room, created.featureCode);
        return responseJson(res, response.status, { capture, reused: response.status === 200 });
      }
      responseJson(res, response.status, list ? captureListDto(value) : live ? liveDto(value, room, feature) : captureDto(value, room, feature));
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); }
      else fail(res, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "upstream_timeout" : error.message === "upstream_invalid_response" ? "upstream_invalid_response" : "collector_unavailable");
    } finally {
      clearTimeout(timer); activeRequests.delete(controller);
      req.removeListener("aborted", cancel); res.removeListener("close", cancel);
    }
  }

  async function handle(req, res) {
    const rawPath = (req.url ?? "").split("?")[0];
    const navigation = rawPath === NAVIGATION || rawPath.startsWith(`${NAVIGATION}/`);
    if (!navigation && rawPath !== PREFIX && !rawPath.startsWith(`${PREFIX}/`)) return false;
    try {
      if (navigation) {
        // A fresh page receives no rooms or recordings. An explicit room-code
        // lookup can recover retained recordings for that code on another
        // device; feature codes still distinguish the individual recordings.
        if ((req.url ?? "").includes("?") || rawPath.includes("%")) { fail(res, 400, "invalid_request"); return true; }
        if (rawPath === `${NAVIGATION}/session` && req.method === "GET") {
          responseJson(res, 200, { configured: configured && !closed, captures: [] }); return true;
        }
        if (closed || !configured) { fail(res, 503, "collector_unavailable"); return true; }
        if (rawPath === `${NAVIGATION}/rooms/lookup` && req.method === "POST") {
          if (!sameOrigin(req)) { fail(res, 403, "forbidden_origin"); return true; }
          const body = await requestJson(req);
          const room = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
          if (Object.keys(body).length !== 1 || !ROOM.test(room)) { fail(res, 400, "invalid_room_code"); return true; }
          if (navigationLimited(req)) { fail(res, 429, "rate_limited"); return true; }
          await proxy(req, res, `/rooms/${room}/captures`, { room, roomLookup: true }); return true;
        }
        if (rawPath === `${NAVIGATION}/rooms` && req.method === "POST") {
          if (!sameOrigin(req)) { fail(res, 403, "forbidden_origin"); return true; }
          const body = await requestJson(req);
          const room = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
          if (Object.keys(body).length !== 1 || !ROOM.test(room)) { fail(res, 400, "invalid_room_code"); return true; }
          if (typeof req.headers["idempotency-key"] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(req.headers["idempotency-key"])) {
            fail(res, 400, "idempotency_key_required"); return true;
          }
          if (navigationLimited(req)) { fail(res, 429, "rate_limited"); return true; }
          await proxy(req, res, "/captures", { body: { roomCode: room }, room, navigationStart: true }); return true;
        }
        const match = rawPath.slice(NAVIGATION.length).match(/^\/(captures|replays)\/([A-P][A-Z0-9]{5})\/([A-F0-9]{20})(\/live|\/archive\.zip)?$/);
        if (match) {
          const [, kind, room, feature, tail = ""] = match;
          const live = kind === "captures" && tail === "/live", status = kind === "captures" && tail === "";
          const zip = kind === "replays" && tail === "/archive.zip";
          if (req.method !== "GET" || !live && !status && !zip) { fail(res, 405, "method_not_allowed"); return true; }
          if (zip && req.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) { fail(res, 400, "invalid_request"); return true; }
          await proxy(req, res, `/${kind}/${room}/${feature}${tail}`, { room, feature, live, file: zip, zip }); return true;
        }
        fail(res, 404, "not_found"); return true;
      }
      if (closed || !configured) {
        if (rawPath === `${PREFIX}/session` && req.method === "GET") responseJson(res, 200, { configured: false, authenticated: false });
        else fail(res, 503, "collector_unavailable");
        return true;
      }
      if ((req.url ?? "").includes("?") || rawPath.includes("%")) { fail(res, 400, "invalid_request"); return true; }
      const authenticated = session(req);
      if (["POST", "DELETE"].includes(req.method) && !sameOrigin(req)) { fail(res, 403, "forbidden_origin"); return true; }
      if (rawPath === `${PREFIX}/session`) {
        if (req.method === "GET") responseJson(res, 200, { configured: true, authenticated: Boolean(authenticated) });
        else if (req.method === "DELETE") { if (authenticated) sessions.delete(authenticated); responseJson(res, 200, { configured: true, authenticated: false }, { "set-cookie": cookie(req, "", 0) }); }
        else if (req.method === "POST") {
          if (loginLimited(req)) { fail(res, 429, "rate_limited"); return true; }
          const body = await requestJson(req);
          if (Object.keys(body).length !== 1 || typeof body.accessCode !== "string" || body.accessCode.length > 512 ||
            !timingSafeEqual(digest(body.accessCode), expectedKey)) { fail(res, 401, "invalid_access_code"); return true; }
          if (sessions.size >= 64) { fail(res, 429, "rate_limited"); return true; }
          if (authenticated) sessions.delete(authenticated);
          const token = randomBytes(32).toString("hex"); sessions.set(digest(token).toString("hex"), now() + ttl);
          responseJson(res, 200, { configured: true, authenticated: true }, { "set-cookie": cookie(req, token, Math.floor(ttl / 1000)) });
        } else fail(res, 405, "method_not_allowed");
        return true;
      }
      if (!authenticated) { fail(res, 401, "not_authenticated"); return true; }
      if (rawPath === `${PREFIX}/captures` && req.method === "GET") {
        await proxy(req, res, "/captures", { list: true }); return true;
      }
      if (rawPath === `${PREFIX}/captures` && req.method === "POST") {
        const body = await requestJson(req);
        const room = typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
        if (Object.keys(body).length !== 1 || !ROOM.test(room)) { fail(res, 400, "invalid_room_code"); return true; }
        if (typeof req.headers["idempotency-key"] !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(req.headers["idempotency-key"])) { fail(res, 400, "idempotency_key_required"); return true; }
        await proxy(req, res, "/captures", { body: { roomCode: room }, room }); return true;
      }
      const match = rawPath.slice(PREFIX.length).match(/^\/(captures|replays)\/([A-P][A-Z0-9]{5})\/([A-F0-9]{20})(\/stop|\/file|\/archive\.zip|\/live)?$/);
      if (match) {
        const [, kind, room, feature, tail = ""] = match;
        const zip = kind === "replays" && tail === "/archive.zip" && req.method === "GET";
        const file = kind === "replays" && (tail === "/file" || zip) && req.method === "GET";
        const live = kind === "captures" && tail === "/live" && req.method === "GET";
        const status = kind === "captures" && tail === "" && req.method === "GET";
        const stop = kind === "captures" && tail === "/stop" && req.method === "POST";
        if (!file && !status && !stop && !live) { fail(res, 405, "method_not_allowed"); return true; }
        if (stop && (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"])) { fail(res, 400, "invalid_request"); return true; }
        if (file && req.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(req.headers.range)) { fail(res, 400, "invalid_request"); return true; }
        await proxy(req, res, `/${kind}/${room}/${feature}${tail}`, { room, feature, file, zip, live }); return true;
      }
      fail(res, 404, "not_found");
    } catch { fail(res, 400, "invalid_request"); }
    return true;
  }
  return { handle, get configured() { return configured && !closed; }, close() { closed = true; sessions.clear(); attempts.clear(); navigationAttempts.clear(); navigationGlobal = [];
    for (const request of activeRequests) request.abort(); activeRequests.clear(); } };
}
