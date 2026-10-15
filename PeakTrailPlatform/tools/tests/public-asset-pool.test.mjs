import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createPublicAssetWriter } from "../lib/public-asset-pool.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "peaktrail-public-pool-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pool = resolve(root, "pool");
  const source = resolve(root, "source.png");
  const bytes = Buffer.from("immutable shared texture");
  await writeFile(source, bytes);
  return { root, pool, source, bytes, blob: resolve(pool, "blobs", sha256(bytes)) };
}
function sameInode(a, b) { assert.equal(a.dev, b.dev); assert.equal(a.ino, b.ino); }

test("local default copies assets and never alters source or shares its inode", async t => {
  const { root, source, bytes } = await fixture(t);
  const writer = await createPublicAssetWriter();
  const destination = resolve(root, "local.png");
  await writer.stageImmutable(source, destination);
  assert.deepEqual(await readFile(destination), bytes);
  assert.notEqual((await stat(source)).ino, (await stat(destination)).ino);
  await writeFile(destination, "changed local output");
  assert.deepEqual(await readFile(source), bytes);
  assert.deepEqual(writer.stats(), { enabled: false, linkedFiles: 0, reusedBytes: 0, newBytes: 0, uniqueCreatedBlobs: 0 });
});

test("two releases and different source paths share one content-addressed immutable inode", async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const source2 = resolve(root, "other-path.bin");
  await copyFile(source, source2);
  const writer = await createPublicAssetWriter(pool);
  const destination1 = resolve(root, "release1", "first.png");
  const destination2 = resolve(root, "release2", "different-name.bin");
  await writer.stageImmutable(source, destination1);
  await writer.stageImmutable(source2, destination2);
  sameInode(await stat(destination1), await stat(destination2));
  sameInode(await stat(blob), await stat(destination1));
  assert.notEqual((await stat(source)).ino, (await stat(blob)).ino);
  assert.equal((await stat(blob)).nlink, 3);
  assert.equal((await stat(blob)).mode & 0o222, 0);
  assert.deepEqual(await readdir(resolve(pool, ".temp")), []);
  assert.deepEqual(writer.stats(), { enabled: true, linkedFiles: 2, reusedBytes: bytes.length, newBytes: bytes.length, uniqueCreatedBlobs: 1 });
});

test("changed input creates a new blob while earlier release bytes remain intact", async t => {
  const { root, pool, source, bytes } = await fixture(t);
  const first = resolve(root, "release1", "asset.png");
  const second = resolve(root, "release2", "asset.png");
  const writer = await createPublicAssetWriter(pool);
  await writer.stageImmutable(source, first);
  const changed = Buffer.from("new content");
  await writeFile(source, changed);
  await writer.stageImmutable(source, second);
  assert.deepEqual(await readFile(first), bytes);
  assert.deepEqual(await readFile(second), changed);
  assert.notEqual((await stat(first)).ino, (await stat(second)).ino);
  assert.equal((await readdir(resolve(pool, "blobs"))).length, 2);
});

test("metadata stays independent when copied beside shared immutable assets", async t => {
  const { root, pool, source } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  await writer.stageImmutable(source, resolve(root, "release1", "asset.png"));
  await writer.stageImmutable(source, resolve(root, "release2", "asset.png"));
  const metadata1 = resolve(root, "release1", "map-pack.json");
  const metadata2 = resolve(root, "release2", "map-pack.json");
  await writeFile(metadata1, JSON.stringify({ route: "old" }));
  await copyFile(metadata1, metadata2);
  await writeFile(metadata2, JSON.stringify({ route: "new" }));
  assert.equal(JSON.parse(await readFile(metadata1, "utf8")).route, "old");
  assert.notEqual((await stat(metadata1)).ino, (await stat(metadata2)).ino);
});

for (const corruption of ["same-size", "wrong-size"]) test(`existing ${corruption} corrupt blob is rejected without replacement`, async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  const corrupt = corruption === "same-size" ? Buffer.alloc(bytes.length, 33) : Buffer.from("wrong");
  await writeFile(blob, corrupt, { mode: 0o444 });
  const before = await stat(blob);
  await assert.rejects(writer.stageImmutable(source, resolve(root, "release", "asset.png")), /blob.*(invalid|digest)/i);
  sameInode(before, await stat(blob));
  assert.deepEqual(await readFile(blob), corrupt);
  assert.deepEqual(await readdir(resolve(pool, ".temp")), []);
});

test("existing writable blob fails closed", async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  await writeFile(blob, bytes, { mode: 0o644 });
  await assert.rejects(writer.stageImmutable(source, resolve(root, "release", "asset.png")), /writable/);
});

async function makeSymlink(t, target, path, directory = false) {
  try { await symlink(target, path, directory ? (process.platform === "win32" ? "junction" : "dir") : "file"); return true; }
  catch (error) { if (["EPERM", "ENOSYS"].includes(error.code)) { t.skip("Host does not permit symlinks"); return false; } throw error; }
}

test("source symlink is rejected", async t => {
  const { root, pool, source } = await fixture(t);
  const pointer = resolve(root, "pointer.png");
  if (!await makeSymlink(t, source, pointer)) return;
  const writer = await createPublicAssetWriter(pool);
  await assert.rejects(writer.stageImmutable(pointer, resolve(root, "out.png")), /symlink|regular/);
});

