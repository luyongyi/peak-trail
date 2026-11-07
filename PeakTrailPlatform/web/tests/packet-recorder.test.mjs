import assert from "node:assert/strict";
import test from "node:test";
import { PacketRecorder, parseCapture, capturePresentation, groupHistory, formatBytes, errorMessage, normalizeRoom, normalizeFeature, validRoom, validFeature, isActiveCapture } from "../src/packet-recorder.js";

const room = "DRXPTJ", feature = "3CA5E6878769B9C53304";
const capture = (status = "connecting", fields = {}) => ({ roomCode: room, featureCode: feature, status, bytes: 0, events: 0, archiveAvailable: status === "completed", ...fields });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fixture(handler = async () => response({ configured: true, authenticated: true })) {
  const requests = [], timers = new Map(), stored = new Map(), changes = [];
  let timerId = 0, sequence = 0;
  const client = new PacketRecorder({
    fetchImpl: async (path, options) => { requests.push({ path, ...options }); return handler(path, options); },
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    makeId: () => `request-${String(++sequence).padStart(16, "0")}`,
    onChange: state => changes.push(state),
    setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { client, requests, timers, stored, changes,
    async poll() { const entries = [...timers]; assert.equal(entries.length, 1); const [id, timer] = entries[0]; timers.delete(id); return timer.fn(); } };
}

test("capture identity is normalized but validates path-breaking and wrong-region values", () => {
  assert.equal(normalizeRoom(" drxptj "), room);
  assert.equal(normalizeFeature(feature.toLowerCase()), feature);
  assert.equal(validRoom(room), true); assert.equal(validFeature(feature), true);
  for (const value of ["Q12345", "../abc", "ABC12", "ABC1234", "ABC 12"]) assert.equal(validRoom(value), false);
  for (const value of ["a".repeat(20), "G".repeat(20), "1".repeat(21), "../" + "0".repeat(17)]) assert.equal(validFeature(value), false);
});

test("accepted start is connecting, then polls recording and completed before enabling download", async () => {
  const states = [capture("recording", { bytes: 500, events: 12 }), capture("completed", { bytes: 830000, events: 2529 })];
  const f = fixture(async (path, options) => options.method === "POST" ? response(capture(), 202) : path.endsWith("/session") ? response({ configured: true, authenticated: true }) : response(states.shift()));
  await f.client.initialize(); await f.client.start(" drxptj ");
  assert.equal(f.client.state.capture.status, "connecting");
  assert.match(capturePresentation(f.client.state.capture).description, /尚未开始/);
  assert.equal(capturePresentation(f.client.state.capture).download, null);
  await f.poll(); assert.equal(f.client.state.capture.status, "recording"); assert.equal(f.client.state.capture.events, 12);
  await f.poll(); assert.equal(f.client.state.capture.status, "completed");
  assert.equal(capturePresentation(f.client.state.capture).download, `/api/packet-replay/replays/${room}/${feature}/archive.zip`);
  assert.equal(capturePresentation(f.client.state.capture).rawDownload, `/api/packet-replay/replays/${room}/${feature}/file`);
  assert.equal(f.timers.size, 0); f.client.dispose();
});

test("unknown start outcome retries the same idempotency key, and cannot change rooms", async () => {
  let count = 0;
  const f = fixture(async (path) => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : ++count === 1 ? Promise.reject(new Error("private secret")) : response(capture(), 202));
  await f.client.initialize(); assert.equal(await f.client.start(room), false);
  assert.equal(f.client.state.pendingRoom, room); assert.equal(f.client.state.error.includes("private secret"), false);
  assert.equal(await f.client.start("ABC123"), false); assert.equal(count, 1);
  assert.equal(await f.client.start(room), true);
  const posts = f.requests.filter(request => request.method === "POST");
  assert.equal(posts.length, 2); assert.equal(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
  assert.equal(await f.client.start(room), true); assert.equal(count, 3, "a deliberate new request can attach to the active room");
  f.client.dispose();
});

test("explicit rejected start releases pending identity for a corrected room", async () => {
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : response({ code: "capture_worker_busy" }, 409));
  await f.client.initialize(); await f.client.start(room);
  assert.equal(f.client.state.pendingRoom, null);
  assert.equal(f.stored.has("peak-packet-replay:pending-start"), false);
  await f.client.start("ABC123");
  const posts = f.requests.filter(request => request.method === "POST");
  assert.notEqual(posts[0].headers["Idempotency-Key"], posts[1].headers["Idempotency-Key"]);
  assert.equal(JSON.parse(posts[1].body).roomCode, "ABC123"); f.client.dispose();
});

test("reload and re-login recover an unacknowledged start with its original idempotency key", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: options.method !== "DELETE" }) : Promise.reject(new Error("lost response")));
  await f.client.initialize(); await f.client.start(room);
  const key = f.requests.find(request => request.path.endsWith("/captures")).headers["Idempotency-Key"];
  assert.deepEqual(JSON.parse(f.stored.get("peak-packet-replay:pending-start")), { roomCode: room, key });
  await f.client.logout(); assert.ok(f.stored.has("peak-packet-replay:pending-start"), "logout must not forget the server job");
  f.client.dispose();
  const g = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: options.method === "POST" }) : response(capture("recording"), 202));
  for (const [name, value] of f.stored) g.stored.set(name, value);
  // A previously completed archive must not replace the pending start on restore.
  g.stored.set("peak-packet-replay:last-capture", JSON.stringify({ roomCode: "ABC123", featureCode: feature }));
  await g.client.initialize(); assert.equal(g.client.state.pendingRoom, null, "wait until authenticated to expose previous room");
  await g.client.login("operator-secret-never-store");
  assert.equal(g.client.state.pendingRoom, room); assert.equal(g.client.state.capture, null);
  assert.equal(await g.client.lookup("ABC123", feature), false); assert.equal(g.requests.length, 2, "lookup does not discard an unresolved start");
  assert.equal(await g.client.start("ABC123"), false);
  await g.client.start(room);
  const retried = g.requests.find(request => request.path.endsWith("/captures"));
  assert.equal(retried.headers["Idempotency-Key"], key);
  assert.equal(g.client.state.capture.status, "recording");
  assert.equal(g.stored.has("peak-packet-replay:pending-start"), false);
  assert.equal([...g.stored.values()].some(value => value.includes("operator-secret-never-store")), false);
  g.client.dispose();
});

