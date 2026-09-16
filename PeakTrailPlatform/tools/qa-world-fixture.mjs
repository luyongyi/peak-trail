// Generates explicitly synthetic replay input, never reads personal recordings.
// The ignored output stays outside site-dist and must be imported manually.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { localAssetPaths, platformDirectory, repositoryDirectory } from "./lib/local-paths.mjs";
import { loadTraceBundle } from "../web/src/protocol.js";

const catalog = JSON.parse(await readFile(resolve(platformDirectory, "data/maps/catalog.json"), "utf8"));
const entry = catalog.mapPacks.find((candidate) => candidate.sceneName === "Level_17" && candidate.enabled !== false);
if (!entry) throw new Error("QA fixture needs the existing Level_17 map metadata");
const packDirectory = resolve(localAssetPaths.mapPacksDirectory, entry.mapPackId);
const pack = JSON.parse(await readFile(resolve(packDirectory, "map-pack.json"), "utf8"));
const routeEvidence = JSON.parse(await readFile(resolve(platformDirectory, `data/maps/routes.${pack.gameBuildId}.json`), "utf8"));
const route = routeEvidence.maps.find((candidate) => candidate.mapPackId === pack.mapPackId)?.route;
if (!route) throw new Error("QA fixture needs resolved route evidence for Level_17");

async function surveyAnchor(layer) {
  if (!layer) throw new Error("QA fixture requires Roots and Swamp chapters");
  const height = await readFile(resolve(packDirectory, layer.height));
  let best = null;
  for (let row = 0; row < layer.rows; row++) for (let col = 0; col < layer.columns; col++) {
    const y = height.readFloatLE((row * layer.columns + col) * 4);
    if (!Number.isFinite(y)) continue;
    const distance = (col - layer.columns / 2) ** 2 + (row - layer.rows / 2) ** 2;
    if (!best || distance < best.distance) best = { distance, pos: [
      layer.minX + (col + 0.5) / layer.columns * (layer.maxX - layer.minX), y + 0.8,
      layer.minZ + (row + 0.5) / layer.rows * (layer.maxZ - layer.minZ),
    ] };
  }
  if (!best) throw new Error(`No static survey reference for ${layer.id}`);
  return best.pos;
}

const roots = await surveyAnchor(pack.layers.find((layer) => layer.biome === "Roots"));
const swamp = await surveyAnchor(pack.layers.find((layer) => layer.segment === 3 && layer.biome === "Swamp"));
const offset = (pos, x, y, z) => pos.map((value, axis) => value + [x, y, z][axis]);
const sessionId = "SYNTHETIC-WORLD-QA-LEVEL17";
const playerId = "qa:synthetic-world-not-gameplay";
const manifest = { schemaVersion: 1, sessionId, sceneName: pack.sceneName,
  gameVersion: pack.gameVersion, gameBuildId: String(pack.gameBuildId), mapSlot: pack.mapSlot,
  mapPackId: pack.mapPackId, projectionVersion: pack.projectionVersion,
  coordinateSpace: "unity-world-meters", timeUnit: "milliseconds", sampleHz: 4,
  positionAuthority: "synthetic-qa-static-map-survey-reference", segmentResolution: "position-inferred-v1",
  recordingPurpose: "SYNTHETIC WORLD QA · 合成测试，不是玩家实录", recorderVersion: "0.6.0-qa",
  startedAtUtc: "2026-09-16T00:00:00Z", durationMs: 30000, route,
  participants: [{ id: playerId, nickname: "SYNTHETIC-WORLD-QA（非实录）", platform: "QA fixture" }] };
const world = (objectId, kind, pos, fields = {}) => ({ objectId, kind, pos, rot: [0, 0, 0, 1],
  scale: [1, 1, 1], active: true, source: "synthetic-world-qa-not-gameplay", ...fields });
const item = world("qa:mushroom", "item", offset(roots, 2, 0, 2),
  { prefabName: "Mushroom Chubby", itemId: "83", activity: "held" });
