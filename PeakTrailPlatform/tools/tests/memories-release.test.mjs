import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadMemoriesArtifact, MAX_MEMORIES_BYTES, requirePublicMemoriesRelease, validateMemoriesRelease, verifyMemoriesBytes } from "../lib/memories-release.mjs";
import { checkSiteBudget, checkSiteDownloadReferences, loadSiteArtifact, siteReleaseOptions } from "../lib/site-release.mjs";

const bytes = Buffer.from("MZ pinned memories fixture");
const release = { schemaVersion: 1, product: "peak-memories", version: "0.8.0", filename: "PeakReplayLab.dll",
  fileVersion: "0.8.0.0", informationalVersion: `0.8.0+${"a".repeat(40)}`, channel: "development",
  releaseStatus: "unreleased", sourceDirty: true, repositoryUrl: "https://github.com/luyongyi/peak-memories",
  sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  downloadPath: "downloads/memories/0.8.0/PeakReplayLab.dll" };
const execFileAsync = promisify(execFile);
const platformSource = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("memories descriptor is a pinned unreleased dirty build without forged tag, source proof or remote asset", () => {
  assert.deepEqual(validateMemoriesRelease({ ...release, privatePath: "C:/private" }), release);
  for (const patch of [
    { product: "recorder" }, { schemaVersion: 2 }, { version: "../0.8.0" }, { filename: "Assembly-CSharp.dll" },
    { fileVersion: "0.7.4.0" }, { informationalVersion: "0.8.0+main" }, { informationalVersion: `0.7.4+${"a".repeat(40)}` },
    { channel: "release" }, { releaseStatus: "published" }, { sourceDirty: false },
    { repositoryUrl: "https://github.com/luyongyi/peak-trail" }, { sha256: "bad" },
    { size: 0 }, { size: 2.5 }, { size: MAX_MEMORIES_BYTES + 1 },
    { downloadPath: "../private.dll" }, { downloadPath: "downloads/memories/0.8.0/Assembly-CSharp.dll" },
    { tag: "v0.8.0" }, { artifactUrl: "https://github.com/luyongyi/peak-memories/releases/download/v0.8.0/PeakReplayLab.dll" },
    { sourceRevision: "a".repeat(40) }, { releaseUrl: "https://github.com/luyongyi/peak-memories/releases/tag/v0.8.0" },
  ]) assert.throws(() => validateMemoriesRelease({ ...release, ...patch }), /Invalid pinned memories/);
  assert.throws(() => requirePublicMemoriesRelease(release), /unpublished development build/);
});

test("memories bytes reject wrong DLL, size, digest and non-assembly inputs", () => {
  assert.equal(verifyMemoriesBytes(bytes, release), bytes);
  assert.throws(() => verifyMemoriesBytes(Buffer.from("MZ"), release), /size mismatch/);
  assert.throws(() => verifyMemoriesBytes(Buffer.alloc(bytes.length), release), /not a PE/);
  const wrong = Buffer.from(bytes); wrong[3] ^= 1;
  assert.throws(() => verifyMemoriesBytes(wrong, release), /SHA-256 mismatch/);
});

