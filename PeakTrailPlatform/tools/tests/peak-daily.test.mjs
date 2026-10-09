import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { cachedDailyIsFresh, createDailyCache, DEFAULT_API_VERSION, resolveDaily } from "../../server/peak-daily.mjs";
import { createDailyApi } from "../lib/daily-api.mjs";

const START = Date.parse("2026-10-07T06:10:00Z");
const payload = (extra = {}) => ({ VersionOkay: true, LevelIndex: 479, HoursUntilLevel: 10,
  MinutesUntilLevel: 50, SecondsUntilLevel: 0, Message: "synthetic daily fixture", ...extra });
const response = data => ({ ok: true, json: async () => data });
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }

test("resolver uses the verified native matchmaking version and timestamps the received response", async () => {
  let now = START, requested;
  const daily = await resolveDaily({ now: () => now, apiVersion: DEFAULT_API_VERSION,
    fetchImpl: async (url, options) => {
      requested = url;
      assert.equal(options.headers["User-Agent"], "peak-trail-platform-daily-monitor/1.0");
      now += 4000;
      return response(payload());
    } });
  assert.equal(DEFAULT_API_VERSION, "2.6");
  assert.match(requested, /VersionCheck\?version=2\.6$/);
  assert.equal(daily.versionOkay, true);
  assert.equal(daily.levelIndex, 479);
  assert.equal(daily.mapSlot, 17);
  assert.equal(daily.sceneName, "Level_17");
  assert.equal(Date.parse(daily.fetchedAtUtc), now, "not the clock before an upstream delay");
  assert.equal(Date.parse(daily.nextChangeAtUtc), now + 39000_000);
});

test("rejected versions and malformed countdowns cannot become valid observations", async () => {
  for (const bad of [payload({ VersionOkay: false }), payload({ LevelIndex: 1.5 }),
    payload({ HoursUntilLevel: 24 }), payload({ MinutesUntilLevel: 60 }),
    payload({ SecondsUntilLevel: undefined }), payload({ SecondsUntilLevel: -1 })]) {
    await assert.rejects(resolveDaily({ now: () => START, fetchImpl: async () => response(bad) }));
  }
  await assert.rejects(resolveDaily({ mapCount: 0 }), /PEAK_MAP_COUNT/);
});

test("a query crossing Shanghai 01:00 rechecks the rotation instead of relabelling the old map", async () => {
  let now = Date.parse("2026-10-07T16:59:59Z"), calls = 0;
  const waits = [];
  const daily = await resolveDaily({ now: () => now, sleepImpl: async ms => { waits.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) { now += 2000; return response(payload({ SecondsUntilLevel: 1 })); }
      return response(payload({ LevelIndex: 480, HoursUntilLevel: 23, MinutesUntilLevel: 59, SecondsUntilLevel: 59 }));
    } });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.equal(daily.sceneName, "Level_18");
  assert.equal(cachedDailyIsFresh(daily, now), true);
});

test("future, expired and previous-rotation cache timestamps require a fresh upstream observation", async () => {
  const daily = await resolveDaily({ now: () => START, fetchImpl: async () => response(payload()) });
  assert.equal(cachedDailyIsFresh(daily, START), true);
  assert.equal(cachedDailyIsFresh(daily, START - 1), false);
  assert.equal(cachedDailyIsFresh(daily, Date.parse(daily.nextChangeAtUtc)), false);
  assert.equal(cachedDailyIsFresh({ ...daily, nextChangeAtUtc: "2026-10-09T17:00:00Z" },
    Date.parse("2026-10-07T17:00:00Z")), false);
  let calls = 0;
  const cache = createDailyCache({ now: () => START,
    resolver: async () => { calls += 1; return { ...daily, fetchedAtUtc: new Date(START + 1).toISOString() }; } });
  await cache.read(); await cache.read();
  assert.equal(calls, 2, "future observations cannot gain a ten-minute TTL");
});

