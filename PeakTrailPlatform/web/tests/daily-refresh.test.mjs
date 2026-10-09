import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDailyRefreshClock, createDailySourceReader, dailyObservationIsFresh,
  dailySourceUrls, latestDailyBoundary, nextDailyBoundary, DAILY_RECHECK_MS } from "../src/daily-refresh.js";
import { buildHomeDailyView } from "../src/home-daily.js";

const START = Date.parse("2026-09-24T16:59:50Z");
const API = "https://peak.example/api/daily";
const STATIC = "./data/daily/current.json";
function daily(slot = 4, deadline = START + 10_000) {
  return { schemaVersion: 1, versionOkay: true, levelIndex: 462 + slot, mapSlot: slot,
    mapCount: 21, sceneName: `Level_${slot}`, fetchedAtUtc: new Date(START).toISOString(),
    nextChangeAtUtc: new Date(deadline).toISOString() };
}
const response = data => ({ ok: true, json: async () => data });
const freshness = (data, now) => buildHomeDailyView({ daily: data, now }).freshness;

test("daily sources prefer the same-origin API without relying on live tracking or port 8787", () => {
  const location = { protocol: "http:", origin: "http://127.0.0.1:4173" };
  assert.deepEqual(dailySourceUrls({ location }), ["http://127.0.0.1:4173/api/daily", STATIC]);
  assert.deepEqual(dailySourceUrls({ location, relayUrl: "http://127.0.0.1:8787/" }),
    ["http://127.0.0.1:4173/api/daily", "http://127.0.0.1:8787/api/daily", STATIC]);
  assert.deepEqual(dailySourceUrls({ location: { protocol: "https:", origin: "https://peak.example" },
    relayUrl: "https://peak.example" }), [API, STATIC]);
  assert.deepEqual(dailySourceUrls({ location: { protocol: "file:", origin: "null" } }), [STATIC]);
});

test("a working preview daily API replaces expired Level_8 even with the live relay stopped", async () => {
  const now = Date.parse("2026-10-07T06:10:00Z");
  const current = { ...daily(17), levelIndex: 479, fetchedAtUtc: new Date(now).toISOString(),
    nextChangeAtUtc: "2026-10-07T17:00:00Z" };
  const old = { ...daily(8), fetchedAtUtc: "2026-09-27T20:07:47Z", nextChangeAtUtc: "2026-09-28T17:00:00Z" };
  const calls = [];
  const sources = () => dailySourceUrls({ location: { protocol: "http:", origin: "http://127.0.0.1:4173" },
    relayUrl: "http://127.0.0.1:8787" });
  const reader = createDailySourceReader({ sources, freshness, now: () => now,
    fetchImpl: async url => { calls.push(url); return response(url.endsWith(":4173/api/daily") ? current : old); } });
  const result = await reader.read();
  assert.equal(result.sceneName, "Level_17");
  assert.equal(freshness(result, now), "current");
  assert.deepEqual(calls, ["http://127.0.0.1:4173/api/daily"]);
  assert.equal(freshness(old, now), "stale", "old fallback dates are never renewed");
});

test("the refresh boundary is the most recent reached 01:00 in Asia/Shanghai", () => {
  const before = Date.parse("2026-09-24T16:59:59.999Z");
  const at = Date.parse("2026-09-24T17:00:00.000Z");
  assert.equal(latestDailyBoundary(before), Date.parse("2026-09-23T17:00:00.000Z"));
  assert.equal(nextDailyBoundary(before), at);
  assert.equal(latestDailyBoundary(at), at);
  assert.equal(nextDailyBoundary(at), Date.parse("2026-09-25T17:00:00.000Z"));
  const misleadingDeadline = Date.parse("2026-09-26T17:00:00.000Z");
  assert.equal(dailyObservationIsFresh(daily(4, misleadingDeadline), before), true);
  assert.equal(dailyObservationIsFresh(daily(4, misleadingDeadline), at), false);
  assert.equal(dailyObservationIsFresh({ ...daily(4, misleadingDeadline), fetchedAtUtc: new Date(at).toISOString() }, at), true);
});

test("daily readers coalesce overlapping fetches and prefer the current API", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = [];
  const reader = createDailySourceReader({ sources: () => [API, STATIC], freshness, now: () => START,
    fetchImpl: async (url, options) => { calls.push(url); assert.equal(options.cache, "no-store"); await pending; return response(daily()); } });
  const first = reader.read(), second = reader.read();
  assert.equal(first, second);
  assert.deepEqual(calls, [API]);
  release();
  assert.equal((await first).sceneName, "Level_4");
  assert.equal(reader.retryAt, 0);
});

