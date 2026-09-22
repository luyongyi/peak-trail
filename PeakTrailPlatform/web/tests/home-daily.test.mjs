import assert from "node:assert/strict";
import test from "node:test";
import { buildHomeDailyView } from "../src/home-daily.js";

const packId = `sha256-${"a".repeat(64)}`;
const build = "25306743";
const start = "2026-09-21T17:01:00.000Z";
const end = "2026-09-22T17:00:00.000Z";
const daily = {
  schemaVersion: 1, versionOkay: true, levelIndex: 465, mapCount: 21, mapSlot: 3,
  sceneName: "Level_3", fetchedAtUtc: start, nextChangeAtUtc: end,
};
const entry = {
  mapPackId: packId, identityVersion: 3, sceneName: "Level_3", mapSlot: 3, gameBuildId: build,
  path: `./packs/${packId}/map-pack.json`, enabled: true,
};
const catalog = { schemaVersion: 1, activeGameBuildId: build, mapPacks: [entry] };
function mapPack(branch = "swamp-temple") {
  const biomes = ["Shore", "Roots", "Alpine", ...(branch === "swamp-temple" ? ["Swamp", "Swamp"] : ["Volcano", "Volcano"])];
  const biomeIds = { Shore: 0, Roots: 7, Alpine: 2, Swamp: 8, Volcano: 3 };
  return {
    mapPackId: packId, sceneName: "Level_3", gameBuildId: Number(build), mapSlot: 3,
    route: {
      authority: "serialized-map-handler", branch,
      segments: biomes.map((biome, index) => ({ index, biome, biomeId: biomeIds[biome], name: `${biome}_Segment` })),
    },
    layers: biomes.map((biome, segment) => ({ id: `segment-${segment}`, segment, biome, name: biome, textureUrl: `https://example.invalid/${segment}.png` })),
  };
}
function view(overrides = {}) {
  return buildHomeDailyView({ daily, catalog, mapPack: mapPack(), now: Date.parse("2026-09-22T02:00:00.000Z"), ...overrides });
}

test("current observation exposes four real chapter cards and the paired Citadel finale", () => {
  const result = view();
  assert.equal(result.freshness, "current");
  assert.equal(result.statusLabel, "今日四关");
  assert.equal(result.mapStatus, "ready");
  assert.deepEqual(result.cards.map((card) => card.title), ["海岸", "森蕈", "雪山", "雾岛"]);
  assert.equal(result.cards[3].ending.title, "城塞");
  assert.equal(result.cards[3].ending.segment, 4);
  assert.equal(result.cards[3].ending.branch, "swamp-temple");
  assert.equal(result.mapEntry, entry);
  assert.equal(result.cards[0].layerId, "segment-0");
  assert.equal(result.countdownLabel, "15:00:00");
});

test("Furnace is the Volcano finale, never a fifth main home card", () => {
  const result = view({ mapPack: mapPack("volcano-kiln") });
  assert.equal(result.cards.length, 4);
  assert.equal(result.cards[3].title, "火山");
  assert.equal(result.cards[3].ending.title, "熔炉");
  assert.equal(result.cards[3].ending.branch, "volcano-kiln");
});

test("expired observation preserves a clearly labelled archive, not today's route", () => {
  const result = view({ now: Date.parse(end) + 86400000 });
  assert.equal(result.freshness, "stale");
  assert.equal(result.isCurrent, false);
  assert.equal(result.statusLabel, "上次确认的四关");
  assert.equal(result.sceneName, "Level_3");
  assert.equal(result.cards[3].title, "雾岛");
  assert.equal(result.remainingSeconds, null);
  assert.equal(result.countdownLabel, "等待新一轮确认");
});

test("the exact rotation deadline expires without advancing the slot", () => {
  assert.equal(view({ now: Date.parse(end) - 1 }).remainingSeconds, 1);
  assert.equal(view({ now: Date.parse(end) }).freshness, "stale");
  assert.equal(view({ now: Date.parse(end) }).mapSlot, 3);
  assert.equal(view({ now: Date.parse(end) + 40 * 86400000 }).mapSlot, 3);
});

test("observation dates and deadline use the explicit display timezone across midnight", () => {
  const result = view({ now: new Date("2026-09-21T17:01:01.000Z") });
  assert.equal(result.observedLabel, "2026/09/22 01:01");
  assert.equal(result.rotationLabel, "2026/09/23 01:00");
  assert.equal(result.countdownLabel, "23:58:59");
  assert.match(view({ timeZone: "not-a-time-zone" }).observedLabel, /UTC$/);
});

test("no daily data never promotes the catalog or an already open replay to today", () => {
  const result = view({ daily: null });
  assert.equal(result.freshness, "unavailable");
  assert.equal(result.mapStatus, "waiting-observation");
  assert.equal(result.sceneName, null);
  assert.equal(result.mapEntry, null);
  assert.equal(result.cards.length, 4);
  assert.ok(result.cards.every((card) => !card.available && !card.layer && !card.ending));
});

