import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { requirePublishedCharacterAssets, MARKER_ONLY_PLAYER_PUBLICATION } from "../lib/player-visualization.mjs";

const mapsDirectory = fileURLToPath(new URL("../../data/maps/", import.meta.url));
const catalog = JSON.parse(await readFile(new URL("../../data/maps/catalog.json", import.meta.url)));
const noCharacters = { characterBuilds: new Set() };

test("only the complete pinned 3.1 map publication can omit its character models", async () => {
  assert.deepEqual(catalog.playerVisualization, MARKER_ONLY_PLAYER_PUBLICATION);
  await requirePublishedCharacterAssets(noCharacters, catalog, { mapsDirectory });
});

test("ordinary active builds still require their own character resources", async () => {
  await assert.rejects(requirePublishedCharacterAssets(noCharacters, { activeGameBuildId: "26542162" }, { mapsDirectory }), /Missing character assets/);
  await assert.rejects(requirePublishedCharacterAssets(noCharacters, { activeGameBuildId: "26155610" }, { mapsDirectory }), /Missing character assets/);
  await requirePublishedCharacterAssets({ characterBuilds: new Set(["26155610"]) }, { activeGameBuildId: "26155610" }, { mapsDirectory });
});

for (const [name, mutate] of [
  ["unknown build", value => { value.activeGameBuildId = "99999999"; }],
  ["different receipt", value => { value.playerVisualization.receiptSha256 = "0".repeat(64); }],
  ["different declaration build", value => { value.playerVisualization.gameBuildId = "26155610"; }],
  ["extra declaration fields", value => { value.playerVisualization.aliasBuild = "26155610"; }],
  ["unreviewed mode", value => { value.playerVisualization.mode = "legacy-model"; }],
  ["missing target map", value => { const i = value.mapPacks.findIndex(entry => String(entry.gameBuildId) === "26542162"); value.mapPacks.splice(i, 1); }],
  ["duplicate target map", value => { const row = value.mapPacks.find(entry => String(entry.gameBuildId) === "26542162"); value.mapPacks.push(structuredClone(row)); }],
  ["target scene changed", value => { value.mapPacks.find(entry => String(entry.gameBuildId) === "26542162").sceneName = "Level_999"; }],
  ["target version changed", value => { value.mapPacks.find(entry => String(entry.gameBuildId) === "26542162").gameVersion = "3.2.0"; }],
  ["target disabled", value => { value.mapPacks.find(entry => String(entry.gameBuildId) === "26542162").enabled = false; }],
]) test(`marker-only publication refuses ${name}`, async () => {
  const value = structuredClone(catalog); mutate(value);
  await assert.rejects(requirePublishedCharacterAssets(noCharacters, value, { mapsDirectory }), /Player visualization:/);
});