test("skipped stale API retries do not move their deadline and recover without static Action data", async () => {
  let now = START + 10_000;
  const initial = now;
  let apiCalls = 0;
  const reader = createDailySourceReader({ sources: () => [API, STATIC], freshness, now: () => now,
    fetchImpl: async url => {
      if (url === API) apiCalls += 1;
      return response(url === API && apiCalls > 1
        ? { ...daily(5, START + 86400_000), fetchedAtUtc: new Date(now).toISOString() }
        : daily());
    } });
  assert.equal((await reader.read()).sceneName, "Level_4");
  assert.equal(reader.retryAt, initial + 30_000);
  for (const elapsed of [5000, 10_000, 20_000, 29_999]) {
    now = initial + elapsed;
    await reader.read();
    assert.equal(apiCalls, 1);
    assert.equal(reader.retryAt, initial + 30_000, "fallback polling cannot postpone a backend retry");
  }
  now = initial + 30_000;
  assert.equal((await reader.read()).sceneName, "Level_5");
  assert.equal(apiCalls, 2);
  assert.equal(reader.retryAt, 0);
});

test("API failure permits a current static fallback and a bounded automatic recovery", async () => {
  let now = START, failed = true, calls = 0;
  const reader = createDailySourceReader({ sources: () => [API, STATIC], freshness, now: () => now,
    fetchImpl: async url => {
      if (url === API) { calls += 1; if (failed) throw new Error("offline"); }
      return response(daily(url === API ? 5 : 4, START + 86400_000));
    } });
  assert.equal((await reader.read()).sceneName, "Level_4");
  const retryAt = reader.retryAt;
  now += 1000; failed = false;
  assert.equal((await reader.read()).sceneName, "Level_4");
  assert.equal(reader.retryAt, retryAt);
  now = retryAt;
  assert.equal((await reader.read()).sceneName, "Level_5");
  assert.equal(calls, 2);
});

test("expired observations remain labelled last-confirmed, never inferred as the next map", async () => {
  const now = START + 20_000;
  const reader = createDailySourceReader({ sources: () => [API, STATIC], freshness, now: () => now,
    fetchImpl: async () => response(daily()) });
  const result = await reader.read();
  const view = buildHomeDailyView({ daily: result, now });
  assert.equal(result.sceneName, "Level_4");
  assert.equal(view.isCurrent, false);
  assert.equal(view.freshness, "stale");
  assert.equal(view.statusLabel, "上次确认的五段路线");
});

test("unavailable or malformed observations remain unknown", async () => {
  const reader = createDailySourceReader({ sources: () => [API, STATIC], freshness, now: () => START,
    fetchImpl: async url => url === API ? { ok: false, status: 502 } : response({ sceneName: "Level_5" }) });
  assert.equal(await reader.read(), null);
  assert.equal(reader.retryAt, START + 30_000);
});

function fakeTimers() {
  let now = START, nextId = 1;
  const timers = new Map();
  return { now: () => now, timers,
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimer: id => timers.delete(id),
    sleepUntil: time => { now = time; },
    async advance(time) {
      now = time;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); await timer.callback(); }
    },
  };
}

test("the rotation boundary expires old data and refreshes immediately, without waiting for the slow poll", async () => {
  const timer = fakeTimers(), calls = [];
  const clock = createDailyRefreshClock({ ...timer, expire: async value => calls.push(`expire:${value.sceneName}`),
    refresh: async () => calls.push("refresh") });
  clock.schedule(daily());
  await timer.advance(START + 9999);
  assert.deepEqual(calls, []);
  await timer.advance(START + 10_050);
  assert.deepEqual(calls, ["expire:Level_4", "refresh"]);
  clock.dispose();
});

test("the Shanghai boundary refreshes a pre-01:00 cache even when its reported deadline is later", async () => {
  const timer = fakeTimers(), calls = [];
  const clock = createDailyRefreshClock({ ...timer, expire: async value => calls.push(`expire:${value.sceneName}`),
    refresh: async () => calls.push("refresh") });
  clock.schedule(daily(4, START + 86400_000));
  await timer.advance(START + 9999);
  assert.deepEqual(calls, []);
  await timer.advance(START + 10_050);
  assert.deepEqual(calls, ["expire:Level_4", "refresh"]);
  clock.dispose();
});

test("a fallback refresh does not postpone an already-scheduled backend retry", async () => {
  const timer = fakeTimers(); let calls = 0;
  const clock = createDailyRefreshClock({ ...timer, expire: async () => {}, refresh: async () => { calls += 1; } });
  const retryAt = START + 30_000;
  clock.schedule(daily(4, START + 86400_000), retryAt);
  timer.sleepUntil(START + 20_000);
  clock.schedule(daily(4, START + 86400_000), retryAt);
  await timer.advance(retryAt + 50);
  assert.equal(calls, 1);
  clock.dispose();
  assert.equal(timer.timers.size, 0);
});

test("visibility wake rechecks expired data after suspended timers and coalesces refreshes", async () => {
  const timer = fakeTimers(), calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const clock = createDailyRefreshClock({ ...timer, expire: async () => calls.push("expire"),
    refresh: async () => { calls.push("refresh"); await pending; } });
  clock.schedule(daily());
  timer.sleepUntil(START + 40_000);
  const first = clock.wake(), second = clock.wake();
  assert.equal(first, second);
  release(); await first;
  assert.deepEqual(calls, ["expire", "refresh"]);
  clock.dispose();
  await clock.wake();
  assert.deepEqual(calls, ["expire", "refresh"]);
});

