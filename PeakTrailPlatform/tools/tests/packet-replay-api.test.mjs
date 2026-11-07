import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { createPacketReplayApi } from "../../server/packet-replay-api.mjs";
import { createLiveServer } from "../../server/live-server.mjs";
import { createLiveTrace, appendLiveRecord } from "../../web/src/protocol.js";
import { PacketWatchClient } from "../../web/src/packet-watch-client.js";

const OPERATOR = "operator-only-test-key-not-the-collector-key";
const API_KEY = "collector-private-test-key-0123456789012345";
const PREFIX = "/api/packet-replay";
const FEATURE = "0123456789ABCDEF0123";
const SNAPSHOT = { roomCode: "DRXPTJ", featureCode: FEATURE, status: "recording", bytes: 120,
  events: 5, startedUtc: "2026-10-28T12:00:00Z", completedUtc: null, coverage: "from-join",
  errors: [], warnings: [], endReason: "", errorCode: null, photonReturnCode: null };
const write = (res, code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
const LIVE = { roomCode: "DRXPTJ", gameVersion: "3.0.1", gameBuildId: "26155610", projectionVersion: 1,
  sceneName: "Level_84", coordinateSpace: "unity-world-meters", timeUnit: "milliseconds", sceneEpoch: 2,
  lastSequence: 10, positionProjectionSupported: true, positionSamples: 100, lastPacketSeconds: 12,
  players: [{ playerId: "p1", name: "房主", userKey: "private-user-id", isCollector: false },
    { playerId: "p2", name: "Collector", isCollector: true }],
  records: [{ sequence: 9, sceneEpoch: 2, type: "participant", t: 100, playerId: "p1", nickname: "房主" },
    { sequence: 10, sceneEpoch: 2, type: "sample", t: 200, playerId: "p1", pos: [1, 2, 3], yaw: 60, activeSegment: -1 }], warnings: [] };

async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
async function fixture(handler = (req, res) => write(res, 200, SNAPSHOT), options = {}) {
  const calls = [];
  const upstream = createServer((req, res) => {
    const call = { path: req.url, method: req.method, headers: req.headers }; calls.push(call);
    const chunks = []; req.on("data", chunk => chunks.push(chunk)); req.on("end", () => { call.body = Buffer.concat(chunks).toString(); handler(req, res, call); });
  });
  const collectorUrl = await listen(upstream);
  const api = createPacketReplayApi({ env: {}, operatorKey: OPERATOR, apiKey: API_KEY, collectorUrl, ...options });
  const server = createServer((req, res) => api.handle(req, res).then(handled => { if (!handled) write(res, 404, {}); }));
  const base = await listen(server);
  let cookie;
  const send = (path, init = {}) => fetch(base + PREFIX + path, { ...init,
    headers: { ...(cookie ? { cookie } : {}), ...(init.method && init.method !== "GET" ? { origin: base } : {}), ...init.headers } });
  async function login() {
    const response = await send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: OPERATOR }) });
    assert.equal(response.status, 200); cookie = response.headers.get("set-cookie").split(";")[0]; await response.arrayBuffer(); return response;
  }
  return { base, send, login, calls, upstream, server, api, cookie: () => cookie,
    close: async () => { api.close(); await close(server); await close(upstream); } };
}

test("disabled configuration never contacts a collector and integration keeps health working", async () => {
  for (const options of [{ operatorKey: "" }, { apiKey: "short" }, { collectorUrl: "https://example.com" },
    { collectorUrl: "http://127.0.0.1:123/a" }, { collectorUrl: "http://user:pass@127.0.0.1:123" }, { operatorKey: API_KEY }]) {
    const f = await fixture(undefined, options);
    try {
      assert.deepEqual(await (await f.send("/session")).json(), { configured: false, authenticated: false });
      assert.equal((await f.send("/captures", { method: "POST" })).status, 503);
      assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
  const live = createLiveServer({ packetReplay: { env: {} } });
  const base = await listen(live.server);
  try {
    assert.equal((await fetch(base + "/api/health")).status, 200);
    const response = await fetch(base + PREFIX + "/session");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), { configured: false, authenticated: false });
  } finally { await close(live.server); }
});

