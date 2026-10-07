import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadMemoriesArtifact, MAX_BUILD_MANIFEST_BYTES, requirePublicMemoriesRelease, validateMemoriesRelease,
  verifyMemoriesBuildManifest, verifyMemoriesReleaseRecord, verifyMemoriesSourceRefs, verifyPublishedMemoriesSource } from "../lib/memories-release.mjs";
import { checkSiteBudget, loadSiteArtifact, readSiteStagingProfile, siteStagingProfile, validateSiteBuildProfile } from "../lib/site-release.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from("MZ public memories fixture");
const repo = "https://github.com/luyongyi/peak-memories";
const release = { schemaVersion: 1, product: "peak-memories", version: "0.8.0", filename: "PeakReplayLab.dll",
  fileVersion: "0.8.0.0", informationalVersion: `0.8.0+${"a".repeat(40)}`, channel: "release", releaseStatus: "published",
  sourceDirty: false, sourceRevision: "a".repeat(40), tag: "v0.8.0", repositoryUrl: repo,
  releaseUrl: `${repo}/releases/tag/v0.8.0`, artifactUrl: `${repo}/releases/download/v0.8.0/PeakReplayLab.dll`,
  sha256: sha256(bytes), size: bytes.length, downloadPath: "downloads/memories/0.8.0/PeakReplayLab.dll" };
const apiUrl = "https://api.github.com/repos/luyongyi/peak-memories/releases/tags/v0.8.0";
const manifestUrl = `${repo}/releases/download/v0.8.0/build-manifest.json`;
const refs = `${release.sourceRevision}\trefs/tags/v0.8.0\n`;
const manifest = { schemaVersion: 1, tag: release.tag, version: release.version, commit: release.sourceRevision,
  assembly: { name: "PeakReplayLab", version: release.fileVersion, fileVersion: release.fileVersion,
    informationalVersion: release.informationalVersion, mvid: "b".repeat(32), file: release.filename, bytes: release.size, sha256: release.sha256 },
  contracts: { passed: true } };
const execFileAsync = promisify(execFile);
const platformSource = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(options = {}) {
  const manifestBytes = options.manifestBytes || Buffer.from(JSON.stringify(options.manifest || manifest));
  const asset = (name, data) => ({ name, state: "uploaded", browser_download_url: `${repo}/releases/download/v0.8.0/${name}`,
    size: data.length, digest: `sha256:${sha256(data)}` });
  const record = options.record || { draft: false, prerelease: true, published_at: "2026-10-07T08:00:00Z", tag_name: release.tag,
    html_url: release.releaseUrl, assets: [asset(release.filename, bytes), asset("build-manifest.json", manifestBytes)] };
  const calls = [], gitCalls = [], sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.respond) { const response = await options.respond(url, init, calls.length); if (response) return response; }
    if (url === apiUrl) return new Response(options.recordBytes || JSON.stringify(record));
    if (url === manifestUrl) return new Response(manifestBytes);
    if (url === release.artifactUrl) return new Response(options.dllBytes || bytes);
    throw new Error("Unexpected fixture URL");
  };
  const execFileImpl = async (...args) => {
    gitCalls.push(args);
    if (options.gitResponse) return options.gitResponse(...args);
    return { stdout: options.refs ?? refs };
  };
  const sleepImpl = async value => { sleeps.push(value); };
  return { record, manifestBytes, calls, gitCalls, sleeps, fetchImpl, execFileImpl, sleepImpl };
}

test("published descriptor pins clean source, exact public URLs and identity without exposing local paths", () => {
  assert.deepEqual(validateMemoriesRelease({ ...release, privatePath: "C:/private" }), release);
  assert.deepEqual(requirePublicMemoriesRelease(release), release);
  for (const patch of [{ version: "00.8.0" }, { sourceDirty: true }, { releaseStatus: "draft" }, { sourceRevision: "main" },
    { informationalVersion: `0.8.0+${"b".repeat(40)}` }, { tag: "main" }, { tag: "v0.8.1" },
    { releaseUrl: `${repo}/releases/latest` }, { artifactUrl: `${repo}/releases/download/v0.8.0/Assembly-CSharp.dll` },
    { artifactUrl: "https://example.com/PeakReplayLab.dll" }, { artifactUrl: `${release.artifactUrl}?token=private` }])
    assert.throws(() => validateMemoriesRelease({ ...release, ...patch }), /Invalid pinned memories/);
});

