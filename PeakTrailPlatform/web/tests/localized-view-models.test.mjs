import assert from "node:assert/strict";
import test from "node:test";
import { setLocale } from "../src/i18n.js";
import { buildHomeDailyView } from "../src/home-daily.js";
import { classifyRouteSegment, normalizeRoute, resolveReplayRoute, routeSegmentName } from "../src/map-route.js";
import { difficultyLabel, mapCompatibilityNote, mapGroupLabel, normalizeHeatmap, normalizeRoutes } from "../src/route-collection-model.js";

const mapPackId = `sha256-${"a".repeat(64)}`;
const biomes = ["Shore", "Roots", "Alpine", "Swamp", "Swamp"];
const biomeIds = [0, 7, 2, 8, 8];
const route = { authority: "serialized-map-handler", branch: "swamp-temple",
  segments: biomes.map((biome, index) => ({ index, biome, biomeId: biomeIds[index], name: `Source_${index}` })) };
const mapPack = { mapPackId, gameBuildId: "25739797", sceneName: "Level_0", mapSlot: 0, route,
  layers: biomes.map((biome, segment) => ({ id: `segment-${segment}`, segment, biome, name: `Source_${segment}` })) };
const daily = { schemaVersion: 1, versionOkay: true, levelIndex: 483, mapCount: 21, mapSlot: 0,
  sceneName: "Level_0", fetchedAtUtc: "2026-10-18T17:01:00Z", nextChangeAtUtc: "2026-10-19T17:00:00Z" };
const entry = { mapPackId, gameBuildId: "25739797", sceneName: "Level_0", mapSlot: 0, identityVersion: 3,
  enabled: true, path: `./packs/${mapPackId}/map-pack.json` };
const catalog = { schemaVersion: 1, activeGameBuildId: "25739797", mapPacks: [entry] };
const input = { daily, catalog, mapPack, now: Date.parse("2026-10-19T02:00:00Z") };

test("home model switches game chapter names, pending states and explicit display dates without changing map identity", () => {
  const original = JSON.stringify(mapPack);
  const chinese = buildHomeDailyView(input);
  try {
    setLocale("en");
    const english = buildHomeDailyView(input);
    assert.deepEqual(english.cards.map(card => card.title), ["SHORE", "ROOTS", "ALPINE", "GLOOM"]);
    assert.equal(english.cards[3].ending.title, "THE CITADEL");
    assert.equal(english.statusLabel, "Today's five chapters");
    assert.equal(english.destinations[1].title, "NADIR");
    assert.equal(english.destinations[1].actionLabel, "Waiting for the NADIR map");
    assert.equal(english.observedLabel, new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(Date.parse(daily.fetchedAtUtc)));
    assert.equal(english.mapEntry, chinese.mapEntry);
    assert.equal(english.cards[0].layer, chinese.cards[0].layer);
    assert.equal(english.cards[0].sourceName, "Source_0");
    assert.equal(english.mapStatus, chinese.mapStatus);
    assert.equal(english.countdownLabel, chinese.countdownLabel);
    const pending = buildHomeDailyView();
    assert.equal(pending.cards[0].title, "Chapter 1");
    assert.equal(pending.statusLabel, "Waiting for rotation confirmation");
    assert.equal(buildHomeDailyView({ ...input, now: Date.parse(daily.nextChangeAtUtc) }).countdownLabel, "Waiting for the next rotation");
    assert.equal(JSON.stringify(mapPack), original);
  } finally { setLocale("zh-CN"); }
  assert.deepEqual(buildHomeDailyView(input).cards.map(card => card.title), chinese.cards.map(card => card.title));
});

test("translated route descriptions preserve branch identity, source names and mismatched-layer decisions", () => {
  const mapped = normalizeRoute(route);
  const other = { ...route, branch: "volcano-kiln", segments: route.segments.map(entry => entry.index >= 3
    ? { ...entry, biome: "Volcano", biomeId: 3 } : entry) };
  const chinese = resolveReplayRoute(mapPack, { manifest: { route: other } });
  try {
    setLocale("en");
    assert.equal(routeSegmentName(mapped, 3), "GLOOM");
    assert.equal(routeSegmentName(mapped, 4), "THE CITADEL");
    assert.equal(classifyRouteSegment({ biome: "Void", biomeId: 17 }).name, "NADIR");
    const english = resolveReplayRoute(mapPack, { manifest: { route: other } });
    assert.equal(english.label, "CALDERA → THE KILN");
    assert.match(english.message, /Mismatched chapter models hidden/);
    assert.equal(english.key, chinese.key);
    assert.equal(english.source, chinese.source);
    assert.deepEqual([...english.hiddenSegments], [...chinese.hiddenSegments]);
    assert.deepEqual(english.route, chinese.route);
    assert.equal(english.route.segments[0].name, "Source_0");
  } finally { setLocale("zh-CN"); }
});

test("collection labels and validation errors translate while player names and coordinate data stay intact", () => {
  const points = [[0, 1, 2, 3], [100, 4, 5, 6]];
  const name = "玩家 <friend>";
  const group = { map: { scene: "Level_0", buildId: "25739797", levelIndex: 483, route } };
  try {
    setLocale("en");
    assert.equal(mapGroupLabel(group), "Level_0 · Rotation 483 · GLOOM / THE CITADEL · Build 25739797");
    assert.match(mapCompatibilityNote({ mapCompatibility: "matched" }), /Map identity verified/);
    assert.match(mapCompatibilityNote(group), /Waiting for the matching game build/);
    const result = normalizeRoutes({ routes: [{ id: "player-id", name, points }] });
    assert.equal(result.routes[0].name, name);
    assert.equal(result.routes[0].nameMissing, false);
    assert.equal(normalizeRoutes({ routes: [{ id: "empty-name", name: "", points }] }).routes[0].nameMissing, true);
    assert.equal(result.routes[0].id, "player-id");
    assert.equal(result.routes[0].points, points);
    assert.throws(() => normalizeRoutes({ routes: [{ id: "bad", points: [[-1, 1, 2, 3]] }] }), /Invalid path time or coordinates/);
    assert.throws(() => normalizeHeatmap({}), /Invalid heatmap resolution/);
  } finally { setLocale("zh-CN"); }
});

test("difficulty labels use native bilingual terms and structured fields rather than server display copy", () => {
  const difficulty = { key: "a3-c1-m0", ascent: 3, custom: true, mini: false, label: "服务器中文说明" };
  assert.equal(difficultyLabel(difficulty), "天阶 3 · 自定义冒险");
  try {
    setLocale("en");
    assert.equal(difficultyLabel(difficulty), "ASCENT 3 · CUSTOM RUN");
    assert.equal(difficultyLabel("a2-c0-m1"), "ASCENT 2 · Mini");
    assert.equal(difficultyLabel("aunknown-cunknown-munknown"), "Unknown difficulty");
    assert.equal(difficultyLabel({ ascent: 0, custom: false, mini: false }), "Ascent 0");
    assert.equal(difficultyLabel({ ascent: -1, custom: false, mini: false }), "Ascent -1");
    assert.equal(difficultyLabel({ ascent: 9, custom: false, mini: false }), "Ascent 9");
    assert.equal(difficulty.label, "服务器中文说明");
  } finally { setLocale("zh-CN"); }
});
