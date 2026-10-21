import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createLiveServer } from "../../server/live-server.mjs";
import { createLiveV2Api } from "../../server/live-v2-api.mjs";
import { createLiveTrace, appendLiveRecord, finalizeLiveFlush, tracePlayerStateAtTime } from "../../web/src/protocol.js";

const roomKey = "a".repeat(64), clientId = "b".repeat(32);
const manifest = { sceneName: "Level_19", gameBuildId: "25306743", identityMode: "session-player-id" };
const sample = (t, playerId = "p1") => ({ type: "sample", t, playerId, pos: [t, 2, 3], yaw: 0 });
const wrap = (record, producerSeq) => ({ producerSeq, record });

async function fixture(t, options = {}) {
  let time = 100_000;
  const live = createLiveServer({ liveV2: { memoryOnly: true, now: () => time, ...options } });
  await new Promise((done) => live.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${live.server.address().port}`;
  const readers = new Set();
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    live.server.closeAllConnections();
    await new Promise((done) => live.server.close(done));
    await live.liveV2.close();
  });
  async function request(path, body, token) {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const create = (body = {}) => request("/api/live/v2/sessions", { roomKey, clientId, manifest, ...body });
  const send = (session, records, token = session.publishToken) => request(`/api/live/v2/sessions/${session.sessionId}/records`,
    records.map((record) => JSON.stringify(record)).join("\n"), token);
  const action = (session, name, body = {}) => request(`/api/live/v2/sessions/${session.sessionId}/${name}`, body, session.publishToken);
  async function stream(session, query = "", headers = {}) {
    const response = await fetch(`${base}/api/live/v2/watch/${session.watchId}/stream${query}`, { headers });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    readers.add(reader);
    let buffer = "";
    const decoder = new TextDecoder();
    return {
      async next() {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const index = buffer.indexOf("\n\n");
          if (index >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const match = frame.match(/event: ([^\n]+)\ndata: (.*)/su);
            if (match) return { event: match[1], body: JSON.parse(match[2]), id: frame.match(/^id: (\d+)$/mu)?.[1] };
            continue;
          }
          let timer;
          const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("SSE frame timeout")), Math.max(1, deadline - Date.now()));
          })]).finally(() => clearTimeout(timer));
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        throw new Error("SSE frame timeout");
      },
      async close() { readers.delete(reader); await reader.cancel(); },
    };
  }
  return { live, request, create, send, action, stream, advance(ms) { time += ms; live.liveV2.sweep(); } };
}

test("v2 anonymous registration separates watching from publishing and has no public directory", async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  assert.equal(created.status, 201);
  const session = created.body;
  assert.match(session.sessionId, /^[a-f0-9]{32}$/u);
  assert.match(session.watchId, /^[a-f0-9]{32}$/u);
  assert.match(session.watchCode, /^[A-HJ-NP-Z]{4}$/u);
  assert.match(session.publishToken, /^[a-f0-9]{64}$/u);
  assert.equal(session.watchPath, `/?watch=${session.watchId}`);
  assert.equal(session.leaseMs, 15_000);
  assert.equal(session.heartbeatMs, 5_000);
  const read = await f.request(`/api/live/v2/watch/${session.watchId}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.manifest.sessionId, session.sessionId);
  assert.equal(read.body.watchCode, session.watchCode);
  for (const secret of [roomKey, clientId, session.publishToken]) assert.ok(!JSON.stringify(read.body).includes(secret));
  assert.equal((await f.request("/api/live/v2/sessions")).status, 404);
  assert.equal((await f.request("/api/live/v2/watch")).status, 404);
  assert.deepEqual(await f.request("/api/live/v2/codes"), { status: 404, body: { error: "unknown-watch-code" } });
  assert.equal((await f.send(session, [wrap(sample(0), 1)], "c".repeat(64))).status, 401);
  assert.equal((await f.send(session, [wrap(sample(0), 1)], session.watchId)).status, 401);
  assert.equal((await f.send(session, [wrap(sample(0), 1)], session.watchCode)).status, 401);
  assert.equal((await f.send(session, [wrap(sample(0), 1)])).status, 200);
});

test("legacy URLs are gone by default while health and trajectory dispatch still work", async (t) => {
  const f = await fixture(t);
  for (const path of ["/api/runs", "/api/runs/abcd", "/api/runs/abcd/stream", "/watch/abcd"]) {
    const result = await f.request(path);
    assert.equal(result.status, 410); assert.equal(result.body.error, "legacy-live-disabled");
  }
  assert.equal((await f.request("/api/runs", { runId: "x", code: "abcd" })).status, 410);
  assert.equal((await f.request("/api/health")).status, 200);
  assert.equal((await f.request("/api/route-groups")).body.error, "route-storage-unconfigured");
});