test("preview /api/daily resolves and coalesces independently of a live relay; methods and failures stay bounded", async () => {
  const daily = await resolveDaily({ now: () => START, fetchImpl: async () => response(payload()) });
  let calls = 0, fail = false, now = START;
  let release, resolverEntered, bothRequestsEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const enteredResolver = new Promise(resolve => { resolverEntered = resolve; });
  const enteredBothRequests = new Promise(resolve => { bothRequestsEntered = resolve; });
  const api = createDailyApi({ now: () => now,
    resolver: async () => { calls += 1; resolverEntered(); await gate; if (fail) throw new Error("offline"); return daily; } });
  let arrived = 0;
  const server = createServer(async (req, res) => {
    const handling = api.handle(req, res);
    if (req.url === "/api/daily" && req.method === "GET" && ++arrived === 2) bothRequestsEntered();
    if (!await handling) res.writeHead(404).end();
  });
  const origin = await listen(server);
  let concurrent;
  try {
    concurrent = Promise.all([fetch(`${origin}/api/daily`), fetch(`${origin}/api/daily`)]);
    // Both actual HTTP handlers have entered the blocked resolver/cache read.
    // Scheduling speed cannot substitute for the overlap being exercised.
    await Promise.all([enteredResolver, enteredBothRequests]);
    assert.equal(arrived, 2);
    assert.equal(calls, 1);
    release();
    const both = await concurrent;
    for (const item of both) {
      assert.equal(item.status, 200);
      assert.equal(item.headers.get("cache-control"), "no-store");
      assert.equal((await item.json()).sceneName, "Level_17");
    }
    assert.equal((await fetch(`${origin}/api/daily`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/api/runs`)).status, 404);
    const head = await fetch(`${origin}/api/daily`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal(calls, 1);
    now += 600_000; fail = true;
    const failure = await fetch(`${origin}/api/daily`);
    assert.equal(failure.status, 502);
    assert.deepEqual(await failure.json(), { error: "daily-unavailable" });
    fail = false;
    assert.equal((await fetch(`${origin}/api/daily`)).status, 200);
    assert.equal(calls, 3, "failures do not poison the next retry");
  } finally {
    release();
    await concurrent?.catch(() => {});
    await close(server);
  }
});

function runUpdater(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, windowsHide: true });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.once("error", reject); child.once("exit", code => resolve({ code, output }));
  });
}

test("scheduled updater shares the resolver version and preserves the old snapshot when the API rejects it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peak-daily-"));
  let okay = false, requestVersion;
  const upstream = createServer((req, res) => {
    requestVersion = new URL(req.url, "http://localhost").searchParams.get("version");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload({ VersionOkay: okay })));
  });
  const origin = await listen(upstream);
  try {
    await Promise.all(["tools", "server", "data/daily"].map(path => mkdir(join(directory, path), { recursive: true })));
    await copyFile(new URL("../update-daily.mjs", import.meta.url), join(directory, "tools/update-daily.mjs"));
    await copyFile(new URL("../../server/peak-daily.mjs", import.meta.url), join(directory, "server/peak-daily.mjs"));
    const currentPath = join(directory, "data/daily/current.json");
    const previous = '{"sceneName":"Level_8","fetchedAtUtc":"2026-09-27T20:07:47Z"}\n';
    await writeFile(currentPath, previous);
    const env = { PEAK_DAILY_ENDPOINT: `${origin}/VersionCheck?version=2.6`, PEAK_API_VERSION: "", PEAK_MAP_COUNT: "21" };
    const rejected = await runUpdater(join(directory, "tools/update-daily.mjs"), env);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.output, /rejected API version 2\.6/);
    assert.equal(await readFile(currentPath, "utf8"), previous);
    okay = true;
    const accepted = await runUpdater(join(directory, "tools/update-daily.mjs"), env);
    assert.equal(accepted.code, 0, accepted.output);
    const current = JSON.parse(await readFile(currentPath, "utf8"));
    assert.equal(current.apiVersion, DEFAULT_API_VERSION);
    assert.equal(current.sceneName, "Level_17");
    assert.equal(requestVersion, "2.6");
    const workflow = await readFile(new URL("../../../.github/workflows/peak-daily-map.yml", import.meta.url), "utf8");
    assert.match(workflow, /PEAK_API_VERSION: \$\{\{ vars\.PEAK_API_VERSION \}\}/);
    assert.doesNotMatch(workflow, /PEAK_API_VERSION: ["']?2\.4/);
    const preview = await readFile(new URL("../serve-site.mjs", import.meta.url), "utf8");
    assert.match(preview, /dailyApi\.handle\(request, response\)/);
  } finally { await close(upstream); await rm(directory, { recursive: true, force: true }); }
});