test("login uses private cookie, checks origin, expires and revokes without leaking either key", async () => {
  let time = 100000;
  const f = await fixture(undefined, { now: () => time, sessionTtlMs: 10000 });
  try {
    assert.deepEqual(await (await f.send("/session")).json(), { configured: true, authenticated: false });
    const badOrigin = await f.send("/session", { method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, body: JSON.stringify({ accessCode: OPERATOR }) });
    assert.equal(badOrigin.status, 403);
    const invalid = await f.send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: '{"accessCode":"wrong"}' });
    assert.equal(invalid.status, 401);
    const login = await f.login();
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.match(login.headers.get("set-cookie"), /Path=\/api\/packet-replay/);
    assert.ok(!login.headers.get("set-cookie").includes(OPERATOR));
    assert.deepEqual(await (await f.send("/session")).json(), { configured: true, authenticated: true });
    await f.send("/session", { method: "DELETE" });
    assert.equal((await (await f.send("/session")).json()).authenticated, false);
    await f.login(); time += 11000;
    assert.equal((await (await f.send("/session")).json()).authenticated, false);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("HTTPS behind an explicitly trusted loopback proxy marks the cookie Secure", async () => {
  const f = await fixture(undefined, { trustedProxy: true });
  try {
    const response = await f.send("/session", { method: "POST", headers: {
      origin: f.base.replace("http:", "https:"), "x-forwarded-proto": "https", "content-type": "application/json",
    }, body: JSON.stringify({ accessCode: OPERATOR }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /; Secure$/);
  } finally { await f.close(); }
});

test("bounded login rate limit and missing-Origin CSRF reject before upstream", async () => {
  const f = await fixture();
  try {
    let result;
    for (let i = 0; i < 7; i++) result = await f.send("/session", { method: "POST", headers: { "content-type": "application/json" }, body: '{"accessCode":"bad"}' });
    assert.equal(result.status, 429);
    assert.equal((await result.json()).code, "rate_limited");
    const missing = await fetch(f.base + PREFIX + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: OPERATOR }) });
    assert.equal(missing.status, 403);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("authenticated start preserves idempotency and uses only server-side authorization", async () => {
  const seen = new Map();
  const f = await fixture((req, res, call) => {
    seen.set(req.headers["idempotency-key"], call.body);
    write(res, 202, { ...SNAPSHOT, status: "connecting", privateTicket: "do-not-forward", errors: [API_KEY], warnings: [OPERATOR] });
  });
  try {
    assert.equal((await f.send("/captures", { method: "POST" })).status, 401);
    await f.login();
    const post = () => f.send("/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "test-job-id-00000001", authorization: "Bearer browser-key" }, body: '{"roomCode":" drxptj "}' });
    const a = await post(), b = await post();
    assert.equal(a.status, 202); assert.equal(b.status, 202);
    const text = await a.text();
    assert.ok(!text.includes(API_KEY) && !text.includes(OPERATOR) && !text.includes("do-not-forward"));
    assert.equal(JSON.parse(text).featureCode, FEATURE);
    assert.equal(JSON.parse(text).endReason, "");
    assert.equal(seen.size, 1);
    assert.equal(f.calls[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(f.calls[0].headers.cookie, undefined);
    assert.equal(f.calls[0].path, "/api/v1/captures");
    assert.equal(f.calls[0].body, '{"roomCode":"DRXPTJ"}');
  } finally { await f.close(); }
});

test("status/stop use strict paths and mutations reject cross-origin requests", async () => {
  const f = await fixture();
  try {
    await f.login();
    assert.equal((await f.send(`/captures/DRXPTJ/${FEATURE}`)).status, 200);
    assert.equal((await f.send(`/captures/DRXPTJ/${FEATURE}/stop`, { method: "POST" })).status, 200);
    assert.equal(f.calls[1].method, "POST");
    assert.equal(f.calls[1].body, "");
    const before = f.calls.length;
    for (const [path, init, status] of [
      [`/captures/DRXPTJ/${FEATURE}/stop`, { method: "POST", headers: { origin: "https://attacker.invalid" } }, 403],
      ["/captures", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "test-job-id-00000001" }, body: '{"roomCode":"DRXPTJ","target":"https://evil"}' }, 400],
      ["/captures", { method: "POST", headers: { "content-type": "application/json" }, body: '{"roomCode":"DRXPTJ"}' }, 400],
      [`/captures/DRXPTJ/${FEATURE}?ticket=secret`, {}, 400],
      ["/captures/%44RXPTJ/0123456789ABCDEF0123", {}, 400],
      [`/captures/DRXPTJ/${FEATURE}/stop`, { method: "POST", body: "ignored-not-allowed" }, 400],
      [`/replays/DRXPTJ/${FEATURE}/file`, { headers: { range: "bytes=0-1,2-3" } }, 400],
    ]) assert.equal((await f.send(path, init)).status, status, path);
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test("binary download streams ranges and never forwards upstream cookies or disposition", async () => {
  const bytes = Buffer.from([0, 1, 128, 255, 60, 13]);
  const f = await fixture((req, res) => {
    const partial = Boolean(req.headers.range);
    const data = partial ? bytes.subarray(1, 4) : bytes;
    res.writeHead(partial ? 206 : 200, { "content-type": "application/octet-stream", "content-length": data.length,
      ...(partial ? { "content-range": "bytes 1-3/6" } : {}), "set-cookie": `secret=${API_KEY}`,
      "content-disposition": `inline; filename="${API_KEY}"` }); res.end(data);
  });
  try {
    await f.login();
    const full = await f.send(`/replays/DRXPTJ/${FEATURE}/file`);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    assert.equal(full.headers.get("set-cookie"), null);
    assert.equal(full.headers.get("content-disposition"), `attachment; filename="DRXPTJ-${FEATURE}.peaknet"`);
    const partial = await f.send(`/replays/DRXPTJ/${FEATURE}/file`, { headers: { range: "bytes=1-3" } });
    assert.equal(partial.status, 206); assert.equal(partial.headers.get("content-range"), "bytes 1-3/6");
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(1, 4));
    assert.equal(f.calls[1].headers.range, "bytes=1-3");
  } finally { await f.close(); }
});

test("upstream failures, unknown fields and redirects cannot reveal credentials", async () => {
  let mode = "error";
  const f = await fixture((req, res) => {
    if (mode === "redirect") { res.writeHead(302, { location: "https://example.com/" }); res.end(); }
    else if (mode === "auth") write(res, 401, { message: API_KEY });
    else if (mode === "oversize") write(res, 200, { ...SNAPSHOT, secret: API_KEY.repeat(2000) });
    else if (mode === "mismatch") write(res, 200, { ...SNAPSHOT, roomCode: "DSVEHQ" });
    else write(res, 409, { code: "capture_worker_busy", message: API_KEY, secret: OPERATOR });
  });
  try {
    await f.login();
    for (const [current, status, code] of [["error", 409, "capture_worker_busy"], ["auth", 502, "collector_auth_failed"],
      ["redirect", 502, "collector_unavailable"], ["oversize", 502, "upstream_invalid_response"], ["mismatch", 502, "upstream_invalid_response"]]) {
      mode = current;
      const response = await f.send(`/captures/DRXPTJ/${FEATURE}`);
      assert.equal(response.status, status, current);
      const text = await response.text(); assert.equal(JSON.parse(text).code, code);
      assert.ok(!text.includes(API_KEY) && !text.includes(OPERATOR));
    }
  } finally { await f.close(); }
});

test("upstream timeout closes request and responds with a fixed safe code", async () => {
  let closed = false;
  const f = await fixture((req, res) => res.once("close", () => { closed = true; }), { requestTimeoutMs: 40 });
  try {
    await f.login();
    const response = await f.send(`/captures/DRXPTJ/${FEATURE}`);
    assert.equal(response.status, 504); assert.equal((await response.json()).code, "upstream_timeout");
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, true);
  } finally { await f.close(); }
});

test("disconnecting a download client cancels the upstream stream", async () => {
  let upstreamClosed;
  const ended = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(1024));
    const interval = setInterval(() => res.write(Buffer.alloc(1024)), 10);
    res.once("close", () => { clearInterval(interval); upstreamClosed(); });
  });
  try {
    await f.login();
    await new Promise((resolve, reject) => {
      const client = request(f.base + PREFIX + `/replays/DRXPTJ/${FEATURE}/file`, { headers: { cookie: f.cookie() } }, response => {
        response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
      }); client.on("error", error => { if (error.code !== "ECONNRESET") reject(error); }); client.end();
    });
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream not cancelled")), 1000))]);
  } finally { await f.close(); }
});

test("capture list separates active and archived history and only exposes public fields", async () => {
  const f = await fixture((req, res) => write(res, 200, { active: SNAPSHOT, history: [{ ...SNAPSHOT,
    status: "completed", completedUtc: "2026-10-29T00:00:00Z", hostKey: "steam:sha256-123", hostName: "房主",
    archiveAvailable: true, zipBytes: 1024, expiresUtc: "2026-11-05T00:00:00Z", privateTicket: API_KEY }],
    hasMore: false, privateToken: OPERATOR }));
  try {
    assert.equal((await f.send("/captures")).status, 401); assert.equal(f.calls.length, 0);
    await f.login(); const response = await f.send("/captures"); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.active.status, "recording");
    assert.deepEqual(value.retention, { maxPerHost: 2, maxAgeDays: 7 });
    assert.equal(value.history[0].hostName, "房主"); assert.equal(value.history[0].archiveAvailable, true);
    assert.equal(value.history[0].zipBytes, 1024); assert.equal(value.history[0].privateTicket, undefined);
    assert.equal(value.privateToken, undefined); assert.equal(f.calls[0].path, "/api/v1/captures");
  } finally { await f.close(); }
});

test("live DTO strips raw identities and packets and feeds existing map trace callbacks", async () => {
  const f = await fixture((req, res) => write(res, 200, { capture: SNAPSHOT, live: { ...LIVE,
    rawPacket: API_KEY, auth: OPERATOR, records: LIVE.records.map(row => ({ ...row, ticket: API_KEY })) } }));
  try {
    assert.equal((await f.send(`/captures/DRXPTJ/${FEATURE}/live`)).status, 401);
    await f.login(); const response = await f.send(`/captures/DRXPTJ/${FEATURE}/live`); assert.equal(response.status, 200);
    const value = await response.json(), serialized = JSON.stringify(value);
    for (const privateValue of [API_KEY, OPERATOR, "private-user-id", "Collector"]) assert.ok(!serialized.includes(privateValue));
    assert.equal(value.live.manifest.mapSlot, 84); assert.equal(value.live.manifest.gameBuildId, "26155610");
    assert.equal(value.live.manifest.projectionVersion, 1); assert.equal(value.live.manifest.segmentResolution, "unassigned");
    assert.deepEqual(value.live.manifest.participants, [{ playerId: "p1", nickname: "房主" }]);
    let trace;
    const client = new PacketWatchClient({ captureId: `DRXPTJ.${FEATURE}`, onSnapshot: snapshot => {
      trace = createLiveTrace(snapshot.manifest);
      for (const entry of snapshot.snapshot.records) appendLiveRecord(trace, entry.record);
    } });
    client.consume(value); client.stop();
    assert.equal(trace.sampleCount, 1); assert.deepEqual(trace.bounds, { min: [1, 2, 3], max: [1, 2, 3] });
    assert.equal(trace.participants[0].nickname, "房主");
  } finally { await f.close(); }
});

test("unknown build and Airport never invent a level map manifest", async () => {
  let live = LIVE;
  const f = await fixture((req, res) => write(res, 200, { capture: SNAPSHOT, live }));
  try {
    await f.login();
    for (const patch of [{ sceneName: "Airport" }, { gameBuildId: null, projectionVersion: null }, { positionProjectionSupported: false }]) {
      live = { ...LIVE, ...patch };
      const response = await f.send(`/captures/DRXPTJ/${FEATURE}/live`);
      assert.equal(response.status, 200); assert.equal((await response.json()).live.manifest, null);
    }
    live = null; assert.equal((await (await f.send(`/captures/DRXPTJ/${FEATURE}/live`)).json()).live, null);
  } finally { await f.close(); }
});

test("live projection rejects mixed scene records, invalid coordinates, ordering and oversized buffers", async () => {
  let live;
  const f = await fixture((req, res) => write(res, 200, { capture: SNAPSHOT, live }));
  try {
    await f.login();
    for (const patch of [{ roomCode: "DSVEHQ" }, { sceneEpoch: -1 }, { lastSequence: 8 },
      { records: [...LIVE.records].reverse() }, { records: Array(10001).fill(LIVE.records[1]) },
      { records: [{ ...LIVE.records[1], sceneEpoch: 1 }] }, { records: [{ ...LIVE.records[1], pos: [null, 2, 3] }] },
      { records: [{ ...LIVE.records[1], playerId: "../private" }] }, { records: [{ ...LIVE.records[1], type: "raw_packet" }] }]) {
      live = { ...LIVE, ...patch };
      const response = await f.send(`/captures/DRXPTJ/${FEATURE}/live`);
      assert.equal(response.status, 502); assert.equal((await response.json()).code, "upstream_invalid_response");
    }
  } finally { await f.close(); }
});

test("ZIP download uses sanitized Unicode host name, preserves bytes/range and strips private headers", async () => {
  const bytes = Buffer.from([80, 75, 3, 4, 10, 0]);
  const f = await fixture((req, res) => {
    if (req.url.startsWith("/api/v1/captures/")) return write(res, 200, { ...SNAPSHOT, status: "completed", archiveAvailable: true,
      hostName: "房主/测试", completedUtc: "2026-10-29T00:00:00Z" });
    const partial = Boolean(req.headers.range), data = partial ? bytes.subarray(1, 4) : bytes;
    res.writeHead(partial ? 206 : 200, { "content-type": "application/zip", "content-length": data.length,
      ...(partial ? { "content-range": "bytes 1-3/6" } : {}), "set-cookie": `secret=${API_KEY}`, "content-disposition": `inline; filename=${API_KEY}` });
    res.end(data);
  });
  try {
    assert.equal((await f.send(`/replays/DRXPTJ/${FEATURE}/archive.zip`)).status, 401);
    await f.login();
    for (const partial of [false, true]) {
      const response = await f.send(`/replays/DRXPTJ/${FEATURE}/archive.zip`, { headers: partial ? { range: "bytes=1-3" } : {} });
      assert.equal(response.status, partial ? 206 : 200);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
      assert.ok(decodeURIComponent(response.headers.get("content-disposition")).includes(`房主_测试-DRXPTJ-${FEATURE}.zip`));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), partial ? bytes.subarray(1, 4) : bytes);
    }
  } finally { await f.close(); }
});

