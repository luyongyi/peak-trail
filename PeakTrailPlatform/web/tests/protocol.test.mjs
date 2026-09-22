import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessCompatibility,
  formatTime,
  groupTraceSessions,
  isDailyMapFresh,
  latestLifeEventBefore,
  loadMapPackBundle,
  loadMapPackUrl,
  loadTraceBundle,
  loadTraceCollection,
  MARKER_LIFE_EVENT_TYPES,
  selectDailyMapPack,
  selectTraceMapPack,
  tracePlayerStateAtTime,
  traceSampleAtTime,
} from "../src/protocol.js";

const manifest = {
  schemaVersion: 1,
  mapPackId: "peak-2.4.c-build-19492001-level-7-p1",
  sceneName: "Level_7",
  gameVersion: "2.4.c",
  gameBuildId: "19492001",
  mapSlot: 7,
  projectionVersion: 1,
  coordinateSpace: "unity-world-meters",
};

const mapPack = { ...manifest };

test("small map manifests bypass old immutable responses so verified enclosure corrections can arrive", async (t) => {
  let options;
  t.mock.method(globalThis, 'fetch', async (_url, requested) => {
    options = requested;
    return { ok: false, status: 404, statusText: 'fixture stop before hydration' };
  });
  await assert.rejects(loadMapPackUrl('https://example.invalid/data/maps/packs/id/map-pack.json'));
  assert.equal(options.cache, 'no-store');
});

test("exact map pack identity allows an overlay", () => {
  assert.equal(assessCompatibility(manifest, mapPack).compatible, true);
});

test("scene and display version alone cannot verify an overlay", () => {
  const weakManifest = { ...manifest, mapPackId: null, gameBuildId: null, projectionVersion: null };
  assert.equal(assessCompatibility(weakManifest, mapPack).compatible, false);
});

test("build and projection fallback allows an overlay without mapPackId", () => {
  const fallbackManifest = { ...manifest, mapPackId: null };
  assert.equal(assessCompatibility(fallbackManifest, mapPack).compatible, true);
});

test("invalid or missing protocol identity cannot verify an overlay", () => {
  assert.equal(assessCompatibility({ ...manifest, schemaVersion: 99 }, mapPack).compatible, false);
  assert.equal(
    assessCompatibility(
      { ...manifest, mapPackId: null, projectionVersion: 0 },
      { ...mapPack, projectionVersion: 0 },
    ).compatible,
    false,
  );
  assert.equal(
    assessCompatibility(
      { ...manifest, mapPackId: null, coordinateSpace: null },
      { ...mapPack, coordinateSpace: null },
    ).compatible,
    false,
  );
});

test("a map slot conflict blocks even an otherwise matching pack", () => {
  const wrongPack = { ...mapPack, mapSlot: 8 };
  const result = assessCompatibility(manifest, wrongPack);
  assert.equal(result.compatible, false);
  assert.match(result.reasons.join(" "), /地图槽位/);
});

test("time formatting handles minute and hour sessions", () => {
  assert.equal(formatTime(65), "01:05");
  assert.equal(formatTime(3661), "01:01:01");
});

test("daily catalog selects only the active build and current scene", () => {
  const oldLevel16 = `sha256-${"a".repeat(64)}`;
  const activeLevel15 = `sha256-${"b".repeat(64)}`;
  const activeLevel16 = `sha256-${"c".repeat(64)}`;
  const catalog = {
    schemaVersion: 1,
    activeGameBuildId: "25306743",
    mapPacks: [
      {
        mapPackId: oldLevel16,
        identityVersion: 2,
        sceneName: "Level_16",
        mapSlot: 16,
        gameBuildId: "25200000",
        generatedAtUtc: "2026-09-14T00:00:00Z",
        path: `./packs/${oldLevel16}/map-pack.json`,
      },
      {
        mapPackId: activeLevel15,
        identityVersion: 2,
        sceneName: "Level_15",
        mapSlot: 15,
        gameBuildId: "25306743",
        generatedAtUtc: "2026-09-15T00:00:00Z",
        path: `./packs/${activeLevel15}/map-pack.json`,
      },
      {
        mapPackId: activeLevel16,
        identityVersion: 2,
        sceneName: "Level_16",
        mapSlot: 16,
        gameBuildId: "25306743",
        generatedAtUtc: "2026-09-15T00:00:00Z",
        path: `./packs/${activeLevel16}/map-pack.json`,
      },
    ],
  };

  assert.equal(
    selectDailyMapPack(catalog, { sceneName: "Level_16", mapSlot: 16 })?.mapPackId,
    activeLevel16,
  );
});

