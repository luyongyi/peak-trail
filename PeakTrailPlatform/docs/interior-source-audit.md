# Interior enclosure source audit

Scope: installed PEAK `2.4.c`, Steam build `25306743`. This audit reads local
Unity assets and managed assemblies; it does not execute game generation, alter
the installed game, or infer walls from terrain bounds or a recorded trail.

## Why the outer walls were absent

The original GLB export traverses the selected MapHandler `_segmentParent` and
`_segmentCampfire`. That correctly captures chapter-local climbing structures,
but the two terminal enclosures are active **sibling roots**, outside that
traversal:

| Representative scene | Selected final chapter | Omitted active outer root | Disabled original mesh | Enabled baked split children |
| --- | --- | --- | --- | --- |
| Level_17 (`level22`) | `Map/Biome_4/Gloom/Temple_Segment` | `Map/Biome_4/Gloom/Gloom Temple` | `Temple_Model`, `Temple Structure Outer` | 94 |
| Level_16 (`level21`) | selected Caldera branch's `Volcano_Segment` | `Map/Biome_4/Caldera/VolcanoModel` | child `VolcanoModel`, `Pipe` | 110 |

In Level_17 the Gloom Temple root contains 130 active mesh renderers in total,
including the 94 split outer-shell renderers and other original temple details.
The original Temple_Model renderer (GameObject 11917) is disabled; its active
split children are the rendering source. Its parent Gloom Temple is GameObject
18936. In Level_16 the VolcanoModel outer root is GameObject 44191 and its
disabled source-model child is GameObject 78802. These are scene-local IDs, not
portable identifiers to apply to other scenes.

The split pieces already exist in the serialized scene. Re-enabling the disabled
mother renderer would duplicate geometry. Constructing walls from colliders or
boxes would manufacture geometry. The correction exports the existing active
renderers with the same original mesh/UV/material/affine-transform pipeline.
Normal inactive-object, dynamic-body and LOD filtering remains in effect.

`export_enclosure.py` resolves each root from the selected source branch, checks
all ancestors are active, checks the original mesh identity and disabled mother
renderer, and requires active pre-split children. It does not select the other
mutually exclusive branch by slot parity or by an unqualified global name search.

## Why this is not a missing per-run tower generation step

The installed `Assembly-CSharp.dll` supports the following normal loading path:

1. `AirportCheckInKiosk.LoadIslandMaster` obtains a scene name from
   `MapBaker.GetLevel` using the daily level index.
2. `BeginIslandLoadRPC` calls `LoadSceneProcess` for that already-built scene.
3. `MapHandler.InitializeMap`, `GoToSegment` and `JumpToSegmentLogic` activate
   existing chapter/campfire/transition-wall roots and spawn gameplay items.

None of these paths calls `LevelGeneration.Generate` or `TowerStacker.Execute`.
`LevelGeneration`, `PropGrouper`, `LevelGenStep` and `Peak.TowerStacker` have no
automatic `Awake` / `Start` / `OnEnable` generation hook. The full assembly's
direct references to `LevelGeneration` are its own implementation and the
developer-console registration of `LevelGeneration.Run`. The explicit generation
path does clear and rebuild children, but it is not evidence of generation on
every normal play session.

On the actual Level_17 outer-shell hierarchy, Gloom Temple has only a Transform.
Temple_Model additionally has MeshFilter, MeshRenderer, MeshCollider and
`Ashley.MeshSplitter.MeshSplitter`. The latter, inspected in
`Ashley.MeshSplitter.dll`, is an empty MonoBehaviour in this player build: it
does not generate the shell or enable its disabled parent renderer at runtime.
The serialized active split children, rather than the presence of an editor
generation component, are the decisive rendering evidence.

There is a separate `TempleConfig` class that can shuffle columns and switch arrow
shooters through a seeded `CreateTemple_RPC` on joining a room. Neither Level_16
nor Level_17 contains a TempleConfig instance in the scene audit. Its class name
alone must not be used to claim that these final-chapter towers are per-run
random geometry.

`MapHandler.wallNext` / `wallPrevious` are also not synonymous with the physical
enclosure: Level_17's final `wallPrevious` points to
`FogSphereSystem/FogOrigins/Caldera/Fogwall_Prev`. They are transition barriers,
not the omitted Temple_Model shell. `TempleEntranceRope` does move an entrance
door Rigidbody based on climber weight; `LavaRising` moves hazard fields. Those
dynamic states are separate from this static outer-wall correction.

## Source-derived interior reference and publication

The original enclosure model's local Z axis transforms to world up. Its world
translation therefore supplies the authored tower-axis reference. The exporter
records `interiorReferenceSource: "source-model-axis"` and validates the axis;
this reference is neither an inferred bounding-box center nor a recorded
climbing-surface normal. It provides horizontal orientation context, not a
guaranteed collision-free camera pose.

The verified model-axis origins in the representative scenes are Unity XYZ
`[7, 805.0999755859375, 2092.5]` for Temple_Model and
`[0, 884.6900024414062, 2047]` for the inner VolcanoModel object. In particular,
the Gloom Temple *group* origin differs from its model axis; using that grouping
transform would aim the camera toward the wrong point. Per-scene renderer
counts are retained rather than assuming every temple root contains the same
details (for example, Level_3 and Level_13 contain 132 active renderers, while
Level_17 contains 130; all three have 94 shell splits).

The enclosure correction is additive metadata in `mapEnclosures`, bound to the
original build, scene hash, map slot and canonical pack ID. Source map packs and
their layer bounds/geometry hashes remain unchanged. A content-addressed
`<sha256>.glb.gz` is published under the shared `data/maps/enclosures/` directory,
so identical geometry is not copied into every map pack. Large extracted assets
remain in ignored `local/assets/maps/enclosures/`.

