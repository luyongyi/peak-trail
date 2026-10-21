using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace PeakTrailRecorder;

/// <summary>Closed projections for public telemetry, independent of the offline file schema.</summary>
internal sealed class LivePayload
{
    private readonly Dictionary<string, string> _players = new(StringComparer.Ordinal);
    private readonly JsonSerializer _serializer = JsonSerializer.Create(new JsonSerializerSettings
    {
        Culture = CultureInfo.InvariantCulture,
        NullValueHandling = NullValueHandling.Ignore,
    });
    private const string Common = "type t playerId activeSegment";
    private const string Stamina = "telemetryReady authority capacityReady baseMaxStamina baseMaxExtraStamina stamina maxStamina stamina01 extraStamina maxExtraStamina extraStamina01 totalStamina";
    private const string Appearance = "ready authority skinIndex eyesIndex mouthIndex accessoryIndex outfitIndex hatIndex effectiveHatIndex sashIndex medalIndex skinColor outfitName hatName formReady form formAuthority formMeshName formMaterialNames formRendererActive ghostReady ghostActive ghostVisible ghostPosition ghostRotation petrificationReady petrificationActive petrificationTriggered petrificationProgress petrificationAmount blindnessReady blindnessActive";
    private const string Status = "ready complete authority source gameSource dead statusSum baseMaxStamina maxStamina baseMaxExtraStamina maxExtraStamina effectsReady effectsAuthority";
    private const string Item = "id itemId name displayName prefabName nameKey slot count";
    private static readonly HashSet<string> Types = new(StringComparer.Ordinal)
        { "participant", "sample", "state", "inventory", "status", "appearance", "event", "route" };

    public static string RoomKey(string runId, string sceneName)
    {
        using SHA256 sha = SHA256.Create();
        byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes("peaktrail-live-v2:" + RunCode.Normalize(runId) + ":" + sceneName));
        return string.Concat(hash.Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
    }

    public static string ReservationKey(string region, string gameVersion, string roomName)
    {
        using SHA256 sha = SHA256.Create();
        // Length-prefix parts to avoid ambiguous separators in custom room names.
        string input = "peaktrail-live-lobby-v1:" + region.Length + ":" + region
            + gameVersion.Length + ":" + gameVersion + roomName.Length + ":" + roomName;
        return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(input)).Select(value => value.ToString("x2", CultureInfo.InvariantCulture)));
    }

    public static JObject Manifest(TraceManifest manifest)
    {
        // Explicit access never serializes raw RunId/Participants into an intermediate tree.
        var result = new JObject
        {
            ["schemaVersion"] = 1, ["startedAtUtc"] = manifest.StartedAtUtc,
            ["gameVersion"] = manifest.GameVersion, ["gameBuildId"] = JToken.FromObject(manifest.GameBuildId),
            ["recorderVersion"] = manifest.RecorderVersion, ["sceneName"] = manifest.SceneName,
            ["levelIndex"] = manifest.LevelIndex, ["mapSlot"] = manifest.MapSlot,
            ["projectionVersion"] = manifest.ProjectionVersion, ["sampleHz"] = manifest.SampleHz,
            ["coordinateSpace"] = manifest.CoordinateSpace, ["positionAuthority"] = manifest.PositionAuthority,
            ["segmentResolution"] = manifest.SegmentResolution, ["activeSegmentSemantics"] = manifest.ActiveSegmentSemantics,
            ["timeUnit"] = "milliseconds", ["recordingScope"] = "all-synchronized-players",
            ["identityMode"] = "session-player-id",
        };
        if (manifest.Route != null) result["route"] = ProjectRoute(JObject.FromObject(manifest.Route));
        return result;
    }

    public JObject? Record(Dictionary<string, object?> record)
    {
        // Caller-thread conversion detaches every POCO before handing it to the worker.
        JObject source = JObject.FromObject(record, _serializer);
        string type = (string?)source["type"] ?? "";
        if (!Types.Contains(type)) return null;
        string fields = type switch
        {
            "participant" => "nickname",
            "sample" => "pos yaw " + Stamina,
            "state" => Stamina,
            "inventory" => "inventoryReady authority selectedSlotKnown selectedSlot heldPresent backpackContentsPresent backpackContentsReady source",
            "status" => "reason",
            "event" => "pos source event confidence cause fromLocation toLocation throwCharge id actionId",
            _ => "",
        };
        JObject result = Pick(source, Common + " " + fields);
        if (source["playerId"]?.Type == JTokenType.String) result["playerId"] = Player((string)source["playerId"]!);
        if (result["nickname"]?.Type == JTokenType.String) result["nickname"] = Limit((string)result["nickname"]!, 64);
        if (type == "appearance" && source["appearance"] is JObject appearance) result["appearance"] = Pick(appearance, Appearance);
        if (type == "status" && source["status"] is JObject status)
        {
            JObject safe = Pick(status, Status);
            safe["values"] = ProjectArray(status["values"], value => Pick(value, "id type amount staminaBlock extraStaminaBlock"));
            safe["effects"] = ProjectArray(status["effects"], value => Pick(value, "typeId type"));
            result["status"] = safe;
        }
        if (type == "route" && source["route"] is JObject route) result["route"] = ProjectRoute(route);
        if ((type == "sample" || type == "event") && source["item"] is JObject item) result["item"] = Pick(item, Item);
        if (type == "inventory" && source["held"] is JObject held) result["held"] = Pick(held, Item);
        else if (type == "inventory" && source.Property("held") != null) result["held"] = JValue.CreateNull();
        if (type == "inventory" && source["slots"] is JArray slots)
        {
            result["slots"] = ProjectArray(slots, slot =>
            {
                JObject safe = Pick(slot, "location container index slotId empty");
                safe["item"] = slot["item"] is JObject value ? Pick(value, Item) : JValue.CreateNull();
                return safe;
            }, 32);
        }
        // Leave room for producerSeq/envelope within the relay's 8 KiB line limit.
        return Encoding.UTF8.GetByteCount(result.ToString(Formatting.None)) <= 7600 ? result : null;
    }

    private string Player(string raw)
    {
        if (!_players.TryGetValue(raw, out string? safe))
        {
            if (_players.Count >= 256) return "p256";
            safe = "p" + (_players.Count + 1).ToString(CultureInfo.InvariantCulture);
            _players.Add(raw, safe);
        }
        return safe;
    }

    private static JObject ProjectRoute(JObject route)
    {
        JObject result = Pick(route, "authority branch");
        result["segments"] = ProjectArray(route["segments"], value => Pick(value, "index biome biomeId name variantSelected variantBiomeIndex"), 16);
        return result;
    }

    private static JArray ProjectArray(JToken? source, Func<JObject, JObject> project, int limit = 64)
        => new(source is JArray array ? array.OfType<JObject>().Take(limit).Select(project) : Enumerable.Empty<JObject>());

    private static JObject Pick(JObject source, string fields)
    {
        var result = new JObject();
        foreach (string field in fields.Split(' '))
        {
            JToken? value = source[field];
            if (value is JValue scalar)
            {
                result[field] = scalar.Type == JTokenType.String
                    ? new JValue(Limit((string?)scalar ?? "", 256)) : scalar.DeepClone();
            }
            else if (value is JArray array && array.All(child => child is JValue))
                result[field] = new JArray(array.Take(16).Select(child => child.Type == JTokenType.String
                    ? new JValue(Limit((string?)child ?? "", 256)) : child.DeepClone()));
        }
        return result;
    }

    private static string Limit(string value, int length)
        => new(value.Where(character => !char.IsControl(character)).Take(length).ToArray());
}

