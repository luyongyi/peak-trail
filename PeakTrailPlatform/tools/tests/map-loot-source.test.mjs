import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import test from "node:test";
import { publicMapLootChunk, readMapLootSource } from "../lib/map-loot-source.mjs";

const sha = body => createHash("sha256").update(body).digest("hex");
const build = "26134529";
const pack = { mapPackId: `sha256-${"a".repeat(64)}`, gameBuildId: build,
  sceneName: "Level_207", mapSlot: 207, source: { sceneSha256: "b".repeat(64) },
  layers: [{ id: "shore", segment: 0, geometrySha256: "c".repeat(64) }] };
const fixture = () => ({ schemaVersion: 1, gameBuildId: build,
  source: { kind: "canonical-map-geometry-survey", componentCoverage: "native components", privateField: "excluded" },
  types: [{ id: "chest-small", category: "chest", name: "小型行李箱", nameEn: "Small Luggage" }],
  maps: [{ mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
    sourceSceneSha256: pack.source.sceneSha256, layers: pack.layers,
    markers: [{ id: "chest:1", type: "chest-small", category: "chest", placement: "fixed",
      pos: [1, 2, 3], segment: 0, layerId: "shore" }] }] });

async function directory(t) {
  const root = await mkdtemp(resolve(tmpdir(), "peak-map-loot-source-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("peak-map-loot-source-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function indexed(t, raw = fixture()) {
  const root = await directory(t);
  const path = `loot/${build}/${pack.mapPackId}.json`;
  const file = resolve(root, path), indexFile = resolve(root, `loot.${build}.json`);
  const body = JSON.stringify(raw) + "\n";
  const index = { schemaVersion: 1, kind: "map-loot-index", gameBuildId: build, source: raw.source,
    maps: [{ mapPackId: pack.mapPackId, sceneName: pack.sceneName, mapSlot: pack.mapSlot,
      sourceSceneSha256: pack.source.sceneSha256, path, sha256: sha(body), size: Buffer.byteLength(body) }] };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  await writeFile(indexFile, JSON.stringify(index));
  return { root, file, indexFile, index, raw, body };
}

test("legacy complete surveys still produce bounded public chunks with exact source identity", async t => {
  const root = await directory(t), raw = fixture();
  await writeFile(resolve(root, `loot.${build}.json`), JSON.stringify(raw));
  const source = await readMapLootSource(root, build);
  const output = await publicMapLootChunk(source, pack), body = JSON.parse(output.body);
  assert.equal(output.sha256, sha(output.body));
  assert.equal(body.maps.length, 1);
  assert.equal(body.maps[0].markers[0].name, raw.types[0].name);
  assert.equal(body.source.componentCoverage, "native components");
  assert.equal(body.source.privateField, undefined);
  assert.equal(output.entry.path, `loot/${build}/${pack.mapPackId}.json`);
  assert.equal(output.entry.sourceSceneSha256, pack.source.sceneSha256);
});

test("an indexed source reads only the selected map and supports the full 208-map pool", async t => {
  const f = await indexed(t);
  for (let slot = 0; slot < 207; slot++) {
    const mapPackId = `sha256-${sha(String(slot))}`;
    f.index.maps.push({ ...f.index.maps[0], mapPackId, sceneName: `Level_${slot}`, mapSlot: slot,
      path: `loot/${build}/${mapPackId}.json` });
  }
  await writeFile(f.indexFile, JSON.stringify(f.index));
  const source = await readMapLootSource(f.root, build);
  assert.equal(source.raw.maps.length, 208);
  assert.ok(source.raw.maps.every(entry => !Object.hasOwn(entry, "markers")));
  const output = await publicMapLootChunk(source, pack);
  assert.equal(JSON.parse(output.body).maps[0].markers.length, 1);
  assert.equal(await source.readMap(`sha256-${"f".repeat(64)}`), null);
});

test("changed chunk bytes are rejected even when valid JSON still has the same identity", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  const changed = f.body.replace('"pos":[1,2,3]', '"pos":[9,2,3]');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(f.body));
  await writeFile(f.file, changed);
  await assert.rejects(publicMapLootChunk(source, pack), /checksum mismatch/);
});

test("index size is checked independently of its checksum", async t => {
  const f = await indexed(t);
  f.index.maps[0].size += 1;
  await writeFile(f.indexFile, JSON.stringify(f.index));
  const source = await readMapLootSource(f.root, build);
  await assert.rejects(source.readMap(pack.mapPackId), /checksum mismatch/);
});

test("path substitution, duplicate entries and malformed references fail before any chunk is opened", async t => {
  const f = await indexed(t);
  for (const mutate of [
    entry => entry.path = "../private.json",
    entry => entry.path = `loot/${build}/different.json`,
    entry => entry.path = f.file,
    entry => entry.path = "https://example.invalid/loot.json",
    entry => entry.mapPackId = "../../private",
    entry => entry.sha256 = "invalid",
    entry => entry.size = 24 * 1024 * 1024 + 1,
    entry => entry.size = 0,
  ]) {
    const value = structuredClone(f.index); mutate(value.maps[0]);
    await writeFile(f.indexFile, JSON.stringify(value));
    await assert.rejects(readMapLootSource(f.root, build), /chunk reference/, mutate.toString());
  }
  f.index.maps.push(f.index.maps[0]);
  await writeFile(f.indexFile, JSON.stringify(f.index));
  await assert.rejects(readMapLootSource(f.root, build), /chunk reference/);
});

test("a matching checksum cannot authorize changed map identity or a different build", async t => {
  const f = await indexed(t);
  for (const mutate of [
    value => value.gameBuildId = "25739797",
    value => value.schemaVersion = 2,
    value => value.maps[0].mapPackId = `sha256-${"d".repeat(64)}`,
    value => value.maps[0].sceneName = "Level_0",
    value => value.maps[0].mapSlot = 0,
    value => value.maps[0].sourceSceneSha256 = "e".repeat(64),
    value => value.maps.push(value.maps[0]),
  ]) {
    const value = fixture(); mutate(value);
    const body = JSON.stringify(value);
    f.index.maps[0].sha256 = sha(body); f.index.maps[0].size = Buffer.byteLength(body);
    await writeFile(f.file, body); await writeFile(f.indexFile, JSON.stringify(f.index));
    const source = await readMapLootSource(f.root, build);
    await assert.rejects(source.readMap(pack.mapPackId), /identity mismatch/, mutate.toString());
  }
});

test("manifest scene and geometry binding remain required after successful indexed-file verification", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  for (const mutate of [
    value => value.gameBuildId = "25739797",
    value => value.source.sceneSha256 = "e".repeat(64),
    value => value.layers[0].geometrySha256 = "e".repeat(64),
    value => value.layers[0].segment = 1,
  ]) {
    const manifest = structuredClone(pack); mutate(manifest);
    await assert.rejects(publicMapLootChunk(source, manifest), /does not match/, mutate.toString());
  }
});

