import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This file is installed by an administrator, OUTSIDE the account-writable state directory.
export const REPOSITORY_URL = "https://github.com/luyongyi/peak-trail.git";
export const STATE_ROOT = "/srv/peak-trail/state";
export const ASSET_ROOT = "/srv/peak-trail/shared/assets";
export const PUBLIC_ASSET_POOL = resolve(STATE_ROOT, "public-assets");
export const LIVE_ENABLED_FILE = "/srv/peak-trail/live-enabled";
const LIVE_SERVICE = "peak-trail-live.service";
const RELEASE_MARKER = ".deployment-state.json";
const RELEASE_NAME = /^([a-f0-9]{12})-[A-Za-z0-9]{6}$/;
const POOL_DIGEST = /^[a-f0-9]{64}$/;
const STORAGE_GRACE_MS = 60 * 60 * 1000;

export function parseDeployCommand(command) {
  const match = typeof command === "string" && /^deploy ([a-f0-9]{40})$/.exec(command);
  if (!match || match[0] !== command) throw new Error("Only deploy followed by one lowercase 40-character commit SHA is allowed");
  return match[1];
}

export function containedPath(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  const difference = relative(base, target);
  if (!difference || difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new Error("Path must be strictly inside its deployment directory");
  }
  return target;
}

async function plainDirectory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== resolve(path)) {
    throw new Error(`Expected a real directory, without symlink ancestors: ${path}`);
  }
}

async function optionalLstat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function withDeployLock(stateRoot, action) {
  await plainDirectory(stateRoot);
  const lock = containedPath(stateRoot, resolve(stateRoot, ".deploy-lock"));
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another deployment holds .deploy-lock; a stale lock needs administrator review");
    throw error;
  }
  try { return await action(); }
  finally { await rmdir(lock); } // Remove only our own empty lock, never a release or asset tree.
}

function releaseSitePath(stateRoot, candidate) {
  const releases = resolve(stateRoot, "releases");
  const site = containedPath(releases, candidate);
  const parts = relative(releases, site).split(sep);
  if (parts.length !== 3 || parts[1] !== "PeakTrailPlatform" || parts[2] !== "site-dist") {
    throw new Error("Published directory must be releases/<release>/PeakTrailPlatform/site-dist");
  }
  return site;
}

export async function publishAtomically(stateRoot, candidate) {
  await plainDirectory(stateRoot);
  await plainDirectory(resolve(stateRoot, "releases"));
  const site = releaseSitePath(stateRoot, candidate);
  await plainDirectory(site);
  const current = resolve(stateRoot, "current");
  const previous = await optionalLstat(current);
  if (previous) {
    if (!previous.isSymbolicLink()) throw new Error("Refusing to replace current: it is not a deployment symlink");
    releaseSitePath(stateRoot, resolve(stateRoot, await readlink(current)));
  }
  const pending = resolve(stateRoot, `.current-${randomUUID()}`);
  await symlink(relative(stateRoot, site), pending, "dir");
  try { await rename(pending, current); }
  catch (error) { await unlink(pending); throw error; }
}

async function currentPublishedSite(stateRoot) {
  const current = resolve(stateRoot, "current");
  const entry = await optionalLstat(current);
  if (!entry) return null;
  if (!entry.isSymbolicLink()) throw new Error("Current is not a deployment symlink");
  return releaseSitePath(stateRoot, resolve(stateRoot, await readlink(current)));
}

async function removeFirstPublication(stateRoot, candidate) {
  const site = releaseSitePath(stateRoot, candidate);
  if (await currentPublishedSite(stateRoot) !== site) {
    throw new Error("Refusing to remove current: it no longer points to the failed first release");
  }
  await unlink(resolve(stateRoot, "current")); // Only the generated symlink; no release files.
}

const publicationOperations = {
  readCurrent: currentPublishedSite,
  publish: publishAtomically,
  removeFirst: removeFirstPublication,
};