test("source ancestor symlink is rejected", async t => {
  const { root, pool, bytes } = await fixture(t);
  const real = resolve(root, "real"); await mkdir(real); await writeFile(resolve(real, "asset.png"), bytes);
  const alias = resolve(root, "alias");
  if (!await makeSymlink(t, real, alias, true)) return;
  const writer = await createPublicAssetWriter(pool);
  await assert.rejects(writer.stageImmutable(resolve(alias, "asset.png"), resolve(root, "out.png")), /symlink/);
});

test("pool ancestor and blob-directory symlinks are rejected", async t => {
  const { root } = await fixture(t);
  const real = resolve(root, "real"); await mkdir(real);
  const alias = resolve(root, "alias");
  if (!await makeSymlink(t, real, alias, true)) return;
  await assert.rejects(createPublicAssetWriter(resolve(alias, "nested")), /symlink/);
  const otherPool = resolve(root, "other-pool"); await mkdir(otherPool);
  if (!await makeSymlink(t, real, resolve(otherPool, "blobs"), true)) return;
  await assert.rejects(createPublicAssetWriter(otherPool), /symlink/);
});

test("existing blob symlink is rejected without following or replacing it", async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  if (!await makeSymlink(t, source, blob)) return;
  await assert.rejects(writer.stageImmutable(source, resolve(root, "out.png")), /blob.*invalid/);
  assert.equal((await lstat(blob)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(source), bytes);
});

test("destination ancestor symlink and private-pool destination are rejected", async t => {
  const { root, pool, source } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  await assert.rejects(writer.stageImmutable(source, resolve(pool, "self.png")), /private storage/);
  const target = resolve(root, "target"); await mkdir(target);
  const alias = resolve(root, "alias");
  if (!await makeSymlink(t, target, alias, true)) return;
  await assert.rejects(writer.stageImmutable(source, resolve(alias, "out.png")), /symlink/);
});

test("concurrent same-digest publishers atomically keep one blob and all release links", async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const writers = await Promise.all(Array.from({ length: 8 }, () => createPublicAssetWriter(pool)));
  const destinations = writers.map((_, i) => resolve(root, `release${i}`, "asset.png"));
  await Promise.all(writers.map((writer, i) => writer.stageImmutable(source, destinations[i])));
  const identity = await stat(blob);
  for (const destination of destinations) { sameInode(identity, await stat(destination)); assert.deepEqual(await readFile(destination), bytes); }
  assert.equal(identity.nlink, 9);
  assert.equal(writers.reduce((sum, writer) => sum + writer.stats().uniqueCreatedBlobs, 0), 1);
  assert.deepEqual(await readdir(resolve(pool, "blobs")), [sha256(bytes)]);
  assert.deepEqual(await readdir(resolve(pool, ".temp")), []);
});

test("interrupted staging removes partial temps and leaves a known blob unchanged", async t => {
  const { root, pool, source, bytes, blob } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  await writer.stageImmutable(source, resolve(root, "release1", "asset.png"));
  const before = await stat(blob);
  await writeFile(source, Buffer.alloc(8 * 1024 * 1024, 4));
  const controller = new AbortController();
  const pending = writer.stageImmutable(source, resolve(root, "release2", "asset.png"), { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, { name: "AbortError" });
  sameInode(before, await stat(blob));
  assert.deepEqual(await readFile(blob), bytes);
  assert.deepEqual(await readdir(resolve(pool, "blobs")), [sha256(bytes)]);
  assert.deepEqual(await readdir(resolve(pool, ".temp")), []);
});

test("existing destination is never overwritten or silently copied", async t => {
  const { root, pool, source } = await fixture(t);
  const writer = await createPublicAssetWriter(pool);
  const destination = resolve(root, "existing.png");
  await writeFile(destination, "keep");
  await assert.rejects(writer.stageImmutable(source, destination), { code: "EEXIST" });
  assert.equal(await readFile(destination, "utf8"), "keep");
});

test("pool must be an absolute non-normalized canonical path", async t => {
  const { root } = await fixture(t);
  for (const value of ["", "relative-pool", `${root}/../wrong`, null]) await assert.rejects(createPublicAssetWriter(value), /absolute canonical/);
});

test("cross-filesystem links fail explicitly instead of making duplicate copies", { skip: process.platform !== "linux" }, async t => {
  const { pool, source } = await fixture(t);
  let destinationRoot;
  try { destinationRoot = await mkdtemp("/dev/shm/peaktrail-public-pool-"); }
  catch { t.skip("No writable secondary filesystem"); return; }
  t.after(() => rm(destinationRoot, { recursive: true, force: true }));
  if ((await stat(pool).catch(() => stat(source))).dev === (await stat(destinationRoot)).dev) { t.skip("No separate filesystem"); return; }
  const writer = await createPublicAssetWriter(pool);
  const destination = resolve(destinationRoot, "asset.png");
  await assert.rejects(writer.stageImmutable(source, destination), /same filesystem.*EXDEV/);
  await assert.rejects(stat(destination), { code: "ENOENT" });
});