test("expired and missing archives fail without fetching a ZIP and live errors remain specific", async () => {
  let mode = "expired";
  const f = await fixture((req, res) => {
    if (mode === "live") return write(res, 409, { code: "live_unavailable", secret: API_KEY });
    write(res, 200, { ...SNAPSHOT, status: mode, archiveAvailable: false });
  });
  try {
    await f.login();
    for (mode of ["expired", "recording"]) assert.equal((await f.send(`/replays/DRXPTJ/${FEATURE}/archive.zip`)).status, 410);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path.startsWith("/api/v1/captures/")));
    mode = "live"; const response = await f.send(`/captures/DRXPTJ/${FEATURE}/live`);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "live_unavailable");
  } finally { await f.close(); }
});

test("public navigation starts with a room code and exposes only the exact recording capability", async () => {
  const f = await fixture((req, res) => write(res, req.method === "POST" ? 202 : 200,
    { ...SNAPSHOT, status: req.method === "POST" ? "connecting" : "recording", secret: API_KEY }));
  const nav = (path, init = {}) => fetch(f.base + "/api/navigation" + path, init);
  try {
    assert.deepEqual(await (await nav("/session")).json(), { configured: true, captures: [] });
    const response = await nav("/rooms", { method: "POST", headers: { origin: f.base,
      "content-type": "application/json", "idempotency-key": "guest-start-000000001", cookie: "irrelevant=private-browser-value" },
      body: '{"roomCode":" drxptj "}' });
    assert.equal(response.status, 202); assert.equal(response.headers.get("set-cookie"), null);
    const value = await response.json(); assert.equal(value.capture.featureCode, FEATURE);
    assert.equal(value.capture.status, "recording"); assert.equal(value.reused, false);
    assert.ok(!JSON.stringify(value).includes(API_KEY));
    assert.equal(f.calls[0].body, '{"roomCode":"DRXPTJ"}'); assert.equal(f.calls[0].headers.cookie, undefined);
    assert.equal(f.calls[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal((await nav(`/captures/DRXPTJ/${FEATURE}`)).status, 200);
    const before = f.calls.length;
    for (const path of ["/captures", "/rooms/DRXPTJ", "/captures/DRXPTJ", `/captures/DRXPTJ/${FEATURE}/stop`, `/replays/DRXPTJ/${FEATURE}/file`])
      assert.equal((await nav(path)).status, 404, path);
    assert.equal((await nav(`/captures/DRXPTJ/${FEATURE}`, { method: "POST" })).status, 405);
    assert.equal(f.calls.length, before);
    assert.equal((await f.send("/captures")).status, 401);
    assert.equal((await f.send(`/captures/DRXPTJ/${FEATURE}/stop`, { method: "POST" })).status, 401);
  } finally { await f.close(); }
});

test("multiple visitors attach to one active feature while a recycled room has a separate history identity", async () => {
  const nextFeature = "FEDCBA9876543210FEDC";
  let activeFeature = FEATURE, first = true;
  const f = await fixture((req, res) => {
    if (req.method === "POST") {
      const status = first ? 202 : 200; first = false;
      return write(res, status, { ...SNAPSHOT, featureCode: activeFeature });
    }
    const feature = req.url.split("/").at(-1);
    if (![FEATURE, nextFeature].includes(feature)) return write(res, 404, { code: "capture_not_found" });
    write(res, 200, { ...SNAPSHOT, featureCode: feature, status: feature === activeFeature ? "recording" : "completed" });
  });
  const start = key => fetch(f.base + "/api/navigation/rooms", { method: "POST", headers: { origin: f.base,
    "content-type": "application/json", "idempotency-key": key }, body: '{"roomCode":"DRXPTJ"}' });
  try {
    const a = await (await start("visitor-one-00000001")).json(), b = await (await start("visitor-two-00000002")).json();
    assert.equal(a.capture.featureCode, b.capture.featureCode); assert.equal(b.reused, true);
    activeFeature = nextFeature; first = true;
    const next = await (await start("visitor-new-run-00003")).json();
    assert.equal(next.capture.featureCode, nextFeature); assert.equal(next.reused, false);
    const old = await fetch(f.base + `/api/navigation/captures/DRXPTJ/${FEATURE}`);
    assert.equal((await old.json()).status, "completed");
    assert.equal((await fetch(f.base + "/api/navigation/captures/DRXPTJ")).status, 404);
    assert.equal((await fetch(f.base + "/api/navigation/rooms/DRXPTJ/history")).status, 404);
  } finally { await f.close(); }
});

test("public navigation validates origin and bounded admission without opening administrative access", async () => {
  const f = await fixture((req, res) => write(res, 200, SNAPSHOT), { navigationStartsPerMinute: 2 });
  const start = headers => fetch(f.base + "/api/navigation/rooms", { method: "POST", headers: {
    origin: f.base, "content-type": "application/json", "idempotency-key": "navigation-test-00001", ...headers }, body: '{"roomCode":"DRXPTJ"}' });
  try {
    assert.equal((await start({ origin: "https://other.invalid" })).status, 403);
    assert.equal(f.calls.length, 0);
    assert.equal((await start()).status, 200); assert.equal((await start()).status, 200);
    const limited = await start(); assert.equal(limited.status, 429); assert.equal((await limited.json()).code, "rate_limited");
    assert.equal(f.calls.length, 4);
    assert.equal((await fetch(f.base + "/api/navigation/session?room=DRXPTJ")).status, 400);
  } finally { await f.close(); }
});

test("public live and ZIP use only full room-feature identity and preserve expiry handling", async () => {
  let expired = false;
  const f = await fixture((req, res) => {
    if (req.url.endsWith("/live")) return write(res, expired ? 410 : 200,
      expired ? { code: "archive_expired" } : { capture: SNAPSHOT, live: LIVE });
    if (req.url.endsWith("/archive.zip")) { res.writeHead(200, { "content-type": "application/zip" }); res.end(Buffer.from('PK')); return; }
    return write(res, 200, { ...SNAPSHOT, status: expired ? "expired" : "completed", archiveAvailable: !expired, hostName: "Host" });
  });
  const get = path => fetch(f.base + "/api/navigation" + path);
  try {
    const live = await get(`/captures/DRXPTJ/${FEATURE}/live`); assert.equal(live.status, 200);
    assert.equal((await live.json()).live.manifest.gameBuildId, "26155610");
    const zip = await get(`/replays/DRXPTJ/${FEATURE}/archive.zip`); assert.equal(zip.status, 200); assert.equal(await zip.text(), 'PK');
    expired = true;
    assert.equal((await get(`/replays/DRXPTJ/${FEATURE}/archive.zip`)).status, 410);
    const ended = await get(`/captures/DRXPTJ/${FEATURE}/live`); assert.equal(ended.status, 410); assert.equal((await ended.json()).code, "archive_expired");
  } finally { await f.close(); }
});

test("administrator listing includes every active room while public navigation exposes no global list", async () => {
  const second = { ...SNAPSHOT, roomCode: "DSVEHQ", featureCode: "B".repeat(20), status: "connecting", hostName: "Second host", privateTicket: API_KEY };
  let activeCaptures = [{ ...SNAPSHOT, hostName: "First host", privateTicket: API_KEY }, second];
  const f = await fixture((req, res) => {
    if (req.url === "/api/v1/captures") return write(res, 200, { active: activeCaptures[0] ?? null, activeCaptures, history: [], hasMore: false });
    const selected = activeCaptures.find(item => req.url.includes(`/${item.roomCode}/${item.featureCode}`));
    if (!selected) return write(res, 404, { code: "capture_not_found" });
    if (req.url.endsWith("/stop")) selected.status = "stopping";
    return write(res, 200, selected);
  });
  try {
    assert.equal((await f.send("/captures")).status, 401);
    assert.equal((await fetch(f.base + "/api/navigation/captures")).status, 404);
    await f.login();
    const value = await (await f.send("/captures")).json();
    assert.deepEqual(value.activeCaptures.map(item => item.roomCode), ["DRXPTJ", "DSVEHQ"]);
    assert.deepEqual(value.active, value.activeCaptures[0]); assert.ok(!JSON.stringify(value).includes(API_KEY));
    await f.send(`/captures/DSVEHQ/${second.featureCode}/stop`, { method: "POST" });
    assert.equal(activeCaptures[0].status, "recording"); assert.equal(activeCaptures[1].status, "stopping");
    assert.equal(f.calls.filter(item => item.path.endsWith("/stop")).length, 1);
    activeCaptures = [];
    const empty = await (await f.send("/captures")).json(); assert.equal(empty.active, null); assert.deepEqual(empty.activeCaptures, []);
  } finally { await f.close(); }
});

test("active room DTO rejects excessive, duplicated, inactive or inconsistent entries", async () => {
  const second = { ...SNAPSHOT, roomCode: "DSVEHQ", featureCode: "B".repeat(20) };
  let active = SNAPSHOT, activeCaptures = [SNAPSHOT, second];
  const f = await fixture((req, res) => write(res, 200, { active, activeCaptures, history: [], hasMore: false }));
  try {
    await f.login();
    for (activeCaptures of [null, Array(17).fill(SNAPSHOT), [SNAPSHOT, { ...SNAPSHOT, featureCode: second.featureCode }],
      [{ ...SNAPSHOT, status: "completed" }], [second], []]) {
      const result = await f.send("/captures"); assert.equal(result.status, 502); assert.equal((await result.json()).code, "upstream_invalid_response");
    }
    active = null; activeCaptures = [SNAPSHOT]; assert.equal((await f.send("/captures")).status, 502);
    active = SNAPSHOT; activeCaptures = undefined;
    assert.equal((await (await f.send("/captures")).json()).activeCaptures.length, 1, "legacy single-room collectors remain readable");
  } finally { await f.close(); }
});

test("public admission preserves capacity errors and different room snapshots independently", async () => {
  const captures = new Map([["DRXPTJ", SNAPSHOT], ["DSVEHQ", { ...SNAPSHOT, roomCode: "DSVEHQ", featureCode: "B".repeat(20) }]]);
  const f = await fixture((req, res, call) => {
    if (req.method === "POST") {
      const item = captures.get(JSON.parse(call.body).roomCode);
      return item ? write(res, 200, item) : write(res, 429, { code: "capture_capacity" });
    }
    const item = [...captures.values()].find(value => req.url.endsWith(`/${value.roomCode}/${value.featureCode}`));
    return item ? write(res, 200, item) : write(res, 404, { code: "capture_not_found" });
  });
  const start = roomCode => fetch(f.base + "/api/navigation/rooms", { method: "POST", headers: { origin: f.base,
    "content-type": "application/json", "idempotency-key": `room-request-${roomCode}-000001` }, body: JSON.stringify({ roomCode }) });
  try {
    for (const room of captures.keys()) {
      const result = await start(room); assert.equal(result.status, 200);
      const value = await result.json(); assert.equal(value.capture.roomCode, room); assert.equal(value.capture.featureCode, captures.get(room).featureCode);
    }
    const full = await start("ABC123"); assert.equal(full.status, 429); assert.equal((await full.json()).code, "capture_capacity");
    assert.equal((await start("DRXPTJ")).status, 200, "existing room still attaches when new-room capacity is full");
  } finally { await f.close(); }
});

test("shared Steam failure DTO preserves only fixed diagnostic codes for administrators and visitors", async () => {
  let code;
  const f = await fixture((req, res) => write(res, 200, { ...SNAPSHOT, status: "failed", errorCode: code,
    errors: [`RAW_PRIVATE_MESSAGE ${API_KEY}`], message: `RAW_PRIVATE_MESSAGE ${OPERATOR}`, privateTicket: API_KEY }));
  try {
    await f.login();
    for (code of ["steam_session_busy", "steam_login_required", "steam_broker_timeout", "steam_broker_ended",
      "steam_broker_protocol", "steam_ticket_reused", "steam_ticket_capacity"]) {
      for (const response of [await f.send(`/captures/DRXPTJ/${FEATURE}`),
        await fetch(f.base + `/api/navigation/captures/DRXPTJ/${FEATURE}`)]) {
        assert.equal(response.status, 200);
        const value = await response.json(); assert.equal(value.errorCode, code);
        assert.equal(value.errors.length, 1);
        assert.ok(!JSON.stringify(value).includes("RAW_PRIVATE_MESSAGE"));
        assert.ok(!JSON.stringify(value).includes(API_KEY)); assert.ok(!JSON.stringify(value).includes(OPERATOR));
        assert.equal(Object.hasOwn(value, "message"), false); assert.equal(Object.hasOwn(value, "privateTicket"), false);
      }
    }
  } finally { await f.close(); }
});

const lookupRoom = (fixture, roomCode, init = {}) => fetch(fixture.base + "/api/navigation/rooms/lookup", {
  method: "POST", headers: { origin: fixture.base, "content-type": "application/json", ...init.headers },
  body: JSON.stringify({ roomCode }), ...Object.fromEntries(Object.entries(init).filter(([key]) => key !== "headers")),
});
const savedCapture = (featureCode = FEATURE) => ({ ...SNAPSHOT, featureCode, status: "completed", archiveAvailable: true,
  completedUtc: "2026-10-28T12:04:00Z", hostName: "Saved host", zipBytes: 100 });

test("fresh visitors receive no room list; an explicit code finds only that room without joining", async () => {
  const active = { ...SNAPSHOT, featureCode: "A".repeat(20), privateTicket: API_KEY };
  const f = await fixture((req, res) => {
    assert.equal(req.url, "/api/v1/rooms/DRXPTJ/captures"); assert.equal(req.method, "GET");
    write(res, 200, { roomCode: "DRXPTJ", active, history: [{ ...savedCapture(), privateTicket: API_KEY }], hasMore: false,
      allRooms: ["DSVEHQ"], privateToken: OPERATOR });
  });
  try {
    assert.deepEqual(await (await fetch(f.base + "/api/navigation/session")).json(), { configured: true, captures: [] });
    for (const path of ["/api/navigation/captures", "/api/navigation/rooms", "/api/navigation/rooms/lookup", "/api/navigation/rooms/DRXPTJ/captures"])
      assert.equal((await fetch(f.base + path)).status, 404, path);
    assert.equal(f.calls.length, 0, "opening a fresh page and probing list routes cannot contact the collector");
    const response = await lookupRoom(f, " drxptj "); assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.roomCode, "DRXPTJ"); assert.equal(value.active.featureCode, active.featureCode);
    assert.deepEqual(value.history.map(item => item.featureCode), [FEATURE]);
    assert.ok(!JSON.stringify(value).includes("DSVEHQ"));
    assert.ok(!JSON.stringify(value).includes(API_KEY) && !JSON.stringify(value).includes(OPERATOR));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, "");
    assert.equal(f.calls[0].headers["idempotency-key"], undefined);
    assert.equal(f.calls[0].headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(f.calls[0].headers.cookie, undefined);
  } finally { await f.close(); }
});

test("new devices can recover completed recordings by entered code; absent codes return an empty result", async () => {
  const f = await fixture((req, res) => {
    const roomCode = req.url.includes("DRXPTJ") ? "DRXPTJ" : "DSVEHQ";
    write(res, 200, { roomCode, active: null, history: roomCode === "DRXPTJ" ? [savedCapture(), savedCapture("B".repeat(20))] : [], hasMore: false });
  });
  try {
    const value = await (await lookupRoom(f, "DRXPTJ")).json();
    assert.equal(value.active, null); assert.equal(value.history.length, 2);
    assert.ok(value.history.every(item => item.archiveAvailable && item.roomCode === "DRXPTJ"));
    const absent = await lookupRoom(f, "DSVEHQ"); assert.equal(absent.status, 200);
    assert.deepEqual(await absent.json(), { roomCode: "DSVEHQ", active: null, history: [], hasMore: false });
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(call => call.method === "GET" && call.path.startsWith("/api/v1/rooms/")), "no new capture or ticket is requested");
  } finally { await f.close(); }
});

