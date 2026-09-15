import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { computeMapPackId, validateLayerGeometry, verifyGeometryGlb } from "./lib/map-pack-identity.mjs";

const platform = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const buildFolder = args[0] && resolve(args[0]);
const single = args.indexOf("--slot");
const slot = single < 0 ? null : Number(args[single + 1]);
const replace = args.includes("--replace-build");
if (!buildFolder || (slot !== null && (!Number.isInteger(slot) || slot < 0 || slot > 20))
    || (replace && slot !== null)) {
  throw new Error("Usage: node tools/finalize-offline-maps.mjs <build-folder> [--slot 16 | --replace-build]");
}
const slots = slot === null ? Array.from({ length: 21 }, (_, index) => index) : [slot];
const completed = [];
// Preflight every source manifest before changing the published catalog.
for (const current of slots) {
  const folder = resolve(buildFolder, `Level_${current}`);
  const manifest = JSON.parse(await readFile(resolve(folder, "map-pack.json"), "utf8"));
  if (manifest.identityVersion !== 3 || manifest.sceneName !== `Level_${current}`
      || manifest.mapSlot !== current || manifest.layers?.length !== 6
      || manifest.layers.some((layer) => !["glb-instanced-v1", "glb-instanced-v1+gzip"].includes(layer.geometryFormat))) {
    throw new Error(`Incomplete original-mesh pack: ${folder}`);
  }
  for (const layer of manifest.layers) validateLayerGeometry(layer, 3);
  completed.push({ folder, manifest });
}
const builds = new Set(completed.map(({ manifest }) => String(manifest.gameBuildId)));
if (builds.size !== 1) throw new Error("All packs must come from the same game build");
const catalogPath = resolve(platform, "data/maps/catalog.json");
const backupDir = resolve(platform, "../local/archives/catalog-history");
await mkdir(backupDir, { recursive: true });
const backupPath = resolve(backupDir, `catalog-${Date.now()}-${process.pid}.json`);
await copyFile(catalogPath, backupPath);
for (const { folder, manifest } of completed) {
  for (const layer of manifest.layers) {
    if (layer.geometryFormat === "glb-instanced-v1+gzip") continue;
    const source = await readFile(resolve(folder, layer.geometry));
    if (createHash("sha256").update(source).digest("hex") !== layer.geometrySha256) {
      throw new Error(`Original geometry SHA-256 mismatch: ${folder}/${layer.geometry}`);
    }
    verifyGeometryGlb(source, `${manifest.sceneName}/${layer.geometry}`);
    const compressed = gzipSync(source, { level: 9 });
    if (!gunzipSync(compressed).equals(source)) throw new Error("Lossless geometry gzip roundtrip failed");
    // Retain original GLBs in the working directory. Only the signed gzip
    // derivatives are registered/published, with no loss of source geometry.
    layer.geometry += ".gz";
    layer.geometryFormat = "glb-instanced-v1+gzip";
    layer.geometrySha256 = createHash("sha256").update(compressed).digest("hex");
    await writeFile(resolve(folder, layer.geometry), compressed);
  }
  manifest.mapPackId = computeMapPackId(manifest);
  await writeFile(resolve(folder, "map-pack.json"), JSON.stringify(manifest, null, 2) + "\n");
  const registration = spawnSync(process.execPath,
    [resolve(platform, "tools/register-map-pack.mjs"), folder, "--activate-build"], { stdio: "inherit" });
  if (registration.status !== 0) throw new Error(`Registration failed; original catalog retained at ${backupPath}`);
}
if (replace) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const build = [...builds][0];
  const ids = new Set(completed.map(({ manifest }) => manifest.mapPackId));
  const previousCount = catalog.mapPacks.length;
  catalog.mapPacks = catalog.mapPacks.filter((entry) => String(entry.gameBuildId) !== build || ids.has(entry.mapPackId));
  const temporary = resolve(platform, `data/maps/.catalog-finalize-${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify(catalog, null, 2) + "\n");
  await rename(temporary, catalogPath);
  console.log(`Replaced ${previousCount - catalog.mapPacks.length} obsolete catalog entries; no map files deleted.`);
}
console.log(`Finalized ${completed.length} original-mesh map packs. Catalog backup: ${backupPath}`);