test("daily catalog refuses to guess without an explicitly active build", () => {
  const unmarkedLevel16 = `sha256-${"d".repeat(64)}`;
  const catalog = {
    schemaVersion: 1,
    activeGameBuildId: null,
    mapPacks: [
      {
        mapPackId: unmarkedLevel16,
        identityVersion: 2,
        sceneName: "Level_16",
        mapSlot: 16,
        gameBuildId: "25306743",
        path: `./packs/${unmarkedLevel16}/map-pack.json`,
      },
    ],
  };
  assert.equal(selectDailyMapPack(catalog, { sceneName: "Level_16", mapSlot: 16 }), null);
});

test("expired or invalid daily data cannot keep an automatic map visible", () => {
  const now = Date.parse("2026-09-15T17:00:00Z");
  assert.equal(isDailyMapFresh({ nextChangeAtUtc: "2026-09-15T17:00:01Z" }, now), true);
  assert.equal(isDailyMapFresh({ nextChangeAtUtc: "2026-09-15T17:00:00Z" }, now), false);
  assert.equal(isDailyMapFresh({ nextChangeAtUtc: "not-a-date" }, now), false);
});

function textFile(name, contents, relativePath = "") {
  return {
    name,
    webkitRelativePath: relativePath,
    async text() {
      return contents;
    },
  };
}

function traceManifest(sessionId, startedAtUtc, sceneName = "Level_7") {
  return {
    ...manifest,
    sessionId,
    startedAtUtc,
    sceneName,
    timeUnit: "milliseconds",
    segmentResolution: "unassigned",
  };
}

