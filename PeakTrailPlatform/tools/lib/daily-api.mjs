import { createDailyCache } from "../../server/peak-daily.mjs";

// The static preview needs today's rotation without a live relay on port 8787.
// Resolve only this fixed, read-only endpoint; clients cannot select an upstream.
export function createDailyApi(options = {}) {
  const cache = createDailyCache(options);
  async function handle(request, response) {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path !== "/api/daily") return false;
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD", "Cache-Control": "no-store" }).end();
      return true;
    }
    let status = 200, payload;
    try { payload = await cache.read(); }
    catch { status = 502; payload = { error: "daily-unavailable" }; }
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify(payload));
    return true;
  }
  return { handle, startPrewarm: cache.startPrewarm };
}