test("local memories loader requires one explicit regular matching file and has no remote fallback", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "peak-memories-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dll = resolve(directory, "PeakReplayLab.dll");
  await writeFile(dll, bytes);
  await writeFile(resolve(directory, "private.peakrun"), "private replay");
  await writeFile(resolve(directory, "PeakReplayLab.cfg"), "private config");
  let remoteCalls = 0;
  const noRemote = { fetchImpl: () => { remoteCalls++; throw new Error("Unexpected remote fetch"); },
    execFileImpl: () => { remoteCalls++; throw new Error("Unexpected source lookup"); } };
  assert.deepEqual(await loadMemoriesArtifact(release, { localPath: dll, ...noRemote }), bytes);
  await assert.rejects(loadMemoriesArtifact(release, noRemote), /requires --memories-dll/);
  assert.equal(remoteCalls, 0, "development paths never invoke public verification or fallback");
  await assert.rejects(loadMemoriesArtifact(release, { localPath: directory }), /regular file/);
  const wrong = Buffer.from(bytes); wrong[3] ^= 1;
  await writeFile(dll, wrong);
  await assert.rejects(loadMemoriesArtifact(release, { localPath: dll }), /SHA-256 mismatch/);
  await writeFile(dll, Buffer.concat([bytes, Buffer.from("overflow")]));
  await assert.rejects(loadMemoriesArtifact(release, { localPath: dll }), /pinned size/);
  const source = await readFile(new URL("../lib/memories-release.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readdir\(|\bcp\(/, "DLL loader does not enumerate or copy neighboring files");
});

test("symlink DLL is refused even when its target matches the pinned bytes", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "peak-memories-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dll = resolve(directory, "PeakReplayLab.dll"), link = resolve(directory, "linked.dll");
  await writeFile(dll, bytes);
  try { await symlink(dll, link); }
  catch (error) { if (error.code === "EPERM") { t.skip("Windows symlink privilege unavailable"); return; } throw error; }
  await assert.rejects(loadMemoriesArtifact(release, { localPath: link }), /regular file/);
});

