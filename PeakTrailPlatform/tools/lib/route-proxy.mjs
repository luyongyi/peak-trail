import { Readable } from "node:stream";

export function routeApiBase(value = "http://127.0.0.1:8787") {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("--route-api must be an HTTP(S) server origin without credentials or a path");
  }
  return url.origin;
}

// Only the read-only historical collection API is proxied. Local file imports
// and POST uploads are never silently forwarded by the static preview server.
export async function proxyRouteRead(request, response, base) {
  const url = new URL(request.url, "http://127.0.0.1");
  const collection = /^\/api\/route-groups(?:\/[a-zA-Z0-9_-]+\/stages\/\d+\/(?:routes|heatmap))?$/.test(url.pathname);
  const inspection = /^\/api\/route-groups\/[a-f0-9]{64}\/uploads\/[a-f0-9]{64}\/stages\/\d+\/inspection$/.test(url.pathname);
  const teams = /^\/api\/route-teams(?:\/[a-f0-9]{64}(?:\/stages\/\d+\/routes)?)?$/.test(url.pathname);
  if (!collection && !inspection && !teams) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return true;
  }
  try {
    const upstream = await fetch(new URL(url.pathname + url.search, base), {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD" || !upstream.body) { await upstream.body?.cancel(); response.end(); }
    else {
      const stream = Readable.fromWeb(upstream.body);
      response.once("close", () => stream.destroy());
      stream.on("error", () => response.destroy()).pipe(response);
    }
  } catch {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify({ error: "route-service-unavailable" }));
    else response.destroy();
  }
  return true;
}