test("a top-level recording directory is split into browser-local days and sessions", async () => {
  const files = [
    textFile("manifest.json", JSON.stringify(traceManifest("day-one", "2026-09-14T23:30:00Z")), "recordings/day-one/manifest.json"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:1","pos":[0,0,0],"yaw":0}\n', "recordings/day-one/stream.ndjson"),
    textFile("manifest.json", JSON.stringify(traceManifest("day-two-a", "2026-09-15T01:00:00Z")), "recordings/day-two-a/manifest.json"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:2","pos":[1,1,1],"yaw":0}\n', "recordings/day-two-a/stream.ndjson"),
    textFile("manifest.json", JSON.stringify(traceManifest("day-two-b", "2026-09-15T03:00:00Z")), "recordings/day-two-b/manifest.json"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:3","pos":[2,2,2],"yaw":0}\n', "recordings/day-two-b/stream.ndjson"),
  ];
  const collection = await loadTraceCollection(files, { timeZone: "UTC" });
  assert.equal(collection.sessions.length, 3);
  assert.deepEqual(collection.days.map((day) => [day.date, day.sessions.length]), [
    ["2026-09-15", 2],
    ["2026-09-14", 1],
  ]);
  assert.equal(collection.days[0].sessions[0].manifest.sessionId, "day-two-b");
});

test("startedAtUtc grouping respects the viewer's local timezone", () => {
  const sessions = [
    { manifest: { sessionId: "late-utc", startedAtUtc: "2026-09-15T23:30:00Z" } },
  ];
  assert.equal(groupTraceSessions(sessions, { timeZone: "UTC" })[0].date, "2026-09-15");
  assert.equal(groupTraceSessions(sessions, { timeZone: "Asia/Shanghai" })[0].date, "2026-09-16");
});

test("ambiguous flat multi-session files are rejected instead of cross-wired", async () => {
  const files = [
    textFile("manifest-a.json", JSON.stringify(traceManifest("a", "2026-09-14T00:00:00Z"))),
    textFile("manifest-b.json", JSON.stringify(traceManifest("b", "2026-09-15T00:00:00Z"))),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:1","pos":[0,0,0],"yaw":0}\n'),
  ];
  await assert.rejects(loadTraceCollection(files), /无法为会话/);
});

test("a single manifest rejects an orphan stream from another directory", async () => {
  const files = [
    textFile("manifest.json", JSON.stringify(traceManifest("only-session", "2026-09-14T00:00:00Z")), "recordings/only-session/manifest.json"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:1","pos":[0,0,0],"yaw":0}\n', "recordings/only-session/stream.ndjson"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:orphan","pos":[9,9,9],"yaw":0}\n', "recordings/orphan/stream.ndjson"),
  ];
  await assert.rejects(loadTraceCollection(files), /无法归属到会话/);
});

test("multiple flat streams require an explicit manifest declaration", async () => {
  const manifestValue = traceManifest("flat-session", "2026-09-14T00:00:00Z");
  await assert.rejects(loadTraceCollection([
    textFile("manifest.json", JSON.stringify(manifestValue)),
    textFile("stream-a.ndjson", '{"type":"sample","t":0,"playerId":"steam:a","pos":[0,0,0],"yaw":0}\n'),
    textFile("stream-b.ndjson", '{"type":"sample","t":0,"playerId":"steam:b","pos":[0,0,0],"yaw":0}\n'),
  ]), /无法为会话/);
});

test("final manifest and stream supersede same-session partial files", async () => {
  const manifestValue = traceManifest("final-wins", "2026-09-14T00:00:00Z");
  const files = [
    textFile("manifest.partial.json", JSON.stringify(manifestValue), "recordings/final-wins/manifest.partial.json"),
    textFile("manifest.json", JSON.stringify({ ...manifestValue, status: "complete" }), "recordings/final-wins/manifest.json"),
    textFile("stream.ndjson.partial", '{"type":"sample","t":0,"playerId":"steam:partial","pos":[8,8,8],"yaw":0}\n', "recordings/final-wins/stream.ndjson.partial"),
    textFile("stream.ndjson", '{"type":"sample","t":0,"playerId":"steam:final","pos":[1,1,1],"yaw":0}\n', "recordings/final-wins/stream.ndjson"),
  ];
  const collection = await loadTraceCollection(files, { timeZone: "UTC" });
  assert.equal(collection.sessions.length, 1);
  assert.equal(collection.sessions[0].manifest.status, "complete");
  assert.equal(collection.sessions[0].tracks.has("steam:final"), true);
  assert.equal(collection.sessions[0].tracks.has("steam:partial"), false);
});

test("append-only history journal reconstructs multiple days and telemetry", async () => {
  const first = traceManifest("journal-one", "2026-09-14T23:00:00Z");
  const second = traceManifest("journal-two", "2026-09-15T01:00:00Z");
  const lines = [
    { type: "session_start", sessionId: "journal-one", manifest: first },
    { type: "trace_record", sessionId: "journal-one", record: { type: "sample", t: 0, playerId: "steam:1", pos: [0, 1, 2], yaw: 0, stamina: 40, maxStamina: 100, extraStamina01: 0.25, item: { id: "rope", name: "Rope", slot: 1 } } },
    { type: "trace_record", sessionId: "journal-one", record: { type: "state", t: 500, playerId: "steam:1", telemetryReady: true, authority: "owner-sync", stamina: 0.6, maxStamina: 0.8, extraStamina: 0.2, maxExtraStamina: 1 } },
    { type: "trace_record", sessionId: "journal-one", record: { type: "inventory", t: 700, playerId: "steam:1", inventoryReady: true, authority: "master-client-rpc-snapshot", selectedSlotKnown: true, selectedSlot: 0, heldPresent: true, held: { itemId: "lantern", prefabName: "Lantern" }, slots: [{ location: "inventory", index: 0, slotId: "hand-0", empty: false, item: { itemId: "lantern", prefabName: "Lantern" } }, { location: "backpack", index: 0, slotId: "pack-0", empty: true, item: null }] } },
    { type: "session_end", sessionId: "journal-one", endedAtUtc: "2026-09-14T23:01:00Z", durationMs: 60000 },
    { type: "session_start", sessionId: "journal-two", manifest: second },
    { type: "trace_record", sessionId: "journal-two", record: { type: "sample", t: 0, playerId: "steam:2", pos: [3, 4, 5], yaw: 0, item: null } },
  ];
  const collection = await loadTraceCollection([
    textFile("PeakTrailHistory.ndjson", lines.map((line) => JSON.stringify(line)).join("\n")),
  ], { timeZone: "UTC" });
  assert.equal(collection.sessions.length, 2);
  assert.equal(collection.days.length, 2);
  const firstTrace = collection.sessions.find((entry) => entry.manifest.sessionId === "journal-one");
  const sample = traceSampleAtTime(firstTrace, "steam:1", 0);
  assert.equal(sample.telemetry.stamina, 40);
  assert.equal(sample.telemetry.extraStamina01, 0.25);
  assert.equal(sample.telemetry.item.name, "Rope");
  assert.equal(tracePlayerStateAtTime(firstTrace, "steam:1", 0.6).telemetry.item.name, "Rope");
  const current = tracePlayerStateAtTime(firstTrace, "steam:1", 0.8);
  assert.equal(current.telemetry.stamina, 0.6);
  assert.equal(current.telemetry.item.name, "Lantern");
  assert.equal(current.inventory.selectedSlot, 0);
  assert.equal(current.inventory.slots[1].location, "backpack");
  assert.equal(firstTrace.duration, 60);
});

test("a renamed history journal is detected from its first envelope", async () => {
  const manifestValue = traceManifest("renamed-history", "2026-09-15T02:00:00Z");
  const lines = [
    { type: "session_start", sessionId: "renamed-history", manifest: manifestValue },
    { type: "trace_record", sessionId: "renamed-history", record: { type: "sample", t: 0, playerId: "steam:renamed", pos: [1, 2, 3], yaw: 0 } },
  ];
  const collection = await loadTraceCollection([
    textFile("my-friends-climb.ndjson", lines.map((line) => JSON.stringify(line)).join("\n")),
  ], { timeZone: "UTC" });
  assert.equal(collection.sessions.length, 1);
  assert.equal(collection.sessions[0].manifest.sessionId, "renamed-history");
});

test("a repeated journal sessionId is preserved as a separate segment", async () => {
  const manifestValue = traceManifest("repeat", "2026-09-15T00:00:00Z");
  const lines = [
    { type: "session_start", sessionId: "repeat", manifest: manifestValue },
    { type: "trace_record", sessionId: "repeat", record: { type: "sample", t: 0, playerId: "steam:first", pos: [0, 0, 0], yaw: 0 } },
    { type: "session_end", sessionId: "repeat", endedAtUtc: "2026-09-15T00:01:00Z", durationMs: 60000, status: "complete", endReason: "scene_exit" },
    { type: "session_start", sessionId: "repeat", manifest: { ...manifestValue, startedAtUtc: "2026-09-15T00:02:00Z" } },
    { type: "trace_record", sessionId: "repeat", record: { type: "sample", t: 0, playerId: "steam:second", pos: [1, 1, 1], yaw: 0 } },
  ];
  const collection = await loadTraceCollection([
    textFile("PeakTrailHistory.ndjson", lines.map((line) => JSON.stringify(line)).join("\n")),
  ], { timeZone: "UTC" });
  assert.deepEqual(collection.sessions.map((entry) => entry.manifest.sessionId).sort(), ["repeat", "repeat#2"]);
  assert.equal(collection.sessions.find((entry) => entry.manifest.sessionId === "repeat").manifest.endReason, "scene_exit");
});

test("older state and inventory snapshots never override a newer enriched sample", async () => {
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(traceManifest("time-order", "2026-09-15T00:00:00Z"))),
    textFile("stream.ndjson", [
      { type: "sample", t: 0, playerId: "steam:p", pos: [0, 0, 0], yaw: 0 },
      { type: "state", t: 1000, playerId: "steam:p", telemetryReady: true, authority: "owner", stamina: 0.9, maxStamina: 1 },
      { type: "inventory", t: 1000, playerId: "steam:p", inventoryReady: true, authority: "host", heldPresent: true, held: { id: "old", name: "Old" }, backpackContentsPresent: true, backpackContentsReady: false, slots: [] },
      { type: "sample", t: 2000, playerId: "steam:p", pos: [2, 0, 0], yaw: 0, telemetryReady: true, stamina: 0.1, maxStamina: 1, item: { id: "new", name: "New" } },
    ].map((line) => JSON.stringify(line)).join("\n")),
  ]);
  const current = tracePlayerStateAtTime(trace, "steam:p", 2);
  assert.equal(current.telemetry.stamina, 0.1);
  assert.equal(current.telemetry.item.name, "New");
  assert.equal(current.inventory.backpackContentsPresent, true);
  assert.equal(current.inventory.backpackContentsReady, false);
});