const mine = world("qa:mine", "mine", offset(roots, -4, 0, 4),
  { prefabName: "Jungle_SporeMushroom", activity: "armed", radius: 4, warningRadius: 10 });
const zombie = world("qa:zombie", "zombie", offset(roots, 0, 0, 25),
  { prefabName: "MushroomZombie", activity: "dormant", activationRadius: 12, warningRadius: 32 });
const placed = world("qa:placed", "placed_object", offset(roots, 5, 0, 3),
  { prefabName: "BounceShroomSpawn", activity: "placed" });
const fog = world("qa:fog", "sleep_fog", offset(swamp, 0, 2, 8),
  { prefabName: "SYNTHETIC_SLEEP_FOG_VOLUME", activity: "emitting", shape: "box", radius: 12, size: [24, 6, 24], warningRadius: 18 });
const safeZone = world("qa:safe-light", "fog_safe_zone", offset(swamp, 0, 1, 5),
  { prefabName: "SYNTHETIC_SAFE_LIGHT", activity: "lit", shape: "sphere", radius: 3 });
const records = [
  { type: "route", t: 0, route },
  { type: "world_snapshot", t: 0, complete: true, objects: [item, mine, zombie] },
  { type: "world_delta", t: 5000, upserts: [{ ...item, activity: "dropped" }], removed: [] },
  { type: "world_event", t: 5000, event: "world_spawn", ...item, activity: "dropped" },
  { type: "world_delta", t: 8000, upserts: [placed], removed: [] },
  { type: "world_delta", t: 12000, upserts: [{ ...zombie, activity: "chasing", pos: offset(roots, 0, 0, 12) }], removed: [] },
  { type: "world_event", t: 12000, event: "zombie_activated", ...zombie, activity: "chasing" },
  { type: "world_event", t: 15000, event: "mine_explosion", ...mine, activity: "exploded" },
  { type: "world_delta", t: 15000, upserts: [{ ...mine, active: false, activity: "exploded" }], removed: [] },
  { type: "world_snapshot", t: 20000, complete: true, objects: [fog] },
  { type: "event", t: 20000, event: "warp", playerId, pos: swamp, source: "synthetic-qa-chapter-switch" },
  { type: "world_event", t: 20000, event: "fog_activated", ...fog },
  { type: "world_delta", t: 22000, upserts: [safeZone], removed: [] },
  { type: "world_snapshot", t: 28000, complete: true, objects: [] },
];
for (let t = 0; t <= 30000; t += 250) {
  const anchor = t < 20000 ? roots : swamp;
  records.push({ type: "sample", t, playerId, pos: offset(anchor, Math.sin(t / 3000) * 1.5, 0, 0), yaw: 0,
    segment: t < 20000 ? 1 : 3, activeSegment: t < 20000 ? 1 : 3 });
}
records.sort((a, b) => a.t - b.t);
const stream = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const contents = JSON.stringify(manifest, null, 2) + "\n";
const decoded = await loadTraceBundle([{ name: "manifest.json", text: async () => contents }, { name: "stream.ndjson", text: async () => stream }]);
if (decoded.duration !== 30 || !decoded.worldTimeline.captured) throw new Error("Generated QA fixture failed protocol verification");
const outputDirectory = resolve(repositoryDirectory, "local/verification/world-qa");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "manifest.json"), contents);
await writeFile(resolve(outputDirectory, "stream.ndjson"), stream);
console.log(JSON.stringify({ outputDirectory, purpose: manifest.recordingPurpose, duration: decoded.duration,
  sampleCount: decoded.sampleCount, rootsAnchor: roots, swampAnchor: swamp,
  checks: ["Roots 0s: held mushroom hidden, zombie warning at 25m", "Roots 5s: dropped mushroom appears",
    "Roots 8s: placed bounce mushroom", "Roots 12s: zombie activated", "Roots 15–18s: explosion ring",
    "Swamp 20–28s: sleep fog", "22s: lit safe zone cuts fog", "28s: complete empty snapshot removes fog", "Scrub back: no future objects"] }, null, 2));
