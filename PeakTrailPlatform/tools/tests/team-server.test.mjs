import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createLiveServer } from "../../server/live-server.mjs";
import { digest } from "../../server/trajectory-contract.mjs";
import { moderate } from "../../server/trajectory-store.mjs";

function fixture(run = "first", date = "2026-10-08T12:00:00Z") {
  return { format: "trajectory-v1", recordingId: digest(`recording-${run}`), runKey: digest(`run-${run}`), timeOriginMs: -2000,
    startedUtc: date, durationMs: 2000, sampleHz: 10, coordinateUnit: "cm",
    map: { buildId: "25306743", scene: "Level_0", levelIndex: 480, layoutKey: digest("layout"), route: ["Shore", "Roots"],
      stages: [{ index: 0, name: "Shore", enterZCm: 0, exitZCm: 1000 }, { index: 1, name: "Roots", enterZCm: 1000, exitZCm: 2000 }],
      alignment: { version: 1, coordinateSpace: "unity-world-cm", landmarks: [
        { key: "progress-point:0", kind: "progress-point", stageIndex: 0, name: "Beach_Entry", positionCm: [0, 0, 0] },
        { key: "progress-point:1", kind: "progress-point", stageIndex: 1, name: "Roots_Entry", positionCm: [1000, 1000, 1000] },
        { key: "progress-point:peak", kind: "progress-point", name: "Peak", positionCm: [0, 1000, 2000] }] } },
    difficulty: { ascent: 1, custom: false, mini: false },
    players: ["Mylu小明", "ALIce", "同名", "同名"].map((name, index) => ({ key: digest(`player-${run}-${index}`), name,
      owner: index === 0, evidence: "native-state", points: Array.from({ length: 21 }, (_, i) => [i * 100, 0, 0, i * 100]),
      events: index === 2 ? [{ tMs: 500, kind: "dead" }] : [] })) };
}

