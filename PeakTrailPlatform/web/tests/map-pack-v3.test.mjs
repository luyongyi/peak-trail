import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { computeMapPackId } from "../../tools/lib/map-pack-identity.mjs";
import { loadMapPackUrl, loadMapPackBundle, selectDailyMapPack, selectTraceMapPack } from "../src/protocol.js";

const vector = JSON.parse(await readFile(new URL("../../schema/test-vectors/map-pack-identity-v2.json", import.meta.url), "utf8"));
function makeV3() {
  const wireVector = JSON.parse(JSON.stringify(vector));
  const manifest = { ...wireVector, identityVersion: 3, layers: wireVector.layers.map((layer) => ({
    ...layer, geometry: `segment-${layer.segment}.glb`, geometrySha256: "a".repeat(64), geometryFormat: "glb-instanced-v1",
  })) };
  manifest.mapPackId = computeMapPackId(manifest);
  return manifest;
}

test("remote v3 verifies identity while deferring every GLB and survey height download", async (t) => {
  const manifest = makeV3();
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    return { ok: true, url: String(url), json: async () => manifest };
  });
  const base = "https://example.test/maps/pack/map-pack.json";
  const pack = await loadMapPackUrl(base);
  assert.deepEqual(requests, [base]);
  assert.equal(pack.identityVersion, 3);
  for (const layer of pack.layers) {
    assert.equal(layer.geometryUrl, new URL(layer.geometry, base).href);
    assert.equal(layer.geometrySha256, "a".repeat(64));
    assert.equal(layer.geometryFormat, "glb-instanced-v1");
    assert.equal(layer.heightData, null);
  }
  manifest.layers[0].geometrySha256 = "b".repeat(64);
  await assert.rejects(loadMapPackUrl(base), /身份校验失败/);
  manifest.identityVersion = 2;
  await assert.rejects(loadMapPackUrl(base), /未签名/);
});

test("local v3 exposes lazy Blob URLs and releases them on disposal", async (t) => {
  const manifest = makeV3();
  const files = [new File([JSON.stringify(manifest)], "map-pack.json", { type: "application/json" })];
  for (const layer of manifest.layers) {
    const geometry = new File(["not read at hydration"], layer.geometry);
    t.mock.method(geometry, "arrayBuffer", () => { throw new Error("must remain lazy"); });
    files.push(geometry, new File(["texture"], layer.texture));
  }
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", (url) => revoked.push(url));
  const pack = await loadMapPackBundle(files);
  assert.ok(pack.layers.every((layer) => layer.geometryUrl.startsWith("blob:")));
  const urls = pack.layers.flatMap((layer) => [layer.geometryUrl, layer.textureUrl]);
  pack.disposeAssets();
  assert.deepEqual(new Set(revoked), new Set(urls));
});

test("gzip v3 preserves its compressed byte identity and lazy geometry URL", async (t) => {
  const manifest = makeV3();
  for (const layer of manifest.layers) {
    layer.geometry += ".gz";
    layer.geometryFormat = "glb-instanced-v1+gzip";
  }
  manifest.mapPackId = computeMapPackId(manifest);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    return { ok: true, url: String(url), json: async () => manifest };
  });
  const base = "https://example.test/maps/pack/map-pack.json";
  const pack = await loadMapPackUrl(base);
  assert.deepEqual(requests, [base]);
  assert.ok(pack.layers.every((layer) => layer.geometryUrl.endsWith(".glb.gz") && layer.geometryFormat === "glb-instanced-v1+gzip"));
  manifest.identityVersion = 2;
  await assert.rejects(loadMapPackUrl(base), /未签名/);
});

test("v3 is preferred over newer v2 metadata but exact historical v2 remains selectable", () => {
  const common = { sceneName: "Level_16", gameBuildId: "25306743", mapSlot: 16, projectionVersion: 1, enabled: true };
  const entry = (version, generatedAtUtc) => {
    const mapPackId = `sha256-${createHash("sha256").update(String(version)).digest("hex")}`;
    return { ...common, identityVersion: version, generatedAtUtc, mapPackId, path: `./packs/${mapPackId}/map-pack.json` };
  };
  const v2 = entry(2, "2027-01-01T00:00:00Z"), v3 = entry(3, "2026-01-01T00:00:00Z");
  const catalog = { schemaVersion: 1, activeGameBuildId: "25306743", mapPacks: [v2, v3] };
  assert.equal(selectDailyMapPack(catalog, common), v3);
  assert.equal(selectTraceMapPack(catalog, common), v3);
  assert.equal(selectTraceMapPack(catalog, { ...common, mapPackId: v2.mapPackId }), v2);
});

test("v2 cannot inject an unsigned geometry URL into the scene", async () => {
  const fixture = JSON.parse(await readFile(new URL("fixtures/map-pack-inline.json", import.meta.url), "utf8"));
  fixture.layers[0].geometryUrl = "https://bad.test/unsigned.glb";
  const pack = await loadMapPackBundle([new File([JSON.stringify(fixture)], "map-pack.json")]);
  assert.equal(pack.layers[0].geometryUrl, null);
  assert.equal(pack.layers[0].geometrySha256, null);
});
