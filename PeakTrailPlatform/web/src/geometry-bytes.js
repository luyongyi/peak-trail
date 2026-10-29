export const MAX_GEOMETRY_BYTES = 128 * 1024 * 1024;
export const GEOMETRY_FORMATS = Object.freeze(["glb-instanced-v1", "glb-instanced-v1+gzip"]);

// Some supported WebKit versions have AbortSignal but no throwIfAborted().
export function checkGeometryAbort(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("模型加载已取消", "AbortError");
}

export function reportGeometryProgress(onProgress, stage, loadedBytes, totalBytes) {
  const progress = { stage };
  if (Number.isSafeInteger(loadedBytes) && loadedBytes >= 0) progress.loadedBytes = loadedBytes;
  if (Number.isSafeInteger(totalBytes) && totalBytes >= 0) progress.totalBytes = totalBytes;
  // Diagnostics must not prevent a valid map from loading.
  try { onProgress?.(progress); } catch { /* optional observer */ }
}

export async function yieldGeometryTask(signal) {
  checkGeometryAbort(signal);
  await new Promise(resolve => setTimeout(resolve, 0));
  checkGeometryAbort(signal);
}

function byteView(bytes) {
  return ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
}

async function readChunks(reader, signal, append) {
  const cancel = () => { reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener?.("abort", cancel, { once: true });
  try {
    while (true) {
      checkGeometryAbort(signal);
      const { done, value } = await reader.read();
      checkGeometryAbort(signal);
      if (done) break;
      append(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener?.("abort", cancel);
    reader.releaseLock();
  }
}

/** Bound the compressed delivery as well as the eventual GLB. Content-Length
 * is an early bound only; count actual stream bytes even when it is absent. */
export async function readGeometryResponse(response, signal, onProgress) {
  checkGeometryAbort(signal);
  const header = response.headers?.get("content-length");
  const total = header && /^\d+$/.test(header) ? Number(header) : undefined;
  if (total > MAX_GEOMETRY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("真实模型下载超过 128 MiB 安全上限");
  }
  reportGeometryProgress(onProgress, "download", 0, total);
  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();
    checkGeometryAbort(signal);
    if (bytes.byteLength > MAX_GEOMETRY_BYTES) throw new Error("真实模型下载超过 128 MiB 安全上限");
    reportGeometryProgress(onProgress, "download", bytes.byteLength, total);
    return bytes;
  }
  const chunks = [];
  let length = 0;
  await readChunks(response.body.getReader(), signal, value => {
    length += value.byteLength;
    if (length > MAX_GEOMETRY_BYTES) throw new Error("真实模型下载超过 128 MiB 安全上限");
    chunks.push(value);
    reportGeometryProgress(onProgress, "download", length, total);
  });
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}

/** Decode only after the caller verifies the SHA-256 of the published bytes.
 * Exported packs contain one gzip member. Its bounded ISIZE lets us fill one
 * output buffer, without retaining all output chunks and then copying them. */
export async function decodeGeometryBytes(bytes, format, signal, onProgress) {
  checkGeometryAbort(signal);
  if (bytes.byteLength > MAX_GEOMETRY_BYTES) throw new Error("真实模型下载超过 128 MiB 安全上限");
  if (format === "glb-instanced-v1") return bytes;
  if (format !== "glb-instanced-v1+gzip") throw new Error("不支持的真实模型压缩格式");
  if (typeof DecompressionStream !== "function") throw new Error("此浏览器不支持 gzip 模型解压，请更新浏览器");
  const input = byteView(bytes);
  if (input.byteLength < 18 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) throw new Error("真实模型 gzip 头无效");
  const expected = new DataView(input.buffer, input.byteOffset, input.byteLength).getUint32(input.byteLength - 4, true);
  if (expected > MAX_GEOMETRY_BYTES) throw new Error("真实模型解压后超过 128 MiB 安全上限");
  if (expected < 20) throw new Error("真实模型 gzip 长度无效");
  const result = new Uint8Array(expected);
  let inputOffset = 0;
  // A byte view avoids Blob's copy of the entire compressed delivery. Pull
  // small slices so the decompressor can apply backpressure between reads.
  const stream = new ReadableStream({ pull(controller) {
    if (inputOffset === input.byteLength) { controller.close(); return; }
    const end = Math.min(inputOffset + 64 * 1024, input.byteLength);
    controller.enqueue(input.subarray(inputOffset, end)); inputOffset = end;
  } });
  let length = 0;
  reportGeometryProgress(onProgress, "decompress", 0, expected);
  await readChunks(stream.pipeThrough(new DecompressionStream("gzip")).getReader(), signal, value => {
    if (length + value.byteLength > expected) throw new Error("真实模型 gzip 长度不符或包含多个成员");
    result.set(value, length); length += value.byteLength;
    reportGeometryProgress(onProgress, "decompress", length, expected);
  });
  if (length !== expected) throw new Error("真实模型 gzip 长度不符");
  return result.buffer;
}
