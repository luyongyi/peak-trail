import { rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPacketReplayArtifact, readPacketReplayRelease, validatePacketReplayRelease, PACKET_REPLAY_FILENAME } from "./lib/packet-replay-release.mjs";

const REPOSITORY = "luyongyi/peak-trail";
const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), "../data/packet-replay/release.json");

// A publisher selects a version, never a URL. The existing verifier remains the
// compatibility gate for the supported PEAK game version and build.
export async function resolvePublishedReplay(version, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof version !== "string" || !/^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$/.test(version))
    throw new Error("Use an existing Windows replay version such as 2026.11.08.1");
  const tag = `packet-replay-windows-${version}`;
  const artifactUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/${PACKET_REPLAY_FILENAME}`;
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, {
    redirect: "error", signal: AbortSignal.timeout(20_000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PeakTrail-Replay-Publisher", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Public replay Release lookup returned HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Replay Release metadata is empty");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1024 * 1024) { await reader.cancel(); throw new Error("Replay Release metadata exceeds limit"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const metadata = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  if (metadata?.tag_name !== tag || metadata.draft !== false || !Array.isArray(metadata.assets))
    throw new Error("Replay Release is not the requested public version");
  const assets = metadata.assets.filter(asset => asset?.name === PACKET_REPLAY_FILENAME);
  const asset = assets[0];
  if (assets.length !== 1 || asset.state !== "uploaded" || asset.browser_download_url !== artifactUrl
      || typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
    throw new Error("Replay Release needs one uploaded ZIP with a GitHub SHA-256 digest at the expected address");
  const release = validatePacketReplayRelease({
    schemaVersion: 1, version, gameVersion: "3.0.1", gameBuildId: "26155610", platform: "windows-x64",
    filename: PACKET_REPLAY_FILENAME, downloadPath: `downloads/${PACKET_REPLAY_FILENAME}`,
    bytes: asset.size, sha256: asset.digest.slice(7), artifactUrl,
  });
  // Reuse bounded public-GitHub download, digest and ZIP-content validation.
  await loadPacketReplayArtifact(release, { fetchImpl });
  return release;
}

export async function updateReplayRelease(version, { manifestPath = MANIFEST, fetchImpl = globalThis.fetch } = {}) {
  const previous = await readPacketReplayRelease(manifestPath);
  const release = await resolvePublishedReplay(version, { fetchImpl });
  const unchanged = JSON.stringify(previous) === JSON.stringify(release);
  if (previous.version === version && !unchanged)
    throw new Error("The published ZIP changed under an existing version; publish a new version instead");
  if (unchanged) return { changed: false, release };
  // Do not overwrite an intervening local edit while the network request ran.
  if (JSON.stringify(await readPacketReplayRelease(manifestPath)) !== JSON.stringify(previous))
    throw new Error("Replay descriptor changed during verification; retry from the latest main");
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(release, null, 2) + "\n", { flag: "wx", mode: 0o644 });
    await rename(temporary, manifestPath);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  return { changed: true, release };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--version") throw new Error("Usage: node update-packet-replay-release.mjs --version YYYY.MM.DD.N");
    const result = await updateReplayRelease(args[1]);
    console.log(`Windows replay ${result.release.version}: verified public ZIP; descriptor ${result.changed ? "updated" : "unchanged"}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