test("reload with valid cookie restores pending room without starting a new request", async () => {
  const f = fixture();
  f.stored.set("peak-packet-replay:pending-start", JSON.stringify({ roomCode: room, key: "existing-key-123456789" }));
  await f.client.initialize();
  assert.equal(f.client.state.pendingRoom, room); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
  f.client.dispose();
});

test("an auth rejection of a retry retains the key for the earlier unknown start", async () => {
  let attempts = 0;
  const f = fixture(async (path) => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : ++attempts === 1 ? Promise.reject(new Error("response lost")) : attempts === 2 ? response({ code: "not_authenticated" }, 401) : response(capture("recording"), 202));
  await f.client.initialize(); await f.client.start(room);
  const pendingBefore = f.stored.get("peak-packet-replay:pending-start");
  await f.client.start(room); assert.equal(f.client.state.authenticated, false);
  assert.equal(f.stored.get("peak-packet-replay:pending-start"), pendingBefore);
  await f.client.login("not-persisted"); await f.client.start(room);
  const posts = f.requests.filter(request => request.path.endsWith("/captures"));
  assert.equal(new Set(posts.map(request => request.headers["Idempotency-Key"])).size, 1);
  assert.equal(f.stored.has("peak-packet-replay:pending-start"), false); f.client.dispose();
});

test("double submit is suppressed while first request is in progress", async () => {
  let finish;
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : new Promise(resolve => { finish = resolve; }));
  await f.client.initialize(); const pending = f.client.start(room);
  assert.equal(await f.client.start(room), false); assert.equal(f.requests.length, 2);
  finish(response(capture(), 202)); await pending; f.client.dispose();
});

