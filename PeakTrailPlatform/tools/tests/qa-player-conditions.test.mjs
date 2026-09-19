import assert from "node:assert/strict";
import test from "node:test";
import { createPlayerConditionsFixture, validatePlayerConditionsFixture, QA_PLAYER_ID } from "../qa-player-conditions.mjs";

function fixtureInputs() {
  return { pack: { sceneName: "Level_17", gameVersion: "2.4.c", gameBuildId: 25306743, mapSlot: 17,
    mapPackId: `sha256-${"a".repeat(64)}`, projectionVersion: 1 }, route: { branch: "swamp-temple", authority: "qa-fixture", segments: [
    { index: 0, biome: "Shore", biomeId: 0, name: "Beach_Segment" },
    { index: 3, biome: "Swamp", biomeId: 8, name: "Swamp_Segment" },
    { index: 4, biome: "Swamp", biomeId: 8, name: "Temple_Segment" }] }, anchor: [1, 2, 3],
  customization: { skins: [{ index: 1, name: "QA skin", color: [0.9, 0.5, 0.2, 1] }],
    eyes: [{ index: 5 }], mouths: [{ index: 12 }], accessories: [{ index: 0 }], sashes: [{ index: 0 }], medals: [{ index: 0 }],
    fits: [{ index: 0, name: "QA fit", overrideHat: false }], hats: [{ index: 18, name: "QA Crown", model: "qa-crown.json" }],
    forms: [{ form: "skeleton", headModel: "qa-skull.json", source: { meshName: "QA skeleton", materialName: "QA bone material" } }] } };
}

test("synthetic status/form schedule survives actual parser, rewind and capacity normalization", async () => {
  const fixture = createPlayerConditionsFixture(fixtureInputs());
  const validated = await validatePlayerConditionsFixture(fixture);
  assert.equal(validated.trace.sampleCount, 161);
  assert.equal(validated.trace.participants[0].id, QA_PLAYER_ID);
  assert.match(validated.trace.participants[0].nickname, /SYNTHETIC.*非实录/);
  assert.equal(validated.trace.worldTimeline.captured, false);
});

test("fixture uses only public supplied cosmetics, stable synthetic identity and clearly marked events", () => {
  const fixture = createPlayerConditionsFixture(fixtureInputs());
  assert.equal(fixture.cosmeticSelection.effectiveHatIndex, 18);
  assert.ok(fixture.records.filter((entry) => entry.type === "event").every((entry) => entry.label.startsWith("合成测试")));
  assert.ok(fixture.records.filter((entry) => entry.type === "sample").every((entry) => entry.segment === 0 && entry.playerId === QA_PLAYER_ID));
  assert.deepEqual(fixture, createPlayerConditionsFixture(fixtureInputs()));
  assert.ok(fixture.records.every((entry, index, entries) => index === 0 || entry.t >= entries[index - 1].t));
});

test("partial form snapshots never invent cosmetic index zero while effects have independent boundaries", () => {
  const fixture = createPlayerConditionsFixture(fixtureInputs());
  const partial = fixture.records.find((entry) => entry.type === "appearance" && entry.t === 27000).appearance;
  assert.equal(partial.formReady, true); assert.equal(partial.ready, false);
  for (const [name, value] of Object.entries(partial)) if (name.endsWith("Index")) assert.equal(value, null);
  const statusTimes = fixture.records.filter((entry) => entry.type === "status").map((entry) => entry.t);
  assert.ok(statusTimes.includes(7000) && statusTimes.includes(18000));
  assert.equal(fixture.records.some((entry) => entry.type === "appearance" && [7000, 18000].includes(entry.t)), false);
});
