# Terrain-aware spectator and source-map corrections

Verified locally on 2026-09-22, on top of `e863077` (20 Hz live pipeline,
mode gate, follow camera and wake lock). This change does not replace the DLL,
change the network clock, transmit recordings or publish the website.

## Camera contract

- Outdoor default observer distance is 56 rendered metres (previously 38);
  wheel range is 12–140. The subsequent enclosure correction uses a separate
  18 m interior framing policy (wheel 4–28 m), source-model-axis orientation and
  actual restored outer triangles. See [the interior audit](interior-source-audit.md).
- The anchor is the recorded, interpolated torso position after the exact same
  origin, Unity-Z reflection and height scaling used by the player marker.
  No invented eye offset or recorded climbing normal is assumed.
- Exact loaded map triangles provide nearby vertical-face normals and visibility.
  Current-chapter centre is only a weak prior, not proof of a climbable surface.
  Bounding boxes accelerate triangle tests; they are not substitute walls.
- Candidate and final placement both check the camera centre and near-plane
  offsets. Eight surrounding rays penalize foreground rocks in the composition.
  This is sampled framing, not a complete pixel-visibility guarantee.
- Orbit angle and distance are damped, not a straight chord through the mountain.
  A useful current view has selection hysteresis. A suddenly blocked view triggers
  an immediate candidate refresh; a verified clear destination can require a cut.
  Gaze uses damped velocity with at most 1.5 m of presentation-only look-ahead.
- The source `GD/FoliageGD` shader identifies soft leaves. They remain rendered
  but cannot act as a hard wall or climbing normal. Unknown materials, tree trunks
  and rock stay solid. The shared framing query also ignores these leaves: no
  separate foliage-opacity buffer is implemented.
- Manual drag/wheel, Escape, Tab, player lock and 60-second automatic rotation
  remain available. Explicit WASD/interior/fit/top-view choices end following.
  Automatic chapter changes retain it; stale asynchronous geometry loads cannot
  overwrite a newer camera choice. Dead/stale/disconnected players are ineligible.
- Teleports, seeking and height-scale changes reset the camera history. Normal
  gameplay positions remain the recorder's data, never the camera's smoothed pose.

## Source assets

The Shore water was outside the original chapter export roots. The verified
enabled `Misc/Water/Collision` plane exists in all 21 scene packs, at Y = -1,
with original corners spanning 5 km. A hash-bound sidecar adds it separately from
terrain, only to Shore/overview, without changing canonical map IDs or GLBs.
This is a static primary-colour approximation, not the game's foam, waves,
refraction or depth-colour shader. See `tools/offline-maps/README.md`.

Citadel's false spheres were source `Decal` projection volumes, not placeholder
crystals. Build/material/shader-qualified filtering retains the real crystal
bodies and genuine spherical props. The same policy handles Furnace fireball
decals. Actual projected animated decal/glow effects are not recreated. See
`tools/offline-maps/EFFECT-PROXIES.md` for evidence and the 21-pack audit.

## Validation and remaining limits

Automated checks cover affine/mirrored/instanced triangle hits, indexed/nonindexed
geometry, material groups, invisible/non-solid surfaces, instance updates,
200 seeded comparisons with native Three.js raycasts, orbit safety, rewind,
frame-rate independence and actual TrailScene method wiring. Staging rejects
wrong-build/scene water and malformed planes before replacing existing output.

The real local Level_17 recording was replayed numerically at 60 FPS for 0–300 s
against its actual loaded map triangles, using the same batching/material policy:

- Default distance stayed 56 m at 202/226/229/240/247 s; 203 s was about 41.82 m.
- All 24 tested initial headings at 240 s reached 56 m. Final eight-ray openness
  was 1 for 21 starts and 0.875 for 3 starts.
- There were **22 safety cuts**, 19 exceeding 12 m. Three intervals went below
  12 m, the longest about **0.67 s**. This is not a perfectly continuous cinematic
  camera: narrow stone corners can still require conspicuous relocation.
- The former 27–29 s leaf-induced repeated cuts were eliminated.
- Camera computation averaged about 0.60 ms/frame, P95 4.64 ms, on this machine,
  excluding WebGL. Initial geometry indexing is a separate roughly 60–117 ms
  cost in the tested chapters; subsequent geometry trees are weakly cached.

Browser checks use the actual local recording and rendered Shore, Snow and
Citadel chapters, not synthetic terrain. Static map geometry is the obstruction
source; moving gameplay objects are not added to the collision index. Only local
replay and server/unit regressions were tested; no live multiplayer playtest or
online deployment was performed. Source-derived water/decal policies were audited
across all 21 packs, but not every playable path in every pack was visually tested.

## Reproduce

```powershell
npm.cmd --prefix PeakTrailPlatform/web test
npm.cmd --prefix PeakTrailPlatform/web run check
node --test PeakTrailPlatform/tools/tests/*.test.mjs
local/python/.venv/Scripts/python.exe -m unittest discover -s PeakTrailPlatform/tools/offline-maps -p 'test_*.py'
node PeakTrailPlatform/tools/offline-maps/audit-effect-proxies.mjs
node PeakTrailPlatform/tools/stage-site.mjs
node PeakTrailPlatform/tools/serve-site.mjs
```

The private real-recording diagnostic remains under ignored `local/verification/`;
it is not a portable public fixture. The local preview is http://127.0.0.1:4173/.
Staging allowlists public assets and does not include private recordings.
