import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { digest, validateTrajectory } from "../../server/trajectory-contract.mjs";
import { ingestUpload, verifyStoredEntry, loadIndex } from "../../server/trajectory-store.mjs";
import { planTrajectoryStorage, missingPointBlockBytes, writePointBlocks, readStoredTrajectory } from "../../server/trajectory-storage.mjs";
import { readPointContext, readPackedPointBytes, planPointPacks } from "../../server/trajectory-point-packs.mjs";

function fixture(recording = "pack-crash-fixture", jitter = 0) {
  return { format: "trajectory-v1", recordingId: digest(recording), runKey: digest("pack-fixture-shared-run"), timeOriginMs: -37,
    startedUtc: "2026-10-15T00:00:00Z", durationMs: 120000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", route: ["Shore"],
      stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 100000 }] },
    difficulty: { ascent: 3, custom: false, mini: false }, players: [{ key: digest("pack-fixture-player"), name: "Synthetic pack scout", owner: true, evidence: "native-state",
      points: Array.from({ length: 1200 }, (_, index) => [index * 100,
        Math.round(Math.sin(index / 13) * 1000) + jitter, Math.round(Math.cos(index / 17) * 100) || 0, index * 100]),
      events: [{ tMs: 0, kind: "game-stage", stageIndex: 0 }, { tMs: 10000, kind: "dead" },
        { tMs: 15000, kind: "revive" }, { tMs: 17000, kind: "break" }, { tMs: 21000, kind: "warp" }] }] };
}

