// Anonymous, capability-authorized live sharing. Watching never grants publishing.
import { randomBytes, timingSafeEqual } from "node:crypto";

export const LIVE_V2_LIMITS = Object.freeze({
  sessions: 200, players: 16, batchLines: 256, bodyBytes: 256 * 1024,
  recordBytes: 8 * 1024, manifestBytes: 32 * 1024,
  historyRecords: 12_000, historyBytes: 512 * 1024, historyMs: 120_000,
  stateBytes: 128 * 1024, snapshotBytes: 256 * 1024, globalBytes: 64 * 1024 * 1024,
  viewersPerSession: 20, viewers: 100, viewerBufferBytes: 512 * 1024,
  requestsPerMinute: 1_200, bytesPerMinute: 12 * 1024 * 1024,
  createsPerMinute: 60, readsPerMinute: 300, rateEntries: 5_000, concurrentBodies: 16,
  leaseMs: 15_000, endedAfterMs: 60_000, ttlMs: 24 * 60 * 60_000,
  endedRetentionMs: 15 * 60_000, heartbeatMs: 5_000,
});

const PREFIX = "/api/live/v2";
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Set(["participant", "sample", "state", "inventory", "appearance", "status", "route", "event"]);
const stateTypes = new Set(["participant", "sample", "state", "inventory", "appearance", "status", "route"]);
const eventStateFamilies = new Map([
  ["join", "presence"], ["leave", "presence"],
  ["death", "life"], ["revive", "life"],
  ["passed_out", "consciousness"], ["recovered", "consciousness"],
]);
const fail = (error, status = 400, extra = {}) => Object.assign(new Error(error), { status, extra });
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const nullable = (validate) => (value) => value === null ? null : validate(value);
const string = (max = 256) => (value) => {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f]/u.test(value)) throw fail("invalid-string");
  return value;
};
const number = (min = -1_000_000, max = 1_000_000) => (value) => {
  if (!Number.isFinite(value) || value < min || value > max) throw fail("invalid-number");
  return value;
};
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => (value) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw fail("invalid-integer");
  return value;
};
const bool = (value) => {
  if (typeof value !== "boolean") throw fail("invalid-boolean");
  return value;
};
const array = (item, max, min = 0) => (value) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw fail("invalid-array");
  return value.map(item);
};
function object(raw, shape, required = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("object-required");
  for (const key of Object.keys(raw)) if (!Object.hasOwn(shape, key)) throw fail("unsupported-field", 400, { field: key });
  for (const key of required) if (!Object.hasOwn(raw, key)) throw fail("missing-field", 400, { field: key });
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, shape[key](value)]));
}
const fields = (names, validator) => Object.fromEntries(names.split(" ").map((name) => [name, validator]));
const text = nullable(string());
const num = nullable(number());
const flag = nullable(bool);
const playerId = nullable((value) => {
  if (typeof value !== "string" || !/^p\d{1,3}$/.test(value)) throw fail("anonymous-player-id-required");
  return value;
});
const pos = nullable(array(number(-1_000_000, 1_000_000), 3, 3));
const item = nullable((raw) => object(raw, {
  ...fields("id itemId", (value) => value === null ? null : typeof value === "number" ? integer(0, 1_000_000)(value) : string(100)(value)),
  ...fields("name displayName prefabName nameKey", text), ...fields("slot count", num),
}));
const slot = (raw) => object(raw, {
  ...fields("location container", text),
  slotId: (value) => value === null ? null : typeof value === "number" ? integer(0, 100_000)(value) : string(100)(value),
  index: num, empty: flag, item,
});
const route = nullable((raw) => object(raw, {
  authority: text, branch: text,
  segments: array((entry) => object(entry, {
    ...fields("index biomeId variantBiomeIndex", nullable(integer(-1, 1_000))),
    ...fields("biome name", text), variantSelected: flag,
  }), 16),
}));
const appearance = nullable((raw) => object(raw, {
  ...fields("ready formReady formRendererActive", flag),
  ...fields("authority source outfitName hatName form formAuthority formMeshName", text),
  ...fields("skinIndex eyesIndex mouthIndex accessoryIndex outfitIndex hatIndex effectiveHatIndex sashIndex medalIndex", nullable(integer(-1, 100_000))),
  skinColor: nullable(array(number(0, 255), 4, 3)),
  formMaterialNames: array(string(), 16),
}));
const status = nullable((raw) => object(raw, {
  ...fields("ready complete dead effectsReady", flag),
  ...fields("authority source gameSource effectsAuthority", text),
  ...fields("statusSum baseMaxStamina maxStamina baseMaxExtraStamina maxExtraStamina", num),
  values: array((value) => object(value, {
    id: integer(0, 1_000), type: string(80), ...fields("amount staminaBlock extraStaminaBlock", num),
  }), 64),
  effects: array((value) => object(value, { typeId: integer(0, 100_000), type: string(80) }), 64),
}));
const stamina = {
  ...fields("telemetryReady capacityReady", flag), authority: text,
  ...fields("stamina baseMaxStamina baseMaxExtraStamina maxStamina stamina01 extraStamina maxExtraStamina extraStamina01 totalStamina", num),
};
const common = { type: string(20), t: number(0, LIVE_V2_LIMITS.ttlMs), playerId, activeSegment: nullable(integer(-1, 16)) };
const recordShapes = {
  participant: { nickname: string(100) },
  sample: { pos, yaw: number(-100_000, 100_000), ...stamina, item },
  state: { ...stamina },
  inventory: {
    ...fields("inventoryReady selectedSlotKnown heldPresent backpackContentsPresent backpackContentsReady", flag),
    authority: text, selectedSlot: num, held: item, slots: array(slot, 32), source: text,
  },
  appearance: { appearance },
  status: { status, reason: text },
  route: { route },
  event: {
    event: string(80), pos, source: text, confidence: text, cause: text, item,
    fromLocation: text, toLocation: text, targetPlayerId: playerId, throwCharge: num,
  },
};

