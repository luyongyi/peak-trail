import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { setImmediate as nextTurn, setTimeout as pause } from "node:timers/promises";
import { createTrajectoryApi } from "../../server/trajectory-api.mjs";
import { digest } from "../../server/trajectory-contract.mjs";

const uploadHeaders = { "content-type": "application/json", "content-encoding": "gzip", "x-trajectory-format": "trajectory-v1" };
function fixture(name = "baseline") {
  return { format: "trajectory-v1", recordingId: digest(name), runKey: digest(`run-${name}`), timeOriginMs: 0,
    startedUtc: "2026-10-15T00:00:00Z", durationMs: 200, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", route: ["Shore"], stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 200 }] },
    difficulty: { ascent: 1, custom: false, mini: false }, players: [{ key: digest("synthetic-player"), name: "Synthetic maintenance fixture",
      owner: true, evidence: "native-state", points: [[0,0,0,0], [100,0,0,100], [200,0,0,200]], events: [{ tMs: 0, kind: "game-stage", stageIndex: 0 }] }] };
}
async function serve(root, options = {}, observe = () => {}) {
  const api = createTrajectoryApi({ root, catalogPath: join(tmpdir(), "missing-maintenance-fixture-catalog.json"), ...options });
  const server = createServer((req, res) => { observe(req); api.handle(req, res).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }); });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { base: `http://127.0.0.1:${server.address().port}`, api, close: async () => {
    api.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
  } };
}
async function post(base, name = "baseline") {
  const res = await fetch(`${base}/api/route-uploads`, { method: "POST", headers: uploadHeaders, body: gzipSync(JSON.stringify(fixture(name))) });
  return { status: res.status, body: await res.json() };
}
async function get(base) {
  const res = await fetch(`${base}/api/route-groups`); return { status: res.status, body: await res.json() };
}
async function snapshot(root) {
  const files = {};
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".migration-maintenance") continue;
      const path = join(directory, entry.name), key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path, `${key}/`);
      else files[key] = digest(await readFile(path));
    }
  }
  await visit(root); return files;
}
async function until(predicate) {
  for (let turn = 0; turn < 2000 && !predicate(); turn++) await nextTurn();
  assert.ok(predicate(), "expected request lifecycle did not arrive");
}
function openRequest(base, headers = uploadHeaders) {
  let req;
  const result = new Promise((done, reject) => {
    req = request(`${base}/api/route-uploads`, { method: "POST", headers }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => done({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("maintenance barrier did not respond before reading the body")));
  });
  return { req, result };
}

test("maintenance rejects HTTP uploads before reading any body, preserves GET data, and removal restores uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-maintenance-")), server = await serve(root);
  try {
    const first = await post(server.base); assert.equal(first.status, 201);
    const groups = await get(server.base), before = await snapshot(root);
    assert.equal(groups.status, 200); assert.equal(groups.body.groups.length, 1);
    const marker = join(root, ".migration-maintenance");
    await writeFile(marker, "operator controlled\n"); await utimes(marker, new Date(0), new Date(0));
    const noBody = openRequest(server.base, { ...uploadHeaders, "content-length": "1024" });
    noBody.req.flushHeaders();
    try { assert.deepEqual(await noBody.result, { status: 503, body: { error: "route-storage-maintenance" } }); }
    finally { noBody.req.destroy(); }
    assert.deepEqual(await get(server.base), groups);
    assert.equal((await post(server.base, "next")).status, 503);
    assert.deepEqual(await snapshot(root), before, "GET and rejected POST must not write stored data");
    await rm(marker);
    assert.equal((await post(server.base, "next")).status, 201);
    assert.equal((await post(server.base, "next")).status, 200);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("cold GET defers automatic pending review during maintenance and resumes review after removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-maintenance-review-")); let server = await serve(root);
  try {
    const first = await post(server.base); assert.equal(first.status, 201); await server.close();
    const indexPath = join(root, "index", `${first.body.uploadId}.json`), entry = JSON.parse(await readFile(indexPath, "utf8"));
    entry.moderationStatus = "pending"; delete entry.reviewedUtc; delete entry.reviewMethod; delete entry.startedUtc;
    await writeFile(indexPath, JSON.stringify(entry));
    await writeFile(join(root, ".migration-maintenance"), "manual\n");
    const before = await snapshot(root); server = await serve(root);
    for (let i = 0; i < 2; i++) assert.deepEqual((await get(server.base)).body.groups, []);
    assert.deepEqual(await snapshot(root), before, "read-only acceptance must not auto-review a pending index");
    await rm(join(root, ".migration-maintenance"));
    assert.equal((await get(server.base)).body.groups.length, 1);
    assert.equal(JSON.parse(await readFile(indexPath, "utf8")).moderationStatus, "approved");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("maintenance appearing during an HTTP body read rejects the finished upload without a worker or stored write", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-maintenance-body-")); let bodyStarted = false, workers = 0;
  const server = await serve(root, { workerFactory: () => { workers++; throw new Error("upload escaped the barrier"); } }, req => {
    const iterate = req[Symbol.asyncIterator];
    req[Symbol.asyncIterator] = function () { bodyStarted = true; return iterate.call(this); };
  });
  const compressed = gzipSync(JSON.stringify(fixture()));
  const pending = openRequest(server.base, { ...uploadHeaders, "content-length": String(compressed.length) });
  try {
    pending.req.write(compressed.subarray(0, 1)); await until(() => bodyStarted);
    await writeFile(join(root, ".migration-maintenance"), "manual\n"); pending.req.end(compressed.subarray(1));
    assert.equal((await pending.result).status, 503); assert.equal(workers, 0); assert.deepEqual(await snapshot(root), {});
  } finally { pending.req.destroy(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("a queued HTTP upload rechecks maintenance at actual worker spawn and never releases an active worker early", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-maintenance-queue-")), workers = [], jobs = []; let bodyEnded = false;
  class HeldWorker extends EventEmitter { terminate() { return Promise.resolve(1); } }
  const server = await serve(root, { workerFactory: (_url, options) => { const worker = new HeldWorker(); workers.push(worker); jobs.push(options.workerData); return worker; } }, req => {
    if (req.method === "POST") req.once("end", () => { bodyEnded = true; });
  });
  try {
    const first = get(server.base); await until(() => workers.length === 1);
    const upload = post(server.base); await until(() => bodyEnded); await pause(30);
    assert.equal(workers.length, 1);
    await writeFile(join(root, ".migration-maintenance"), "manual\n");
    workers[0].emit("message", { json: '{"groups":[]}', migrationComplete: true });
    await nextTurn(); assert.equal(workers.length, 1);
    workers[0].emit("exit", 0); assert.equal((await first).status, 200);
    assert.equal((await upload).status, 503); assert.equal(workers.length, 1); assert.equal(jobs[0].operation, "groups");
    assert.deepEqual(await snapshot(root), {});
  } finally { for (const worker of workers) worker.emit("exit", 1); await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("any marker entry and non-ENOENT stat errors fail closed, while missing configuration remains explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "peak-maintenance-types-")); let server;
  try {
    await mkdir(join(root, ".migration-maintenance")); server = await serve(root);
    assert.equal((await post(server.base)).status, 503); await server.close();
    // An invalid filesystem path produces a non-ENOENT lstat failure on both
    // Windows and Linux, without depending on the test runner's privileges.
    server = await serve(join(root, "invalid\0root"));
    assert.deepEqual(await post(server.base), { status: 503, body: { error: "route-maintenance-state-unavailable" } }); await server.close();
    server = await serve(null);
    assert.deepEqual(await post(server.base), { status: 503, body: { error: "route-storage-unconfigured" } });
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
});
