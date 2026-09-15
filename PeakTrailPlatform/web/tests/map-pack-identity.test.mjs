import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalMapPackIdentity,
  computeMapPackId,
  float32BitsHex,
  verifyMapPackIdentity,
  verifyGeometryGlb,
} from "../../tools/lib/map-pack-identity.mjs";
import { canonicalMapPackIdentity as browserCanonical } from "../src/protocol.js";

const vectorUrl = new URL("../../schema/test-vectors/map-pack-identity-v2.json", import.meta.url);
const vector = JSON.parse(await readFile(vectorUrl, "utf8"));

test("Node matches the shared C#/Node identity v2 vector", () => {
  assert.equal(computeMapPackId(vector), vector.expectedMapPackId);
  assert.equal(float32BitsHex(0.1), "3dcccccd");
  assert.equal(float32BitsHex(-0), "80000000");
});

test("identity v2 is independent of manifest layer order", () => {
  const reversed = { ...vector, layers: [...vector.layers].reverse() };
  assert.equal(canonicalMapPackIdentity(reversed), canonicalMapPackIdentity(vector));
  assert.equal(computeMapPackId(reversed), vector.expectedMapPackId);
});

test("identity verification rejects a formatted but forged mapPackId", () => {
  assert.throws(() => verifyMapPackIdentity(vector), /mapPackId mismatch/);
  const verified = { ...vector, mapPackId: vector.expectedMapPackId };
  assert.equal(verifyMapPackIdentity(verified), vector.expectedMapPackId);
});

function version3() {
  return { ...structuredClone(vector), identityVersion: 3, layers: vector.layers.map((layer, index) => ({
    ...layer, geometry: `segment-${layer.segment}.glb`, geometrySha256: String(index + 1).repeat(64), geometryFormat: "glb-instanced-v1",
  })) };
}

test("browser and Node preserve exact v2 bytes and agree on identity v3", () => {
  assert.equal(browserCanonical(vector), canonicalMapPackIdentity(vector));
  const v3 = version3();
  assert.equal(browserCanonical(v3), canonicalMapPackIdentity(v3));
  assert.equal(computeMapPackId(v3), "sha256-150eda144e00d051b26a45aabde520b9803c2d2f11be3e1d33c541a2fee47842");
  assert.notEqual(computeMapPackId(v3), vector.expectedMapPackId);
  const reversed = { ...v3, layers: [...v3.layers].reverse() };
  assert.equal(computeMapPackId(reversed), computeMapPackId(v3));
});

test("geometry bytes, filename and format cannot escape versioned identity", () => {
  const v3 = version3();
  const original = computeMapPackId(v3);
  v3.layers[0].geometrySha256 = "f".repeat(64);
  assert.notEqual(computeMapPackId(v3), original);
  const beforeRename = computeMapPackId(v3);
  v3.layers[0].geometry = "renamed.glb";
  assert.notEqual(computeMapPackId(v3), beforeRename);
  v3.layers[0].geometryFormat = "arbitrary-gltf";
  assert.throws(() => computeMapPackId(v3), /geometryFormat/);
  for (const field of ["geometry", "geometrySha256", "geometryFormat"]) {
    const unsigned = structuredClone(vector);
    unsigned.layers[0][field] = version3().layers[0][field];
    assert.throws(() => computeMapPackId(unsigned), /unsigned geometry/);
    assert.throws(() => browserCanonical(unsigned), /未签名/);
  }
  for (const path of ["../outside.glb", "/absolute.glb", "https://host/remote.glb", "file.glb?query", "\\\\host\\file.glb"]) {
    const unsafe = version3(); unsafe.layers[0].geometry = path;
    assert.throws(() => computeMapPackId(unsafe), /safe relative/);
  }
});

test("legacy v2 geometry statistics stay metadata and preserve existing map identity", () => {
  const legacy = structuredClone(vector);
  legacy.layers[0].geometry = { renderTriangles: 123, colliderTriangles: 456, rootGameObjects: [1, 2] };
  assert.equal(computeMapPackId(legacy), vector.expectedMapPackId);
  assert.equal(browserCanonical(legacy), canonicalMapPackIdentity(vector));
});

