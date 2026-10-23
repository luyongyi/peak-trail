#!/usr/bin/env node
// One-shot derivative import. No service changes, privilege grants or raw game inputs.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const digest = value => createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;
const packPath = /^maps\/packs\/(sha256-[a-f0-9]{64})\/(map-pack\.json|[a-z0-9][a-z0-9._-]{0,127}\.(?:glb(?:\.gz)?|png|f32))$/;
const enclosurePath = /^maps\/enclosures\/([a-f0-9]{64})\.glb\.gz$/;
const noFollow = constants.O_NOFOLLOW || 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const missing = error => { if (error.code === "ENOENT") return null; throw error; };
const inside = (root, path) => { const part = relative(root, path); return !part || !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`); };

async function directories(path, { missingAllowed = false, secure = false } = {}) {
  const absolute = resolve(path), root = parse(absolute).root;
  let cursor = root;
  for (const part of ["", ...relative(root, absolute).split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    const info = await lstat(cursor).catch(missing);
    if (!info && missingAllowed) return;
    assert(info?.isDirectory() && !info.isSymbolicLink(), `Expected ordinary directory: ${cursor}`);
    if (secure && process.platform !== "win32") {
      const uid = process.geteuid();
      assert(info.uid === 0 || info.uid === uid, `Untrusted destination directory owner: ${cursor}`);
      const rootSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
      assert(!(info.mode & 0o022) || rootSticky, `Writable destination ancestor: ${cursor}`);
    }
  }
}

async function ordinaryFile(path) {
  await directories(dirname(path));
  const before = await lstat(path);
  assert(before.isFile() && !before.isSymbolicLink(), `Expected ordinary file: ${path}`);
  const file = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await file.stat();
    assert(info.isFile() && info.dev === before.dev && info.ino === before.ino, `File changed during open: ${path}`);
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function fileDigest(path, expected, destination = null) {
  const input = await ordinaryFile(path);
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      assert(bytes <= expected.bytes, `Source exceeds declared size: ${path}`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (destination) {
        let offset = 0;
        while (offset < chunk.length) offset += (await destination.write(chunk, offset, chunk.length - offset, null)).bytesWritten;
      }
    }
    assert(bytes === expected.bytes && hash.digest("hex") === expected.sha256, `Asset size/hash mismatch: ${path}`);
  } finally { await input.close(); }
}

async function smallJson(path, { maximum, sha256 } = {}) {
  const file = await ordinaryFile(path);
  try {
    assert((await file.stat()).size <= maximum, `JSON exceeds size limit: ${path}`);
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    assert(bytes.length <= maximum && (!sha256 || digest(bytes) === sha256), `Manifest SHA-256 mismatch: ${path}`);
    return JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
}

function validateManifest(manifest) {
  assert(manifest?.schemaVersion === 1 && /^[1-9]\d{0,19}$/.test(manifest.gameBuildId), "Invalid import build identity");
  assert(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 100000, "Invalid import allowlist");
  const files = new Map(), packs = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    const pack = typeof entry?.path === "string" && packPath.exec(entry.path);
    const enclosure = typeof entry?.path === "string" && enclosurePath.exec(entry.path);
    assert((pack || enclosure) && !entry.path.includes("..") && !files.has(entry.path), "Unsafe, duplicate or unsupported asset path");
    assert(Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 2 ** 31 && hex.test(entry.sha256), "Invalid asset size or SHA-256");
    if (enclosure) assert(enclosure[1] === entry.sha256, "Enclosure filename must match its SHA-256");
    if (pack) packs.add(pack[1]);
    files.set(entry.path, entry);
    totalBytes += entry.bytes;
  }
  assert(packs.size > 0 && Number.isSafeInteger(totalBytes) && totalBytes <= 100 * 1024 ** 3, "Invalid import size or missing maps");
  for (const id of packs) assert(files.has(`maps/packs/${id}/map-pack.json`), "Every imported pack requires its manifest");
  return { files, packs, totalBytes };
}

async function validatePacks(source, manifest, plan) {
  for (const id of plan.packs) {
    const prefix = `maps/packs/${id}/`, reference = `${prefix}map-pack.json`, entry = plan.files.get(reference);
    const pack = await smallJson(join(source, reference), { maximum: 8 * 1024 ** 2, sha256: entry.sha256 });
    assert(pack.schemaVersion === 1 && pack.mapPackId === id && String(pack.gameBuildId) === String(manifest.gameBuildId), "Map manifest build/identity mismatch");
    assert(Array.isArray(pack.layers) && pack.layers.length > 0 && pack.layers.length <= 64, "Invalid map layers");
    const expected = new Set([reference]);
    for (const layer of pack.layers) for (const key of ["texture", "height", "geometry"]) {
      if (key === "geometry" && !layer[key]) continue;
      const path = `${prefix}${layer[key]}`, file = plan.files.get(path);
      assert(typeof layer[key] === "string" && !layer[key].includes("/") && file && file.sha256 === layer[`${key}Sha256`], "Map dependency missing or hash differs from pack manifest");
      expected.add(path);
    }
    for (const path of plan.files.keys()) if (path.startsWith(prefix)) assert(expected.has(path), "Unreferenced file inside imported map pack");
  }
}

async function ensureDestination(path) {
  await directories(path, { missingAllowed: true, secure: true });
  const pending = [];
  for (let cursor = resolve(path); !(await lstat(cursor).catch(missing)); cursor = dirname(cursor)) pending.unshift(cursor);
  for (const cursor of pending) {
    try { await mkdir(cursor, { mode: 0o755 }); await chmod(cursor, 0o755); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await directories(cursor, { secure: true });
  }
}

async function publish(source, destination, entry) {
  await ensureDestination(dirname(destination));
  const temporary = join(dirname(destination), `.map-import-${randomUUID()}.tmp`);
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    try {
      await fileDigest(source, entry, output);
      await output.chmod(0o644);
      await output.sync();
    } finally { await output.close(); }
    await directories(dirname(destination), { secure: true });
    try { await link(temporary, destination); return true; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await fileDigest(destination, entry); // A concurrent identical import is safe.
      return false;
    }
  } finally { await unlink(temporary).catch(missing); }
}

export async function importMapAssets({ source, destination, manifestPath, manifestSha256, install = false }) {
  assert(hex.test(manifestSha256), "An independently reviewed manifest SHA-256 is required");
  source = resolve(source); destination = resolve(destination); manifestPath = resolve(manifestPath);
  assert(!inside(source, destination) && !inside(destination, source), "Source and destination must be separate trees");
  await directories(source);
  await directories(destination, { missingAllowed: true, secure: install });
  const manifest = await smallJson(manifestPath, { maximum: 16 * 1024 ** 2, sha256: manifestSha256 });
  const plan = validateManifest(manifest);
  await validatePacks(source, manifest, plan);
  const pending = [];
  let existingFiles = 0;
  // Entire import is verified before creating any destination directory or file.
  for (const entry of plan.files.values()) {
    await fileDigest(join(source, entry.path), entry);
    const target = join(destination, entry.path);
    await directories(dirname(target), { missingAllowed: true, secure: install });
    const info = await lstat(target).catch(missing);
    if (info) { await fileDigest(target, entry); existingFiles++; }
    else pending.push(entry);
  }
  let installedFiles = 0;
  if (install) {
    // Publish each completed map manifest after its dependencies.
    pending.sort((a, b) => Number(a.path.endsWith("/map-pack.json")) - Number(b.path.endsWith("/map-pack.json")) || a.path.localeCompare(b.path));
    for (const entry of pending) if (await publish(join(source, entry.path), join(destination, entry.path), entry)) installedFiles++;
  }
  return { mode: install ? "install" : "dry-run", gameBuildId: String(manifest.gameBuildId), manifestSha256,
    packs: plan.packs.size, files: plan.files.size, bytes: plan.totalBytes, existingFiles,
    missingFiles: pending.length, installedFiles, destination, preservedExistingFiles: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  const fields = { "--source": "source", "--destination": "destination", "--manifest": "manifestPath", "--manifest-sha256": "manifestSha256" };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--install" && !options.install) { options.install = true; continue; }
    assert(fields[name] && !options[fields[name]] && args[i + 1] && !args[i + 1].startsWith("--"), "Usage: node import-map-assets.mjs --source DIR --destination DIR --manifest FILE --manifest-sha256 SHA256 [--install]");
    options[fields[name]] = args[++i];
  }
  assert(Object.values(fields).every(key => options[key]), "source, destination, manifest and manifest-sha256 are required; omit --install for a read-only dry run");
  console.log(JSON.stringify(await importMapAssets(options), null, 2));
}
