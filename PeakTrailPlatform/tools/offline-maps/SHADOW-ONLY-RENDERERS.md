# Alpine light blockers are not visible walls

Read-only source audit: installed PEAK 2.4.c, Steam build **25306743**.
This correction does not move terrain or players and does not modify already
registered canonical packs.

## Source evidence

In `Level_4`, these four children of
`Map/Biome_3/Alpine/Snow_Segment/Misc` have enabled MeshRenderers with
`m_CastShadows = 3`, the built-in `Quad` mesh, and the ordinary `Lit` material
(`Universal Render Pipeline/Lit`). Each has only Transform, MeshFilter and
MeshRenderer components: none has a collider.

| Object | GameObject path ID | Renderer path ID | World centre (metres) |
| --- | ---: | ---: | --- |
| Quad | 9767 | 321412 | (-178.4, 589.1, 1146.6) |
| Quad (1) | 21378 | 322783 | (178.4, 589.1, 1146.6) |
| Quad (2) | 14279 | 321966 | (0, 589.1, 1410.0) |
| Quad (3) | 19976 | 322608 | (0, 378.6, 1146.6) |

The three vertical quads are approximately 541 metres square. The horizontal
one is approximately 541 by 307 metres. Source inspection of `Level_17` confirms
the same four shadow-only objects. The existing Alpine GLBs for slots
2, 4, 5, 7, 8, 11, 12, 14, 17, 19 and 20 each contain four `Quad` / `Lit`
instances (three GPU instances and one full-affine node).

Unity's [ShadowCastingMode enum](https://github.com/Unity-Technologies/UnityCsReference/blob/master/Runtime/Export/Graphics/GraphicsEnums.cs)
assigns 3 to `ShadowsOnly`. Its [documented behaviour](https://docs.unity3d.com/ScriptReference/Rendering.ShadowCastingMode.ShadowsOnly.html)
is to contribute shadows without a visible surface. Treating these enabled
renderers as opaque visible geometry produced the large false panels.

## Export correction and scope

`Scene.collect` excludes **only the renderer** when `m_CastShadows == 3` and
reports `shadowOnlyRenderers` in its statistics. This shared collector feeds
both the planar colour baker and `export_meshes.py`; no second GLB-specific
filter is needed. Modes Off/On/TwoSided (0/1/2) retain their visible geometry.
Missing or unknown values are not guessed invisible. Children and any separate
colliders remain eligible, so the height-field source is not silently changed.

This is not a material, shader, object-name or large-plane heuristic. `Lit` is
also used by real Cube, Plane and Cliff meshes elsewhere; those remain. Depth
projection decals are a separate issue handled by the existing exact source
material policy, not by changing this shadow-mode rule.

In the checked `Level_4` and `Level_17` chapter trees, the only shadow-only
renderers are the four Alpine quads. Waterfall Splash, Void Water and Void fog
wall renderers use mode 0; Onsen/forest/swamp water, Lava, FogSurface and
FogSurface void use mode 1. They are not removed. Global shore water and Gloom
volume metadata use separate exporters whose selection is unchanged.

The survey renderer does not reproduce these invisible objects' contribution
to the game's shadow maps. Omitting their visible surface is not a full port
of PEAK lighting. The collector change affects future exports only.

## Compatibility with existing packs

`source-render-policy.js` records the two glTF node indices for each of the 11
audited Alpine layers, bound to both build 25306743 and the SHA-256 of the
delivered compressed GLB. `loadGameGeometry` computes and verifies this digest
before consulting the table. `batchStaticMeshes` uses GLTFLoader's node
associations to omit the one affine instance and three GPU instances before
rendering, bounding-box calculation and terrain raycasts. Other nodes sharing
the same geometry, material or name remain; unrecognized content is unchanged.

No canonical pack, geometry hash, coordinate, recording or map identity is
rewritten. Existing cached assets and old recordings receive the same fix when
opened with the updated viewer. The digest-bound table is intentionally not
applied to re-exported content: new exports already honor renderer visibility.

## Regression checks

```powershell
local/python/.venv/Scripts/python.exe -m unittest discover -s PeakTrailPlatform/tools/offline-maps -p "test_*.py"
node --test PeakTrailPlatform/web/tests/source-render-policy.test.mjs PeakTrailPlatform/web/tests/geometry-loader.test.mjs
node PeakTrailPlatform/tools/offline-maps/audit-shadow-only.mjs
```

`test_render_visibility.py` uses the actual collector on a small serialized
hierarchy. It covers modes 0/1/2/3, missing/unknown modes, disabled renderers,
and retention of the child renderer and independent collision mesh.