test("independent state records mark telemetry captured without replacing the sample held item", async () => {
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(traceManifest("independent-state", "2026-09-15T00:00:00Z"))),
    textFile("stream.ndjson", [
      { type: "sample", t: 0, playerId: "steam:p", pos: [0, 0, 0], yaw: 0 },
      { type: "state", t: 1000, playerId: "steam:p", telemetryReady: true, authority: "owner", stamina: 0.6, maxStamina: 1 },
      { type: "sample", t: 1500, playerId: "steam:p", pos: [1, 0, 0], yaw: 0, item: { id: "rope", name: "Rope" } },
      { type: "state", t: 2000, playerId: "steam:p", telemetryReady: true, authority: "owner", stamina: 0.4, maxStamina: 1 },
    ].map((line) => JSON.stringify(line)).join("\n")),
  ]);
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 0).telemetry.captured, false);
  const first = tracePlayerStateAtTime(trace, "steam:p", 1);
  assert.equal(first.telemetry.captured, true);
  assert.equal(first.telemetry.ready, true);
  assert.equal(first.telemetry.authority, "owner");
  assert.equal(first.telemetry.stamina, 0.6);
  const current = tracePlayerStateAtTime(trace, "steam:p", 2);
  assert.equal(current.telemetry.captured, true);
  assert.equal(current.telemetry.stamina, 0.4);
  assert.equal(current.telemetry.item.name, "Rope");
});

