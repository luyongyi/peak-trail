import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { maintainDeploymentStorage, publishAtomically, publishReleaseAndMaintain, withDeployLock, writeReleaseState } from "../../deploy/receiver.mjs";

const linux = { skip: process.platform !== "linux" && "Receiver symlink, ownership and hard-link retention semantics are verified on Linux" };
const now = Date.parse("2026-10-15T12:00:00Z");
const old = new Date(now - 2 * 60 * 60 * 1000);

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "peak-deployment-storage-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "releases"));
  return root;
}

async function release(root, index, state = "successful", { legacy = false } = {}) {
  const commit = index.toString(16).padStart(40, "0");
  const name = `${commit.slice(0, 12)}-${index.toString(36).padStart(6, "0")}`;
  const directory = join(root, "releases", name);
  const site = join(directory, "PeakTrailPlatform", "site-dist");
  await mkdir(site, { recursive: true });
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, ".git", "HEAD"), commit + "\n");
  await writeFile(join(site, "index.html"), `release ${index}`);
  if (state === "successful") await writeFile(join(site, "release.json"), JSON.stringify({ commit, deployedAtUtc: new Date(now + index).toISOString() }));
  if (!legacy) await writeReleaseState(root, directory, commit, state, { now: now + index });
  return { directory, site, commit, name };
}

async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

async function blob(root, contents, { age = old } = {}) {
  const digest = createHash("sha256").update(contents).digest("hex");
  const path = join(root, "public-assets", "blobs", digest);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await utimes(path, age, age);
  return path;
}

async function pooledAsset(item, source) {
  const path = join(item.site, "data", "maps", "packs", "sha256-fixture", "terrain.glb");
  await mkdir(dirname(path), { recursive: true });
  await link(source, path);
  return path;
}

test("release markers reject root, outside, nested, mismatched commit and invalid state", async t => {
  const root = await temporary(t);
  const item = await release(root, 1, "building");
  for (const path of [root, join(root, "releases"), join(root, "..", "outside"), join(item.directory, "nested")]) {
    await assert.rejects(writeReleaseState(root, path, item.commit, "failed"), /strictly inside|direct, receiver-named/);
  }
  await assert.rejects(writeReleaseState(root, item.directory, "f".repeat(40), "failed"), /commit does not match/);
  await assert.rejects(writeReleaseState(root, item.directory, item.commit, "unknown"), /Invalid deployment state/);
  await writeReleaseState(root, item.directory, item.commit, "failed", { now: now + 2 });
  const marker = JSON.parse(await readFile(join(item.directory, ".deployment-state.json"), "utf8"));
  assert.equal(marker.createdAtUtc, new Date(now + 1).toISOString());
  assert.equal(marker.updatedAtUtc, new Date(now + 2).toISOString());
  assert.equal(marker.state, "failed");
});

test("retention pins current plus three successful rollbacks and one failed release; building and unknown stay", linux, async t => {
  const root = await temporary(t);
  const successes = [];
  for (let index = 1; index <= 7; index++) successes.push(await release(root, index));
  const failures = [];
  for (let index = 8; index <= 10; index++) failures.push(await release(root, index, "failed"));
  const building = await release(root, 11, "building");
  const unknown = join(root, "releases", "operator-review");
  await mkdir(unknown);
  await writeFile(join(unknown, "evidence.txt"), "retain");
  await publishAtomically(root, successes[0].site); // Deliberately older than the rollback candidates.
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.retainedSuccessful, 4);
  assert.equal(result.retainedFailed, 1);
  assert.equal(result.retainedBuilding, 1);
  assert.equal(result.removedReleases, 5);
  assert.equal(result.skippedReleases, 1);
  for (const item of [successes[0], ...successes.slice(4), failures[2], building]) assert.ok(await exists(item.directory));
  for (const item of [...successes.slice(1, 4), ...failures.slice(0, 2)]) assert.equal(await exists(item.directory), false);
  assert.equal(await realpath(join(root, "current")), successes[0].site);
  assert.equal(await readFile(join(unknown, "evidence.txt"), "utf8"), "retain");
});

