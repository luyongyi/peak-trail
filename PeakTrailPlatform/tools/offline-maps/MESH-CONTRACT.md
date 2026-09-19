# Original triangle scene export

`export_meshes.py` is the preferred 3D export. It preserves the installed game's
indexed MeshFilter triangles, shared vertices, original UVs, component separation,
and complete instance transforms. It does not reconstruct trees or rocks from a
height field, join separate components, remove triangles, quantize positions,
or project an overhead picture onto vertical faces.

## Build

```powershell
& PeakTrailPlatform/tools/offline-maps/setup-env.ps1
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/export_meshes.py --slots 16 --layers 0,1
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/export_meshes.py --slots all
```

The output is separate from the v2 packs:
`local/assets/maps/working/mesh-v3/<build>/Level_<slot>/`. Each layer contains a GLB with
embedded source-derived PNG textures. Existing height/PNG files are retained as
a separate planar reference and to support old clients, not as the 3D geometry.

The exporter first reads the matching planar-reference manifest, PNGs and height
files from `local/assets/maps/working/legacy/<build>/Level_<slot>/`. Both paths
are derived from `__file__`'s repository root and can be changed using `--legacy`
and `--output`.

After a clean migration, do not copy the old duplicate working trees just to
restore this input. The already-registered canonical pack contains the same
planar reference. For each catalog-selected pack, copy only `map-pack.json` and
the files named by each layer's `texture`/`height` into the legacy structure
above, using its `gameBuildId` and `sceneName`. There is no need to copy its GLBs
into legacy. The exporter accepts that canonical v3 manifest, clears its old
geometry references, and creates new unsigned geometry outputs. Keep published
canonical packs unchanged. Alternatively run `build_maps.py` to regenerate the
reference from the installed game.

`mesh-export.json` is an incremental unsigned manifest for completed layers.
After all layers finish, `map-pack.json` contains the complete unsigned v3 pack.
The publishing workflow must compute its canonical v3 identity and register it
before staging. The generator deliberately does not mutate the active catalog.

Publishing may wrap a completed GLB in lossless **outer gzip** to reduce the
large JSON instance-transform section. Such a layer uses
`geometryFormat: "glb-instanced-v1+gzip"` and a `.glb.gz` filename. Its
`geometrySha256` is the SHA-256 of the **compressed file bytes**, not the
decompressed GLB. The publishing step recomputes the canonical map-pack identity
after updating these fields. Do not gzip a canonical registered file in place.

Clients verify the compressed hash first, then gunzip with a 128 MiB output
limit, then parse the unchanged GLB including its internal lossless meshopt
buffers. This is an explicit asset-file format, not implicit HTTP
`Content-Encoding: gzip`; hosts should serve `.glb.gz` as opaque bytes to avoid
double decompression. Geometry, original textures and every affine matrix are
unchanged. An outer archive is preferable to reducing triangles or texture
quality solely to meet the GitHub Pages size budget.

## Layer fields

```json
{
  "geometry": "segment-00-shore.glb",
  "geometrySha256": "<lowercase SHA-256>",
  "geometryFormat": "glb-instanced-v1",
  "meshBounds": {"min": [0, 0, 0], "max": [1, 1, 1]},
  "meshStatistics": {"uniqueMeshes": 212, "instances": 4099}
}
```

The legacy `minX`/`maxX` etc describe the solid playable area's sampling extent.
`meshBounds` includes all visible source decoration, which can extend far below
or outside the playable section. Camera fitting may use the former to avoid
letting a large distant background mesh shrink the useful view.

## GLB loader requirements

- glTF 2.0, `EXT_mesh_gpu_instancing`, and `EXT_meshopt_compression`.
- For `glb-instanced-v1+gzip`, verify the stored SHA-256 and gunzip (maximum
  output 128 MiB) before invoking the glTF loader.
- Geometry and transforms retain raw **Unity world XYZ**. Do not mirror Z or
  add an axis-rotation conversion. Source triangle winding was checked against
  stored source normals; both agree in this coordinate representation.
- Unity mesh UV0 is preserved, with only `v = 1-v` for glTF's image convention.
  Original material UV scale/offset is baked into that mesh UV accessor. There
  is no world-X/Z projected texture.
- Every compressed accessor is decoded and compared **byte for byte** with its
  original source buffer while exporting. The encoder uses `ATTRIBUTES` or
  `INDICES`, with filter `NONE`; no lossy quantization or vertex reorder runs.
- Normals and positions are original float32 attributes. Texture images use the
  existing source extraction's maximum 512-pixel side and are embedded in GLB.
- Many repeated rocks and trees reference the same shared mesh. Non-sheared
  instances use `EXT_mesh_gpu_instancing`. Any affine transform that fails the
  strict reconstruction tolerance remains a regular node with full `matrix`.

### Preserve shear after Three.js parsing

Three.js `Object3D.applyMatrix4` decomposes a matrix into TRS. Its normal automatic
matrix update would discard a shear. Before calculating world matrices and before
batching ordinary meshes, restore full source matrices from the GLTF parser:

```js
gltf.scene.traverse((object) => {
  const association = gltf.parser.associations.get(object);
  const source = association?.nodes === undefined
    ? null : gltf.parser.json.nodes[association.nodes];
  if (source?.matrix) {
    object.matrix.fromArray(source.matrix);
    object.matrixAutoUpdate = false;
  }
});
gltf.scene.updateMatrixWorld(true);
```

Regular meshes with the same geometry/material can then be batched into
`THREE.InstancedMesh` using the full `matrixWorld`. That batching preserves
shear and avoids thousands of draw calls. Keep the component triangles separate;
do not weld their vertices or create connecting surfaces.

