import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

export const MAX_MEMORIES_BYTES = 64 * 1024 * 1024;
export const MAX_BUILD_MANIFEST_BYTES = 2 * 1024 * 1024;
const REPOSITORY = "https://github.com/luyongyi/peak-memories";
const RELEASE_ROOT = `${REPOSITORY}/releases/download/`;
const REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const execFileAsync = promisify(execFile);
const inFlight = new Map(), implementationIds = new WeakMap();
let nextImplementationId = 1;

// Development descriptors describe a local dirty build. Published descriptors
// pin a clean source tag and artifact; validation alone does not verify either.
export function validateMemoriesRelease(value) {
  const version = value?.version || "";
  if (value?.schemaVersion !== 1 || value.product !== "peak-memories"
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) || value.filename !== "PeakReplayLab.dll"
      || value.fileVersion !== `${version}.0`
      || !new RegExp(`^${version.replaceAll(".", "\\.")}\\+[a-f0-9]{40}$`).test(value.informationalVersion || "")
      || value.repositoryUrl !== REPOSITORY
      || !/^[a-f0-9]{64}$/.test(value.sha256 || "")
      || !Number.isSafeInteger(value.size) || value.size < 2 || value.size > MAX_MEMORIES_BYTES
      || value.downloadPath !== `downloads/memories/${version}/PeakReplayLab.dll`) throw new Error("Invalid pinned memories descriptor");
  if (value.channel === "development") {
    if (value.releaseStatus !== "unreleased" || value.sourceDirty !== true
        || value.artifactUrl !== undefined || value.releaseUrl !== undefined || value.tag !== undefined
        || value.sourceRevision !== undefined) throw new Error("Invalid pinned memories development descriptor");
  } else if (value.channel === "release") {
    if (value.releaseStatus !== "published" || value.sourceDirty !== false
        || !/^[a-f0-9]{40}$/.test(value.sourceRevision || "")
        || value.informationalVersion !== `${version}+${value.sourceRevision}`
        || value.tag !== `v${version}` || value.releaseUrl !== `${REPOSITORY}/releases/tag/v${version}`
        || value.artifactUrl !== `${RELEASE_ROOT}v${version}/PeakReplayLab.dll`)
      throw new Error("Invalid pinned memories published descriptor");
  } else throw new Error("Invalid pinned memories descriptor channel");
  return {
    schemaVersion: 1, product: value.product, version, filename: value.filename,
    fileVersion: value.fileVersion, informationalVersion: value.informationalVersion,
    channel: value.channel, releaseStatus: value.releaseStatus, sourceDirty: value.sourceDirty,
    repositoryUrl: value.repositoryUrl, sha256: value.sha256, size: value.size, downloadPath: value.downloadPath,
    ...(value.channel === "release" ? { sourceRevision: value.sourceRevision, tag: value.tag,
      releaseUrl: value.releaseUrl, artifactUrl: value.artifactUrl } : {}),
  };
}

export async function readMemoriesRelease(path) {
  return validateMemoriesRelease(JSON.parse(await readFile(path, "utf8")));
}

export function requirePublicMemoriesRelease(release) {
  release = validateMemoriesRelease(release);
  if (release.channel !== "release")
    throw new Error(`PEAK Memories ${release.version} is an unpublished development build. Use --preview for a local preview; a verified public release is required for publication.`);
  return release;
}

export function verifyMemoriesBytes(bytes, release) {
  release = validateMemoriesRelease(release);
  if (bytes.length !== release.size) throw new Error("Memories DLL size mismatch");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("Memories DLL is not a PE assembly");
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("Memories DLL SHA-256 mismatch");
  return bytes;
}

// A development build has no remote fallback. A published build is always
// verified anonymously from GitHub; local overrides cannot substitute bytes.
export async function loadMemoriesArtifact(release, options = {}) {
  release = validateMemoriesRelease(release);
  if (release.channel === "release") {
    if (options.localPath) throw new Error("Published memories verification does not accept a local DLL override");
    return loadPublishedMemoriesArtifact(release, options);
  }
  return loadLocalMemoriesArtifact(release, options.localPath);
}

async function loadLocalMemoriesArtifact(release, localPath) {
  if (typeof localPath !== "string" || !localPath) throw new Error("Unreleased memories DLL requires --memories-dll <file> or PEAK_TRAIL_MEMORIES_DLL for local preview.");
  const entry = await lstat(localPath);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== release.size)
    throw new Error("Local memories DLL must be one regular file of the pinned size");
  const file = await open(localPath, "r");
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== release.size) throw new Error("Local memories DLL must be one regular file of the pinned size");
    const bytes = Buffer.alloc(release.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    return verifyMemoriesBytes(bytes.subarray(0, length), release);
  } finally { await file.close(); }
}

