import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, Raycaster, Vector3 }
  from "../../vendor/three/0.180.0/build/three.module.js";
import { parseGlb, readFloatAccessor } from "../../tools/offline-maps/export-loot-from-geometry.mjs";

const glb = parseGlb(await readFile(new URL("../src/airport/26542162.glb", import.meta.url)));
const primitives = glb.json.meshes.flatMap(mesh => mesh.primitives);

function surface(name) {
  const primitive = primitives.find(p => glb.json.materials[p.material].name === name);
  assert.ok(primitive, `missing Airport surface: ${name}`);
  const geometry = new BufferGeometry();
  for (const [attribute, key, size] of [["position", "POSITION", 3], ["uv", "TEXCOORD_0", 2]]) {
    if (key in primitive.attributes) {
      geometry.setAttribute(attribute, new Float32BufferAttribute(readFloatAccessor(glb, primitive.attributes[key]).flat(), size));
    }
  }
  const indices = glb.json.accessors[primitive.indices], view = glb.json.bufferViews[indices.bufferView];
  const start = (view.byteOffset ?? 0) + (indices.byteOffset ?? 0);
  const width = { 5121: 1, 5123: 2, 5125: 4 }[indices.componentType];
  geometry.setIndex(Array.from({ length: indices.count }, (_, i) => glb.binary.readUIntLE(start + i * (view.byteStride ?? width), width)));
  return { material: glb.json.materials[primitive.material], mesh: new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide })) };
}

function checkNativeTexture(material) {
  assert.ok(material.extensions?.KHR_materials_unlit, `${material.name} needs its native baked appearance`);
  const texture = glb.json.textures[material.pbrMetallicRoughness.baseColorTexture.index];
  const image = glb.json.images[texture.source];
  assert.ok(glb.json.bufferViews[image.bufferView].byteLength > 0, "baked image is embedded");
}

function hits(mesh, x, z) {
  const found = new Raycaster(new Vector3(x, 20, z), new Vector3(0, -1, 0)).intersectObject(mesh);
  assert.ok(found.length, `no surface at (${x}, ${z})`);
  return found;
}

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected} ± ${tolerance}, got ${actual}`);
}

function topOf(mesh) {
  const positions = mesh.geometry.getAttribute("position");
  let top = -Infinity;
  for (const vertex of mesh.geometry.index.array) top = Math.max(top, positions.getY(vertex));
  return top;
}

test("Airport preserves the tiled passport floor and its raised carpet in the native camera orientation", () => {
  const { mesh, material } = surface("Airport native floor");
  checkNativeTexture(material);
  // The Unity bake looks straight down. World +X points right and world +Z points up in the source image.
  for (const [x, z, height] of [[-3, 65, .555], [-7.01, 65.49, .569], [-10, 65, .569], [-9, 112, .569]]) {
    const [sample] = hits(mesh, x, z);
    near(sample.point.y, height, .002);
    near(sample.uv.x, (x + 40) / 88, .0002);
    near(sample.uv.y, (152 - z) / 108, .0002);
  }
  assert.ok(hits(mesh, -7.01, 65.49).some(h => Math.abs(h.point.y - .555) < .002), "passport tiles beneath carpet");
});

test("Airport retains the baked crash-pad top and the full-height practice wall", () => {
  const pad = surface("Airport native climbing mats");
  checkNativeTexture(pad.material);
  near(hits(pad.mesh, .5, 62)[0].point.y, 1.141, .007);
  near(topOf(pad.mesh), 1.1415, .006);
  near(topOf(surface("Climbing Wall").mesh), 13.879, .03);
  near(topOf(surface("Climbing Holds").mesh), 14.174, .03);
});