Staging validates metadata before replacing the previous site, hashes each
referenced geometry, and rejects non-content-addressed/traversing filenames.
Only referenced files are copied. Neighboring unreferenced models, nested
private files and recording logs are not part of the publication allowlist.

## Verification boundary

The representative source/runtime audit above establishes the missing-root
cause and does not claim in-game camera validation. The independent exporter
repeats scene-hash, selected-root, active-split and axis checks for every exported
scene. The staging regression fixture exercises two packs sharing one enclosure,
unchanged canonical packs, private-file exclusion, identity mismatch, filename
traversal, missing assets, damaged asset bytes and preservation of the previously
staged site on preflight failure.

Custom Unity shaders and runtime moving doors/hazards are not made exact merely
by restoring the static enclosure. Browser visual/camera checks must be reported
separately with the tested scenes and replay positions.

## Browser and deployment checks (2026-09-22)

The local browser loaded the existing Level_17 recording at 41:00, 44:10 and
47:00 with the new enclosure assets. The follow HUD displayed `关内向外观测`;
the lower view showed the enclosing wall, wall bands and doorway around the
original climbing structures. Higher views retained a solid wall behind the
player rather than an open-world backdrop. No browser warnings/errors were
reported during these checks.

A separate Level_16 page loaded its original final `Volcano_Segment` and the
Furnace enclosure, using the existing `进入关内` geometry-reference placement.
The page explicitly labelled this as a model reference, not a player position;
there was no Furnace recording in this browser check. Irregular interior rock
surfaces rendered without browser errors. This is not an in-game comparison or
a claim that all camera positions in either ending have been tested.

All 21 canonical scene hashes and original enclosures were exported/validated.
The staged site contains 1,294 files / 945.8 MB; shared enclosure data adds
26,002,419 bytes across 11 unique assets. Private recordings remain excluded.
Because additive enclosure metadata does not change a canonical map ID, small
map manifests are fetched with `cache: no-store`; immutable caching remains for
content-addressed geometry. This avoids keeping an old wall-less manifest after
refreshing the viewer.

Validation: 318 web tests, 21 tooling tests and 18 offline-map tests passed;
`npm run check` passed. No DLL replacement, game modification, live multiplayer
playtest or online publication was performed for this correction.

## Independent numerical camera QA (2026-09-22)

The local diagnostic `local/verification/interior-follow-benchmark.mjs` combines
the original segment-4 GLB and its verified enclosure GLB under the same world
root, preserves their affine/instance transforms, and applies the viewer's Z
reflection. The authored model-axis reference is reflected identically. Rays
intersect the real triangles, not an assumed cylindrical wall. Texture decoding
is omitted for this Node-only test; this is not a material or browser-image test.
The script and private recording remain ignored local files; no player IDs or
recording data are added to the site or repository.

For one participant in the local Level_17 replay, each point was tested from
eight initial azimuths for 240 frames at 60 Hz. Distances below are metres; the
wall column is the actual outer-root ray hit from the axis at the player's
height and azimuth, not a universal room radius.

| Replay time | Player axis distance | Camera axis distance | Actual boom | Measured wall radius |
| --- | ---: | ---: | ---: | ---: |
| 41:00 | 29.316 | 20.920–20.989 | 18.000 | 38.748 |
| 44:10 | 16.728 | 6.799 | 17.833 | 38.753 |
| 47:00 | 38.273 | 20.363–21.479 | 18.000 | 38.820 |
| 48:30, outside/top section | 121.064 | 103.200–103.867 | 18.000 | No radial hit |

At the three verified enclosed points, every tested frame had clear two-way
player/camera line of sight, remained inside the measured shell, and stayed no
farther from the axis than the player; there were no relocation cuts. Repeating
the test with a requested 28 m boom also passed those checks; near the axis at
44:10, the policy shortened it to 17.057–23.928 m depending on the initial view.
This verifies the sampled poses, not every frame of the complete replay.

**48:30 is not an enclosed-room pass:** the recorded player is at Y=1208.238 m,
121.064 m from the axis, although `activeSegment` is still 4. Neither the player
nor camera has an enclosing radial hit at that height/direction. Line of sight
is clear, but a chapter ID alone does not prove the player remains in the tower.

Level_16 has no corresponding actual replay in this check. Four **synthetic**
interior positions at Y=900/1000/1100 m were selected using real shell rays and
then checked against both the inner and outer meshes: clear axis-to-point rays
and no surface within 1 m on 26 local directions. Eight starts × 240 frames per
point produced zero line-of-sight conflicts or shell crossings, with booms of
13.094–18.000 m. These are geometry-backed tests, not evidence of real player
routes, traversability or the final appearance of the Kiln.

Taking an arbitrary point 3 m inside the outer shell is insufficient: 20 of 24
initial synthetic candidates failed that clear-space precondition. Two were
only 0.0012/0.0295 m from inner triangles; the existing 0.15 m minimum clearance
could cross those surfaces. They are explicitly not counted as successful
interior cases. A near-embedded subject remains a known collision edge case.

Node solver timings, excluding WebGL and image rendering, averaged 0.376 ms
(P95 1.846 ms, P99 7.743 ms) for Level_17 and 0.430 ms (P95 3.600 ms,
P99 7.047 ms) for the four clear Level_16 synthetic points. Reproduce with
`--slot=17`, optionally `--distance=28`, or `--slot=16 --valid-interior-only`.
