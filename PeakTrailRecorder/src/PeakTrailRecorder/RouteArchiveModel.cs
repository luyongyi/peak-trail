using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace PeakTrailRecorder;

// Deliberately independent of Unity. Journal records contain scoped hashes, never account IDs.
internal sealed class RouteArchiveHeader
{
    public string Kind = "header";
    public string Server = "";
    public string RecordingId = "";
    public string StartedUtc = "";
    public JObject Map = new();
    public JObject Difficulty = new();
}

internal sealed class RouteArchiveFrame
{
    [JsonProperty("t")] public int Time;
    [JsonProperty("r", NullValueHandling = NullValueHandling.Ignore)] public string? RunKey;
    [JsonProperty("o", NullValueHandling = NullValueHandling.Ignore)] public long? Origin;
    [JsonProperty("s")] public int Stage;
    [JsonProperty("a")] public List<RouteArchiveActor> Actors = new();
    [JsonProperty("e", NullValueHandling = NullValueHandling.Ignore)] public string? Event;
    [JsonProperty("checkpoint", NullValueHandling = NullValueHandling.Ignore)] public int? Checkpoint;
    [JsonProperty("keys", NullValueHandling = NullValueHandling.Ignore)] public Dictionary<int, string>? Keys;
    [JsonProperty("itemEvents", NullValueHandling = NullValueHandling.Ignore)] public List<RouteArchiveItemEvent>? ItemEvents;
    [JsonProperty("seal", DefaultValueHandling = DefaultValueHandling.Ignore)] public bool Seal;
    [JsonProperty("closed", DefaultValueHandling = DefaultValueHandling.Ignore)] public bool Closed;
}

// Actor is a journal-local integer. Resolve its final scoped key at export so an
// identity arriving after the action also rekeys that action without raw IDs.
internal sealed class RouteArchiveItemEvent
{
    public string Id = "", ActionId = "", Kind = "";
    public int Time, Stage;
    public int[] Position = new int[3];
    public JObject Item = new();
    [JsonProperty(NullValueHandling = NullValueHandling.Ignore)] public int? Actor;
}

internal sealed class ItemEventIdentity
{
    private readonly string _scope;
    private long _sequence;
    private readonly HashSet<string> _spawned = new(StringComparer.Ordinal);
    public ItemEventIdentity(string recordingId) { _scope = recordingId; }
    public string Action() => RouteArchiveIdentity.Hash("peaktrail/item-action/v1/" + _scope + "/" + (++_sequence).ToString(CultureInfo.InvariantCulture));
    public string Event(string action, string kind, string nativeKey) => RouteArchiveIdentity.Hash("peaktrail/item-event/v1/" + _scope + "/" + action + "/" + kind + "/" + nativeKey);
    public bool FirstSpawn(string nativeKey) => _spawned.Add(nativeKey);
}

internal sealed class RouteArchiveActor
{
    [JsonProperty("i")] public int Id;
    [JsonProperty("k", NullValueHandling = NullValueHandling.Ignore)] public string? Key;
    [JsonProperty("n", NullValueHandling = NullValueHandling.Ignore)] public string? Name;
    [JsonProperty("p")] public int[] Position = new int[3];
    // alive / owner / warping / won / wonViaNadir
    [JsonProperty("f")] public int Flags;
    [JsonProperty("w")] public int Warp;
}

internal static class RouteArchiveIdentity
{
    public static string Hash(string value)
    {
        using var hash = SHA256.Create();
        return string.Concat(hash.ComputeHash(Encoding.UTF8.GetBytes(value)).Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));
    }
    public static string Run(Guid id) => id == Guid.Empty ? "" : Hash("peak-memories/run/v1/" + id.ToString("D"));
    public static string Player(string scope, string actor) => Hash("peak-memories/player/v1/" + scope + "/" + actor);
    public static int Cm(float value) => checked((int)Math.Round((double)value * 100, MidpointRounding.AwayFromZero));
}

