import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { importMapAssets } from "../../deploy/import-map-assets.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const id = `sha256-${"1".repeat(64)}`, prefix = `maps/packs/${id}/`;
const exists = async path => !!(await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; }));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "peak-map-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "staging"), destination = join(root, "assets"), manifestPath = join(root, "manifest.json");
  const inputs = new Map([[`${prefix}segment-00.png`, Buffer.from("native texture")],
    [`${prefix}segment-00.height.f32`, Buffer.from("native heights")], [`${prefix}segment-00.glb.gz`, Buffer.from("native terrain")]]);
  const pack = { schemaVersion: 1, gameBuildId: 26134529, mapPackId: id, layers: [{ id: "segment-00",
    texture: "segment-00.png", textureSha256: sha(inputs.get(`${prefix}segment-00.png`)),
    height: "segment-00.height.f32", heightSha256: sha(inputs.get(`${prefix}segment-00.height.f32`)),
    geometry: "segment-00.glb.gz", geometrySha256: sha(inputs.get(`${prefix}segment-00.glb.gz`)) }] };
  inputs.set(`${prefix}map-pack.json`, Buffer.from(JSON.stringify(pack)));
  const enclosure = Buffer.from("native enclosure");
  inputs.set(`maps/enclosures/${sha(enclosure)}.glb.gz`, enclosure);
  for (const [path, bytes] of inputs) { await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), bytes); }
  const manifest = { schemaVersion: 1, gameBuildId: "26134529", files: [...inputs].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) })) };
  const state = { root, source, destination, manifestPath, inputs, manifest, pack };
  await saveManifest(state);
  state.options = overrides => ({ source, destination, manifestPath, manifestSha256: state.manifestSha256, ...overrides });
  return state;
}

async function saveManifest(state) {
  const bytes = JSON.stringify(state.manifest);
  await writeFile(state.manifestPath, bytes);
  state.manifestSha256 = sha(bytes);
}

test("dry run validates the full allowlist without creating destination; install is exact and repeatable", async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, "private-save.ndjson"), "must not import");
  const dry = await importMapAssets(f.options());
  assert.equal(dry.mode, "dry-run"); assert.equal(dry.files, 5); assert.equal(dry.missingFiles, 5);
  assert.equal(await exists(f.destination), false);
  await mkdir(f.destination, { mode: 0o755 }); await writeFile(join(f.destination, "historical-pack.txt"), "preserve old");
  const installed = await importMapAssets(f.options({ install: true }));
  assert.equal(installed.installedFiles, 5);
  for (const [path, bytes] of f.inputs) assert.deepEqual(await readFile(join(f.destination, path)), bytes);
  assert.equal(await exists(join(f.destination, "private-save.ndjson")), false);
  assert.equal(await readFile(join(f.destination, "historical-pack.txt"), "utf8"), "preserve old");
  if (process.platform !== "win32") {
    assert.equal((await lstat(join(f.destination, `${prefix}map-pack.json`))).mode & 0o777, 0o644);
    assert.equal((await lstat(join(f.destination, "maps/packs", id))).mode & 0o777, 0o755);
  }
  const repeated = await importMapAssets(f.options({ install: true }));
  assert.equal(repeated.existingFiles, 5); assert.equal(repeated.installedFiles, 0);
  assert.ok((await readdir(join(f.destination, "maps/packs", id))).every(name => !name.startsWith(".map-import-")));
});

test("a reviewed manifest hash and every source digest are required before any mutation", async t => {
  const f = await fixture(t);
  await assert.rejects(importMapAssets(f.options({ install: true, manifestSha256: "0".repeat(64) })), /Manifest SHA-256 mismatch/);
  assert.equal(await exists(f.destination), false);
  await writeFile(join(f.source, `${prefix}segment-00.png`), "tampered texture");
  await assert.rejects(importMapAssets(f.options({ install: true })), /size\/hash mismatch|exceeds declared size/);
  assert.equal(await exists(f.destination), false);
});

test("existing different bytes fail the whole preflight and are never replaced", async t => {
  const f = await fixture(t), conflicting = join(f.destination, `${prefix}segment-00.glb.gz`);
  await mkdir(dirname(conflicting), { recursive: true, mode: 0o755 }); await writeFile(conflicting, "existing release");
  await assert.rejects(importMapAssets(f.options({ install: true })), /size\/hash mismatch|exceeds declared size/);
  assert.equal(await readFile(conflicting, "utf8"), "existing release");
  assert.equal(await exists(join(f.destination, `${prefix}segment-00.png`)), false);
});

