import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_PACKET_REPLAY_BYTES = 128 * 1024 * 1024;
export const PACKET_REPLAY_FILENAME = "peak-packet-replay-windows.zip";
const RELEASE_ROOT = "https://github.com/luyongyi/peak-trail/releases/download/";
const REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const KEYS = ["schemaVersion", "version", "gameVersion", "gameBuildId", "platform", "filename", "downloadPath", "bytes", "sha256", "artifactUrl"];
const REQUIRED = ["Play-Replay.cmd", "README.zh-CN.txt", "release.json", "Prepare-NativeReplay.ps1", "Start-NativeReplay.ps1",
  "bridge/PeakPacketReplay.NativeBridge.BuildInput.dll", "tools/PeakPacketReplay.WindowsPatch.exe",
  "tools/PeakPacketReplay.WindowsPatch.dll", "licenses/dotnet-LICENSE.TXT", "licenses/Mono.Cecil-LICENSE.txt"];

// This identifies the tested distribution, not a claim that its private build
// inputs or the user's installed game assemblies are published in this repository.
export function validatePacketReplayRelease(value) {
  if (!value || Object.keys(value).length !== KEYS.length || Object.keys(value).some(key => !KEYS.includes(key))
      || value.schemaVersion !== 1 || !/^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(value.version || "")
      || value.gameVersion !== "3.0.1" || value.gameBuildId !== "26155610" || value.platform !== "windows-x64"
      || value.filename !== PACKET_REPLAY_FILENAME || value.downloadPath !== `downloads/${PACKET_REPLAY_FILENAME}`
      || !Number.isSafeInteger(value.bytes) || value.bytes < 22 || value.bytes > MAX_PACKET_REPLAY_BYTES
      || !/^[a-f0-9]{64}$/.test(value.sha256 || "")
      || value.artifactUrl !== `${RELEASE_ROOT}packet-replay-windows-${value.version}/${PACKET_REPLAY_FILENAME}`)
    throw new Error("Invalid pinned Windows packet replay release manifest");
  return Object.fromEntries(KEYS.map(key => [key, value[key]]));
}

export async function readPacketReplayRelease(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error("Invalid packet replay manifest file");
  return validatePacketReplayRelease(JSON.parse(await readFile(path, "utf8")));
}

// Inspect the ZIP directory without unpacking or executing anything. Hash/size
// pinning verifies the entire byte stream; these checks catch malformed packages,
// accidental recordings and missing launchers before a release can be advertised.
export function inspectPacketReplayZip(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_PACKET_REPLAY_BYTES) throw new Error("Invalid replay ZIP size/type");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error("Invalid replay ZIP directory");
  const count = bytes.readUInt16LE(end + 10), directoryBytes = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count < REQUIRED.length || count > 2048 || count !== bytes.readUInt16LE(end + 8) || start + directoryBytes !== end)
    throw new Error("Invalid replay ZIP directory bounds");
  let offset = start, expanded = 0;
  const names = new Set(), prefix = "peak-packet-replay-windows/";
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid replay ZIP entry");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20), uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameLength + extra + comment, local = bytes.readUInt32LE(offset + 42);
    if (next > end || (flags & 1) || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34) !== 0
        || ((bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000) === 0xa000 || compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw new Error("Unsupported replay ZIP entry");
    // The existing Windows packager emitted backslashes. Normalize them before
    // path/duplicate checks, while matching the raw name in both ZIP headers.
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replaceAll("\\", "/");
    const identity = name.toLowerCase();
    if (!name.startsWith(prefix) || name.endsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(name)
        || name.split("/").some(part => !part || part === "." || part === "..") || names.has(identity)
        || /(?:^|\/)(?:Assembly-CSharp(?:-[^.]+)?\.dll|UnityEngine[^/]*\.dll|steam[^/]*|\.env[^/]*|.*\.(?:peaknet|ndjson|log|pem|key))$/i.test(name))
      throw new Error("Unsafe or private replay ZIP entry");
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags
        || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 26) !== nameLength)
      throw new Error("Replay ZIP local entry mismatch");
    const localName = local + 30, body = localName + nameLength + bytes.readUInt16LE(local + 28);
    if (body + compressed > start || !bytes.subarray(localName, localName + nameLength).equals(bytes.subarray(offset + 46, offset + 46 + nameLength)))
      throw new Error("Replay ZIP entry bounds mismatch");
    expanded += uncompressed;
    if (expanded > 512 * 1024 * 1024) throw new Error("Replay ZIP expanded size exceeds limit");
    names.add(identity); offset = next;
  }
  if (offset !== end || REQUIRED.some(name => !names.has((prefix + name).toLowerCase()))) throw new Error("Replay ZIP is missing required launchers or runtime files");
  return { entries: count, expandedBytes: expanded };
}

export function verifyPacketReplayBytes(bytes, release) {
  release = validatePacketReplayRelease(release);
  if (bytes.length !== release.bytes) throw new Error("Replay ZIP size mismatch");
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("Replay ZIP SHA-256 mismatch");
  inspectPacketReplayZip(bytes);
  return bytes;
}

export async function loadPacketReplayArtifact(release, { localPath, fetchImpl = globalThis.fetch, sleepImpl = delay } = {}) {
  release = validatePacketReplayRelease(release);
  if (localPath) {
    const info = await lstat(localPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== release.bytes) throw new Error("Local replay ZIP size/type mismatch");
    return verifyPacketReplayBytes(await readFile(localPath), release);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return verifyPacketReplayBytes(await download(release, fetchImpl), release); }
    catch (error) {
      if (!error.retryable || attempt === 2) throw error;
      await sleepImpl(300 * 2 ** attempt);
    }
  }
}

async function download(release, fetchImpl) {
  const signal = AbortSignal.timeout(60_000);
  let url = release.artifactUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try { response = await fetchImpl(url, { redirect: "manual", signal, headers: { "User-Agent": "PeakTrail-PacketReplay-Release", Accept: "application/octet-stream" } }); }
    catch { throw Object.assign(new Error("Replay release download transport failed"), { retryable: true }); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      let next;
      try { next = new URL(response.headers.get("location"), url); } catch { /* rejected below */ }
      if (redirects === 3 || !next || next.protocol !== "https:" || next.username || next.password || next.port || next.hash || !REDIRECT_HOSTS.has(next.hostname))
        throw new Error("Replay release redirected outside public GitHub asset storage");
      url = next.href; continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Replay release download returned HTTP ${response.status}`), { retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== release.bytes)) {
      await response.body?.cancel(); throw new Error("Replay ZIP Content-Length mismatch");
    }
    if (!response.body) throw new Error("Replay release returned no download body");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > release.bytes) { await reader.cancel(); throw new Error("Replay ZIP download exceeds pinned size"); }
        chunks.push(value);
      }
    } catch (error) {
      if (["AbortError", "TimeoutError", "TypeError"].includes(error.name)) throw Object.assign(new Error("Replay release download stream failed"), { retryable: true });
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Replay release has too many redirects");
}
