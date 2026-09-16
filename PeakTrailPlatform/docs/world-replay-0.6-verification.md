# World replay 0.6 verification

Verified locally against PEAK build **25306743**, 2026-09-16.

## Automated checks

- Browser modules: 167 passing tests (including camera, world timeline, world
  model transforms/disposal, fog inputs and reversible baked-mine visibility).
- Site tools: 10 passing tests; asset allowlists include all world models and
  NPC image references, reject external/traversing/unlisted paths.
- Source extraction: 3 world-asset tests and 11 offline-map tests.
- Recorder Release build: zero warnings/errors, deployment disabled.
- Recorder contracts: History, Telemetry, Appearance, Route; World: 21 checks.
- Site staging: 21 exact-build map packs, approximately 918.2 MB. No personal
  recordings, synthetic QA logs or extraction workspaces enter the static site.

## Browser observations

The real 0.5 run still loads its original route, portrait and player telemetry.
At the Citadel chapter, the camera enters an already-recorded interior position.
World dynamics are explicitly **unknown** for this old log, not silently added.

The independent `tools/qa-world-fixture.mjs` generates a 30-second fixture under
ignored `local/verification/world-qa`. It reads static map metadata/survey files,
not personal recordings. Its participant is visibly labelled
`SYNTHETIC-WORLD-QA（非实录）`.

Observed in the browser: original mushroom models and actual zombie head icon,
proximity warning changing to active warning, an expanding explosion ring at the
recorded event position, fog volume and lit protection-sphere marker, empty
checkpoint removing objects, backwards seek hiding future drops, and Escape
returning to orbit mode. No browser warning/error messages in these checks.
An initial outside-volume depth-test issue was fixed and rechecked visually.

## Limits / next game acceptance

The new DLL was **built, not installed or exercised in a live 0.6 game** during
this change. Contract and synthetic UI tests cannot verify multiplayer capture
coverage, Harmony patch installation or actual game-frame overhead. Use a short
new 0.6 run to test thrown/deployed mushrooms, a real mine trigger, zombie wake,
fog height and lit/unlit protection, preferably with a remote participant.
The recorder sees only the current client's observable scene, not an omniscient
server history. The file retains raw player IDs and belongs outside Git.

World-model shape is the source prefab's reference geometry; child animations,
Unity particles, shader masks and physics between samples are not reproduced.
Explosion and fog graphics are labelled replay illustrations. The bounded fog
overlay does not implement Unity's scene-depth/refraction shader. Its analytic
integration subtracts recorded lit protection spheres (up to 32 nearest per
field). Missing source meshes use an explicit icon/location marker.