export function validateLiveRecord(raw) {
  if (!TYPES.has(raw?.type)) throw fail("unsupported-record-type");
  const result = object(raw, { ...common, ...recordShapes[raw.type] }, ["type", "t"]);
  if (!["route", "event"].includes(raw.type) && !result.playerId) throw fail("player-id-required");
  if (raw.type === "sample" && !result.pos) throw fail("position-required");
  if (raw.type === "participant" && !Object.hasOwn(result, "nickname")) throw fail("nickname-required");
  if (raw.type === "event" && !result.event) throw fail("event-required");
  for (const key of ["appearance", "status", "route"]) if (raw.type === key && !result[key]) throw fail(`${key}-required`);
  return result;
}

export function validateLiveManifest(raw) {
  const result = object(raw, {
    schemaVersion: integer(1, 1), startedAtUtc: string(40),
    ...fields("gameVersion recorderVersion sceneName coordinateSpace positionAuthority segmentResolution activeSegmentSemantics timeUnit recordingScope identityMode", text),
    gameBuildId: (value) => typeof value === "number" ? String(integer(1)(value)) : string(40)(value),
    ...fields("levelIndex mapSlot projectionVersion", nullable(integer(0, 2_147_483_647))),
    sampleHz: number(0.1, 120), route,
  }, ["sceneName"]);
  if (!result.sceneName || !/^Level_\d+$/.test(result.sceneName)) throw fail("scene-name-required");
  if (result.coordinateSpace && result.coordinateSpace !== "unity-world-meters") throw fail("unsupported-coordinates");
  if (result.identityMode && result.identityMode !== "session-player-id") throw fail("anonymous-identity-required");
  if (result.timeUnit && result.timeUnit !== "milliseconds") throw fail("unsupported-time-unit");
  return { ...result, schemaVersion: 1, identityMode: "session-player-id", coordinateSpace: "unity-world-meters", timeUnit: "milliseconds" };
}

