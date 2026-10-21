// Private, append-only path archive. A successful append has reached fsync.
import { mkdir, lstat, readdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const LIVE_WAL_LIMITS = Object.freeze({ totalBytes: 2 * 1024 ** 3, archiveBytes: 128 * 1024 ** 2,
  archives: 10_000, transactionBytes: 512 * 1024, pendingBytes: 4 * 1024 ** 2, pendingOperations: 16 });
const ID = /^[a-f0-9]{32}$/;
const CODE = /^[A-HJ-NP-Z]{4}$/;
const failure = (message) => Object.assign(new Error(message), { status: 503 });
const checksum = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pick = (value, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const MANIFEST_FIELDS = "schemaVersion startedAtUtc gameVersion gameBuildId recorderVersion sceneName levelIndex mapSlot projectionVersion sampleHz coordinateSpace positionAuthority segmentResolution activeSegmentSemantics timeUnit recordingScope identityMode route sessionId".split(" ");

export function projectLivePathRecord(record) {
  const common = pick(record, ["type", "t", "playerId", "activeSegment"]);
  if (record.type === "participant") return { ...common, ...pick(record, ["nickname"]) };
  if (record.type === "sample") return { ...common, ...pick(record, ["pos", "yaw"]) };
  if (record.type === "route") return { ...common, route: record.route };
  if (record.type === "event") return { ...common, ...pick(record, ["event", "pos", "source", "confidence", "cause", "targetPlayerId"]),
    ...(["item-use", "item-spawn"].includes(record.event) ? pick(record, ["id", "actionId", "item"]) : {}) };
  if (record.type === "status" && typeof record.status?.dead === "boolean")
    return { ...common, status: pick(record.status, ["ready", "dead", "authority"]), ...pick(record, ["reason"]) };
  return null;
}

async function syncDirectory(path) {
  // Windows does not expose directory fsync through Node. Production is Linux.
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function ordinary(path, directory = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw failure("live-archive-unsafe-path");
  if (process.platform !== "win32" && (info.mode & 0o077)) throw failure("live-archive-unsafe-permissions");
  return info;
}
function advance(previous, transaction, sessionId) {
  if (!transaction || typeof transaction !== "object" || transaction.version !== 1
      || !Number.isSafeInteger(transaction.tx) || transaction.tx !== (previous?.tx ?? 0) + 1
      || !Number.isSafeInteger(transaction.at) || transaction.at < 0) throw failure("live-archive-corrupt");
  const { kind, epoch } = transaction;
  if (!previous) {
    if (transaction.sessionId !== sessionId || !ID.test(transaction.watchId) || !CODE.test(transaction.watchCode)
        || (kind === "reserve" ? epoch !== 0 || transaction.manifest !== null
          : kind !== "open" || epoch !== 1 || !transaction.manifest
            || !isDeepStrictEqual(transaction.manifest, pick(transaction.manifest, MANIFEST_FIELDS)))) throw failure("live-archive-corrupt");
    return { tx: transaction.tx, epoch, producerSeq: 0, seq: 0, ended: false };
  }
  if (previous.ended) throw failure("live-archive-corrupt");
  if (kind === "reservation-claim") {
    if (previous.epoch !== 0 || epoch !== 0) throw failure("live-archive-corrupt");
    return { ...previous, tx: transaction.tx };
  }
  if (kind === "epoch" || kind === "activate") {
    if ((kind === "activate" ? previous.epoch !== 0 : previous.epoch < 1)
        || epoch !== previous.epoch + 1 || !transaction.manifest
        || !isDeepStrictEqual(transaction.manifest, pick(transaction.manifest, MANIFEST_FIELDS))) throw failure("live-archive-corrupt");
    return { tx: transaction.tx, epoch, producerSeq: 0, seq: 0, ended: false };
  }
  if (epoch !== previous.epoch) throw failure("live-archive-corrupt");
  if (kind === "end") {
    if (typeof transaction.reason !== "string" || transaction.reason.length > 100) throw failure("live-archive-corrupt");
    return { ...previous, tx: transaction.tx, ended: true };
  }
  if (epoch < 1 || kind !== "batch" || !Number.isSafeInteger(transaction.toSeq) || !Number.isSafeInteger(transaction.producerThrough)
      || transaction.fromSeq !== previous.seq + 1 || transaction.producerFrom !== previous.producerSeq + 1
      || transaction.toSeq < transaction.fromSeq || transaction.producerThrough < transaction.producerFrom
      || transaction.toSeq - transaction.fromSeq !== transaction.producerThrough - transaction.producerFrom
      || transaction.toSeq - transaction.fromSeq >= 256 || !Array.isArray(transaction.records)) throw failure("live-archive-corrupt");
  let seq = transaction.fromSeq - 1;
  for (const entry of transaction.records) {
    if (!Number.isSafeInteger(entry?.seq) || entry.seq <= seq || entry.seq < transaction.fromSeq || entry.seq > transaction.toSeq
        || entry.producerSeq !== transaction.producerFrom + entry.seq - transaction.fromSeq || !entry.record
        || !Number.isFinite(entry.record.t) || entry.record.t < 0
        || !isDeepStrictEqual(entry.record, projectLivePathRecord(entry.record))) throw failure("live-archive-corrupt");
    seq = entry.seq;
  }
  return { ...previous, tx: transaction.tx, producerSeq: transaction.producerThrough, seq: transaction.toSeq };
}

// Scan without loading an entire recording. Only a non-newline-terminated final
// transaction is uncommitted; a complete but damaged transaction fails closed.
async function recover(path, sessionId, limit, mayRepair) {
  const file = await open(path, "r");
  let pending = Buffer.alloc(0), validBytes = 0, state = null;
  try {
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline + 1 > limit) throw failure("live-archive-corrupt");
        let frame;
        try { frame = JSON.parse(pending.subarray(0, newline).toString("utf8")); } catch { throw failure("live-archive-corrupt"); }
        if (!frame || Object.keys(frame).length !== 2 || typeof frame.checksum !== "string"
            || frame.checksum !== checksum(frame.transaction)) throw failure("live-archive-corrupt");
        state = advance(state, frame.transaction, sessionId);
        validBytes += newline + 1; pending = pending.subarray(newline + 1);
      }
      if (pending.length > limit) throw failure("live-archive-corrupt");
    }
  } finally { await file.close(); }
  if (pending.length) {
    await mayRepair();
    const repair = await open(path, "r+");
    try { await repair.truncate(validBytes); await repair.sync(); } finally { await repair.close(); }
  }
  return validBytes;
}

