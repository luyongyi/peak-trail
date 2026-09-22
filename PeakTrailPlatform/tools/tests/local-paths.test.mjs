import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  repositoryDirectory,
  resolveLocalAssetPaths,
} from "../lib/local-paths.mjs";

test("local assets default to the ignored repository-local asset root", () => {
  const paths = resolveLocalAssetPaths({});
  assert.equal(paths.assetRootDirectory, resolve(repositoryDirectory, "local", "assets"));
  assert.equal(paths.mapPacksDirectory, resolve(repositoryDirectory, "local", "assets", "maps", "packs"));
  assert.equal(paths.gameAssetsDirectory, resolve(repositoryDirectory, "local", "assets", "game-assets"));
  assert.equal(paths.homeArtDirectory, resolve(repositoryDirectory, "local", "assets", "home-art"));
});

test("PEAK_TRAIL_ASSET_ROOT relocates every large-asset reader together", () => {
  const override = resolve(repositoryDirectory, "test-local-assets");
  const paths = resolveLocalAssetPaths({ PEAK_TRAIL_ASSET_ROOT: `  ${override}  ` });
  assert.equal(paths.assetRootDirectory, override);
  assert.equal(paths.mapPacksDirectory, resolve(override, "maps", "packs"));
  assert.equal(paths.gameAssetsDirectory, resolve(override, "game-assets"));
  assert.equal(paths.homeArtDirectory, resolve(override, "home-art"));
});