test("legacy receipts require matching detached HEAD, directory prefix and publication commit", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 20);
  const recognized = await release(root, 1, "successful", { legacy: true });
  for (let index = 21; index <= 23; index++) await release(root, index);
  const mismatch = await release(root, 2, "successful", { legacy: true });
  await writeFile(join(mismatch.site, "release.json"), JSON.stringify({ commit: "f".repeat(40), deployedAtUtc: new Date(now).toISOString() }));
  const incomplete = await release(root, 3, "failed", { legacy: true });
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(await exists(recognized.directory), false);
  assert.ok(await exists(mismatch.directory));
  assert.ok(await exists(incomplete.directory));
  assert.equal(result.skippedReleases, 2);
});

test("pool GC deletes only old unlinked blobs and strict old temporary names", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 1);
  const linked = await blob(root, "linked to current");
  const publicFile = await pooledAsset(current, linked);
  const orphan = await blob(root, "old orphan");
  const young = await blob(root, "young orphan", { age: new Date(now - 1000) });
  const temporaryDirectory = join(root, "public-assets", ".temp");
  await mkdir(temporaryDirectory);
  const staleTemporary = join(temporaryDirectory, `123-${randomUUID()}`);
  const youngTemporary = join(temporaryDirectory, `123-${randomUUID()}`);
  const unknownTemporary = join(temporaryDirectory, "operator-note");
  for (const file of [staleTemporary, youngTemporary, unknownTemporary]) await writeFile(file, "temporary");
  await utimes(staleTemporary, old, old);
  await utimes(unknownTemporary, old, old);
  await utimes(youngTemporary, new Date(now), new Date(now));
  const unexpected = join(root, "public-assets", "blobs", "operator-note");
  await writeFile(unexpected, "keep");
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedBlobs, 1);
  assert.equal(result.removedTemporary, 1);
  assert.equal(await exists(orphan), false);
  assert.equal(await exists(staleTemporary), false);
  for (const file of [linked, young, publicFile, youngTemporary, unknownTemporary, unexpected]) assert.ok(await exists(file));
  assert.equal(await lstat(linked).then(entry => entry.ino), await lstat(publicFile).then(entry => entry.ino));
  assert.equal(result.poolBlobs, 2);
  assert.ok(result.releaseLogicalBytes + result.poolLogicalBytes > result.managedUniqueBytes);
});

test("pruned release links are removed before old orphan pool GC, while rollback and building links survive", linux, async t => {
  const root = await temporary(t);
  const oldest = await release(root, 1);
  const oldBlob = await blob(root, "only pruned release uses this");
  await pooledAsset(oldest, oldBlob);
  const items = [];
  for (let index = 2; index <= 5; index++) items.push(await release(root, index));
  const rollbackBlob = await blob(root, "rollback resource");
  await pooledAsset(items[0], rollbackBlob);
  const building = await release(root, 6, "building");
  const buildingBlob = await blob(root, "pending resource");
  await pooledAsset(building, buildingBlob);
  await publishAtomically(root, items[3].site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedReleases, 1);
  assert.equal(result.removedBlobs, 1);
  assert.equal(await exists(oldest.directory), false);
  assert.equal(await exists(oldBlob), false);
  assert.ok(await exists(rollbackBlob));
  assert.ok(await exists(buildingBlob));
});

test("release and pool symlinks, special files and unexpected hard links are never deleted", linux, async t => {
  const root = await temporary(t);
  const unsafe = await release(root, 1);
  const unsafeLink = await release(root, 2);
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside evidence");
  await symlink(outside, join(unsafe.directory, "shortcut"));
  await link(outside, join(unsafeLink.directory, "unrecognized-link"));
  const current = await release(root, 10);
  for (let index = 11; index <= 13; index++) await release(root, index);
  const fakeRelease = join(root, "releases", `${"f".repeat(12)}-abcdef`);
  await symlink(root, fakeRelease);
  await mkdir(join(root, "public-assets", "blobs"), { recursive: true });
  const fakeBlob = join(root, "public-assets", "blobs", "f".repeat(64));
  await symlink(outside, fakeBlob);
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.ok(await exists(unsafe.directory));
  assert.ok(await exists(unsafeLink.directory));
  assert.ok((await lstat(fakeRelease)).isSymbolicLink());
  assert.ok((await lstat(fakeBlob)).isSymbolicLink());
  assert.equal(await readFile(outside, "utf8"), "outside evidence");
  assert.equal(result.removedReleases, 0);
});

