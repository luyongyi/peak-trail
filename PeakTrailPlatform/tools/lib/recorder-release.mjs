import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export const MAX_RECORDER_BYTES = 4 * 1024 * 1024;
const RELEASE_ROOT = "https://github.com/luyongyi/peak-trail/releases/download/";
const REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

// The download is our recorder only, not a directory of game assemblies or config.
export function validateRecorderRelease(value) {
  if (value?.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(value?.version || "")
      || value.filename !== "PeakTrailRecorder.dll"
      || !/^[a-f0-9]{40}$/.test(value.sourceRevision || "")
      || !/^[a-f0-9]{64}$/.test(value.sha256 || "")
      || !Number.isSafeInteger(value.size) || value.size < 2 || value.size > MAX_RECORDER_BYTES
      || value.artifactUrl !== `${RELEASE_ROOT}recorder-v${value.version}/PeakTrailRecorder.dll`
      || value.downloadPath !== `downloads/recorder/${value.version}/PeakTrailRecorder.dll`) {
    throw new Error("Invalid pinned recorder release manifest");
  }
  return {
    schemaVersion: 1, version: value.version, filename: value.filename,
    sourceRevision: value.sourceRevision, sha256: value.sha256, size: value.size,
    artifactUrl: value.artifactUrl, downloadPath: value.downloadPath,
  };
}

export async function readRecorderRelease(path) {
  return validateRecorderRelease(JSON.parse(await readFile(path, "utf8")));
}

export function verifyRecorderBytes(bytes, release) {
  release = validateRecorderRelease(release);
  if (bytes.length !== release.size) throw new Error("Recorder DLL size mismatch");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("Recorder DLL is not a PE assembly");
  if (createHash("sha256").update(bytes).digest("hex") !== release.sha256) {
    throw new Error("Recorder DLL SHA-256 mismatch");
  }
  return bytes;
}

// A development override still has to match the exact published bytes. It never
// permits a containing folder, symlink, config or neighboring log to be copied.
export async function loadRecorderArtifact(release, {
  localPath, fetchImpl = globalThis.fetch, sleepImpl = delay,
} = {}) {
  release = validateRecorderRelease(release);
  if (localPath) {
    const entry = await lstat(localPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== release.size) {
      throw new Error("Local recorder DLL must be a regular file of the pinned size");
    }
    return verifyRecorderBytes(await readFile(localPath), release);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return verifyRecorderBytes(await download(release, fetchImpl), release);
    } catch (error) {
      // Validation errors are deterministic; retry only transport / temporary HTTP failures.
      if (!error.retryable || attempt === 2) throw error;
      await sleepImpl(300 * 2 ** attempt);
    }
  }
}

async function download(release, fetchImpl) {
  const signal = AbortSignal.timeout(15_000);
  let url = release.artifactUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "manual", signal,
        headers: { "User-Agent": "PeakTrail-Recorder-Release", Accept: "application/octet-stream" } });
    } catch {
      throw Object.assign(new Error("Recorder release download transport failed"), { retryable: true });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      let next;
      try { next = new URL(response.headers.get("location"), url); } catch { /* rejected below */ }
      if (redirects === 3 || !next || next.protocol !== "https:" || next.username || next.password
          || next.port || next.hash || !REDIRECT_HOSTS.has(next.hostname)) {
        throw new Error("Recorder release redirected outside public GitHub asset storage");
      }
      url = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`Recorder release download returned HTTP ${response.status}`), {
        retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
      });
    }
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) !== release.size)) {
      await response.body?.cancel();
      throw new Error("Recorder DLL Content-Length mismatch");
    }
    if (!response.body) throw new Error("Recorder release returned no download body");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > release.size || size > MAX_RECORDER_BYTES) {
          await reader.cancel();
          throw new Error("Recorder DLL download exceeds pinned size");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error.name === "AbortError" || error.name === "TimeoutError" || error instanceof TypeError) {
        throw Object.assign(new Error("Recorder release download stream failed"), { retryable: true });
      }
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Recorder release has too many redirects");
}
