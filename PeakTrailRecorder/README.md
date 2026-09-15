# PeakTrailRecorder

Read-only BepInEx recorder for PEAK 2.4.c. It samples every human character returned by
`PlayerHandler.GetAllPlayerCharacters()` and writes a local, crash-recoverable trace for the
PeakTrail 2.5D viewer. The same DLL also captures the currently loaded map for the viewer;
there is no second end-user map-exporter mod.

## One DLL, trails and map packs

Install only `PeakTrailRecorder.dll`. While a generated island is loaded, press `F8` to export
that exact scene under `BepInEx/PeakTrailMapPacks/`. The capture contains aligned orthographic
PNG layers, float32 height fields and `map-pack.json`. Its identity binds the scene name, Steam
build ID, projection contract, bounds and asset hashes, so a viewer can reject a trace/map
mismatch.

PEAK ships 21 baked scenes (`Level_0` through `Level_20`). They are full executable Unity
scenes, not standalone model files. The recorder intentionally does not load all of them in a
hidden batch: activating a scene runs PEAK's `Awake`/`Start`, Photon, spawner and persistent
singleton lifecycle. Instead, capture each map when that scene is genuinely loaded. Once the
21 packs for a game build have been registered in the site repository, GitHub Pages serves them
as ordinary static assets and daily selection no longer needs the mod or game to be running.

## Output

The default output root is `BepInEx/PeakTrailRecordings/`. While recording, a session contains:

```text
manifest.partial.json
stream.ndjson.partial
```

On a clean run end, those become `manifest.json` and `stream.ndjson`. An interrupted stream is
recoverable by reading every complete NDJSON line and ignoring an incomplete final line.

The same root contains one append-only `PeakTrailHistory.ndjson` for convenient multi-day
upload. It does not replace the recoverable per-session pair. Its line contract is:

```json
{"type":"session_start","sessionId":"...","manifest":{"schemaVersion":1}}
{"type":"trace_record","sessionId":"...","record":{"type":"sample","t":123}}
{"type":"session_end","sessionId":"...","endedAtUtc":"...","durationMs":123,"status":"complete","endReason":"game_run_end"}
```

Every line is flushed immediately. A crash can leave an open session without `session_end`,
but cannot invalidate earlier complete lines. The viewer groups entries by `sessionId` and by
the calendar date in `manifest.startedAtUtc`.

Every recorder instance creates a unique timestamp-plus-GUID `sessionId`. `runId` remains a
separate correlation key, so a crash/reconnect can produce several monotonic sessions for one
game run without resetting `t` inside an already-used journal identity.

The manifest/stream follow schema version 1 in `PeakTrailPlatform/schema`. `sceneName` is the
authoritative map key; `levelIndex` is only supplementary daily-rotation metadata. Steam's app
build ID is captured so the viewer can refuse to overlay a trace on geometry from another build.

## Sampling and events

- Since 0.4.0, `appearance` records capture each synchronized player's skin, eyes,
  mouth, accessory, outfit, raw/effective hat, sash and medal indices, actual skin
  color and outfit names. The source is the same `PersistentPlayerDataService`
  snapshot that the game uses to render characters. Remote data must be the exact
  object received through `SyncPersistentPlayerDataPackage`; default placeholder
  values and actor IDs reused in another room are not accepted. Local appearance
  waits for Steam cosmetic stats. Changes emit a new timestamped snapshot.
- Older logs contain no appearance facts. A separate current-local Steam cache
  preview is explicitly current-only and must never be inserted into historical
  trails. Static game meshes, materials, icons and outfit references are exported
  by `PeakTrailPlatform/tools/game-assets`, and selected by exact Steam build.
- Maximum frequency: 5 Hz by default.
- Adaptive thresholds: 0.25 m movement, 5 degrees yaw, or a 1 second stationary heartbeat.
- A separate `state` record is emitted whenever stamina changes by at least `0.002`, and at
  least once per second even if the player does not move. It contains `stamina`, `maxStamina`,
  `extraStamina`, `maxExtraStamina`, normalized ratios and `totalStamina`.
- For the local player, stamina is owner-authoritative. A remote player's values are marked
  `telemetryReady: false` until `CharacterSyncer` receives its first owner-authored Photon
  packet; ready remote values are marked `authority: photon-owner-sync` and have the game's
  half-float network precision.
- An `inventory` record is emitted initially and only when the synchronized snapshot changes.
  It covers hotbar slots 0-2, worn-backpack slot 3, temporary overflow slot 250, the current
  held item/selected slot, and up to four nested backpack slots. Item IDs, canonical prefab
  names, per-run instance GUIDs and supported scalar item data (uses/fuel/cooking state, etc.)
  are retained.
- PEAK exposes no `SyncInventoryRPC received` flag. The master client can read its canonical
  inventory immediately; every non-master view stays `inventoryReady: false` for a conservative
  two-second object-stability window, and ordinary remote players must also have received an
  owner-authored `CharacterSyncer` packet. This favors a short "syncing" gap over a fabricated
  empty inventory during `Player.Awake`.
- Events: join, leave, passed out, recovered, death, revive, warp, segment change, run end,
  item consumed, item thrown, and conservative inventory changes.
- `item_consumed` and `item_thrown` come from RPC-backed game events. Snapshot-derived
  `item_acquired`, `item_lost`, `item_moved`, and `item_state_changed` records are explicitly
  tagged `source: snapshot_diff`, `confidence: observed-state-transition`, and `cause: unknown`.
  They are not mislabeled as a confirmed pickup/drop because PEAK exposes a pickup request
  before host acceptance, and some death/overflow drops have no global item event.
- Coordinates: original Unity world metres (`x`, `y`, `z`); time is monotonic milliseconds from
  this recording's start.
- XYZ is authoritative. PEAK exposes only one scene-wide `MapHandler` progression value and no
  reliable current-segment field for each synchronized character, so recorder 0.1.1 deliberately
  leaves per-player `segment` unassigned instead of attaching that global value to every player.
- `activeSegment` is the scene-wide `MapHandler.segments` array index used by PeakMapExporter,
  not the public `Segment` enum value (the two differ for special zones such as Void).
  `segment_change` is therefore a global event. Future high-confidence position inference may
  add `segment` separately as the owning map-layer index.
- No Harmony patches and no game/network state writes are used. Inventory is observed after
  PEAK's master-client RPC synchronization; brief spawn/RPC transitions are nullable instead
  of being written as fabricated values.

## Privacy warning

This implementation deliberately does **not** assign random participant IDs. It prefers Photon
`Owner.UserId`, then PEAK product/platform IDs, and finally a deterministic platform/nickname
hash. Nicknames, actor numbers, platform, and the ID source are also stored.

These stable identifiers, location trails, stamina curves and item/inventory histories are
sensitive multiplayer telemetry and can identify or profile friends across sessions. The recorder
never uploads anything, but users must obtain every participant's consent before recording or
sharing a trace. This also applies to `PeakTrailHistory.ndjson`, which aggregates every mirrored
session. Avoid committing recordings to a public Git repository.

## Build

With PEAK installed in the default Steam directory:

```powershell
dotnet build .\PeakTrailRecorder.slnx -c Release
Copy-Item .\artifacts\bin\PeakTrailRecorder\release\PeakTrailRecorder.dll `
  'C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\plugins\PeakTrailRecorder.dll' -Force
```

If PEAK is installed elsewhere, build with `-p:PEAKGameRootDir="D:/.../PEAK/"` and copy the DLL
to that installation's `BepInEx/plugins/` directory.
