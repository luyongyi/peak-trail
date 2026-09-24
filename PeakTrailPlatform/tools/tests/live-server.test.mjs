import assert from "node:assert/strict";
import test from "node:test";
import { createLiveServer } from "../../server/live-server.mjs";
import { deriveRunCode } from "../../server/run-code.mjs";

const RUN_ID = "9bf6aaa3-0712-49e2-83d0-6e54930c3d90";

async function start(options = {}) {
  const live = createLiveServer(options);
  await new Promise((resolveListen) => live.server.listen(0, "127.0.0.1", resolveListen));
  const { port } = live.server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    live, base,
    close: () => new Promise((done) => {
      // fetch() pools keep-alive sockets; without this the close callback never fires.
      live.server.closeAllConnections?.();
      live.server.close(done);
    }),
  };
}

const register = async (base, body) => {
  const response = await fetch(`${base}/api/runs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
};

test("deployment health endpoint exposes no room or player information", async () => {
  const { base, close } = await start();
  try {
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { ok: true, service: "peak-trail-live" });
  } finally { await close(); }
});

const postRecords = async (base, code, producer, records) => {
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  const response = await fetch(`${base}/api/runs/${code}/records?producer=${encodeURIComponent(producer)}`, {
    method: "POST", headers: { "content-type": "application/x-ndjson" }, body,
  });
  return { status: response.status, json: await response.json() };
};

test("server confirms the derived code and merges every producer of one runId into one run", async () => {
  const { base, close } = await start();
  try {
    const code = deriveRunCode(RUN_ID);
    const first = await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_18" } });
    assert.equal(first.status, 201);
    assert.equal(first.json.confirmed, true);

    // Another modded client in the same run derives the same code and runId:
    // the server confirms instead of creating a second run.
    const second = await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_18", extra: true } });
    assert.equal(second.status, 200);
    assert.equal(second.json.mergedIntoExisting, true);
    assert.equal(second.json.code, code);

    // The code is not taken on faith: it must re-derive from the runId.
    const forged = await register(base, { code: "aaaa", runId: RUN_ID });
    assert.equal(forged.status, 400);
    const wrongRun = await register(base, { code: deriveRunCode(RUN_ID), runId: "00000000-0000-0000-0000-000000000000" });
    assert.equal(wrongRun.status, 400);
    const junk = await register(base, { code: "zzzz", runId: "00000000-0000-0000-0000-000000000000" });
    assert.equal(junk.status, 400);

    // A genuine code collision (a different runId deriving the same code) is
    // rejected once; the recorder walks its deterministic attempt sequence and
    // every client of that run converges on the same next code.
    const primaryCode = deriveRunCode(RUN_ID);
    let collisionRunId = null;
    for (let seed = 0; seed < 2_000_000 && !collisionRunId; seed += 1) {
      const candidate = `00000000-0000-4000-8000-${String(seed).padStart(12, "0")}`;
      if (candidate !== RUN_ID && deriveRunCode(candidate) === primaryCode) collisionRunId = candidate;
    }
    assert.ok(collisionRunId, "a collision partner for the fixed run code exists in the scan space");
    const collision = await register(base, { code: primaryCode, runId: collisionRunId });
    assert.equal(collision.status, 409);
    assert.equal(collision.json.retryWithNextAttempt, true);
    const fallback = await register(base, { code: deriveRunCode(collisionRunId, 1), runId: collisionRunId });
    assert.equal(fallback.status, 201);
  } finally {
    await close();
  }
});

test("records from multiple producers of one run deduplicate on the shared room clock", async () => {
  const { base, close, live } = await start();
  try {
    const code = deriveRunCode(RUN_ID);
    await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_18" } });

    const shared = { type: "sample", t: 12_500, playerId: "76561198000000001", pos: [1, 2, 3], yaw: 0, roomTs: 900 };
    const mine = await postRecords(base, code, "76561198000000001", [shared]);
    assert.equal(mine.json.accepted, 1);
    // Teammate's recorder observed the same game frame: same roomTs -> duplicate.
    const teammate = await postRecords(base, code, "76561198000000002", [
      { ...shared, pos: [1.02, 2, 3] },
    ]);
    assert.equal(teammate.json.accepted, 0);
    assert.equal(teammate.json.duplicates, 1);
    // A different frame is not deduplicated.
    const next = await postRecords(base, code, "76561198000000002", [
      { type: "sample", t: 12_700, playerId: "76561198000000001", pos: [1.1, 2, 3], yaw: 4, roomTs: 920 },
    ]);
    assert.equal(next.json.accepted, 1);

    // Without a shared clock the key falls back to producer scope: never deduped
    // (graceful degradation, never wrongly merged).
    const noClock = await postRecords(base, code, "76561198000000002", [
      { type: "sample", t: 12_500, playerId: "76561198000000001", pos: [1, 2, 3], yaw: 0 },
    ]);
    assert.equal(noClock.json.accepted, 1);

    // Malformed lines are rejected without poisoning the batch.
    const mixed = await postRecords(base, code, "76561198000000001", [
      { type: "sample", t: 13_000, playerId: "p1", pos: [0, 0, 0], roomTs: 950 },
      "not-json",
      { type: "sample", t: "NaN", playerId: "p1" },
    ]);
    assert.equal(mixed.json.accepted, 1);
    assert.equal(mixed.json.rejected, 2);

    // Producers count their own session clocks; the relay rebases served t onto
    // the run's shared room-clock anchor (first-seen roomTs = 900 here), so all
    // teammates land on one small positive timeline.
    await postRecords(base, code, "76561198000000001", [
      { type: "state", t: 14_000, playerId: "76561198000000001", stamina01: 0.5, roomTs: 970 },
    ]);
    const snapshotNow = await (await fetch(`${base}/api/runs/${code}/snapshot`)).json();
    const aligned = snapshotNow.players["76561198000000001"].state;
    assert.equal(aligned.t, 70, "t is rebased onto the shared room timeline");
    assert.equal(aligned.localT, 14_000, "the producer-local clock is preserved");
    const localSample = snapshotNow.players["76561198000000001"].sample;
    assert.equal(localSample.t, 12_500, "records without roomTs keep their local clock");

    const run = [...live.runs.values()][0];
    assert.equal(run.acceptedLines, 5);
    const list = await (await fetch(`${base}/api/runs`)).json();
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0].sceneName, "Level_18");
  } finally {
    await close();
  }
});

test("a reconnecting viewer resumes from Last-Event-ID without hello or full replay", async () => {
  const { base, close } = await start();
  try {
    const code = deriveRunCode(RUN_ID);
    await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_19" } });
    await postRecords(base, code, "p1", [
      { type: "sample", t: 100, playerId: "p1", pos: [0, 0, 0], yaw: 0, roomTs: 10 },
      { type: "sample", t: 200, playerId: "p1", pos: [1, 0, 0], yaw: 9, roomTs: 20 },
      { type: "sample", t: 300, playerId: "p1", pos: [2, 0, 0], yaw: 18, roomTs: 30 },
      { type: "sample", t: 400, playerId: "p1", pos: [3, 0, 0], yaw: 27, roomTs: 40 },
    ]);

    // A page reconnecting after a drop presents its last seen seq; the relay
    // skips hello + already-delivered records instead of replaying everything.
    const response = await fetch(`${base}/api/runs/${code}/stream`, {
      headers: { "last-event-id": "2" },
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames = [];
    const readFrame = async (timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frameEnd = buffer.indexOf("\n\n");
        if (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const eventMatch = frame.match(/event: (\S+)\ndata: (.*)/s);
          if (eventMatch) return { event: eventMatch[1], data: JSON.parse(eventMatch[2]), id: (frame.match(/^id: (\S+)$/m) || [])[1] ?? null };
          continue;
        }
        const timer = new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(null), deadline - Date.now()));
        const { value, done } = await Promise.race([reader.read(), timer.then(() => ({ done: true, value: undefined }))]);
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
      }
      return null;
    };
    const resumed = await readFrame();
    assert.equal(resumed.event, "resumed", "a resume gets no hello snapshot");
    const first = await readFrame();
    assert.equal(first.data.seq, 3, "records before the resume cursor are not resent");
    assert.equal(first.data.record.t, 20, "served t stays on the rebased room timeline");
    // Consume the rest of the replay (seq 4) before going live.
    const rest = await readFrame();
    assert.equal(rest.data.seq, 4);
    // Live delivery continues from the resume cursor with matching ids.
    await postRecords(base, code, "p1", [
      { type: "sample", t: 500, playerId: "p1", pos: [4, 0, 0], yaw: 36, roomTs: 50 },
    ]);
    const live = await readFrame();
    assert.equal(live.event, "record");
    assert.equal(live.id, "5");
    assert.equal(live.data.record.t, 40);
    reader.cancel();
  } finally {
    await close();
  }
});

test("concurrent daily requests coalesce into one upstream fetch and the warm cache serves directly", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const payload = {
    schemaVersion: 1, sceneName: "Level_20", mapSlot: 20,
    nextChangeAtUtc: new Date(Date.now() + 3600_000).toISOString(),
  };
  const { base, close } = await start({
    dailyResolver: async () => { calls += 1; await gate; return payload; },
  });
  try {
    const first = fetch(`${base}/api/daily`);
    const second = fetch(`${base}/api/daily`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(calls, 1, "both cold requests await the same in-flight upstream fetch");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(await a.json(), payload);
    assert.deepEqual(await b.json(), payload);
    // A warm cache answers without touching the upstream again.
    const third = await (await fetch(`${base}/api/daily`)).json();
    assert.deepEqual(third, payload);
    assert.equal(calls, 1);
  } finally {
    await close();
  }
});

test("daily cache expires at the rotation boundary even before its ten-minute TTL", async () => {
  let now = Date.parse("2026-09-24T16:59:50Z"), calls = 0;
  const deadline = now + 10_000;
  const { base, close } = await start({ dailyNow: () => now, dailyResolver: async () => {
    calls += 1;
    return { sceneName: calls === 1 ? "Level_4" : "Level_5", nextChangeAtUtc: new Date(calls === 1 ? deadline : deadline + 86400_000).toISOString() };
  } });
  try {
    assert.equal((await (await fetch(`${base}/api/daily`)).json()).sceneName, "Level_4");
    now = deadline - 1;
    await fetch(`${base}/api/daily`);
    assert.equal(calls, 1);
    now = deadline;
    assert.equal((await (await fetch(`${base}/api/daily`)).json()).sceneName, "Level_5");
    assert.equal(calls, 2);
  } finally { await close(); }
});

test("upstream stale data does not acquire a fresh cache TTL and a failure can recover", async () => {
  const now = Date.parse("2026-09-24T17:00:00Z"); let calls = 0;
  const { base, close } = await start({ dailyNow: () => now, dailyResolver: async () => {
    calls += 1;
    if (calls === 2) throw new Error("upstream temporarily offline");
    return { sceneName: calls === 1 ? "Level_4" : "Level_5", nextChangeAtUtc: new Date(calls === 1 ? now : now + 86400_000).toISOString() };
  } });
  try {
    assert.equal((await (await fetch(`${base}/api/daily`)).json()).sceneName, "Level_4");
    assert.equal((await fetch(`${base}/api/daily`)).status, 502);
    assert.equal((await (await fetch(`${base}/api/daily`)).json()).sceneName, "Level_5");
    await fetch(`${base}/api/daily`);
    assert.equal(calls, 3, "failure and stale data never mask the next successful observation");
  } finally { await close(); }
});

test("daily cache still observes the short TTL within a long rotation", async () => {
  let now = Date.parse("2026-09-24T17:00:00Z"), calls = 0;
  const deadline = now + 86400_000;
  const { base, close } = await start({ dailyNow: () => now, dailyResolver: async () => {
    calls += 1; return { sceneName: "Level_5", nextChangeAtUtc: new Date(deadline).toISOString() };
  } });
  try {
    await fetch(`${base}/api/daily`);
    now += 10 * 60_000;
    await fetch(`${base}/api/daily`);
    assert.equal(calls, 2);
  } finally { await close(); }
});

test("SSE streams carry observable ping events so viewers can detect silently-dead sockets", async () => {
  const { base, close } = await start({ pingIntervalMs: 50 });
  let reader;
  try {
    const code = deriveRunCode(RUN_ID);
    await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_18" } });
    const response = await fetch(`${base}/api/runs/${code}/stream`);
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawKeepaliveComment = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const frameEnd = buffer.indexOf("\n\n");
      if (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        if (frame.includes(": keepalive")) sawKeepaliveComment = true;
        if (frame.match(/event: ping\ndata: \{\}/)) {
          assert.ok(sawKeepaliveComment, "the comment line accompanies the ping");
          return;
        }
        continue;
      }
      // The server clamps heartbeat intervals to >=100ms. A separate 100ms
      // read timeout races that first ping and falsely reports a 2s failure.
      // Wait for the actual remaining deadline, retaining just one pending read.
      let timer;
      let packet;
      try {
        packet = await Promise.race([
          reader.read(),
          new Promise((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout({ done: true }), Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally { clearTimeout(timer); }
      const { value, done } = packet;
      if (done && !value) break;
      if (value) buffer += decoder.decode(value, { stream: true });
    }
    assert.fail("no ping event within 2s");
  } finally {
    await reader?.cancel().catch(() => {});
    await close();
  }
});

test("snapshot returns the latest per-player state and the SSE stream replays then goes live", async () => {
  const { base, close } = await start();
  try {
    const code = deriveRunCode(RUN_ID);
    await register(base, { code, runId: RUN_ID, manifest: { sceneName: "Level_18", gameBuildId: "25306743" } });
    await postRecords(base, code, "p1", [
      { type: "sample", t: 100, playerId: "p1", pos: [0, 0, 0], yaw: 0, roomTs: 10 },
      { type: "sample", t: 200, playerId: "p1", pos: [1, 0, 0], yaw: 10, roomTs: 20 },
      { type: "state", t: 200, playerId: "p1", stamina01: 0.8, roomTs: 20 },
      { type: "event", event: "segment_change", t: 210, playerId: null, activeSegment: 2, roomTs: 21 },
    ]);

    const snapshot = await (await fetch(`${base}/api/runs/${code}/snapshot`)).json();
    assert.equal(snapshot.players.p1.sample.pos.join(","), "1,0,0");
    assert.equal(snapshot.players.p1.state.stamina01, 0.8);
    assert.equal(snapshot.activeSegment.activeSegment, 2);

    const events = [];
    const controller = new AbortController();
    const response = await fetch(`${base}/api/runs/${code}/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // SSE frames can split across TCP chunks; buffer until a complete frame arrives.
    let sseBuffer = "";
    const readEvent = async () => {
      while (true) {
        const frameEnd = sseBuffer.indexOf("\n\n");
        if (frameEnd >= 0) {
          const frame = sseBuffer.slice(0, frameEnd);
          sseBuffer = sseBuffer.slice(frameEnd + 2);
          const match = frame.match(/event: (\S+)\ndata: (.*)/s);
          if (match) return { event: match[1], data: JSON.parse(match[2]) };
          continue;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        sseBuffer += decoder.decode(value, { stream: true });
      }
    };
    (async () => {
      try { while (true) { const event = await readEvent(); if (!event) break; events.push(event); } } catch { /* closed */ }
    })();
    const hello = await new Promise((resolveHello) => {
      const timer = setInterval(() => {
        const found = events.find((event) => event.event === "hello");
        if (found) { clearInterval(timer); resolveHello(found); }
      }, 20);
    });
    assert.equal(hello.data.manifest.sceneName, "Level_18");
    assert.equal(hello.data.snapshot.players.p1.sample.pos.join(","), "1,0,0");

    // A live record pushed after subscribing arrives with the next seq, with t
    // already normalized onto the shared room clock.
    await postRecords(base, code, "p1", [
      { type: "sample", t: 300, playerId: "p1", pos: [2, 0, 0], yaw: 20, roomTs: 30 },
    ]);
    const live = await new Promise((resolveLive) => {
      const timer = setInterval(() => {
        const found = events.find((event) => event.event === "record"
          && event.data.record.localT === 300);
        if (found) { clearInterval(timer); resolveLive(found); }
      }, 20);
    });
    assert.equal(live.data.record.t, 20, "the streamed record carries the rebased room timeline");
    assert.equal(live.data.record.localT, 300);
    assert.equal(live.data.record.pos.join(","), "2,0,0");
    assert.ok(live.data.seq > hello.data.lastSeq);
    controller.abort();
  } finally {
    await close();
  }
});
