import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLiveWal, projectLivePathRecord } from "../../server/live-wal.mjs";
import { createLiveServer } from "../../server/live-server.mjs";

const manifest = { sceneName: "Level_19", identityMode: "session-player-id" };
const roomKey = "a".repeat(64), clientId = "b".repeat(32);
const sample = (t) => ({ type: "sample", t, playerId: "p1", pos: [t, 2, 3], yaw: 10, activeSegment: 0 });
const wrap = (record, producerSeq) => ({ producerSeq, record });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const session = (id = "1") => ({ sessionId: id.repeat(32), watchId: "2".repeat(32), watchCode: "TEST", epoch: 1, createdAt: 100_000, manifest });
const filePath = (root, value) => join(root, "live-archive", `${value.sessionId}.wal`);
const frames = async (root, value) => (await readFile(filePath(root, value), "utf8")).trim().split("\n").map(JSON.parse);

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "peak-live-wal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function walFixture(t, options = {}) {
  const root = await directory(t), wal = createLiveWal({ root, ...options });
  t.after(() => wal.close());
  return { root, wal };
}
async function httpFixture(t, { root, liveWal, liveV2 } = {}) {
  let time = 100_000;
  const live = createLiveServer({ trajectoryDir: root, liveWal,
    liveV2: { now: () => time, sweepIntervalMs: 60_000, pingIntervalMs: 60_000, ...liveV2 } });
  await new Promise(done => live.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${live.server.address().port}`, readers = new Set();
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    await live.liveV2.close().catch(() => {});
    live.server.closeAllConnections();
    await new Promise(done => live.server.close(done));
  });
  async function request(path, body, token) {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const create = (body = {}) => request("/api/live/v2/sessions", { roomKey, clientId, manifest, ...body });
  const send = (value, records) => request(`/api/live/v2/sessions/${value.sessionId}/records`, records.map(JSON.stringify).join("\n"), value.publishToken);
  const action = (value, name, body = {}) => request(`/api/live/v2/sessions/${value.sessionId}/${name}`, body, value.publishToken);
  const metadata = value => request(`/api/live/v2/watch/${value.watchId}`);
  async function stream(value) {
    const response = await fetch(`${base}/api/live/v2/watch/${value.watchId}/stream`);
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); readers.add(reader);
    let buffer = "";
    return {
      async next() {
        for (;;) {
          const index = buffer.indexOf("\n\n");
          if (index !== -1) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const match = frame.match(/event: ([^\n]+)\ndata: (.*)/su);
            if (match) return { event: match[1], body: JSON.parse(match[2]) };
            continue;
          }
          const result = await reader.read();
          if (result.done) return null;
          buffer += Buffer.from(result.value).toString("utf8");
        }
      },
      async close() { readers.delete(reader); await reader.cancel(); },
    };
  }
  return { live, request, create, send, action, metadata, stream, setTime: value => { time = value; } };
}

test("production refuses registrations without a private archive root; explicit tests can opt into memory", async t => {
  const f = await httpFixture(t);
  assert.deepEqual(await f.create(), { status: 503, body: { error: "live-archive-unconfigured" } });
  assert.equal(f.live.liveV2.stats().sessions, 0);
  assert.equal((await f.request("/api/health")).status, 200);
  const memory = await httpFixture(t, { liveV2: { memoryOnly: true } });
  const value = (await memory.create()).body;
  assert.equal((await memory.metadata(value)).body.persistence, "memory");
});

test("accepted transactions preserve paths and producer ranges, omit unrelated state and secrets, and retry exactly once", async t => {
  const root = await directory(t), f = await httpFixture(t, { root });
  const value = (await f.create()).body;
  assert.equal((await f.metadata(value)).body.persistence, "durable");
  const records = [wrap({ type: "participant", t: 0, playerId: "p1", nickname: "Scout" }, 1),
    wrap({ ...sample(0), stamina: 0.5, item: { name: "Compass" } }, 2),
    wrap({ type: "inventory", t: 0, playerId: "p1", selectedSlot: 2 }, 3),
    wrap({ type: "event", t: 10, playerId: "p1", event: "nadir-entry", source: "native-state", pos: [1, 2, 3], activeSegment: 5 }, 4)];
  assert.equal((await f.send(value, records)).body.accepted, 4);
  assert.equal((await f.send(value, records)).body.duplicates, 4);
  assert.equal((await f.send(value, [wrap({ type: "state", t: 11, playerId: "p1", stamina: 0.2 }, 5)])).status, 200);
  assert.equal((await f.action(value, "heartbeat")).status, 200);
  assert.equal((await f.create()).body.publishToken, value.publishToken);
  assert.equal((await f.action(value, "end")).status, 200);
  const log = await frames(root, value);
  assert.deepEqual(log.map(frame => frame.transaction.kind), ["open", "batch", "batch", "end"]);
  assert.deepEqual(log.map(frame => frame.transaction.tx), [1, 2, 3, 4]);
  for (const frame of log) assert.equal(frame.checksum, hash(frame.transaction));
  const batch = log[1].transaction;
  assert.equal(batch.producerFrom, 1); assert.equal(batch.producerThrough, 4);
  assert.deepEqual(batch.records.map(entry => entry.seq), [1, 2, 4]);
  assert.deepEqual(batch.records[1].record, sample(0));
  assert.deepEqual(log[2].transaction.records, []);
  assert.equal(log[2].transaction.producerThrough, 5);
  const raw = JSON.stringify(log);
  for (const hidden of [value.publishToken, roomKey, clientId, "stamina", "Compass", "inventory"]) assert.ok(!raw.includes(hidden));
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "live-archive"))).mode & 0o777, 0o700);
    assert.equal((await stat(filePath(root, value))).mode & 0o777, 0o600);
  }
});

test("open, batches and end wait for durable sync before HTTP ACK, state mutation or SSE publication", async t => {
  const root = await directory(t), pending = new Map();
  const entered = deferred(), openRelease = deferred();
  const f = await httpFixture(t, { root, liveWal: { beforeSync: async transaction => {
    if (transaction.kind === "open") { entered.resolve(); await openRelease.promise; }
    if (pending.has(transaction.kind)) { const gate = pending.get(transaction.kind); gate.entered.resolve(); await gate.release.promise; }
  } } });
  t.after(() => { openRelease.resolve(); for (const gate of pending.values()) gate.release.resolve(); });
  let registered = false;
  const opening = f.create().then(result => { registered = true; return result; });
  await entered.promise;
  assert.equal(registered, false); assert.equal(f.live.liveV2.stats().sessions, 0);
  openRelease.resolve(); const value = (await opening).body;
  const view = await f.stream(value), hello = await view.next();
  assert.equal(hello.body.persistence, "durable"); assert.equal(hello.body.snapshotSeq, 0);
  const batchGate = { entered: deferred(), release: deferred() }; pending.set("batch", batchGate);
  let acknowledged = false, published = false;
  const uploading = f.send(value, [wrap(sample(0), 1)]).then(result => { acknowledged = true; return result; });
  const next = view.next().then(result => { published = true; return result; });
  await batchGate.entered.promise;
  assert.equal(acknowledged, false); assert.equal(published, false);
  assert.equal((await f.metadata(value)).body.lastSeq, 0);
  batchGate.release.resolve(); assert.equal((await uploading).status, 200);
  assert.equal((await next).event, "record"); pending.delete("batch");
  const endGate = { entered: deferred(), release: deferred() }; pending.set("end", endGate);
  let ended = false;
  const ending = f.action(value, "end").then(result => { ended = true; return result; });
  await endGate.entered.promise;
  assert.equal(ended, false); assert.equal((await f.metadata(value)).body.status, "live");
  endGate.release.resolve(); assert.equal((await ending).status, 200);
  assert.equal((await view.next()).body.status, "ended"); assert.equal(await view.next(), null);
});

test("concurrent identical batches serialize and takeover creates a new durable epoch without joining anonymous players", async t => {
  const root = await directory(t), entered = deferred(), release = deferred();
  const f = await httpFixture(t, { root, liveWal: { beforeSync: async transaction => {
    if (transaction.kind === "batch" && transaction.epoch === 1) { entered.resolve(); await release.promise; }
  } } });
  t.after(() => release.resolve());
  const first = (await f.create()).body, records = [wrap(sample(0), 1)];
  const one = f.send(first, records); await entered.promise;
  const two = f.send(first, records); release.resolve();
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map(result => result.body.accepted).sort(), [0, 1]);
  const size = (await stat(filePath(root, first))).size;
  assert.equal((await f.send(first, [wrap(sample(5), 3)])).status, 409);
  assert.equal((await stat(filePath(root, first))).size, size);
  f.setTime(116_000);
  const second = (await f.create({ clientId: "c".repeat(32) })).body;
  assert.equal(second.epoch, 2); assert.equal(second.watchId, first.watchId);
  assert.equal((await f.send(first, [wrap(sample(10), 2)])).status, 401);
  assert.equal((await f.send(second, [wrap(sample(0), 1)])).status, 200);
  assert.equal((await f.action(second, "end")).status, 200);
  const log = (await frames(root, first)).map(frame => frame.transaction);
  assert.deepEqual(log.map(tx => [tx.kind, tx.epoch]), [["open", 1], ["batch", 1], ["epoch", 2], ["batch", 2], ["end", 2]]);
  assert.equal(log[3].fromSeq, 1); assert.equal(log[3].producerFrom, 1);
});

test("sync failure returns 503 without publishing or advancing, then fails closed until restart recovery", async t => {
  const root = await directory(t), f = await httpFixture(t, { root, liveWal: { beforeSync: transaction => {
    if (transaction.kind === "batch") throw new Error("synthetic fsync failure");
  } } });
  const value = (await f.create()).body;
  const result = await f.send(value, [wrap(sample(0), 1)]);
  assert.deepEqual(result, { status: 503, body: { error: "live-archive-write-failed" } });
  assert.equal((await f.metadata(value)).body.lastSeq, 0);
  const length = (await stat(filePath(root, value))).size;
  assert.equal((await f.send(value, [wrap(sample(0), 1)])).status, 503);
  assert.equal((await f.action(value, "end")).status, 503);
  assert.equal((await stat(filePath(root, value))).size, length);
  const recovery = createLiveWal({ root }); await recovery.ready(); await recovery.close();
  assert.equal((await frames(root, value)).length, 2); // Unacknowledged but complete transaction remains private.
});

test("recovery truncates only an incomplete tail; checksum and transaction order corruption fail closed", async t => {
  const { root, wal } = await walFixture(t), value = session();
  await wal.open(value); await wal.batch(value, [wrap(sample(0), 1)], [{ seq: 1, record: sample(0) }], 100_001); await wal.close();
  const intact = await readFile(filePath(root, value));
  await appendFile(filePath(root, value), '{"transaction":{"kind":"batch"');
  const recovered = createLiveWal({ root }); await recovered.ready(); await recovered.close();
  assert.deepEqual(await readFile(filePath(root, value)), intact);
  const complete = JSON.parse(intact.toString().split("\n")[1]); complete.transaction.records[0].record.pos[0] = 99;
  await writeFile(filePath(root, value), intact.toString().split("\n")[0] + "\n" + JSON.stringify(complete) + "\n");
  await assert.rejects(createLiveWal({ root }).ready(), /live-archive-corrupt/);
  complete.checksum = hash(complete.transaction); complete.transaction.tx = 4; complete.checksum = hash(complete.transaction);
  await writeFile(filePath(root, value), intact.toString().split("\n")[0] + "\n" + JSON.stringify(complete) + "\n");
  await assert.rejects(createLiveWal({ root }).ready(), /live-archive-corrupt/);
});

test("maintenance marker blocks registration, append and recovery repair without modifying archives", async t => {
  const { root, wal } = await walFixture(t), value = session(); await wal.open(value);
  const path = filePath(root, value), size = (await stat(path)).size;
  await mkdir(join(root, ".migration-maintenance"));
  await assert.rejects(wal.batch(value, [wrap(sample(0), 1)], [{ seq: 1, record: sample(0) }], 100_001), /live-archive-maintenance/);
  assert.equal((await stat(path)).size, size);
  await wal.close(); await appendFile(path, "half-tail");
  await assert.rejects(createLiveWal({ root }).ready(), /live-archive-maintenance/);
  assert.equal((await stat(path)).size, size + 9);
  await rm(join(root, ".migration-maintenance"), { recursive: true });
  await writeFile(join(root, ".migration-maintenance"), "paused");
  const f = await httpFixture(t, { root }); assert.equal((await f.create()).status, 503);
});

test("global, per-archive, file count and transaction quotas reject before writes; orphan files count", async t => {
  for (const limits of [{ totalBytes: 1 }, { archiveBytes: 1 }, { archives: 0 }, { transactionBytes: 1 }]) {
    const { root, wal } = await walFixture(t, { limits });
    await assert.rejects(wal.open(session()), /live-archive-(capacity|busy)/);
    assert.equal(wal.stats().pendingBytes, 0);
    assert.deepEqual(await readdir(join(root, "live-archive")).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  }
  const root = await directory(t); await mkdir(join(root, "live-archive"), { mode: 0o700 });
  await writeFile(join(root, "live-archive", "orphan.tmp"), Buffer.alloc(100), { mode: 0o600 });
  await assert.rejects(createLiveWal({ root, limits: { totalBytes: 99 } }).ready(), /live-archive-capacity/);
});

test("WAL pending operations are bounded, close drains a sync in progress, and closed instances reject writes", async t => {
  const entered = deferred(), release = deferred();
  const { wal } = await walFixture(t, { limits: { pendingOperations: 1 }, beforeSync: async () => { entered.resolve(); await release.promise; } });
  t.after(() => release.resolve());
  const opening = wal.open(session()); await entered.promise;
  await assert.rejects(wal.open(session("3")), /live-archive-busy/);
  let closed = false; const closing = wal.close().then(() => { closed = true; });
  assert.equal(closed, false); assert.equal(wal.stats().pendingOperations, 1);
  release.resolve(); await opening; await closing;
  assert.equal(wal.stats().pendingOperations, 0); assert.equal(wal.stats().pendingBytes, 0);
  await assert.rejects(wal.open(session("4")), /live-archive-stopped/);
});

test("append quotas preserve the last acknowledged prefix and pending byte admission is bounded", async t => {
  for (const limits of [{ totalBytes: 700 }, { archiveBytes: 700 }]) {
    const { root, wal } = await walFixture(t, { limits }), value = session(); await wal.open(value);
    const before = await readFile(filePath(root, value));
    const record = { type: "event", t: 1, event: "nadir-entry", cause: "x".repeat(256), source: "native-state", pos: [1, 2, 3], activeSegment: 5 };
    await assert.rejects(wal.batch(value, [wrap(record, 1)], [{ seq: 1, record }], 100_001), /live-archive-capacity/);
    assert.deepEqual(await readFile(filePath(root, value)), before);
    await wal.end(value, "stopped", 100_002); // A refused batch did not advance the transaction or sequence.
    assert.deepEqual((await frames(root, value)).map(frame => frame.transaction.kind), ["open", "end"]);
  }
  const { wal } = await walFixture(t, { limits: { pendingBytes: 1 } });
  await assert.rejects(wal.open(session()), /live-archive-busy/);
  assert.equal(wal.stats().pendingOperations, 0);
});

test("service shutdown drains an accepted batch and durably ends it before releasing the session", async t => {
  const root = await directory(t), entered = deferred(), release = deferred();
  const f = await httpFixture(t, { root, liveWal: { beforeSync: async tx => {
    if (tx.kind === "batch") { entered.resolve(); await release.promise; }
  } } });
  t.after(() => release.resolve());
  const value = (await f.create()).body, sending = f.send(value, [wrap(sample(0), 1)]); await entered.promise;
  let closed = false; const closing = f.live.liveV2.close().then(() => { closed = true; });
  assert.equal(closed, false);
  assert.equal((await f.create({ roomKey: "c".repeat(64) })).status, 503);
  release.resolve(); assert.equal((await sending).status, 200); await closing;
  assert.deepEqual((await frames(root, value)).map(frame => frame.transaction.kind), ["open", "batch", "end"]);
  assert.equal(f.live.liveV2.stats().sessions, 0);
});

test("restart and ended-memory expiry retain archives, but never restore old publish tokens or live session IDs", async t => {
  const root = await directory(t), one = await httpFixture(t, { root });
  const value = (await one.create()).body; await one.send(value, [wrap(sample(0), 1)]);
  await one.action(value, "end"); one.setTime(1_001_000); await one.live.liveV2.sweep();
  assert.equal((await one.metadata(value)).status, 404);
  assert.equal((await stat(filePath(root, value))).isFile(), true);
  await one.live.liveV2.close();
  const two = await httpFixture(t, { root });
  assert.equal((await two.action(value, "heartbeat")).status, 404);
  assert.equal((await two.metadata(value)).status, 404);
  const next = (await two.create()).body;
  assert.notEqual(next.sessionId, value.sessionId); assert.notEqual(next.publishToken, value.publishToken);
  assert.equal((await readdir(join(root, "live-archive"))).length, 2);
});

test("path projection retains life and native milestones without item or stamina payloads", () => {
  assert.deepEqual(projectLivePathRecord({ type: "status", t: 1, playerId: "p1", status: { dead: true, ready: true, statusSum: 5 } }),
    { type: "status", t: 1, playerId: "p1", status: { ready: true, dead: true } });
  assert.equal(projectLivePathRecord({ type: "appearance", t: 1, playerId: "p1" }), null);
  assert.equal(projectLivePathRecord({ type: "status", t: 1, playerId: "p1", status: { ready: true } }), null);
});

test("only the two explicit item events preserve their safe item and immutable IDs across WAL restart", async t => {
  const { root, wal } = await walFixture(t), value = session(); await wal.open(value);
  const actionId = "c".repeat(64);
  const records = ["item-use", "item-spawn"].map((event, index) => ({ type: "event", event, t: index,
    id: String(index + 3).repeat(64), actionId, pos: [index, 2, 3], item: { itemId: 7, prefabName: "Campfire" } }));
  await wal.batch(value, records.map((record, index) => wrap(record, index + 1)), records.map((record, index) => ({ seq: index + 1, record })), 100_001);
  await wal.end(value, "done", 100_002); await wal.close();
  const recovered = createLiveWal({ root }); await recovered.ready(); await recovered.close();
  assert.deepEqual((await frames(root, value))[1].transaction.records.map(entry => entry.record), records);
  assert.equal(projectLivePathRecord({ ...records[0], event: "inventory_changed" }).item, undefined);
});