export function verifyMemoriesSourceRefs(output, release) {
  release = requirePublicMemoriesRelease(release);
  const ref = `refs/tags/${release.tag}`, refs = new Map();
  if (typeof output !== "string" || output.length > 4096) throw new Error("Invalid memories release tag response");
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{40})\t([^\s]+)$/);
    if (!match || ![ref, `${ref}^{}`].includes(match[2]) || refs.has(match[2])) throw new Error("Invalid memories release tag response");
    refs.set(match[2], match[1]);
  }
  if (!refs.has(ref)) throw new Error("Published memories release tag is missing");
  const revision = refs.get(`${ref}^{}`) || refs.get(ref);
  if (revision !== release.sourceRevision) throw new Error("Memories release tag does not match pinned sourceRevision");
  return revision;
}

export async function verifyPublishedMemoriesSource(release, { execFileImpl = execFileAsync, sleepImpl = delay } = {}) {
  release = requirePublicMemoriesRelease(release);
  const ref = `refs/tags/${release.tag}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let stdout;
    try {
      ({ stdout } = await execFileImpl("git", ["-c", "credential.helper=", "-c", "http.extraHeader=",
        "ls-remote", "--exit-code", "--tags", `${REPOSITORY}.git`, ref, `${ref}^{}`], {
        encoding: "utf8", timeout: 15_000, maxBuffer: 4096, windowsHide: true, cwd: tmpdir(),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
          GIT_CONFIG_PARAMETERS: "", GIT_CEILING_DIRECTORIES: tmpdir(), GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" },
      }));
    } catch (error) {
      if (error.code === 2) throw new Error("Published memories release tag is missing");
      if (error.code === "ENOENT") throw new Error("Git is required to verify the memories release source");
      const transient = error.killed || (error.code === 128 &&
        /could not resolve|failed to connect|connection.*(?:reset|closed|timed out)|timed out|TLS|SSL|RPC failed|early EOF|HTTP (?:429|5\d\d)|returned error: (?:429|5\d\d)/i.test(error.stderr || ""));
      if (!transient || attempt === 2) throw new Error("Memories release tag lookup failed");
      await sleepImpl(300 * 2 ** attempt); continue;
    }
    return verifyMemoriesSourceRefs(stdout, release);
  }
}

function selectReleaseAsset(record, filename, release, limit) {
  const expectedUrl = `${RELEASE_ROOT}${release.tag}/${filename}`;
  const matches = record.assets.filter(asset => asset?.name === filename);
  if (matches.length !== 1) throw new Error(`Published memories release must have exactly one ${filename} asset`);
  const asset = matches[0];
  if (asset.state !== "uploaded" || asset.browser_download_url !== expectedUrl
      || !Number.isSafeInteger(asset.size) || asset.size < 2 || asset.size > limit
      || asset.digest !== null && asset.digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
    throw new Error("Invalid published memories asset identity or size");
  if (filename === release.filename && (asset.size !== release.size
      || asset.digest && asset.digest !== `sha256:${release.sha256}`)) throw new Error("Published memories DLL asset does not match pinned size or SHA-256");
  return { size: asset.size, url: expectedUrl, digest: asset.digest };
}

export function verifyMemoriesReleaseRecord(record, release) {
  release = requirePublicMemoriesRelease(release);
  if (record?.draft !== false || typeof record.published_at !== "string" || !record.published_at || !Number.isFinite(Date.parse(record.published_at))
      || typeof record.prerelease !== "boolean" || record.tag_name !== release.tag || record.html_url !== release.releaseUrl
      || !Array.isArray(record.assets) || record.assets.length > 128) throw new Error("Memories release is not publicly published under the pinned tag");
  return { dll: selectReleaseAsset(record, release.filename, release, MAX_MEMORIES_BYTES),
    manifest: selectReleaseAsset(record, "build-manifest.json", release, MAX_BUILD_MANIFEST_BYTES) };
}

export function verifyMemoriesBuildManifest(manifest, release) {
  release = requirePublicMemoriesRelease(release);
  const assembly = manifest?.assembly;
  if (manifest?.schemaVersion !== 1 || manifest.tag !== release.tag || manifest.version !== release.version
      || manifest.commit !== release.sourceRevision || assembly?.name !== "PeakReplayLab"
      || assembly.version !== release.fileVersion || assembly.fileVersion !== release.fileVersion
      || assembly.informationalVersion !== release.informationalVersion || assembly.file !== release.filename
      || assembly.bytes !== release.size || String(assembly.sha256).toLowerCase() !== release.sha256
      || !/^[a-f0-9]{32}$/i.test(assembly.mvid || "") || manifest.contracts?.passed !== true)
    throw new Error("Published memories build manifest does not match pinned source, assembly identity or SHA-256");
  return manifest;
}

function implementationId(fn) {
  if (!implementationIds.has(fn)) implementationIds.set(fn, nextImplementationId++);
  return implementationIds.get(fn);
}

// Deduplicate concurrent checks only while one build verification is running.
// No completed success is cached: moved tags/assets fail on the next call.
async function loadPublishedMemoriesArtifact(release, { fetchImpl = globalThis.fetch, execFileImpl = execFileAsync, sleepImpl = delay } = {}) {
  const key = JSON.stringify(release) + implementationId(fetchImpl) + ":" + implementationId(execFileImpl);
  if (inFlight.has(key)) return inFlight.get(key);
  const work = (async () => {
    const apiUrl = `https://api.github.com/repos/luyongyi/peak-memories/releases/tags/${release.tag}`;
    const recordBytes = await publicBytes(apiUrl, { fetchImpl, sleepImpl, limit: 256 * 1024, redirects: false, json: true });
    const assets = verifyMemoriesReleaseRecord(parseJson(recordBytes), release);
    await verifyPublishedMemoriesSource(release, { execFileImpl, sleepImpl });
    const manifestBytes = await publicBytes(assets.manifest.url, { fetchImpl, sleepImpl, limit: MAX_BUILD_MANIFEST_BYTES, expectedSize: assets.manifest.size });
    verifyAssetDigest(manifestBytes, assets.manifest);
    verifyMemoriesBuildManifest(parseJson(manifestBytes), release);
    const dll = await publicBytes(assets.dll.url, { fetchImpl, sleepImpl, limit: MAX_MEMORIES_BYTES, expectedSize: release.size });
    return verifyMemoriesBytes(dll, release);
  })();
  inFlight.set(key, work);
  try { return await work; } finally { inFlight.delete(key); }
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Published memories metadata is invalid JSON"); }
}
function verifyAssetDigest(bytes, asset) {
  if (asset.digest && asset.digest !== `sha256:${createHash("sha256").update(bytes).digest("hex")}`)
    throw new Error("Published memories metadata asset SHA-256 mismatch");
}

