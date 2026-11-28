# PEAK visual asset pipeline

These tools read an installed copy of PEAK without launching Unity or changing a
running game. They produce build-keyed resources for the static viewer.

```powershell
& PeakTrailPlatform/tools/offline-maps/setup-env.ps1
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-game-assets.py --build 25306743
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/render-previews.py local/assets/game-assets/25306743
```

The shared environment is `local/python/.venv` (Python 3.12, tested 3.12.10);
the map tools' `requirements-all.txt` locks all shared dependencies. A copied
virtual environment from another project is neither needed nor supported.
By default the exporter writes `local/assets/game-assets` using the repository
root derived from `__file__`, independent of the working directory. `--output`
can override it. Extraction workspaces and private captures remain gitignored
under `local/`; only explicitly selected derivatives may enter the publishing
bundle described below. The old project's artifacts/decompiled trees are not inputs.

The `--build` value must match the installed Steam build. `--game` selects the
installation directory; raw game files stay in Steam, not in this repository.
The exporter reads:

- `resources.assets`: `ItemDatabase.Objects` (194 canonical items for this build),
  then each serialized `Item.itemID`, `Item.UIData.itemName`, and `Item.UIData.icon`.
  This includes inherited item types such as Guidebook and MobItem. Two items have
  null icons in the game and remain explicitly unavailable.
- `level3`: the airport `Customization` arrays, whose order defines all recorded
  customization indices. There are 9 skin colors, 18 eyes, 19 mouths, 21 accessories,
  34 outfits, 45 selectable hats, 10 sashes, and 2 medal choices in build 25739797.
  `CustomizationRefs.playerHats` has 47 real renderers: indices 45/46 are the
  Blue/Pink Ice Hoods selected by outfits 19/20. They are exported with their
  original indices and `selectable: false`, rather than lost outside the menu array.
- `sharedassets3.assets` and referenced resources: the original customization
  textures, meshes, materials, renderer references, skeleton and bind poses.
- `InventoryItemUI`: the real backpack/carrying/slot artwork.

The models have already applied the serialized prefab transform and skinning.
Every part uses the **same** airport preview-character coordinate frame. A browser
must assemble avatar base, outfit, hat, sash and medal, then center the combined
bounds once. Centering each part separately breaks the character.

The web head portraits use only the separately exported `HeadMesh`, eyes, mouth,
face accessory and effective hat. They never load or crop an outfit/body mesh.
Head framing includes the hat so tall hats are not clipped. Hat 0/1 still need
the selected outfit's material metadata, not its geometry. Missing historical
appearance or exact-build artwork produces an explicitly unavailable portrait,
not a default face or the user's current Steam cosmetics.

The third-eye accessory activates `CustomizationRefs.thirdEye`, a separate
original renderer, and disables the ordinary accessory card. Its mesh and
offline-decoded mask live in `avatar.thirdEyeModel`; other accessories obey
`drawUnderEye` layering. Existing resource packs can add this head resource
without rebuilding their outfit previews:

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-game-assets.py --build 25306743 --head-only
```

The `skin` material uses the recorded RGBA color. Face cards use PEAK mask textures:
eyes encode the outer eye in red and pupil in green; mouth/accessory artwork uses
white background as transparent. Decoded preview PNGs and material face-scale
values are provided. Studio lighting and neutral pose differ from Unity's live
animated game shader; the geometry, UVs, apparel and feature shapes come from the
installed game. Outfit preview PNGs are catalog references, not player portraits.

`fits[].hatMaterial` replaces the material of hats 0 and 1, matching
`CharacterCustomization.OnPlayerDataChange`. An outfit's `overrideHat` must select
its `overrideHatIndex` instead of the player's raw hat choice.

`catalog.json` contains an explicit `assets` array with relative path, byte length
and SHA-256. The site stage copies only that list. Do not put private player logs or
Steam stat cache output inside `local/assets/game-assets`.

## Publishing an additional character build

The deployment receiver's existing asset root may be read-only. Approved character
derivatives can instead be bundled under `PeakTrailPlatform/data/avatar-assets/`:
one top-level `catalog.json`, `<build>/catalog.json`, and exactly the files named by
that build's checksummed `assets` allowlist. Export to a separate local directory,
then run preview and form exports before copying the allowlist. The full exporter
verifies the installed Steam build and preserves other build entries in its index;
re-exporting a build still rewrites that build's derived catalog, so rerun additive
steps before publishing. Raw Unity files, player captures and extraction caches
are not part of this bundle.

The live-navigation 3.1 pack is **26542162**, based on the `head-portraits` profile.
It was freshly extracted from the installed build, rather than relabeled from
3.0.1. Its source evidence records assembly SHA-256
`a3643f11dc444d86491270b224c0a0caf9126a10b26731feb97fc85ad1d82038`
and the five serialized input/texture-stream fingerprints. Its portrait portion contains 227
allowlisted files (13,473,303 bytes): the independent head and face cards, 9 skin
colors, 18 eye choices, 19 mouth choices, 21 accessories, all 47 hat renderers,
and 34 outfit entries containing only hat material/override metadata. It does
not contain outfit/body meshes, item models, world objects, or player data.
Chosen cosmetics can be rendered with unknown runtime form; this package does
not claim captured transformations, stone, blindness or ghost state.

Reproduce it into a new ignored extraction directory using the repository's
configured Python environment:

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-head-assets.py --build 26542162 --output local/head-assets-26542162
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/test_head_assets.py
```