test("same client registration is idempotent and a second active publisher cannot take over", async (t) => {
  const f = await fixture(t), session = (await f.create()).body;
  await f.send(session, [wrap(sample(0), 1)]);
  const repeated = await f.create();
  assert.equal(repeated.body.publishToken, session.publishToken);
  assert.equal(repeated.body.epoch, session.epoch);
  assert.equal(repeated.body.watchCode, session.watchCode);
  assert.equal(repeated.body.lastProducerSeq, 1);
  const other = await f.create({ clientId: "c".repeat(32) });
  assert.equal(other.status, 409);
  assert.deepEqual(other.body, { error: "publisher-active", retryAfterMs: 5_000, sessionId: session.sessionId, watchId: session.watchId, watchCode: session.watchCode });
});

test("expired lease takeover keeps the watch link, rotates credentials, resets epoch and updates existing viewers", async (t) => {
  const f = await fixture(t), old = (await f.create()).body;
  await f.send(old, [wrap(sample(0), 1)]);
  const view = await f.stream(old);
  assert.equal((await view.next()).event, "hello");
  f.advance(15_001);
  assert.equal((await view.next()).body.status, "reconnecting");
  assert.equal((await f.action(old, "heartbeat")).body.error, "publisher-lease-expired");
  const taken = await f.create({ clientId: "c".repeat(32) });
  assert.equal(taken.status, 201);
  const next = taken.body;
  assert.equal(next.watchId, old.watchId); assert.equal(next.sessionId, old.sessionId);
  assert.equal(next.watchCode, old.watchCode);
  assert.equal(next.epoch, old.epoch + 1); assert.notEqual(next.publishToken, old.publishToken);
  assert.equal(next.lastSeq, 0); assert.equal(next.lastProducerSeq, 0);
  const reset = await view.next();
  assert.equal(reset.event, "hello"); assert.equal(reset.body.epoch, next.epoch);
  assert.equal(reset.body.watchCode, old.watchCode);
  assert.deepEqual(reset.body.snapshot.records, []);
  assert.equal((await f.send(old, [wrap(sample(1), 2)])).status, 401);
  await f.send(next, [wrap(sample(0), 1)]);
  const record = await view.next();
  assert.equal(record.body.epoch, next.epoch); assert.equal(record.body.seq, 1);
});

test("short codes resolve only a minimal public watch destination and remain usable during reconnect grace", async (t) => {
  const f = await fixture(t, { watchCodeGenerator: () => "TEST" }), session = (await f.create()).body;
  const path = `/api/live/v2/codes/${session.watchCode}`;
  assert.deepEqual(await f.request(path), { status: 200, body: {
    watchCode: session.watchCode, watchId: session.watchId, watchPath: session.watchPath, status: "live",
  } });
  const view = await f.stream(session);
  assert.equal((await view.next()).body.watchCode, session.watchCode);
  for (const code of ["", "ZZZZ", "AAAAA", "1234", "IIII", "OOOO", session.watchCode.toLowerCase(), "ABCD/extra", "%41BCD"]) {
    assert.deepEqual(await f.request(`/api/live/v2/codes/${code}`), { status: 404, body: { error: "unknown-watch-code" } });
  }
  assert.equal((await f.request(path, {})).status, 404);
  f.advance(15_001);
  assert.deepEqual(await f.request(path), { status: 200, body: {
    watchCode: session.watchCode, watchId: session.watchId, watchPath: session.watchPath, status: "reconnecting",
  } });
  f.advance(45_000);
  assert.deepEqual(await f.request(path), { status: 404, body: { error: "unknown-watch-code" } });
  const retained = await f.request(`/api/live/v2/watch/${session.watchId}`);
  assert.equal(retained.status, 200); assert.equal(retained.body.status, "ended"); assert.equal(retained.body.watchCode, null);
  const late = await f.stream(session);
  assert.equal((await late.next()).body.watchCode, null);
  assert.equal(await late.next(), null);
});

test("short code collisions retry without replacing a room and ended codes stay reserved until cleanup", async (t) => {
  const candidates = ["AAAA", "AAAA", "BBBB", "AAAA", "CCCC", "AAAA"];
  let calls = 0;
  const f = await fixture(t, { watchCodeGenerator: () => { calls += 1; return candidates.shift(); } });
  const first = (await f.create()).body;
  const second = (await f.create({ roomKey: "c".repeat(64) })).body;
  assert.equal(first.watchCode, "AAAA"); assert.equal(second.watchCode, "BBBB"); assert.equal(calls, 3);
  await f.action(first, "end");
  assert.deepEqual(await f.request("/api/live/v2/codes/AAAA"), { status: 404, body: { error: "unknown-watch-code" } });
  const third = (await f.create()).body;
  assert.equal(third.watchCode, "CCCC"); assert.equal(calls, 5);
  assert.notEqual(third.watchId, first.watchId);
  assert.equal((await f.request("/api/live/v2/codes/BBBB")).body.watchId, second.watchId);
  assert.equal((await f.request(`/api/live/v2/watch/${first.watchId}`)).body.watchCode, null);
  f.advance(15 * 60_000);
  assert.equal((await f.request(`/api/live/v2/watch/${first.watchId}`)).status, 404);
  const reused = await f.create({ roomKey: "d".repeat(64) });
  assert.equal(reused.status, 201); assert.equal(reused.body.watchCode, "AAAA"); assert.equal(calls, 6);
  assert.notEqual(reused.body.watchId, first.watchId);
});