test("stop keeps polling during finalization and never exposes a partial-file download", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : path.endsWith("/stop") ? response(capture("stopping"), 202) : options.method === "POST" ? response(capture("recording"), 202) : response(capture("completed")));
  await f.client.initialize(); await f.client.start(room); await f.client.stop();
  assert.equal(f.client.state.capture.status, "stopping");
  assert.equal(capturePresentation(f.client.state.capture).download, null);
  assert.equal(await f.client.stop(), false);
  await f.poll(); assert.ok(capturePresentation(f.client.state.capture).download); f.client.dispose();
});

test("login secret is sent once in JSON and never persisted; refresh restores only room and feature", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: options.method === "POST" }) : response(capture("recording"), 202));
  await f.client.initialize(); assert.equal(f.client.state.authenticated, false);
  await f.client.login("operator-test-code"); await f.client.start(room);
  const login = f.requests.find(request => request.path.endsWith("/session") && request.method === "POST");
  assert.equal(JSON.parse(login.body).accessCode, "operator-test-code");
  for (const value of f.stored.values()) assert.deepEqual(JSON.parse(value), { roomCode: room, featureCode: feature });
  assert.equal(JSON.stringify(f.client.state).includes("operator-test-code"), false);
  f.client.dispose();
  const g = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : response(capture("recording")));
  for (const [key, value] of f.stored) g.stored.set(key, value);
  await g.client.initialize(); assert.equal(g.client.state.capture.roomCode, room); assert.equal(g.timers.size, 1); g.client.dispose();
});

test("401 polling expires management and stops automatic requests without losing saved identity", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : options.method === "POST" ? response(capture(), 202) : response({ code: "not_authenticated" }, 401));
  await f.client.initialize(); await f.client.start(room); await f.poll();
  assert.equal(f.client.state.authenticated, false); assert.equal(f.timers.size, 0); assert.ok(f.client.savedIdentity());
  assert.match(f.client.state.error, /过期/); f.client.dispose();
});

test("configuration unavailable causes no capture or restore request", async () => {
  const f = fixture(async () => response({ configured: false, authenticated: false }));
  f.stored.set("peak-packet-replay:last-capture", JSON.stringify({ roomCode: room, featureCode: feature }));
  await f.client.initialize(); assert.equal(f.requests.length, 1);
  assert.equal(await f.client.start(room), false); assert.equal(f.requests.length, 1); f.client.dispose();
});

test("unknown failures and malformed responses never display raw messages or construct unsafe download links", async () => {
  assert.throws(() => parseCapture(capture("completed", { roomCode: "../../evil" })));
  assert.throws(() => parseCapture(capture("completed", { bytes: -1 })));
  assert.throws(() => parseCapture(capture("secret-state")));
  assert.equal(errorMessage("SECRET raw sdk token"), "操作未完成，请稍后重试或联系管理员。");
  const parsed = parseCapture(capture("failed", { errors: ["SECRET"], message: "SECRET", errorCode: "SECRET" }));
  assert.equal(JSON.stringify(parsed).includes("SECRET"), false);
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : response({ code: "unknown", message: "SECRET" }, 500));
  await f.client.initialize(); await f.client.lookup(room, feature); assert.equal(f.client.state.error.includes("SECRET"), false); f.client.dispose();
});

test("shared Steam failures have fixed actionable messages including separate authentication capacity", () => {
  for (const code of ["steam_session_busy", "steam_login_required", "steam_broker_timeout", "steam_broker_ended",
    "steam_broker_protocol", "steam_ticket_reused", "steam_ticket_capacity"]) {
    const parsed = parseCapture(capture("failed", { errorCode: code, errors: ["RAW_PRIVATE_MESSAGE"], message: "RAW_PRIVATE_MESSAGE" }));
    assert.equal(parsed.errorCode, code);
    assert.equal(capturePresentation(parsed).note, errorMessage(code));
    assert.notEqual(errorMessage(code), errorMessage("unknown"));
    assert.ok(!JSON.stringify(parsed).includes("RAW_PRIVATE_MESSAGE"));
  }
  assert.match(errorMessage("steam_ticket_capacity"), /Steam 认证槽.*回收/);
  assert.match(errorMessage("steam_login_required"), /扫码登录/);
});