export function createLiveWal({ root, limits: overrides = {}, beforeSync = null } = {}) {
  const limits = { ...LIVE_WAL_LIMITS, ...overrides };
  const directory = root ? join(resolve(root), "live-archive") : null;
  const active = new Map();
  let initialization, tail = Promise.resolve(), fault = null, closing = false;
  let totalBytes = 0, archiveCount = 0, pendingBytes = 0, pendingOperations = 0;
  async function writable() {
    if (!directory) throw failure("live-archive-unconfigured");
    try { await lstat(join(resolve(root), ".migration-maintenance")); }
    catch (error) { if (error.code === "ENOENT") return; throw failure("live-archive-maintenance"); }
    throw failure("live-archive-maintenance");
  }
  async function initialize() {
    await writable();
    await mkdir(resolve(root), { recursive: true, mode: 0o700 });
    await ordinary(resolve(root), true);
    const canonical = await realpath(resolve(root));
    if ((process.platform === "win32" ? canonical.toLowerCase() : canonical) !== (process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root))) throw failure("live-archive-unsafe-path");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await ordinary(directory, true); await syncDirectory(resolve(root));
    const names = await readdir(directory);
    if (names.length > limits.archives) throw failure("live-archive-capacity");
    totalBytes = 0; archiveCount = names.length;
    for (const name of names) {
      const path = join(directory, name), info = await ordinary(path);
      let size = info.size;
      if (size > limits.archiveBytes) throw failure("live-archive-capacity");
      const match = name.match(/^([a-f0-9]{32})\.wal$/);
      if (match) size = await recover(path, match[1], limits.transactionBytes, writable);
      totalBytes += size;
      if (totalBytes > limits.totalBytes) throw failure("live-archive-capacity");
    }
  }
  async function ready() {
    if (fault) throw fault;
    if (!initialization) initialization = initialize().catch(error => {
      initialization = null;
      throw error.status ? error : failure("live-archive-unavailable");
    });
    await initialization;
  }
  async function commit(sessionId, payload, first = false) {
    if (closing) throw failure("live-archive-stopped");
    if (!ID.test(sessionId)) throw failure("live-archive-invalid-session");
    const reserved = Buffer.byteLength(JSON.stringify(payload)) + 256;
    if (reserved > limits.transactionBytes || pendingBytes + reserved > limits.pendingBytes
        || pendingOperations >= limits.pendingOperations) throw failure("live-archive-busy");
    pendingBytes += reserved; pendingOperations += 1;
    const operation = tail.then(async () => {
      await ready(); await writable();
      const previous = active.get(sessionId);
      if (first ? Boolean(previous) : !previous) throw failure("live-archive-invalid-session");
      const transaction = { version: 1, tx: (previous?.state.tx ?? 0) + 1, ...payload };
      const state = advance(previous?.state ?? null, transaction, sessionId);
      const line = Buffer.from(JSON.stringify({ transaction, checksum: checksum(transaction) }) + "\n");
      if (line.length > limits.transactionBytes || (previous?.bytes ?? 0) + line.length > limits.archiveBytes
          || totalBytes + line.length > limits.totalBytes || (first && archiveCount >= limits.archives)) throw failure("live-archive-capacity");
      const path = join(directory, `${sessionId}.wal`);
      let file;
      try {
        if (!first) {
          const info = await ordinary(path);
          if (info.size !== previous.bytes) throw failure("live-archive-corrupt");
        }
        file = await open(path, first ? "wx" : "a", 0o600);
        await file.writeFile(line);
        if (beforeSync) await beforeSync(transaction); // deterministic fault injection in tests
        await file.sync();
        if (first) await syncDirectory(directory);
        active.set(sessionId, { state, bytes: (previous?.bytes ?? 0) + line.length });
        totalBytes += line.length; if (first) archiveCount += 1;
      } catch (error) {
        // A write/sync failure has an uncertain on-disk result. Stop all new
        // writes until restart recovery instead of acknowledging or appending twice.
        fault = error.status ? error : failure("live-archive-write-failed");
        throw fault;
      } finally { if (file) await file.close().catch(() => {}); }
    });
    tail = operation.catch(() => {});
    try { await operation; } finally { pendingBytes -= reserved; pendingOperations -= 1; }
  }
  return {
    ready,
    reserve: session => commit(session.sessionId, { kind: "reserve", at: session.createdAt, epoch: 0,
      sessionId: session.sessionId, watchId: session.watchId, watchCode: session.watchCode, manifest: null }, true),
    claimReservation: (session, at) => commit(session.sessionId, { kind: "reservation-claim", at, epoch: 0 }),
    activate: (session, manifest, at) => commit(session.sessionId, { kind: "activate", at, epoch: 1, manifest: pick(manifest, MANIFEST_FIELDS) }),
    open: session => commit(session.sessionId, { kind: "open", at: session.createdAt, epoch: 1,
      sessionId: session.sessionId, watchId: session.watchId, watchCode: session.watchCode,
      manifest: pick(session.manifest, MANIFEST_FIELDS) }, true),
    epoch: (session, manifest, at) => commit(session.sessionId, { kind: "epoch", at, epoch: session.epoch + 1, manifest: pick(manifest, MANIFEST_FIELDS) }),
    batch: (session, pending, entries, at) => commit(session.sessionId, {
      kind: "batch", at, epoch: session.epoch, fromSeq: entries[0].seq, toSeq: entries.at(-1).seq,
      producerFrom: pending[0].producerSeq, producerThrough: pending.at(-1).producerSeq,
      records: entries.flatMap((entry, index) => {
        const record = projectLivePathRecord(entry.record);
        return record ? [{ seq: entry.seq, producerSeq: pending[index].producerSeq, record }] : [];
      }),
    }),
    end: (session, reason, at) => commit(session.sessionId, { kind: "end", at, epoch: session.epoch, reason }),
    stats: () => ({ totalBytes, archiveCount, pendingBytes, pendingOperations }),
    close: async () => { closing = true; await tail; active.clear(); },
  };
}