test("visibility and slow polls do not refetch a cache already confirmed after this boundary", async () => {
  const timer = fakeTimers(); let calls = 0;
  const current = { ...daily(4, START + 86400_000), fetchedAtUtc: new Date(START + 10_000).toISOString() };
  const clock = createDailyRefreshClock({ ...timer, expire: async () => {}, refresh: async () => { calls += 1; } });
  timer.sleepUntil(START + 20_000);
  clock.schedule(current);
  await Promise.all([clock.wake(), clock.wake(), clock.wake()]);
  assert.equal(calls, 0);
  clock.dispose();
});

test("an open map checks for official intraday changes within ten minutes while retaining the valid model", async () => {
  const timer = fakeTimers(), calls = [];
  const confirmedAt = START + 20_000;
  timer.sleepUntil(confirmedAt);
  const current = { ...daily(4, confirmedAt + 86400_000), fetchedAtUtc: new Date(confirmedAt).toISOString() };
  const replacement = { ...current, levelIndex: 470, mapSlot: 8, sceneName: "Level_8" };
  let clock;
  clock = createDailyRefreshClock({ ...timer,
    expire: async () => calls.push("expire"),
    refresh: async () => {
      calls.push(replacement.sceneName);
      clock.schedule({ ...replacement, fetchedAtUtc: new Date(timer.now()).toISOString() });
    } });
  assert.equal(DAILY_RECHECK_MS, 600_000);
  clock.schedule(current);
  await timer.advance(confirmedAt + DAILY_RECHECK_MS - 1);
  assert.deepEqual(calls, []);
  await timer.advance(confirmedAt + DAILY_RECHECK_MS + 50);
  assert.deepEqual(calls, ["Level_8"], "the still-valid model is not expired or cleared before confirmation");
  await clock.wake();
  assert.equal(calls.length, 1, "a fresh official observation gains a new check interval");
  clock.dispose();
});

test("resuming a suspended tab rechecks an old but unexpired official observation", async () => {
  const timer = fakeTimers(); let expired = 0, refreshed = 0;
  const currentAt = START + 20_000;
  timer.sleepUntil(currentAt);
  const current = { ...daily(4, currentAt + 7 * 86400_000), fetchedAtUtc: new Date(currentAt).toISOString() };
  const clock = createDailyRefreshClock({ ...timer, expire: async () => { expired += 1; },
    refresh: async () => { refreshed += 1; } });
  clock.schedule(current);
  timer.sleepUntil(currentAt + DAILY_RECHECK_MS + 1);
  await clock.wake();
  assert.equal(refreshed, 1);
  assert.equal(expired, 0);
  clock.dispose();
});

test("application expiry preserves imported traces and wires visibility recovery", () => {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const expire = source.slice(source.indexOf("async function expireDailyStatus"), source.indexOf('elements.eventList.addEventListener("scroll"'));
  assert.match(expire, /if \(state\.trace\) return;/);
  assert.match(expire, /if \(!document\.hidden\) void dailyClock\.wake\(\);/);
  assert.match(source, /const trace = state\.trace;\s+await syncMapForTrace\(trace, true\);/);
  assert.match(source, /dailyClock\.schedule\(state\.daily, dailyReader\.retryAt\);/);
  assert.match(source, /setInterval\(\(\) => void dailyClock\.wake\(\), 5 \* 60_000\);/);
});

function applicationExpiry(state, clearDailyMap, updateMapUI = () => {}) {
  const source = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const start = source.indexOf("async function expireDailyStatus");
  const end = source.indexOf('document.addEventListener("visibilitychange"', start);
  return new Function("state", "isDailyMapFresh", "clearDailyMap", "updateMapUI",
    `${source.slice(start, end)}; return expireDailyStatus;`)(state,
      value => freshness(value, START + 20_000) === "current", clearDailyMap, updateMapUI);
}

test("an old expiry callback cannot clear a newly refreshed daily map", async () => {
  const next = { ...daily(5, START + 86400_000), fetchedAtUtc: new Date(START + 10_000).toISOString() };
  const state = { daily: next, mapSourceKind: "daily", mapRequestRevision: 7, dailyMapStatus: null };
  let cleared = 0;
  const expire = applicationExpiry(state, async () => { cleared += 1; });
  await expire(daily());
  await expire(next); // A premature callback cannot expire current data either.
  assert.equal(cleared, 0);
  assert.equal(state.mapRequestRevision, 7);
  assert.equal(state.dailyMapStatus, null);
});

test("expiry keeps the last confirmed automatic map visible while refresh recovers", async () => {
  const previous = daily(), previousMap = { sceneName: "Level_4" };
  const state = { daily: previous, mapSourceKind: "daily", mapPack: previousMap,
    mapRequestRevision: 7, manualMapLoads: 0 };
  let cleared = 0, updates = 0;
  const expire = applicationExpiry(state, async () => { cleared += 1; }, () => { updates += 1; });
  await expire(previous);
  assert.equal(cleared, 0);
  assert.equal(state.mapPack, previousMap);
  assert.match(state.dailyMapStatus.detail, /保留上次确认的地图/);
  assert.equal(updates, 1);
});
