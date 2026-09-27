import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMapPeak } from "../src/map-peak.js";

const pack = { gameBuildId: "25306743", mapPackId: "sha256-pack", sceneName: "Level_1", mapSlot: 1,
  source: { sceneSha256: "scene-abc" },
  layers: [{ segment: 4, biome: "Swamp", geometrySha256: "abc" }] };
const evidence = { schemaVersion: 1, authority: "serialized-peak-handler", gameBuildId: "25306743",
  mapPackId: "sha256-pack", sceneName: "Level_1", mapSlot: 1, segment: 4, biome: "Swamp",
  sourceSceneSha256: "scene-abc",
  geometrySha256: "abc", rootGameObject: 22, gateGameObject: 33, peakHandler: 44,
  bounds: { min: [-10, 0, 20], max: [10, 100, 80] },
  collisionBounds: { min: [-8, 5, 25], max: [8, 95, 75] } };

test("serialized PeakHandler evidence binds exact source, pack and terminal geometry", () => {
  assert.deepEqual(normalizeMapPeak(evidence, pack)?.collisionBounds, evidence.collisionBounds);
  for (const value of [
    { ...evidence, authority: "object-name-guess" },
    { ...evidence, mapPackId: "other" },
    { ...evidence, sourceSceneSha256: "wrong" },
    { ...evidence, geometrySha256: "wrong" },
    { ...evidence, segment: 3 },
    { ...evidence, rootGameObject: 0 },
    { ...evidence, collisionBounds: { min: [-20, 5, 25], max: [8, 95, 75] } },
  ]) assert.equal(normalizeMapPeak(value, pack), null);
});
