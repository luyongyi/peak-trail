import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { headAppearanceFingerprint } from "../src/avatar-renderer.js";
import { routeAtTime, routeSegmentName } from "../src/map-route.js";
import { loadTraceCollection, tracePlayerStateAtTime } from "../src/protocol.js";

const fixtureName = "qa-route-head-history.ndjson";
const fixtureUrl = new URL(`./fixtures/${fixtureName}`, import.meta.url);
const players = ["qa:route-alpha", "qa:route-beta"];
const assetIdentity = {
  gameBuildId: "25306743",
  catalogUrl: new URL("https://qa.invalid/data/game-assets/25306743/catalog.json"),
};

async function loadFixture() {
  const contents = await readFile(fixtureUrl, "utf8");
  return loadTraceCollection([{ name: fixtureName, text: async () => contents }], { timeZone: "UTC" });
}

test("browser route/head fixture splits into two synthetic days with mutually exclusive ending pairs", async () => {
  const collection = await loadFixture();
  assert.equal(collection.sessions.length, 2);
  assert.equal(collection.days.length, 2);
  const byScene = new Map(collection.sessions.map((trace) => [trace.manifest.sceneName, trace]));
  for (const [scene, branch, labels] of [
    ["Level_16", "volcano-kiln", ["火山", "熔炉"]],
    ["Level_1", "swamp-temple", ["雾岛", "城塞"]],
  ]) {
    const trace = byScene.get(scene);
    assert.ok(trace);
    assert.equal(String(trace.manifest.gameBuildId), "25306743");
    assert.equal(trace.manifest.route.branch, branch);
    assert.equal(trace.routeTracks.length, 1);
    assert.equal(trace.routeTracks[0].t, 0);
    const route = routeAtTime(trace, 0);
    assert.equal(route.branch, branch);
    assert.equal(route.authority, "maphandler-resolved-biomes");
    assert.deepEqual([3, 4].map((index) => routeSegmentName(route, index)), labels);
    assert.deepEqual([...trace.tracks.keys()].sort(), players);
    for (const playerId of players) {
      assert.deepEqual(trace.tracks.get(playerId).map((sample) => sample.t), [0, 2, 12, 20]);
    }
  }
});

test("synthetic heads remain unknown before sync and rewind from the later crown to the original cap", async () => {
  const { sessions } = await loadFixture();
  for (const trace of sessions) {
    const appearanceAt = (playerId, time) => tracePlayerStateAtTime(trace, playerId, time).appearance;
    for (const playerId of players) {
      assert.equal(appearanceAt(playerId, 0), null);
      assert.equal(appearanceAt(playerId, 1.999), null);
      assert.equal(appearanceAt(playerId, 2).authority, "qa-fixture-not-gameplay");
    }
    const first = appearanceAt(players[0], 2);
    const later = appearanceAt(players[0], 12);
    const thirdEye = appearanceAt(players[1], 12);
    assert.deepEqual([first.skinIndex, first.eyesIndex, first.mouthIndex, first.outfitIndex, first.effectiveHatIndex], [2, 0, 0, 0, 0]);
    assert.deepEqual([later.skinIndex, later.eyesIndex, later.mouthIndex, later.accessoryIndex, later.effectiveHatIndex], [4, 5, 12, 5, 18]);
    assert.deepEqual([thirdEye.skinIndex, thirdEye.eyesIndex, thirdEye.mouthIndex, thirdEye.accessoryIndex, thirdEye.effectiveHatIndex], [1, 0, 0, 20, 18]);
    assert.notEqual(headAppearanceFingerprint(assetIdentity, first), headAppearanceFingerprint(assetIdentity, later));
    assert.notEqual(headAppearanceFingerprint(assetIdentity, later), headAppearanceFingerprint(assetIdentity, thirdEye));
    assert.equal(headAppearanceFingerprint(assetIdentity, appearanceAt(players[0], 11.999)), headAppearanceFingerprint(assetIdentity, first));
    assert.equal(appearanceAt(players[0], 1), null, "Backwards scrubbing must not leak a future portrait.");
  }
});
