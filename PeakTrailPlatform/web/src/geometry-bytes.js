export const MAX_GEOMETRY_BYTES = 128 * 1024 * 1024;
export const GEOMETRY_FORMATS = Object.freeze(["glb-instanced-v1", "glb-instanced-v1+gzip"]);

/** Decode only after the caller verifies the SHA-256 of the published bytes. */
export async function decodeGeometryBytes(bytes, format, signal) {
  signal?.throwIfAborted();
  if (format === "glb-instanced-v1") return bytes;
  if (format !== "glb-instanced-v1+gzip") throw new Error("不支持的真实模型压缩格式");
  if (typeof DecompressionStream !== "function") throw new Error("此浏览器不支持 gzip 模型解压，请更新浏览器");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_GEOMETRY_BYTES) throw new Error("真实模型解压后超过 128 MiB 安全上限");
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result.buffer;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