async function isolated(action) {
  const root = await mkdtemp(join(tmpdir(), "peak-teams-test-")), catalogPath = join(root, "catalog.json");
  const mapPackId = `sha256-${digest("map")}`, sourceSceneSha256 = digest("source");
  const packs = join(root, "packs", mapPackId); await mkdir(packs, { recursive: true });
  await writeFile(join(packs, "map-pack.json"), JSON.stringify({ mapPackId, gameBuildId: "25306743", sceneName: "Level_0",
    coordinateSpace: "unity-world-meters", source: { sceneSha256: sourceSceneSha256 } }));
  await writeFile(join(root, "landmarks.25306743.json"), JSON.stringify({ schemaVersion: 1, gameBuildId: "25306743",
    authority: "serialized-map-landmarks", sourceGameAssemblyMvid: "a".repeat(32), sourceGameAssemblySha256: digest("assembly"),
    maps: [{ sceneName: "Level_0", mapPackId, sourceSceneSha256, alignment: fixture().map.alignment }] }));
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, mapPacks: [{ gameBuildId: "25306743", sceneName: "Level_0",
    mapPackId, path: `./packs/${mapPackId}/map-pack.json`, route: fixture().map.route, enabled: true }] }));
  const live = createLiveServer({ trajectoryDir: root, catalogPath });
  await new Promise(done => live.server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${live.server.address().port}`;
  const get = async path => { const res = await fetch(base + path); return { status: res.status, body: await res.json() }; };
  const post = async raw => {
    const response = await fetch(base + "/api/route-uploads", { method: "POST", headers: {
      "content-type": "application/json", "content-encoding": "gzip" }, body: gzipSync(JSON.stringify(raw)) });
    assert.equal(response.status, 201); return response.json();
  };
  try { await action({ root, base, get, post }); }
  finally { live.server.closeAllConnections(); await new Promise(done => live.server.close(done)); await rm(root, { recursive: true, force: true }); }
}

test("four members remain independently selectable, same names stay distinct and own sources win without stitching", async () => {
  await isolated(async ({ post, get, root }) => {
    const raw = fixture(); raw.players[3].points = raw.players[3].points.slice(0, 7);
    const first = await post(raw);
    const copy = structuredClone(raw); copy.recordingId = digest("observer-copy");
    copy.players.forEach((player, index) => { player.owner = index === 1; });
    copy.players[0].points = copy.players[0].points.map(([t, , y, z]) => [t, 50, y, z]);
    copy.players[1].points = copy.players[1].points.map(([t, , y, z]) => [t, 70, y, z]);
    const second = await post(copy);
    const list = await get("/api/route-teams?member=小明");
    assert.equal(list.status, 200); assert.equal(list.body.teams.length, 1);
    const team = list.body.teams[0]; assert.equal(team.members.length, 4);
    assert.equal(team.members.filter(member => member.name === "同名").length, 2);
    assert.equal(team.stageSummaries[0].memberCount, 4); assert.equal(team.stageSummaries[0].completedCount, 2);
    const detail = await get(`/api/route-teams/${team.id}`);
    assert.equal(detail.body.team.mapCompatibility, "matched"); assert.equal(detail.body.team.groupId, first.groupId);
    const view = await get(`/api/route-teams/${team.id}/stages/0/routes`);
    assert.equal(view.body.routes.length, 4); assert.equal(view.body.timeBasis, "recording-ms");
    const ownerA = view.body.routes.find(route => route.playerKey === raw.players[0].key);
    const ownerB = view.body.routes.find(route => route.playerKey === raw.players[1].key);
    assert.equal(ownerA.uploadId, first.uploadId); assert.ok(ownerA.points.every(point => point[1] === 0));
    assert.equal(ownerB.uploadId, second.uploadId); assert.ok(ownerB.points.every(point => point[1] === 70));
    assert.equal(ownerA.points[0][0], 0); assert.equal(ownerA.timeOriginMs, -2000);
    const dead = view.body.routes.find(route => route.playerKey === raw.players[2].key);
    assert.equal(dead.completed, false); assert.ok(dead.breaks.includes(500));
    const next = await get(`/api/route-teams/${team.id}/stages/1/routes`);
    assert.equal(next.body.routes.length, 4);
    assert.equal(next.body.routes.find(route => route.playerKey === raw.players[3].key).points.length, 0);
    const heat = await get(`/api/route-groups/${first.groupId}/stages/0/heatmap?countBy=team&team=${team.id}`);
    assert.equal(heat.body.teamCount, 1); assert.equal(heat.body.routeCount, 2);
    assert.ok(heat.body.cells.every(cell => cell[3] === 1));
    assert.equal((await get("/api/route-teams?member=alice")).body.teams[0].id, team.id);
    // A source withdrawal is authoritative immediately; a remaining approved
    // observation stays visible, then the entire team disappears after both hide.
    await moderate(root, first.uploadId, "hidden");
    assert.equal((await get(`/api/route-teams/${team.id}/stages/0/routes`)).body.routes[0].uploadId, second.uploadId);
    await moderate(root, second.uploadId, "hidden");
    assert.equal((await get(`/api/route-teams/${team.id}`)).status, 404);
    assert.equal((await get(`/api/route-teams/${team.id}/stages/0/routes`)).status, 404);
    assert.deepEqual((await get("/api/route-teams?member=小明")).body.teams, []);
  });
});

test("same-layout different dates and rotation indices reuse a map group but separate teams and heat visits", async () => {
  await isolated(async ({ post, get }) => {
    const first = fixture(); first.players = first.players.slice(0, 2);
    const a = await post(first), later = fixture("later", "2026-11-08T12:00:00Z");
    later.players = later.players.slice(0, 2); later.map.levelIndex = 501;
    const b = await post(later); assert.equal(a.groupId, b.groupId);
    const teams = (await get(`/api/route-teams?group=${a.groupId}`)).body.teams;
    assert.equal(teams.length, 2); assert.notEqual(teams[0].id, teams[1].id);
    const players = (await get(`/api/route-groups/${a.groupId}/stages/0/heatmap?countBy=player`)).body;
    const squads = (await get(`/api/route-groups/${a.groupId}/stages/0/heatmap?countBy=team`)).body;
    assert.equal(players.countBy, "player"); assert.equal(players.teamCount, 2);
    assert.ok(players.cells.every(cell => cell[3] === 4)); assert.ok(squads.cells.every(cell => cell[3] === 2));
    const filtered = (await get(`/api/route-groups/${a.groupId}/stages/0/routes?team=${teams[0].id}`)).body;
    assert.equal(filtered.routes.length, 2);
    assert.equal((await get(`/api/route-teams?group=${a.groupId}&difficulty=ascent-99`)).body.teams.length, 0);
  });
});

test("multiple complete attempts count a member once per cell while routeCount retains the attempts", async () => {
  await isolated(async ({ post, get }) => {
    const raw = fixture(); raw.players = raw.players.slice(0, 1);
    const a = await post(raw), again = structuredClone(raw);
    again.recordingId = digest("later-attempt"); again.timeOriginMs += 10000;
    await post(again);
    const heat = (await get(`/api/route-groups/${a.groupId}/stages/0/heatmap?countBy=player`)).body;
    assert.equal(heat.routeCount, 2); assert.ok(heat.cells.every(cell => cell[3] === 1));
  });
});

test("shared ID without a shared clock never merges recordings; old complete indexes retain team identity", async () => {
  await isolated(async ({ post, get, root }) => {
    const raw = fixture(); raw.players = raw.players.slice(0, 1);
    const receipt = await post(raw), before = (await get("/api/route-teams")).body.teams[0].id;
    const path = join(root, "index", `${receipt.uploadId}.json`), entry = JSON.parse(await readFile(path, "utf8"));
    delete entry.team; await writeFile(path, JSON.stringify(entry));
    assert.equal((await get("/api/route-teams")).body.teams[0].id, before);
    const old = structuredClone(raw); old.recordingId = digest("no-clock-one"); delete old.timeOriginMs;
    const other = structuredClone(old); other.recordingId = digest("no-clock-two");
    await post(old); await post(other);
    assert.equal((await get("/api/route-teams")).body.teams.length, 3);
  });
});

test("partial-only teams stay searchable and resolvable without contributing to heat or decoding for search", async () => {
  await isolated(async ({ post, get, root }) => {
    const raw = fixture(); raw.players = raw.players.slice(0, 1); raw.players[0].points = raw.players[0].points.slice(0, 7);
    const receipt = await post(raw), teams = (await get("/api/route-teams?member=小明")).body.teams;
    assert.equal(teams.length, 1); assert.equal(teams[0].stageSummaries[0].memberCount, 1);
    assert.equal(teams[0].stageSummaries[0].completedCount, 0);
    const groups = (await get("/api/route-groups")).body.groups;
    assert.equal(groups.length, 1); assert.ok(groups[0].stageSummaries.every(stage => stage.routeCount === 0));
    assert.deepEqual((await get(`/api/route-groups/${receipt.groupId}/stages/0/heatmap?countBy=team`)).body.cells, []);
    assert.equal((await get(`/api/route-teams/${teams[0].id}/stages/0/routes`)).body.routes[0].points.length, 7);
    const indexPath = join(root, "index", `${receipt.uploadId}.json`), oldEntry = JSON.parse(await readFile(indexPath, "utf8"));
    delete oldEntry.team; await writeFile(indexPath, JSON.stringify(oldEntry));
    const oldTeam = (await get("/api/route-teams?member=小明")).body.teams[0];
    assert.equal(oldTeam.stageSummaries[0].memberCount, 0, "legacy search does not decompress the raw trajectory");
    const hydrated = (await get(`/api/route-teams/${oldTeam.id}`)).body.team;
    assert.equal(hydrated.stageSummaries[0].memberCount, 1, "selected legacy team detail recovers real partial stage membership");
    assert.equal(hydrated.stageSummaries[0].completedCount, 0);
    assert.equal((await get(`/api/route-teams/${oldTeam.id}/stages/0/routes`)).body.routes[0].points.length, 7);
    assert.equal(JSON.parse(await readFile(indexPath, "utf8")).team, undefined, "legacy detail does not rewrite its index");
    // Search uses only small private metadata. A missing raw blob must fail a
    // selected preview but must not cause mass reads during listing.
    const blob = join(root, "uploads", `${receipt.uploadId}.json.gz`); await rename(blob, blob + ".held");
    assert.equal((await get("/api/route-teams?member=小明")).body.teams.length, 1);
    assert.equal((await get(`/api/route-teams/${oldTeam.id}/stages/0/routes`)).status, 503);
  });
});

test("legacy missing gates remain accepted and selectable as unknown without guessing points into a stage", async () => {
  await isolated(async ({ post, get }) => {
    const raw = fixture(); raw.players = raw.players.slice(0, 1);
    for (const stage of raw.map.stages) { delete stage.enterZCm; delete stage.exitZCm; }
    delete raw.map.alignment;
    await post(raw);
    const team = (await get("/api/route-teams")).body.teams[0];
    const response = await get(`/api/route-teams/${team.id}/stages/0/routes`);
    assert.equal(response.status, 200); assert.equal(response.body.routes.length, 1);
    assert.equal(response.body.routes[0].completion, "unknown"); assert.deepEqual(response.body.routes[0].points, []);
  });
});

test("team search has bounded validated filters, deterministic limits and does not fold same names into identities", async () => {
  await isolated(async ({ post, get }) => {
    for (let index = 0; index < 3; index += 1) await post(fixture(`limit-${index}`));
    const list = (await get("/api/route-teams?member=同名&limit=1")).body;
    assert.equal(list.teams.length, 1); assert.equal(list.truncated, true);
    const all = (await get("/api/route-teams?member=同名&limit=100")).body;
    assert.equal(all.teams.length, 3); assert.equal(all.truncated, false);
    assert.equal(new Set(all.teams.flatMap(team => team.members.map(member => member.playerKey))).size, 12);
    for (const path of ["/api/route-teams?limit=0", "/api/route-teams?limit=101", "/api/route-teams?limit=1.5",
      "/api/route-teams?group=not-a-hash", `/api/route-teams?member=${"a".repeat(81)}`, "/api/route-teams?member=%00",
      `/api/route-groups/${all.teams[0].groupId}/stages/0/heatmap?countBy=owner`,
      `/api/route-groups/${all.teams[0].groupId}/stages/0/routes?team=bad`]) assert.equal((await get(path)).status, 400, path);
    assert.equal((await get(`/api/route-teams/${all.teams[0].id}/stages/99/routes`)).status, 400);
    assert.equal((await get(`/api/route-teams/${digest("missing")}`)).status, 404);
  });
});