test("public release API requires published non-draft tag and exactly one bound DLL and manifest, allowing prereleases", () => {
  const f = fixture();
  assert.equal(verifyMemoriesReleaseRecord(f.record, release).dll.url, release.artifactUrl);
  assert.doesNotThrow(() => verifyMemoriesReleaseRecord({ ...f.record, prerelease: false }, release));
  for (const patch of [{ draft: true }, { draft: undefined }, { published_at: null }, { published_at: 123 }, { published_at: "invalid" },
    { prerelease: undefined }, { tag_name: "v0.8.1" }, { html_url: `${repo}/releases/latest` }, { assets: [] },
    { assets: [...f.record.assets, f.record.assets[0]] }])
    assert.throws(() => verifyMemoriesReleaseRecord({ ...f.record, ...patch }, release));
  for (const patch of [{ state: "starter" }, { size: release.size + 1 }, { digest: `sha256:${"0".repeat(64)}` },
    { browser_download_url: "https://example.com/private.dll" }]) {
    const record = structuredClone(f.record); Object.assign(record.assets[0], patch);
    assert.throws(() => verifyMemoriesReleaseRecord(record, release));
  }
  const record = structuredClone(f.record); record.assets[1].size = MAX_BUILD_MANIFEST_BYTES + 1;
  assert.throws(() => verifyMemoriesReleaseRecord(record, release), /Invalid published memories asset/);
});

test("build manifest must bind exact tag, commit, assembly version, informational version, size, digest and contracts", () => {
  assert.equal(verifyMemoriesBuildManifest(manifest, release), manifest);
  for (const patch of [{ schemaVersion: 2 }, { tag: "v0.8.1" }, { version: "0.8.1" }, { commit: "b".repeat(40) }, { contracts: { passed: false } }])
    assert.throws(() => verifyMemoriesBuildManifest({ ...manifest, ...patch }, release), /build manifest does not match/);
  for (const patch of [{ name: "PeakTrailRecorder" }, { version: "0.7.4.0" }, { fileVersion: "0.7.4.0" },
    { informationalVersion: "0.8.0+main" }, { file: "Assembly-CSharp.dll" }, { bytes: release.size + 1 },
    { sha256: "0".repeat(64) }, { mvid: "bad" }])
    assert.throws(() => verifyMemoriesBuildManifest({ ...manifest, assembly: { ...manifest.assembly, ...patch } }, release), /build manifest does not match/);
});

test("source verification accepts lightweight or peeled annotated exact tags and rejects moved or malformed responses", () => {
  assert.equal(verifyMemoriesSourceRefs(refs, release), release.sourceRevision);
  assert.equal(verifyMemoriesSourceRefs(`${"b".repeat(40)}\trefs/tags/v0.8.0\n${release.sourceRevision}\trefs/tags/v0.8.0^{}\n`, release), release.sourceRevision);
  for (const value of ["", `${"b".repeat(40)}\trefs/tags/v0.8.0\n`, refs + refs,
    refs + `${"b".repeat(40)}\trefs/heads/main\n`, `${release.sourceRevision} refs/tags/v0.8.0`, "x".repeat(4097)])
    assert.throws(() => verifyMemoriesSourceRefs(value, release));
});

test("source lookup disables credential helpers, injected config and prompts, and bounds command response and time", async () => {
  const f = fixture();
  assert.equal(await verifyPublishedMemoriesSource(release, f), release.sourceRevision);
  const [command, args, options] = f.gitCalls[0];
  assert.equal(command, "git");
  assert.deepEqual(args, ["-c", "credential.helper=", "-c", "http.extraHeader=", "ls-remote", "--exit-code", "--tags", `${repo}.git`, "refs/tags/v0.8.0", "refs/tags/v0.8.0^{}"]);
  assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 4096);
  assert.equal(options.env.GIT_TERMINAL_PROMPT, "0"); assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(options.env.GIT_CONFIG_COUNT, "0"); assert.equal(options.env.GIT_CONFIG_PARAMETERS, "");
  assert.equal(options.cwd, tmpdir());
});