test("timestamped appearance snapshots follow playback without inventing pre-record history", async () => {
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(traceManifest("appearance-time", "2026-09-15T00:00:00Z"))),
    textFile("stream.ndjson", [
      { type: "sample", t: 0, playerId: "steam:looks", pos: [0, 0, 0], yaw: 0 },
      { type: "appearance", t: 500, playerId: "steam:looks", appearance: { ready: true, authority: "persistent-player-data-sync", source: "recorded", skinIndex: 2, eyesIndex: 3, mouthIndex: 4, accessoryIndex: 5, outfitIndex: 6, hatIndex: 1, effectiveHatIndex: 8, sashIndex: 2, medalIndex: 1, skinColor: [0.2, 0.4, 0.6, 1], outfitName: "First Fit", hatName: "Forced Hat" } },
      { type: "appearance", t: 1500, playerId: "steam:looks", appearance: { ready: true, authority: "persistent-player-data-sync", source: "recorded", skinIndex: 4, eyesIndex: 5, mouthIndex: 6, accessoryIndex: 7, outfitIndex: 21, hatIndex: 18, effectiveHatIndex: 18, sashIndex: 9, medalIndex: 1, skinColor: [128, 64, 32, 255] } },
      { type: "sample", t: 2000, playerId: "steam:looks", pos: [1, 0, 0], yaw: 0 },
    ].map((line) => JSON.stringify(line)).join("\n")),
  ]);
  assert.equal(tracePlayerStateAtTime(trace, "steam:looks", 0.25).appearance, null);
  const first = tracePlayerStateAtTime(trace, "steam:looks", 1).appearance;
  assert.equal(first.outfitIndex, 6);
  assert.equal(first.effectiveHatIndex, 8);
  assert.equal(first.outfitName, "First Fit");
  const second = tracePlayerStateAtTime(trace, "steam:looks", 2).appearance;
  assert.equal(second.outfitIndex, 21);
  assert.deepEqual(second.skinColor, [128 / 255, 64 / 255, 32 / 255, 1]);
  assert.equal(trace.telemetry.hasAppearance, true);
});

