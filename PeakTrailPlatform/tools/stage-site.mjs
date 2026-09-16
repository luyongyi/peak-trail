import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readGameAssets } from "./lib/game-assets.mjs";
import { localAssetHint, localAssetPaths } from "./lib/local-paths.mjs";

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const platformDirectory = resolve(toolDirectory, "..");
const webDirectory = resolve(platformDirectory, "web");
const dataDirectory = resolve(platformDirectory, "data");
const mapsDirectory = resolve(dataDirectory, "maps");
const schemaDirectory = resolve(platformDirectory, "schema");
const outputDirectory = resolve(platformDirectory, "site-dist");
const { gameAssetsDirectory, mapPacksDirectory } = localAssetPaths;
// Fail before replacing the running preview if an extraction is incomplete.
let gameAssets;
try {
  gameAssets = await readGameAssets(gameAssetsDirectory);
} catch (error) {
  throw new Error(`Local game assets are missing or invalid at ${localAssetHint(gameAssetsDirectory)}: ${error.message}`);
}
const publishedSchemas = [
  "daily-map.schema.json",
  "map-catalog.schema.json",
  "map-pack.schema.json",
  "peaktrace-manifest.schema.json",
  "peaktrace-stream.schema.json",
  "peaktrace-history.schema.json",
  "peaktrace-route.schema.json",
];

const catalog = JSON.parse(await readFile(resolve(mapsDirectory, "catalog.json"), "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks)) {
  throw new Error("Cannot stage an invalid map catalog");
}
const mapPacks = [];
for (const entry of catalog.mapPacks) {
  const mapPackId = String(entry?.mapPackId || "").toLowerCase();
  const expectedPath = `./packs/${mapPackId}/map-pack.json`;
  if (!/^sha256-[a-f0-9]{64}$/.test(mapPackId) || entry.path !== expectedPath) {
    throw new Error(`Cannot stage unsafe map catalog path: ${entry?.path}`);
  }
  const sourceDirectory = resolve(mapPacksDirectory, mapPackId);
  const { files, manifest } = await readMapPackAllowlist(sourceDirectory, mapPackId);
  const route = await verifiedRouteMetadata(manifest);
  mapPacks.push({ mapPackId, sourceDirectory, files, manifest, route });
}

// site-dist is generated exclusively by this script and is safe to recreate.
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await mkdir(resolve(outputDirectory, "data", "maps"), { recursive: true });
await mkdir(resolve(outputDirectory, "schema"), { recursive: true });
await Promise.all([
  cp(resolve(webDirectory, "index.html"), resolve(outputDirectory, "index.html")),
  cp(resolve(webDirectory, "styles.css"), resolve(outputDirectory, "styles.css")),
  cp(resolve(webDirectory, "src"), resolve(outputDirectory, "src"), { recursive: true }),
  cp(resolve(platformDirectory, "vendor"), resolve(outputDirectory, "vendor"), { recursive: true }),
  cp(resolve(dataDirectory, "daily"), resolve(outputDirectory, "data", "daily"), { recursive: true }),
  cp(resolve(mapsDirectory, "catalog.json"), resolve(outputDirectory, "data", "maps", "catalog.json")),
  ...publishedSchemas.map((name) => cp(
    resolve(schemaDirectory, name),
    resolve(outputDirectory, "schema", name),
  )),
]);

for (const pack of mapPacks) {
  for (const reference of pack.files) {
    const destination = resolve(outputDirectory, "data", "maps", "packs", pack.mapPackId, reference);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(pack.sourceDirectory, reference), destination);
  }
  // Route evidence is additive metadata and is not part of geometry identity.
  // Original canonical packs remain untouched; only the generated site is enriched.
  if (pack.route) await writeFile(
    resolve(outputDirectory, "data", "maps", "packs", pack.mapPackId, "map-pack.json"),
    JSON.stringify({ ...pack.manifest, route: pack.route }, null, 2) + "\n",
  );
}
for (const reference of gameAssets.files) {
  const destination = resolve(outputDirectory, "data", "game-assets", reference);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(gameAssetsDirectory, reference), destination);
}
await writeFile(resolve(outputDirectory, ".nojekyll"), "", "utf8");