test("short code allocation gives up after exactly 32 collisions without leaking a half-created session", async (t) => {
  let calls = 0;
  const f = await fixture(t, { watchCodeGenerator: () => { calls += 1; return "AAAA"; } });
  const session = (await f.create()).body, initial = f.live.liveV2.stats();
  const result = await f.create({ roomKey: "d".repeat(64) });
  assert.deepEqual(result, { status: 503, body: { error: "watch-code-capacity" } });
  assert.equal(calls, 33); assert.deepEqual(f.live.liveV2.stats(), initial);
  assert.equal((await f.request("/api/live/v2/codes/AAAA")).body.watchId, session.watchId);
  const retry = await f.create();
  assert.equal(retry.status, 201); assert.equal(retry.body.watchCode, "AAAA"); assert.equal(calls, 33);
});

test("short code lookups count success and malformed attempts in a separate 30-per-minute budget", async (t) => {
  const f = await fixture(t), session = (await f.create()).body;
  const path = `/api/live/v2/codes/${session.watchCode}`;
  for (let index = 0; index < 30; index += 1) {
    assert.equal((await f.request(index % 2 ? "/api/live/v2/codes/bad" : path)).status, index % 2 ? 404 : 200);
  }
  assert.deepEqual(await f.request(path), { status: 429, body: { error: "rate-limited", retryAfterMs: 60_000 } });
  assert.equal((await f.request("/api/live/v2/codes")).status, 429);
  assert.equal((await f.request(`/api/live/v2/watch/${session.watchId}`)).status, 200);
  assert.equal((await f.action(session, "heartbeat")).status, 200);
  assert.equal((await f.create()).status, 201);
  f.advance(60_000);
  const next = (await f.create()).body;
  assert.equal((await f.request(`/api/live/v2/codes/${next.watchCode}`)).status, 200);
  const independent = await fixture(t, { limits: { readsPerMinute: 1 } });
  const other = (await independent.create()).body;
  assert.equal((await independent.request(`/api/live/v2/watch/${other.watchId}`)).status, 200);
  assert.equal((await independent.request(`/api/live/v2/watch/${other.watchId}`)).status, 429);
  assert.equal((await independent.request(`/api/live/v2/codes/${other.watchCode}`)).status, 200);
});

test("records retry idempotently and malformed or gapped batches never partially commit", async (t) => {
  const f = await fixture(t), session = (await f.create()).body;
  const batch = [wrap(sample(0), 1), wrap(sample(100), 2)];
  assert.equal((await f.send(session, batch)).body.accepted, 2);
  const repeated = await f.send(session, batch);
  assert.equal(repeated.body.accepted, 0); assert.equal(repeated.body.duplicates, 2);
  assert.equal(repeated.body.lastSeq, 2);
  const gap = await f.send(session, [wrap(sample(200), 3), wrap(sample(400), 5)]);
  assert.equal(gap.status, 409); assert.equal(gap.body.expectedProducerSeq, 3);
  const invalid = await f.send(session, [wrap(sample(200), 3), wrap({ ...sample(300), stableId: "private" }, 4)]);
  assert.equal(invalid.status, 400);
  assert.equal(f.live.liveV2.sessions.get(session.sessionId).lastSeq, 2);
  assert.equal((await f.send(session, [wrap(sample(200), 3)])).body.lastSeq, 3);
});

test("record and manifest schemas reject stable identities, arbitrary nested data and invalid coordinates", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ runId: "private" }, { participants: [] }, { identityMode: "platform-user-id" }]) {
    assert.equal((await f.create({ manifest: { ...manifest, ...extra } })).status, 400);
  }
  const session = (await f.create()).body;
  const records = [
    { ...sample(0), playerId: "76561198000000001" },
    { ...sample(0), roomTs: 10 },
    { ...sample(0), pos: [1, 2] },
    { type: "world_snapshot", t: 0, objects: [] },
    { type: "appearance", t: 0, playerId: "p1", appearance: { platformId: "private" } },
    { type: "inventory", t: 0, playerId: "p1", held: { name: "apple", instanceId: "private" } },
  ];
  for (const record of records) assert.equal((await f.send(session, [wrap(record, 1)])).status, 400);
  assert.equal(f.live.liveV2.sessions.get(session.sessionId).lastSeq, 0);
});

