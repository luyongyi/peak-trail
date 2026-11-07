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
