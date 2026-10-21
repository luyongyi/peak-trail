import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLiveServer } from "../../server/live-server.mjs";
import { createLiveWal } from "../../server/live-wal.mjs";

const airportKey = "a".repeat(64), runKey = "b".repeat(64), clientId = "c".repeat(32);
const manifest = { sceneName: "Level_10", gameBuildId: "25739797", identityMode: "session-player-id" };
const sample = { producerSeq: 1, record: { type: "sample", t: 0, playerId: "p1", pos: [1, 2, 3] } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function fixture(t, { durable = false, liveV2 = {}, liveWal = {}, root: providedRoot } = {}) {
  const root = providedRoot ?? (durable ? await mkdtemp(join(tmpdir(), "peak-reservations-")) : undefined);
  let time = 100_000;
  const live = createLiveServer({ trajectoryDir: root, liveWal,
    liveV2: { memoryOnly: !durable, now: () => time, sweepIntervalMs: 60_000, pingIntervalMs: 60_000, ...liveV2 } });
  await new Promise(done => live.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${live.server.address().port}`, readers = new Set();
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    await live.liveV2.close().catch(() => {});
    live.server.closeAllConnections();
    await new Promise(done => live.server.close(done));
    if (root && !providedRoot) await rm(root, { recursive: true, force: true });
  });
  async function request(path, body, token) {
    const response = await fetch(base + path, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const reserve = (overrides = {}) => request("/api/live/v2/reservations", { roomKey: airportKey, clientId, ...overrides });
  const action = (session, name, body = {}, token = session.publishToken) => request(`/api/live/v2/sessions/${session.sessionId}/${name}`, body, token);
  const activate = (session, overrides = {}) => action(session, "activate", { roomKey: runKey, manifest, ...overrides });
  const send = session => action(session, "records", JSON.stringify(sample));
  const metadata = session => request(`/api/live/v2/watch/${session.watchId}`);
  const code = session => request(`/api/live/v2/codes/${session.watchCode}`);
  async function stream(session, query = "") {
    const response = await fetch(`${base}/api/live/v2/watch/${session.watchId}/stream${query}`);
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
          let timer;
          const result = await Promise.race([reader.read(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("reservation SSE timeout")), 3_000);
          })]).finally(() => clearTimeout(timer));
          if (result.done) return null;
          buffer += Buffer.from(result.value).toString("utf8");
        }
      },
      async close() { readers.delete(reader); await reader.cancel(); },
    };
  }
  const walPath = session => join(root, "live-archive", `${session.sessionId}.wal`);
  const frames = async session => (await readFile(walPath(session), "utf8")).trim().split("\n").map(JSON.parse);
  return { live, root, request, reserve, action, activate, send, metadata, code, stream, frames, walPath,
    async advance(ms) { time += ms; await live.liveV2.sweep(); } };
}

test("reservation is a unique anonymous waiting session, and waiting heartbeats never invent a map or records", async t => {
  const f = await fixture(t);
  const first = await f.reserve(), value = first.body;
  assert.equal(first.status, 201); assert.equal(value.status, "waiting"); assert.equal(value.epoch, 0);
  assert.equal(value.runRoomKey, null);
  assert.equal(value.manifest, null); assert.equal(value.lastSeq, 0); assert.equal(value.lastProducerSeq, 0);
  assert.match(value.watchCode, /^[A-HJ-NP-Z]{4}$/);
  assert.deepEqual(await f.reserve(), first);
  const standby = await f.reserve({ clientId: "d".repeat(32) });
  assert.equal(standby.status, 409); assert.equal(standby.body.error, "publisher-active");
  for (const key of ["sessionId", "watchId", "watchCode", "status", "epoch"]) assert.equal(standby.body[key], value[key]);
  assert.equal(standby.body.publishToken, undefined);
  assert.equal(standby.body.runRoomKey, undefined);
  const view = await f.stream(value), hello = await view.next();
  assert.equal(hello.event, "hello"); assert.equal(hello.body.manifest, null); assert.equal(hello.body.epoch, 0);
  assert.equal(hello.body.snapshotSeq, 0); assert.deepEqual(hello.body.snapshot.records, []);
  await f.advance(10_000);
  assert.equal((await f.action(value, "heartbeat")).body.status, "waiting");
  assert.equal((await f.code(value)).body.status, "waiting");
  assert.deepEqual(await f.send(value), { status: 409, body: { error: "session-not-active" } });
  const read = (await f.metadata(value)).body;
  for (const hidden of [airportKey, clientId, value.publishToken]) assert.ok(!JSON.stringify(read).includes(hidden));
  assert.equal(read.manifest, null); assert.equal(read.lastRecordAt, null); assert.equal(read.status, "waiting");
  assert.equal(read.runRoomKey, undefined); assert.equal(hello.body.runRoomKey, undefined);
  await view.close();
  assert.equal((await f.request("/api/live/v2/reservations")).status, 404);
  assert.equal((await f.reserve({ roomKey: "raw room" })).status, 400);
  assert.equal((await f.reserve({ manifest })).status, 400);
});

test("activation preserves identity and token, emits one real hello, and exact retry never resets accepted records", async t => {
  const f = await fixture(t, { durable: true }), value = (await f.reserve()).body;
  const view = await f.stream(value); await view.next();
  assert.equal((await f.action(value, "activate", { roomKey: runKey, manifest }, value.watchCode)).status, 401);
  const activated = await f.activate(value), next = activated.body;
  assert.equal(activated.status, 200); assert.equal(next.status, "live"); assert.equal(next.epoch, 1);
  assert.equal(next.runRoomKey, runKey);
  for (const key of ["sessionId", "watchId", "watchCode", "publishToken"]) assert.equal(next[key], value[key]);
  const hello = await view.next();
  assert.equal(hello.event, "hello"); assert.equal(hello.body.epoch, 1); assert.equal(hello.body.manifest.sceneName, "Level_10");
  for (const publicBody of [hello.body, (await f.metadata(next)).body, (await f.code(next)).body,
    (await f.reserve({ clientId: "d".repeat(32) })).body]) {
    assert.equal(publicBody.runRoomKey, undefined);
    assert.ok(!JSON.stringify(publicBody).includes(runKey));
  }
  assert.equal((await f.send(next)).body.accepted, 1);
  assert.equal((await view.next()).event, "record");
  assert.equal((await f.activate(value)).body.lastSeq, 1);
  const again = await f.reserve();
  assert.equal(again.status, 201); assert.equal(again.body.status, "live"); assert.equal(again.body.epoch, 1);
  assert.equal(again.body.lastSeq, 1); assert.equal(again.body.publishToken, value.publishToken);
  assert.equal((await f.send(next)).body.duplicates, 1);
  await f.action(next, "end");
  assert.equal((await view.next()).event, "state"); // No duplicate hello from either retry.
  assert.equal(await view.next(), null);
  const frames = await f.frames(value);
  assert.deepEqual(frames.map(frame => frame.transaction.kind), ["reserve", "activate", "batch", "end"]);
  for (const frame of frames) assert.equal(frame.checksum, hash(frame.transaction));
  for (const hidden of [airportKey, runKey, clientId, value.publishToken]) assert.ok(!JSON.stringify(frames).includes(hidden));
  assert.ok(!JSON.stringify(frames).includes("runRoomKey"));
});

test("waiting and live airport alias takeovers keep the code, rotate credentials, and preserve correct epoch semantics", async t => {
  const f = await fixture(t, { durable: true }), one = (await f.reserve()).body;
  await f.advance(15_001);
  assert.equal((await f.metadata(one)).body.status, "waiting");
  assert.equal((await f.action(one, "heartbeat")).body.error, "publisher-lease-expired");
  const two = (await f.reserve({ clientId: "d".repeat(32) })).body;
  assert.equal(two.epoch, 0); assert.equal(two.status, "waiting"); assert.notEqual(two.publishToken, one.publishToken);
  assert.equal(two.watchCode, one.watchCode); assert.equal(two.watchId, one.watchId);
  assert.equal((await f.activate(one)).status, 401);
  const active = (await f.activate(two)).body; await f.send(active);
  const standby = await f.reserve({ clientId: "e".repeat(32) });
  assert.equal(standby.body.status, "live"); assert.equal(standby.body.watchCode, one.watchCode);
  await f.advance(15_001);
  const three = (await f.reserve({ clientId: "e".repeat(32) })).body;
  assert.equal(three.status, "live"); assert.equal(three.epoch, 2); assert.equal(three.lastSeq, 0);
  assert.equal(three.watchCode, one.watchCode); assert.equal(three.sessionId, one.sessionId);
  assert.equal(three.runRoomKey, runKey);
  assert.notEqual(three.publishToken, two.publishToken);
  assert.equal((await f.send(active)).status, 401); assert.equal((await f.send(three)).body.accepted, 1);
  assert.equal((await f.metadata(three)).body.manifest.sceneName, manifest.sceneName);
  assert.deepEqual((await f.frames(one)).map(frame => frame.transaction.kind), ["reserve", "reservation-claim", "activate", "batch", "epoch", "batch"]);
});

test("owner can detect a stale airport alias by its private run key and end it before reserving the next game", async t => {
  const f = await fixture(t), previous = (await f.reserve()).body;
  await f.activate(previous);
  await f.advance(15_001);
  const newClient = "d".repeat(32), stale = (await f.reserve({ clientId: newClient })).body;
  assert.equal(stale.status, "live"); assert.equal(stale.runRoomKey, runKey);
  const nextRunKey = "e".repeat(64);
  assert.notEqual(stale.runRoomKey, nextRunKey);
  await f.action(stale, "end", { reason: "different-run" });
  const fresh = (await f.reserve({ clientId: newClient })).body;
  assert.equal(fresh.status, "waiting"); assert.equal(fresh.runRoomKey, null);
  assert.notEqual(fresh.watchId, previous.watchId); assert.notEqual(fresh.watchCode, previous.watchCode);
  const activated = await f.activate(fresh, { roomKey: nextRunKey });
  assert.equal(activated.status, 200); assert.equal(activated.body.runRoomKey, nextRunKey);
  assert.equal((await f.code(previous)).status, 404);
});

test("concurrent airport registrations allocate once and cannot fork a code during activation or live standby", async t => {
  const f = await fixture(t, { durable: true });
  const results = await Promise.all([f.reserve(), f.reserve(), f.reserve({ clientId: "d".repeat(32) })]);
  assert.deepEqual(results.map(result => result.status), [201, 201, 409]);
  assert.equal(new Set(results.map(result => result.body.watchCode)).size, 1);
  const value = results[0].body;
  const activation = await Promise.all([f.activate(value), f.activate(value), f.reserve({ clientId: "d".repeat(32) })]);
  assert.deepEqual(activation.map(result => result.status), [200, 200, 409]);
  assert.equal(activation[2].body.status, "live"); assert.equal(activation[2].body.watchCode, value.watchCode);
  assert.equal(f.live.liveV2.stats().sessions, 1);
  assert.deepEqual((await f.frames(value)).map(frame => frame.transaction.kind), ["reserve", "activate"]);
});

test("reservation allocation shares legacy collision and capacity bounds while ended codes remain quarantined", async t => {
  const generated = ["TEST", "TEST", "ABCD", "ABCD", "EFGH"];
  const f = await fixture(t, { liveV2: { watchCodeGenerator: () => generated.shift(), limits: { sessions: 3 } } });
  const waiting = (await f.reserve()).body;
  const old = await f.request("/api/live/v2/sessions", { roomKey: runKey, clientId, manifest });
  assert.equal(old.status, 201); assert.equal(old.body.watchCode, "ABCD");
  await f.action(waiting, "end");
  const fresh = (await f.reserve()).body;
  assert.equal(fresh.watchCode, "EFGH"); assert.notEqual(fresh.sessionId, waiting.sessionId);
  assert.equal((await f.reserve({ roomKey: "e".repeat(64) })).body.error, "too-many-sessions");
  assert.equal((await f.code(waiting)).status, 404); assert.equal((await f.code(fresh)).body.status, "waiting");
  await f.advance(15 * 60_000);
  assert.equal((await f.metadata(waiting)).status, 404);
});

test("waiting SSE resumes at epoch zero and an old waiting cursor receives the actual activated snapshot", async t => {
  const f = await fixture(t), value = (await f.reserve()).body;
  const view = await f.stream(value, "?after=0&epoch=0");
  const resumed = await view.next(); assert.equal(resumed.event, "resumed"); assert.equal(resumed.body.status, "waiting");
  await f.activate(value);
  const hello = await view.next(); assert.equal(hello.event, "hello"); assert.equal(hello.body.epoch, 1);
  await f.send(value);
  const late = await f.stream(value, "?after=0&epoch=0"), snapshot = await late.next();
  assert.equal(snapshot.event, "hello"); assert.equal(snapshot.body.epoch, 1);
  assert.equal(snapshot.body.snapshot.records[0].seq, 1);
  await view.close(); await late.close();
});

test("run conflicts fail closed without stealing the reservation or another publisher, while legacy sessions remain compatible", async t => {
  const f = await fixture(t), one = (await f.reserve()).body;
  const old = await f.request("/api/live/v2/sessions", { roomKey: runKey, clientId: "f".repeat(32), manifest });
  assert.equal(old.status, 201); assert.equal(old.body.epoch, 1);
  assert.equal((await f.activate(one)).body.error, "run-room-active");
  assert.equal((await f.metadata(one)).body.status, "waiting");
  assert.equal((await f.send(old.body)).body.accepted, 1);
  await f.action(old.body, "end");
  const active = (await f.activate(one)).body;
  assert.equal(active.watchCode, one.watchCode);
  assert.equal((await f.activate(one, { roomKey: "e".repeat(64) })).body.error, "activation-conflict");
  assert.equal((await f.activate(one, { manifest: { ...manifest, sceneName: "Level_11" } })).body.error, "activation-conflict");
  const conflict = await f.request("/api/live/v2/sessions", { roomKey: runKey, clientId: "f".repeat(32), manifest });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.watchCode, one.watchCode);
  assert.equal((await f.send(active)).body.accepted, 1);
});

test("waiting cancellation, silence and hard TTL retain a null manifest terminal snapshot and quarantine the code", async t => {
  const f = await fixture(t, { liveV2: { watchCodeGenerator: () => "TEST" } }), value = (await f.reserve()).body;
  const view = await f.stream(value); await view.next();
  await f.advance(60_000);
  const ended = await view.next(); assert.equal(ended.body.status, "ended"); assert.equal(ended.body.epoch, 0);
  assert.equal((await f.code(value)).status, 404);
  const late = await f.stream(value), hello = await late.next();
  assert.equal(hello.body.status, "ended"); assert.equal(hello.body.manifest, null); assert.equal(hello.body.epoch, 0);
  assert.deepEqual(hello.body.snapshot.records, []); assert.equal(hello.body.watchCode, null);
  await late.close();
  assert.equal((await f.reserve()).body.error, "watch-code-capacity");
  await f.advance(15 * 60_000);
  assert.equal((await f.metadata(value)).status, 404);
  const next = (await f.reserve()).body;
  assert.equal(next.watchCode, value.watchCode); assert.notEqual(next.watchId, value.watchId);
  assert.equal((await f.action(next, "end", { reason: "airport-left" })).body.status, "ended");
  assert.equal((await f.code(next)).status, 404);
  const ttl = await fixture(t, { liveV2: { limits: { ttlMs: 20_000 } } }), short = (await ttl.reserve()).body;
  await ttl.advance(10_000); await ttl.action(short, "heartbeat"); await ttl.advance(10_000);
  assert.equal((await ttl.metadata(short)).body.reason, "maximum-duration");
});

test("reservation and activation ACK, indices and SSE wait for fsync; end queues behind activation", async t => {
  const gates = new Map(["reserve", "activate"].map(kind => [kind, { entered: deferred(), release: deferred() }]));
  const f = await fixture(t, { durable: true, liveWal: { beforeSync: async tx => {
    const gate = gates.get(tx.kind); if (gate) { gate.entered.resolve(); await gate.release.promise; }
  } } });
  t.after(() => { for (const gate of gates.values()) gate.release.resolve(); });
  let ack = false;
  const reservation = f.reserve().then(result => { ack = true; return result; });
  await gates.get("reserve").entered.promise;
  assert.equal(ack, false); assert.equal(f.live.liveV2.stats().sessions, 0);
  gates.get("reserve").release.resolve();
  const value = (await reservation).body, view = await f.stream(value); await view.next();
  let activated = false;
  const activation = f.activate(value).then(result => { activated = true; return result; });
  await gates.get("activate").entered.promise;
  assert.equal(activated, false);
  const before = (await f.metadata(value)).body;
  assert.equal(before.status, "waiting"); assert.equal(before.epoch, 0); assert.equal(before.manifest, null);
  let ended = false;
  const ending = f.action(value, "end").then(result => { ended = true; return result; });
  assert.equal(ended, false);
  gates.get("activate").release.resolve();
  assert.equal((await activation).status, 200); assert.equal((await ending).status, 200);
  assert.equal((await view.next()).event, "hello"); assert.equal((await view.next()).body.status, "ended");
  assert.deepEqual((await f.frames(value)).map(frame => frame.transaction.kind), ["reserve", "activate", "end"]);
});

test("reservation quota, maintenance, missing storage and activation fsync failure never silently downgrade", async t => {
  const missing = await fixture(t, { liveV2: { memoryOnly: false } });
  assert.equal((await missing.reserve()).body.error, "live-archive-unconfigured");
  const quota = await fixture(t, { durable: true, liveWal: { limits: { archives: 0 } } });
  assert.equal((await quota.reserve()).body.error, "live-archive-capacity");
  assert.equal(quota.live.liveV2.stats().sessions, 0);
  const marked = await fixture(t, { durable: true });
  await writeFile(join(marked.root, ".migration-maintenance"), "maintenance");
  assert.equal((await marked.reserve()).body.error, "live-archive-maintenance");
  const failed = await fixture(t, { durable: true, liveWal: { beforeSync: tx => {
    if (tx.kind === "activate") throw new Error("synthetic disk failure");
  } } });
  const value = (await failed.reserve()).body;
  assert.equal((await failed.activate(value)).status, 503);
  assert.equal((await failed.metadata(value)).body.status, "waiting");
  assert.equal((await failed.metadata(value)).body.manifest, null);
  assert.equal((await failed.activate(value)).status, 503);
  assert.equal((await failed.send(value)).status, 409);
});

test("new WAL transitions recover alongside old archives, repair only torn tails and never restore waiting credentials", async t => {
  const f = await fixture(t, { durable: true }), waiting = (await f.reserve()).body;
  const active = (await f.reserve({ roomKey: "e".repeat(64), clientId: "f".repeat(32) })).body;
  await f.activate(active); await f.send(active);
  const old = (await f.request("/api/live/v2/sessions", { roomKey: "d".repeat(64), clientId, manifest })).body;
  await f.live.liveV2.close();
  const valid = await readFile(f.walPath(waiting));
  await appendFile(f.walPath(waiting), '{"transaction":');
  const recovered = createLiveWal({ root: f.root });
  await recovered.ready(); await recovered.close();
  assert.deepEqual(await readFile(f.walPath(waiting)), valid);
  assert.equal((await readdir(join(f.root, "live-archive"))).length, 3);
  const restart = await fixture(t, { durable: true, root: f.root });
  for (const value of [waiting, active, old]) {
    assert.equal((await restart.metadata(value)).status, 404);
    assert.equal((await restart.action(value, "heartbeat")).status, 404);
  }
  const fresh = await restart.reserve(); assert.equal(fresh.status, 201); assert.notEqual(fresh.body.sessionId, waiting.sessionId);
  await restart.live.liveV2.close();
  const lines = valid.toString().trim().split("\n").map(JSON.parse);
  lines[0].transaction.epoch = 1; lines[0].checksum = hash(lines[0].transaction);
  await writeFile(f.walPath(waiting), lines.map(JSON.stringify).join("\n") + "\n");
  const damaged = createLiveWal({ root: f.root });
  await assert.rejects(damaged.ready(), /live-archive-corrupt/); await damaged.close();
});

test("WAL rejects records or live epochs before activation and rejects waiting claims after activation", async t => {
  const root = await mkdtemp(join(tmpdir(), "peak-reservation-transitions-"));
  const wal = createLiveWal({ root });
  t.after(async () => { await wal.close(); await rm(root, { recursive: true, force: true }); });
  const value = { sessionId: "1".repeat(32), watchId: "2".repeat(32), watchCode: "TEST", createdAt: 100_000, epoch: 0, manifest: null };
  await wal.reserve(value);
  await assert.rejects(wal.epoch(value, manifest, 100_001), /live-archive-corrupt/);
  await assert.rejects(wal.batch(value, [sample], [{ seq: 1, record: sample.record }], 100_001), /live-archive-corrupt/);
  await wal.claimReservation(value, 100_002);
  await wal.activate(value, manifest, 100_003);
  await assert.rejects(wal.claimReservation(value, 100_004), /live-archive-corrupt/);
  await assert.rejects(wal.activate(value, manifest, 100_004), /live-archive-corrupt/);
  value.epoch = 1;
  await wal.end(value, "stopped", 100_005);
});
