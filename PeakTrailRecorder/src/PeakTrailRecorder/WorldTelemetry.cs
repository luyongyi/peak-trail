using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

// Additive to schema 1: old readers can skip these records; missing records mean unknown,
// never an empty world. All positions, quaternions and scales use Unity world coordinates.
internal sealed class WorldObjectTelemetry
{
    [JsonProperty("objectId")] public string ObjectId { get; set; } = string.Empty;
    [JsonProperty("kind")] public string Kind { get; set; } = string.Empty;
    [JsonProperty("prefabName")] public string PrefabName { get; set; } = string.Empty;
    [JsonProperty("pos")] public float[] Position { get; set; } = Array.Empty<float>();
    [JsonProperty("rot")] public float[] Rotation { get; set; } = new[] { 0f, 0f, 0f, 1f };
    [JsonProperty("scale")] public float[] Scale { get; set; } = new[] { 1f, 1f, 1f };
    [JsonProperty("active")] public bool Active { get; set; }
    [JsonProperty("activity")] public string Activity { get; set; } = string.Empty;
    [JsonProperty("source")] public string Source { get; set; } = string.Empty;
    [JsonProperty("itemId")] public int? ItemId { get; set; }
    [JsonProperty("itemInstanceId")] public string? ItemInstanceId { get; set; }
    [JsonProperty("lastThrownByPlayerId")] public string? LastThrownByPlayerId { get; set; }
    [JsonProperty("photonViewId")] public int? PhotonViewId { get; set; }
    [JsonProperty("activationRadius")] public float? ActivationRadius { get; set; }
    [JsonProperty("warningRadius")] public float? WarningRadius { get; set; }
    [JsonProperty("warningRadiusSource")] public string? WarningRadiusSource { get; set; }
    [JsonProperty("activationRequires")] public string[]? ActivationRequires { get; set; }
    [JsonProperty("spawnRadius")] public float? SpawnRadius { get; set; }
    [JsonProperty("radius")] public float? Radius { get; set; }
    [JsonProperty("shape")] public string? Shape { get; set; }
    [JsonProperty("size")] public float[]? Size { get; set; }
    [JsonProperty("statusType")] public string? StatusType { get; set; }
    [JsonProperty("statusAmountPerSecond")] public float? StatusAmountPerSecond { get; set; }
    [JsonProperty("statusEnabled")] public bool? StatusEnabled { get; set; }
    [JsonProperty("statusDelaySeconds")] public float? StatusDelaySeconds { get; set; }
    [JsonProperty("sightDistance")] public float? SightDistance { get; set; }
    [JsonProperty("visualRadius")] public float? VisualRadius { get; set; }
    [JsonProperty("falloff")] public float? Falloff { get; set; }
    [JsonProperty("targetPlayerId")] public string? TargetPlayerId { get; set; }
    [JsonProperty("relatedObjectId")] public string? RelatedObjectId { get; set; }
    [JsonProperty("scenePath")] public string? ScenePath { get; set; }
}

internal sealed class WorldTelemetryTracker
{
    public static object Capabilities(bool mineObserverInstalled, bool networkSpawnObserverInstalled = false) => new
    {
        version = 1,
        scope = "loaded-scene-observed-state-not-server-omniscience",
        sampleHz = 4,
        discoveryIntervalMs = 2000,
        snapshotIntervalMs = 10000,
        identity = "component-kind-photon-view-unity-instance-session-lifecycle",
        mineExplosionObservation = mineObserverInstalled ? "SpawnGameObject.Go.postfix" : "unavailable",
        networkSpawnObservation = networkSpawnObserverInstalled ? "PhotonNetwork.NetworkInstantiate.postfix" : "polling-only",
        absentLegacyData = "unknown-not-empty",
    };

    private readonly Dictionary<string, string> _ids = new(StringComparer.Ordinal);
    private readonly Dictionary<string, WorldObjectTelemetry> _previous = new(StringComparer.Ordinal);
    private long _generation;
    private long _nextSnapshotAt;

    public string GetObjectId(string observedKey)
    {
        if (!_ids.TryGetValue(observedKey, out string? id))
        {
            id = observedKey + ":life:" + (++_generation).ToString(System.Globalization.CultureInfo.InvariantCulture);
            _ids.Add(observedKey, id);
        }
        return id;
    }