This profile decodes face masks directly and needs no outfit-preview step.
Before bundling, `readGameAssets()` from `tools/lib/game-assets.mjs` verifies the
catalog and complete recursive model/material dependency allowlist. Copy only
that build's `catalog.json` and its declared `assets`, then append its exact
build entry to `data/avatar-assets/catalog.json`. The source files are never
copied. `web/tests/head-pack-310.test.mjs` verifies all recorded cosmetic indices
and inherited/overridden hat combinations using the actual browser render-plan
functions. The map catalog's `playerVisualization: { mode: "heads", gameBuildId:
"26542162" }` requires this exact build's character assets when staging.

The additive navigation UI export follows the same build's `ItemDatabase.Objects`
for all 194 canonical item entries (192 native icons; the two source null icons
remain unavailable), `InventoryItemUI` for slot art, and the scene's `StaminaBar`
and `BarAffliction` references for stamina artwork and colors. It adds 172 unique
PNG dependencies (12,791,747 bytes), preserves the portrait catalog and all
existing asset hashes, and does not export item models. The subsequent native UI
render audit adds 29 derivatives (5,958,805 bytes), including full logical sprite
rectangles and the original paper/noise textures. Item icons are loaded on demand;
the stamina material resources load when the HUD first needs this build's art.
The complete pack now has 428 allowlisted files.

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-navigation-ui.py --build 26542162 --output local/head-assets-26542162
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/test_navigation_ui.py
```

`ui` contains the directly usable sprite paths. `uiStyle.stamina.images` retains
their original tints, nine-slice borders, trim padding, logical pixel dimensions
and Unity component / sprite references. Tight `Sprite.image` crops must not be
used with the untrimmed sprite borders: `ui/native/` reconstructs the actual
source `Sprite.rect` from its unpacked texture. The published outline and cap
are both 256×256, rather than the 239×239 and 84×247 cropped previews.

`uiStyle.stamina.material` and `conditionMaterial` retain the audited `Scouts/UI`
parameters. Its output is not raw sprite alpha: normal alpha is
`smoothstep(Step, Step + StepSmooth, Noise + AlphaStrength * spriteAlpha)`;
the status-fill variant additionally multiplies the input by decoded sprite red.
The original bilinear noise/paper textures, texture color spaces, tint conversion
and clipping parameters are recorded. `nativeLayout` preserves the scene's
actual transforms, masks, image types, material names and layout ordering;
`layout` gives compact render dimensions in native UI units. Status fills use
the native tiled dither texture and their icons sit above the normal bar.
Petrification uses its own right-side icon with the source preserve-aspect rule.
The Web renderer evaluates the native material at a fixed phase after slicing,
keeps a bounded 64-surface cache, and does no continuous texture animation or
extra WebGL rendering. Only noise and paper textures retain CPU pixel buffers.

Native normal stamina is green, extra stamina is yellow-green
with its own lightning icon, and the outline is cream. The source full bar is
600 units wide and 45 units high; both fills use absolute fractions of that full
width, rather than treating a damaged capacity as full. No percentage labels are
part of the native stamina bar.

The historical 26134529 pack was re-exported from the installed 3.0 build,
including all 194 canonical items and world models, 192 available native icons,
34 outfits, 47 native hat renderers, the three transformations, ghost and
independent state layers. ClimbingChalk and ScoutmasterSoul retain their original
null-icon result; neither receives an invented image.
Its `sourceEvidence` records the exact installed assembly and serialized-input
SHA-256 values. The separate item-event pack includes 11 native item definitions
and their 11 deployed-object references; the particle-only healing puff retains
its explicit no-solid-mesh result.