// Injection is for offline transaction tests; production always uses the filesystem operations above.
export async function publishAndActivate(stateRoot, candidate, activate = null, operations = publicationOperations) {
  const previous = await operations.readCurrent(stateRoot);
  await operations.publish(stateRoot, candidate);
  if (!activate) return candidate;
  try {
    await activate(candidate);
    return candidate;
  } catch (activationError) {
    try {
      if (await operations.readCurrent(stateRoot) !== candidate) {
        throw new Error("Current changed during activation; refusing to overwrite another publication");
      }
      if (previous) {
        await operations.publish(stateRoot, previous);
        await activate(previous);
      } else {
        await operations.removeFirst(stateRoot, candidate);
      }
    } catch (rollbackError) {
      const error = new AggregateError([activationError, rollbackError],
        `Live activation failed and rollback did not complete: ${activationError.message}; rollback: ${rollbackError.message}. Administrator intervention required.`);
      error.rollbackStatus = "failed";
      throw error;
    }
    const error = new Error(previous
      ? `Live activation failed; previous site restored and previous service restarted: ${activationError.message}`
      : `First live activation failed; generated current symlink removed. No previous service exists; administrator must inspect service state: ${activationError.message}`,
    { cause: activationError });
    error.rollbackStatus = previous ? "restored" : "removed";
    throw error;
  }
}

export async function liveActivationEnabled(path = LIVE_ENABLED_FILE) {
  const entry = await optionalLstat(path);
  if (!entry) return false;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || await realpath(path) !== resolve(path)) {
    throw new Error("Live activation flag must be a root-owned regular file without symlink ancestors or group/world write access");
  }
  return true;
}

export async function verifyLiveHealth(fetchImpl = fetch) {
  const response = await fetchImpl("http://127.0.0.1:8787/api/health", { signal: AbortSignal.timeout(2000), redirect: "error" });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("Live health endpoint is not ready");
  }
  const state = await response.json();
  if (state?.ok !== true || state?.service !== "peak-trail-live") {
    throw new Error("Live health response is invalid or belongs to another service");
  }
}

async function restartLiveService(options) {
  const serviceOptions = { ...options, timeout: 30_000 };
  await run("/usr/bin/sudo", ["-n", "/usr/bin/systemctl", "restart", LIVE_SERVICE], serviceOptions);
  const deadline = Date.now() + 30_000;
  let failure;
  do {
    try {
      await run("/usr/bin/systemctl", ["is-active", "--quiet", LIVE_SERVICE], { ...serviceOptions, timeout: 2000 });
      await verifyLiveHealth();
      return;
    } catch (error) { failure = error; }
    await new Promise((accept) => setTimeout(accept, 500));
  } while (Date.now() < deadline);
  throw new Error(`Live service did not become healthy: ${failure?.message}`);
}

const forbiddenNames = new Set(["local", "recordings", "archives", ".git", ".ssh", "node_modules"]);

export async function verifyStagedSite(site) {
  await plainDirectory(site);
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (forbiddenNames.has(entry.name.toLowerCase()) || /^\.env(?:\.|$)/i.test(entry.name) || /\.(?:ndjson|partial|log|pem|key)$/i.test(entry.name)) {
        throw new Error(`Private or unexpected file in public site: ${entry.name}`);
      }
      const path = containedPath(site, resolve(directory, entry.name));
      if (entry.isSymbolicLink()) throw new Error("Public site must not contain symlinks");
      if (entry.isDirectory()) await inspect(path);
      else if (!entry.isFile()) throw new Error("Public site must contain only regular files and directories");
    }
  }
  await inspect(site);
  for (const name of ["index.html", "styles.css", "home.css", "src/app.js", "data/daily/current.json", "data/daily/history.json", "data/maps/catalog.json", "data/game-assets/catalog.json"]) {
    const file = await lstat(resolve(site, name));
    if (!file.isFile() || file.size === 0) throw new Error(`Missing or empty public entry point: ${name}`);
  }
  const readJson = async (name) => JSON.parse(await readFile(resolve(site, name), "utf8"));
  const daily = await readJson("data/daily/current.json");
  const history = await readJson("data/daily/history.json");
  const catalog = await readJson("data/maps/catalog.json");
  const assets = await readJson("data/game-assets/catalog.json");
  if (daily.schemaVersion !== 1 || !Number.isInteger(daily.mapSlot) || history.schemaVersion !== 1 || !Array.isArray(history.observations)) {
    throw new Error("Invalid staged daily manifests");
  }
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mapPacks) || catalog.mapPacks.length === 0 || assets.schemaVersion !== 1) {
    throw new Error("Invalid or empty staged asset manifests");
  }
  for (const entry of catalog.mapPacks) {
    if (!/^sha256-[a-f0-9]{64}$/.test(entry.mapPackId || "") || entry.path !== `./packs/${entry.mapPackId}/map-pack.json`) {
      throw new Error("Unsafe staged map manifest reference");
    }
    const pack = await readJson(`data/maps/packs/${entry.mapPackId}/map-pack.json`);
    if (pack.mapPackId !== entry.mapPackId || !Array.isArray(pack.layers) || pack.layers.length === 0) {
      throw new Error("Staged map manifest does not match its catalog");
    }
  }
  return { mapPacks: catalog.mapPacks.length };
}

