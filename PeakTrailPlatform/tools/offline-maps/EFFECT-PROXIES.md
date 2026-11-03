# Depth projection volumes are not solid props

Verified against installed PEAK **2.4.c / Steam build 25306743**, including the
currently registered GLB packs. This is a rendering-policy correction; no mesh
coordinates, source assets, recordings or canonical pack hashes are modified.

## Cause

In `Level_17` / `Temple_Segment`, each of 100 `Petrify Crystal 1` objects has a
child `Decal`. That child references Unity's built-in `Sphere` mesh and
`sharedassets4.assets` material **M_VFX_PetrifyDecal**. The actual crystal is its
separate LOD-0 `Wall Petrified Stone` mesh, material `M_Petrified_Stone_Evil`;
it is already present in the GLB. Neither is a frontend placeholder.

The decal's real shader is **Decal**, with a Transparent/Unlit Forward pass,
source-alpha blending, zero depth writes and front-face culling. Exporting its
volume mesh as an ordinary opaque, double-sided glTF material made a huge ball
that obscured the crystal. Lowering opacity alone would still show a false
spherical shell rather than the original projected surface effect.

The same exact shader/material problem affects **M_VFX_FireballDecal** in
Furnace. `inspect_effect_proxies.py` prints both source material path IDs and
actual shader pass values, rather than relying on stale saved `_Surface` or
`_ZWrite` properties (which do not describe this custom shader's pass).

## Correction and limits

The web geometry loader now excludes only primitive groups matching all three:
verified build ID, exact material name, and `Decal` source shader. Exclusion
happens before GPU batching, so false volumes cannot cover players or interfere
with camera terrain raycasts. Mixed-material meshes retain their other groups.
Original crystal bodies and genuine spherical mushrooms, glass and AntiSphere
objects remain. A different build or missing shader evidence is not guessed.

The terrain-projected animated decal/glow is **not reproduced** in this fix.
Its unsupported proxy is omitted, not converted to an invented hazard radius.
The complete original GLBs stay on disk; no 21-pack rebake/download is needed.
Future export output is covered because `peakTerrain.sourceColors.shader`
already retains the same identity needed by the loader's policy.

## Reproduce verification

```powershell
local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/offline-maps/inspect_effect_proxies.py
node PeakTrailPlatform/tools/offline-maps/audit-effect-proxies.mjs
node --test PeakTrailPlatform/web/tests/source-render-policy.test.mjs PeakTrailPlatform/web/tests/geometry-loader.test.mjs
```

The pack audit verifies every published geometry digest before inspecting all
21 packs, then counts excluded material instances and retained crystal bodies.
It does not open private player logs or execute game code. Browser scene QA is
separate from these source/asset/loader regression checks.

## Build 26134529 verification

Both materials were re-read from the installed 3.0 build's
`sharedassets4.assets`: `M_VFX_FireballDecal` path ID 121 and
`M_VFX_PetrifyDecal` path ID 123. Their `Decal` shader object SHA-256 matches the
audited 25739797 shader. The native Forward pass still uses source blend 5,
destination blend 10, zero depth writes and front-face culling (1), with
Transparent/Unlit tags. The exact source values and serialized-file hashes are
retained in `source-effect-materials.26134529.json`; this evidence permits the
same narrowly scoped exclusion for 26134529. Legacy digest-bound shadow-only
node corrections remain restricted to 25306743.

## Mesa pit fade volumes, builds 26134529 and 26155610

Audited on 2026-11-03 against the raw `BuildPlayer-Level_87` and its
`.sharedAssets` sidecar from the 26134529 map bundle. The scene SHA-256 is
`32a8cc8ef5b7c76cf920d162340570247f27386cc5f0a12cf6323ce1b320ca2b`, matching
the Level_87 entry in `data/maps/game-build.26155610.json`. That build's
`sourceEquivalence` receipt verifies the map assets against 26134529.
The sidecar SHA-256 is
`c1f2afb4e966a440ac5ac78ed0be6f2879ef486aad80698e154ca803aaeb4e2a`.

The four `DarkFade` cubes are children of
`Map/Biome_3/Mesa/Desert_Segment/Platteau/Rocks/Timple/Inside`:

| Child path | MeshRenderer path ID | World minimum | World maximum |
| --- | --- | --- | --- |
| `End/Pit (1)` | 427837 | (-6.209, 394.010, 540.913) | (67.903, 445.390, 620.307) |
| `Carridor/Pit (1)` | 428032 | (21.279, 424.936, 630.913) | (40.415, 447.264, 722.965) |
| `Carridor/Pit` | 428432 | (21.279, 291.706, 630.913) | (40.415, 388.325, 722.965) |
| `End/Pit` | 429340 | (-6.209, 291.706, 540.913) | (67.903, 388.325, 620.307) |

Each is active, has an enabled MeshRenderer with cast-shadows mode 1, and has
only Transform, MeshFilter and MeshRenderer components; no collider is attached.
They reference sidecar material path ID **25**, name **DarkFade**, and shader
path ID **5231**, also **DarkFade**. The serialized object SHA-256 values are:

- Material: `1cce4c3912a00816bbf5660290d65f369a0eb17f5b4bee242a4444b50ba4be92`.
- Shader: `f1c5fd933476612d0f9695638592346f2aefdcdc8bcb2bcc362ad815d3aa6462`.

The native Forward pass is Transparent/Unlit, with `zTest=8` (Always),
`zWrite=0`, `culling=1` (Front), `srcBlend=5` (SrcAlpha) and `destBlend=10`
(OneMinusSrcAlpha). Its material has no base-color property. The export's
generic material fallback instead produced an opaque, double-sided white
PBR cube. This is an unsupported shader-effect container, not a white platform.

The published `segment-02-mesa.glb.gz` SHA-256 is
`248d248b6033cae2dc2337bc2a91c315d35767c4b1660ccec0a70bcee7288717`.
Within that GLB, material 16 is DarkFade, mesh 47 is Cube, node 717 is one
affine instance and node 1772 is a three-instance GPU group. Browser raycasts
at the visible foreground white box confirmed DarkFade; the detached rock at
the upper right instead uses M_DesertSand and is retained.

The runtime correction omits only the exact `DarkFade` material plus `DarkFade`
shader pair for these two verified builds. It uses the existing primitive-group
filter before batching, keeping the effect out of rendering, camera bounds and
terrain raycasts. The pit darkening effect is not reproduced. Ordinary cubes,
white materials, other shaders, unknown builds and the actual temple geometry
remain intact. Source meshes, map coordinates and published hashes are unchanged.
