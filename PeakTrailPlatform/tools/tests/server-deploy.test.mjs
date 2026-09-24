import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { containedPath, parseDeployCommand, publishAtomically, verifyStagedSite, withDeployLock } from "../../deploy/receiver.mjs";

const commit = "a1".repeat(20);
const mapPackId = `sha256-${"ab".repeat(32)}`;

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "peak-deploy-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "releases"));
  return root;
}

async function fixture(root, name = "release-a") {
  const site = join(root, "releases", name, "PeakTrailPlatform", "site-dist");
  const files = {
    "index.html": "<!doctype html><title>PEAK Trail</title>", "styles.css": "body{}", "home.css": "main{}", "src/app.js": "export {};",
    "data/daily/current.json": JSON.stringify({ schemaVersion: 1, mapSlot: 0 }),
    "data/daily/history.json": JSON.stringify({ schemaVersion: 1, observations: [] }),
    "data/maps/catalog.json": JSON.stringify({ schemaVersion: 1, mapPacks: [{ mapPackId, path: `./packs/${mapPackId}/map-pack.json` }] }),
    "data/game-assets/catalog.json": JSON.stringify({ schemaVersion: 1 }),
    [`data/maps/packs/${mapPackId}/map-pack.json`]: JSON.stringify({ mapPackId, layers: [{ segment: 0 }] }),
  };
  for (const [name, content] of Object.entries(files)) {
    const target = join(site, name);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return site;
}

test("deploy command accepts only an exact full lowercase SHA", () => {
  assert.equal(parseDeployCommand(`deploy ${commit}`), commit);
  for (const value of [undefined, "", `deploy ${commit}\n`, `deploy ${commit};id`, `deploy ${commit} `, `deploy ${commit.toUpperCase()}`, `deploy ${commit.slice(1)}`, "sh", `deploy --help`, `deploy\t${commit}`]) {
    assert.throws(() => parseDeployCommand(value), /Only deploy/);
  }
});

test("deployment paths reject root, traversal and sibling-prefix paths", () => {
  const root = resolve("safe-state");
  assert.equal(containedPath(root, join(root, "releases", "new")), join(root, "releases", "new"));
  for (const candidate of [root, resolve(root, ".."), `${root}-other`, resolve(root, "releases", "..", "..", "other")]) {
    assert.throws(() => containedPath(root, candidate), /strictly inside/);
  }
});

test("deployment lock rejects overlap and releases after failure", async (t) => {
  const root = await temporary(t);
  await assert.rejects(withDeployLock(root, async () => {
    await assert.rejects(withDeployLock(root, () => assert.fail("overlapping deploy ran")), /Another deployment/);
    throw new Error("build failed");
  }), /build failed/);
  assert.equal(await withDeployLock(root, async () => "next deploy"), "next deploy");
});

test("staged site checks entry points, manifest bindings and private files", async (t) => {
  const root = await temporary(t);
  const site = await fixture(root);
  assert.deepEqual(await verifyStagedSite(site), { mapPacks: 1 });
  await writeFile(join(site, "session.ndjson"), "private");
  await assert.rejects(verifyStagedSite(site), /Private or unexpected/);
  await rm(join(site, "session.ndjson"));
  await writeFile(join(site, "data/maps/catalog.json"), JSON.stringify({ schemaVersion: 1, mapPacks: [{ mapPackId, path: "../../private" }] }));
  await assert.rejects(verifyStagedSite(site), /Unsafe staged map/);
});

test("staged site rejects missing or mismatched map manifests", async (t) => {
  const root = await temporary(t);
  const site = await fixture(root);
  await writeFile(join(site, `data/maps/packs/${mapPackId}/map-pack.json`), JSON.stringify({ mapPackId: "other", layers: [{}] }));
  await assert.rejects(verifyStagedSite(site), /does not match/);
  await writeFile(join(site, "src/app.js"), "");
  await assert.rejects(verifyStagedSite(site), /Missing or empty/);
});

test("atomic publication switches current; failure preserves prior release", { skip: process.platform === "win32" && "Production symlink semantics require Linux; exercised in Actions" }, async (t) => {
  const root = await temporary(t);
  const first = await fixture(root, "first");
  const second = await fixture(root, "second");
  await writeFile(join(second, "index.html"), "second release");
  await publishAtomically(root, first);
  await assert.rejects(publishAtomically(root, join(root, "missing")), /strictly inside/);
  assert.equal(await realpath(join(root, "current")), first);
  await publishAtomically(root, second);
  assert.equal(await readFile(join(root, "current", "index.html"), "utf8"), "second release");
  assert.match(await readFile(join(first, "index.html"), "utf8"), /PEAK Trail/);
});

test("publication refuses normal current directory and external or symlinked targets", { skip: process.platform === "win32" && "Production symlink semantics require Linux; exercised in Actions" }, async (t) => {
  const root = await temporary(t);
  const site = await fixture(root);
  await mkdir(join(root, "current"));
  await assert.rejects(publishAtomically(root, site), /not a deployment symlink/);
  await rm(join(root, "current"), { recursive: true });
  await symlink(root, join(root, "current"));
  await assert.rejects(publishAtomically(root, site), /strictly inside/);
  await rm(join(root, "current"));
  await symlink(site, join(site, "shortcut"));
  await assert.rejects(verifyStagedSite(site), /must not contain symlinks/);
});