test("full anonymous published loader verifies API, source, build manifest and one DLL without authorization headers", async () => {
  const f = fixture();
  assert.deepEqual(await loadMemoriesArtifact(release, f), bytes);
  assert.deepEqual(f.calls.map(call => call.url), [apiUrl, manifestUrl, release.artifactUrl]);
  assert.equal(f.gitCalls.length, 1);
  for (const { init } of f.calls) {
    assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
    assert.ok(init.signal); assert.equal(Object.keys(init.headers).some(key => /authorization/i.test(key)), false);
  }
  assert.deepEqual(await loadSiteArtifact(release, f), bytes);
});

test("public local overrides are refused before network or source calls in preview and production", async () => {
  const f = fixture();
  await assert.rejects(loadMemoriesArtifact(release, { ...f, localPath: "private.dll" }), /does not accept a local DLL/);
  await assert.rejects(loadSiteArtifact(release, { ...f, localPath: "private.dll" }), /Public staging cannot use a local/);
  await assert.rejects(loadSiteArtifact(release, { ...f, preview: true, localPath: "private.dll" }), /does not accept a local DLL/);
  assert.equal(f.calls.length, 0); assert.equal(f.gitCalls.length, 0);
});

test("invalid public metadata or moved tags abort before downloading DLL", async () => {
  const f = fixture({ recordBytes: "invalid json" });
  await assert.rejects(loadMemoriesArtifact(release, f), /invalid JSON/);
  assert.equal(f.calls.length, 1); assert.equal(f.gitCalls.length, 0);
  const moved = fixture({ refs: `${"b".repeat(40)}\trefs/tags/v0.8.0\n` });
  await assert.rejects(loadMemoriesArtifact(release, moved), /pinned sourceRevision/);
  assert.deepEqual(moved.calls.map(call => call.url), [apiUrl]);
  const badManifest = fixture({ manifest: { ...manifest, commit: "b".repeat(40) } });
  await assert.rejects(loadMemoriesArtifact(release, badManifest), /build manifest does not match/);
  assert.deepEqual(badManifest.calls.map(call => call.url), [apiUrl, manifestUrl]);
});

test("manifest API digest and DLL hash are independently verified, without retrying mismatches", async () => {
  const f = fixture(); f.record.assets[1].digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(loadMemoriesArtifact(release, f), /metadata asset SHA-256 mismatch/);
  assert.equal(f.calls.length, 2); assert.equal(f.sleeps.length, 0);
  const wrong = Buffer.from(bytes); wrong[3] ^= 1;
  const badDll = fixture({ dllBytes: wrong });
  await assert.rejects(loadMemoriesArtifact(release, badDll), /DLL SHA-256 mismatch/);
  assert.equal(badDll.calls.length, 3); assert.equal(badDll.sleeps.length, 0);
});

test("asset downloads allow bounded HTTPS public GitHub storage redirects only", async () => {
  const storage = "https://release-assets.githubusercontent.com/fixture.dll?signature=public";
  const f = fixture({ respond: url => url === release.artifactUrl ? new Response(null, { status: 302, headers: { location: storage } })
    : url === storage ? new Response(bytes) : null });
  assert.deepEqual(await loadMemoriesArtifact(release, f), bytes);
  assert.equal(f.calls.at(-1).url, storage);
  for (const location of ["https://evil.example/fixture", "http://release-assets.githubusercontent.com/file",
    "https://user:password@release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com:444/file",
    "https://release-assets.githubusercontent.com/file#fragment"]) {
    const bad = fixture({ respond: url => url === release.artifactUrl ? new Response(null, { status: 302, headers: { location } }) : null });
    await assert.rejects(loadMemoriesArtifact(release, bad), /redirected outside public/);
    assert.equal(bad.calls.length, 3);
  }
});

