import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePublishedReplay, updateReplayRelease } from "../update-packet-replay-release.mjs";

const version = "2026.11.08.1", previousVersion = "2026.10.31.2";
const filename = "peak-packet-replay-windows.zip";
const required = ["Play-Replay.cmd", "README.zh-CN.txt", "release.json", "Prepare-NativeReplay.ps1", "Start-NativeReplay.ps1",
  "bridge/PeakPacketReplay.NativeBridge.BuildInput.dll", "tools/PeakPacketReplay.WindowsPatch.exe",
  "tools/PeakPacketReplay.WindowsPatch.dll", "licenses/dotnet-LICENSE.TXT", "licenses/Mono.Cecil-LICENSE.txt"];
function zip(extra = []) {
  const local = [], central = [], names = [...required, ...extra];
  let offset = 0;
  for (const item of names) {
    const name = Buffer.from(`peak-packet-replay-windows/${item}`), header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name); central.push(entry, name); offset += header.length + name.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const bytes = zip();
function descriptor(selected = version, body = bytes) {
  return { schemaVersion: 1, version: selected, gameVersion: "3.0.1", gameBuildId: "26155610", platform: "windows-x64",
    filename, downloadPath: `downloads/${filename}`, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"),
    artifactUrl: `https://github.com/luyongyi/peak-trail/releases/download/packet-replay-windows-${selected}/${filename}` };
}
function metadata(release = descriptor()) {
  return { tag_name: `packet-replay-windows-${release.version}`, draft: false,
    assets: [{ name: filename, state: "uploaded", size: release.bytes, digest: `sha256:${release.sha256}`, browser_download_url: release.artifactUrl }] };
}
function source({ release = descriptor(), data = metadata(release), body = bytes, calls = [], beforeMetadata } = {}) {
  return async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, undefined);
    if (url === `https://api.github.com/repos/luyongyi/peak-trail/releases/tags/packet-replay-windows-${release.version}`) {
      assert.equal(options.redirect, "error");
      await beforeMetadata?.();
      return Response.json(data);
    }
    assert.equal(url, release.artifactUrl);
    assert.equal(options.redirect, "manual");
    return new Response(body, { headers: { "content-length": String(body.length) } });
  };
}
async function fixture(t, previous = descriptor(previousVersion)) {
  const directory = await mkdtemp(join(tmpdir(), "peak-replay-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "release.json"), original = JSON.stringify(previous, null, 2) + "\n";
  await writeFile(manifestPath, original);
  return { manifestPath, directory, original };
}

test("publisher takes only an exact version and downloads anonymously from the fixed repository", async () => {
  const calls = [];
  assert.deepEqual(await resolvePublishedReplay(version, { fetchImpl: source({ calls }) }), descriptor());
  assert.equal(calls.length, 2);
  for (const value of ["latest", "../other", "https://example.test/archive.zip", "2026.11.08.1\n", "2026.11.08.1; echo bad", undefined]) {
    await assert.rejects(resolvePublishedReplay(value, { fetchImpl: () => assert.fail("invalid input must not reach the network") }), /existing Windows replay version/);
  }
});

test("publisher refuses wrong, draft, ambiguous, incomplete or redirected Release assets", async () => {
  const asset = metadata().assets[0];
  for (const data of [
    { ...metadata(), tag_name: "unrelated" }, { ...metadata(), draft: true }, { ...metadata(), assets: [] },
    { ...metadata(), assets: [asset, asset] }, { ...metadata(), assets: [{ ...asset, state: "new" }] },
    { ...metadata(), assets: [{ ...asset, digest: null }] },
    { ...metadata(), assets: [{ ...asset, browser_download_url: "https://other.example/archive.zip" }] },
    { ...metadata(), assets: [{ ...asset, size: 129 * 1024 * 1024 }] },
  ]) {
    const calls = [];
    await assert.rejects(resolvePublishedReplay(version, { fetchImpl: source({ data, calls }) }));
    assert.equal(calls.length, 1, "invalid metadata must not start an artifact download");
  }
  await assert.rejects(resolvePublishedReplay(version, { fetchImpl: async () => new Response(null, { status: 404 }) }), /HTTP 404/);
  await assert.rejects(resolvePublishedReplay(version, { fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1)) }), /metadata exceeds limit/);
});

test("verified new version updates only the descriptor and leaves no staging file", async t => {
  const { manifestPath, directory } = await fixture(t);
  const result = await updateReplayRelease(version, { manifestPath, fetchImpl: source() });
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), descriptor());
  assert.deepEqual(await readdir(directory), ["release.json"]);
});

test("unchanged version is still fully verified and does not rewrite the descriptor", async t => {
  const { manifestPath, original } = await fixture(t, descriptor());
  const calls = [];
  assert.equal((await updateReplayRelease(version, { manifestPath, fetchImpl: source({ calls }) })).changed, false);
  assert.equal(calls.length, 2);
  assert.equal(await readFile(manifestPath, "utf8"), original);
});

test("bad digest or unsafe ZIP never changes the selected website download", async t => {
  const { manifestPath, original } = await fixture(t);
  const corrupt = Buffer.from(bytes); corrupt[31] ^= 1;
  await assert.rejects(updateReplayRelease(version, { manifestPath, fetchImpl: source({ body: corrupt }) }), /SHA-256/);
  const unsafe = zip(["capture.peaknet"]), release = descriptor(version, unsafe);
  await assert.rejects(updateReplayRelease(version, { manifestPath, fetchImpl: source({ release, body: unsafe }) }), /Unsafe or private/);
  assert.equal(await readFile(manifestPath, "utf8"), original);
});

test("replacing a published asset under the same version requires a new version", async t => {
  const { manifestPath, original } = await fixture(t, descriptor());
  const replacement = zip(["new-file.txt"]), release = descriptor(version, replacement);
  await assert.rejects(updateReplayRelease(version, { manifestPath, fetchImpl: source({ release, body: replacement }) }), /changed under an existing version/);
  assert.equal(await readFile(manifestPath, "utf8"), original);
});

test("an intervening descriptor edit is preserved instead of overwritten after download", async t => {
  const { manifestPath } = await fixture(t);
  const intervening = descriptor("2026.11.08.2");
  await assert.rejects(updateReplayRelease(version, { manifestPath, fetchImpl: source({
    beforeMetadata: () => writeFile(manifestPath, JSON.stringify(intervening)),
  }) }), /changed during verification/);
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), intervening);
});
