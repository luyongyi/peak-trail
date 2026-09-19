using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

internal sealed class TraceManifest
{
    [JsonProperty("schemaVersion")]
    public int SchemaVersion { get; set; } = 1;

    [JsonProperty("sessionId")]
    public string SessionId { get; set; } = string.Empty;

    [JsonProperty("runId")]
    public string RunId { get; set; } = string.Empty;

    [JsonProperty("startedAtUtc")]
    public string StartedAtUtc { get; set; } = string.Empty;

    [JsonProperty("endedAtUtc", NullValueHandling = NullValueHandling.Ignore)]
    public string? EndedAtUtc { get; set; }

    [JsonProperty("status")]
    public string Status { get; set; } = "recording";

    [JsonProperty("endReason", NullValueHandling = NullValueHandling.Ignore)]
    public string? EndReason { get; set; }

    [JsonProperty("gameVersion")]
    public string GameVersion { get; set; } = string.Empty;

    [JsonProperty("gameBuildId")]
    public object GameBuildId { get; set; } = "unknown";

    [JsonProperty("recorderVersion")]
    public string RecorderVersion { get; set; } = string.Empty;

    [JsonProperty("sceneName")]
    public string SceneName { get; set; } = string.Empty;

    [JsonProperty("levelIndex")]
    public int LevelIndex { get; set; }

    [JsonProperty("mapSlot")]
    public int MapSlot { get; set; }

    [JsonProperty("projectionVersion")]
    public int ProjectionVersion { get; set; } = 1;

    [JsonProperty("sampleHz")]
    public float SampleHz { get; set; }

    [JsonProperty("coordinateSpace")]
    public string CoordinateSpace { get; set; } = "unity-world-meters";

    [JsonProperty("positionAuthority")]
    public string PositionAuthority { get; set; } = "xyz";

    [JsonProperty("segmentResolution")]
    public string SegmentResolution { get; set; } = "unassigned";

    [JsonProperty("activeSegmentSemantics")]
    public string ActiveSegmentSemantics { get; set; } = "global-maphandler-segments-index";

    [JsonProperty("route", NullValueHandling = NullValueHandling.Ignore)]
    public RouteTelemetry? Route { get; set; }

    [JsonProperty("timeUnit")]
    public string TimeUnit { get; set; } = "milliseconds";

    [JsonProperty("identityMode")]
    public string IdentityMode { get; set; } = "platform-user-id";

    [JsonProperty("recordingScope")]
    public string RecordingScope { get; set; } = "all-synchronized-players";

    [JsonProperty("telemetryFields")]
    public List<string> TelemetryFields { get; set; } = new()
    {
        "item",
        "stamina",
        "extraStamina",
        "appearance",
        "route",
        "world",
        "status",
    };

    [JsonProperty("worldTelemetry")]
    public object WorldTelemetry { get; set; } = WorldTelemetryTracker.Capabilities(false);

    [JsonProperty("staminaAuthority")]
    public string StaminaAuthority { get; set; } =
        "local-owner-authoritative-or-photon-owner-sync-after-first-packet";

    [JsonProperty("statusTelemetry")]
    public object StatusTelemetry { get; set; } = new
    {
        version = 1,
        snapshots = "complete-replacement-on-change-and-1-second-heartbeat",
        statusTypes = "all-CharacterAfflictions.STATUSTYPE-values",
        effects = "all-observed-AfflictionType-identities-no-remote-countdown",
        remoteReadiness = "independent-status-and-affliction-RPC-observation",
        staminaUnit = "fraction-of-original-capacity-1",
    };

    [JsonProperty("inventoryAuthority")]
    public string InventoryAuthority { get; set; } = "master-client-rpc-snapshot";

    [JsonProperty("participants")]
    public List<ParticipantInfo> Participants { get; set; } = new();

    [JsonProperty("privacyWarning")]
    public string PrivacyWarning { get; set; } =
        "This file contains stable/raw player IDs and nicknames plus location trails, stamina, statuses, appearance and item/inventory telemetry. Keep it private unless every participant agrees to the recording and sharing.";
}

internal sealed class ParticipantInfo
{
    [JsonProperty("playerId")]
    public string PlayerId { get; set; } = string.Empty;

    [JsonProperty("nickname")]
    public string Nickname { get; set; } = string.Empty;

    [JsonProperty("actorNumber")]
    public int ActorNumber { get; set; }

    [JsonProperty("platform")]
    public string Platform { get; set; } = "unknown";

    [JsonProperty("idSource")]
    public string IdSource { get; set; } = string.Empty;

    [JsonProperty("firstSeenAtMs")]
    public long FirstSeenAtMs { get; set; }
}

internal sealed class PlayerIdentity
{
    public string PlayerId { get; set; } = string.Empty;

    public string Nickname { get; set; } = string.Empty;

    public int ActorNumber { get; set; }

    public string Platform { get; set; } = "unknown";

    public string IdSource { get; set; } = string.Empty;
}

internal sealed class TrackedPlayer
{
    public Character Character { get; set; } = null!;

    public PlayerIdentity Identity { get; set; } = null!;

    public Action ReviveHandler { get; set; } = null!;

    public Action<Character> WarpHandler { get; set; } = null!;

    public bool HasSample { get; set; }

    public UnityEngine.Vector3 LastPosition { get; set; }

    public float LastYaw { get; set; }

    public long LastSampleAtMs { get; set; }

    // Live-only stream bookkeeping: the relay path samples at a higher rate than
    // the offline files and gates on its own last-sent state, so the two pipelines
    // never distort each other's adaptive filters.
    public bool HasLiveSample { get; set; }

    public UnityEngine.Vector3 LastLivePosition { get; set; }

    public float LastLiveYaw { get; set; }

    public long LastLiveSampleAtMs { get; set; }

    public bool WasDead { get; set; }

    public bool WasPassedOut { get; set; }

    public long FirstObservedAtMs { get; set; }

    public StaminaTelemetry? LastStamina { get; set; }

    public long LastStateAtMs { get; set; }

    public StatusTelemetry? LastStatus { get; set; }

    public string LastStatusFingerprint { get; set; } = string.Empty;

    public long LastStatusAtMs { get; set; }

    public InventoryTelemetry? LastInventory { get; set; }

    public string LastInventoryFingerprint { get; set; } = string.Empty;

    public string LastAppearanceFingerprint { get; set; } = string.Empty;
}
