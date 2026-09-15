import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Only publish explicitly declared, checksummed derivatives. The extraction
// workspace and local player saves must never be swept into a Pages build.
export async function readGameAssets(directory) {
  const root = resolve(directory);
  const files = ["catalog.json"];
  const catalog = JSON.parse(await readFile(resolve(root, "catalog.json"), "utf8"));
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.builds), "Invalid game-assets catalog");
  const builds = new Set();
  for (const entry of catalog.builds) {
    const buildId = String(entry.gameBuildId);
    assert(/^[1-9]\d*$/.test(buildId) && !builds.has(buildId), "Invalid or duplicate game-assets build");
    builds.add(buildId);
    assert(entry.catalog === `${buildId}/catalog.json`, "Unsafe game-assets build catalog path");
    const buildRoot = resolve(root, buildId);
    const build = JSON.parse(await readFile(resolve(root, entry.catalog), "utf8"));
    assert(build.schemaVersion === 1 && String(build.gameBuildId) === buildId, "Game-assets build identity mismatch");
    assert(Array.isArray(build.items) && Array.isArray(build.assets), "Game-assets needs items and an explicit assets allowlist");
    const assets = new Set();
    for (const asset of build.assets) {
      assert(typeof asset.path === "string" && /^[a-zA-Z0-9_./-]+\.(png|webp|jpg|jpeg|glb|gltf|bin|json)$/i.test(asset.path), "Unsupported game asset path");
      const assetPath = resolve(buildRoot, asset.path);
      assert(assetPath.startsWith(buildRoot + sep) && !asset.path.split("/").includes(".."), "Game asset escapes build directory");
      assert(!assets.has(asset.path), `Duplicate game asset: ${asset.path}`);
      assets.add(asset.path);
      const bytes = await readFile(assetPath);
      assert(Number.isSafeInteger(asset.bytes) && bytes.length === asset.bytes, `Game asset size mismatch: ${asset.path}`);
      assert(/^[a-f0-9]{64}$/.test(asset.sha256) && createHash("sha256").update(bytes).digest("hex") === asset.sha256, `Game asset hash mismatch: ${asset.path}`);
      files.push(`${buildId}/${asset.path}`);
    }
    const checkReferences = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (["icon", "preview", "texture", "model"].includes(key) && typeof child === "string") {
          assert(assets.has(child), `Unlisted game asset reference: ${child}`);
        } else if (child && typeof child === "object") checkReferences(child);
      }
    };
    checkReferences(build.items);
    checkReferences(build.customization);
    for (const reference of Object.values(build.ui || {})) {
      if (typeof reference === "string") assert(assets.has(reference), `Unlisted UI asset: ${reference}`);
    }
    files.push(entry.catalog);
  }
  return { catalog, files };
}

function assert(condition, message) { if (!condition) throw new Error(message); }