test("recorder numeric build IDs and inventory slots keep their safe native shape", async (t) => {
  const f = await fixture(t), created = await f.create({ manifest: { ...manifest, gameBuildId: 25306743 } });
  assert.equal(created.status, 201);
  const session = created.body;
  const result = await f.send(session, [
    wrap({ type: "inventory", t: 0, playerId: "p1", inventoryReady: true, held: null,
      slots: [{ location: "inventory", container: "backpack", slotId: 1, index: 0, empty: false, item: { id: "apple", itemId: 100, name: "Apple", count: 1 } }] }, 1),
    wrap({ type: "event", t: 1, playerId: "p1", event: "throw", throwCharge: 0.5 }, 2),
  ]);
  assert.equal(result.status, 200); assert.equal(result.body.accepted, 2);
  assert.equal((await f.request(`/api/live/v2/watch/${session.watchId}`)).body.manifest.gameBuildId, "25306743");
});

test("production C# LivePayload fixture registers, publishes all eight record types and produces a private-safe snapshot", async (t) => {
  const payload = JSON.parse(await readFile(new URL("../../../PeakTrailRecorder/tests/LivePublisherContract/fixture.json", import.meta.url), "utf8"));
  const f = await fixture(t), created = await f.create({ manifest: payload.manifest });
  assert.equal(created.status, 201);
  const session = created.body;
  const result = await f.send(session, payload.records.map((record, index) => wrap(record, index + 1)));
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, payload.records.length);
  const view = await f.stream(session), first = await view.next();
  assert.equal(first.body.snapshotSeq, payload.records.length);
  assert.deepEqual(new Set(first.body.snapshot.records.map(({ record }) => record.type)),
    new Set(["participant", "sample", "state", "appearance", "inventory", "status", "route", "event"]));
  const exposed = JSON.stringify(first.body);
  for (const forbidden of ["roomKey", "clientId", "publishToken", "runId", "actorNumber", "platform", "instanceId", "76561198000012345"]) {
    assert.ok(!exposed.includes(forbidden), `snapshot exposed ${forbidden}`);
  }
});

test("independent latest state survives history eviction and initial hello has one ordered snapshot", async (t) => {
  const f = await fixture(t, { limits: { historyRecords: 3 } }), session = (await f.create()).body;
  await f.send(session, [
    wrap({ type: "participant", t: 0, playerId: "p1", nickname: "队友" }, 1),
    wrap({ type: "appearance", t: 0, playerId: "p1", appearance: { ready: true, outfitName: "Scout" } }, 2),
    wrap({ type: "route", t: 0, route: { segments: [{ index: 0, biome: "Coast" }] } }, 3),
    wrap(sample(10), 4), wrap(sample(20), 5), wrap(sample(30), 6), wrap(sample(40), 7),
  ]);
  const view = await f.stream(session), first = await view.next();
  assert.equal(first.event, "hello"); assert.equal(first.body.snapshotSeq, 7);
  const records = first.body.snapshot.records;
  assert.ok(records.some(({ record }) => record.type === "participant"));
  assert.ok(records.some(({ record }) => record.type === "appearance"));
  assert.ok(records.some(({ record }) => record.type === "route"));
  const sequences = records.map((entry) => entry.seq);
  assert.deepEqual(sequences, [...new Set(sequences)].sort((a, b) => a - b));
  await f.send(session, [wrap(sample(50), 8)]);
  const next = await view.next();
  assert.equal(next.event, "record"); assert.equal(next.body.seq, 8);
});

test("visual appearance fields have a closed typed HTTP contract without source identities", async t => {
  const f = await fixture(t), session = (await f.create()).body;
  const appearance = { ready: true, formReady: true, form: "ghost", ghostReady: true, ghostActive: true,
    ghostVisible: false, ghostPosition: [10, 20, -30], ghostRotation: [0, 0, 0, 1],
    petrificationReady: true, petrificationActive: true, petrificationAmount: .625,
    petrificationTriggered: true, petrificationProgress: .5, blindnessReady: true, blindnessActive: true };
  const record = value => ({ type: "appearance", t: 0, playerId: "p1", appearance: value });
  for (const invalid of [{ ownerId: "private" }, { ghostOwner: "private" }, { ghostReady: null }, { ghostReady: "true" },
    { ghostActive: 1 }, { ghostVisible: "false" }, { ghostPosition: [1, 2] }, { ghostPosition: [1_000_001, 0, 0] },
    { ghostPosition: ["1", 0, 0] }, { ghostRotation: [0, 0, 1] }, { ghostRotation: [0, 0, 0, 1.01] },
    { petrificationReady: null }, { petrificationAmount: 1001 }, { petrificationAmount: "0.5" },
    { petrificationProgress: -.1 }, { petrificationProgress: 1.1 }, { petrificationTriggered: "true" },
    { blindnessReady: 1 }, { blindnessActive: "true" }, { form: "guessed-from-death" }]) {
    const result = await f.send(session, [wrap(record({ ...appearance, ...invalid }), 1)]);
    assert.equal(result.status, 400, JSON.stringify(invalid));
    assert.equal(f.live.liveV2.sessions.get(session.sessionId).lastSeq, 0);
  }
  assert.equal((await f.send(session, [wrap(record(appearance), 1)])).body.accepted, 1);
  assert.equal((await f.send(session, [wrap(record({ ...appearance, petrificationAmount: -1.25 }), 2)])).body.accepted, 1,
    "native shader values are bounded but not clamped to a normalized progress range");
  const unknown = { ready: false, formReady: false, form: "unknown", ghostReady: false, ghostActive: null, ghostVisible: null,
    petrificationReady: false, petrificationActive: null, petrificationAmount: null,
    petrificationTriggered: null, petrificationProgress: null, blindnessReady: false, blindnessActive: null };
  assert.equal((await f.send(session, [wrap(record(unknown), 3)])).body.accepted, 1);
});