/// <summary>Latest state plus bounded recent events; positions never form an outage backlog.</summary>
internal sealed class LiveRecordBuffer
{
    private const int MaxStates = 2048;
    private const int MaxEvents = 256;
    private readonly object _gate = new();
    private readonly Dictionary<string, JObject> _latest = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JObject> _dirty = new(StringComparer.Ordinal);
    private readonly Queue<JObject> _events = new();
    private readonly Queue<JObject> _history = new();
    private long _latestTime;
    public long LatestTime { get { lock (_gate) return _latestTime; } }

    public void Add(JObject record)
    {
        lock (_gate)
        {
            _latestTime = Math.Max(_latestTime, (long?)record["t"] ?? 0);
            string type = (string?)record["type"] ?? "";
            if (type == "event")
            {
                _events.Enqueue(record);
                _history.Enqueue(record);
                TrimEvents(_events);
                TrimEvents(_history);
                return;
            }
            string key = type + "|" + (string?)record["playerId"];
            if (_latest.Count >= MaxStates && !_latest.ContainsKey(key)) return;
            _latest[key] = record;
            _dirty[key] = record;
        }
    }

    public void ReplaySnapshot(bool includeRecentEvents)
    {
        lock (_gate)
        {
            _dirty.Clear();
            foreach (KeyValuePair<string, JObject> pair in _latest)
            {
                var record = (JObject)pair.Value.DeepClone();
                record["t"] = _latestTime;
                _dirty[pair.Key] = record;
            }
            if (includeRecentEvents)
            {
                _events.Clear();
                TrimEvents(_history);
                foreach (JObject value in _history) _events.Enqueue(value);
            }
        }
    }

    public List<JObject> Take(int maxLines, int maxBytes)
    {
        lock (_gate)
        {
            var result = new List<JObject>();
            int bytes = 0;
            foreach (string key in _dirty.Keys.OrderBy(key => key.StartsWith("participant|", StringComparison.Ordinal) ? 0 : 1).ToArray())
            {
                JObject value = _dirty[key];
                int size = Encoding.UTF8.GetByteCount(value.ToString(Formatting.None)) + 128;
                if (size > maxBytes) { _dirty.Remove(key); continue; }
                if (bytes + size > maxBytes || result.Count >= maxLines) break;
                result.Add((JObject)value.DeepClone());
                bytes += size;
                _dirty.Remove(key);
            }
            TrimEvents(_events);
            while (_events.Count > 0 && result.Count < maxLines)
            {
                JObject value = _events.Peek();
                int size = Encoding.UTF8.GetByteCount(value.ToString(Formatting.None)) + 128;
                if (size > maxBytes) { _events.Dequeue(); continue; }
                if (bytes + size > maxBytes) break;
                result.Add((JObject)_events.Dequeue().DeepClone());
                bytes += size;
            }
            return result;
        }
    }

    private void TrimEvents(Queue<JObject> queue)
    {
        while (queue.Count > MaxEvents || (queue.Count > 0 && (long?)queue.Peek()["t"] < _latestTime - 30_000)) queue.Dequeue();
    }
}