async function publicBytes(url, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await downloadPublicBytes(url, options); }
    catch (error) {
      if (!error.retryable || attempt === 2) throw error;
      await options.sleepImpl(300 * 2 ** attempt);
    }
  }
}

async function downloadPublicBytes(originalUrl, { fetchImpl, limit, expectedSize, redirects = true, json = false }) {
  const signal = AbortSignal.timeout(json ? 15_000 : 60_000);
  let url = originalUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    let response;
    try { response = await fetchImpl(url, { redirect: "manual", credentials: "omit", signal,
      headers: { "User-Agent": "PeakTrail-Memories-Release", Accept: json ? "application/vnd.github+json" : "application/octet-stream",
        ...(json ? { "X-GitHub-Api-Version": "2022-11-28" } : {}) } }); }
    catch { throw Object.assign(new Error("Memories release download transport failed"), { retryable: true }); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      let next;
      try { next = new URL(response.headers.get("location"), url); } catch { /* rejected below */ }
      if (!redirects || redirectCount === 3 || !next || next.protocol !== "https:" || next.username || next.password
          || next.port || next.hash || !REDIRECT_HOSTS.has(next.hostname)) throw new Error("Memories release redirected outside public GitHub asset storage");
      url = next.href; continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Memories release download returned HTTP ${response.status}`), { retryable: [408, 429, 500, 502, 503, 504].includes(response.status) });
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit
        || expectedSize !== undefined && Number(declared) !== expectedSize)) {
      await response.body?.cancel(); throw new Error("Memories release Content-Length mismatch or limit exceeded");
    }
    if (!response.body) throw new Error("Memories release returned no download body");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit || expectedSize !== undefined && size > expectedSize) {
          await reader.cancel(); throw new Error("Memories release download exceeds pinned size or metadata limit");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError)
        throw Object.assign(new Error("Memories release download stream failed"), { retryable: true });
      throw error;
    } finally { reader.releaseLock(); }
    if (expectedSize !== undefined && size !== expectedSize) throw new Error("Memories release download size mismatch");
    return Buffer.concat(chunks, size);
  }
  throw new Error("Memories release has too many redirects");
}