// Rebuilt from a durable journal by the disk worker. Compatible with Memories v0.8.36
// identity, center coordinates and shared run-clock anchor. Never infer a checkpoint
// for all players merely because the global MapHandler advanced.
internal sealed class RouteArchiveBuilder
{
    private sealed class Track
    {
        public string Key = "", Name = "";
        public bool Owner, Present, Dead, HasState, Summit, Nadir, EnteredNadir, NadirEntryPending;
        public int LastTime = -1, LastPoint = -100, Flags, Warp, Stage = -1;
        public int[]? Position;
        public readonly JArray Points = new(), Events = new();
        public readonly HashSet<int> Finished = new();
        public readonly HashSet<int> Checkpoints = new();
    }
    private readonly RouteArchiveHeader _header;
    private readonly Dictionary<int, Track> _tracks = new();
    private readonly Dictionary<string, RouteArchiveItemEvent> _itemEvents = new(StringComparer.Ordinal);
    private readonly JObject[] _stages;
    private string? _runKey;
    private long? _origin;
    private int _duration;
    private long _points, _events;
    public int FrameCount { get; private set; }
    public RouteArchiveBuilder(RouteArchiveHeader header)
    {
        _header = header;
        _stages = ((JArray)header.Map["stages"]!).Cast<JObject>().ToArray();
    }
    public void Observe(RouteArchiveFrame frame)
    {
        if (frame.Time < _duration) throw new InvalidOperationException("Route journal clock is invalid.");
        if (frame.Time > 14_400_000) throw new RouteArchiveBudgetException("duration-over-four-hours");
        _duration = frame.Time; FrameCount++;
        if (!string.IsNullOrEmpty(frame.RunKey))
        {
            if (_runKey != frame.RunKey) { _runKey = frame.RunKey; _origin = frame.Origin; }
            else if (frame.Origin.HasValue) _origin = frame.Origin;
        }
        var present = new HashSet<int>();
        foreach (var actor in frame.Actors)
        {
            present.Add(actor.Id);
            if (!_tracks.TryGetValue(actor.Id, out var track)) _tracks.Add(actor.Id, track = new Track());
            if (actor.Key != null) track.Key = actor.Key;
            if (actor.Name != null) track.Name = actor.Name;
            track.Owner |= (actor.Flags & 2) != 0;
            bool alive = (actor.Flags & 1) != 0, warping = (actor.Flags & 4) != 0;
            bool join = !track.Present, terminal = track.HasState && !track.Dead && !alive && !join;
            if (join) { Event(track, frame.Time, "join"); track.Position = null; }
            if (!alive && (!track.HasState || !track.Dead || join)) Event(track, frame.Time, "dead");
            else if (alive && track.HasState && track.Dead) { Event(track, frame.Time, "revive"); Event(track, frame.Time, "break"); track.Position = null; }
            bool warp = track.HasState && (actor.Warp != track.Warp || warping && (track.Flags & 4) == 0);
            bool gap = track.LastTime >= 0 && frame.Time - track.LastTime > 1000;
            bool jump = track.Position != null && Distance(track.Position, actor.Position) > Math.Max(1000, (frame.Time - track.LastTime) * 5d);
            if (warp) Event(track, frame.Time, "warp", null, actor.Position);
            if (warp || gap || jump || join && track.HasState) { Event(track, frame.Time, "break"); track.Position = null; }
            if (frame.Stage >= 0 && frame.Stage < _stages.Length && track.Stage != frame.Stage)
            {
                bool toVoid = (string?)_stages[frame.Stage]["name"] == "Void";
                track.NadirEntryPending = toVoid && track.Stage >= 0 && (string?)_stages[track.Stage]["name"] != "Void";
                if (!toVoid) track.EnteredNadir = false;
                Event(track, frame.Time, "game-stage", frame.Stage, actor.Position); track.Stage = frame.Stage;
            }
            bool isVoid = track.Stage >= 0 && track.Stage < _stages.Length && (string?)_stages[track.Stage]["name"] == "Void";
            if (alive && isVoid && !warping && track.NadirEntryPending && !track.EnteredNadir)
            { Event(track, frame.Time, "nadir-entry", track.Stage, actor.Position); track.EnteredNadir = true; }
            if (alive && isVoid && (frame.Event == "nadir-wall" || frame.Event == "nadir-chase"))
                Event(track, frame.Time, frame.Event, track.Stage, actor.Position);
            if (alive && !warping && (actor.Flags & 2) != 0 && frame.Checkpoint is int checkpoint && checkpoint >= 0
                && checkpoint < _stages.Length && (string?)_stages[checkpoint]["name"] != "Void"
                && frame.Stage == checkpoint + 1 && !isVoid && track.Checkpoints.Add(checkpoint))
                Event(track, frame.Time, "native-checkpoint", checkpoint, actor.Position);
            bool sameBucket = frame.Time / 100 == track.LastPoint / 100 && track.LastPoint >= 0;
            if (alive && !warping && !warp && !gap && !jump && !join && !track.Dead && track.Position != null)
                foreach (var stage in _stages)
                {
                    int index = (int)stage["index"]!;
                    if (stage["exitZCm"] is JValue exit && track.Position[2] <= (int)exit && actor.Position[2] > (int)exit && track.Finished.Add(index))
                        Event(track, frame.Time, "finish", index, actor.Position);
                }
            if (terminal || alive && !sameBucket)
            {
                var point = new JArray(frame.Time, actor.Position[0], actor.Position[1], actor.Position[2]);
                if (sameBucket && track.Points.Count != 0) track.Points[track.Points.Count - 1] = point;
                else { if (++_points > 400_000) throw new RouteArchiveBudgetException("point-memory-budget"); track.Points.Add(point); }
                track.LastPoint = frame.Time;
            }
            bool won = (actor.Flags & 8) != 0, nadir = (actor.Flags & 16) != 0;
            if (alive && won && nadir && !track.Nadir)
            {
                int stage = Array.FindIndex(_stages, s => (string?)s["name"] == "Void");
                if (stage >= 0) { Event(track, frame.Time, "nadir", stage, actor.Position); track.Nadir = true; }
            }
            if (alive && won && !nadir && !track.Summit)
            {
                int stage = Array.FindLastIndex(_stages, s => (string?)s["name"] != "Void");
                if (stage >= 0) { Event(track, frame.Time, "summit", stage, actor.Position); track.Summit = true; }
            }
            track.Present = true; track.Dead = !alive; track.HasState = true;
            track.Position = actor.Position; track.LastTime = frame.Time; track.Warp = actor.Warp; track.Flags = actor.Flags;
        }
        foreach (var pair in _tracks)
            if (pair.Value.Present && !present.Contains(pair.Key))
            { Event(pair.Value, frame.Time, "leave"); Event(pair.Value, frame.Time, "break"); pair.Value.Present = false; pair.Value.Position = null; }
        if (frame.Keys != null) foreach (var pair in frame.Keys)
            if (_tracks.TryGetValue(pair.Key, out var track)) track.Key = pair.Value;
        if (frame.ItemEvents != null) foreach (var itemEvent in frame.ItemEvents)
        {
            if (_itemEvents.ContainsKey(itemEvent.Id)) continue;
            if (_itemEvents.Count >= 4096) throw new RouteArchiveBudgetException("item-event-budget");
            _itemEvents.Add(itemEvent.Id, itemEvent);
        }
    }
    public JObject Finish()
    {
        var players = new JArray();
        foreach (var track in _tracks.Values.Where(t => t.Key.Length == 64).OrderBy(t => t.Key, StringComparer.Ordinal))
            players.Add(new JObject { ["key"] = track.Key, ["name"] = track.Name, ["owner"] = track.Owner,
                ["evidence"] = "native-state", ["points"] = track.Points, ["events"] = track.Events });
        var result = new JObject { ["format"] = "trajectory-v1", ["recordingId"] = _header.RecordingId,
            ["startedUtc"] = _header.StartedUtc, ["durationMs"] = _duration, ["sampleHz"] = 10, ["coordinateUnit"] = "cm",
            ["map"] = _header.Map.DeepClone(), ["difficulty"] = _header.Difficulty.DeepClone(), ["players"] = players };
        if (_runKey != null && _origin.HasValue) { result["runKey"] = _runKey; result["timeOriginMs"] = _origin.Value; }
        if (_itemEvents.Count != 0)
        {
            var events = new JArray();
            foreach (var itemEvent in _itemEvents.Values.OrderBy(e => e.Time).ThenBy(e => e.Id, StringComparer.Ordinal))
            {
                var value = new JObject { ["id"] = itemEvent.Id, ["kind"] = itemEvent.Kind, ["tMs"] = itemEvent.Time,
                    ["stageIndex"] = itemEvent.Stage, ["positionCm"] = new JArray(itemEvent.Position), ["item"] = itemEvent.Item.DeepClone() };
                if (itemEvent.ActionId.Length != 0) value["actionId"] = itemEvent.ActionId;
                if (itemEvent.Actor is int actor && _tracks.TryGetValue(actor, out var track) && track.Key.Length == 64) value["playerKey"] = track.Key;
                events.Add(value);
            }
            result["itemEvents"] = events;
        }
        return result;
    }
    private static double Distance(int[] a, int[] b) => Math.Sqrt(Math.Pow((double)a[0]-b[0],2)+Math.Pow((double)a[1]-b[1],2)+Math.Pow((double)a[2]-b[2],2));
    private void Event(Track track, int time, string kind, int? stage = null, int[]? position = null)
    {
        if (++_events > 200_000 || track.Events.Count >= 100_000) throw new RouteArchiveBudgetException("event-memory-budget");
        var e = new JObject { ["tMs"] = time, ["kind"] = kind };
        if (stage.HasValue) e["stageIndex"] = stage.Value;
        if (position != null) e["positionCm"] = new JArray(position);
        track.Events.Add(e);
    }
}

internal sealed class RouteArchiveBudgetException : Exception
{
    public RouteArchiveBudgetException(string reason) : base(reason) { }
}
