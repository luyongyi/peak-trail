import { open } from "node:fs/promises";

// Linux production requires directory fsync as well as file fsync before an ACK.
// Windows does not expose POSIX directory handles through Node.
export async function syncDirectory(path) {
  let file;
  try { file = await open(path, "r"); await file.sync(); }
  catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)) throw error;
  } finally { await file?.close(); }
}
export async function writeDurable(path, value) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
}