function run(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output = (output + bytes.toString()).slice(-64 * 1024);
      process.stdout.write(bytes);
    });
    child.stderr.on("data", (bytes) => process.stderr.write(bytes));
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? accept(output.trim()) : reject(new Error(`${executable} failed (${signal || code})`)));
  });
}

function ownerUid() { return typeof process.getuid === "function" ? process.getuid() : null; }
function owned(entry) { return ownerUid() === null || entry.uid === ownerUid(); }
function inodeKey(entry) { return `${entry.dev}:${entry.ino}`; }

function managedReleasePath(stateRoot, candidate) {
  const releases = resolve(stateRoot, "releases");
  const path = containedPath(releases, candidate);
  const name = relative(releases, path);
  if (!RELEASE_NAME.test(name)) throw new Error("Release must be a direct, receiver-named directory");
  return path;
}

async function ownedDirectory(path) {
  await plainDirectory(path);
  if (!owned(await lstat(path))) throw new Error(`Deployment directory is not owned by the receiver account: ${path}`);
}

async function plainOwnedFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || !owned(entry) || entry.nlink !== 1 || await realpath(path) !== resolve(path)) {
    throw new Error(`Expected an owned regular file without external links: ${path}`);
  }
  return entry;
}

export async function writeReleaseState(stateRoot, release, commit, state, { now = Date.now() } = {}) {
  parseDeployCommand(`deploy ${commit}`);
  if (!["building", "failed", "successful"].includes(state)) throw new Error("Invalid deployment state");
  const target = managedReleasePath(stateRoot, release);
  if (!relative(resolve(stateRoot, "releases"), target).startsWith(`${commit.slice(0, 12)}-`)) throw new Error("Release state commit does not match its directory");
  await ownedDirectory(target);
  const marker = resolve(target, RELEASE_MARKER);
  const priorEntry = await optionalLstat(marker);
  let createdAtUtc = new Date(now).toISOString();
  if (priorEntry) {
    await plainOwnedFile(marker);
    const prior = JSON.parse(await readFile(marker, "utf8"));
    if (prior.schemaVersion !== 1 || prior.commit !== commit || !Number.isFinite(Date.parse(prior.createdAtUtc))) throw new Error("Existing deployment state is invalid");
    createdAtUtc = prior.createdAtUtc;
  }
  const temporary = resolve(target, `.deployment-state-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, commit, state, createdAtUtc, updatedAtUtc: new Date(now).toISOString() }) + "\n", { flag: "wx", mode: 0o644 });
    await rename(temporary, marker);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

async function releaseIdentity(stateRoot, name) {
  const release = managedReleasePath(stateRoot, resolve(stateRoot, "releases", name));
  await ownedDirectory(release);
  const markerPath = resolve(release, RELEASE_MARKER);
  const markerEntry = await optionalLstat(markerPath);
  let marker;
  if (markerEntry) {
    await plainOwnedFile(markerPath);
    marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(marker.commit || "") || !name.startsWith(`${marker.commit.slice(0, 12)}-`)
      || !["building", "failed", "successful"].includes(marker.state) || !Number.isFinite(Date.parse(marker.createdAtUtc)) || !Number.isFinite(Date.parse(marker.updatedAtUtc))) {
      throw new Error("Release state does not prove its deployment identity");
    }
    if (marker.state !== "successful") return { release, name, state: marker.state, time: Date.parse(marker.updatedAtUtc), commit: marker.commit };
  }
  // Legacy successful releases are recognized without executing their Git or build scripts.
  await ownedDirectory(resolve(release, ".git"));
  const head = resolve(release, ".git", "HEAD");
  await plainOwnedFile(head);
  const commit = (await readFile(head, "utf8")).trim();
  if (!/^[a-f0-9]{40}$/.test(commit) || !name.startsWith(`${commit.slice(0, 12)}-`) || (marker && marker.commit !== commit)) throw new Error("Release Git identity does not match its directory");
  const site = resolve(release, "PeakTrailPlatform", "site-dist");
  await ownedDirectory(site);
  const receiptPath = resolve(site, "release.json");
  await plainOwnedFile(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  if (receipt.commit !== commit || !Number.isFinite(Date.parse(receipt.deployedAtUtc))) throw new Error("Public release receipt does not match Git identity");
  return { release, name, state: "successful", time: marker ? Date.parse(marker.updatedAtUtc) : Date.parse(receipt.deployedAtUtc), commit };
}

async function poolInventory(stateRoot) {
  const pool = resolve(stateRoot, "public-assets");
  const inventory = { blobs: [], temporary: [], inodes: new Set(), skipped: 0 };
  if (!await optionalLstat(pool)) return inventory;
  await ownedDirectory(pool);
  for (const [directoryName, matcher, output] of [["blobs", POOL_DIGEST, inventory.blobs], [".temp", /^\d+-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, inventory.temporary]]) {
    const directory = resolve(pool, directoryName);
    if (!await optionalLstat(directory)) continue;
    await ownedDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = containedPath(directory, resolve(directory, entry.name));
      const metadata = await lstat(path);
      if (!matcher.test(entry.name) || !metadata.isFile() || metadata.isSymbolicLink() || !owned(metadata) || await realpath(path) !== path) { inventory.skipped++; continue; }
      output.push({ path, metadata });
      if (directoryName === "blobs") inventory.inodes.add(inodeKey(metadata));
    }
  }
  return inventory;
}

async function inspectReleaseTree(release, poolInodes) {
  await ownedDirectory(release);
  const files = [];
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = containedPath(release, resolve(directory, entry.name));
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !owned(metadata) || await realpath(path) !== path) throw new Error("Release contains a symlink or an unexpected owner");
      if (metadata.isDirectory()) await inspect(path);
      else if (metadata.isFile()) {
        const reference = relative(release, path).split(sep).join("/");
        const mutableAssetMetadata = /^PeakTrailPlatform\/site-dist\/data\/maps\/packs\/[^/]+\/map-pack\.json$/.test(reference)
          || /^PeakTrailPlatform\/site-dist\/data\/game-assets\/(?:[^/]+\/)?catalog\.json$/.test(reference);
        const publicAsset = (!mutableAssetMetadata && /^PeakTrailPlatform\/site-dist\/data\/(?:maps\/(?:packs|enclosures)\/|game-assets\/|home-art\/)/.test(reference))
          // Keep these names/version forms identical to the two pinned download descriptors.
          || /^PeakTrailPlatform\/site-dist\/downloads\/(?:memories\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/PeakReplayLab\.dll|recorder\/\d+\.\d+\.\d+\/PeakTrailRecorder\.dll)$/.test(reference);
        if (metadata.nlink > 1 && (!publicAsset || !poolInodes.has(inodeKey(metadata)))) throw new Error("Release contains an unexpected hard link");
        files.push({ path, metadata });
      } else throw new Error("Release contains a special filesystem entry");
    }
  }
  await inspect(release);
  return files;
}

// Called only after publication and health succeed, while the receiver still holds its lock.
// Unknown directories and interrupted builds require operator review rather than speculative deletion.
export async function maintainDeploymentStorage(stateRoot, { now = Date.now(), graceMs = STORAGE_GRACE_MS } = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(graceMs) || graceMs < STORAGE_GRACE_MS) throw new Error("Storage GC grace must be at least one hour");
  await ownedDirectory(stateRoot);
  await ownedDirectory(resolve(stateRoot, ".deploy-lock"));
  const releases = resolve(stateRoot, "releases");
  await ownedDirectory(releases);
  const currentSite = await currentPublishedSite(stateRoot);
  if (!currentSite) throw new Error("Storage maintenance requires a current publication");
  await ownedDirectory(currentSite);
  const currentRelease = managedReleasePath(stateRoot, resolve(currentSite, "..", ".."));
  const currentName = relative(releases, currentRelease);
  const currentIdentity = await releaseIdentity(stateRoot, currentName);
  if (currentIdentity.state !== "successful") throw new Error("Current publication is not a verified successful release");
  const pool = await poolInventory(stateRoot);
  const identities = [];
  const skippedReleases = [];
  for (const entry of await readdir(releases, { withFileTypes: true })) {
    if (!RELEASE_NAME.test(entry.name)) { skippedReleases.push(entry.name); continue; }
    try { identities.push(await releaseIdentity(stateRoot, entry.name)); }
    catch { skippedReleases.push(entry.name); }
  }
  const newest = (left, right) => right.time - left.time || left.name.localeCompare(right.name);
  const retained = new Set([currentRelease]);
  for (const item of identities.filter(item => item.state === "successful" && item.release !== currentRelease).sort(newest).slice(0, 3)) retained.add(item.release);
  for (const item of identities.filter(item => item.state === "failed").sort(newest).slice(0, 1)) retained.add(item.release);
  const removedReleases = [];
  let protectedExpiredReleases = 0;
  for (const item of identities) {
    if (retained.has(item.release) || item.state === "building") continue;
    try {
      // Recheck immediately before deletion; never follow a changed current or directory.
      if (await currentPublishedSite(stateRoot) !== currentSite) throw new Error("Current publication changed during storage maintenance");
      const confirmed = await releaseIdentity(stateRoot, item.name);
      if (confirmed.commit !== item.commit || confirmed.state !== item.state) throw new Error("Release identity changed during storage maintenance");
      await inspectReleaseTree(item.release, pool.inodes);
      await rm(managedReleasePath(stateRoot, item.release), { recursive: true, force: false });
      removedReleases.push(item.name);
    } catch (error) { protectedExpiredReleases++; console.warn(`Storage cleanup retained ${item.name}: ${error.message}`); }
  }
  if (await currentPublishedSite(stateRoot) !== currentSite) throw new Error("Current publication changed before pool GC");
  let removedBlobs = 0, removedTemporary = 0, reclaimedPoolBytes = 0;
  for (const [items, kind] of [[pool.blobs, "blob"], [pool.temporary, "temporary"]]) {
    for (const item of items) {
      const metadata = await optionalLstat(item.path);
      if (!metadata || !metadata.isFile() || metadata.isSymbolicLink() || !owned(metadata) || inodeKey(metadata) !== inodeKey(item.metadata)
        || (kind === "blob" && metadata.nlink !== 1) || now - metadata.mtimeMs < graceMs || await realpath(item.path) !== item.path) continue;
      await unlink(item.path);
      // Removing a stale temporary name with other links does not free its shared data blocks.
      if (metadata.nlink === 1) reclaimedPoolBytes += metadata.size;
      if (kind === "blob") removedBlobs++; else removedTemporary++;
    }
  }
  const remainingPool = await poolInventory(stateRoot);
  const allInodes = new Map();
  let releaseFiles = 0, releaseLogicalBytes = 0;
  for (const item of identities) {
    if (removedReleases.includes(item.name)) continue;
    try {
      for (const file of await inspectReleaseTree(item.release, remainingPool.inodes)) {
        releaseFiles++; releaseLogicalBytes += file.metadata.size;
        allInodes.set(inodeKey(file.metadata), file.metadata);
      }
    } catch { /* An unknown/unsafe tree is deliberately excluded from managed metrics. */ }
  }
  for (const blob of remainingPool.blobs) allInodes.set(inodeKey(blob.metadata), blob.metadata);
  const summary = { retainedSuccessful: identities.filter(item => item.state === "successful" && !removedReleases.includes(item.name)).length,
    retainedFailed: identities.filter(item => item.state === "failed" && !removedReleases.includes(item.name)).length,
    retainedBuilding: identities.filter(item => item.state === "building").length, skippedReleases: skippedReleases.length,
    removedReleases: removedReleases.length, protectedExpiredReleases, removedBlobs, removedTemporary, reclaimedPoolBytes,
    poolBlobs: remainingPool.blobs.length, poolLogicalBytes: remainingPool.blobs.reduce((total, item) => total + item.metadata.size, 0),
    releaseFiles, releaseLogicalBytes, managedUniqueBytes: [...allInodes.values()].reduce((total, metadata) => total + metadata.size, 0),
    managedAllocatedBytes: [...allInodes.values()].reduce((total, metadata) => total + (Number.isFinite(metadata.blocks) ? metadata.blocks * 512 : metadata.size), 0),
    skippedPoolEntries: remainingPool.skipped };
  console.log(`Deployment storage: ${JSON.stringify(summary)}`);
  return summary;
}

export async function publishReleaseAndMaintain(stateRoot, release, commit, activate = null, { maintenance = maintainDeploymentStorage, writeState = writeReleaseState } = {}) {
  const candidate = managedReleasePath(stateRoot, release);
  const site = resolve(candidate, "PeakTrailPlatform", "site-dist");
  await publishAndActivate(stateRoot, site, activate);
  try { await writeState(stateRoot, candidate, commit, "successful"); }
  catch (error) {
    console.warn(`Healthy publication retained; successful deployment state could not be recorded, storage maintenance skipped: ${error.message}`);
    return site;
  }
  // A cleanup warning must not turn a healthy publication into a failed activation or rollback.
  try { await maintenance(stateRoot); }
  catch (error) { console.warn(`Healthy publication retained; automatic storage maintenance skipped: ${error.message}`); }
  return site;
}

export async function deploy(commit, { stateRoot = STATE_ROOT, assetRoot = ASSET_ROOT } = {}) {
  parseDeployCommand(`deploy ${commit}`);
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Production receiver requires Linux and Node.js 24 or newer");
  }
  await plainDirectory(assetRoot);
  return withDeployLock(stateRoot, async () => {
    const activateLive = await liveActivationEnabled();
    const releases = resolve(stateRoot, "releases");
    await plainDirectory(releases);
    const release = await mkdtemp(resolve(releases, `${commit.slice(0, 12)}-`));
    await chmod(release, 0o755);
    // Do not inherit SSH-supplied Git, Node, loader or proxy environment variables.
    const env = {
      PATH: "/usr/local/bin:/usr/bin:/bin", HOME: stateRoot, LANG: "C.UTF-8", CI: "true",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      PEAK_TRAIL_ASSET_ROOT: assetRoot,
      PEAK_TRAIL_PUBLIC_ASSET_POOL: resolve(stateRoot, "public-assets"),
    };
    const options = { cwd: release, env, timeout: 15 * 60 * 1000 };
    const git = (...args) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], options);
    try {
      await writeReleaseState(stateRoot, release, commit, "building");
      await git("init", "--quiet");
      await git("remote", "add", "origin", REPOSITORY_URL);
      await git("fetch", "--no-tags", "--depth=1", "origin", "refs/heads/main");
      const fetched = await git("rev-parse", "--verify", "FETCH_HEAD");
      if (fetched !== commit) throw new Error("Requested commit is no longer main HEAD; rerun deployment for the latest commit");
      await git("checkout", "--detach", "--quiet", commit);
      await run(process.execPath, ["PeakTrailPlatform/tools/validate-data.mjs"], options);
      await run(process.execPath, ["PeakTrailPlatform/tools/stage-site.mjs"], options);
      const site = resolve(release, "PeakTrailPlatform", "site-dist");
      const summary = await verifyStagedSite(site);
      await writeFile(resolve(site, "release.json"), JSON.stringify({ commit, deployedAtUtc: new Date().toISOString(), ...summary }) + "\n", { flag: "wx", mode: 0o644 });
      await publishReleaseAndMaintain(stateRoot, release, commit, activateLive ? () => restartLiveService(options) : null);
      console.log(`Published ${commit}; ${summary.mapPacks} map packs.${activateLive ? " Live service restarted and verified." : " Static-only deployment."}`);
      return site;
    } catch (error) {
      try { await writeReleaseState(stateRoot, release, commit, "failed"); }
      catch (markerError) { console.warn(`Could not record failed deployment state: ${markerError.message}`); }
      console.error(`Deployment failed. ${error.rollbackStatus ? `Activation rollback status: ${error.rollbackStatus}.` : "Publication did not complete; inspect current before retrying."} Release retained at ${release}`);
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o022);
    await deploy(parseDeployCommand(process.env.SSH_ORIGINAL_COMMAND));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
