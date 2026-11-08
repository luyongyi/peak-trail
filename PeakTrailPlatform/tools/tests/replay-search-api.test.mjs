import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createPacketReplayApi } from "../../server/packet-replay-api.mjs";

const RECORD = { roomCode: "DRXPTJ", featureCode: "0123456789ABCDEF0123", hostName: "Mylu",
  hostKey: "private-steam-identity", status: "completed", bytes: 120, events: 5, coverage: "from-join",
  startedUtc: "2026-11-09T00:00:00Z", completedUtc: "2026-11-09T00:01:00Z", expiresUtc: "2026-11-16T00:01:00Z",
  archiveAvailable: true, zipBytes: 80, errorCode: null };
async function fixture(t, result = { hostName: "Mylu", history: [RECORD], hasMore: false }, options = {}) {
  const calls = [];
  const upstream = createServer((req, res) => { calls.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const api = createPacketReplayApi({ env: {}, operatorKey: "operator-search-test-01234567890123456789",
    apiKey: "collector-search-test-01234567890123456789", collectorUrl: `http://127.0.0.1:${upstream.address().port}`, ...options });
  const server = createServer(async (req, res) => { if (!await api.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { api.close(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const search = (body = { hostName: "Mylu" }, headers = {}) => fetch(`${base}/api/navigation/replays/search`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { base, calls, search };
}
test("nickname lookup uses the filtered collector endpoint and exposes no private identity", async t => {
  const f = await fixture(t); const response = await f.search({ hostName: " Mylu " });
  assert.equal(response.status, 200); const value = await response.json();
  assert.equal(value.history.length, 1); assert.equal(value.hostName, "Mylu");
  assert.equal(value.history[0].featureCode, RECORD.featureCode);
  assert.ok(!JSON.stringify(value).includes("private-steam")); assert.ok(!("hostKey" in value.history[0]));
  assert.deepEqual(f.calls, [{ method: "GET", url: "/api/v1/replays/search?hostName=Mylu" }]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("fresh browsers and empty requests never enumerate all recordings", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(f.base + "/api/navigation/session")).json(), { configured: true, captures: [] });
  assert.equal((await fetch(f.base + "/api/navigation/replays/search")).status, 404);
  for (const body of [{}, { hostName: "" }, { hostName: "   " }, { hostName: "*", all: true },
    { hostName: "a".repeat(101) }, { hostName: "bad\nname" }, { hostName: "\ud800" }]) {
    assert.equal((await f.search(body)).status, 400);
  }
  assert.equal((await f.search(undefined, { origin: "https://unrelated.invalid" })).status, 403);
  assert.deepEqual(f.calls, []);
});
test("Unicode names are normalized and encoded as a single parameter", async t => {
  const hostName = "é房主 &/?😀";
  const f = await fixture(t, { hostName, history: [{ ...RECORD, hostName }], hasMore: false });
  const response = await f.search({ hostName: " e\u0301房主 &/?😀 " });
  assert.equal(response.status, 200); assert.equal((await response.json()).history[0].hostName, hostName);
  assert.deepEqual(f.calls, [{ method: "GET", url: "/api/v1/replays/search?hostName=" + encodeURIComponent(hostName) }]);
});
test("only completed matching archives may cross the public search boundary", async t => {
  for (const change of [{ hostName: "someone else" }, { status: "recording" }, { archiveAvailable: false },
    { completedUtc: null }, { zipBytes: 0 }, { roomCode: "BAD" }]) {
    const f = await fixture(t, { hostName: "Mylu", history: [{ ...RECORD, ...change }], hasMore: false });
    assert.equal((await f.search()).status, 502);
  }
  const duplicate = await fixture(t, { hostName: "Mylu", history: [RECORD, RECORD], hasMore: false });
  assert.equal((await duplicate.search()).status, 502);
});
test("scoped overflow remains explicit and searches share navigation rate limits", async t => {
  const f = await fixture(t, { hostName: "Mylu", history: [RECORD], hasMore: true }, { navigationStartsPerMinute: 1 });
  assert.equal((await (await f.search()).json()).hasMore, true);
  assert.equal((await f.search()).status, 429); assert.equal(f.calls.length, 1);
});

test("nickname normalization preserves FEFF and does not expand sharp-s", async t => {
  const hostName = "\uFEFFAlice";
  const f = await fixture(t, { hostName, history: [{ ...RECORD, hostName }], hasMore: false });
  const response = await f.search({ hostName }); assert.equal(response.status, 200);
  assert.equal((await response.json()).hostName, hostName);
  assert.equal(f.calls[0].url, "/api/v1/replays/search?hostName=" + encodeURIComponent(hostName));
  const other = await fixture(t, { hostName: "SS", history: [{ ...RECORD, hostName: "ß" }], hasMore: false });
  assert.equal((await other.search({ hostName: "SS" })).status, 502);
});