async function temporary(t) {
  const parent = await mkdtemp(join(tmpdir(), "peak-point-pack-crash-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root: join(parent, "store"), catalog: join(parent, "missing-catalog.json") };
}

const storeUrl = new URL("../../server/trajectory-store.mjs", import.meta.url).href;
// Fault injection is isolated in an expendable process/thread and happens before
// product imports. No production fault hook, real store or network is involved.
const childScript = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { gzipSync } from "node:zlib";
const input = workerData ?? await new Promise(resolve => process.once("message", resolve));
const hold = setInterval(() => {}, 1000);
const notify = message => parentPort ? parentPort.postMessage(message) : process.send(message);
const normalized = path => String(path).replaceAll("\\\\", "/");
async function checkpoint(stage) { notify({ checkpoint: stage }); await new Promise(() => {}); }
const originalLink = fs.promises.link, originalRename = fs.promises.rename;
fs.promises.link = async (from, to) => {
  const result = await originalLink(from, to), path = normalized(to);
  if (input.stopAt === "pack" && path.endsWith(".pack")) await checkpoint("pack");
  if (input.stopAt === "upload" && path.includes("/uploads/") && path.endsWith(".json.gz")) await checkpoint("upload");
  return result;
};
fs.promises.rename = async (from, to) => {
  const result = await originalRename(from, to), path = normalized(to);
  if (input.stopAt === "context" && path.includes("/point-bases/context-") && path.endsWith(".json")) await checkpoint("context");
  return result;
};
syncBuiltinESMExports();
try {
  const { ingestUpload } = await import(${JSON.stringify(storeUrl)});
  const result = await ingestUpload(input.root, gzipSync(JSON.stringify(input.raw)), input.catalog);
  notify({ result });
} catch (error) { notify({ error: { message: error.message, statusCode: error.statusCode } }); process.exitCode = 1; }
finally { clearInterval(hold); if (parentPort) parentPort.close(); else if (process.connected) process.disconnect(); }
`;

function controlledRun(t, input, { thread = false } = {}) {
  const runner = thread
    ? new Worker(new URL(`data:text/javascript,${encodeURIComponent(childScript)}`), { workerData: input })
    : spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "", answer, settled = false;
  runner.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-4096); });
  let milestoneResolve, milestoneReject;
  const milestone = new Promise((resolve, reject) => { milestoneResolve = resolve; milestoneReject = reject; });
  // Some callers only await completion; keep a startup failure from becoming an unhandled rejection.
  milestone.catch(() => {});
  const completed = new Promise((resolve, reject) => {
    runner.on("message", message => {
      if (message.checkpoint) milestoneResolve(message.checkpoint);
      if (message.result) answer = message.result;
      if (message.error) answer = { error: message.error };
    });
    runner.once("error", error => { settled = true; milestoneReject(error); reject(error); });
    runner.once("exit", (code, signal) => {
      settled = true;
      if (input.stopAt) { resolve({ code, signal }); milestoneReject(new Error(`Fault checkpoint was not reached: ${code}/${signal} ${stderr}`)); return; }
      if (code !== 0 || !answer || answer.error) {
        const error = new Error(`Synthetic pack child failed: ${JSON.stringify(answer?.error) ?? stderr} (${code}/${signal})`);
        milestoneReject(error); reject(error);
      } else resolve(answer);
    });
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      milestoneReject(new Error("Synthetic pack child timed out"));
      if (thread) runner.terminate(); else runner.kill("SIGKILL");
    }
  }, 15000);
  completed.finally(() => clearTimeout(timeout)).catch(() => {});
  t.after(async () => {
    if (!settled) { if (thread) await runner.terminate(); else runner.kill("SIGKILL"); }
    await completed.catch(() => {});
  });
  if (!thread) runner.once("spawn", () => runner.send(input));
  return { runner, milestone, completed, async stop() {
    if (thread) await runner.terminate(); else runner.kill("SIGKILL");
    return completed;
  } };
}

test("same-context direct concurrent pack writers atomically merge every logical block and retain valid plain bases", async t => {
  const { root, catalog } = await temporary(t), a = fixture("concurrent-a"), b = fixture("concurrent-b", 1);
  const plans = [a, b].map(raw => planTrajectoryStorage(validateTrajectory(raw).trajectory));
  await Promise.all(plans.map(plan => missingPointBlockBytes(root, plan)));
  await Promise.all(plans.map(plan => writePointBlocks(root, plan)));
  const context = plans[0].blockInfo.values().next().value.context;
  const { index } = await readPointContext(root, context);
  const hashes = new Set(plans.flatMap(plan => [...plan.blocks.keys()]));
  assert.deepEqual(new Set(Object.keys(index.blocks)), hashes);
  assert.ok(Object.values(index.bases).every(hash => index.blocks[hash].type === 1));
  for (const raw of [a, b]) {
    const result = await ingestUpload(root, gzipSync(JSON.stringify(raw)), catalog);
    assert.deepEqual((await readStoredTrajectory(root, result.uploadId)).trajectory, validateTrajectory(raw).trajectory);
  }
  assert.ok((await readdir(join(root, "point-bases"))).every(file => !file.endsWith(".lock")));
});

for (const stopAt of ["pack", "context", "upload"]) {
  test(`SIGKILL after ${stopAt} publication leaves no persistent lock and a fresh process can finish the identical upload`, async t => {
    const { root, catalog } = await temporary(t), raw = fixture(`crash-${stopAt}`);
    const interrupted = controlledRun(t, { root, catalog, raw, stopAt });
    assert.equal(await interrupted.milestone, stopAt);
    await interrupted.stop(); // Actual child exit precedes the independent retry.
    const result = await controlledRun(t, { root, catalog, raw }).completed;
    const canonical = validateTrajectory(raw).trajectory;
    assert.equal(result.uploadId, digest(JSON.stringify(canonical)));
    assert.deepEqual((await readStoredTrajectory(root, result.uploadId)).trajectory, canonical);
    const entries = await loadIndex(root);
    assert.equal(entries.length, 1);
    await verifyStoredEntry(root, entries[0]);
    const duplicate = await controlledRun(t, { root, catalog, raw }).completed;
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.uploadId, result.uploadId);
    assert.ok((await readdir(join(root, "point-bases"))).every(file => !file.endsWith(".lock")));
  });
}

test("terminated worker loses only its in-memory queue and the next worker retries after actual exit", async t => {
  const { root, catalog } = await temporary(t), raw = fixture("worker-termination");
  const interrupted = controlledRun(t, { root, catalog, raw, stopAt: "context" }, { thread: true });
  assert.equal(await interrupted.milestone, "context");
  await interrupted.stop();
  const result = await controlledRun(t, { root, catalog, raw }, { thread: true }).completed;
  assert.equal(result.uploadId, digest(JSON.stringify(validateTrajectory(raw).trajectory)));
  assert.deepEqual((await readStoredTrajectory(root, result.uploadId)).trajectory, validateTrajectory(raw).trajectory);
  assert.ok((await readdir(join(root, "point-bases"))).every(file => !file.endsWith(".lock")));
});

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function packedFixture(t) {
  const { parent, root } = await temporary(t), context = digest("isolated-pack-record-context");
  const entries = [0, 60000].map(window => {
    const points = [[0, 1, 2, 3], [100, 4, 5, 6]], value = { version: 1, context, window, points };
    return { hash: digest(JSON.stringify(value)), body: gzipSync(JSON.stringify(value)), info: { context, window, points } };
  });
  const bytes = Buffer.concat(entries.map(entry => entry.body)), packHash = sha(bytes), blocks = {}, bases = {};
  let offset = 0;
  for (const entry of entries) {
    blocks[entry.hash] = { packHash, offset, length: entry.body.length, recordSha256: sha(entry.body), window: entry.info.window, pointCount: 2, type: 1 };
    bases[`${entry.info.window}:2`] = entry.hash;
    offset += entry.body.length;
  }
  const index = { version: 1, context, blocks, bases }, indexPath = join(root, "point-bases", `context-${context}.json`), packPath = join(root, "point-blocks", `${packHash}.pack`);
  await mkdir(join(root, "point-bases"), { recursive: true });
  await mkdir(join(root, "point-blocks"), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index));
  await writeFile(packPath, bytes);
  return { parent, root, context, entries, bytes, index, indexPath, packPath };
}

test("context index rejects wrong identity, unsafe offsets or lengths and overlapping records", async t => {
  const data = await packedFixture(t), hash = data.entries[0].hash, other = data.entries[1].hash;
  for (const mutate of [
    index => { index.context = digest("different-context"); },
    index => { index.blocks[hash].offset = -1; },
    index => { index.blocks[hash].offset = 0.5; },
    index => { index.blocks[hash].offset = Number.MAX_SAFE_INTEGER + 1; },
    index => { index.blocks[hash].length = 0; },
    index => { index.blocks[hash].length = 128 * 1024 + 1; },
    index => { index.blocks[hash].length = Number.MAX_SAFE_INTEGER + 1; },
    index => { index.blocks[other].offset = 1; },
  ]) {
    const changed = structuredClone(data.index); mutate(changed);
    await writeFile(data.indexPath, JSON.stringify(changed));
    await assert.rejects(readPointContext(data.root, data.context), /context|reference|overlap/);
  }
});

test("point record seek checks actual file bounds and record checksum before returning bytes", async t => {
  const data = await packedFixture(t), entry = data.entries[0];
  assert.deepEqual(await readPackedPointBytes(data.root, entry.hash, data.context, 0), entry.body);
  let changed = structuredClone(data.index); changed.blocks[entry.hash].offset = data.bytes.length + 1;
  await writeFile(data.indexPath, JSON.stringify(changed));
  await assert.rejects(readPackedPointBytes(data.root, entry.hash, data.context, 0), /actual file length/);
  changed = structuredClone(data.index); changed.blocks[entry.hash].recordSha256 = digest("incorrect-record-checksum");
  await writeFile(data.indexPath, JSON.stringify(changed));
  await assert.rejects(readPackedPointBytes(data.root, entry.hash, data.context, 0), /checksum/);
  await writeFile(data.indexPath, JSON.stringify(data.index));
  await assert.rejects(readPackedPointBytes(data.root, entry.hash, data.context, 60000), /window identity/);
});

test("malformed and oversized context JSON and non-file packs fail closed", async t => {
  const data = await packedFixture(t), entry = data.entries[0];
  await writeFile(data.indexPath, "{\"version\":");
  await assert.rejects(readPointContext(data.root, data.context));
  await writeFile(data.indexPath, " ".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(readPointContext(data.root, data.context), /capacity/);
  await writeFile(data.indexPath, JSON.stringify(data.index));
  await rm(data.packPath); await mkdir(data.packPath);
  await assert.rejects(readPackedPointBytes(data.root, entry.hash, data.context, 0), /ordinary|regular|file|EISDIR|EACCES/i);
});

test("immutable existing pack corruption blocks reuse without replacing earlier bytes", async t => {
  const data = await packedFixture(t), corrupt = Buffer.alloc(data.bytes.length, 7);
  await writeFile(data.packPath, corrupt);
  const plan = { blocks: new Map(data.entries.map(entry => [entry.hash, entry.body])),
    blockInfo: new Map(data.entries.map(entry => [entry.hash, entry.info])), existing: new Set(), bases: new Map() };
  await assert.rejects(planPointPacks(data.root, plan), /immutable point pack identity/);
  assert.deepEqual(await readFile(data.packPath), corrupt);
});

test("seeking one record does not decode an unrelated damaged range in the same immutable pack", async t => {
  const data = await packedFixture(t), changed = Buffer.from(data.bytes), second = data.index.blocks[data.entries[1].hash];
  changed[second.offset + Math.floor(second.length / 2)] ^= 0xff;
  await writeFile(data.packPath, changed);
  assert.deepEqual(await readPackedPointBytes(data.root, data.entries[0].hash, data.context, 0), data.entries[0].body);
  await assert.rejects(readPackedPointBytes(data.root, data.entries[1].hash, data.context, 60000), /checksum/);
});

test("a symlink cannot substitute for a private immutable pack or context index", {
  skip: process.platform === "win32" && "Linux production symlink semantics; Windows may require administrator privileges",
}, async t => {
  const data = await packedFixture(t), outside = join(data.parent, "outside.pack");
  await writeFile(outside, data.bytes); await rm(data.packPath); await symlink(outside, data.packPath);
  await assert.rejects(readPackedPointBytes(data.root, data.entries[0].hash, data.context, 0), /symlink|ordinary|regular|file/i);
  await rm(data.packPath); await writeFile(data.packPath, data.bytes);
  const outsideIndex = join(data.parent, "outside-index.json");
  await writeFile(outsideIndex, JSON.stringify(data.index)); await rm(data.indexPath); await symlink(outsideIndex, data.indexPath);
  await assert.rejects(readPointContext(data.root, data.context), /capacity|file|symlink/);
});