test("storage maintenance rejects missing lock, anomalous current and non-successful current before deleting anything", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 1);
  const orphan = await blob(root, "must survive rejected cleanup");
  await publishAtomically(root, current.site);
  await assert.rejects(maintainDeploymentStorage(root, { now }), /ENOENT/);
  await rm(join(root, "current"));
  await symlink(root, join(root, "current"));
  await assert.rejects(withDeployLock(root, () => maintainDeploymentStorage(root, { now })), /strictly inside/);
  await rm(join(root, "current"));
  await publishAtomically(root, current.site);
  await writeReleaseState(root, current.directory, current.commit, "failed");
  await assert.rejects(withDeployLock(root, () => maintainDeploymentStorage(root, { now })), /verified successful release/);
  assert.ok(await exists(orphan));
  assert.ok(await exists(current.directory));
});

test("current with mismatched marker, public receipt or root identity never permits cleanup", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 1);
  await publishAtomically(root, current.site);
  await writeFile(join(current.site, "release.json"), JSON.stringify({ commit: "f".repeat(40), deployedAtUtc: new Date(now).toISOString() }));
  await assert.rejects(withDeployLock(root, () => maintainDeploymentStorage(root, { now })), /receipt does not match/);
  await assert.rejects(withDeployLock(root, () => maintainDeploymentStorage(root, { now, graceMs: 0 })), /at least one hour/);
  assert.ok(await exists(current.directory));
});

test("failed activation never starts retention, and later publication is not overwritten by rollback", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 1);
  const candidate = await release(root, 2, "building");
  const intervening = await release(root, 3);
  await publishAtomically(root, current.site);
  let maintenanceCalls = 0;
  await assert.rejects(withDeployLock(root, () => publishReleaseAndMaintain(root, candidate.directory, candidate.commit, async target => {
    if (target === candidate.site) throw new Error("health failed");
  }, { maintenance: async () => { maintenanceCalls++; } })), error => error.rollbackStatus === "restored");
  assert.equal(maintenanceCalls, 0);
  assert.equal(await realpath(join(root, "current")), current.site);
  await assert.rejects(withDeployLock(root, () => publishReleaseAndMaintain(root, candidate.directory, candidate.commit, async () => {
    await publishAtomically(root, intervening.site);
    throw new Error("health failed after another publication");
  }, { maintenance: async () => { maintenanceCalls++; } })), error => error.rollbackStatus === "failed");
  assert.equal(maintenanceCalls, 0);
  assert.equal(await realpath(join(root, "current")), intervening.site);
  assert.ok(await exists(candidate.directory));
});

test("cleanup failure leaves a healthy publication successful and current", linux, async t => {
  const root = await temporary(t);
  const candidate = await release(root, 1, "building");
  await writeFile(join(candidate.site, "release.json"), JSON.stringify({ commit: candidate.commit, deployedAtUtc: new Date(now).toISOString() }));
  await withDeployLock(root, () => publishReleaseAndMaintain(root, candidate.directory, candidate.commit, async target => {
    assert.equal(await realpath(join(root, "current")), target);
  }, { maintenance: async () => { throw new Error("simulated cleanup failure"); } }));
  assert.equal(await realpath(join(root, "current")), candidate.site);
  assert.equal(JSON.parse(await readFile(join(candidate.directory, ".deployment-state.json"), "utf8")).state, "successful");
});

test("successful-state write failure preserves healthy current and never starts cleanup", linux, async t => {
  const root = await temporary(t);
  const candidate = await release(root, 1, "building");
  await writeFile(join(candidate.site, "release.json"), JSON.stringify({ commit: candidate.commit, deployedAtUtc: new Date(now).toISOString() }));
  let cleanupCalls = 0;
  const result = await withDeployLock(root, () => publishReleaseAndMaintain(root, candidate.directory, candidate.commit, async target => {
    assert.equal(await realpath(join(root, "current")), target);
  }, { writeState: async () => { const error = new Error("simulated marker disk full"); error.code = "ENOSPC"; throw error; }, maintenance: async () => { cleanupCalls++; } }));
  assert.equal(result, candidate.site);
  assert.equal(cleanupCalls, 0);
  assert.equal(await realpath(join(root, "current")), candidate.site);
  assert.equal(JSON.parse(await readFile(join(candidate.directory, ".deployment-state.json"), "utf8")).state, "building");
});

test("special entries stop deletion of an otherwise expired release", linux, async t => {
  const root = await temporary(t);
  const unsafe = await release(root, 1);
  const fifo = join(unsafe.directory, "special-fifo");
  const command = spawnSync("mkfifo", [fifo]);
  assert.equal(command.status, 0, command.stderr?.toString());
  const current = await release(root, 10);
  for (let index = 11; index <= 13; index++) await release(root, index);
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedReleases, 0);
  assert.ok((await lstat(fifo)).isFIFO());
});