test("life-event lookup is per player, time-ordered and type-filtered", () => {
  // Unsorted input proves the lazy per-player cache sorts before searching; the
  // unrelated event proves non-life records never enter the split.
  const trace = {
    events: [
      { type: "death", t: 9000, playerId: "steam:a" },
      { type: "join", t: 1000, playerId: "steam:a" },
      { type: "revive", t: 12000, playerId: "steam:a" },
      { type: "leave", t: 15000, playerId: "steam:a" },
      { type: "item_acquired", t: 4000, playerId: "steam:a" },
      { type: "death", t: 3000, playerId: "steam:b" },
      { type: "join", t: 2000, playerId: null },
    ],
  };
  assert.equal(latestLifeEventBefore(trace, "steam:a", 500), null);
  assert.equal(latestLifeEventBefore(trace, "steam:a", 9000).type, "death");
  assert.equal(latestLifeEventBefore(trace, "steam:a", 11000).type, "death");
  assert.equal(latestLifeEventBefore(trace, "steam:a", 20000).type, "leave");
  assert.equal(latestLifeEventBefore(trace, "steam:a", 20000, MARKER_LIFE_EVENT_TYPES).type, "revive");
  assert.equal(latestLifeEventBefore(trace, "steam:a", 15000).type, "leave");
  assert.equal(latestLifeEventBefore(trace, "steam:b", 2500), null);
  assert.equal(latestLifeEventBefore(trace, "steam:b", 3000).type, "death");
  assert.equal(latestLifeEventBefore(trace, "steam:missing", 20000), null);
  assert.equal(latestLifeEventBefore(trace, null, 20000), null);
  assert.equal(latestLifeEventBefore(null, "steam:a", 20000), null);
  assert.equal(latestLifeEventBefore(undefined, "steam:a", 20000), null);
  assert.deepEqual([...trace.lifeEventsByPlayer.keys()].sort(), ["steam:a", "steam:b"]);
});

test("tracePlayerStateAtTime resolves life states from the cached per-player life events", async () => {
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(traceManifest("life-events", "2026-09-15T00:00:00Z"))),
    textFile("stream.ndjson", [
      { type: "sample", t: 0, playerId: "steam:p", pos: [0, 0, 0], yaw: 0 },
      { type: "event", event: "join", t: 1000, playerId: "steam:p" },
      { type: "event", event: "death", t: 4000, playerId: "steam:p" },
      { type: "event", event: "revive", t: 8000, playerId: "steam:p" },
      { type: "sample", t: 12000, playerId: "steam:p", pos: [4, 0, 0], yaw: 0 },
      { type: "event", event: "leave", t: 15000, playerId: "steam:p" },
    ].map((line) => JSON.stringify(line)).join("\n")),
  ]);
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 0.5).life, "unknown");
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 2).life, "alive");
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 5).life, "dead");
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 10).life, "alive");
  assert.equal(tracePlayerStateAtTime(trace, "steam:p", 20).life, "absent");
  assert.ok(trace.lifeEventsByPlayer instanceof Map, "the per-player split is cached on the trace");
  assert.deepEqual(trace.lifeEventsByPlayer.get("steam:p").map((event) => event.type),
    ["join", "death", "revive", "leave"]);
});

