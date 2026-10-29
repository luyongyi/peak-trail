import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { decodeGeometryBytes, MAX_GEOMETRY_BYTES, readGeometryResponse, checkGeometryAbort } from "../src/geometry-bytes.js";
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

test("single-member gzip size must agree, including sliced inputs and checksum failures", async () => {
  const original = glb(), zipped = gzipSync(original), envelope = Buffer.concat([Buffer.alloc(17), zipped, Buffer.alloc(13)]);
  assert.deepEqual(Buffer.from(await decodeGeometryBytes(envelope.subarray(17, 17 + zipped.length), FORMAT)), original);
  const wrongSize = Buffer.from(zipped); wrongSize.writeUInt32LE(original.length + 1, wrongSize.length - 4);
  const badCrc = Buffer.from(zipped); badCrc[badCrc.length - 8] ^= 1;
  for (const invalid of [wrongSize, badCrc, Buffer.concat([zipped, zipped])]) await assert.rejects(decodeGeometryBytes(invalid, FORMAT));
});

test("download counts stream bytes even without or with a misleading content length", async () => {
  const bytes = glb(), progress = [];
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 8)); controller.enqueue(bytes.subarray(8)); controller.close();
  } }), { headers: { "content-length": "1" } });
  assert.deepEqual(Buffer.from(await readGeometryResponse(response, undefined, event => progress.push(event))), bytes);
  assert.equal(progress.at(-1).loadedBytes, bytes.length);
  assert.ok(progress.every(event => Object.keys(event).every(key => ["stage", "loadedBytes", "totalBytes"].includes(key))));
  let canceled = false;
  const hugeHeader = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-length": String(MAX_GEOMETRY_BYTES + 1) } });
  await assert.rejects(readGeometryResponse(hugeHeader), /128 MiB/);
  assert.equal(canceled, true);
  canceled = false; let sent = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const unknownSize = new Response(new ReadableStream({ pull(controller) { controller.enqueue(chunk); sent++; }, cancel() { canceled = true; } }));
  await assert.rejects(readGeometryResponse(unknownSize), /128 MiB/);
  assert.ok(sent <= 131, "cancel before reading an unbounded stream");
  assert.equal(canceled, true);
});

test("older AbortSignal without throwIfAborted can cancel a pending stream read", async () => {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const pending = readGeometryResponse(response, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(canceled, true);
  assert.throws(() => checkGeometryAbort({ aborted: true }), { name: "AbortError" });
  const active = { aborted: false };
  assert.deepEqual(Buffer.from(await decodeGeometryBytes(gzipSync(glb()), FORMAT, active, () => { throw Error("observer"); })), glb());
});