The 26134529 native localization audit found the same 206 `NAME_` terms and 191
verified prefab bindings as 25739797, with no changed Chinese or English names.
The runtime `SerializedTermsData` TextAsset is now path ID 1423, SHA-256
`6cc434199ba3d27ce7cc9b9ac1b8daf72ddee05a573ff87f6d47210826f1df67`.
The full localization table is private; only site-used terms and provenance are
published. No translated prefab guesses or invented new items are added.
The compact build provenance summary is
`data/game-builds/26134529.json`; the per-map source manifest is kept separately
at `data/maps/game-build.26134529.json`.

The historical 25739797 catalog records the installed
assembly and Unity bundle SHA-256, plus the exporter source hashes. For a bundled
installation, first unpack into an ignored directory and set `PEAK_TRAIL_GAME_DATA`.
An example isolated export sequence is:

```powershell
$env:PEAK_TRAIL_GAME_DATA = 'local/unpacked/25739797'
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-game-assets.py --build 25739797 --output local/avatar-assets-25739797
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/render-previews.py local/avatar-assets-25739797/25739797
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-form-assets.py --build 25739797 --output local/avatar-assets-25739797
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-ghost-assets.py --build 25739797 --output local/avatar-assets-25739797
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-state-assets.py --build 25739797 --output local/avatar-assets-25739797
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/prepare-live-visual-assets.py local/avatar-assets-25739797/25739797
```

`--extra-hats-only` adds missing native hat renderers to an existing catalog while
preserving its decoded face previews and additive form resources. Completeness
tests check all 47 native hats, outfit overrides, model/texture closure and hashes.

Validation and staging merge the installed `game-assets` index with the optional
bundled avatar index into the existing public `data/game-assets/catalog.json`.
Older builds remain available at their original URLs. A duplicate build is accepted
only when its build-catalog bytes are identical and both copies pass every resource
size/hash check; differing metadata or artwork fails before replacing the staged
site. Catalog references and references inside JSON models, including material
textures, decoded previews and additive `customization.ghost` art, must all belong
to the same build's allowlist. A map catalog declaring `activeGameBuildId` must have
that exact build's non-empty avatar model; a missing new character pack is a build
failure, rather than a silent fallback to another game's artwork. This requires no
receiver, shared-root permissions or public URL changes.

The independent PlayerGhost body/face layers and the original petrification and
blindness layers retain source geometry, material properties, textures and
activation evidence. Recorder 0.8.5 supplies their independent readiness and
native state observations. `prepare-live-visual-assets.py` adds a stone portrait
from the original separate `Statue head` renderer and decodes the ghost's own
third-eye mask offline. It writes new derivative URLs and updates the mutable
build catalog's telemetry contract; the previously published source-model bytes
and their export-time metadata remain intact. Ghosts stay separate from ordinary
`forms[]` and require their true owner's recorded face. A death or ordinary status
amount alone must not select a visual state. Custom Unity shaders, animation and
shadow-only/first-person proxy renderers are not presented as reconstructed
third-person characters. The web's stone coverage is an approximation driven by
the actual recorded material amount and progress.

## Private current-local appearance preview

`read-current-appearance.py` reads only cosmetic fields from Steam's local binary
stat cache, writes `source: steam-local-cache-current` and `historical: false`, and
preserves its cache modification time. It never changes or supplements a trail.

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/read-current-appearance.py --output local/profiles/current-local-appearance.json
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/render-current-appearance.py local/assets/game-assets/25306743 local/profiles/current-local-appearance.json local/profiles/current-local-appearance.png
```

The recorder's `appearance` records are the historical source for player outfits.

## Recorded transformations (Book of Bones)

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-form-assets.py --build 25306743
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/test_form_assets.py
```

This additive export preserves existing previews and the strict deployment
allowlist. Six mesh derivatives (body and portrait per form) stay in ignored
`local/assets/game-assets/25306743/models/forms/`; the catalog records source
mesh/material IDs, selected bones and triangle counts. No game files change.

Verified in installed build 25306743:

- `Action_BecomeSkeleton.RunAction` toggles `CharacterData.isSkeleton` through
  `SetSkeleton` / `RPC_SyncSkeleton`. Possession of the book proves nothing.
- `CustomizationRefs.SetSkeleton` uses third-person `resources.assets` mesh 1110
  (`Skeleton`) and material 141 (`M_Skeleton`). Its independent skull is selected
  from Head/Face bone weights: 1,015 original vertices, 1,604 original triangles.
  First-person mesh 1109 has no suitable head and is deliberately not used.
  The ordinary skin, eyes, mouth, accessory and third-eye renderers are disabled;
  hats remain. Known hats retain their source placement and outfit material.