test("historical trace map selection prefers exact pack identity", () => {
  const exactId = `sha256-${"e".repeat(64)}`;
  const otherId = `sha256-${"f".repeat(64)}`;
  const catalog = {
    schemaVersion: 1,
    activeGameBuildId: "999",
    mapPacks: [
      { mapPackId: otherId, identityVersion: 2, sceneName: "Level_7", mapSlot: 7, gameBuildId: "19492001", path: `./packs/${otherId}/map-pack.json` },
      { mapPackId: exactId, identityVersion: 2, sceneName: "Level_7", mapSlot: 7, gameBuildId: "19492001", path: `./packs/${exactId}/map-pack.json` },
    ],
  };
  assert.equal(selectTraceMapPack(catalog, { ...manifest, mapPackId: exactId })?.mapPackId, exactId);
  assert.equal(selectTraceMapPack(catalog, { ...manifest, mapPackId: `sha256-${"0".repeat(64)}` }), null);
});

test("browser QA fixtures load as a matching two-player replay", async () => {
  const fixture = new URL("./fixtures/", import.meta.url);
  const [mapJson, manifestJson, streamText] = await Promise.all([
    readFile(new URL("qa-map-pack.json", fixture), "utf8"),
    readFile(new URL("qa-manifest.json", fixture), "utf8"),
    readFile(new URL("qa-stream.ndjson", fixture), "utf8"),
  ]);
  const map = await loadMapPackBundle([textFile("map-pack.json", mapJson)]);
  const trace = await loadTraceBundle([
    textFile("manifest.json", manifestJson),
    textFile("stream.ndjson", streamText),
  ]);

  assert.equal(trace.participants.length, 2);
  assert.equal(trace.sampleCount, 18);
  assert.equal(trace.tracks.get("steam:76561198000000001")[0].segment, 0);
  assert.equal(map.layers.length, 1);
  assert.equal(assessCompatibility(trace.manifest, map).compatible, true);
});

test("viewer rejects pre-v2 or non-canonical map-pack identities", async () => {
  const fixture = new URL("./fixtures/map-pack-inline.json", import.meta.url);
  const valid = JSON.parse(await readFile(fixture, "utf8"));
  await assert.rejects(
    loadMapPackBundle([textFile("map-pack.json", JSON.stringify({ ...valid, identityVersion: 1 }))]),
    /地图身份版本/,
  );
  await assert.rejects(
    loadMapPackBundle([textFile("map-pack.json", JSON.stringify({ ...valid, mapPackId: valid.mapPackId.toUpperCase() }))]),
    /mapPackId 格式无效/,
  );
});

test("unsigned textureFlipY cannot reverse an identity-v2 map layer", async () => {
  const fixture = new URL("./fixtures/map-pack-inline.json", import.meta.url);
  const valid = JSON.parse(await readFile(fixture, "utf8"));
  valid.layers[0].textureFlipY = false;
  await assert.rejects(
    loadMapPackBundle([textFile("map-pack.json", JSON.stringify(valid))]),
    /图像方向|textureFlipY/,
  );
});

