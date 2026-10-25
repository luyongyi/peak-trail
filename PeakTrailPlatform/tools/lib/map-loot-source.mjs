import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeMapLoot } from "../../web/src/map-loot.js";
import { readVerifiedMapBuild, readVerifiedMapManifest } from "./verified-map-input.mjs";

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
  return await readNativeMapLootSource(directory, build) || readVerifiedMapLootSource(directory, String(build));
}

async function readNativeMapLootSource(directory, build) {
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

/** A receipt authorizes exactly one reuse hop; source survey checksums remain authoritative. */
async function readVerifiedMapLootSource(directory, build) {
  const verified = await readVerifiedMapBuild(build, { mapsDirectory: directory });
  if (!verified) return null;
  const { plan, proof } = verified;
  const sourceBuild = plan.sourceGameBuildId;
  // Never follow another verified-build entry in place of a native survey.
  const original = await readNativeMapLootSource(directory, sourceBuild);
  if (!original) throw new Error("Verified supply reuse requires a native source survey; chains are unsupported");
  const mappings = new Map(), identities = [];
  if (plan.packs.length > 512) throw new Error("Verified supply survey exceeds map limit");
  for (const entry of plan.packs) {
    const sourceRows = original.raw.maps.filter(row => row.mapPackId === entry.sourceMapPackId);
    const receipts = proof.maps.filter(row => row.sourceMapPackId === entry.sourceMapPackId);
    const source = sourceRows[0], receipt = receipts[0];
    if (sourceRows.length !== 1 || receipts.length !== 1 || source.sceneName !== receipt.sceneName
        || source.mapSlot !== receipt.mapSlot || source.sourceSceneSha256 !== receipt.sourceSceneSha256)
      throw new Error("Verified supply survey source scene identity mismatch");
    mappings.set(entry.mapPackId, { entry, receipt });
    identities.push({ mapPackId: entry.mapPackId, sceneName: source.sceneName, mapSlot: source.mapSlot,
      sourceSceneSha256: source.sourceSceneSha256 });
  }
  return { raw: { ...original.raw, gameBuildId: build, maps: identities }, async readMap(mapPackId) {
    const mapping = mappings.get(mapPackId);
    if (!mapping) return null;
    const manifest = await readVerifiedMapManifest(verified, mapPackId);
    const sourceRaw = await original.readMap(mapping.entry.sourceMapPackId);
    const matches = sourceRaw?.maps?.filter(row => row.mapPackId === mapping.entry.sourceMapPackId) || [];
    const source = matches[0], receipt = mapping.receipt;
    const layers = manifest.layers.map(layer => ({ id: layer.id, segment: layer.segment, geometrySha256: layer.geometrySha256 }));
    if (matches.length !== 1 || source.sceneName !== receipt.sceneName || source.mapSlot !== receipt.mapSlot
        || source.sourceSceneSha256 !== receipt.sourceSceneSha256 || !Array.isArray(source.layers)
        || !isDeepStrictEqual(source.layers.map(layer => ({ id: layer.id, segment: layer.segment, geometrySha256: layer.geometrySha256 })), layers)
        || !Array.isArray(source.markers)) throw new Error("Verified supply survey scene/layer identity mismatch");
    const layerHashes = new Map(layers.map(layer => [layer.id, layer.geometrySha256]));
    for (const marker of source.markers) {
      const observed = marker.source;
      if (!observed || (observed.sourceKind === "serialized-scene-component"
        ? observed.sceneSha256 !== receipt.sourceSceneSha256
        : !hashPattern.test(observed.geometrySha256 || "") || observed.geometrySha256 !== layerHashes.get(marker.layerId)))
        throw new Error("Verified supply marker lacks matching source identity");
    }
    const { maps: _maps, ...header } = sourceRaw;
    const rebound = { ...structuredClone(header), gameBuildId: build,
      maps: [{ ...structuredClone(source), mapPackId }] };
    if (!normalizeMapLoot(rebound, manifest)) throw new Error("Verified supply marker identity does not match the new map");
    return rebound;
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
