# PEAK Trail Platform

PEAK Trail Platform is a local-first route recorder and 2.5D replay system.
The daily map check is only a resolver for the landing page; saved runs always
identify the scene that was actually loaded by the game.

## Components

- `../PeakTrailRecorder`: the only player-installed BepInEx DLL. It records trails and
  also contains the maintainer-only `F8` capture command.
- `../PeakMapExporter`: canonical source/test project for the map-pack implementation;
  it is compiled into the recorder and is not a second end-user plugin.
- `web`: static replay application suitable for GitHub Pages.
- `schema`: JSON Schemas shared by the recorder, exporter, and viewer.
- `tools/update-daily.mjs`: server-side daily map resolver used by GitHub Actions.
- `tools/offline-maps`: pre-bakes all daily scenes directly from installed Unity assets, without running the game.
- `tools/game-assets`: extracts original item sprites and neutral-pose avatar geometry/textures.
- `tools/register-map-pack.mjs`: verifies and stages one exporter result into the
  static map catalog.
- `data/daily`: generated current-map and observation-history files.

## Decisions that keep replays aligned

1. A trace stores the active Unity scene name and Steam application build ID.
   The API `LevelIndex` is supplementary because a lobby can remain on an old
   map across the daily rotation.
2. Map packs are exported from the installed game itself. Each v3 layer contains
   original indexed triangles, UVs, normals and full instance transforms in an
   embedded GLB, in the same Unity world coordinates as recorded positions.
   PNG/height fields remain separate survey references, not the displayed mesh.
3. Recorded XYZ is authoritative. PEAK's current segment is scene-wide rather
   than per-player, so it is stored as `activeSegment`; a sample gets an owning
   `segment` only when position-based evidence is available.
4. The viewer may overlay a trace only when the scene and build identifiers
   match. A mismatched trace remains viewable as a bare 3D route, but it is not
   silently projected onto a similar-looking map.
5. The current game build has 21 baked daily scene slots. They should be
   exported once per PEAK build; the daily Action only selects
   `LevelIndex % 21`. It does not regenerate geometry every day.
6. The recorder uses the network platform user ID and nickname supplied by the
   game. These are intentionally stable rather than random, so trace files are
   personally identifying and should not be uploaded without the players'
   agreement.

## Original geometry, one chapter at a time

The source of truth is the installed Unity scene. The offline pipeline reads
the actual BuildSettings mapping (file indices are not daily slot numbers),
selects MapHandler biome variants and retains full world transforms. For each segment it:

1. retains each static renderer's original mesh and material UVs;
2. shares repeated trees/rocks through instancing without removing triangles;
3. preserves full affine matrices, including parent-induced shear;
4. losslessly compresses geometry buffers, checking decoded bytes against source;
5. hashes the GLB and its survey references into a v3 map-pack identity.

The viewer defaults to the run's starting chapter. Previous/next chapter buttons
fit the camera to that chapter; playback can follow global progress. Manual
selection locks the chapter until following is re-enabled. A full mountain
overview is explicit, not the initial screen. Only the selected chapter is
normally loaded into GPU memory.

This replaces the old height-grid extrusion, which could stretch separate
surfaces into pillars and could not represent caves or overhangs. Original XYZ
trails are overlaid without snapping or warping. Blender and mesh decimation are
not needed. The integrated F8 v2 height-field capture remains a validation and
legacy alternative, not the preferred visual model.

Custom Unity lighting, water, wind and material masks are still approximated;
the retained source geometry is not a claim of pixel-identical game rendering.
The viewer matches build-specific lava/water/fog shader names to extracted source
colors; lava uses its HDR emission, not the near-white tint multiplier. These
effects keep their original meshes but do not reproduce depth/refraction/flow.
See `tools/offline-maps/MESH-CONTRACT.md` for the export and loader contract.

## 0.6 world replay and interior camera

The same recorder DLL now writes additive `world_snapshot`, `world_delta` and
`world_event` records: ground/held item state, deployed mushroom prefabs, observed
Roots explosive-mushroom effects, zombie states/ranges, and sleep-fog fields with
lit protective zones. World data is sampled at 4 Hz; full checkpoints every 10 s
support reversible scrubbing. Object discovery is shared every 2 s, with an
observation-only Photon instantiation hook for short-lived placed mushrooms.
Missing client observations and old 0.5 logs remain unknown; player item events
are **not** converted to guessed impact positions or fake explosions.

