import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const platformSource = resolve(testDirectory, "..", "..");

test("stage reads external assets by allowlist and never copies local recordings", async (t) => {
  const repository = await mkdtemp(resolve(tmpdir(), "peaktrail-stage-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const platform = resolve(repository, "PeakTrailPlatform");
  const tools = resolve(platform, "tools");
  const assets = resolve(repository, "separate-assets");
  const packId = `sha256-${"a".repeat(64)}`;
  const pack = resolve(assets, "maps", "packs", packId);
  const gameAssets = resolve(assets, "game-assets");
  const schemas = [
    "daily-map.schema.json", "map-catalog.schema.json", "map-pack.schema.json",
    "peaktrace-manifest.schema.json", "peaktrace-stream.schema.json", "peaktrace-history.schema.json",
  ];

  await Promise.all([
    mkdir(resolve(tools, "lib"), { recursive: true }),
    mkdir(resolve(platform, "web", "src"), { recursive: true }),
    mkdir(resolve(platform, "vendor"), { recursive: true }),
    mkdir(resolve(platform, "data", "daily"), { recursive: true }),
    mkdir(resolve(platform, "data", "maps"), { recursive: true }),
    mkdir(resolve(platform, "schema"), { recursive: true }),
    mkdir(pack, { recursive: true }),
    mkdir(resolve(gameAssets, "123", "icons"), { recursive: true }),
    mkdir(resolve(repository, "local", "recordings"), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(resolve(platformSource, "tools", "stage-site.mjs"), resolve(tools, "stage-site.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "game-assets.mjs"), resolve(tools, "lib", "game-assets.mjs")),
    copyFile(resolve(platformSource, "tools", "lib", "local-paths.mjs"), resolve(tools, "lib", "local-paths.mjs")),
    writeFile(resolve(platform, "web", "index.html"), "<!doctype html>"),
    writeFile(resolve(platform, "web", "styles.css"), "body{}"),
    writeFile(resolve(platform, "web", "src", "app.js"), "export {};"),
    writeFile(resolve(platform, "vendor", "notice.txt"), "fixture"),
    writeFile(resolve(platform, "data", "daily", "current.json"), "{}"),
    writeFile(resolve(repository, "local", "recordings", "private-session.ndjson"), "private trail"),
  ]);
  await Promise.all(schemas.map((name) => writeFile(resolve(platform, "schema", name), "{}")));

  const texture = Buffer.from("texture");
  const height = Buffer.alloc(16);
  const geometry = Buffer.from("geometry");
  const item = Buffer.from("item icon");
  const manifest = {
    identityVersion: 3,
    mapPackId: packId,
    layers: [{
      texture: "shore.png",
      height: "shore.height.f32",
      geometry: "shore.glb.gz",
    }],
  };
  const buildCatalog = {
    schemaVersion: 1,
    gameBuildId: "123",
    items: [{ itemId: 1, icon: "icons/item.png" }],
    assets: [{ path: "icons/item.png", bytes: item.length, sha256: sha256(item) }],
  };
  await Promise.all([
    writeFile(resolve(platform, "data", "maps", "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      mapPacks: [{ mapPackId: packId, path: `./packs/${packId}/map-pack.json` }],
    })),
    writeFile(resolve(pack, "map-pack.json"), JSON.stringify(manifest)),
    writeFile(resolve(pack, "shore.png"), texture),
    writeFile(resolve(pack, "shore.height.f32"), height),
    writeFile(resolve(pack, "shore.glb.gz"), geometry),
    writeFile(resolve(pack, "private-session.ndjson"), "must not publish"),
    writeFile(resolve(gameAssets, "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      builds: [{ gameBuildId: "123", catalog: "123/catalog.json" }],
    })),
    writeFile(resolve(gameAssets, "123", "catalog.json"), JSON.stringify(buildCatalog)),
    writeFile(resolve(gameAssets, "123", "icons", "item.png"), item),
  ]);

  const options = { env: { ...process.env, PEAK_TRAIL_ASSET_ROOT: assets } };
  await execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options);
  const staged = resolve(platform, "site-dist");
  assert.deepEqual(await readFile(resolve(staged, "data", "maps", "packs", packId, "shore.glb.gz")), geometry);
  assert.deepEqual(await readFile(resolve(staged, "data", "game-assets", "123", "icons", "item.png")), item);
  await assert.rejects(access(resolve(staged, "data", "maps", "packs", packId, "private-session.ndjson")));
  await assert.rejects(access(resolve(staged, "local", "recordings", "private-session.ndjson")));

  await writeFile(resolve(staged, "preflight-marker.txt"), "keep on failure");
  await rm(resolve(pack, "shore.glb.gz"));
  await assert.rejects(
    execFileAsync(process.execPath, [resolve(tools, "stage-site.mjs")], options),
    (error) => /Local map asset is missing:.*PEAK_TRAIL_ASSET_ROOT/s.test(`${error.stderr}\n${error.stdout}`),
  );
  assert.equal(await readFile(resolve(staged, "preflight-marker.txt"), "utf8"), "keep on failure");
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
