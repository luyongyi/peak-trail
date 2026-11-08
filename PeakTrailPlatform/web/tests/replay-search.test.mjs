import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ReplaySearch, mountReplaySearch, normalizeReplayHost, parseReplaySearch } from "../src/replay-search.js";

const now = Date.parse("2026-11-09T12:00:00Z");
const feature = "AABBCCDDEEFF00112233";
const capture = (fields = {}) => ({ hostName: "Mylu", roomCode: "DRXPTJ", featureCode: feature, status: "completed", archiveAvailable: true,
  startedUtc: "2026-11-09T10:00:00Z", completedUtc: "2026-11-09T11:00:00Z", expiresUtc: "2026-11-16T11:00:00Z", ...fields });
const result = (fields = {}) => ({ hostName: "Mylu", history: [capture()], hasMore: false, ...fields });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(accept => resolve = accept); return { promise, resolve }; };
function fixture(handler = async () => response(result())) {
  const calls = [], states = [];
  const client = new ReplaySearch({ fetchImpl: async (path, options) => { calls.push({ path, options }); return handler(path, options); }, now: () => now,
    onChange: state => states.push(state) });
  return { client, calls, states };
}

test("a new visitor makes no request; only explicit valid nickname searches reach the dedicated endpoint", async () => {
  const { client, calls } = fixture();
  assert.equal(calls.length, 0); assert.deepEqual(client.state.history, []);
  for (const name of ["", "   ", "x".repeat(101), "a\u0000b", "a\ud800", "a\udc00"]) assert.equal(await client.search(name), false);
  assert.equal(calls.length, 0);
  assert.equal(normalizeReplayHost(" 🎮 "), "🎮");
  assert.equal(normalizeReplayHost("\uFEFFAlice"), "\uFEFFAlice");
  assert.throws(() => parseReplaySearch({ hostName: "SS", history: [capture({ hostName: "ß" })], hasMore: false }, "SS"));
  assert.equal(normalizeReplayHost("🎮".repeat(100)), "🎮".repeat(100));
  assert.equal(normalizeReplayHost("🎮".repeat(101)), null);
  assert.equal(normalizeReplayHost(" Cafe\u0301 "), "Café");
  assert.equal(await client.search(" Mylu "), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].path, "/api/navigation/replays/search");
  assert.equal(calls[0].options.method, "POST"); assert.deepEqual(JSON.parse(calls[0].options.body), { hostName: "Mylu" });
  assert.equal(calls[0].options.credentials, "same-origin"); assert.equal(calls[0].options.redirect, "error");
  client.dispose();
});

test("response validation limits results to completed matching hosts, safe identities and display fields", () => {
  const parsed = parseReplaySearch(result({ history: [capture({ hostKey: "private-host-key", steamId: "private-steam-id", downloadUrl: "https://bad.example" })] }), "Mylu");
  for (const key of ["hostKey", "steamId", "downloadUrl"]) assert.equal(key in parsed.history[0], false);
  for (const value of [result({ hostName: "Other" }), result({ hasMore: "yes" }), result({ history: [capture(), capture()] }),
    result({ history: Array(101).fill(capture()) }), result({ history: [capture({ hostName: "Other" })] }),
    result({ history: [capture({ roomCode: "../abc" })] }), result({ history: [capture({ featureCode: "a".repeat(20) })] }),
    result({ history: [capture({ status: "recording" })] }), result({ history: [capture({ archiveAvailable: false })] }),
    result({ history: [capture({ startedUtc: "bad" })] }), result({ history: [capture({ expiresUtc: "bad" })] })])
    assert.throws(() => parseReplaySearch(value, "Mylu"), /upstream_invalid_response/);
});

test("empty results and service errors never retain a previous person's recordings or private messages", async () => {
  let current = response(result());
  const { client } = fixture(async () => current);
  await client.search("Mylu");
  current = response(result({ history: [] })); await client.search("Mylu");
  assert.equal(client.state.phase, "ready"); assert.deepEqual(client.state.history, []);
  current = response({ code: "rate_limited", message: "private-upstream-details" }, 429); await client.search("Mylu");
  assert.equal(client.state.phase, "error"); assert.match(client.state.error, /频繁/); assert.doesNotMatch(client.state.error, /private/);
  current = response({ code: "unknown", message: "private-token" }, 503); await client.search("Mylu");
  assert.match(client.state.error, /暂不可用/); assert.deepEqual(client.state.history, []); client.dispose();
});

test("new queries and input changes invalidate slower previous responses even if transport ignores abort", async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const { client, calls } = fixture(() => ++count === 1 ? first.promise : second.promise);
  const old = client.search("Mylu"), recent = client.search("Other");
  assert.equal(calls[0].options.signal.aborted, true);
  second.resolve(response(result({ hostName: "Other", history: [capture({ hostName: "Other" })] }))); await recent;
  first.resolve(response(result())); await old;
  assert.equal(client.state.hostName, "Other"); assert.equal(client.state.history[0].hostName, "Other");
  const third = deferred(); client.fetch = () => third.promise;
  const request = client.search("Mylu"); client.clear(); third.resolve(response(result())); await request;
  assert.equal(client.state.phase, "idle"); assert.deepEqual(client.state.history, []); client.dispose();
});