test("compact smoke fixtures still satisfy the strict projection contract", async () => {
  const fixture = new URL("./fixtures/", import.meta.url);
  const [mapJson, manifestJson, streamText] = await Promise.all([
    readFile(new URL("map-pack-inline.json", fixture), "utf8"),
    readFile(new URL("manifest.json", fixture), "utf8"),
    readFile(new URL("stream.ndjson", fixture), "utf8"),
  ]);
  const map = await loadMapPackBundle([textFile("map-pack.json", mapJson)]);
  const trace = await loadTraceBundle([
    textFile("manifest.json", manifestJson),
    textFile("stream.ndjson", streamText),
  ]);

  assert.equal(assessCompatibility(trace.manifest, map).compatible, true);
  assert.equal(trace.tracks.get("steam:10001")[0].segment, 0);
});

test("legacy keyed players merge with v1 participants", async () => {
  const legacyManifest = {
    ...manifest,
    sessionId: "legacy-merge",
    participants: [],
    players: { "steam:legacy": { nickname: "Legacy Climber", platform: "steam" } },
    timeUnit: "milliseconds",
  };
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(legacyManifest)),
    textFile(
      "stream.ndjson",
      '{"type":"sample","t":0,"playerId":"steam:legacy","pos":[0,0,0],"yaw":0,"segment":0}\n',
    ),
  ]);

  assert.equal(trace.participants[0].id, "steam:legacy");
  assert.equal(trace.participants[0].nickname, "Legacy Climber");
  assert.equal(trace.tracks.get("steam:legacy")[0].segment, null);
  assert.equal(trace.tracks.get("steam:legacy")[0].activeSegment, 0);
  assert.match(trace.warnings.join(" "), /全局 MapHandler/);
});

test("unassigned player layers retain XYZ and explicit global progression", async () => {
  const conservativeManifest = {
    ...manifest,
    sessionId: "unassigned-segments",
    participants: [{ playerId: "steam:careful", nickname: "Careful" }],
    timeUnit: "milliseconds",
    positionAuthority: "xyz",
    segmentResolution: "unassigned",
    activeSegmentSemantics: "global-maphandler-segments-index",
  };
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(conservativeManifest)),
    textFile(
      "stream.ndjson",
      [
        '{"type":"sample","t":0,"playerId":"steam:careful","pos":[1,2,3],"yaw":0,"activeSegment":2}',
        '{"type":"event","event":"segment_change","t":1,"activeSegment":3}',
      ].join("\n"),
    ),
  ]);

  const sample = trace.tracks.get("steam:careful")[0];
  assert.deepEqual(sample.pos, [1, 2, 3]);
  assert.equal(sample.segment, null);
  assert.equal(sample.activeSegment, 2);
  assert.equal(trace.events[0].segment, null);
  assert.equal(trace.events[0].activeSegment, 3);
});

test("only an explicitly position-inferred trace exposes owning layers", async () => {
  const inferredManifest = {
    ...manifest,
    sessionId: "inferred-segments",
    participants: [{ playerId: "steam:inferred", nickname: "Inferred" }],
    timeUnit: "milliseconds",
    segmentResolution: "position-inferred-v1",
  };
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(inferredManifest)),
    textFile(
      "stream.ndjson",
      '{"type":"sample","t":0,"playerId":"steam:inferred","pos":[1,2,3],"yaw":0,"segment":1,"activeSegment":2}\n',
    ),
  ]);

  const sample = trace.tracks.get("steam:inferred")[0];
  assert.equal(sample.segment, 1);
  assert.equal(sample.activeSegment, 2);
});

test("position-inferred layer claims must still be non-negative integers", async () => {
  const inferredManifest = {
    ...manifest,
    sessionId: "invalid-inferred-segment",
    participants: [{ playerId: "steam:invalid", nickname: "Invalid" }],
    timeUnit: "milliseconds",
    segmentResolution: "position-inferred-v1",
  };
  const trace = await loadTraceBundle([
    textFile("manifest.json", JSON.stringify(inferredManifest)),
    textFile(
      "stream.ndjson",
      '{"type":"sample","t":0,"playerId":"steam:invalid","pos":[1,2,3],"yaw":0,"segment":1.5,"activeSegment":2}\n',
    ),
  ]);

  assert.equal(trace.tracks.get("steam:invalid")[0].segment, null);
});