test("gzip geometry uses the same v3 canonical contract and cannot enter unsigned v2", () => {
  const manifest = version3();
  const originalId = computeMapPackId(manifest);
  for (const layer of manifest.layers) {
    layer.geometry += ".gz";
    layer.geometryFormat = "glb-instanced-v1+gzip";
  }
  assert.equal(browserCanonical(manifest), canonicalMapPackIdentity(manifest));
  assert.notEqual(computeMapPackId(manifest), originalId);
  const mismatched = structuredClone(manifest);
  mismatched.layers[0].geometryFormat = "glb-instanced-v1";
  assert.throws(() => computeMapPackId(mismatched), /filename must match/);
  assert.throws(() => browserCanonical(mismatched), /匹配/);
  manifest.identityVersion = 2;
  assert.throws(() => computeMapPackId(manifest), /unsigned geometry/);
  assert.throws(() => browserCanonical(manifest), /未签名/);
});

function glb(document, binary = null) {
  const json = Buffer.from(JSON.stringify(document).padEnd(Math.ceil(Buffer.byteLength(JSON.stringify(document)) / 4) * 4, " "));
  const binaryLength = binary ? Math.ceil(binary.length / 4) * 4 : 0;
  const bytes = Buffer.alloc(20 + json.length + (binary ? 8 + binaryLength : 0));
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  if (binary) {
    bytes.writeUInt32LE(binaryLength, 20 + json.length);
    bytes.writeUInt32LE(0x004e4942, 24 + json.length);
    binary.copy(bytes, 28 + json.length);
  }
  return bytes;
}

test("geometry registration accepts embedded GLB and rejects external or truncated content", () => {
  const valid = glb({ asset: { version: "2.0" }, scenes: [{ nodes: [] }] });
  assert.equal(verifyGeometryGlb(valid).asset.version, "2.0");
  assert.throws(() => verifyGeometryGlb(valid.subarray(0, valid.length - 1)), /complete GLB/);
  assert.throws(() => verifyGeometryGlb(glb({ asset: { version: "2.0" }, images: [{ uri: "remote.png" }] })), /external URIs/);
  assert.throws(() => verifyGeometryGlb(glb({ asset: { version: "2.0" }, buffers: [{ byteLength: 12 }] })), /buffer length/);
});

function compressedDocument() {
  return {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    buffers: [
      { byteLength: 16 },
      { byteLength: 48, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
    bufferViews: [{
      buffer: 1, byteOffset: 0, byteLength: 48,
      extensions: { EXT_meshopt_compression: {
        buffer: 0, byteOffset: 0, byteLength: 16, byteStride: 12, count: 4, mode: "ATTRIBUTES", filter: "NONE",
      } },
    }],
  };
}

test("meshopt GLB supports required decoded placeholder buffers larger than its BIN", () => {
  const document = compressedDocument();
  assert.equal(verifyGeometryGlb(glb(document, Buffer.alloc(16))).buffers[1].byteLength, 48);
  // The fallback marker is optional; no-URI non-BIN buffers still require meshopt.
  delete document.buffers[1].extensions;
  assert.doesNotThrow(() => verifyGeometryGlb(glb(document, Buffer.alloc(16))));
});

test("meshopt GLB still rejects missing fallback declarations and out-of-bounds physical or decoded data", () => {
  const mutations = [
    [(doc) => { doc.extensionsRequired = []; }, /without required/],
    [(doc) => { doc.extensionsUsed = []; }, /without required/],
    [(doc) => { delete doc.bufferViews[0].extensions; }, /fallback buffer without/],
    [(doc) => { doc.buffers[1].byteLength = 47; }, /outside its declared buffer/],
    [(doc) => { doc.bufferViews[0].buffer = 2; }, /outside its declared buffer/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.buffer = 1; }, /compressed range/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.byteOffset = 1; }, /compressed range/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.byteLength = 17; }, /compressed range/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.count = 3; }, /decoded layout/],
    [(doc) => { doc.bufferViews[0].byteStride = 16; }, /decoded layout/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.mode = "UNKNOWN"; }, /decoded layout/],
    [(doc) => { doc.bufferViews[0].extensions.EXT_meshopt_compression.filter = "QUATERNION"; }, /decoded layout/],
    [(doc) => { doc.buffers[1].uri = "external.bin"; }, /external URIs/],
    [(doc) => { doc.images = [{ bufferView: 9, mimeType: "image/png" }]; }, /embedded bufferView/],
  ];
  for (const [mutate, error] of mutations) {
    const document = compressedDocument();
    mutate(document);
    assert.throws(() => verifyGeometryGlb(glb(document, Buffer.alloc(16))), error);
  }
});