Alpine sections contain mirrored native instances (1,210 across this build's
21 scenes). Separate positive- and negative-determinant instance batches.
Three.js cannot treat mixed-sign InstancedMesh matrices like regular per-object
draws. A mirrored parent plus compensating local reflection preserves the exact
world matrix while giving the entire batch one consistent front-face parity.
Level_16 has no mirrored instances, so it alone does not exercise this case.

## Source material approximation

The GLB has standard PBR materials plus `material.extras.peakTerrain`:

```json
{
  "colorSpace": "linear",
  "baseColor": [0.5, 0.3, 0.1],
  "topColor": [0.7, 0.5, 0.2],
  "topAlpha": 1,
  "tightness": [0.5, 1],
  "amount": 1,
  "sourceMaterial": "<installed game material name>"
}
```

These colors come from the actual material properties, not a chosen biome
palette. The shader approximation blends the base and top color by
`smoothstep(lo, hi, max(worldNormal.y, 0)) * amount * topAlpha`. Colors are already
linear. Multiply the resulting color by the base texture sampled at original
UVs. Correctly transformed world normals matter for rotated/scaled instances.

That world-up blend is only reproduced for `W/Peak_Rock`, where the build's own
survey capture confirms it (sand-coloured tops on sand and rock matching each
material's authored top colour). Three shader families contradict the same
capture and must not be painted by surface slope: `GD/FoliageGD` and
`W/Peak_Mirage` store one shared default `_TopColor` `[0.11, 0.19, 0.19]` for
every material (a tall cactus crown stays pink in the capture, not teal), and
`W/Peak_Petrified_Rock` would turn desert stone cyan or black while the capture
shows warm tan. The viewer therefore zeroes `amount` for those shaders
(`verifiableTopBlend` in `web/src/geometry-loader.js`). Prop albedo, alpha masks
and vertex AO are still approximated from the layered foliage shader; see the
known limitations in the material report.

Color conversion is selected using the installed shader's property metadata.
`sourceColors` records the shader name, selected base property, raw stored colors,
and base/top property flags. HDR/Gamma Color flags (16/32) retain the stored linear
value; ordinary Color properties use sRGB-to-linear conversion. In particular,
Shore `_BaseColor` is HDR while `_TopColor` is ordinary Color; converting both
as sRGB incorrectly darkens the rock sidewalls. This follows the storage behavior
documented by [Unity 6 Material.SetColor](https://docs.unity3d.com/jp/current/ScriptReference/Material.SetColor.html)
and [ShaderPropertyFlags](https://github.com/Unity-Technologies/UnityCsReference/blob/master/Runtime/Export/Shaders/ShaderProperties.cs).

PEAK-specific material masks, animated water, wind, special fog and lighting
still require game-specific shader work. Geometry fidelity should not be
described as full shader fidelity. Moving game objects and runtime-spawned loot
remain outside the static scene export and belong to recorded telemetry.

The browser's `web/src/source-materials.js` contains a small, exact-build/name/
shader adapter for eight source effect materials (Lava, five Water materials,
and two FogSurface materials). It avoids using a near-white tint multiplier as
the color of an entire lava/water plane. The unmodified source color values,
shader flags and blending state used by the regression tests are preserved in
the tracked `tools/offline-maps/source-effect-materials.25306743.json` snapshot
(relative to `PeakTrailPlatform`). Reproduce them with
`extract_surface_materials.py`, which writes fresh evidence to the ignored
`local/assets/evidence/source-effect-materials.25306743.json` under the repository
root. Regeneration does not overwrite the tracked test snapshot automatically.
The adapter changes no geometry or pack bytes.
Lava uses its original HDR `_BaseColor` as emission. Water uses original
`_WaterColorPrimary`, with an explicitly opaque color-only fallback because
depth/refraction/foam alpha is not reproduced. Fog uses original `_Color` and
`_Opacity`. These are limited shader approximations, not full shader ports.

## Measured prototype

Steam build 25306743, Level_16:

| Section | Drawn source triangles | Unique source triangles | Instances | Lossless GLB |
| --- | ---: | ---: | ---: | ---: |
| Shore | 6,709,766 | 175,510 | 4,099 | 5,291,140 bytes |
| Roots | 10,562,552 | 220,378 | 6,692 | 7,536,024 bytes |

Sixty-seven empty Roots renderer meshes were skipped; no triangles were removed.
The entire six-layer Level_16 pack's GLBs total 35,624,860 bytes.

## Independent readback audit

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/test_geometry.py
node PeakTrailPlatform/tools/offline-maps/audit-meshes.mjs local/assets/maps/working/mesh-v3/25306743 16
# Omit the final slot argument to audit all 21 scenes.
node PeakTrailPlatform/tools/offline-maps/validate-glb.mjs local/assets/maps/working/mesh-v3/25306743/Level_16/segment-00-shore.glb
```

The independent audit decodes the final GLBs, checks SHA-256, finite geometry,
index bounds, triangle winding versus source normals, mirrored instance counts,
and source-color metadata. Level_16's 1,240,543 unique triangles have a positive
normal/winding proportion of 99.79–99.98% per layer; the largest negative-facing
area fraction is 0.00735%, consistent with a few native smoothing anomalies,
not an axis inversion. None of its instances have a negative determinant.
The official glTF validator reports 0 errors and 0 warnings for all 126 layers; its
unsupported-extension information is supplemented by our meshopt readback.

The audit accepts an entire parent folder of packs or one canonical pack folder,
handles both plain and outer-gzipped GLBs, and authenticates stored bytes before
decompression. `--report <path.json>` writes the full per-layer SHA-256 report.