test("no exact active build never borrows a same-slot map from another build", () => {
  for (const activeGameBuildId of [null, "", "0", "999"]) {
    const result = view({ catalog: { ...catalog, activeGameBuildId } });
    assert.equal(result.freshness, "current");
    assert.equal(result.mapStatus, "missing-build");
    assert.equal(result.mapEntry, null);
    assert.ok(result.cards.every((card) => !card.available));
  }
});

test("missing or malformed catalogs remain a non-throwing data state", () => {
  for (const bad of [null, {}, { schemaVersion: 2, mapPacks: [] }, { ...catalog, mapPacks: [] }]) {
    assert.equal(view({ catalog: bad }).mapStatus, "missing-build");
  }
});

test("selected catalog entry can be fetched separately from a pending map", () => {
  const result = view({ mapPack: null });
  assert.equal(result.mapStatus, "waiting-pack");
  assert.equal(result.mapEntry, entry);
  assert.ok(result.cards.every((card) => !card.available));
});

test("loaded map identity must bind mapPackId, build, scene and slot together", () => {
  for (const mutation of [
    { mapPackId: `sha256-${"b".repeat(64)}` }, { gameBuildId: "999" }, { sceneName: "Level_4" },
    { mapSlot: 4 }, { mapSlot: null }, { mapSlot: "3" }, { layers: null },
  ]) {
    const result = view({ mapPack: { ...mapPack(), ...mutation } });
    assert.equal(result.mapStatus, "identity-mismatch");
    assert.ok(result.cards.every((card) => !card.available));
  }
});

test("invalid observations and rejected API versions cannot count down or reveal chapter claims", () => {
  for (const mutation of [
    { versionOkay: false }, { schemaVersion: 2 }, { levelIndex: 464 }, { mapCount: 0 }, { mapSlot: -1 },
    { mapSlot: "3" }, { sceneName: "Level_4" }, { fetchedAtUtc: null }, { fetchedAtUtc: "invalid" },
    { nextChangeAtUtc: "invalid" }, { fetchedAtUtc: "2026-09-23T00:00:00Z" },
    { nextChangeAtUtc: "2026-09-21T00:00:00Z" },
  ]) {
    const result = view({ daily: { ...daily, ...mutation } });
    assert.equal(result.freshness, "unavailable", JSON.stringify(mutation));
    assert.equal(result.remainingSeconds, null);
    assert.equal(result.mapEntry, null);
    assert.ok(result.cards.every((card) => !card.available));
  }
  assert.equal(view({ now: NaN }).freshness, "unavailable");
});

test("contradictory or missing branch evidence does not invent either mutually exclusive finale", () => {
  const pack = mapPack();
  for (const route of [null, { ...pack.route, branch: "volcano-kiln" }, { ...pack.route, branch: "unknown" }]) {
    const result = view({ mapPack: { ...pack, route } });
    assert.equal(result.mapStatus, "route-unconfirmed");
    assert.ok(result.cards.slice(0, 3).every((card) => card.available));
    assert.equal(result.cards[3].available, false);
    assert.equal(result.cards[3].ending, null);
    assert.equal(result.cards[3].title, "第四关 · 分支待确认");
  }
});

test("route and rendered layer must agree on both halves of an ending pair", () => {
  for (const segment of [3, 4]) {
    const pack = mapPack();
    pack.layers[segment].biome = "Volcano";
    assert.equal(view({ mapPack: pack }).cards[3].available, false);
  }
  const pack = mapPack();
  pack.layers.pop();
  assert.equal(view({ mapPack: pack }).cards[3].ending, null);
});

test("duplicate chapter assignments are not resolved by iteration order", () => {
  const pack = mapPack();
  pack.layers.push({ ...pack.layers[1], id: "duplicate" });
  const result = view({ mapPack: pack });
  assert.equal(result.cards[1].available, false);
  assert.equal(result.cards[0].available, true);
});

test("unknown source biome uses its real source name without calling it another familiar biome", () => {
  const pack = mapPack();
  pack.layers[1] = { ...pack.layers[1], biome: "FutureBiome", name: "Future source chapter" };
  const result = view({ mapPack: pack });
  assert.equal(result.cards[1].title, "Future source chapter");
  assert.equal(result.cards[1].theme, "unknown");
});

test("home metadata does not mutate daily, catalog, pack, or route", () => {
  const inputs = { daily, catalog, mapPack: mapPack(), now: Date.parse(start) + 1 };
  const before = JSON.stringify(inputs);
  buildHomeDailyView(inputs);
  assert.equal(JSON.stringify(inputs), before);
});