test("room lookup rejects another room, failed archives, duplicate identities and excessive results", async () => {
  let value;
  const f = await fixture((req, res) => write(res, 200, value));
  const valid = { roomCode: "DRXPTJ", active: null, history: [savedCapture()], hasMore: false };
  const invalid = [
    { ...valid, roomCode: "DSVEHQ" },
    { ...valid, active: { ...SNAPSHOT, roomCode: "DSVEHQ" } },
    { ...valid, active: savedCapture() },
    { ...valid, history: [{ ...savedCapture(), roomCode: "DSVEHQ" }] },
    { ...valid, history: [{ ...savedCapture(), status: "failed", errorCode: "room_not_found" }] },
    { ...valid, history: [{ ...savedCapture(), archiveAvailable: false }] },
    { ...valid, history: [{ ...savedCapture(), completedUtc: null }] },
    { ...valid, history: [savedCapture(), savedCapture()] },
    { ...valid, active: SNAPSHOT },
    { ...valid, history: Array(21).fill(savedCapture()) },
    { ...valid, hasMore: "yes" },
    { ...valid, history: null },
  ];
  try {
    for (value of invalid) {
      const response = await lookupRoom(f, "DRXPTJ");
      assert.equal(response.status, 502); assert.equal((await response.json()).code, "upstream_invalid_response");
    }
  } finally { await f.close(); }
});

