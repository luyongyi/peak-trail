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
can override it. All assets and private captures remain gitignored under
`local/`; the old project's artifacts/decompiled trees are not inputs.

The `--build` value must match the installed Steam build. `--game` selects the
installation directory; raw game files stay in Steam, not in this repository.
The exporter reads:

- `resources.assets`: `ItemDatabase.Objects` (194 canonical items for this build),
  then each serialized `Item.itemID`, `Item.UIData.itemName`, and `Item.UIData.icon`.
  This includes inherited item types such as Guidebook and MobItem. Two items have
  null icons in the game and remain explicitly unavailable.
- `level3`: the airport `Customization` arrays, whose order defines all recorded
  customization indices. There are 9 skin colors, 18 eyes, 19 mouths, 21 accessories,
  34 outfits, 45 selectable hats, 10 sashes, and 2 medal choices in this build.
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
