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

- Since 0.7.0, independent `status` records capture every `CharacterAfflictions.STATUSTYPE`
  (including observed zeros), plus every currently active `AfflictionType` identity. Changes,
  death observations and a one-second heartbeat write complete replacement snapshots.
  `ready=false` and `effectsReady=false` mean unknown, never healthy/no buffs. Remote status
  and timed-effect RPC receipt are tracked independently of the movement/stamina packet,
  per character, Photon owner/view, room and initialized array. Hooks only observe successful
  receiver callbacks; they never send RPCs or modify game state. No remote effect countdown
  is fabricated because PEAK only ticks those clocks on the character's owner.
- Stamina numbers use the game's original capacity of **1**, not a re-normalized damaged bar.
  Normal capacity is `max(1 - sum(currentStatuses), 0)`. Cold/Curse and every ordinary status
  directly occupy that bar. Petrify is special: `petrifyAmount / 100` occupies the extra bar
  and its remaining capacity is `1 - petrifyAmount / 100`. Each value reports separate
  `staminaBlock` / `extraStaminaBlock`. State records expose `baseMaxStamina`,
  `baseMaxExtraStamina` and `capacityReady`; missing remote status packets omit ordinary
  `maxStamina` / `stamina01`, while independently synchronized current stamina remains usable.
  Death does **not** mean all statuses became zero: real death/clear/revive observations replace
  earlier snapshots, and game-retained curse/petrification are retained. Pre-0.7 logs cannot
  reveal which status caused a missing-capacity segment.
- Since 0.6.0, `world_snapshot` (initial and every 10 seconds), `world_delta` (changed
  objects, sampled at 4 Hz) and `world_event` preserve observed world state. A shared
  2-second scene discovery pass supplies cached references; there is no scan per player.
  An observation-only Photon `NetworkInstantiate` postfix captures the actual newly returned
  deployed-mushroom object immediately (both local and remote instantiations), without waiting
  for discovery; unavailable hooks are labelled `polling-only` in the manifest.
  Ground items and deployed Shelf/Bounce/Cloud/Healing Puff mushroom prefabs retain their
  original item IDs, Unity world positions/quaternions/scales and active state. Held or
  backpack items are inactive for ground replay. Removed/destroyed objects produce explicit
  removals; recycled Photon/Unity IDs receive a new session lifecycle suffix.
- Mines are the game's `Jungle_SporeMushroom*` + `SpawnGameObject.toSpawn=VFX_SporeExplo*`
  components. `mine_explosion` is emitted only after `SpawnGameObject.Go` actually completes
  through an observation-only Harmony postfix. It is never inferred from player damage,
  death, object disappearance or a nearby movement path. `manifest.worldTelemetry` reports
  whether this postfix was installed. A disabled/spent mine is not drawn as armed.
- Zombie snapshots include surviving scene spawners (not culled prefab candidates), actual
  `MushroomZombie.currentState`, wake/spawn distances and target identity when observed.
  The installed build's serialized NPC prefab uses 20 m wake / 40 m spawn distance; runtime
  fields always take precedence over the C# class's 30 m default. Warning distance is the
  observed wake radius plus an explicitly labelled 20 m replay UI margin. Wake-up also
  depends on visibility, player look angle, line of sight and target validity: the warning
  radius is not a claim that crossing a circle actually activated the enemy.
- Drowsiness fields record live enabled state and exact sphere/axis-aligned box extent;
  Drowsy/Spores/Poison emitters include wind suppression. This captures observable volume
  state, not Unity's exact volumetric shader. The real Swamp `StatusFieldGloom` additionally
  records sight distance, status delay and the `Hazard_SleepyGloom` run-setting gate. Lit
  `GloomSafeZone` objects record actual protection and visual radii; their protected spheres
  are excluded from the gloom's harmful volume (being inside the box alone is insufficient).
  Old logs without the `world` capability are
  unknown, not empty: their missing mine bursts, spawned objects and fog cannot be recovered.
- World telemetry is limited to the recording client's loaded/synchronized scene. Fast
  unsupported non-mine effects shorter than a discovery interval can be missed; no server omniscience
  or retroactive reconstruction is claimed. Unchanged snapshots are heartbeat checkpoints,
  not extra spawn events, and do not replay an earlier explosion on timeline seek.
- Since 0.5.0, `manifest.route` and timestamped `route` records preserve the resolved
  scene branch and every stage's real biome ID/name, parent name and selected variant.
  A `route` record is written at session start and only when its contents change; the
  append-only history mirrors it as an ordinary `trace_record`. It does not alter the
  map-pack identity or infer an individual player's owning stage.
