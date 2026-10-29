import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { geometryAuditRuntime } from "../../tools/lib/geometry-audit-runtime.mjs";

const { geometry, THREE } = await geometryAuditRuntime({ sourceRoot: process.env.PEAK_GEOMETRY_SOURCE_ROOT,
  fallbackRoot: process.env.PEAK_GEOMETRY_FALLBACK_ROOT });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function glb(document = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [] }] }) {
  const json = Buffer.from(JSON.stringify(document));
  const size = Math.ceil(json.length / 4) * 4, bytes = Buffer.alloc(20 + size, 0x20);
  bytes.writeUInt32LE(0x46546c67); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(size, 12); bytes.writeUInt32LE(0x4e4f534a, 16); json.copy(bytes, 20);
  return bytes;
}
function sharedGeometry() {
  const positions = new Float32Array(100000 * 3); positions.fill(100000);
  positions.set([0, 0, 0, 2, 0, 0, 0, 3, 0, -500, -500, -500]);
  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  result.setIndex([3, 3, 3, 0, 1, 2, 3, 3, 3]);
  return result;
}

test("missing bounds visit only drawRange/group vertices and cache across material batches", () => {
  const source = sharedGeometry(), scene = new THREE.Group();
  source.setDrawRange(3, 6); source.addGroup(0, 6, 0);
  let reads = 0; const position = source.attributes.position, read = position.getX;
  position.getX = function (...args) { reads++; return read.apply(this, args); };
  const attributes = source.attributes, index = source.index;
  for (let i = 0; i < 16; i++) scene.add(new THREE.Mesh(source, [new THREE.MeshStandardMaterial()]));
  const root = geometry.batchStaticMeshes(scene);
  assert.equal(reads, 3, "one indexed bounds pass, no 100k shared position-buffer scans or repeated material scans");
  for (const mesh of root.children) {
    assert.deepEqual(mesh.boundingBox.min.toArray(), [0, 0, 0]);
    assert.deepEqual(mesh.boundingBox.max.toArray(), [2, 3, 0]);
    assert.equal(mesh.geometry.attributes, attributes); assert.equal(mesh.geometry.index, index);
    assert.ok(mesh.boundingSphere.center.distanceTo(new THREE.Vector3(2, 0, 0)) <= mesh.boundingSphere.radius + 1e-12);
  }
  assert.equal(source.boundingBox, null, "source geometry and buffers remain unchanged");
});

test("valid existing GLTF bounds are reused without an added index scan", () => {
  const source = sharedGeometry(), scene = new THREE.Group();
  source.boundingBox = new THREE.Box3(new THREE.Vector3(-500, -500, -500), new THREE.Vector3(100000, 100000, 100000));
  const existing = source.boundingBox;
  source.index.getX = () => { throw Error("unnecessary index scan"); };
  scene.add(new THREE.Mesh(source, new THREE.MeshStandardMaterial()));
  const root = geometry.batchStaticMeshes(scene);
  assert.equal(source.boundingBox, existing);
  assert.deepEqual(root.children[0].boundingBox, existing);
});

test("all indexed affine/reflected vertices fit the conservative instance sphere", () => {
  const source = sharedGeometry(), scene = new THREE.Group(); source.setDrawRange(3, 3);
  const material = new THREE.MeshStandardMaterial();
  for (const reflected of [false, true]) {
    const mesh = new THREE.Mesh(source, material);
    mesh.matrix.set(reflected ? -1 : 1, 4, 0, 20, 0, 1, 3, 10, 0, 0, 1, 3, 0, 0, 0, 1);
    mesh.matrixAutoUpdate = false; scene.add(mesh);
  }
  const root = geometry.batchStaticMeshes(scene), matrix = new THREE.Matrix4(), point = new THREE.Vector3();
  for (const mesh of root.children) {
    mesh.getMatrixAt(0, matrix);
    for (const i of [0, 1, 2]) {
      point.fromBufferAttribute(source.attributes.position, i).applyMatrix4(matrix);
      assert.ok(mesh.boundingBox.containsPoint(point)); assert.ok(mesh.boundingSphere.containsPoint(point));
    }
  }
  assert.deepEqual(root.children.map(mesh => mesh.scale.x), [1, -1]);
});

test("actual parser exposes fixed progress stages, yields to timers, and keeps old AbortSignal compatible", async () => {
  const zipped = gzipSync(glb()), previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(zipped);
  const stages = [], controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  try {
    const root = await geometry.loadGameGeometry({ geometryUrl: "private-path-not-in-progress", geometrySha256: sha(zipped), geometryFormat: "glb-instanced-v1+gzip" },
      controller.signal, "26155610", { onProgress: event => {
        assert.ok(Object.keys(event).every(key => ["stage", "loadedBytes", "totalBytes"].includes(key)));
        if (stages.at(-1) !== event.stage) stages.push(event.stage);
      } });
    assert.equal(root.children.length, 0);
    assert.deepEqual(stages, ["download", "hash", "decompress", "parse", "batch", "ready"]);
    assert.ok(ticks > 0, "main-loop timers run between expensive loading stages");
  } finally { clearInterval(timer); globalThis.fetch = previousFetch; }
});

test("bad SHA/external-resource GLB never reaches parsing and batch can be cancelled", async () => {
  const previousFetch = globalThis.fetch, controller = new AbortController();
  const layer = { geometryUrl: "fixture", geometryFormat: "glb-instanced-v1+gzip", geometrySha256: "0".repeat(64) };
  let bytes = gzipSync(glb()); globalThis.fetch = async () => new Response(bytes);
  const before = geometry.audit.parses.length;
  try {
    await assert.rejects(geometry.loadGameGeometry(layer), /哈希不匹配/);
    bytes = gzipSync(glb({ asset: { version: "2.0" }, images: [{ uri: "https://example.invalid/external.png" }] }));
    await assert.rejects(geometry.loadGameGeometry({ ...layer, geometrySha256: sha(bytes) }), /外部资源/);
    assert.equal(geometry.audit.parses.length, before);
    bytes = gzipSync(glb());
    await assert.rejects(geometry.loadGameGeometry({ ...layer, geometrySha256: sha(bytes) }, controller.signal, "26155610", {
      onProgress: event => { if (event.stage === "batch") setTimeout(() => controller.abort(), 0); },
    }), { name: "AbortError" });
  } finally { globalThis.fetch = previousFetch; }
});
