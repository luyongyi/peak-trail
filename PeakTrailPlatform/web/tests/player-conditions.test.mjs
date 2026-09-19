import assert from "node:assert/strict";
import test from "node:test";
import { normalizePlayerStatus, staminaLayout, conditionSummary, appearanceFormPresentation } from "../src/player-conditions.js";
import { loadTraceBundle, tracePlayerStateAtTime } from "../src/protocol.js";

const value = (type, id, amount, extra = 0) => ({ type, id, amount, staminaBlock: extra ? 0 : amount, extraStaminaBlock: extra });
function status(overrides = {}) {
  return { ready: true, complete: true, authority: "synthetic", source: "recorded", dead: false,
    values: [value("Cold", 2, .2), value("Curse", 5, .1), value("Petrify", 13, .4, .4)],
    statusSum: .3, baseMaxStamina: 1, maxStamina: .7, baseMaxExtraStamina: 1, maxExtraStamina: .6,
    effectsReady: true, effectsAuthority: "synthetic", effects: [{ type: "InfiniteStamina", typeId: 1 }], ...overrides };
}
function normalized(overrides) { return normalizePlayerStatus({ status: status(overrides) }); }
const file = (name, body) => ({ name, text: async () => body });
async function trace(records) {
  return loadTraceBundle([file("manifest.json", JSON.stringify({ schemaVersion: 1, sessionId: "SYNTHETIC-CONDITIONS",
    sceneName: "Level_17", gameBuildId: "25306743", timeUnit: "milliseconds", coordinateSpace: "unity-world-meters" })),
  file("stream.ndjson", [{ type: "sample", t: 0, playerId: "qa", pos: [0, 0, 0] }, ...records].map((r) => JSON.stringify(r)).join("\n"))]);
}

test("cold and curse occupy absolute normal capacity; petrify occupies only extra capacity", () => {
  const s = normalized();
  const telemetry = { stamina: .35, maxStamina: .7, stamina01: .5, extraStamina: .3, maxExtraStamina: .6, extraStamina01: .5 };
  const normal = staminaLayout(telemetry, s), extra = staminaLayout(telemetry, s, true);
  assert.equal(normal.ratio, .35); assert.equal(normal.output, "35%"); assert.equal(normal.capText, "上限 70%");
  assert.deepEqual(normal.blocks.map((b) => b.type), ["Cold", "Curse"]);
  assert.equal(extra.ratio, .3); assert.equal(extra.capacity, .6); assert.deepEqual(extra.blocks.map((b) => b.type), ["Petrify"]);
});

test("legacy limits remain visible without inventing affliction types or healthy status", () => {
  const layout = staminaLayout({ stamina: .4, maxStamina: .5, stamina01: .8 }, null);
  assert.equal(layout.output, "40%"); assert.equal(layout.blocked, .5); assert.deepEqual(layout.blocks, []);
  assert.match(conditionSummary(null), /未记录状态种类/);
  assert.equal(appearanceFormPresentation({ captured: true, ready: true }).known, false);
});

test("capacity unknown can retain observed current stamina but cannot manufacture a full cap", () => {
  const layout = staminaLayout({ ready: true, capacityReady: false, baseMaxStamina: 1, stamina: .4, maxStamina: 1 }, null);
  assert.equal(layout.ratio, .4); assert.equal(layout.capacity, null); assert.equal(layout.capText, "上限未知");
  assert.equal(staminaLayout({ stamina: .3 }, null).ratio, .3);
  assert.equal(staminaLayout({ ready: false, stamina: .3 }, null).output, "同步中");
  const independent = { ready: true, capacityReady: false, stamina: .4, extraStamina: .3, maxExtraStamina: .6 };
  assert.equal(staminaLayout(independent, null, true).capacity, .6);
  assert.deepEqual(staminaLayout(independent, normalized()).blocks, []);
});

test("unready snapshots clear prior afflictions and never treat default zeros as health", () => {
  const result = normalized({ ready: false, effectsReady: false });
  assert.deepEqual(result.values, []); assert.deepEqual(result.effects, []); assert.equal(result.maxStamina, null);
  assert.match(conditionSummary(result), /未就绪/);
  assert.equal(normalizePlayerStatus({}), null);
});

