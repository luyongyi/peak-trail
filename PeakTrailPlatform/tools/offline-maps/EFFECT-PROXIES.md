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