test("public room lookup requires a same-origin explicit body and rejects broad or malformed requests", async () => {
  const f = await fixture();
  try {
    assert.equal((await lookupRoom(f, "DRXPTJ", { headers: { origin: "https://attacker.invalid" } })).status, 403);
    assert.equal((await fetch(f.base + "/api/navigation/rooms/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: '{"roomCode":"DRXPTJ"}' })).status, 403);
    for (const body of [{}, { roomCode: "" }, { roomCode: "*" }, { roomCode: "DRXPTJ", all: true }, { roomCode: ["DRXPTJ", "DSVEHQ"] }])
      assert.equal((await lookupRoom(f, "DRXPTJ", { body: JSON.stringify(body) })).status, 400);
    assert.equal((await fetch(f.base + "/api/navigation/rooms/lookup?room=DRXPTJ")).status, 400);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("room lookup and admission share the room-code rate limit and never return cacheable lists", async () => {
  const f = await fixture((req, res) => write(res, 200, { roomCode: "DRXPTJ", active: null, history: [], hasMore: false }), { navigationStartsPerMinute: 1 });
  try {
    const first = await lookupRoom(f, "DRXPTJ"); assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store"); assert.equal(first.headers.get("referrer-policy"), "no-referrer");
    const next = await lookupRoom(f, "DRXPTJ"); assert.equal(next.status, 429); assert.equal((await next.json()).code, "rate_limited");
    const start = await fetch(f.base + "/api/navigation/rooms", { method: "POST", headers: { origin: f.base,
      "content-type": "application/json", "idempotency-key": "rate-limited-start-000001" }, body: '{"roomCode":"DRXPTJ"}' });
    assert.equal(start.status, 429); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});