test("invalid/duplicate entries make a snapshot partial; future enum names remain readable", () => {
  const result = normalized({ values: [value("Cold", 2, .2), value("Cold", 2, .4), value("Modded", 50, .1), value("Poison", 3, -1)] });
  assert.equal(result.complete, false); assert.deepEqual(result.values.map((v) => v.type), ["Cold", "Modded"]);
  const empty = normalized({ values: [], complete: false });
  assert.match(conditionSummary(empty), /不完整/);
});

test("status snapshots are independent, replace fully, rewind, and extend duration", async () => {
  const data = await trace([
    { type: "state", t: 0, playerId: "qa", telemetryReady: true, stamina: .4, maxStamina: 1 },
    { type: "status", t: 1000, playerId: "qa", status: status() },
    { type: "status", t: 2000, playerId: "qa", status: status({ values: [], statusSum: 0, maxStamina: 1, maxExtraStamina: 1, effects: [] }) },
    { type: "status", t: 3000, playerId: "qa", status: status({ ready: false, effectsReady: false }) },
  ]);
  assert.equal(data.duration, 3); assert.equal(data.telemetry.hasStatus, true);
  assert.equal(tracePlayerStateAtTime(data, "qa", .5).status, null);
  assert.equal(tracePlayerStateAtTime(data, "qa", 1.5).telemetry.maxStamina, .7);
  assert.equal(tracePlayerStateAtTime(data, "qa", 2.5).status.values.length, 0);
  assert.equal(tracePlayerStateAtTime(data, "qa", 3).status.ready, false);
  assert.equal(tracePlayerStateAtTime(data, "qa", 3).telemetry.capacityReady, false);
  assert.equal(tracePlayerStateAtTime(data, "qa", 3).telemetry.maxStamina, null);
  assert.equal(tracePlayerStateAtTime(data, "qa", 1.5).status.values[0].type, "Cold");
});

test("a newer stamina packet losing status readiness clears old caps but not current stamina", async () => {
  const data = await trace([
    { type: "sample", t: 1000, playerId: "qa", pos: [1, 0, 0], stamina: .8, maxStamina: 1 },
    { type: "status", t: 1000, playerId: "qa", status: status() },
    { type: "state", t: 2000, playerId: "qa", telemetryReady: true, capacityReady: false, baseMaxStamina: 1, stamina: .4, extraStamina: .3, maxExtraStamina: .6 },
  ]);
  const current = tracePlayerStateAtTime(data, "qa", 2);
  assert.equal(current.telemetry.stamina, .4); assert.equal(current.telemetry.maxStamina, null);
  assert.equal(staminaLayout(current.telemetry, current.status).capacity, null);
  assert.equal(staminaLayout(current.telemetry, current.status, true).capacity, .6);
});

test("form changes follow observed snapshots rather than item possession, with unknown clearing", async () => {
  const data = await trace([
    { type: "appearance", t: 0, playerId: "qa", appearance: { ready: true, formReady: true, form: "normal" } },
    { type: "inventory", t: 500, playerId: "qa", inventoryReady: true, heldPresent: true, held: { name: "Book of Bones" }, slots: [] },
    { type: "appearance", t: 1000, playerId: "qa", appearance: { ready: false, formReady: true, form: "skeleton", formMeshName: "Skeleton", skinIndex: null } },
    { type: "appearance", t: 2000, playerId: "qa", appearance: { ready: true, formReady: true, form: "normal" } },
    { type: "appearance", t: 3000, playerId: "qa", appearance: { ready: true, formReady: false, form: "skeleton" } },
  ]);
  assert.equal(tracePlayerStateAtTime(data, "qa", .75).appearance.form, "normal");
  const bone = tracePlayerStateAtTime(data, "qa", 1.5).appearance;
  assert.equal(bone.form, "skeleton"); assert.equal(bone.skinIndex, null); assert.equal(bone.ready, false);
  assert.equal(appearanceFormPresentation(bone).transformed, true);
  assert.equal(tracePlayerStateAtTime(data, "qa", 2.5).appearance.form, "normal");
  assert.equal(tracePlayerStateAtTime(data, "qa", 3).appearance.form, "unknown");
  assert.equal(tracePlayerStateAtTime(data, "qa", 1).appearance.form, "skeleton");
});
