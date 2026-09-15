# PeakMapExporter (developer source project)

Canonical source and contract-test project for PeakTrail's versioned 2.5D map
capture. The implementation is compiled into `PeakTrailRecorder.dll`; players and
map maintainers install that single DLL. Do not install this project's standalone
output beside the recorder, because that would restore the obsolete two-Mod setup.

It does not use Blender or redistribute PEAK meshes: it captures the map while the
user's installed game is running.

## Build the standalone development target

```powershell
dotnet build .\PeakMapExporter.slnx -c Release
```

This output exists for development and identity-contract verification only. Build
`../PeakTrailRecorder/PeakTrailRecorder.slnx` for the installable single DLL. If PEAK
is installed elsewhere, pass `-p:PEAKGameRootDir="D:/.../PEAK/"` to that build.

## Export a loaded map

1. Start PEAK through Steam and enter the generated island scene to export.
2. With `PeakTrailRecorder.dll` installed, press `F8` (configurable in the
   recorder's BepInEx config under `MapCapture`).
3. Wait for the completion line in the BepInEx log. The game is paused during
   capture and every touched active/enabled state is restored in `finally`.
4. Find the result under `BepInEx/PeakTrailMapPacks/`.

Every segment produces a square orthographic PNG and a matching float32 height
field. `map-pack.json` follows the shared PeakTrail schema:

- Unity world coordinates in metres;
- UV runs `minX -> maxX` and `minZ -> maxZ`;
- row zero is `minZ`, column zero is `minX`;
- heights are little-endian IEEE-754 float32, row-major;
- quiet `NaN` means no selected-segment collider was hit;
- `identityVersion: 2` makes `mapPackId` independently reproducible by C# and
  Node. Coordinate-critical strings use UTF-8 byte-length prefixes, bounds use
  their exact IEEE-754 float32 bits, and every texture/height file hash and
  referenced filename is included.
  Registration recomputes this identity instead of trusting the JSON value.

The exporter excludes UI, triggers, particle/trail/line renderers and movable
rigidbodies. This keeps random loot and players out of the map identity. It uses
real renderer/collider bounds for the square capture rectangle, hides unrelated
renderers for the PNG, and accepts ray hits only from colliders belonging to the
selected `MapHandler` segment hierarchy.

## Known limits

- A height field stores one Y value per XZ cell. Bridges over paths, stacked
  interiors and caves collapse to the highest hit. The PNG is still aligned, but
  a future multi-surface format is required to reconstruct those spaces.
- Meshes with no collider appear in the PNG but have `NaN` height cells.
- Foliage or shader animation can make PNG pixels differ between captures and
  therefore produce a different content-addressed map-pack ID even when the
  height geometry is unchanged.
- The exporter captures the current loaded scene only. Exporting all 21 baked
  maps requires loading each scene through PEAK; automatic scene cycling is not
  included because doing so safely needs separate lifecycle/online-state work.
- Use at least three known landmarks, the start, a campfire and a high point to
  validate each exported pack before publishing it.