test("dispose aborts in-flight requests and timers, while logout never calls stop", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: options.method !== "DELETE" }) : response(capture(), 202));
  await f.client.initialize(); await f.client.start(room); await f.client.logout();
  assert.equal(f.client.state.authenticated, false); assert.equal(f.timers.size, 0);
  assert.equal(f.requests.some(request => request.path.endsWith("/stop")), false);
  f.client.dispose();
  const g = fixture(async (path, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  const pending = g.client.initialize(); const changeCount = g.changes.length;
  g.client.dispose(); await pending;
  assert.equal(g.requests[0].signal.aborted, true); assert.equal(g.timers.size, 0); assert.equal(g.changes.length, changeCount);
});

test("inactive outcomes never poll or offer downloads except completed", async () => {
  for (const status of ["completed", "cancelled", "failed", "interrupted", "expired"]) {
    const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true }) : response(capture(status)));
    await f.client.initialize(); await f.client.lookup(room, feature);
    assert.equal(isActiveCapture(f.client.state.capture), false); assert.equal(f.timers.size, 0);
    assert.equal(Boolean(capturePresentation(f.client.state.capture).download), status === "completed"); f.client.dispose();
  }
  assert.equal(formatBytes(831309), "811.8 KB");
});

test("library groups stable host keys, shows latest two by completion time, and excludes expired files", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const saved = (number, hostKey = "host-one", fields = {}) => parseCapture(capture("completed", {
    featureCode: number.toString(16).toUpperCase().padStart(20, "0"), hostKey, hostName: "同名房主",
    startedUtc: `2026-10-${String(20 + number).padStart(2, "0")}T10:00:00Z`,
    completedUtc: `2026-10-${String(20 + number).padStart(2, "0")}T12:00:00Z`,
    expiresUtc: "2026-11-02T12:00:00Z", ...fields,
  }));
  const older = saved(3), latest = saved(5), previous = saved(4);
  const secondHost = saved(2, "host-two"), expired = saved(6, "host-two", { expiresUtc: "2026-10-29T12:00:00Z" });
  const unavailable = saved(7, "host-two", { archiveAvailable: false });
  const groups = groupHistory([older, latest, previous, secondHost, expired, unavailable], now);
  assert.equal(groups.length, 2, "same nickname must not merge different host identities");
  assert.deepEqual(groups[0].captures, [latest, previous]);
  assert.deepEqual(groups[1].captures, [secondHost]);
  assert.equal(groupHistory([saved(1, null), saved(2, null)], now).length, 2, "unidentified sessions remain separate");
  assert.equal(latest.startedUtc, "2026-10-25T10:00:00Z");
  assert.equal(latest.completedUtc, "2026-10-25T12:00:00Z");
  assert.equal(Object.hasOwn(latest, "createdUtc"), false);
});

test("opening the library recovers the active server capture without another start or saved browser identity", async () => {
  let active = capture("recording", { hostName: "房主", hostKey: "stable-key" });
  let history = [];
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true })
    : path.endsWith("/captures") ? response({ active, history, hasMore: false }) : response(capture("completed")));
  f.client.libraryEnabled = true;
  await f.client.initialize();
  assert.equal(f.client.state.capture.status, "recording");
  assert.equal(f.client.state.active.hostName, "房主");
  assert.equal(f.requests.some(request => request.method === "POST"), false);
  active = null; history = [capture("completed", { hostName: "房主", hostKey: "stable-key" })];
  await f.poll();
  assert.equal(f.client.state.active, null); assert.equal(f.client.state.capture.status, "completed");
  assert.equal(f.client.state.history.length, 1); assert.equal(f.client.state.libraryLoaded, true);
  f.client.dispose();
});

