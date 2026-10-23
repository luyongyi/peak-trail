import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeMapLoot } from "../../web/src/map-loot.js";

const hashPattern = /^[a-f0-9]{64}$/;
const packPattern = /^sha256-[a-f0-9]{64}$/;

async function readSurvey(path, limit) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("Map supply survey must be a regular file");
  if (file.size > limit) throw new Error("Map supply survey exceeds size limit");
  const body = await readFile(path);
  if (body.length > limit) throw new Error("Map supply survey exceeds size limit");
  return { raw: JSON.parse(body.toString("utf8")), body };
}

/** Legacy surveys and independently verified per-map chunks share one reader. */
export async function readMapLootSource(directory, build) {
  if (!/^[1-9]\d{0,19}$/.test(String(build))) throw new Error("Invalid supply survey build");
  let root;
  try { root = await readSurvey(resolve(directory, `loot.${build}.json`), 96 * 1024 * 1024); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { raw } = root;
  if (raw.schemaVersion !== 1 || String(raw.gameBuildId) !== String(build)
      || !Array.isArray(raw.maps) || raw.maps.length > 512) throw new Error("Invalid supply survey identity");
  if (raw.kind !== "map-loot-index") return { raw, async readMap() { return raw; } };
  const entries = new Map();
  for (const entry of raw.maps) {
    const path = `loot/${build}/${entry?.mapPackId}.json`;
    if (!packPattern.test(entry?.mapPackId || "") || entries.has(entry.mapPackId) || entry.path !== path
        || !hashPattern.test(entry.sha256 || "") || !Number.isSafeInteger(entry.size)
        || entry.size < 1 || entry.size > 24 * 1024 * 1024) throw new Error("Invalid supply survey chunk reference");
    entries.set(entry.mapPackId, entry);
  }
  return { raw, async readMap(mapPackId) {
    const entry = entries.get(mapPackId);
    if (!entry) return null;
    // Only validated, generated paths are read; raw index paths are never resolved.
    const chunk = await readSurvey(resolve(directory, "loot", String(build), `${mapPackId}.json`), 24 * 1024 * 1024);
    if (chunk.body.length !== entry.size || createHash("sha256").update(chunk.body).digest("hex") !== entry.sha256)
      throw new Error(`Supply survey chunk checksum mismatch: ${mapPackId}`);
    const map = chunk.raw.maps?.[0];
    if (chunk.raw.schemaVersion !== 1 || String(chunk.raw.gameBuildId) !== String(build)
        || chunk.raw.maps?.length !== 1 || map?.mapPackId !== mapPackId
        || map.sceneName !== entry.sceneName || map.mapSlot !== entry.mapSlot
        || map.sourceSceneSha256 !== entry.sourceSceneSha256) throw new Error(`Supply survey chunk identity mismatch: ${mapPackId}`);
    return chunk.raw;
  } };
}

export async function publicMapLootChunk(surveySource, manifest) {
  const raw = await surveySource.readMap(manifest.mapPackId);
  const normalized = normalizeMapLoot(raw, manifest);
  if (!normalized) throw new Error(`Map supply survey does not match ${manifest.mapPackId}`);
  const original = raw.maps.find(entry => entry.mapPackId === manifest.mapPackId);
  const source = {};
  for (const key of ["kind", "anchor", "positions", "chestCoverage", "itemCoverage", "animalCoverage", "componentCoverage", "excluded"]) {
    const value = surveySource.raw.source?.[key];
    if (typeof value === "string" && value.length <= 4096) source[key] = value;
  }
  const entry = { mapPackId: normalized.mapPackId, sceneName: normalized.sceneName, mapSlot: manifest.mapSlot,
    sourceSceneSha256: normalized.sourceSceneSha256,
    ...(original.layers ? { layers: original.layers.map(layer => ({ id: layer.id, segment: layer.segment, geometrySha256: layer.geometrySha256 })) } : {}),
    markers: normalized.markers };
  const build = String(manifest.gameBuildId), path = `loot/${build}/${manifest.mapPackId}.json`;
  const body = JSON.stringify({ schemaVersion: 1, gameBuildId: build, types: normalized.types,
    ...(Object.keys(source).length ? { source } : {}), maps: [entry] }) + "\n";
  if (Buffer.byteLength(body, "utf8") > 24 * 1024 * 1024) throw new Error(`Map supply map payload exceeds size limit: ${manifest.mapPackId}`);
  return { path, body, sha256: createHash("sha256").update(body).digest("hex"), entry: {
    mapPackId: entry.mapPackId, sceneName: entry.sceneName, mapSlot: entry.mapSlot,
    sourceSceneSha256: entry.sourceSceneSha256, path,
  } };
}