test("native visual updates survive latest snapshots and SSE retry while producer takeover clears the old epoch", async t => {
  const f = await fixture(t, { limits: { historyRecords: 2 } }), session = (await f.create()).body;
  const active = { ready: true, formReady: true, form: "ghost", ghostReady: true, ghostActive: true,
    ghostVisible: false, ghostPosition: [100, 50, -20], ghostRotation: [0, 0, 0, 1],
    petrificationReady: true, petrificationActive: true, petrificationAmount: .625,
    petrificationTriggered: true, petrificationProgress: .5, blindnessReady: true, blindnessActive: true };
  const clear = { ready: true, formReady: true, form: "normal", ghostReady: true, ghostActive: false, ghostVisible: false,
    petrificationReady: true, petrificationActive: false, petrificationTriggered: false, blindnessReady: true, blindnessActive: false };
  const unknown = { ready: false, formReady: false, form: "unknown", ghostReady: false, ghostActive: null,
    petrificationReady: false, petrificationActive: null, blindnessReady: false, blindnessActive: null };
  const appearanceRecord = (t, appearance) => ({ type: "appearance", t, playerId: "p1", appearance });
  const initial = [wrap(sample(0), 1), wrap(appearanceRecord(100, active), 2), wrap(sample(200), 3), wrap(sample(300), 4)];
  assert.equal((await f.send(session, initial)).body.accepted, 4);
  const view = await f.stream(session), hello = await view.next();
  assert.equal(hello.event, "hello");
  assert.deepEqual(hello.body.snapshot.records.find(entry => entry.record.type === "appearance").record.appearance, active);
  assert.equal(hello.body.snapshot.records.find(entry => entry.record.type === "appearance").seq, 2,
    "independent latest appearance is retained after its history entry is evicted");
  const trace = createLiveTrace(hello.body.manifest);
  for (const entry of hello.body.snapshot.records) appendLiveRecord(trace, entry.record);
  finalizeLiveFlush(trace);
  assert.equal(tracePlayerStateAtTime(trace, "p1", .3).appearance.ghostActive, true);
  assert.notDeepEqual(trace.tracks.get("p1").at(-1).pos, active.ghostPosition);

  const cleared = wrap(appearanceRecord(400, clear), 5);
  assert.equal((await f.send(session, [cleared])).body.accepted, 1);
  const frame = await view.next(); assert.equal(frame.event, "record"); assert.equal(frame.id, "5");
  assert.deepEqual(frame.body.record.appearance, clear); appendLiveRecord(trace, frame.body.record); finalizeLiveFlush(trace);
  const state = tracePlayerStateAtTime(trace, "p1", .4).appearance;
  assert.equal(state.ghostActive, false); assert.equal(state.ghostPosition, null); assert.equal(state.petrificationAmount, null);
  assert.equal(state.blindnessActive, false);
  const retry = await f.send(session, [cleared]); assert.equal(retry.body.accepted, 0); assert.equal(retry.body.duplicates, 1);
  const repeated = (await f.create()).body;
  assert.equal(repeated.epoch, session.epoch); assert.equal(repeated.lastProducerSeq, 5);
  const resumed = await f.stream(session, `?after=4&epoch=${session.epoch}`);
  assert.equal((await resumed.next()).event, "resumed");
  assert.deepEqual((await resumed.next()).body.record.appearance, clear); await resumed.close();
  const late = await f.stream(session);
  assert.deepEqual((await late.next()).body.snapshot.records.filter(entry => entry.record.type === "appearance").at(-1).record.appearance, clear);
  await late.close();

  await f.send(session, [wrap(appearanceRecord(500, unknown), 6)]);
  assert.deepEqual((await view.next()).body.record.appearance, unknown);
  f.advance(15_001); assert.equal((await view.next()).body.status, "reconnecting");
  const next = (await f.create({ clientId: "c".repeat(32) })).body;
  assert.equal(next.epoch, session.epoch + 1); assert.equal(next.watchId, session.watchId);
  const reset = await view.next(); assert.equal(reset.event, "hello"); assert.deepEqual(reset.body.snapshot.records, []);
  assert.equal((await f.send(session, [wrap(appearanceRecord(600, active), 7)])).status, 401);
  await f.send(next, [wrap(appearanceRecord(0, unknown), 1)]);
  const newFrame = await view.next(); assert.equal(newFrame.body.epoch, next.epoch); assert.equal(newFrame.body.seq, 1);
  const newTrace = createLiveTrace(reset.body.manifest); appendLiveRecord(newTrace, newFrame.body.record); finalizeLiveFlush(newTrace);
  assert.equal(tracePlayerStateAtTime(newTrace, "p1", 0).appearance.ghostActive, null);
  assert.equal(tracePlayerStateAtTime(newTrace, "p1", 0).appearance.blindnessActive, null);
});