- In PEAK build `25306743`, the regular route's stages 3 and 4 share a biome enum:
  `Volcano` (3) means 火山 → 熔炉 (`volcano-kiln`), while `Swamp` (8) means
  雾岛 → 城塞 (`swamp-temple`). The public `Segment` enum still calls these stages
  `Caldera` and `TheKiln` for both branches. The recorder therefore reads
  `MapHandler.MapSegment.biome` and `segmentParent`, whose getters resolve variants
  through `hasVariant` and `BiomeIsPresent`; it never checks `activeSelf`, since PEAK
  deliberately disables future/past stage parents during progression. Missing state
  produces no route; an unfamiliar or inconsistent pair remains `branch: unknown`.
- Old recordings have no runtime route evidence. A viewer may use a separately verified
  map-pack route for the exact scene/build, explicitly labelled as offline metadata;
  it must not infer the branch from `activeSegment` or the legacy `Segment` enum alone.
- Since 0.4.0, `appearance` records capture each synchronized player's skin, eyes,
  mouth, accessory, outfit, raw/effective hat, sash and medal indices, actual skin
  color and outfit names. The source is the same `PersistentPlayerDataService`
  snapshot that the game uses to render characters. Remote data must be the exact
  object received through `SyncPersistentPlayerDataPackage`; default placeholder
  values and actor IDs reused in another room are not accepted. Local appearance
  waits for Steam cosmetic stats. Changes emit a new timestamped snapshot.
- The sync references are observed with read-only Harmony postfixes on
  `PersistentPlayerDataService.OnSyncReceived` and `SetPlayerData` — the only two
  methods that write the service's per-actor data. A `CustomCommands` listener
  cannot be used: the game's `CustomCommandListener` keeps a single listener per
  package type, silently removes earlier registrations, and its `UnregisterListener`
  is a no-op, so the game's own service always displaces a plugin listener.
- Older logs contain no appearance facts. A separate current-local Steam cache
  preview is explicitly current-only and must never be inserted into historical
  trails. Static game meshes, materials, icons and outfit references are exported
  by `PeakTrailPlatform/tools/game-assets`, and selected by exact Steam build.
- Maximum frequency: 5 Hz by default.
- Optional live publishing (`[Live] Enabled`, default **off**): while recording, a
  background thread uploads the same records to a relay over outbound HTTP(S).
  The relay confirms a 4-character run code derived from the room-shared RunId and
  merges every teammate's upload of the same run into one stream: records carry a
  `roomTs` envelope (Photon's shared clock) and the relay deduplicates on
  `type|playerId|roomTs`. The code and protocol are pinned by cross-language
  vectors (`tests/LiveContract` ↔ `PeakTrailPlatform/server/run-code.mjs`). See
  `PeakTrailPlatform/server/README.md`. Since 0.7.1, the default `[Live] ServerUrl`
  is `https://peak.mylus.cn`; set `Enabled = true` to publish directly without a
  password or token. Existing BepInEx configs keep their saved URL, so update an old
  localhost URL explicitly. `ServerUrl` accepts HTTP(S) URLs without user information,
  query strings or fragments; redirects are not followed. The public relay requires
  no login, so live sessions should be treated as visible to anyone with site access.
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
- No game/network state writes are used. Harmony postfixes observe completed mine effects
  and spawned network instances without changing arguments/results. Inventory is observed after
  PEAK's master-client RPC synchronization; brief spawn/RPC transitions are nullable instead
  of being written as fabricated values.

## Privacy warning

This implementation deliberately does **not** assign random participant IDs. It prefers Photon
`Owner.UserId`, then PEAK product/platform IDs, and finally a deterministic platform/nickname
hash. Nicknames, actor numbers, platform, and the ID source are also stored.

These stable identifiers, location trails, stamina curves and item/inventory histories are
sensitive multiplayer telemetry and can identify or profile friends across sessions. The recorder
does not upload unless optional live publishing is enabled; users must obtain every participant's
consent before recording, broadcasting or sharing a trace. This also applies to `PeakTrailHistory.ndjson`, which aggregates every mirrored
session. Avoid committing recordings to a public Git repository.

## Build

With PEAK installed in the default Steam directory:

```powershell
dotnet build .\PeakTrailRecorder.slnx -c Release -p:DeployModFiles=false
Copy-Item .\artifacts\bin\PeakTrailRecorder\release\PeakTrailRecorder.dll `
  'C:\Program Files (x86)\Steam\steamapps\common\PEAK\BepInEx\plugins\PeakTrailRecorder.dll' -Force
```

If PEAK is installed elsewhere, build with `-p:PEAKGameRootDir="D:/.../PEAK/"` and copy the DLL
to that installation's `BepInEx/plugins/` directory.

Close PEAK before replacing the installed DLL; building alone does not install it.
For the route reader's synthetic game-boundary tests, run:

```powershell
dotnet run --project .\tests\RouteContract -c Release
dotnet run --project .\tests\LiveContract -c Release -p:DeployModFiles=false
```

The new route contract is additive to schema version 1. Head portraits can reuse the
appearance fields already recorded by 0.4.0; older logs without an appearance snapshot
must retain an explicit unknown-avatar state rather than borrowing today's cosmetics.
