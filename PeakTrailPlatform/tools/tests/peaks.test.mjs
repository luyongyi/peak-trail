import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeMapPeak } from "../../web/src/map-peak.js";

const mapsDirectory = new URL("../../data/maps/", import.meta.url);
const catalog = JSON.parse(await readFile(new URL("catalog.json", mapsDirectory), "utf8"));
const evidence = JSON.parse(await readFile(new URL("peaks.25306743.json", mapsDirectory), "utf8"));

test("every build map has one public source-bound PeakHandler evidence row", () => {
  const entries = catalog.mapPacks.filter(entry => String(entry.gameBuildId) === evidence.gameBuildId);
  assert.equal(evidence.authority, "serialized-peak-handler");
  assert.equal(evidence.maps.length, entries.length);
  assert.equal(new Set(evidence.maps.map(value => value.mapPackId)).size, entries.length);
  for (const entry of entries) {
    const value = evidence.maps.find(candidate => candidate.mapPackId === entry.mapPackId);
    assert.ok(value, entry.sceneName);
    assert.equal(value.sceneName, entry.sceneName);
    assert.equal(value.mapSlot, entry.mapSlot);
    assert.match(value.sourceSceneSha256, /^[a-f0-9]{64}$/);
    assert.match(value.geometrySha256, /^[a-f0-9]{64}$/);
    assert.match(value.rootName, /^Peak(?:_Kiln Variant)?$/);
    assert.equal(value.gateGameObject === null, value.rootName === "Peak_Kiln Variant");
    assert.ok(value.statistics.renderers > 0 && value.statistics.meshColliders > 0);
  }
});

test("PeakHandler evidence matches locally provisioned canonical terminal geometry", async t => {
  const entries = catalog.mapPacks.filter(entry => String(entry.gameBuildId) === evidence.gameBuildId);
  const firstPack = new URL(`../../../local/assets/maps/packs/${entries[0].mapPackId}/map-pack.json`, import.meta.url);
  try { await access(firstPack); } catch { t.skip("canonical game assets are provisioned only for staging and local audits"); return; }
  for (const entry of entries) {
    const pack = JSON.parse(await readFile(new URL(`../../../local/assets/maps/packs/${entry.mapPackId}/map-pack.json`, import.meta.url), "utf8"));
    const matches = evidence.maps.filter(value => value.mapPackId === entry.mapPackId);
    assert.equal(matches.length, 1, entry.sceneName);
    const value = normalizeMapPeak({ ...matches[0], schemaVersion: evidence.schemaVersion,
      authority: evidence.authority, gameBuildId: evidence.gameBuildId }, pack);
    assert.ok(value, entry.sceneName);
    assert.equal(value.sourceSceneSha256, pack.source.sceneSha256);
    assert.match(value.rootName, /^Peak(?:_Kiln Variant)?$/);
    assert.equal(value.gateGameObject === null, value.rootName === "Peak_Kiln Variant");
    assert.ok(value.statistics.renderers > 0 && value.statistics.meshColliders > 0);
  }
});