let totalBytes = 0;
let fileCount = 0;
async function measure(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await measure(path);
    else if (entry.isFile()) { totalBytes += (await stat(path)).size; fileCount++; }
  }
}
await measure(outputDirectory);
if (totalBytes > 1_000_000_000) {
  throw new Error(`Staged site is ${totalBytes} bytes, above the conservative GitHub Pages 1 GB budget. Reduce published pack versions without altering geometry.`);
}
console.log(`Staged GitHub Pages site at ${outputDirectory}`);
console.log(`${fileCount} files, ${(totalBytes / 1_000_000).toFixed(1)} MB; ${catalog.mapPacks.length} map packs. No private recordings are staged.`);

async function readMapPackAllowlist(directory, expectedMapPackId) {
  const manifestPath = resolve(directory, "map-pack.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Local map pack ${expectedMapPackId} is missing or invalid at ${localAssetHint(manifestPath)}: ${error.message}`);
  }
  if (manifest?.mapPackId !== expectedMapPackId || !Array.isArray(manifest.layers) || manifest.layers.length === 0) {
    throw new Error(`Local map pack manifest does not match catalog entry ${expectedMapPackId}: ${manifestPath}`);
  }

  const files = new Set(["map-pack.json"]);
  for (const [layerIndex, layer] of manifest.layers.entries()) {
    const fields = ["texture", "height"];
    if (manifest.identityVersion === 3) fields.push("geometry");
    for (const field of fields) {
      const reference = layer?.[field];
      assertSafeRelativePath(reference, `${expectedMapPackId} layer ${layerIndex} ${field}`);
      files.add(reference);
    }
  }

  for (const reference of files) {
    const source = resolve(directory, reference);
    if (source !== manifestPath && !source.startsWith(directory + sep)) {
      throw new Error(`Map asset escapes local pack ${expectedMapPackId}: ${reference}`);
    }
    let entry;
    try {
      entry = await lstat(source);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Local map asset is missing: ${localAssetHint(source)}`);
      }
      throw error;
    }
    if (!entry.isFile()) throw new Error(`Local map asset must be a regular file: ${source}`);
  }
  return { files: [...files], manifest };
}

async function verifiedRouteMetadata(manifest) {
  const build = String(manifest.gameBuildId || "");
  if (!/^\d+$/.test(build)) return null;
  let evidence;
  try {
    evidence = JSON.parse(await readFile(resolve(mapsDirectory, `routes.${build}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (evidence.schemaVersion !== 1 || String(evidence.gameBuildId) !== build || !Array.isArray(evidence.maps)) {
    throw new Error(`Invalid route evidence for build ${build}`);
  }
  const entries = evidence.maps.filter((entry) => entry.mapPackId === manifest.mapPackId);
  if (!entries.length) return null;
  const entry = entries[0];
  if (entries.length !== 1 || entry.sceneName !== manifest.sceneName || entry.mapSlot !== manifest.mapSlot
      || entry.sourceSceneSha256 !== manifest.source?.sceneSha256 || !Array.isArray(entry.route?.segments)
      || !["volcano-kiln", "swamp-temple"].includes(entry.route.branch)) throw new Error("Route evidence identity mismatch");
  for (const segment of entry.route.segments) {
    if (!manifest.layers.some((layer) => layer.segment === segment.index && layer.biome === segment.biome)) {
      throw new Error(`Route evidence disagrees with geometry: ${manifest.sceneName}, segment ${segment.index}`);
    }
  }
  return entry.route;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value)
      || /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[a-z]+:/i.test(value)) {
    throw new Error(`${label} is not a safe relative path`);
  }
}
