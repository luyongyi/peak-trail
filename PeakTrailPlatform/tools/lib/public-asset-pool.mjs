import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

// Private, receiver-owned storage. Public URLs retain their original paths;
// only allowlisted immutable asset bytes share an inode between releases.
export async function createPublicAssetWriter(poolDirectory) {
  const counters = { linkedFiles: 0, reusedBytes: 0, newBytes: 0, uniqueCreatedBlobs: 0 };
  if (poolDirectory === undefined) return {
    async stageImmutable(source, destination) { await copyFile(source, destination); },
    stats: () => ({ enabled: false, ...counters }),
  };
  if (typeof poolDirectory !== "string" || !poolDirectory || !isAbsolute(poolDirectory)
    || resolve(poolDirectory) !== poolDirectory) throw new Error("Public asset pool requires an absolute canonical directory");
  const root = resolve(poolDirectory);
  const blobs = resolve(root, "blobs");
  const temporary = resolve(root, ".temp");
  for (const directory of [root, blobs, temporary]) await ensureDirectory(directory);
  const rootIdentity = await lstat(root);
  const blobsIdentity = await lstat(blobs);
  const tempIdentity = await lstat(temporary);

  return {
    async stageImmutable(source, destination, { signal } = {}) {
      signal?.throwIfAborted();
      await assertDirectoryIdentity(root, rootIdentity);
      await assertDirectoryIdentity(blobs, blobsIdentity);
      await assertDirectoryIdentity(temporary, tempIdentity);
      const sourcePath = resolve(source);
      const destinationPath = resolve(destination);
      if (!relative(root, destinationPath).startsWith(`..${sep}`)
        && relative(root, destinationPath) !== ".." && !isAbsolute(relative(root, destinationPath)))
        throw new Error("Public asset pool cannot stage inside its private storage");
      await assertAncestors(sourcePath, false);
      const sourceBefore = await lstat(sourcePath);
      if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink()) throw new Error("Public asset source must be a regular file without symlinks");
      await ensureDirectory(dirname(destinationPath));
      // Each writer owns its temp. A failed copy cannot truncate a known blob.
      const tempPath = resolve(temporary, `${process.pid}-${randomUUID()}`);
      let sourceHandle;
      let tempHandle;
      let created = false;
      try {
        sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await sourceHandle.stat();
        if (!sameFile(sourceBefore, opened) || !opened.isFile()) throw new Error("Public asset source changed while opening");
        const hash = createHash("sha256");
        const bytes = await streamFile(sourceHandle, { hash, signal });
        const sourceAfter = await sourceHandle.stat();
        const pathAfter = await lstat(sourcePath);
        await assertAncestors(sourcePath, false);
        if (!sameSnapshot(sourceBefore, sourceAfter) || !sameSnapshot(sourceAfter, pathAfter) || bytes !== opened.size)
          throw new Error("Public asset source changed during staging");
        const digest = hash.digest("hex");
        const blobPath = resolve(blobs, digest);
        await assertDirectoryIdentity(blobs, blobsIdentity);
        let existing;
        try { existing = await lstat(blobPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
        // Repeated deployments only read and link known bytes; they never
        // rewrite a temporary copy of the complete shared asset library.
        if (!existing) {
          tempHandle = await open(tempPath, "wx", 0o600);
          const copyHash = createHash("sha256");
          const copied = await streamFile(sourceHandle, { hash: copyHash, destination: tempHandle, signal });
          if (copied !== bytes || copyHash.digest("hex") !== digest
            || !sameSnapshot(sourceBefore, await sourceHandle.stat()) || !sameSnapshot(sourceBefore, await lstat(sourcePath)))
            throw new Error("Public asset source changed during staging");
          await tempHandle.sync();
          await tempHandle.chmod(0o444);
          await tempHandle.close(); tempHandle = undefined;
          await assertDirectoryIdentity(blobs, blobsIdentity);
          try {
            await link(tempPath, blobPath); // Atomic create, never replaces an existing name.
            created = true;
          } catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        await verifyBlob(blobPath, digest, bytes, signal);
        await assertDirectoryIdentity(blobs, blobsIdentity);
        await assertAncestors(sourcePath, false);
        if (!sameSnapshot(sourceBefore, await sourceHandle.stat()) || !sameSnapshot(sourceBefore, await lstat(sourcePath)))
          throw new Error("Public asset source changed during staging");
        try { await link(blobPath, destinationPath); }
        catch (error) {
          if (error.code === "EXDEV") throw new Error("Public asset pool and staged release must be on the same filesystem (EXDEV)", { cause: error });
          throw error;
        }
        counters.linkedFiles++;
        if (created) { counters.newBytes += bytes; counters.uniqueCreatedBlobs++; }
        else counters.reusedBytes += bytes;
      } finally {
        await sourceHandle?.close();
        await tempHandle?.close();
        // Windows requires a writable temp to unlink; it can share a read-only
        // blob inode after publication, so never chmod the temp at that point.
        try { await unlink(tempPath); }
        catch (error) {
          if (error.code !== "ENOENT") {
            if (!created && process.platform === "win32" && error.code === "EPERM") {
              await chmod(tempPath, 0o600); await unlink(tempPath);
            } else throw error;
          }
        }
      }
    },
    stats: () => ({ enabled: true, ...counters }),
  };
}

async function streamFile(handle, { hash, destination, signal }) {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let bytes = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
    if (!bytesRead) return bytes;
    const block = buffer.subarray(0, bytesRead);
    hash.update(block);
    if (destination) {
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(block, offset, bytesRead - offset, bytes + offset);
        if (!bytesWritten) throw new Error("Public asset temporary write made no progress");
        offset += bytesWritten;
      }
    }
    bytes += bytesRead;
  }
}

async function verifyBlob(path, digest, size, signal) {
  await assertAncestors(path, false);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== size || (before.mode & 0o222))
    throw new Error("Existing public asset blob is invalid or writable");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, await handle.stat())) throw new Error("Existing public asset blob changed while opening");
    const hash = createHash("sha256");
    const bytes = await streamFile(handle, { hash, signal });
    // Another release adding a link changes ctime, without changing bytes.
    if (bytes !== size || hash.digest("hex") !== digest || !sameContent(before, await handle.stat())
      || !sameContent(before, await lstat(path))) throw new Error("Existing public asset blob digest mismatch or changed content");
  } finally { await handle.close(); }
}

function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function sameContent(left, right) { return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs; }
function sameSnapshot(left, right) { return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function samePath(left, right) { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }

async function assertDirectoryIdentity(path, identity) {
  await assertAncestors(path, true);
  if (!sameFile(identity, await lstat(path))) throw new Error("Public asset pool directory changed during staging");
}

async function ensureDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Public asset pool paths must use real directories without symlinks");
  }
  await assertAncestors(absolute, true);
}

async function assertAncestors(path, includeLeaf) {
  const absolute = resolve(path);
  const directory = includeLeaf ? absolute : dirname(absolute);
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Public asset paths must use real directories without symlinks");
  }
  if (!samePath(await realpath(directory), directory)) throw new Error("Public asset path is not canonical");
}