test("a late viewer preserves presence, life and consciousness after their events leave the history window", async (t) => {
  const f = await fixture(t, { limits: { historyRecords: 2 } }), session = (await f.create()).body;
  const records = [
    { type: "participant", t: 0, playerId: "p1", nickname: "已离开" },
    { type: "event", t: 0, playerId: "p1", event: "join" },
    sample(0, "p1"),
    { type: "status", t: 0, playerId: "p1", status: { ready: true, complete: true, dead: false, values: [], effects: [] } },
    { type: "event", t: 100, playerId: "p1", event: "leave" },
    { type: "participant", t: 0, playerId: "p2", nickname: "已死亡" },
    { type: "event", t: 0, playerId: "p2", event: "join" },
    sample(0, "p2"),
    { type: "event", t: 100, playerId: "p2", event: "death" },
    { type: "event", t: 100, playerId: "p3", event: "passed_out" },
    { type: "event", t: 200, playerId: "p3", event: "recovered" },
    sample(1_000, "p4"), sample(2_000, "p4"), sample(3_000, "p4"),
  ];
  await f.send(session, records.map((record, index) => wrap(record, index + 1)));
  const view = await f.stream(session), hello = await view.next();
  const entries = hello.body.snapshot.records;
  assert.deepEqual(entries.map((entry) => entry.seq), [...new Set(entries.map((entry) => entry.seq))].sort((a, b) => a - b));
  const trace = createLiveTrace(hello.body.manifest);
  for (const entry of entries) appendLiveRecord(trace, entry.record);
  finalizeLiveFlush(trace);
  assert.equal(tracePlayerStateAtTime(trace, "p1", 3).life, "absent");
  assert.equal(tracePlayerStateAtTime(trace, "p2", 3).life, "dead");
  assert.ok(entries.some(({ record }) => record.playerId === "p3" && record.event === "recovered"));
  assert.ok(!entries.some(({ record }) => record.playerId === "p3" && record.event === "passed_out"));
  assert.ok(!entries.some(({ record }) => record.playerId === "p1" && record.event === "join"));
  // A later resurrection replaces only the life family; it cannot erase
  // another player's retained presence or consciousness.
  await f.send(session, [
    wrap({ type: "event", t: 3_100, playerId: "p2", event: "revive" }, records.length + 1),
    wrap(sample(4_000, "p4"), records.length + 2),
    wrap(sample(5_000, "p4"), records.length + 3),
  ]);
  const after = await f.stream(session), refreshed = await after.next();
  const second = createLiveTrace(refreshed.body.manifest);
  for (const entry of refreshed.body.snapshot.records) appendLiveRecord(second, entry.record);
  finalizeLiveFlush(second);
  assert.equal(tracePlayerStateAtTime(second, "p2", 5).life, "alive");
  assert.equal(tracePlayerStateAtTime(second, "p1", 5).life, "absent");
});

test("late hello retains native milestones independently of the recent path window in original sequence order", async (t) => {
  const f = await fixture(t, { limits: { historyRecords: 1 } }), session = (await f.create()).body;
  const names = ["native-checkpoint", "summit", "nadir-ready", "nadir-entry", "nadir-wall", "nadir-chase", "nadir", "run_end"];
  const records = names.map((event, index) => wrap({ type: "event", t: index, playerId: "p1", activeSegment: 5,
    event, source: "native-state", pos: [index, 2, 3] }, index + 1));
  await f.send(session, records);
  await f.send(session, [wrap(sample(10), 9), wrap(sample(11), 10)]);
  const view = await f.stream(session), hello = await view.next();
  assert.equal(hello.body.snapshotSeq, 10);
  assert.deepEqual(hello.body.snapshot.records.map(entry => entry.seq), [1, 2, 3, 4, 5, 6, 7, 8, 10]);
  assert.deepEqual(hello.body.snapshot.records.filter(entry => entry.record.type === "event").map(entry => entry.record.event), names);
});