    // Keep disabled/held objects in the observed set: only actual destruction retires an ID.
    public void RetireMissing(ISet<string> observedKeys)
    {
        foreach (string key in _ids.Keys.Where(key => !observedKeys.Contains(key)).ToArray()) _ids.Remove(key);
    }

    public void ObserveImmediate(long t, WorldObjectTelemetry value, Action<object> write)
    {
        if (_previous.TryGetValue(value.ObjectId, out WorldObjectTelemetry? old) && Equivalent(old, value)) return;
        _previous[value.ObjectId] = value;
        write(new { type = "world_delta", t, upserts = new[] { value }, removed = Array.Empty<string>() });
    }

    public void Reconcile(long t, IReadOnlyCollection<WorldObjectTelemetry> objects, Action<object> write)
    {
        var current = objects.ToDictionary(value => value.ObjectId, StringComparer.Ordinal);
        var upserts = new List<WorldObjectTelemetry>();
        var events = new List<object>();
        foreach (WorldObjectTelemetry value in objects)
        {
            if (!_previous.TryGetValue(value.ObjectId, out WorldObjectTelemetry? old)
                || !Equivalent(old, value))
            {
                upserts.Add(value);
                if (old != null && value.Kind == "zombie" && old.Activity != value.Activity)
                {
                    events.Add(Event(t, "zombie_state", value, "observed-state-change"));
                }
                if (old != null && value.Kind == "sleep_fog" && old.Active != value.Active)
                {
                    events.Add(Event(t, value.Active ? "fog_enabled" : "fog_disabled", value, "observed-state-change"));
                }
            }
        }
        string[] removed = _previous.Keys.Where(id => !current.ContainsKey(id)).ToArray();
        if (t >= _nextSnapshotAt)
        {
            write(new { type = "world_snapshot", t, complete = true, objects });
            _nextSnapshotAt = t + 10_000;
        }
        else if (upserts.Count != 0 || removed.Length != 0)
        {
            write(new { type = "world_delta", t, upserts, removed });
        }
        foreach (object value in events) write(value);
        _previous.Clear();
        foreach (WorldObjectTelemetry value in objects) _previous.Add(value.ObjectId, value);
    }

    public static object Event(long t, string eventName, WorldObjectTelemetry value, string source) => new
    {
        type = "world_event", t, @event = eventName, objectId = value.ObjectId, kind = value.Kind,
        pos = value.Position, source, activity = value.Activity, radius = value.Radius,
        prefabName = value.PrefabName, itemId = value.ItemId,
    };

    private static bool Equivalent(WorldObjectTelemetry a, WorldObjectTelemetry b) =>
        a.Kind == b.Kind && a.PrefabName == b.PrefabName && a.Active == b.Active && a.Activity == b.Activity
        && a.Source == b.Source && a.ItemId == b.ItemId && a.ItemInstanceId == b.ItemInstanceId
        && a.LastThrownByPlayerId == b.LastThrownByPlayerId && a.PhotonViewId == b.PhotonViewId
        && a.ActivationRadius == b.ActivationRadius && a.WarningRadius == b.WarningRadius
        && a.WarningRadiusSource == b.WarningRadiusSource && a.SpawnRadius == b.SpawnRadius
        && a.Radius == b.Radius && a.Shape == b.Shape && a.StatusType == b.StatusType
        && a.StatusAmountPerSecond == b.StatusAmountPerSecond && a.TargetPlayerId == b.TargetPlayerId
        && a.StatusEnabled == b.StatusEnabled && a.StatusDelaySeconds == b.StatusDelaySeconds
        && a.SightDistance == b.SightDistance && a.VisualRadius == b.VisualRadius && a.Falloff == b.Falloff
        && a.RelatedObjectId == b.RelatedObjectId && a.ScenePath == b.ScenePath
        && EqualArray(a.Position, b.Position) && EqualArray(a.Rotation, b.Rotation)
        && EqualArray(a.Scale, b.Scale) && EqualArray(a.Size, b.Size)
        && EqualArray(a.ActivationRequires, b.ActivationRequires);

    private static bool EqualArray<T>(T[]? a, T[]? b) => ReferenceEquals(a, b)
        || (a != null && b != null && a.SequenceEqual(b));
}
