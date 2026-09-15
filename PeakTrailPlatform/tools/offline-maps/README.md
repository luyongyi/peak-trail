# Offline PEAK map baker

The current preferred 3D path is [original triangle GLB export](MESH-CONTRACT.md).
The height-field pipeline below remains a planar-reference/legacy export; it
does not represent vertical cliffs, overhangs or trees as accurately as the GLBs.

This pipeline reads the installed game's serialized Unity scene, mesh, material,
texture and collider assets. It never launches PEAK, executes game scripts,
changes game files, or loads scenes into a multiplayer session. Blender is not
required: a software orthographic rasterizer produces the survey PNG and height
field; the current browser displays the separate original GLB export.

## Run

Python 3.12 (tested 3.12.10), Node.js 24 and the pinned packages are required.
The map and game-asset tools share the repository-local environment
`local/python/.venv`. Do not copy a virtual environment from another checkout;
its launcher/configuration can retain the old absolute path. Set it up once:

```powershell
& PeakTrailPlatform/tools/offline-maps/setup-env.ps1
```

From the workspace root:

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/build_maps.py --slots 16
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/build_maps.py --slots all
```

`--game` changes the installation directory. `--texture 1024 --height 512` are
the default square resolutions. `--slots 0,1,2` bakes a subset. `--output`
overrides the generated pack root. Each scene takes approximately 45 seconds on
the tested machine, and about 1–1.5 GiB while running. Two processes can build
disjoint slot sets. Never run two processes writing the same slot directory.

Outputs are in `local/assets/maps/working/legacy/<Steam build ID>/Level_<slot>/`.
Default paths are resolved from the script's repository root, not the shell's
current directory. `--output` remains available for a different workspace.
A manifest is
written and signed only after all six layers finish; files in an incomplete
directory are not a usable pack. These working folders are not automatically
served. Register finished packs with `tools/register-map-pack.mjs` to copy them
into the canonical SHA-256 directory. `tools/stage-site.mjs` publishes only
catalog-listed packs; it does not copy arbitrary build/slot working folders.

`requirements.txt` is the six direct map dependencies; the adjacent
`requirements-all.txt` locks the complete tested 17-package environment shared
with the game-asset exporter. The setup script installs the complete lock and
runs `npm ci` using `gltf-deps/package-lock.json`. No Blender, decompiled C# tree,
old project artifacts, or private player logs are dependencies of this pipeline.
It reads the installed game's `PEAK_Data` assets/managed assemblies and Steam's
`appmanifest_3527290.acf`; those remain in the game installation selected by
`--game`. Source managed DLLs are read, not copied into the repository.

## How the scene and coordinates are selected

- Read `BuildSettings.scenes` from `globalgamemanagers`; do not infer the scene
  number from the daily slot. In Steam build **25306743**, `level4` is
  **WilIsland**, `Level_0` is `level5`, and `Level_16` is `level21`.
- Read the version (`2.4.c` in that build) from `PlayerSettings.bundleVersion`
  and the build ID from Steam's application manifest.
- Generate MonoBehaviour type trees from the installed managed assemblies.
  Read `MapHandler.segments`, `variantSegments`, and `biomes`. Select variant
  parents exactly when the game's property getters would select them. Read
  the scene's `VoidBiome.segment` as the additional runtime layer.
- Traverse each selected segment and campfire subtree. Preserve serialized
  child activation, select LOD 0, and exclude nonkinematic rigid bodies.
  Transform every mesh through the complete parent-chain TRS matrix. For
  static batches, use the serialized batch root and submesh range.
- Ignore the fog wall roots: their shader draws a transition effect, not solid
  map albedo. Use the solid collider extent, excluding kilometre-wide visual
  horizon meshes, to define the square raster bounds.
- Rasterize X/Z with Unity Y as height. Height cells are sampled at centers;
  row zero is minZ and column zero is minX. The PNG is stored with top-left
  image origin, while its declared UV convention remains bottom-left, matching
  the existing viewer's texture upload flip.

Every manifest records its exact scene file, scene SHA-256, Unity version,
per-layer source root references (including the excluded fog-wall references)
and geometry counts. The existing canonical identity routine
signs the projection metadata and all texture/height digests.

## Appearance and limitations

The result is a **survey rendering from the actual game assets**, not a game
screenshot. Basic textures, UVs and artist-authored colors are retained. For
PEAK's custom terrain shaders, the baker blends `_BaseColor` and `_TopColor`
using the surface slope and `_TopSurfaceTightness`; props use `_Tint` and base
texture. Material masks, lighting, wind, water and other custom GPU shader
effects are approximated. No invented biome palette or hand-drawn terrain is
used.

Height uses the highest non-trigger MeshCollider, BoxCollider, SphereCollider
or CapsuleCollider surface. Spheres/capsules are tessellated with 16 sides, so
their boundaries have a small polygon approximation. Convex MeshColliders are
sampled from their source mesh; Unity's cooked convex hull may differ. Moving props and spawned
loot belong to telemetry and are not baked. A single height per X/Z cannot
represent both a cave floor and its roof; a player's Y must remain the measured
log value. The Void layer has a very large static collision plane, so its grid
has coarser horizontal spacing than the five mountain layers. These limitations
are also included in each generated manifest.

The scene-to-slot mapping, full transform chain and build ID are exact source
data. The rendering appearance and height discretization should not be described
as an exact recreation of the game screen or collision engine.

## Verification

```powershell
& local/python/.venv/Scripts/python.exe -m unittest discover -s PeakTrailPlatform/tools/offline-maps -p "test_*.py"
node PeakTrailPlatform/tools/check-trace-alignment.mjs "<recording folder>" "<pack folder>"
```

The unit checks cover parent transform composition, cell-center rasterization,
and collider placement. The trace check validates the actual recorded session's
scene/build, X/Z coverage and height residuals. A residual can be large under
overhangs or while airborne; do not change player coordinates to hide it.

Upstream parser documentation: [UnityPy](https://github.com/K0lb3/UnityPy).