test("live item use/spawn keeps actual positions and linked IDs with a bounded newest item snapshot", async (t) => {
  const f = await fixture(t, { limits: { itemEvents: 2 } }), session = (await f.create()).body;
  const actionId = "a".repeat(64), records = [1, 2, 3].map((n, index) => ({ type: "event", t: n,
    event: index ? "item-spawn" : "item-use", id: String(n).repeat(64), actionId,
    item: { itemId: 7, name: "Campfire" }, pos: [n, 2, 3], activeSegment: 0 }));
  assert.equal((await f.send(session, records.map((record, index) => wrap(record, index + 1)))).status, 200);
  const view = await f.stream(session), hello = await view.next();
  assert.deepEqual(hello.body.snapshot.records.map(entry => entry.record), records.slice(1));
  assert.equal(hello.body.snapshotSeq, 3);
  await f.send(session, [wrap(sample(10), 4)]);
  const item = (await f.stream(session));
  assert.equal((await item.next()).body.snapshot.records.filter(entry => entry.record.type === "event").length, 2);
  for (const change of [{ id: "bad" }, { actionId: "bad" }, { pos: null }, { item: null }])
    assert.equal((await f.send(session, [wrap({ ...records[0], ...change }, 5)])).status, 400);
});

test("SSE resumes every retained record and resets with a snapshot for an evicted cursor or old epoch", async (t) => {
  const f = await fixture(t, { limits: { historyRecords: 4 } }), session = (await f.create()).body;
  await f.send(session, Array.from({ length: 6 }, (_, i) => wrap(sample(i), i + 1)));
  const view = await f.stream(session, `?after=2&epoch=${session.epoch}`);
  assert.equal((await view.next()).event, "resumed");
  for (let seq = 3; seq <= 6; seq += 1) assert.equal((await view.next()).body.seq, seq);
  await f.send(session, [wrap(sample(7), 7)]);
  assert.equal((await view.next()).body.seq, 7);
  await view.close();
  const stale = await f.stream(session, `?after=1&epoch=${session.epoch}`);
  const hello = await stale.next();
  assert.equal(hello.event, "hello"); assert.equal(hello.body.snapshotSeq, 7);
  assert.equal(hello.body.snapshot.records.at(-1).seq, 7);
  const wrongEpoch = await f.stream(session, "?after=7&epoch=99");
  assert.equal((await wrongEpoch.next()).event, "hello");
  const headerCursor = await f.stream(session, `?after=0&epoch=${session.epoch}`, { "last-event-id": "6" });
  assert.equal((await headerCursor.next()).event, "resumed");
  assert.equal((await headerCursor.next()).body.seq, 7);
});

test("heartbeat renews the lease, silence ends it, and viewers cannot extend retention", async (t) => {
  const f = await fixture(t), session = (await f.create()).body;
  const view = await f.stream(session); await view.next();
  f.advance(10_000);
  assert.equal((await f.action(session, "heartbeat")).status, 200);
  f.advance(10_000);
  assert.equal((await f.request(`/api/live/v2/watch/${session.watchId}`)).body.status, "live");
  f.advance(50_001);
  assert.equal((await view.next()).body.status, "ended");
  assert.equal((await view.next()), null);
  assert.equal((await f.request(`/api/live/v2/watch/${session.watchId}`)).body.reason, "publisher-timeout");
  f.advance(15 * 60_000);
  assert.equal((await f.request(`/api/live/v2/watch/${session.watchId}`)).status, 404);
  assert.equal(f.live.liveV2.stats().residentBytes, 0);
});

test("explicit stop ends immediately, and the hard lifetime applies even with heartbeats", async (t) => {
  const f = await fixture(t, { limits: { ttlMs: 20_000 } }), session = (await f.create()).body;
  const view = await f.stream(session); await view.next();
  const stopped = await f.action(session, "end", { reason: "disabled-in-settings" });
  assert.equal(stopped.body.status, "ended");
  assert.equal((await f.request(`/api/live/v2/codes/${session.watchCode}`)).status, 404);
  assert.equal((await view.next()).body.reason, "disabled-in-settings");
  assert.equal((await f.send(session, [wrap(sample(0), 1)])).status, 410);
  const next = (await f.create()).body;
  assert.notEqual(next.watchId, session.watchId);
  f.advance(10_000); await f.action(next, "heartbeat");
  f.advance(10_000);
  const meta = await f.request(`/api/live/v2/watch/${next.watchId}`);
  assert.equal(meta.body.status, "ended"); assert.equal(meta.body.reason, "maximum-duration");
  assert.equal(meta.body.watchCode, null);
  assert.equal((await f.request(`/api/live/v2/codes/${next.watchCode}`)).status, 404);
});

