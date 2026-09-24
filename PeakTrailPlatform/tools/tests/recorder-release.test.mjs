import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadRecorderArtifact, MAX_RECORDER_BYTES, validateRecorderRelease, verifyRecorderBytes } from "../lib/recorder-release.mjs";

const bytes = Buffer.from("MZ recorder fixture");
const release = {
  schemaVersion: 1, version: "0.7.1", filename: "PeakTrailRecorder.dll",
  sourceRevision: "a".repeat(40), sha256: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length,
  artifactUrl: "https://github.com/luyongyi/peak-trail/releases/download/recorder-v0.7.1/PeakTrailRecorder.dll",
  downloadPath: "downloads/recorder/0.7.1/PeakTrailRecorder.dll",
};
const execFileAsync = promisify(execFile);

test("recorder release pins only the expected public repo, DLL and same-origin versioned path", () => {
  assert.deepEqual(validateRecorderRelease({ ...release, privateField: "do not publish" }), release);
  for (const patch of [
    { schemaVersion: 2 }, { version: "../0.7.1" }, { version: "0.7" },
    { filename: "Assembly-CSharp.dll" }, { sourceRevision: "main" }, { sha256: "bad" },
    { size: 0 }, { size: 2.5 }, { size: MAX_RECORDER_BYTES + 1 },
    { artifactUrl: release.artifactUrl.replace("https:", "http:") },
    { artifactUrl: release.artifactUrl.replace("github.com/", "github.com@evil.invalid/") },
    { artifactUrl: release.artifactUrl.replace("luyongyi", "someone") },
    { artifactUrl: release.artifactUrl + "?token=private" },
    { downloadPath: "../PeakTrailRecorder.dll" },
    { downloadPath: "downloads/recorder/0.7.1/Assembly-CSharp.dll" },
  ]) assert.throws(() => validateRecorderRelease({ ...release, ...patch }), /Invalid pinned recorder/);
});

test("recorder bytes must match size, PE header and digest", () => {
  assert.equal(verifyRecorderBytes(bytes, release), bytes);
  assert.throws(() => verifyRecorderBytes(Buffer.from("MZ"), release), /size mismatch/);
  assert.throws(() => verifyRecorderBytes(Buffer.alloc(bytes.length), release), /not a PE/);
  const wrong = Buffer.from(bytes);
  wrong[3] ^= 1;
  assert.throws(() => verifyRecorderBytes(wrong, release), /SHA-256 mismatch/);
});

test("download follows bounded public GitHub asset redirects without credentials", async () => {
  const calls = [];
  const result = await loadRecorderArtifact(release, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/fixture?signature=public" } })
      : new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  } });
  assert.deepEqual(result, bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, release.artifactUrl);
  for (const { options } of calls) {
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, undefined);
  }
});

test("unsafe and looping download redirects are refused", async () => {
  for (const location of ["https://evil.invalid/a", "http://release-assets.githubusercontent.com/a",
    "https://user:password@release-assets.githubusercontent.com/a", "https://release-assets.githubusercontent.com:444/a"])
    await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location } }) }), /outside public GitHub/);
  let calls = 0;
  await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/loop" } });
  } }), /outside public GitHub/);
  assert.equal(calls, 4);
});

test("download limits both declared size and streamed bytes before buffering", async () => {
  let canceled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); },
    cancel() { canceled = true; } });
  await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () => new Response(body) }), /exceeds pinned size/);
  assert.equal(canceled, true);
  await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () =>
    new Response(bytes, { headers: { "content-length": String(MAX_RECORDER_BYTES + 1) } }) }), /Content-Length mismatch/);
  await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () => new Response(bytes.subarray(0, 4)) }), /size mismatch/);
});

test("transient download errors retry, deterministic errors do not", async () => {
  let calls = 0;
  const sleeps = [];
  assert.deepEqual(await loadRecorderArtifact(release, {
    fetchImpl: async () => { calls++; if (calls === 1) throw new TypeError("connection closed");
      return calls === 2 ? new Response(null, { status: 503 }) : new Response(bytes); },
    sleepImpl: async ms => sleeps.push(ms),
  }), bytes);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [300, 600]);
  for (const response of [() => new Response(null, { status: 404 }), () => new Response(Buffer.from("MZ invalid fixture!"))]) {
    calls = 0;
    await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () => { calls++; return response(); }, sleepImpl: async () => {} }));
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(loadRecorderArtifact(release, { fetchImpl: async () => { calls++; throw new TypeError("down"); },
    sleepImpl: async () => {} }), /transport failed/);
  assert.equal(calls, 3);
});

test("local override must be one regular matching file and does not call the network", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "peaktrail-recorder-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "PeakTrailRecorder.dll");
  await writeFile(path, bytes);
  const options = { localPath: path, fetchImpl() { throw new Error("network must not be called"); } };
  assert.deepEqual(await loadRecorderArtifact(release, options), bytes);
  const wrong = Buffer.from(bytes); wrong[3] ^= 1;
  await writeFile(path, wrong);
  await assert.rejects(loadRecorderArtifact(release, options), /SHA-256 mismatch/);
  await mkdir(resolve(directory, "folder"));
  await assert.rejects(loadRecorderArtifact(release, { ...options, localPath: resolve(directory, "folder") }), /regular file/);
});

test("static HTML verification exempts only the manifest-pinned generated download", async t => {
  const platform = await mkdtemp(resolve(tmpdir(), "peaktrail-recorder-html-"));
  t.after(() => rm(platform, { recursive: true, force: true }));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  await Promise.all(["web/tools", "web/src", "tools/lib", "data/recorder"].map(path => mkdir(resolve(platform, path), { recursive: true })));
  await Promise.all([
    copyFile(resolve(source, "web/tools/verify.mjs"), resolve(platform, "web/tools/verify.mjs")),
    copyFile(resolve(source, "tools/lib/recorder-release.mjs"), resolve(platform, "tools/lib/recorder-release.mjs")),
    writeFile(resolve(platform, "data/recorder/release.json"), JSON.stringify(release)),
    ...["app", "protocol", "scene"].map(name => writeFile(resolve(platform, `web/src/${name}.js`), "export {};")),
  ]);
  const html = path => `<script type="importmap">{}</script><a href="./${path}" download>Download</a>`;
  await writeFile(resolve(platform, "web/index.html"), html(release.downloadPath));
  await execFileAsync(process.execPath, [resolve(platform, "web/tools/verify.mjs")]);
  await writeFile(resolve(platform, "web/index.html"), html("downloads/recorder/0.7.1/Other.dll"));
  await assert.rejects(execFileAsync(process.execPath, [resolve(platform, "web/tools/verify.mjs")]), /缺少本地静态资源/);
  await writeFile(resolve(platform, "web/index.html"), html(release.downloadPath));
  await writeFile(resolve(platform, "data/recorder/release.json"), JSON.stringify({ ...release, downloadPath: "../private.dll" }));
  await assert.rejects(execFileAsync(process.execPath, [resolve(platform, "web/tools/verify.mjs")]), /Invalid pinned recorder/);
});