test("administrators select and stop one of multiple rooms without switching or stopping the others", async () => {
  const second = capture("recording", { roomCode: "DSVEHQ", featureCode: "B".repeat(20), hostName: "Second host" });
  const rooms = new Map([[room, capture("recording", { hostName: "First host" })], [second.roomCode, second]]);
  const f = fixture(async (path, options) => {
    if (path.endsWith("/session")) return response({ configured: true, authenticated: options.method !== "DELETE" });
    if (path.endsWith("/captures") && options.method === "GET") {
      const all = [...rooms.values()], activeCaptures = all.filter(isActiveCapture);
      return response({ active: activeCaptures[0] ?? null, activeCaptures, history: all.filter(item => item.status === "completed"), hasMore: false });
    }
    if (path.endsWith("/captures") && options.method === "POST") {
      const roomCode = JSON.parse(options.body).roomCode;
      const item = capture("recording", { roomCode, featureCode: "C".repeat(20), hostName: "New host" }); rooms.set(roomCode, item); return response(item, 202);
    }
    const [, requestRoom, requestFeature] = path.match(/\/captures\/([^/]+)\/([^/]+)/) ?? [];
    const item = rooms.get(requestRoom); assert.equal(item.featureCode, requestFeature);
    if (path.endsWith("/stop")) { item.status = "stopping"; return response(item, 202); }
    return response(item);
  });
  f.client.libraryEnabled = true;
  await f.client.initialize(); assert.equal(f.client.state.activeCaptures.length, 2);
  await f.client.lookup(second.roomCode, second.featureCode);
  assert.equal(f.client.state.capture.roomCode, second.roomCode, "library refresh preserves chosen room B instead of selecting first room A");
  assert.equal(await f.client.start("ABC123"), true, "room C may start while A and B record");
  assert.equal(f.client.state.activeCaptures.length, 3); assert.equal(f.client.state.capture.roomCode, "ABC123");
  await f.client.lookup(room, feature); await f.client.stop();
  const stops = f.requests.filter(item => item.path.endsWith("/stop"));
  assert.equal(stops.length, 1); assert.ok(stops[0].path.endsWith(`/${room}/${feature}/stop`));
  assert.equal(rooms.get(second.roomCode).status, "recording"); assert.equal(rooms.get("ABC123").status, "recording");
  rooms.get(room).status = "completed";
  await f.poll();
  assert.equal(f.client.state.capture.roomCode, room); assert.equal(f.client.state.capture.status, "completed");
  assert.equal(f.client.state.activeCaptures.length, 2); assert.equal([...f.timers.values()][0].delay, 2000);
  await f.client.lookup(second.roomCode, second.featureCode); assert.equal(f.client.state.capture.status, "recording");
  await f.client.logout(); assert.deepEqual(f.client.state.activeCaptures, []);
  assert.equal(await f.client.stop(), false); assert.equal(f.requests.filter(item => item.path.endsWith("/stop")).length, 1);
  f.client.dispose();
});

test("capacity rejection releases the pending room so administrators can select an existing room", async () => {
  const f = fixture(async (path, options) => path.endsWith("/session") ? response({ configured: true, authenticated: true })
    : options.method === "POST" ? response({ code: "capture_capacity" }, 429) : response(capture("recording")));
  await f.client.initialize(); assert.equal(await f.client.start("ABC123"), false);
  assert.match(f.client.state.error, /房间数已满/); assert.equal(f.client.state.pendingRoom, null);
  assert.equal(await f.client.lookup(room, feature), true); assert.equal(f.client.state.capture.roomCode, room);
  f.client.dispose();
});

test("invalid active room lists do not replace administrator state", async () => {
  let supplied = [capture("recording")];
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true })
    : response({ active: capture("recording"), activeCaptures: supplied, history: [], hasMore: false }));
  f.client.libraryEnabled = true; await f.client.initialize();
  const previous = f.client.state.activeCaptures;
  for (supplied of [null, [capture("completed")], [capture("recording"), capture("recording", { featureCode: "B".repeat(20) })],
    [capture("recording", { roomCode: "ABC123" })], Array(17).fill(capture("recording"))]) {
    await f.client.refreshLibrary(); assert.equal(f.client.state.activeCaptures, previous); assert.match(f.client.state.error, /读取录制状态/);
  }
  f.client.dispose();
});

test("expired identities remain findable but never offer map archives or raw downloads", async () => {
  const f = fixture(async path => path.endsWith("/session") ? response({ configured: true, authenticated: true })
    : response(capture("expired", { archiveAvailable: false, endReason: "archive_expired" })));
  await f.client.initialize(); await f.client.lookup(room, feature);
  const view = capturePresentation(f.client.state.capture);
  assert.match(view.title, /清理/); assert.equal(view.download, null); assert.equal(view.rawDownload, null);
  assert.match(errorMessage("archive_expired"), /保留规则/); f.client.dispose();
});
