import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { cacheControlFor } from "./lib/serve-headers.mjs";

await import("./stage-site.mjs");
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../site-dist"));
const mime = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".f32": "application/octet-stream",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
};
function withinRoot(path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    let target = resolve(root, `.${pathname}`);
    if (!withinRoot(target)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if ((await stat(target)).isDirectory()) target = resolve(target, "index.html");
    target = await realpath(target);
    if (!withinRoot(target)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "Content-Type": mime[extname(target)] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": cacheControlFor(pathname),
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(target).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

// Bind only loopback. If another viewer already uses the preferred port, use an OS-assigned
// free port instead of opening an unrelated service or terminating another user's process.
// Loopback by default; --host 0.0.0.0 (or a LAN IP) serves other devices on the network.
const hostFlag = process.argv.indexOf("--host");
const portFlag = process.argv.indexOf("--port");
const listenHost = hostFlag >= 0 ? process.argv[hostFlag + 1] : "127.0.0.1";
const listenPort = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4173;
await new Promise((done, reject) => {
  server.once("error", (error) => {
    if (error.code !== "EADDRINUSE") return reject(error);
    server.once("error", reject);
    server.listen(0, listenHost, done);
  });
  server.listen(listenPort, listenHost, done);
});
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`PEAK Trail is ready: ${url}`);
console.log("Keep this window open while using the viewer. Press Ctrl+C to stop.");
if (process.argv.includes("--open")) {
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`], { windowsHide: true, stdio: "ignore" })
    : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
  child.on("error", () => console.log(`Open this address in your browser: ${url}`));
}
process.on("SIGINT", () => { server.close(); server.closeAllConnections(); });
process.on("SIGTERM", () => { server.close(); server.closeAllConnections(); });