test("site defaults to memories, legacy requires explicit selection, and public mode never admits local development", async t => {
  assert.deepEqual(siteReleaseOptions(), { product: "memories", localPath: undefined });
  assert.deepEqual(siteReleaseOptions([], { PEAK_TRAIL_RECORDER_DLL: "legacy.dll" }), { product: "memories", localPath: undefined });
  assert.deepEqual(siteReleaseOptions(["--memories-dll", "current.dll"], { PEAK_TRAIL_MEMORIES_DLL: "other.dll" }), { product: "memories", localPath: "current.dll" });
  assert.deepEqual(siteReleaseOptions(["--download-product", "recorder"], { PEAK_TRAIL_RECORDER_DLL: "legacy.dll" }), { product: "recorder", localPath: "legacy.dll" });
  for (const args of [["--download-product", "other"], ["--memories-dll"], ["--memories-dll", "--open"], ["--memories-dll", "one", "--memories-dll", "two"]])
    assert.throws(() => siteReleaseOptions(args));
  await assert.rejects(loadSiteArtifact(release), /unpublished development build/);
  await assert.rejects(loadSiteArtifact(release, { preview: true }), /requires --memories-dll/);
  const directory = await mkdtemp(resolve(tmpdir(), "peak-memories-site-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dll = resolve(directory, "PeakReplayLab.dll"); await writeFile(dll, bytes);
  assert.deepEqual(await loadSiteArtifact(release, { preview: true, localPath: dll }), bytes);
  assert.throws(() => checkSiteBudget(1_000_000_001), /above.*budget/);
  assert.doesNotThrow(() => checkSiteBudget(1_020_000_000, { preview: true }));
  assert.doesNotThrow(() => checkSiteBudget(1_000_000_000));
  assert.throws(() => checkSiteBudget(NaN, { preview: true }), /Invalid staged/);
});

test("site entrypoints cannot select legacy bytes behind memories links or mix download products", () => {
  const link = `<a href="./${release.downloadPath}" download="${release.filename}">Download</a>`;
  assert.doesNotThrow(() => checkSiteDownloadReferences([link, "<title>Guide</title>"], release));
  const legacy = { filename: "PeakTrailRecorder.dll", downloadPath: "downloads/recorder/0.7.1/PeakTrailRecorder.dll" };
  assert.throws(() => checkSiteDownloadReferences([link], legacy), /does not match selected/);
  assert.throws(() => checkSiteDownloadReferences([link, `<a href="./${legacy.downloadPath}">Old</a>`], release), /does not match selected/);
  assert.throws(() => checkSiteDownloadReferences(["<title>No link</title>"], release), /no download link/);
  assert.throws(() => checkSiteDownloadReferences([link.replace(release.downloadPath, `${release.downloadPath}?old`) ], release), /does not match selected/);
  assert.throws(() => checkSiteDownloadReferences([link.replace('download="PeakReplayLab.dll"', 'download="PeakTrailRecorder.dll"')], release), /filename does not match/);
});

test("checker is offline metadata-only by default, verifies explicit bytes, and refuses --public", async t => {
  const platform = await mkdtemp(resolve(tmpdir(), "peak-memories-checker-"));
  t.after(() => rm(platform, { recursive: true, force: true }));
  await Promise.all(["tools/lib", "data/memories"].map(path => mkdir(resolve(platform, path), { recursive: true })));
  await Promise.all([
    copyFile(resolve(platformSource, "tools/check-memories-download.mjs"), resolve(platform, "tools/check-memories-download.mjs")),
    ...["site-release", "memories-release", "recorder-release"].map(name => copyFile(resolve(platformSource, `tools/lib/${name}.mjs`), resolve(platform, `tools/lib/${name}.mjs`))),
    writeFile(resolve(platform, "data/memories/release.json"), JSON.stringify(release)),
  ]);
  const script = resolve(platform, "tools/check-memories-download.mjs");
  assert.match((await execFileAsync(process.execPath, [script])).stdout, /Metadata only; DLL bytes and published source are not verified/);
  await assert.rejects(execFileAsync(process.execPath, [script, "--public"]), /unpublished development build/);
  const dll = resolve(platform, "PeakReplayLab.dll"); await writeFile(dll, bytes);
  assert.match((await execFileAsync(process.execPath, [script, "--dll", dll])).stdout, /bytes and SHA-256 verified; not a public release or source verification/);
  const wrong = Buffer.from(bytes); wrong[3] ^= 1; await writeFile(dll, wrong);
  await assert.rejects(execFileAsync(process.execPath, [script, "--dll", dll]), /SHA-256 mismatch/);
});

test("default HTML checker exempts only the new pinned memories path and validates the guide too", async t => {
  const platform = await mkdtemp(resolve(tmpdir(), "peak-memories-html-"));
  t.after(() => rm(platform, { recursive: true, force: true }));
  await Promise.all(["web/tools", "web/src", "tools/lib", "data/memories"].map(path => mkdir(resolve(platform, path), { recursive: true })));
  await Promise.all([
    copyFile(resolve(platformSource, "web/tools/verify.mjs"), resolve(platform, "web/tools/verify.mjs")),
    ...["site-release", "memories-release", "recorder-release"].map(name => copyFile(resolve(platformSource, `tools/lib/${name}.mjs`), resolve(platform, `tools/lib/${name}.mjs`))),
    ...["app", "protocol", "scene", "community-map-panel", "community-routes"].map(name => writeFile(resolve(platform, `web/src/${name}.js`), "export {};")),
    writeFile(resolve(platform, "data/memories/release.json"), JSON.stringify(release)),
  ]);
  const html = path => `<script type="importmap">{}</script><a href="./${path}" download>Download</a>`;
  await writeFile(resolve(platform, "web/index.html"), html(release.downloadPath));
  await writeFile(resolve(platform, "web/guide.html"), html(release.downloadPath));
  const script = resolve(platform, "web/tools/verify.mjs");
  await execFileAsync(process.execPath, [script]);
  await writeFile(resolve(platform, "web/guide.html"), html("downloads/recorder/0.7.1/PeakTrailRecorder.dll"));
  await assert.rejects(execFileAsync(process.execPath, [script]), /缺少本地静态资源/);
  await writeFile(resolve(platform, "web/guide.html"), html("downloads/memories/0.8.0/Other.dll"));
  await assert.rejects(execFileAsync(process.execPath, [script]), /缺少本地静态资源/);
});