test("API redirects and excessive asset redirect chains fail without falling back to authenticated downloads", async () => {
  const apiRedirect = fixture({ respond: url => url === apiUrl ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/api" } }) : null });
  await assert.rejects(loadMemoriesArtifact(release, apiRedirect), /redirected outside public/);
  assert.equal(apiRedirect.calls.length, 1);
  const loop = fixture({ respond: url => url === release.artifactUrl || url.startsWith("https://objects.githubusercontent.com/")
    ? new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/loop" } }) : null });
  await assert.rejects(loadMemoriesArtifact(release, loop), /redirected outside public/);
  assert.equal(loop.calls.length, 6);
});

test("stream and Content-Length limits reject oversized metadata and mismatched or truncated DLLs", async () => {
  const hugeApi = fixture({ recordBytes: Buffer.alloc(256 * 1024 + 1, 0x20) });
  await assert.rejects(loadMemoriesArtifact(release, hugeApi), /exceeds pinned size or metadata limit/);
  assert.equal(hugeApi.calls.length, 1);
  for (const dllBytes of [Buffer.concat([bytes, Buffer.from("extra")]), bytes.subarray(0, bytes.length - 1)]) {
    const f = fixture({ dllBytes });
    await assert.rejects(loadMemoriesArtifact(release, f), /exceeds pinned size|download size mismatch/);
    assert.equal(f.calls.length, 3);
  }
  const f = fixture({ respond: url => url === release.artifactUrl ? new Response(bytes, { headers: { "content-length": String(bytes.length + 1) } }) : null });
  await assert.rejects(loadMemoriesArtifact(release, f), /Content-Length mismatch/);
});

test("transient HTTP and transport errors retry three times, but public absence fails immediately", async () => {
  let attempts = 0;
  const transient = fixture({ respond: url => url === apiUrl && ++attempts < 3 ? new Response(null, { status: 503 }) : null });
  assert.deepEqual(await loadMemoriesArtifact(release, transient), bytes);
  assert.deepEqual(transient.sleeps, [300, 600]);
  const unavailable = fixture({ respond: () => { throw new TypeError("network"); } });
  await assert.rejects(loadMemoriesArtifact(release, unavailable), /transport failed/);
  assert.equal(unavailable.calls.length, 3); assert.deepEqual(unavailable.sleeps, [300, 600]);
  const absent = fixture({ respond: () => new Response(null, { status: 404 }) });
  await assert.rejects(loadMemoriesArtifact(release, absent), /HTTP 404/);
  assert.equal(absent.calls.length, 1); assert.equal(absent.sleeps.length, 0);
});

test("source transport retries are bounded while missing or moved tags never retry", async () => {
  let attempts = 0;
  const retry = fixture({ gitResponse: () => { if (++attempts < 3) throw Object.assign(new Error("timeout"), { killed: true }); return { stdout: refs }; } });
  assert.equal(await verifyPublishedMemoriesSource(release, retry), release.sourceRevision);
  assert.deepEqual(retry.sleeps, [300, 600]);
  const missing = fixture({ gitResponse: () => { throw Object.assign(new Error("missing"), { code: 2 }); } });
  await assert.rejects(verifyPublishedMemoriesSource(release, missing), /tag is missing/);
  assert.equal(missing.gitCalls.length, 1);
  const moved = fixture({ refs: `${"b".repeat(40)}\trefs/tags/v0.8.0\n` });
  await assert.rejects(verifyPublishedMemoriesSource(release, moved), /pinned sourceRevision/);
  assert.equal(moved.gitCalls.length, 1);
});

test("concurrent checks share only in-flight work and later checks detect moved tags instead of using cached successes", async () => {
  let gitRefs = refs;
  const f = fixture({ gitResponse: () => ({ stdout: gitRefs }) });
  const result = await Promise.all([loadMemoriesArtifact(release, f), loadMemoriesArtifact(release, f)]);
  assert.deepEqual(result, [bytes, bytes]); assert.equal(f.calls.length, 3); assert.equal(f.gitCalls.length, 1);
  gitRefs = `${"b".repeat(40)}\trefs/tags/v0.8.0\n`;
  await assert.rejects(loadMemoriesArtifact(release, f), /pinned sourceRevision/);
  assert.equal(f.calls.length, 4); assert.equal(f.gitCalls.length, 2);
  gitRefs = refs;
  assert.deepEqual(await loadMemoriesArtifact(release, f), bytes);
  assert.equal(f.calls.length, 7); assert.equal(f.gitCalls.length, 3);
});

test("public server budget is an explicit profile, preserving Pages cap and excluding preview", () => {
  assert.equal(siteStagingProfile(), "pages");
  assert.equal(siteStagingProfile(["--profile", "server"]), "server");
  assert.equal(siteStagingProfile(["--profile", "pages"], { configuredProfile: "server" }), "pages");
  assert.throws(() => siteStagingProfile(["--profile", "server"], { preview: true }), /cannot use --preview/);
  for (const args of [["--profile"], ["--profile", "unknown"], ["--profile", "pages", "--profile", "server"]]) assert.throws(() => siteStagingProfile(args));
  assert.doesNotThrow(() => checkSiteBudget(2_000_000_000, { profile: "server" }));
  assert.throws(() => checkSiteBudget(2_000_000_001, { profile: "server" }), /server 2 GB/);
  assert.throws(() => checkSiteBudget(1_000_000_001), /GitHub Pages 1 GB/);
  assert.throws(() => checkSiteBudget(1, { preview: true, profile: "server" }), /cannot use --preview/);
});

test("tracked profile is strict, absent config defaults to Pages, and explicit Pages overrides reviewed server config", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "peak-site-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "site-build-profile.json");
  assert.equal(await readSiteStagingProfile(path), "pages");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, profile: "server" }));
  assert.equal(await readSiteStagingProfile(path), "server");
  assert.equal(await readSiteStagingProfile(path, ["--profile", "pages"]), "pages");
  await assert.rejects(readSiteStagingProfile(path, [], { preview: true }), /cannot use --preview/);
  assert.equal(await readSiteStagingProfile(path, ["--profile", "pages"], { preview: true }), "pages");
  for (const value of [{ schemaVersion: 2, profile: "server" }, { schemaVersion: 1, profile: "unknown" },
    { schemaVersion: 1, profile: "server", maxBytes: 999999999999 }, null]) assert.throws(() => validateSiteBuildProfile(value), /Invalid tracked/);
  await writeFile(path, '{"schemaVersion":1,"profile":"unknown"}');
  await assert.rejects(readSiteStagingProfile(path), /Invalid tracked/);
  await writeFile(path, "not JSON"); await assert.rejects(readSiteStagingProfile(path), /Invalid tracked.*JSON/);
});

