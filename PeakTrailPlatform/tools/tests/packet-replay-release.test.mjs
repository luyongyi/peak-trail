import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePacketReplayRelease, loadPacketReplayArtifact, verifyPacketReplayBytes, inspectPacketReplayZip } from "../lib/packet-replay-release.mjs";

const required = ["Play-Replay.cmd", "README.zh-CN.txt", "release.json", "Prepare-NativeReplay.ps1", "Start-NativeReplay.ps1",
  "bridge/PeakPacketReplay.NativeBridge.BuildInput.dll", "tools/PeakPacketReplay.WindowsPatch.exe",
  "tools/PeakPacketReplay.WindowsPatch.dll", "licenses/dotnet-LICENSE.TXT", "licenses/Mono.Cecil-LICENSE.txt"];
function zip(names = required, { localNames = names, flags = 0, method = 0, windowsNames = false } = {}) {
  let localSize = 0;
  const local = [], entries = [];
  for (let index = 0; index < names.length; index++) {
    const encode = name => Buffer.from(windowsNames ? name.replaceAll("/", "\\") : name);
    const name = encode(`peak-packet-replay-windows/${names[index]}`), localName = encode(`peak-packet-replay-windows/${localNames[index]}`);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(1, 18); header.writeUInt32LE(1, 22); header.writeUInt16LE(localName.length, 26);
    local.push(header, localName, Buffer.from("x"));
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(flags, 8); entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(1, 20); entry.writeUInt32LE(1, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(localSize, 42);
    entries.push(entry, name); localSize += header.length + localName.length + 1;
  }
  const central = Buffer.concat(entries), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(localSize, 16);
  return Buffer.concat([...local, central, end]);
}
const bytes = zip();
function descriptor(body = bytes) {
  return { schemaVersion: 1, version: "2026.10.31.2", gameVersion: "3.0.1", gameBuildId: "26155610", platform: "windows-x64",
    filename: "peak-packet-replay-windows.zip", downloadPath: "downloads/peak-packet-replay-windows.zip", bytes: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    artifactUrl: "https://github.com/luyongyi/peak-trail/releases/download/packet-replay-windows-2026.10.31.2/peak-packet-replay-windows.zip" };
}
const release = descriptor();
const inGameFiles = ["README.zh-CN.txt", "release.json", "BepInEx/patchers/PeakPacketReplay.Loader.dll",
  "BepInEx/plugins/PeakPacketReplay/PeakPacketReplay.dll"];
function inGameDescriptor(body) {
  return { ...descriptor(body), version: "2026.11.08.1",
    artifactUrl: "https://github.com/luyongyi/peak-trail/releases/download/packet-replay-windows-2026.11.08.1/peak-packet-replay-windows.zip" };
}

test("new releases require the in-game DLL layout and keep the pinned old release readable", () => {
  const value = zip([...inGameFiles, "licenses/Mono.Cecil-LICENSE.txt"]);
  assert.equal(verifyPacketReplayBytes(value, inGameDescriptor(value)), value);
  assert.equal(verifyPacketReplayBytes(bytes, release), bytes);
  assert.throws(() => verifyPacketReplayBytes(bytes, inGameDescriptor(bytes)), /required in-game/);
  for (const missing of [0, 1, 2, 3]) {
    const incomplete = zip([...inGameFiles.filter((_, i) => i !== missing), "licenses/NOTICE.txt"]);
    assert.throws(() => verifyPacketReplayBytes(incomplete, inGameDescriptor(incomplete)), /required in-game/);
  }
});

test("in-game packages reject external launchers, stale tools, game assemblies and extra DLLs", () => {
  for (const extra of ["Play-Replay.cmd", "Start-NativeReplay.ps1", "tools/patch.exe", "BepInEx/plugins/other.dll",
    "PhotonUnityNetworking.dll", "Photon3Unity3D.dll", "level.bundle", "resources.assets"]) {
    const value = zip([...inGameFiles, extra]);
    assert.throws(() => verifyPacketReplayBytes(value, inGameDescriptor(value)), /unexpected file|Unsafe or private/);
  }
});

test("Windows ZIP manifest pins exact repository, version, filename, platform and digest", () => {
  assert.deepEqual(validatePacketReplayRelease(release), release);
  for (const change of [{ version: "latest" }, { gameBuildId: "26134529" }, { gameVersion: "3.0" }, { platform: "linux" },
    { filename: "Assembly-CSharp.dll" }, { downloadPath: "../private.zip" }, { bytes: 0 }, { bytes: 128 * 1024 * 1024 + 1 },
    { sha256: "invalid" }, { privateKey: "not-public" }, { artifactUrl: release.artifactUrl.replace("luyongyi", "other") }])
    assert.throws(() => validatePacketReplayRelease({ ...release, ...change }), /manifest/);
});

test("ZIP verifies exact bytes, usable layout and matching local/central entries", () => {
  assert.equal(verifyPacketReplayBytes(bytes, release), bytes);
  assert.deepEqual(inspectPacketReplayZip(bytes), { entries: required.length, expandedBytes: required.length });
  assert.throws(() => verifyPacketReplayBytes(bytes.subarray(0, 10), release), /size/);
  const corrupt = Buffer.from(bytes); corrupt[31] ^= 1;
  assert.throws(() => verifyPacketReplayBytes(corrupt, release), /SHA-256/);
  const mismatched = zip(required, { localNames: required.map((name, index) => index === 0 ? "Fake-Replay.cmd" : name) });
  assert.throws(() => verifyPacketReplayBytes(mismatched, descriptor(mismatched)), /mismatch/);
});

test("ZIP rejects traversal, duplicate Windows names, private data and native game assemblies", () => {
  for (const extra of ["../outside.txt", "folder//bad.txt", "PLAY-REPLAY.cmd", "capture.peaknet", "steam-ticket.txt", "Assembly-CSharp.dll", "UnityEngine.CoreModule.dll", "logs/a.ndjson"]) {
    const value = zip([...required, extra]);
    assert.throws(() => verifyPacketReplayBytes(value, descriptor(value)), /Unsafe or private/);
  }
  const missing = zip([...required.slice(1), "other.txt"]);
  assert.throws(() => verifyPacketReplayBytes(missing, descriptor(missing)), /missing required/);
});

test("legacy Windows ZIP separators normalize before traversal and duplicate checks", () => {
  const legacy = zip(required, { windowsNames: true });
  assert.equal(verifyPacketReplayBytes(legacy, descriptor(legacy)), legacy);
  for (const extra of ["../outside.txt", "PLAY-REPLAY.cmd", "folder\\..\\private.key"]) {
    const value = zip([...required, extra], { windowsNames: true });
    assert.throws(() => inspectPacketReplayZip(value), /Unsafe or private/);
  }
});

test("ZIP rejects malformed bounds, encrypted archives, split archives and unsupported methods", () => {
  for (const options of [{ flags: 1 }, { method: 9 }]) assert.throws(() => inspectPacketReplayZip(zip(required, options)), /Unsupported/);
  for (const mutation of [
    value => value.writeUInt32LE(0xffffffff, value.length - 6),
    value => value.writeUInt16LE(1, value.length - 18),
    value => value.writeUInt32LE(0x07064b50, value.length - 22),
  ]) { const value = Buffer.from(bytes); mutation(value); assert.throws(() => inspectPacketReplayZip(value), /ZIP/); }
});

test("local ZIP override still requires the exact pinned package", async t => {
  const directory = await mkdtemp(join(tmpdir(), "peak-packet-zip-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "replay.zip"); await writeFile(file, bytes);
  assert.deepEqual(await loadPacketReplayArtifact(release, { localPath: file }), bytes);
  const corrupt = Buffer.from(bytes); corrupt[31] ^= 1; await writeFile(file, corrupt);
  await assert.rejects(loadPacketReplayArtifact(release, { localPath: file }), /SHA-256/);
  await writeFile(file, bytes.subarray(0, 5));
  await assert.rejects(loadPacketReplayArtifact(release, { localPath: file }), /size\/type/);
});

test("anonymous download accepts only GitHub public asset redirects and checks streamed bytes", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "manual"); assert.equal(options.headers.Authorization, undefined);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/example?signature=public" } })
      : new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };
  assert.deepEqual(await loadPacketReplayArtifact(release, { fetchImpl }), bytes);
  assert.equal(calls[0], release.artifactUrl); assert.equal(calls.length, 2);
  for (const location of ["https://evil.example/file.zip", "http://release-assets.githubusercontent.com/a", "https://user:pass@release-assets.githubusercontent.com/a", "/login"]) {
    await assert.rejects(loadPacketReplayArtifact(release, { fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }), /outside public/);
  }
});

test("download bounds and SHA mismatches fail before staging without retries", async () => {
  for (const response of [() => new Response(bytes, { headers: { "content-length": "1" } }),
    () => new Response(Buffer.concat([bytes, Buffer.from("extra")])), () => new Response(Buffer.alloc(bytes.length)),
    () => new Response(null, { status: 404 })]) {
    let attempts = 0;
    await assert.rejects(loadPacketReplayArtifact(release, { fetchImpl: async () => { attempts++; return response(); } }));
    assert.equal(attempts, 1);
  }
});

test("only temporary transport failures retry, with a bounded attempt count", async () => {
  let attempts = 0; const waits = [];
  assert.deepEqual(await loadPacketReplayArtifact(release, { fetchImpl: async () => ++attempts < 3 ? new Response(null, { status: 503 }) : new Response(bytes), sleepImpl: async ms => waits.push(ms) }), bytes);
  assert.equal(attempts, 3); assert.deepEqual(waits, [300, 600]);
  attempts = 0;
  await assert.rejects(loadPacketReplayArtifact(release, { fetchImpl: async () => { attempts++; throw new Error("network"); }, sleepImpl: async () => {} }), /transport/);
  assert.equal(attempts, 3);
});