test("expired or removed downloads are explained in place and never open a ZIP", async () => {
  for (const status of [404, 410]) {
    const { client, calls } = fixture(async path => path.endsWith("/search") ? response(result()) : response({}, status));
    await client.search("Mylu");
    assert.equal(await client.prepareDownload(client.state.history[0]), null);
    assert.equal(client.state.history[0].downloadState, status === 410 ? "expired" : "missing");
    assert.equal(calls[1].path, `/api/navigation/captures/DRXPTJ/${feature}`);
    assert.equal(calls[1].options.method, "GET"); client.dispose();
  }
  const { client, calls } = fixture(async () => response(result({ history: [capture({ expiresUtc: "2026-11-08T00:00:00Z" })] })));
  await client.search("Mylu"); assert.equal(await client.prepareDownload(client.state.history[0]), null);
  assert.equal(calls.length, 1); assert.equal(client.state.history[0].downloadState, "expired"); client.dispose();
});

test("download preflight uses fixed server paths, is retryable and cannot race a new search", async () => {
  let allow = false;
  const { client, calls } = fixture(async path => path.endsWith("/search") ? response(result()) : allow ? response(capture()) : response({}, 503));
  await client.search("Mylu"); assert.equal(await client.prepareDownload(client.state.history[0]), null);
  assert.equal(client.state.history[0].downloadState, "error"); allow = true;
  assert.equal(await client.prepareDownload(client.state.history[0]), `/api/navigation/replays/DRXPTJ/${feature}/archive.zip`);
  assert.ok(calls.every(call => !call.path.includes("/rooms") && !call.path.endsWith("/archive.zip")), "no room joining or buffering the recording ZIP");
  const wait = deferred(); client.fetch = () => wait.promise;
  const checking = client.prepareDownload(client.state.history[0]); client.clear(); wait.resolve(response(capture()));
  assert.equal(await checking, null); assert.deepEqual(client.state.history, []); client.dispose();
});

class Element {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ""; this.className = ""; this._text = ""; this.classList = { add: name => this.className += ` ${name}` }; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(_) { throw new Error("innerHTML must never be used"); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this._text = ""; this.children = []; this.append(...children); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  setAttribute(name, value) { this.attributes[name] = value; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function domFixture(handler) {
  const elements = new Map(["replaySearchForm", "replaySearchName", "replaySearchSubmit", "replaySearchResults", "replaySearchStatus", "replaySearchError", "replaySearchMore"].map(id => [id, new Element()]));
  const document = { getElementById: id => elements.get(id), createElement: tag => new Element(tag) };
  const calls = [], downloads = [];
  const window = { fetch: async (path, options) => { calls.push({ path, options }); return handler(path, options); },
    location: { assign: value => downloads.push(value) }, addEventListener() {} };
  const client = mountReplaySearch(document, window, { now: () => now });
  return { client, elements, calls, downloads };
}

test("compact rows show host/date/room only, render hostile names as text, and download after preflight", async () => {
  const name = '<img src=x onerror="bad()">';
  const f = domFixture(async path => path.endsWith("/search") ? response(result({ hostName: name, history: [capture({ hostName: name })], hasMore: true })) : response(capture()));
  assert.equal(f.calls.length, 0); assert.equal(f.elements.get("replaySearchResults").children.length, 0);
  await f.client.search(name);
  const list = f.elements.get("replaySearchResults"), nodes = descendants(list);
  assert.ok(list.textContent.includes(name)); assert.ok(list.textContent.includes("DRXPTJ")); assert.match(list.textContent, /2026/);
  assert.ok(!list.textContent.includes(feature)); assert.ok(!list.textContent.includes("hostKey"));
  assert.equal(nodes.filter(node => node.tagName === "IMG").length, 1, "only the fixed game artwork is an image");
  assert.equal(f.elements.get("replaySearchMore").hidden, false);
  const download = nodes.find(node => node.tagName === "BUTTON"); await download.listeners.get("click")();
  assert.deepEqual(f.downloads, [`/api/navigation/replays/DRXPTJ/${feature}/archive.zip`]);
  f.elements.get("replaySearchName").listeners.get("input")();
  assert.equal(list.children.length, 0); assert.equal(f.calls.length, 2); f.client.dispose();
});

test("mount renders empty/error/expired states accessibly without issuing background enumeration", async () => {
  let value = result({ history: [] });
  const f = domFixture(async () => response(value));
  await f.client.search("Mylu"); assert.match(f.elements.get("replaySearchStatus").textContent, /没有找到/);
  await f.client.search(" "); assert.equal(f.elements.get("replaySearchError").hidden, false);
  value = result({ history: [capture({ expiresUtc: "2026-11-08T00:00:00Z" })] });
  await f.client.search("Mylu");
  const nodes = descendants(f.elements.get("replaySearchResults"));
  assert.match(f.elements.get("replaySearchResults").textContent, /已到期/); assert.equal(nodes.find(node => node.tagName === "BUTTON").disabled, true);
  assert.equal(f.calls.length, 2); f.client.dispose();
});

test("the page adds an isolated nickname form with no populated records or retired launchers", async () => {
  const html = await readFile(new URL("../record.html", import.meta.url), "utf8");
  const code = await readFile(new URL("../src/replay-search.js", import.meta.url), "utf8");
  assert.match(html, /src="\.\/src\/replay-search\.js"/); assert.match(html, /id="replaySearchResults"[^>]*><\/div>/);
  assert.match(html, /id="replaySearchName" maxlength="200"/);
  assert.doesNotMatch(code, /innerHTML|localStorage|\/api\/packet-replay\/captures/);
});
