import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const platformDirectory = resolve(moduleDirectory, "..", "..");
export const repositoryDirectory = resolve(platformDirectory, "..");

export function resolveLocalAssetPaths(environment = process.env) {
  const configuredRoot = typeof environment?.PEAK_TRAIL_ASSET_ROOT === "string"
    ? environment.PEAK_TRAIL_ASSET_ROOT.trim()
    : "";
  const assetRootDirectory = configuredRoot
    ? resolve(configuredRoot)
    : resolve(repositoryDirectory, "local", "assets");

  return Object.freeze({
    assetRootDirectory,
    mapPacksDirectory: resolve(assetRootDirectory, "maps", "packs"),
    mapEnclosuresDirectory: resolve(assetRootDirectory, "maps", "enclosures"),
    gameAssetsDirectory: resolve(assetRootDirectory, "game-assets"),
    homeArtDirectory: resolve(assetRootDirectory, "home-art"),
  });
}

export const localAssetPaths = resolveLocalAssetPaths();

export function localAssetHint(path) {
  return `${path} (set PEAK_TRAIL_ASSET_ROOT to override the local asset root)`;
}