test("stale atomic-publication temporary hard links are unlinked without touching their blob or release", linux, async t => {
  const root = await temporary(t);
  const current = await release(root, 1);
  const linked = await blob(root, "published before temporary unlink");
  const publicFile = await pooledAsset(current, linked);
  const directory = join(root, "public-assets", ".temp");
  await mkdir(directory);
  const temporaryFile = join(directory, `123-${randomUUID()}`);
  await link(linked, temporaryFile);
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedTemporary, 1);
  assert.equal(await exists(temporaryFile), false);
  assert.equal(await readFile(publicFile, "utf8"), "published before temporary unlink");
  assert.equal(await lstat(linked).then(entry => entry.nlink), 2);
});

test("pinned DLL and static model JSON pool links survive current and rollbacks while an expired release is removed", linux, async t => {
  const root = await temporary(t);
  const memories = await blob(root, "MZ verified memories assembly");
  const recorder = await blob(root, "MZ verified recorder assembly");
  const model = await blob(root, JSON.stringify({ vertices: [0, 0, 0], triangles: [0, 0, 0] }));
  const items = [];
  for (let index = 1; index <= 5; index++) {
    const item = await release(root, index);
    for (const [relative, source] of [["downloads/memories/0.8.35/PeakReplayLab.dll", memories], ["downloads/recorder/1.2.3/PeakTrailRecorder.dll", recorder], ["data/game-assets/25306743/models/player.json", model]]) {
      const path = join(item.site, relative);
      await mkdir(dirname(path), { recursive: true });
      await link(source, path);
    }
    items.push(item);
  }
  await publishAtomically(root, items[4].site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedReleases, 1);
  assert.equal(result.protectedExpiredReleases, 0);
  assert.equal(result.retainedSuccessful, 4);
  assert.equal(await exists(items[0].directory), false);
  for (const item of items.slice(1)) {
    assert.equal(await readFile(join(item.site, "downloads/memories/0.8.35/PeakReplayLab.dll"), "utf8"), "MZ verified memories assembly");
    assert.equal(await readFile(join(item.site, "downloads/recorder/1.2.3/PeakTrailRecorder.dll"), "utf8"), "MZ verified recorder assembly");
  }
  assert.equal((await lstat(memories)).nlink, 5);
  assert.equal((await lstat(recorder)).nlink, 5);
  assert.equal((await lstat(model)).nlink, 5);
});

test("other download paths and mutable release metadata cannot masquerade as approved DLL pool links", linux, async t => {
  const root = await temporary(t);
  const shared = await blob(root, "MZ not approved for these paths");
  const invalidPaths = [
    "downloads/memories/0.8.35/Other.dll",
    "downloads/memories/0.8.35/PeakTrailRecorder.dll",
    "downloads/recorder/1.2.3/PeakReplayLab.dll",
    "downloads/other/0.8.35/PeakReplayLab.dll",
    "downloads/memories/latest/PeakReplayLab.dll",
    "downloads/memories/00.8.35/PeakReplayLab.dll",
    "downloads/memories/0.8.35/PeakReplayLab.dll.json",
    "downloads/memories/0.8.35/PeakReplayLab.dll/config.json",
    "downloads/memories/0.8.35/release.json",
    "data/memories/release.json",
    "data/maps/packs/sha256-fixture/map-pack.json",
    "data/game-assets/catalog.json",
    "data/game-assets/25306743/catalog.json",
  ];
  const unsafe = [];
  for (const [index, relative] of invalidPaths.entries()) {
    const item = await release(root, index + 1);
    const path = join(item.site, relative);
    await mkdir(dirname(path), { recursive: true });
    await link(shared, path);
    unsafe.push(item);
  }
  const current = await release(root, 100);
  for (let index = 101; index <= 103; index++) await release(root, index);
  await publishAtomically(root, current.site);
  const result = await withDeployLock(root, () => maintainDeploymentStorage(root, { now }));
  assert.equal(result.removedReleases, 0);
  assert.equal(result.protectedExpiredReleases, invalidPaths.length);
  for (const item of unsafe) assert.ok(await exists(item.directory));
  assert.equal(await realpath(join(root, "current")), current.site);
});