export function createLiveV2Api({ now = Date.now, limits: overrides = {}, trustedProxy = false,
  sweepIntervalMs = 1_000, pingIntervalMs = 15_000 } = {}) {
  const limits = { ...LIVE_V2_LIMITS, ...overrides };
  const sessions = new Map(), rooms = new Map(), watches = new Map(), rates = new Map();
  let residentBytes = 0, viewerCount = 0, activeBodies = 0, closed = false;
  const headers = {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type,authorization,last-event-id",
  };
  function json(res, code, value) {
    if (!res.destroyed && !res.writableEnded) { res.writeHead(code, headers); res.end(JSON.stringify(value)); }
  }
  function limited(req, group, maximum) {
    const address = trustedProxy ? String(req.headers["x-real-ip"] ?? req.socket.remoteAddress) : req.socket.remoteAddress;
    const key = `${group}:${address}`, time = now();
    let value = rates.get(key);
    if (!value || time - value.since >= 60_000) {
      if (!value && rates.size >= limits.rateEntries) {
        for (const [entry, rate] of rates) if (time - rate.since >= 60_000) rates.delete(entry);
        if (rates.size >= limits.rateEntries) return true;
      }
      rates.set(key, value = { since: time, count: 0 });
    }
    return ++value.count > maximum;
  }
  function metadata(session) {
    return {
      sessionId: session.sessionId, watchId: session.watchId, epoch: session.epoch,
      manifest: session.manifest, status: session.status, lastSeq: session.lastSeq,
      createdAt: session.createdAt, lastRecordAt: session.lastRecordAt,
      leaseExpiresAt: session.leaseExpiresAt, endedAt: session.endedAt, reason: session.reason,
    };
  }
  function detach(session, viewer, destroy = false) {
    if (session.viewers.delete(viewer)) viewerCount -= 1;
    if (destroy) viewer.res.destroy();
  }
  function write(session, viewer, event, payload, id) {
    const frame = `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const res = viewer.res;
    if (res.destroyed || res.writableEnded) { detach(session, viewer); return false; }
    if ((res.writableLength || 0) + bytes(frame) > limits.viewerBufferBytes) {
      detach(session, viewer, true);
      return false;
    }
    // write(false) means Node has queued the frame. Permit a bounded queue, then
    // disconnect before the next frame exceeds its budget; never retain a second queue.
    try { res.write(frame); return true; }
    catch { detach(session, viewer, true); return false; }
  }
  function broadcastState(session) {
    const { status, lastRecordAt, leaseExpiresAt, endedAt, reason, epoch } = session;
    for (const viewer of session.viewers) write(session, viewer, "state", { status, lastRecordAt, leaseExpiresAt, endedAt, reason, epoch });
  }
  function end(session, reason) {
    if (session.status === "ended") return;
    session.status = "ended"; session.endedAt = now(); session.reason = reason;
    if (rooms.get(session.roomKey) === session) rooms.delete(session.roomKey);
    broadcastState(session);
    for (const viewer of [...session.viewers]) { detach(session, viewer); viewer.res.end(); }
  }
  function updateStatus(session) {
    if (session.status === "ended") return;
    const time = now();
    if (time - session.createdAt >= limits.ttlMs) return end(session, "maximum-duration");
    if (time - session.lastSeenAt >= limits.endedAfterMs) return end(session, "publisher-timeout");
    const next = time >= session.leaseExpiresAt ? "reconnecting" : "live";
    if (next !== session.status) { session.status = next; broadcastState(session); }
  }
  function remove(session) {
    for (const viewer of [...session.viewers]) detach(session, viewer, true);
    residentBytes -= session.bytes;
    sessions.delete(session.sessionId); watches.delete(session.watchId);
    if (rooms.get(session.roomKey) === session) rooms.delete(session.roomKey);
  }
  function sweep() {
    const time = now();
    for (const session of sessions.values()) {
      updateStatus(session);
      if (session.status === "ended" && time - session.endedAt >= limits.endedRetentionMs) remove(session);
    }
    for (const [key, rate] of rates) if (time - rate.since >= 60_000) rates.delete(key);
  }
  function snapshot(session) {
    const selected = new Map([...session.latest.values()].map((entry) => [entry.seq, entry]));
    let size = [...selected.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    // Preserve complete latest state first, then the newest path/events fitting the budget.
    for (let index = session.history.length - 1; index >= 0; index -= 1) {
      const entry = session.history[index];
      if (selected.has(entry.seq)) continue;
      if (size + entry.bytes > limits.snapshotBytes) break;
      selected.set(entry.seq, entry); size += entry.bytes;
    }
    return { records: [...selected.values()].sort((a, b) => a.seq - b.seq).map(({ seq, record }) => ({ seq, record })) };
  }
  function hello(session, viewer) {
    return write(session, viewer, "hello", { ...metadata(session), snapshotSeq: session.lastSeq, snapshot: snapshot(session) });
  }
  function publish(session, entry) {
    for (const viewer of session.viewers) write(session, viewer, "record", { epoch: session.epoch, seq: entry.seq, record: entry.record }, entry.seq);
  }
  function registration(session) {
    return {
      sessionId: session.sessionId, watchId: session.watchId, publishToken: session.token,
      epoch: session.epoch, watchPath: `/?watch=${session.watchId}`,
      heartbeatMs: limits.heartbeatMs, leaseMs: limits.leaseMs,
      lastProducerSeq: session.lastProducerSeq, lastSeq: session.lastSeq,
    };
  }
  function touch(session, record = false) {
    const changed = session.status !== "live";
    session.lastSeenAt = now(); session.leaseExpiresAt = now() + limits.leaseMs; session.status = "live";
    if (record) session.lastRecordAt = now();
    if (changed) broadcastState(session);
  }
  function startEpoch(session, clientId, manifest) {
    const nextManifest = { ...manifest, sessionId: session.sessionId };
    const size = bytes(nextManifest);
    if (residentBytes - session.bytes + size > limits.globalBytes) throw fail("live-service-capacity", 503);
    residentBytes -= session.bytes;
    Object.assign(session, {
      clientId, manifest: nextManifest, token: randomBytes(32).toString("hex"), epoch: session.epoch + 1,
      lastSeq: 0, lastProducerSeq: 0, latest: new Map(), history: [], players: new Set(),
      historyBytes: 0, stateBytes: 0, bytes: size, lastRecordAt: null,
      status: "live", endedAt: null, reason: null, budget: { since: now(), count: 0, bytes: 0 },
    });
    residentBytes += size; touch(session);
    for (const viewer of session.viewers) hello(session, viewer);
  }
  async function readBody(req, limit) {
    if (activeBodies >= limits.concurrentBodies) throw fail("live-service-busy", 429);
    if (Number(req.headers["content-length"]) > limit) { req.resume(); throw fail("body-too-large", 413); }
    activeBodies += 1;
    try {
      return await new Promise((resolve, reject) => {
        let size = 0, chunks = [], failed = false;
        req.setTimeout(10_000, () => req.destroy(new Error("upload-timeout")));
        req.on("data", (chunk) => {
          if (failed) return;
          size += chunk.length;
          if (size > limit) { failed = true; chunks = []; reject(fail("body-too-large", 413)); return; }
          chunks.push(chunk);
        });
        req.once("end", () => { req.setTimeout(0); if (!failed) resolve(Buffer.concat(chunks).toString("utf8")); });
        req.once("error", () => reject(fail("upload-interrupted", 400)));
      });
    } finally { activeBodies -= 1; }
  }
  async function readJson(req, limit) {
    const source = await readBody(req, limit);
    try { return JSON.parse(source); } catch { throw fail("invalid-json"); }
  }
  function authorize(req, session) {
    if (!session) throw fail("unknown-session", 404);
    const token = String(req.headers.authorization ?? "").match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token || !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))) throw fail("invalid-publish-token", 401);
    updateStatus(session);
    if (session.status === "ended") throw fail("session-ended", 410);
    if (now() >= session.leaseExpiresAt) throw fail("publisher-lease-expired", 409, { retryAfterMs: 0 });
  }
  function append(session, envelopes) {
    // Validate the complete batch before changing state, including retry sequence gaps.
    const pending = [], players = new Set(session.players);
    let expected = session.lastProducerSeq + 1, duplicates = 0;
    for (const raw of envelopes) {
      const envelope = object(raw, { producerSeq: integer(1), record: validateLiveRecord }, ["producerSeq", "record"]);
      if (bytes(envelope) > limits.recordBytes) throw fail("record-too-large", 413);
      if (envelope.producerSeq < expected) { duplicates += 1; continue; }
      if (envelope.producerSeq !== expected) throw fail("producer-sequence-gap", 409, { expectedProducerSeq: session.lastProducerSeq + 1 });
      if (envelope.record.playerId) players.add(envelope.record.playerId);
      if (players.size > limits.players) throw fail("too-many-players", 413);
      expected += 1; pending.push(envelope);
    }
    const latest = new Map(session.latest), history = [...session.history];
    let stateBytes = session.stateBytes, historyBytes = session.historyBytes, lastSeq = session.lastSeq;
    const entries = [];
    for (const { record } of pending) {
      const entry = { seq: ++lastSeq, record, receivedAt: now() };
      entry.bytes = bytes({ seq: entry.seq, record }) + 96;
      entries.push(entry);
      let key = null;
      if (stateTypes.has(record.type)) key = `${record.type}:${record.playerId ?? ""}`;
      else if (record.type === "event" && record.event === "segment_change") key = "segment_change";
      else if (record.type === "event" && record.playerId && eventStateFamilies.has(record.event)) {
        // These events describe current player state as well as history. A new
        // viewer must not resurrect a departed/dead player after path eviction.
        key = `event:${eventStateFamilies.get(record.event)}:${record.playerId}`;
      }
      if (key) { stateBytes -= latest.get(key)?.bytes ?? 0; latest.set(key, entry); stateBytes += entry.bytes; }
      history.push(entry); historyBytes += entry.bytes;
    }
    if (stateBytes > limits.stateBytes) throw fail("session-state-capacity", 413);
    while (history.length && (history.length > limits.historyRecords || historyBytes > limits.historyBytes || now() - history[0].receivedAt > limits.historyMs)) {
      historyBytes -= history.shift().bytes;
    }
    const nextBytes = bytes(session.manifest) + stateBytes + historyBytes;
    if (residentBytes - session.bytes + nextBytes > limits.globalBytes) throw fail("live-service-capacity", 503);
    residentBytes += nextBytes - session.bytes;
    Object.assign(session, { latest, history, stateBytes, historyBytes, players, bytes: nextBytes, lastSeq, lastProducerSeq: expected - 1 });
    touch(session, pending.length > 0);
    for (const entry of entries) publish(session, entry);
    return { accepted: entries.length, duplicates, lastProducerSeq: session.lastProducerSeq, lastSeq, epoch: session.epoch, status: session.status };
  }
  function stream(req, res, url, session) {
    if (session.viewers.size >= limits.viewersPerSession || viewerCount >= limits.viewers) throw fail("too-many-viewers", 503);
    res.writeHead(200, { ...headers, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
    const viewer = { res };
    session.viewers.add(viewer); viewerCount += 1;
    res.once("close", () => detach(session, viewer));
    res.once("error", () => detach(session, viewer, true));
    res.write("retry: 2000\n\n");
    const queryAfter = url.searchParams.get("after");
    const rawAfter = req.headers["last-event-id"] ?? queryAfter;
    const after = rawAfter == null ? NaN : Number(rawAfter), epoch = Number(url.searchParams.get("epoch"));
    const firstSeq = session.history[0]?.seq ?? session.lastSeq + 1;
    const missing = session.history.filter((entry) => entry.seq > after);
    const replayBytes = missing.reduce((sum, entry) => sum + entry.bytes, 0);
    const resume = session.status !== "ended" && epoch === session.epoch && Number.isSafeInteger(after)
      && after >= firstSeq - 1 && after <= session.lastSeq && replayBytes <= limits.snapshotBytes;
    if (resume) {
      if (write(session, viewer, "resumed", { epoch: session.epoch, lastSeq: session.lastSeq, status: session.status })) {
        for (const entry of missing) if (!write(session, viewer, "record", { epoch: session.epoch, seq: entry.seq, record: entry.record }, entry.seq)) break;
      }
    } else hello(session, viewer);
    if (session.status === "ended") { detach(session, viewer); res.end(); }
  }
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost"), path = url.pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
    if (req.method === "OPTIONS") { res.writeHead(204, headers).end(); return true; }
    try {
      if (closed) throw fail("live-service-stopped", 503);
      sweep();
      if (path === `${PREFIX}/sessions` && req.method === "POST") {
        if (limited(req, "create", limits.createsPerMinute)) throw fail("rate-limited", 429, { retryAfterMs: 5_000 });
        const body = object(await readJson(req, limits.manifestBytes), {
          roomKey: (value) => { if (typeof value !== "string" || !HASH.test(value)) throw fail("room-key-required"); return value; },
          clientId: (value) => { if (typeof value !== "string" || !ID.test(value)) throw fail("client-id-required"); return value; },
          manifest: validateLiveManifest,
        }, ["roomKey", "clientId", "manifest"]);
        let session = rooms.get(body.roomKey);
        if (session && now() < session.leaseExpiresAt) {
          if (session.clientId !== body.clientId) throw fail("publisher-active", 409, {
            retryAfterMs: 5_000, sessionId: session.sessionId, watchId: session.watchId,
          });
          touch(session);
          json(res, 201, registration(session));
        } else {
          if (!session) {
            if (sessions.size >= limits.sessions) throw fail("too-many-sessions", 503);
            session = { roomKey: body.roomKey, sessionId: randomBytes(16).toString("hex"),
              watchId: randomBytes(16).toString("hex"), createdAt: now(), epoch: 0, bytes: 0, viewers: new Set() };
            startEpoch(session, body.clientId, body.manifest);
            sessions.set(session.sessionId, session); watches.set(session.watchId, session); rooms.set(body.roomKey, session);
          } else startEpoch(session, body.clientId, body.manifest);
          json(res, 201, registration(session));
        }
        return true;
      }
      const writer = path.match(/^\/api\/live\/v2\/sessions\/([a-f0-9]{32})\/(records|heartbeat|end)$/);
      if (writer && req.method === "POST") {
        const session = sessions.get(writer[1]);
        authorize(req, session);
        if (now() - session.budget.since >= 60_000) session.budget = { since: now(), count: 0, bytes: 0 };
        if (++session.budget.count > limits.requestsPerMinute) throw fail("rate-limited", 429, { retryAfterMs: 1_000 });
        if (writer[2] === "records") {
          const source = await readBody(req, limits.bodyBytes);
          authorize(req, session); // A pending body cannot outlive its lease or takeover.
          if (session.budget.bytes + bytes(source) > limits.bytesPerMinute) throw fail("rate-limited", 429, { retryAfterMs: 1_000 });
          session.budget.bytes += bytes(source);
          const lines = source.split(/\r?\n/u).filter((line) => line.trim());
          if (!lines.length) throw fail("empty-body");
          if (lines.length > limits.batchLines) throw fail("too-many-lines", 413);
          let envelopes;
          try { envelopes = lines.map((line) => JSON.parse(line)); } catch { throw fail("invalid-json"); }
          json(res, 200, append(session, envelopes));
        } else {
          const body = object(await readJson(req, 1_024), writer[2] === "end" ? { reason: string(100) } : {});
          authorize(req, session);
          if (writer[2] === "end") end(session, body.reason || "publisher-stopped");
          else touch(session);
          json(res, 200, { status: session.status, epoch: session.epoch, leaseExpiresAt: session.leaseExpiresAt });
        }
        return true;
      }
      const watcher = path.match(/^\/api\/live\/v2\/watch\/([a-f0-9]{32})(\/stream)?$/);
      if (watcher && req.method === "GET") {
        if (limited(req, "read", limits.readsPerMinute)) throw fail("rate-limited", 429);
        const session = watches.get(watcher[1]);
        if (!session) throw fail("unknown-watch", 404);
        if (watcher[2]) stream(req, res, url, session);
        else json(res, 200, metadata(session));
        return true;
      }
      throw fail("not-found", 404);
    } catch (error) {
      if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : "live-service-error", ...error.extra });
      else res.destroy();
      req.resume();
    }
    return true;
  }
  const sweeper = setInterval(sweep, sweepIntervalMs);
  sweeper.unref?.();
  const pinger = setInterval(() => {
    sweep();
    for (const session of sessions.values()) for (const viewer of session.viewers) {
      write(session, viewer, "ping", { epoch: session.epoch, status: session.status, lastRecordAt: session.lastRecordAt });
    }
  }, pingIntervalMs);
  pinger.unref?.();
  return {
    handle, sweep, sessions,
    stats: () => ({ sessions: sessions.size, residentBytes, viewers: viewerCount, activeBodies }),
    close: () => { closed = true; clearInterval(sweeper); clearInterval(pinger); for (const session of [...sessions.values()]) remove(session); rates.clear(); },
  };
}