test("path traversal, unsupported artifacts, duplicates and digest-mismatched enclosure names are rejected", async t => {
  const f = await fixture(t), original = structuredClone(f.manifest);
  for (const path of ["../secret.png", `${prefix}../../secret.png`, `${prefix}raw.assets`, `${prefix}capture.json`, `${prefix}folder/icon.png`, "maps/packs/C:/secret.png"]) {
    f.manifest = structuredClone(original); f.manifest.files[0].path = path; await saveManifest(f);
    await assert.rejects(importMapAssets(f.options({ install: true })), /Unsafe, duplicate or unsupported/);
  }
  f.manifest = structuredClone(original); f.manifest.files.push(f.manifest.files[0]); await saveManifest(f);
  await assert.rejects(importMapAssets(f.options()), /Unsafe, duplicate or unsupported/);
  f.manifest = structuredClone(original); f.manifest.files.at(-1).path = `maps/enclosures/${"0".repeat(64)}.glb.gz`; await saveManifest(f);
  await assert.rejects(importMapAssets(f.options()), /Enclosure filename/);
  assert.equal(await exists(f.destination), false);
});

test("imported map identity, dependency closure and build must agree with the pinned manifest", async t => {
  const f = await fixture(t);
  f.manifest.gameBuildId = "25739797"; await saveManifest(f);
  await assert.rejects(importMapAssets(f.options()), /build\/identity mismatch/);
  f.manifest.gameBuildId = "26134529"; f.manifest.files = f.manifest.files.filter(entry => !entry.path.endsWith(".height.f32")); await saveManifest(f);
  await assert.rejects(importMapAssets(f.options()), /dependency missing/);
  const bytes = Buffer.from("unreferenced");
  f.manifest.files.push({ path: `${prefix}unused.png`, bytes: bytes.length, sha256: sha(bytes) });
  f.manifest.files.push({ path: `${prefix}segment-00.height.f32`, bytes: 14, sha256: sha("native heights") });
  await saveManifest(f);
  await assert.rejects(importMapAssets(f.options()), /Unreferenced file/);
});

test("source and destination trees must be disjoint", async t => {
  const f = await fixture(t);
  for (const destination of [f.source, join(f.source, "new"), f.root])
    await assert.rejects(importMapAssets(f.options({ destination, install: true })), /separate trees/);
});

test("concurrent identical imports publish complete files without replacing or leaving temporary files", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([importMapAssets(f.options({ install: true })), importMapAssets(f.options({ install: true }))]);
  assert.equal(a.installedFiles + b.installedFiles, 5);
  for (const [path, bytes] of f.inputs) assert.deepEqual(await readFile(join(f.destination, path)), bytes);
  assert.ok((await readdir(join(f.destination, "maps/packs", id))).every(name => !name.startsWith(".map-import-")));
});

test("symlinks at source files, source ancestors, destination files and destination ancestors are rejected", { skip: process.platform === "win32" && "Linux symlink security is checked in CI" }, async t => {
  for (const kind of ["source-file", "source-dir", "destination-file", "destination-dir"]) {
    const f = await fixture(t), original = join(f.source, `${prefix}segment-00.png`);
    if (kind === "source-file") {
      const outside = join(f.root, "outside.png"); await writeFile(outside, await readFile(original)); await rm(original); await symlink(outside, original);
    } else if (kind === "source-dir") {
      const real = join(f.root, "real-packs"); await mkdir(real); await rm(join(f.source, "maps/packs"), { recursive: true }); await symlink(real, join(f.source, "maps/packs"));
    } else if (kind === "destination-file") {
      const target = join(f.destination, `${prefix}segment-00.png`); await mkdir(dirname(target), { recursive: true, mode: 0o755 }); await symlink(original, target);
    } else {
      await mkdir(f.destination, { mode: 0o755 }); await symlink(join(f.source, "maps"), join(f.destination, "maps"));
    }
    await assert.rejects(importMapAssets(f.options({ install: true })), /ordinary directory|ordinary file/);
  }
});

test("install rejects writable destination directories", { skip: process.platform === "win32" && "POSIX ownership and modes are checked in CI" }, async t => {
  const f = await fixture(t);
  await mkdir(f.destination); await chmod(f.destination, 0o777);
  await assert.rejects(importMapAssets(f.options({ install: true })), /Writable destination ancestor/);
});
