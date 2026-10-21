import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Only publish explicitly declared, checksummed derivatives. The extraction
// workspace and local player saves must never be swept into a Pages build.
export async function readGameAssets(directory) {
  const root = resolve(directory);
  const files = ["catalog.json"];
  const sourceFiles = new Map([["catalog.json", resolve(root, "catalog.json")]]), buildChecksums = new Map();
  const characterBuilds = new Set();
  const catalog = JSON.parse(await readFile(resolve(root, "catalog.json"), "utf8"));
  assert(catalog.schemaVersion === 1 && Array.isArray(catalog.builds), "Invalid game-assets catalog");
  const builds = new Set();
  for (const entry of catalog.builds) {
    const buildId = String(entry.gameBuildId);
    assert(/^[1-9]\d*$/.test(buildId) && !builds.has(buildId), "Invalid or duplicate game-assets build");
    builds.add(buildId);
    assert(entry.catalog === `${buildId}/catalog.json`, "Unsafe game-assets build catalog path");
    const buildRoot = resolve(root, buildId);
    const catalogBytes = await readFile(resolve(root, entry.catalog));
    const build = JSON.parse(catalogBytes.toString("utf8"));
    buildChecksums.set(buildId, createHash("sha256").update(catalogBytes).digest("hex"));
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
      sourceFiles.set(`${buildId}/${asset.path}`, assetPath);
    }
    const checkReferences = (value) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        // Archived Unity material properties distinguish exported dependencies
        // from provenance such as source.asset = "resources.assets".
        if (key === "sourceProperties" && Array.isArray(child?.textures)) {
          for (const texture of child.textures) if (texture && Object.hasOwn(texture, "asset")) {
            assert(typeof texture.asset === "string" && assets.has(texture.asset),
              `Unlisted archived texture reference: ${texture.asset}`);
          }
        }
        if (["icon", "altIcon", "preview", "texture", "model", "worldModel", "headModel", "thirdEyeModel"].includes(key) && typeof child === "string") {
          assert(assets.has(child), `Unlisted game asset reference: ${child}`);
        } else if (child && typeof child === "object") checkReferences(child);
      }
    };
    checkReferences(build.items);
    checkReferences(build.customization);
    checkReferences(build.worldObjects);
    // A model is not complete just because its JSON checksum is valid: its
    // material textures and decoded face previews must be staged as well.
    for (const asset of build.assets) if (/\.json$/i.test(asset.path)) {
      const model = JSON.parse(await readFile(resolve(buildRoot, asset.path), "utf8"));
      checkReferences(model);
      if (asset.path === build.customization?.avatar?.model && Array.isArray(model?.parts) && model.parts.length > 0)
        characterBuilds.add(buildId);
    }
    for (const reference of Object.values(build.ui || {})) {
      if (typeof reference === "string") assert(assets.has(reference), `Unlisted UI asset: ${reference}`);
    }
    files.push(entry.catalog);
    sourceFiles.set(entry.catalog, resolve(root, entry.catalog));
  }
  return { catalog, files, sourceFiles, buildChecksums, characterBuilds };
}

// The installed asset root stays read-only. Bundled derivatives add exact game
// builds to that root's public catalog without shadowing or replacing old art.
export async function readMergedGameAssets(directory, bundledDirectory) {
  const sources = [await readGameAssets(directory)];
  if (bundledDirectory) {
    const info = await lstat(bundledDirectory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info) {
      assert(info.isDirectory() && !info.isSymbolicLink(), "Invalid bundled game-assets directory");
      sources.push(await readGameAssets(bundledDirectory));
    }
  }
  const entries = new Map(), buildChecksums = new Map(), sourceFiles = new Map(), characterBuilds = new Set();
  for (const source of sources) for (const entry of source.catalog.builds) {
    const buildId = String(entry.gameBuildId), checksum = source.buildChecksums.get(buildId);
    if (entries.has(buildId)) {
      assert(buildChecksums.get(buildId) === checksum, `Conflicting game-assets build: ${buildId}`);
      continue;
    }
    entries.set(buildId, entry); buildChecksums.set(buildId, checksum);
    if (source.characterBuilds.has(buildId)) characterBuilds.add(buildId);
    for (const reference of source.files) if (reference.startsWith(`${buildId}/`))
      sourceFiles.set(reference, source.sourceFiles.get(reference));
  }
  const builds = [...entries.values()].sort((a, b) => String(a.gameBuildId).localeCompare(String(b.gameBuildId), "en", { numeric: true }));
  return { catalog: { schemaVersion: 1, builds }, files: ["catalog.json", ...sourceFiles.keys()], sourceFiles, buildChecksums, characterBuilds };
}

export function requireActiveCharacterAssets(gameAssets, activeGameBuildId) {
  // Synthetic/custom map fixtures may omit activeGameBuildId. A published game
  // rotation that declares one must also ship that exact build's avatar model.
  if (activeGameBuildId == null) return;
  const buildId = String(activeGameBuildId);
  assert(/^[1-9]\d*$/.test(buildId), "Invalid active game-assets build");
  assert(gameAssets.characterBuilds.has(buildId), `Missing character assets for active game build: ${buildId}`);
}

function assert(condition, message) { if (!condition) throw new Error(message); }