The browser uses exact-build original world meshes for 194 item prefabs and three
deployed mushrooms, plus the actual zombie head asset for proximity warnings.
Warning distance is the observed wake range plus a labelled 20 m viewer margin;
it does not override the game's view-angle, line-of-sight or valid-target rules.
Explosion rings and bounded fog volumes are analytical replay illustrations,
not the original Unity particles. Lit recorded protection spheres cut holes in
the sleep-fog visualization. Particle-only deployments use an explicit location
marker rather than an invented solid model.

Citadel (`Temple_Segment`) and Kiln (`Volcano_Segment`, not outdoor
`Caldera_Segment`) prefer an already-recorded in-chapter player position for the
camera. Without one, the viewer searches actual loaded geometry for a floor and
ceiling and labels that point as a geometry reference, not a player position.
Use **进入关内** to reposition, **自由相机 WASD** to toggle, WASD to move, Q/E to
descend/ascend, Shift for faster movement, mouse-drag to look, and Esc to return
to the saved orbit view. Keyboard movement requires viewport focus. This is a
spectator camera without collision physics; the fitted overview remains available.

World telemetry and remote-player synchronization still need an in-game 0.6
multiplayer acceptance run. Automated contracts and synthetic UI fixtures cannot
prove capture coverage or frame cost in every modded lobby.

## Delivery plan

1. Export one active scene and record a 30-60 second solo run.
2. Confirm several known landmarks and the recorded trail align in the viewer.
3. Exercise a multiplayer run including join, leave, death, revive, and warp.
4. Export all 21 slots for the current Steam build and publish the compact map
   packs only after the distribution policy has been confirmed.
5. Enable the scheduled daily resolver and GitHub Pages deployment.
6. Add route comparison, heat maps and redacted sharing after multiplayer
   runtime checks are complete.

## Daily resolver

Run from the repository root:

```powershell
node PeakTrailPlatform/tools/update-daily.mjs
```

Optional environment variables:

- `PEAK_API_VERSION` (default `2.4`)
- `PEAK_MAP_COUNT` (default `21`)
- `PEAK_DAILY_ENDPOINT` (defaults to the official version-check endpoint)

The endpoint is queried by Node/GitHub Actions because it does not expose CORS
headers for direct browser access.

## Registering map packs

After an offline bake or an `F8` capture passes the accuracy gates,
register its whole output folder from the repository root:

```powershell
node PeakTrailPlatform/tools/register-map-pack.mjs `
  "C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\PeakTrailMapPacks\Level_16-..." `
  --activate-build
node PeakTrailPlatform/tools/validate-data.mjs
```

The first registered build becomes `activeGameBuildId`. When intentionally
switching the site to a newly exported Steam build, add `--activate-build`.
The tool checks every PNG/height/GLB SHA-256, independently recomputes the
`identityVersion: 2` or `3` `mapPackId`, copies only referenced assets, and adds the
versioned pack to `data/maps/catalog.json`. The browser then selects
the active-build entry matching today's `sceneName` and `mapSlot`; it displays
an unavailable state instead of falling back to a different build.

Registration is serialized by `data/maps/.register-map-pack.lock`. If the
process was forcibly terminated and that file remains, first confirm no other
registration process is running, then remove that exact lock file and retry;
completed-but-uncatalogued pack directories are verified and recovered.

Source assets are stored in the repository's ignored `local/assets` directory:
`maps/packs/<mapPackId>` and `game-assets/<build>`. The code catalog remains in
`PeakTrailPlatform/data/maps/catalog.json`. Staging emits the original public
URL layout without tracking those binary assets in Git.

Keep resources ignored even after an approved distribution/storage plan is
configured. A clean checkout needs an independent resource restore before a
Pages build; code-only CI uses synthetic fixtures and needs no real game files.
Staging verifies and copies the derivative allowlist only; it never copies
`local/recordings`, local Steam appearance caches or archives. Public deployment
is opt-in and is not configured by this local repository migration.

## Player appearance and item UI

The single recorder DLL records build-specific appearance changes alongside
positions, stamina and inventories. The viewer assembles the original head,
face cards, outfit and hat geometry and textures into a neutral-pose preview;
inventory slots use PEAK's `Item.UIData.icon` sprites. Asset lookup is exact-build
only. Old 0.3.0 logs contain no appearance events, so their historical costume
is unknown; a current local Steam cache is not used to invent missing history.
