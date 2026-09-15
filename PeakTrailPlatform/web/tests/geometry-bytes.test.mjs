import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { decodeGeometryBytes, MAX_GEOMETRY_BYTES } from "../src/geometry-bytes.js";
import { verifyGeometryGlb, MAX_GEOMETRY_BYTES as NODE_LIMIT } from "../../tools/lib/map-pack-identity.mjs";

const FORMAT = "glb-instanced-v1+gzip";
function glb(document = { asset: { version: "2.0" }, scenes: [{ nodes: [] }] }) {
  const text = JSON.stringify(document);
  const json = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, " "));
  const bytes = Buffer.alloc(20 + json.length);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}

test("gzip delivery is byte-identical to its source GLB in Node and browser decoding", async () => {
  const original = glb();
  const compressed = gzipSync(original);
  assert.deepEqual(verifyGeometryGlb(compressed, "test", FORMAT), verifyGeometryGlb(original));
  assert.deepEqual(Buffer.from(await decodeGeometryBytes(compressed, FORMAT)), original);
  assert.equal(await decodeGeometryBytes(original, "glb-instanced-v1"), original);
  assert.throws(() => verifyGeometryGlb(compressed), /complete GLB/);
});

test("invalid, truncated or external-resource gzip models are rejected", async () => {
  const compressed = gzipSync(glb());
  for (const bad of [Buffer.from("not gzip"), compressed.subarray(0, compressed.length - 4)]) {
    assert.throws(() => verifyGeometryGlb(bad, "test", FORMAT), /invalid gzip/);
    await assert.rejects(decodeGeometryBytes(bad, FORMAT));
  }
  assert.throws(() => verifyGeometryGlb(gzipSync(glb({ asset: { version: "2.0" }, images: [{ uri: "outside.png" }] })), "test", FORMAT), /external URIs/);
});

test("Node and browser reject gzip expansion beyond the same 128 MiB ceiling", async () => {
  assert.equal(MAX_GEOMETRY_BYTES, 128 * 1024 * 1024);
  assert.equal(NODE_LIMIT, MAX_GEOMETRY_BYTES);
  const oversized = gzipSync(Buffer.alloc(MAX_GEOMETRY_BYTES + 1), { level: 1 });
  assert.throws(() => verifyGeometryGlb(oversized, "test", FORMAT), /128 MiB/);
  await assert.rejects(decodeGeometryBytes(oversized, FORMAT), /128 MiB/);
});

test("gzip decode respects cancellation and rejects unsupported formats", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(decodeGeometryBytes(gzipSync(glb()), FORMAT, controller.signal), { name: "AbortError" });
  await assert.rejects(decodeGeometryBytes(glb(), "unknown"), /不支持/);
});