test("published checker stays metadata-only by default and rejects local substitutes without fetching", async t => {
  const platform = await mkdtemp(resolve(tmpdir(), "peak-public-checker-"));
  t.after(() => rm(platform, { recursive: true, force: true }));
  await Promise.all(["tools/lib", "data/memories"].map(path => mkdir(resolve(platform, path), { recursive: true })));
  await Promise.all([
    copyFile(resolve(platformSource, "tools/check-memories-download.mjs"), resolve(platform, "tools/check-memories-download.mjs")),
    ...["site-release", "memories-release", "recorder-release"].map(name => copyFile(resolve(platformSource, `tools/lib/${name}.mjs`), resolve(platform, `tools/lib/${name}.mjs`))),
    writeFile(resolve(platform, "data/memories/release.json"), JSON.stringify(release)),
  ]);
  const script = resolve(platform, "tools/check-memories-download.mjs");
  const result = await execFileAsync(process.execPath, [script]);
  assert.match(result.stdout, /release descriptor valid.*Metadata only.*Run --public/);
  await assert.rejects(execFileAsync(process.execPath, [script, "--dll", "private.dll"]), /only for local development/);
  await assert.rejects(execFileAsync(process.execPath, [script, "--public", "--dll", "private.dll"]), /cannot use --dll/);
  const serve = await readFile(resolve(platformSource, "tools/serve-site.mjs"), "utf8");
  assert.match(serve, /previewArgs\.push\("--profile", "pages"\)/, "local preview explicitly overrides the production profile");
});
