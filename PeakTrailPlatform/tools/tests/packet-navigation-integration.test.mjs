import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { createLiveServer, closeLiveServer } from "../../server/live-server.mjs";

const OPERATOR = "operator-integration-test-only-012345";
const API_KEY = "collector-integration-test-only-0123456789";
const json = (res, value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}, handler) {
  const calls = [];
  const upstream = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    if (handler) handler(req, res);
    else json(res, { roomCode: "DRXPTJ", active: null, history: [], hasMore: false });
  });
  const collectorUrl = await listen(upstream);
  const live = createLiveServer({ liveV2: { memoryOnly: true }, ...options,
    packetReplay: { env: { PEAK_CAPTURE_OPERATOR_KEY: OPERATOR, PEAK_CAPTURE_API_KEY: API_KEY,
      PEAK_CAPTURE_URL: collectorUrl }, ...options.packetReplay } });
  const base = await listen(live.server);
  t.after(async () => {
    await closeLiveServer(live, { timeoutMs: 100 });
    upstream.closeAllConnections();
    await new Promise(done => upstream.close(done));
  });
  const send = (path, init) => fetch(base + path, init);
  return { live, base, send, calls, upstream };
}

test("publishing unified code remains disabled even with inherited collector configuration", async t => {
  const f = await fixture(t);
  const health = await f.send("/api/packet-replay/health");
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { ok: false, service: "peak-packet-web", version: 1,
    enabled: false, configured: false });
  assert.deepEqual(await (await f.send("/api/navigation/session")).json(), { configured: false, captures: [] });
  assert.deepEqual(await (await f.send("/api/packet-replay/session")).json(), { configured: false, authenticated: false });
  for (const path of ["/api/navigation/captures", "/api/navigation/rooms", "/api/packet-replay/captures"]) {
    const response = await f.send(path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    await response.arrayBuffer();
  }
  const start = await f.send("/api/navigation/rooms", { method: "POST", headers: {
    origin: f.base, "content-type": "application/json", "idempotency-key": "integration-start-0001" },
    body: JSON.stringify({ roomCode: "DRXPTJ" }) });
  assert.equal(start.status, 503);
  await start.arrayBuffer();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await (await f.send("/api/health")).json(), { ok: true, service: "peak-trail-live" });
});

test("enabled navigation exposes safe readiness and empty fresh-browser state; only explicit room lookup reaches upstream", async t => {
  const f = await fixture(t, { packetNavigationEnabled: true });
  const health = await f.send("/api/packet-replay/health");
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.deepEqual(await health.json(), { ok: true, service: "peak-packet-web", version: 1,
    enabled: true, configured: true });
  assert.deepEqual(await (await f.send("/api/navigation/session")).json(), { configured: true, captures: [] });
  for (const path of ["/api/navigation/captures", "/api/navigation/rooms", "/api/navigation/rooms/lookup"]) {
    const response = await f.send(path);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
  }
  assert.deepEqual(f.calls, []);
  const lookup = await f.send("/api/navigation/rooms/lookup", { method: "POST",
    headers: { origin: f.base, "content-type": "application/json" }, body: '{"roomCode":"DRXPTJ"}' });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await lookup.json(), { roomCode: "DRXPTJ", active: null, history: [], hasMore: false });
  assert.deepEqual(f.calls, [{ method: "GET", path: "/api/v1/rooms/DRXPTJ/captures", authorization: `Bearer ${API_KEY}` }]);
});

test("enabled service with missing configuration fails its navigation health without exposing configuration", async t => {
  const f = await fixture(t, { packetNavigationEnabled: true, packetReplay: { apiKey: "" } });
  const health = await f.send("/api/packet-replay/health");
  assert.equal(health.status, 503);
  const value = await health.json();
  assert.deepEqual(value, { ok: false, service: "peak-packet-web", version: 1, enabled: true, configured: false });
  assert.deepEqual(f.calls, []);
  assert.equal((await f.send("/api/health")).status, 200);
});

test("integrated bridge retains same-origin and trusted-proxy cookie protection", async t => {
  const f = await fixture(t, { packetNavigationEnabled: true, trustedProxy: true });
  const sendLogin = origin => f.send("/api/packet-replay/session", { method: "POST", headers: {
    origin, "x-forwarded-proto": "https", "content-type": "application/json" },
    body: JSON.stringify({ accessCode: OPERATOR }) });
  assert.equal((await sendLogin("https://unrelated.invalid")).status, 403);
  const login = await sendLogin(f.base.replace("http:", "https:"));
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.equal(login.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await login.json(), { configured: true, authenticated: true });
  assert.deepEqual(f.calls, []);
});

test("deployment shutdown aborts a pending upstream request without waiting for its timeout", async t => {
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, { packetNavigationEnabled: true }, () => requestStarted());
  const response = f.send("/api/navigation/rooms/lookup", { method: "POST", headers: {
    origin: f.base, "content-type": "application/json" }, body: '{"roomCode":"DRXPTJ"}' })
    .then(value => value.arrayBuffer(), () => {});
  await started;
  const before = Date.now();
  assert.equal(await closeLiveServer(f.live, { timeoutMs: 100 }), true);
  assert.ok(Date.now() - before < 1500, "upstream timeout must not delay deployment");
  await response;
  assert.equal(f.live.packetReplay.configured, false);
});

test("deployment shutdown bounds a client that never finishes its request body", async t => {
  const f = await fixture(t, { packetNavigationEnabled: true });
  const socket = connect(f.live.server.address().port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(`POST /api/navigation/rooms/lookup HTTP/1.1\r\nHost: ${new URL(f.base).host}\r\nOrigin: ${f.base}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await new Promise(resolve => setTimeout(resolve, 20));
  const before = Date.now();
  const closed = once(socket, "close");
  assert.equal(await closeLiveServer(f.live, { timeoutMs: 100 }), true);
  assert.ok(Date.now() - before < 1500, "unfinished body must not delay deployment");
  await closed;
  assert.deepEqual(f.calls, []);
});