test("missing optional survey is tolerated but a missing declared chunk aborts publication", async t => {
  const f = await indexed(t);
  assert.equal(await readMapLootSource(f.root, "25739797"), null);
  const source = await readMapLootSource(f.root, build);
  await rm(f.file);
  await assert.rejects(publicMapLootChunk(source, pack), { code: "ENOENT" });
});

test("malformed survey JSON, wrong root identity and non-regular files are rejected", async t => {
  const root = await directory(t), path = resolve(root, `loot.${build}.json`);
  await writeFile(path, "{broken");
  await assert.rejects(readMapLootSource(root, build), SyntaxError);
  for (const value of [{ ...fixture(), gameBuildId: "25739797" }, { ...fixture(), schemaVersion: 2 },
    { ...fixture(), maps: Array.from({ length: 513 }, () => ({})) }]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readMapLootSource(root, build), /survey identity/);
  }
  await rm(path); await mkdir(path);
  await assert.rejects(readMapLootSource(root, build), /regular file/);
  for (const value of ["../1", "0", "12a", "1".repeat(21)])
    await assert.rejects(readMapLootSource(root, value), /Invalid supply survey build/);
});

test("a source is re-read on every publication pass instead of caching stale marker bodies", async t => {
  const f = await indexed(t), source = await readMapLootSource(f.root, build);
  const first = await publicMapLootChunk(source, pack);
  assert.equal(first.sha256, sha(first.body));
  const original = await readFile(f.file, "utf8");
  await writeFile(f.file, original.replace('"pos":[1,2,3]', '"pos":[4,2,3]'));
  await assert.rejects(publicMapLootChunk(source, pack), /checksum mismatch/);
});
