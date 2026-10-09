import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { proxyRouteRead, routeApiBase } from "../lib/route-proxy.mjs";

async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${server.address().port}`; }
function close(server) { return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }

test("development route proxy is read-only, preserves filtering, and cannot proxy arbitrary paths", async () => {
  const requests = [];
  const upstream = createServer((request, response) => {
    requests.push({ url: request.url, method: request.method });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ groups: [], url: request.url }));
  });
  const base = await listen(upstream);
  const proxy = createServer(async (request, response) => {
    if (!await proxyRouteRead(request, response, base)) response.writeHead(404).end();
  });
  const origin = await listen(proxy);
  try {
    const response = await fetch(`${origin}/api/route-groups/test_abc/stages/0/routes?difficulty=ascent-3`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).url, "/api/route-groups/test_abc/stages/0/routes?difficulty=ascent-3");
    assert.equal((await fetch(`${origin}/api/route-groups`, { method: "POST", body: "private-recording" })).status, 405);
    assert.equal((await fetch(`${origin}/api/route-uploads`)).status, 404);
    assert.equal((await fetch(`${origin}/api/runs`)).status, 404);
    assert.equal((await fetch(`${origin}/api/route-groups/test/stages/0/heatmap`, { method: "HEAD" })).status, 200);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === "GET"));
    const inspection = `/api/route-groups/${"a".repeat(64)}/uploads/${"b".repeat(64)}/stages/3/inspection`;
    const preview = await fetch(origin + inspection);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).url, inspection);
    assert.equal((await fetch(origin + inspection, { method: "POST", body: "private-recording" })).status, 405);
    assert.equal((await fetch(origin + inspection.replace("b".repeat(64), "bad-upload"))).status, 404);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.method === "GET"));
  } finally { await close(proxy); await close(upstream); }
});

test("proxy failure returns a bounded unavailable response and configuration refuses credentials and paths", async () => {
  const unused = createServer();
  const unavailable = await listen(unused);
  await close(unused);
  const proxy = createServer(async (request, response) => { await proxyRouteRead(request, response, unavailable); });
  const origin = await listen(proxy);
  try {
    const response = await fetch(`${origin}/api/route-groups`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "route-service-unavailable" });
    assert.equal(routeApiBase(), "http://127.0.0.1:8787");
    for (const value of ["file:///secret", "http://user:pass@localhost", "http://localhost/private", "http://localhost?token=secret"]) assert.throws(() => routeApiBase(value));
  } finally { await close(proxy); }
});
