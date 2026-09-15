# Versioned 2.5D map pipeline

## Identity hierarchy

For a recorded run, identity is resolved in this order:

1. `sceneName`: ground truth for the scene that was actually loaded.
2. `gameBuildId`: prevents a trace from being overlaid after a geometry-changing
   Steam update that retained the same scene name.
3. `gameVersion`: human-readable diagnostic information.
4. `levelIndex` and `mapSlot`: useful for daily history, never sufficient for
   historical replay by themselves.
5. `mapPackId`: when known, verifies the exact exported geometry, references and projection.

The viewer must not use the capture if required identity fields conflict.

## Reproducible map-pack identity v2 / v3

Published packs declare `identityVersion: 3` for original GLB meshes, or `2` for
legacy height-field captures. The exporter and both Node
ingestion tools build the same UTF-8 canonical byte stream and require
`mapPackId = "sha256-" + lowercase_sha256(canonical_bytes)`.

- The header is exactly `peaktrail-map-pack-identity-v2\n` or `peaktrail-map-pack-identity-v3\n`.
- Integer lines use `key=<canonical decimal>\n`.
- String lines use `key=<UTF-8 byte count>:<string>\n`.
- Float lines use `key=f32:<eight lowercase hex digits>\n`; the digits are the
  exact IEEE-754 binary32 bits after JSON numbers are rounded to float32.
- Layers are sorted by their unique numeric `segment` before hashing.
- Root fields, in order, are `identityVersion`, `schemaVersion`,
  `projectionVersion`, `coordinateSpace`, `textureUv`, `imageOrigin`,
  `gameVersion`, `gameBuildId`, `sceneName`, `mapSlot`, and `layerCount`.
- Each sorted layer contributes `id`, `segment`, `biome`, `texture`, lowercase
  `textureSha256`, `height`, the six X/Y/Z bounds, `columns`, `rows`,
  `heightEncoding`, `noData`, `sampleLocation`, and lowercase `heightSha256`.
  Display names, timestamps, and `validHeightSamples` are deliberately excluded
  because they are descriptive or derived rather than referenced pack content.
- Version 3 then appends each layer's `geometry`, lowercase `geometrySha256`,
  and `geometryFormat` (`glb-instanced-v1`). A v2 pack cannot smuggle unsigned
  geometry references into the renderer. All GLB resource dependencies must be
  embedded; the build validates compressed and decoded buffer bounds.

The shared vector is
`schema/test-vectors/map-pack-identity-v2.json`; both implementations must
produce `sha256-ccd35ff5c8a8502cc04bf975e50828b3ec26f7b149f44f73fb3f8ff77a7f1641`.
`register-map-pack.mjs` and `validate-data.mjs` reject a correctly formatted but
incorrect ID.

## Height-field convention

- Coordinates use Unity world metres.
- X is the first horizontal axis, Y is up, and Z is the second horizontal axis.
- Each height file is little-endian IEEE-754 float32.
- Samples are row-major: row zero is `minZ`, column zero is `minX`.
- Samples lie at cell centres: `x = minX + (column + 0.5) *
  (maxX-minX)/columns`, with the equivalent formula for Z and rows.
- Map-layer `segment` values are zero-based indices into `MapHandler.segments`; they are not
  PEAK's public `Segment` enum values.
- A trace sample writes `segment` only when the recorder has high-confidence positional evidence
  for the owning map layer. PEAK's `MapHandler` value is global progression, so it is stored as
  `activeSegment` and never used as a per-player layer claim. `segment_change` is a global event.
- A quiet NaN marks a grid point without a surface hit.
- Texture UV is `u = (x-minX)/(maxX-minX)` and
  `v = (z-minZ)/(maxZ-minZ)`; the viewer handles image-origin flipping explicitly.
- Map packs must declare the UV, image-origin, sample-location and height
  encoding conventions. Unknown or missing conventions are rejected rather
  than guessed.

The trace always retains the original XYZ values, which remain authoritative when `segment` is
unassigned. Projection is a view concern,
so future map-pack formats can improve without rewriting old recordings.

Recorder manifests declare `segmentResolution`. `unassigned` means samples intentionally omit
their owning layer; `position-inferred-v1` permits a trusted `segment`. A v1 manifest without this
field is treated conservatively as `legacy-global-current`: its historical `segment` values are
preserved as global `activeSegment` metadata but are not trusted for single-layer filtering.

Trace timestamps named `t` are integer milliseconds from the session's monotonic
clock origin. UTC timestamps are descriptive anchors and are never used to order
samples within a run.

## Accuracy gates

A map pack is ready to publish only when:

- a runtime capture restored every segment's active state, or an offline bake never ran game code;
- at least three separated landmarks agree with their world positions;
- the start point, a campfire, and a high point are within the chosen visual
  tolerance in the web viewer;
- a warp/death discontinuity is broken rather than connected by a false line;
- scene/build mismatch tests prevent an overlay;
- missing height cells do not create spikes or triangles spanning empty space.

## Offline pre-baking

The current browser renderer uses `tools/offline-maps/export_meshes.py` v3
packs: original renderer triangles, UVs and normals, with instanced mesh sharing
and lossless meshopt buffer compression. Full affine transforms are restored
after GLTFLoader parsing so non-uniform parent scales do not lose shear. An
inverse-transpose instance matrix also preserves the normal direction. Terrain
colors come from source shader properties and use their declared color space.
See `tools/offline-maps/MESH-CONTRACT.md` for the full loader contract.

The viewer lazily loads one chapter by default; global `activeSegment` can drive
navigation but is never relabelled as an individual player's location. Manual
chapter selection suspends following. Unknown per-player segments preserve their
raw XYZ trail. An explicit overview loads the five mountain layers; Void has its
own chapter because its kilometre-scale floor would overwhelm ordinary fitting.

The following survey pipeline is retained for references and legacy imports,
not used to generate the displayed surface of a v3 pack.

`tools/offline-maps/build_maps.py` reads the installed build's `BuildSettings`
to resolve scene files. In build 25306743, `Level_16` is `level21`, not `level20`.
MapHandler's biome list selects segment variants, and a serialized VoidBiome
provides the additional void segment. Parent-chain TRS and static batch roots
retain Unity world coordinates. MeshCollider top surfaces become the height
field; original mesh UVs, material albedo and tint produce the orthographic PNG.
These are survey renders: custom shaders, lighting, moving props and multiple
surfaces stacked at the same X/Z are not reproduced exactly.

`tools/check-trace-alignment.mjs <recording-folder> <pack-folder>` reports real
trace coverage and position-to-surface height residuals without publishing any
player identifiers. It rejects mismatching scene/build/projection/coordinates.
Small residuals support alignment but do not replace landmark checks and do
not validate other scenes. Climbing and airborne positions need not lie on the
topmost surface. The viewer renders original-XYZ trails as an x-ray analytical
overlay to keep caves and overhangs legible.

Game visual derivatives have a separate per-build catalog in the ignored
repository-root `local/assets/game-assets`. Canonical maps are in
`local/assets/maps/packs`; the code's map catalog retains the served URL paths.
Static staging copies only listed paths with verified lengths and SHA-256s;
raw extraction dumps, local saves and player recording folders are not staged.

## Daily operation

Daily rotation does not mutate a map pack. The scheduled job records the
absolute `LevelIndex`, maps it to a baked slot, and updates the landing page.
After a PEAK update, the site may temporarily say that the selected map pack is
unavailable until a developer exports and publishes the new build. This is
preferable to showing a confidently wrong map.
