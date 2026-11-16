import test from "node:test";
import assert from "node:assert/strict";
import { assessCompatibility, selectTraceMapPack } from "../src/protocol.js";

// Metadata checked against the deployed 3.0.1 Level_84 map on 2026-10-29.
const map = Object.freeze({ schemaVersion: 1, identityVersion: 3,
  mapPackId: "sha256-40cadfe2def6bf38ad00452d7c0aec6720591c583b7be64c2852c4c6a1cbf5aa",
  sceneName: "Level_84", mapSlot: 84, gameVersion: "3.0.1--logFile", gameBuildId: "26155610",
  projectionVersion: 1, coordinateSpace: "unity-world-meters", enabled: true,
  path: "./packs/sha256-40cadfe2def6bf38ad00452d7c0aec6720591c583b7be64c2852c4c6a1cbf5aa/map-pack.json" });
const trace = Object.freeze({ ...map, mapPackId: undefined, gameVersion: "3.0.1" });

test("verified 3.0.1 packet traces select the deployed map without mutating signed metadata", () => {
  const before = JSON.stringify(map);
  assert.equal(selectTraceMapPack({ schemaVersion: 1, mapPacks: [map] }, trace), map);
  assert.equal(assessCompatibility(trace, map).compatible, true);
  assert.equal(JSON.stringify(map), before);
  assert.equal(map.gameVersion, "3.0.1--logFile");
  assert.equal(trace.gameVersion, "3.0.1");
});

test("the audited version spelling never relaxes scene, build, projection or unknown version checks", () => {
  for (const fields of [
    { gameBuildId: "26134529" }, { gameBuildId: null }, { projectionVersion: 2 },
    { sceneName: "Level_83" }, { mapSlot: 83 }, { coordinateSpace: "other" },
    { gameVersion: "3.0.2" }, { gameVersion: "3.0.1--logFile-other" },
  ]) assert.equal(assessCompatibility({ ...trace, ...fields }, map).compatible, false, JSON.stringify(fields));
  assert.equal(assessCompatibility({ ...trace, gameBuildId: "26134529" }, { ...map, gameBuildId: "26134529" }).compatible, false);
});

test("verified 3.1 packet traces select their own build while older recordings still select 3.0.1", () => {
  const currentMap = Object.freeze({ ...map, gameBuildId: "26542162", gameVersion: "3.1.0--logFile",
    mapPackId: `sha256-${"b".repeat(64)}`, path: `./packs/sha256-${"b".repeat(64)}/map-pack.json` });
  const currentTrace = Object.freeze({ ...trace, gameBuildId: "26542162", gameVersion: "3.1.0" });
  const before = JSON.stringify(currentMap);
  const catalog = { schemaVersion: 1, activeGameBuildId: "26542162", mapPacks: [map, currentMap] };
  assert.equal(selectTraceMapPack(catalog, currentTrace), currentMap);
  assert.equal(selectTraceMapPack(catalog, trace), map);
  assert.equal(assessCompatibility(currentTrace, currentMap).compatible, true);
  assert.equal(assessCompatibility(trace, map).compatible, true);
  assert.equal(assessCompatibility(currentTrace, map).compatible, false);
  assert.equal(assessCompatibility(trace, currentMap).compatible, false);
  assert.equal(JSON.stringify(currentMap), before);
  for (const fields of [{ gameBuildId: "26155610" }, { gameBuildId: null }, { gameBuildId: "26542163" },
    { gameVersion: "3.1.1" }, { gameVersion: "3.1" }, { gameVersion: "3.1.0--logFile-other" },
    { sceneName: "Level_83" }, { projectionVersion: 2 }])
    assert.equal(assessCompatibility({ ...currentTrace, ...fields }, currentMap).compatible, false, JSON.stringify(fields));
  assert.equal(assessCompatibility({ ...currentTrace, gameBuildId: "26542163" }, { ...currentMap, gameBuildId: "26542163" }).compatible, false);
});