test("body, line, player, state, session, global memory and rate budgets reject excess without corrupting cursors", async (t) => {
  const f = await fixture(t, { limits: { sessions: 1, players: 1, batchLines: 2, bodyBytes: 1_024, recordBytes: 256, requestsPerMinute: 20 } });
  const session = (await f.create()).body;
  assert.equal((await f.create({ roomKey: "c".repeat(64) })).status, 503);
  assert.equal((await f.send(session, [wrap(sample(0), 1), wrap(sample(1), 2), wrap(sample(2), 3)])).status, 413);
  assert.equal((await f.send(session, [wrap(sample(0), 1)])).status, 200);
  assert.equal((await f.send(session, [wrap(sample(1, "p2"), 2)])).status, 413);
  assert.equal((await f.request(`/api/live/v2/sessions/${session.sessionId}/records`, "x".repeat(1_025), session.publishToken)).status, 413);
  assert.equal((await f.send(session, [wrap({ type: "participant", t: 0, playerId: "p1", nickname: "中".repeat(100) }, 2)])).status, 413);
  assert.equal(f.live.liveV2.sessions.get(session.sessionId).lastSeq, 1);

  const memory = await fixture(t, { limits: { globalBytes: 600 } }), small = (await memory.create()).body;
  assert.equal((await memory.send(small, [wrap(sample(0), 1), wrap(sample(1), 2)])).status, 503);
  assert.equal(memory.live.liveV2.sessions.get(small.sessionId).lastSeq, 0);
  const state = await fixture(t, { limits: { stateBytes: 100 } }), stateSession = (await state.create()).body;
  assert.equal((await state.send(stateSession, [wrap(sample(0), 1)])).status, 413);
  const rate = await fixture(t, { limits: { requestsPerMinute: 1 } }), rateSession = (await rate.create()).body;
  assert.equal((await rate.action(rateSession, "heartbeat")).status, 200);
  assert.equal((await rate.action(rateSession, "heartbeat")).status, 429);
});

test("slow SSE consumers are disconnected at the byte budget even when write returns false", async (t) => {
  const f = await fixture(t), session = (await f.create()).body;
  const view = await f.stream(session); await view.next();
  const room = f.live.liveV2.sessions.get(session.sessionId), viewer = [...room.viewers][0];
  const realWrite = viewer.res.write;
  let queued = 0, writes = 0;
  Object.defineProperty(viewer.res, "writableLength", { get: () => queued, configurable: true });
  viewer.res.write = (frame) => { queued += Buffer.byteLength(frame); writes += 1; return false; };
  const record = { type: "participant", t: 0, playerId: "p1", nickname: "队友".repeat(40) };
  // A bounded fake kernel isolates the backpressure behavior from local TCP buffering.
  queued = 512 * 1024 - 1_000;
  for (let seq = 1; seq < 10 && room.viewers.size; seq += 1) await f.send(session, [wrap(record, seq)]);
  assert.ok(writes > 0); assert.ok(queued <= 512 * 1024);
  assert.equal(room.viewers.size, 0); assert.equal(f.live.liveV2.stats().viewers, 0);
  viewer.res.write = realWrite;
});

test("large retained replay resets to a bounded current snapshot instead of skipping latest records", async (t) => {
  const f = await fixture(t, { limits: { snapshotBytes: 500 } }), session = (await f.create()).body;
  await f.send(session, Array.from({ length: 10 }, (_, i) => wrap(sample(i), i + 1)));
  const view = await f.stream(session, `?after=1&epoch=${session.epoch}`);
  const frame = await view.next();
  assert.equal(frame.event, "hello"); assert.equal(frame.body.snapshotSeq, 10);
  assert.equal(frame.body.snapshot.records.at(-1).seq, 10);
  assert.ok(frame.body.snapshot.records.length < 10);
  await f.send(session, [wrap(sample(11), 11)]);
  assert.equal((await view.next()).body.seq, 11);
});

test("viewer admission and byte rates have independent bounded budgets", async (t) => {
  const f = await fixture(t, { limits: { viewersPerSession: 1, viewers: 1, bytesPerMinute: 100 } });
  const session = (await f.create()).body, view = await f.stream(session);
  assert.equal((await view.next()).event, "hello");
  const second = await f.request(`/api/live/v2/watch/${session.watchId}/stream`);
  assert.equal(second.status, 503); assert.equal(second.body.error, "too-many-viewers");
  assert.equal((await f.send(session, [wrap(sample(1), 1)])).status, 200);
  assert.equal((await f.send(session, [wrap(sample(2), 2)])).status, 429);
  assert.equal(f.live.liveV2.sessions.get(session.sessionId).lastSeq, 1);
  await view.close();
  // close is asynchronous at the server; admission is released on its close event.
  for (let retry = 0; retry < 20 && f.live.liveV2.stats().viewers; retry += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(f.live.liveV2.stats().viewers, 0);
});

test("closing the API releases all sessions and timers", async () => {
  const api = createLiveV2Api();
  await api.close();
  assert.deepEqual(api.stats(), { sessions: 0, residentBytes: 0, viewers: 0, activeBodies: 0 });
});