- `SetMushroomMan` uses mesh 1054 (`Mushroom Chubby`) and material 305. Its real
  cap/head contains 292 vertices and 493 triangles. `HideAllRenderers` disables
  `hatTransform`, so mushroom portraits have no human face cards or hat.
- `BecomeChicken` uses `chickenRenderer`, mesh 1224 and material 236. This is an
  intentionally headless roast chicken. Head-weighted triangles are only a neck
  stump, so its portrait is the **whole original form**, explicitly labelled
  `portraitScope: whole-form-no-head`, not a fabricated head. The actual hat's
  final local Y of -4.66 is transformed by its source parent matrix; the catalog
  stores the resulting offset, not an assumed 0.68-metre world translation.

Models retain original UVs, source material base color and vertex RGB. Custom
Unity layered shaders and transition animation are not claimed to be reproduced.
The web renderer respects source color space; no generated artwork is involved.

`appearance.formReady` is independent of cosmetic `ready`. A recorded skeleton
can display with missing face indices; unknown hats are omitted, not defaulted
to index 0. `customization.forms[]` supplies `form`, `model`, `headModel`,
`retainHat`, `hatOffset` and `portraitScope`. The render result exposes `form`,
`hasHat` and `portraitScope`. Missing transformed resources fail closed instead
of substituting the normal outfit preview. Old logs without form telemetry may
still show their recorded cosmetic baseline, explicitly marked form-unknown by
the UI; this is not evidence that they never transformed.
An explicit new `formReady: false` observation clears the portrait entirely;
it is not equivalent to absent/null legacy telemetry and cannot reuse a cached
skeleton or silently return to a human face.
Version 0.3 logs did not record this data and must show that limitation.

## Recorded world objects (recorder 0.6+)

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-world-assets.py --build 25306743
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/test_world_assets.py
```

This additive step retains avatar previews and adds original enabled renderer
geometry for all 194 canonical items, plus the three solid deployed prefabs
`ShelfShroomSpawn`, `BounceShroomSpawn` and `CloudFungusPlaced`. A healing puff is
particles/AOE only in the source; it is deliberately not given an invented mesh.
Runtime RenderTextures (e.g. the guidebook's UI) are also not fabricated.

`items[].worldModel` and `worldObjects[].model` reference JSON with the same
`parts/positions/uv/groups/material` layout as avatar models. Unlike avatars,
world models are in **prefab-local metres**: apply the recorded world position,
rotation and scale without centering or fitting them to a unit box. LOD0 is used
once; inactive descendants and duplicate lower LOD renderers are excluded.
Material `colorSpace` is derived from the source shader's property flags.
Custom Unity layer masks, deformation and illumination remain approximations.

`worldObjects[].icon` for `MushroomZombie` is rendered from its source head,
zombie eye texture, skin material and fully grown head mushrooms. It is an NPC
reference icon, not a claim about its historical growth stage or attack pose.
The source prefab wakes at 20 m and enables at 40 m in this build; the recorder's
actual instance fields take precedence over these reference values.

Only existing allowlisted resources and newly exported references enter the
updated pack allowlist. A source export cannot reconstruct historical dropped
items, surviving/cull-randomized zombies or triggered mines from 0.5 logs.

## Item event reference assets (recorder 0.8.3+)

`export-item-event-assets.py` builds the small, version-specific public pack in
`data/item-event-assets/`. Staging publishes it under
`data/game-assets/item-events/`, within the receiver's existing immutable asset
namespace, using its own index without changing the main game-asset catalog.
It exports source item icons and the real generated
prefabs for pitons, mushrooms, rope anchors and construction items. Particle-only
prefabs retain their icon without an invented solid model. The web uses this
pack only for a matching recorded game build; no older model is substituted.

```powershell
& local/python/.venv/Scripts/python.exe PeakTrailPlatform/tools/game-assets/export-item-event-assets.py --build 25739797 --output PeakTrailPlatform/data/item-event-assets
```

For a bundled installed game, first unpack it with
`tools/offline-maps/unpack_game_data.py` into an ignored local directory, then set
`PEAK_TRAIL_GAME_DATA` to that directory for the export command. Managed assembly
metadata still comes from the installed game. The export verifies the installed
build and records the source assembly SHA-256. The raw input is never published.

Staging reads only the dedicated pack's explicit asset allowlist, verifies each
byte count and SHA-256 before replacing a release, and copies only the two levels
of catalogs plus their referenced derivatives. Receiver staging shares immutable
model/image bytes through the existing asset pool; catalogs remain independent.
Event markers are historical positions. Default model orientation is illustrative;
the recorder does not capture object rotation or later movement for these events.
