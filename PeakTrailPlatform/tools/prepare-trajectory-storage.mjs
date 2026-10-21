import { mkdir, readdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digest, extractStageRoutes, LIMITS } from "../server/trajectory-contract.mjs";
import { verifyStoredEntry } from "../server/trajectory-store.mjs";
import { planTrajectoryStorage, missingPointBlockBytes, writePointBlocks, readStoredTrajectory, routeSource, makeInspectionSources } from "../server/trajectory-storage.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function nested(parent, child) { const path = relative(parent, child); return !path || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)); }
async function fileInventory(root) {
  const files = []; let bytes = 0;
  for (const directory of ["index", "uploads", "routes", "point-blocks", "point-bases"]) {
    const folder = await lstat(join(root, directory)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!folder) continue;
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("offline migration requires plain private-store directories");
    for (const file of (await readdir(join(root, directory)).catch(error => { if (error.code === "ENOENT") return []; throw error; })).sort()) {
      const path = join(root, directory, file), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("offline migration requires plain private-store files");
      const body = await readFile(path); bytes += body.byteLength;
      files.push({ path: `${directory}/${file}`, bytes: body.byteLength, sha256: sha(body) });
    }
  }
  return { files, bytes };
}

// Preparation only: source is read-only, destination must not exist, and no
// rename/delete/switch is provided. The operator separately reviews this copy's
// complete counts/hashes and query equivalence before considering any live work.
export async function prepareTrajectoryStorage(sourcePath, destinationPath) {
  const source = await realpath(resolve(sourcePath)), requested = resolve(destinationPath);
  const parent = await realpath(resolve(requested, "..")), destination = join(parent, basename(requested));
  if (nested(source, destination) || nested(destination, source)
    || source.replaceAll("\\", "/").replace(/\/$/, "") === "/var/lib/peak-trail-routes") throw new Error("use an offline source copy and a separate new destination");
  const livePath = join(source, "live-archive"), liveInfo = await lstat(livePath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (liveInfo && (!liveInfo.isDirectory() || liveInfo.isSymbolicLink())) throw new Error("live archive backup requires an ordinary private directory");
  const liveArchives = liveInfo ? await readdir(livePath) : [];
  if (liveArchives.length) throw new Error("live archives require a complete separate backup; this trajectory-only preparation cannot migrate them");
  const before = await fileInventory(source);
  const indexes = before.files.filter(file => /^index\/[a-f0-9]{64}\.json$/.test(file.path));
  await mkdir(destination, { mode: 0o700 });
  for (const directory of ["index", "uploads", "routes"]) await mkdir(join(destination, directory), { mode: 0o700 });
  const entries = []; let pointCount = 0, routeCount = 0;
  for (const file of indexes) {
    const original = JSON.parse(await readFile(join(source, ...file.path.split("/")), "utf8"));
    if (original.version !== 1 || original.id !== file.path.slice(6, -5)
      || !["pending", "approved", "hidden", "rejected"].includes(original.moderationStatus)) throw new Error("invalid source moderation index");
    await verifyStoredEntry(source, original);
    const { trajectory, totalPoints } = await readStoredTrajectory(source, original.id), plan = planTrajectoryStorage(trajectory);
    const coordinateBytes = await missingPointBlockBytes(destination, plan);
    await writePointBlocks(destination, plan);
    await writeFile(join(destination, "uploads", `${original.id}.json.gz`), plan.stored, { flag: "wx", mode: 0o600 });
    const routes = [];
    for (const player of trajectory.players) for (const stage of trajectory.map.stages) {
      const attempts = extractStageRoutes(trajectory, player, stage).routes;
      for (const attempt of attempts) {
        const old = original.routes[routes.length];
        if (!old || old.playerKey !== player.key || old.stageIndex !== stage.index) throw new Error("source route ordering mismatch");
        const { file: ignoredFile, source: ignoredSource, ...metadata } = old;
        routes.push({ ...metadata, source: routeSource(player, attempt, plan.manifestSha256) });
      }
    }
    const prepared = { ...original, storageManifestSha256: plan.manifestSha256,
      inspectionSources: makeInspectionSources(trajectory, plan.manifestSha256), routes, storedBytes: plan.stored.byteLength + coordinateBytes };
    for (;;) {
      const exact = plan.stored.byteLength + coordinateBytes + Buffer.byteLength(`${JSON.stringify(prepared)}\n`);
      if (prepared.storedBytes === exact) break;
      prepared.storedBytes = exact;
    }
    const indexBytes = `${JSON.stringify(prepared)}\n`;
    if (Buffer.byteLength(indexBytes) > LIMITS.compressedBytes) throw new Error("prepared index metadata exceeds 12 MiB capacity");
    await writeFile(join(destination, "index", `${original.id}.json`), indexBytes, { flag: "wx", mode: 0o600 });
    await verifyStoredEntry(destination, prepared);
    const restored = (await readStoredTrajectory(destination, original.id)).trajectory;
    if (!isDeepStrictEqual(restored, trajectory)) throw new Error("prepared trajectory differs from its source");
    pointCount += totalPoints; routeCount += routes.length;
    entries.push({ uploadId: original.id, canonicalSha256: digest(JSON.stringify(restored)), originalIndexSha256: file.sha256,
      preparedIndexSha256: sha(Buffer.from(indexBytes)), pointCount: totalPoints, routeCount: routes.length,
      eventSha256: digest(restored.players.map(player => ({ key: player.key, events: player.events }))),
      routeSha256: digest(restored.players.flatMap(player => restored.map.stages.flatMap(stage => extractStageRoutes(restored, player, stage).routes))) });
  }
  const sourceAfter = await fileInventory(source);
  if (!isDeepStrictEqual(before, sourceAfter)) throw new Error("offline source changed during preparation");
  const after = await fileInventory(destination);
  const uploadPaths = new Set(entries.map(entry => `uploads/${entry.uploadId}.json.gz`));
  const manifest = { format: "trajectory-storage-preparation-v1", operation: "prepare-and-verify-only", complete: true,
    scope: "all valid hash-named index submissions; auxiliary and orphan source files remain in the unchanged source copy",
    unindexedSourceFiles: before.files.filter(file => file.path.startsWith("index/") && !/^index\/[a-f0-9]{64}\.json$/.test(file.path)
      || file.path.startsWith("uploads/") && !uploadPaths.has(file.path)),
    uploadCount: entries.length, pointCount, routeCount, sourceBytes: before.bytes, preparedBytes: after.bytes,
    sourceInventorySha256: digest(before.files), preparedInventorySha256: digest(after.files),
    sourceFiles: before.files, preparedFiles: after.files, entries, sourceUnchanged: true, sourceRemoved: false, liveSwitchPerformed: false };
  await writeFile(join(destination, "migration-verification.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, source, destination, ...extra] = process.argv.slice(2);
  if (mode !== "--prepare" || !source || !destination || extra.length) throw new Error("usage: node tools/prepare-trajectory-storage.mjs --prepare OFFLINE_SOURCE_COPY NEW_DESTINATION");
  const result = await prepareTrajectoryStorage(source, destination);
  console.log(JSON.stringify({ complete: result.complete, uploadCount: result.uploadCount, pointCount: result.pointCount,
    routeCount: result.routeCount, sourceBytes: result.sourceBytes, preparedBytes: result.preparedBytes,
    sourceUnchanged: result.sourceUnchanged, liveSwitchPerformed: result.liveSwitchPerformed }));
}
