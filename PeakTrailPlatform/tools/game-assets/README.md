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
Version 0.3 logs did not record this data and must show that limitation.
