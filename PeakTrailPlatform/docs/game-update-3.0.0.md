# PEAK 3.0.0 source compatibility

The update targets installed Steam build `26134529`. Map geometry and item metadata must be regenerated from this build: the 208 bundled islands replace the previous 21-scene cycle. Old-build packs remain historical assets and must never substitute for a new-build map with the same `Level_N` name.

## Map and rendering evidence

`MapBundleService` now reads `StreamingAssets/maps/*Levels*.assetBundle`. `MapBaker.ScenePaths` supplies the indexed scene names. Online rotation still comes from `CloudAPI.CheckVersion → LoginResponse.LevelIndex`; offline rotation still starts at **2025-06-14 17:00 UTC**, advances every 24 hours and reduces the index modulo the actual scene count. The update does not establish a new epoch.

Native bundled `Level_0` and `Level_1` confirm both branch structures:

| Source scene | Selected branch | Enclosure source | Summit |
| --- | --- | --- | --- |
| `Level_0` | `volcano-kiln` | `VolcanoModel`, original `Pipe` mesh, 220 active split renderers | `PeakHandler` is inside segment 4 |
| `Level_1` | `swamp-temple` | `Gloom Temple/Temple_Model`, original `Temple Structure Outer`, 94 active split children | `PeakHandler` is inside segment 4 |

Both original enclosure renderers remain disabled, their split children remain active, and the model axis remains vertical. Each exported scene still checks its own hierarchy, renderer state and axis. Source hashes are `29545f55d4d2366674ea338315c00a8d88a2e69c0d6c5225efa63d66e1bba459` and `25b0b1fd7195480834fa8093ab53ef93d9bb40cf739b9a4fd5fd6a950d687ce3`, respectively.

Both scenes retain the 5 km `M_Void Water` planes at Y ≈ 727.276 and 728.276. Camera fitting continues to exclude only verified water planes and fully submerged geometry inside their bounds; it does not remove the meshes. Source build checks, exact material/shader matching and strict sidecar identity checks remain required for Nadir framing, Citadel context, fog replacement, swamp depth colour and explosive-mushroom visibility.

The material audit in [source-effect-materials.26134529.json](../tools/offline-maps/source-effect-materials.26134529.json) confirms the 20 audited materials in the installed direct `sharedassets` source retain their previous shader-object hashes and declared colour/float values. The direct `GD/Water-GD` shader SHA256 is `ae73632b504b76b465c5523b681ca46e1bdeb2d5ec2ceb61d24e9444b9026aa0`. Separately, all 136 audited material instances across the seven map bundles match the consumed colours, floats, declared property flags and Forward pass. Bundled Water, Fog, Lava, Jelly, AntiSphere and Decal shaders also match the direct source's parsed shader structure and compiled program bytes. Bundled `W/Peak_Standard` uses a program variant; its full byte identity is not claimed. Build-specific gates are extended only for these verified properties and passes.

## Cross-platform room code and live viewing

The game's code is **six uppercase letters** and is the actual Photon room name. `Utilities.ROOM_NAME_LENGTH` is 6; the first letter encodes region, the second platform/mod state and the remaining four are random. `MainMenuJoinRoomPage` checks crossplay permissions and mod warnings before joining. `HideRoomCodeSetting` is **on by default**. Giving someone this code also lets them attempt to join the game.

PeakTrail live v2 currently uses a separate random four-letter viewing code, a private viewing URL and a secret publishing token with a lease. Raw Photon room names are not uploaded: airport reservation identity hashes the region, game version and room name. Viewing credentials never authorize publication.

An official room code could be an **optional viewing alias**, while retaining the independent viewing code/link. It requires an explicit sharing setting, clear disclosure that the same code can join the game, and respect for the game's room-code concealment setting. Only the active publisher may bind or revoke the alias; bindings need separate validation, lookup limits, expiry and conflict rejection. Room codes must not become publishing credentials or appear in public manifests, route archives or logs. The relay cannot independently prove official room ownership, so conflicting or ambiguous aliases must fail rather than redirect viewers to another stream. This update documents feasibility; it does not silently enable this association.

At least one participant must run the compatible recorder on a supported PC. Only after the game permits both clients to join the same room could that recorder observe synchronized teammates from another platform. The installed Steam join path offers a Continue button for its modded-room warning, while crossplay permission/settings failures block joining or cause a kick/disconnect. This establishes no blanket mod-based rejection in the inspected Steam paths; it does not establish the console builds' policy or actual interoperability with BepInEx. A room code alone does not provide position telemetry, and this project does not supply a console publisher. Console-to-modded-PC joining and cross-platform telemetry remain unverified; only the recorder's compile compatibility was tested.

## Recorder validation

`PeakTrailRecorder` 0.8.5 builds against installed `26134529` assemblies with **0 warnings and 0 errors**, using `DeployModFiles=false`. This is compile validation, not an in-game crossplay test. Photon APIs remain available through the newer `NetCode.Session` wrapper. Existing identity resolution already handles `PlatformFamily`, `ProductUserID` and the string `CharacterData.userID`; the recorder's game-build lookup remains Steam-specific.

Private decompilation evidence is retained outside Git. Installed `Assembly-CSharp.dll` SHA256: `e9a8585abfa566afa7a3ef3e3699bc27369039eeefcdb3caa38d624d56f59e5c`; `Utilities.dll`: `ea8a7701caf51f6068c7775b2358b9c0cf5cb4295efffa6ae6a6dcf394b9e478`.
