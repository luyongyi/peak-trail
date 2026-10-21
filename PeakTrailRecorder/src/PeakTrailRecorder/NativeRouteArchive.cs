using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PeakTrailRecorder;

// Only this adapter reads Unity. The upload worker receives durable plain DTOs.
internal sealed class NativeRouteArchive : IDisposable
{
    private sealed class Actor
    {
        public int Id, Warp;
        public string Identity = "", LastKey = "", LastName = "", LastScope = "";
        public Character Character = null!;
        public Action<Character>? WarpHandler;
        public bool Entered, Won, Nadir, SawOrdinary;
        public readonly HashSet<int> Checkpoints = new();
    }
    private readonly Dictionary<string, Actor> _actors = new(StringComparer.Ordinal);
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly RouteArchiveJournal _journal;
    private readonly string _recordingId;
    private readonly int _voidStage;
    private readonly int _summitStage;
    private readonly Action<string, Character?, int, Vector3?> _liveEvent;
    private bool _closed, _capturing;
    private long _nextSample;
    private int _lastStage = -1;
    private int _lastFrameTime = -1, _lastStageTime = -1;
    private string _lastRunKey = "";
    private Guid _lastRunId;
    public int RunManagerId { get; }
    public string Scene { get; }
    public NativeRouteArchive(RouteArchiveOutbox outbox, string server, Action<string, Character?, int, Vector3?> liveEvent)
    {
        _liveEvent = liveEvent;
        Scene = SceneManager.GetActiveScene().name;
        RunManagerId = RunManager.Instance.GetInstanceID();
        _recordingId = RouteArchiveIdentity.Hash("peak-memories/recording/" + Guid.NewGuid().ToString("N"));
        var header = Context(server, _recordingId);
        var stages = ((JArray)header.Map["stages"]!).Cast<JObject>().ToArray();
        _voidStage = Array.FindIndex(stages, s => (string?)s["name"] == "Void");
        _summitStage = Array.FindLastIndex(stages, s => (string?)s["name"] != "Void");
        _journal = new RouteArchiveJournal(outbox, header);
        try { Capture(true); }
        catch { foreach (var actor in _actors.Values) Detach(actor); _journal.Dispose(); throw; }
    }
    public void Tick()
    {
        if (_closed) return;
        _journal.FlushIfDue();
        if (_clock.ElapsedMilliseconds >= _nextSample) { _nextSample = _clock.ElapsedMilliseconds + 100; Capture(false); }
    }
    public void Capture(bool critical, string? nativeEvent = null, bool seal = false)
    {
        if (_closed || _capturing) return;
        _capturing = true;
        try
        {
            int now = checked((int)_clock.ElapsedMilliseconds);
            // The HTTP contract has a four-hour member duration. Preserve later
            // observations locally rather than silently clipping their clocks.
            var run = RunManager.Instance;
            string runKey = _lastRunKey;
            if (run && run.RunId != Guid.Empty && run.RunId != _lastRunId)
            { _lastRunId = run.RunId; runKey = RouteArchiveIdentity.Run(run.RunId); }
            bool scopeChanged = runKey.Length != 0 && runKey != _lastRunKey;
            if (runKey.Length == 0) runKey = _lastRunKey; else _lastRunKey = runKey;
            long? origin = null;
            if (run && !float.IsNaN(run.TimeSinceRunStarted) && !float.IsInfinity(run.TimeSinceRunStarted) && run.TimeSinceRunStarted >= 0)
            {
                long value = (long)Math.Round(run.TimeSinceRunStarted * 1000d) - now;
                if (value >= -60_000 && value <= 604_800_000) origin = value;
            }
            int stage = NativeStage();
            var frame = new RouteArchiveFrame { Time = now, RunKey = runKey.Length == 0 ? null : runKey, Origin = origin,
                Stage = stage, Event = nativeEvent, Seal = seal, Closed = nativeEvent == "end" };
            if (nativeEvent != null && nativeEvent.StartsWith("local-checkpoint:", StringComparison.Ordinal)
                && int.TryParse(nativeEvent.Substring(17), out int checkpoint)) frame.Checkpoint = checkpoint;
            foreach (var c in Character.AllCharacters)
            {
                if (!c || !c.IsPlayerControlled || !c.gameObject.activeInHierarchy || c.data == null || !c.refs?.hip) continue;
                var owner = c.photonView ? c.photonView.Owner : null;
                string id = !string.IsNullOrEmpty(owner?.UserId) ? owner!.UserId : owner != null
                    ? "actor:" + owner.ActorNumber : "view:" + (c.photonView ? c.photonView.ViewID : c.GetInstanceID());
                string localId = owner != null ? "actor:" + owner.ActorNumber : "view:" + (c.photonView ? c.photonView.ViewID : c.GetInstanceID());
                if (!_actors.TryGetValue(localId, out var actor))
                {
                    actor = new Actor { Id = _actors.Count + 1, Identity = id, Character = c };
                    _actors.Add(localId, actor); Attach(actor, c);
                }
                else if (actor.Character != c) { Detach(actor); actor.Character = c; Attach(actor, c); }
                bool identityChanged = actor.Identity != id;
                actor.Identity = id;
                var stats = c.refs.stats;
                bool won = stats && stats.won, nadir = won && stats!.wonViaNadir;
                if (nadir && _voidStage >= 0) frame.Stage = stage = _voidStage; // cutscene already deactivates Void
                int flags = (!c.data.dead ? 1 : 0) | (c.IsLocal ? 2 : 0) | (c.warping ? 4 : 0) | (won ? 8 : 0) | (nadir ? 16 : 0);
                Vector3 p = c.Center;
                string scope = runKey.Length == 0 ? _recordingId : runKey;
                string key = !identityChanged && actor.LastScope == scope && actor.LastKey.Length != 0 ? actor.LastKey : RouteArchiveIdentity.Player(scope, id);
                string name = CleanName(owner?.NickName ?? c.name);
                frame.Actors.Add(new RouteArchiveActor { Id = actor.Id, Key = key != actor.LastKey ? key : null,
                    Name = name != actor.LastName || actor.LastKey.Length == 0 ? name : null,
                    Position = new[] { RouteArchiveIdentity.Cm(p.x), RouteArchiveIdentity.Cm(p.y), RouteArchiveIdentity.Cm(p.z) }, Flags = flags, Warp = actor.Warp });
                actor.LastKey = key; actor.LastName = name; actor.LastScope = scope;
                if (frame.Checkpoint is int completed && completed >= 0 && completed < _summitStage
                    && stage == completed + 1 && stage != _voidStage && c.IsLocal && !c.data.dead && !c.warping && actor.Checkpoints.Add(completed))
                { _liveEvent("native-checkpoint", c, completed, p); critical = true; frame.Seal = true; }
                if (stage >= 0 && stage != _voidStage) { actor.SawOrdinary = true; actor.Entered = false; }
                if (!c.data.dead && !c.warping && stage == _voidStage && _voidStage >= 0 && actor.SawOrdinary && !actor.Entered)
                { actor.Entered = true; _liveEvent("nadir-entry", c, stage, p); critical = true; }
                if (!c.data.dead && stage == _voidStage && _voidStage >= 0 && (nativeEvent == "nadir-wall" || nativeEvent == "nadir-chase"))
                    _liveEvent(nativeEvent!, c, stage, p);
                if (won && !actor.Won)
                { actor.Won = true; actor.Nadir = nadir; _liveEvent(nadir ? "nadir" : "summit", c, nadir ? _voidStage : _summitStage, p); critical = true; frame.Seal = true; }
            }
            if (nativeEvent == "nadir-ready") _liveEvent(nativeEvent, null, stage, null);
            if (scopeChanged) frame.Keys = _actors.Values.ToDictionary(a => a.Id, a => RouteArchiveIdentity.Player(runKey, a.Identity));
            if (_lastStage >= 0 && frame.Stage != _lastStage) { critical = true; frame.Seal = true; }
            frame.Time = Math.Max(frame.Time, _lastFrameTime);
            if (frame.Stage != _lastStage) { frame.Time = Math.Max(frame.Time, _lastStageTime + 1); _lastStageTime = frame.Time; }
            if (frame.Origin.HasValue) frame.Origin -= frame.Time - now;
            _lastStage = frame.Stage;
            _lastFrameTime = frame.Time;
            _journal.Append(frame, critical);
        }
        finally { _capturing = false; }
    }
    private void Attach(Actor actor, Character c)
    {
        actor.WarpHandler = _ => { actor.Warp++; NativeRouteHooks.Capture?.Invoke(true, "warp", true); };
        c.WarpCompleted += actor.WarpHandler;
    }
    private static void Detach(Actor actor)
    { if (actor.Character && actor.WarpHandler != null) actor.Character.WarpCompleted -= actor.WarpHandler; }
    public void Dispose()
    {
        if (_closed) return;
        try { Capture(true, "end", true); }
        finally { _closed = true; foreach (var actor in _actors.Values) Detach(actor); _journal.Dispose(); }
    }
    private static string CleanName(string name) => new(name.Where(c => c >= 32 && c != 127).Take(100).ToArray());
    private int NativeStage()
    {
        if (!MapHandler.ExistsAndInitialized) return _lastStage;
        int segment = (int)MapHandler.Instance.GetCurrentSegment();
        return segment == 6 ? _voidStage : segment == 5 ? 4 : segment;
    }
    // Exact v0.8.36 native landmark/gate/layout identity algorithm. This makes
    // Recorder and Memories uploads comparable without either DLL referencing the other.
    private static RouteArchiveHeader Context(string server, string recordingId)
    {
        var map = MapHandler.Instance;
        int build = 0; try { build = Steamworks.SteamApps.GetAppBuildId(); } catch { }
        string scene = SceneManager.GetActiveScene().name;
        string route = string.Join(",", map.segments.Select(s => s.biome.ToString()));
        var stages = new JArray();
        var available = MountainProgressHandler.Instance ? MountainProgressHandler.Instance.progressPoints : null;
        var used = new HashSet<MountainProgressHandler.ProgressPoint>();
        var entries = new List<MountainProgressHandler.ProgressPoint?>();
        int normal = Math.Min(5, map.segments.Length);
        for (int i = 0; i < normal; i++)
        {
            var biome = map.segments[i].biome;
            var point = available?.FirstOrDefault(p => p != null && p.transform && p.biome == biome && !used.Contains(p));
            if (point != null) used.Add(point);
            entries.Add(point);
            string name = biome.ToString();
            if (i == 4 && point?.title == "THE KILN") name = "Kiln";
            else if (i == 4 && point?.title == "THE CITADEL") name = "Temple";
            stages.Add(new JObject { ["index"] = i, ["name"] = name });
        }
        var peak = available?.FirstOrDefault(p => p != null && p.transform && p.biome == Biome.BiomeType.Peak);
        for (int i = 0; i < normal; i++)
        {
            var enter = entries[i]; var exit = i + 1 < normal ? entries[i + 1] : peak;
            if (enter?.transform && exit?.transform && enter.transform.position.z < exit.transform.position.z)
            { stages[i]["enterZCm"] = RouteArchiveIdentity.Cm(enter.transform.position.z); stages[i]["exitZCm"] = RouteArchiveIdentity.Cm(exit.transform.position.z); }
        }
        if (map.segments.Skip(normal).Any(s => s.biome == Biome.BiomeType.Void)) stages.Add(new JObject { ["index"] = stages.Count, ["name"] = "Void" });
        var landmarks = new JArray();
        for (int i = 0; i < stages.Count && i < map.segments.Length; i++)
            if (map.segments[i].segmentParent) landmarks.Add(Landmark(map.segments[i].segmentParent.transform, "segment-root", i));
        for (int i = 0; i < entries.Count; i++) if (entries[i]?.transform) landmarks.Add(Landmark(entries[i]!.transform, "progress-point", i));
        if (peak?.transform) landmarks.Add(Landmark(peak.transform, "progress-point", null));
        var roots = map.segments.Select((s, i) => s.segmentParent ? i + ":" + TransformPath(s.segmentParent.transform) + ":" +
            string.Join(",", new[] { s.segmentParent.transform.position.x, s.segmentParent.transform.position.y, s.segmentParent.transform.position.z }
                .Select(p => RouteArchiveIdentity.Cm(p).ToString(CultureInfo.InvariantCulture))) : i + ":unknown");
        string gates = string.Join(";", stages.Select(s => s["index"] + ":" + s["name"] + ":" + s["enterZCm"] + ":" + s["exitZCm"]));
        var metadata = new JObject { ["buildId"] = build, ["scene"] = scene, ["route"] = new JArray(stages.Select(s => (string?)s["name"])), ["stages"] = stages,
            ["layoutKey"] = RouteArchiveIdentity.Hash("peak-memories/layout/v1/" + build + "/" + typeof(Character).Assembly.ManifestModule.ModuleVersionId.ToString("N") + "/" + scene + "/" + route + "/" + string.Join(";", roots) + "/" + gates) };
        try { int? level = GameHandler.GetService<NextLevelService>()?.NextLevelIndexOrFallback; if (level >= 0) metadata["levelIndex"] = level; } catch { }
        if (landmarks.Count != 0) metadata["alignment"] = new JObject { ["version"] = 1, ["coordinateSpace"] = "unity-world-cm", ["landmarks"] = landmarks };
        var difficulty = new JObject { ["ascent"] = null, ["custom"] = null, ["mini"] = null };
        try { difficulty["ascent"] = Ascents.currentAscent; difficulty["custom"] = RunSettings.IsCustomRun; difficulty["mini"] = RunSettings.isMiniRun; } catch { }
        string endpoint = "";
        try { endpoint = new LiveRelayConnection(server).ServerUrl; } catch (ArgumentException) { /* Keep local capture available even with invalid relay configuration. */ }
        return new RouteArchiveHeader { Server = endpoint, RecordingId = recordingId, StartedUtc = DateTime.UtcNow.ToString("O"), Map = metadata, Difficulty = difficulty };
    }
    private static JObject Landmark(Transform t, string kind, int? stage)
    {
        var p = t.position;
        var value = new JObject { ["key"] = kind + ":" + (stage?.ToString(CultureInfo.InvariantCulture) ?? "peak"), ["kind"] = kind,
            ["name"] = t.name, ["positionCm"] = new JArray(RouteArchiveIdentity.Cm(p.x), RouteArchiveIdentity.Cm(p.y), RouteArchiveIdentity.Cm(p.z)) };
        if (stage.HasValue) value["stageIndex"] = stage.Value;
        if (kind == "segment-root") { var r = t.rotation; var s = t.lossyScale; value["rotation"] = new JArray(r.x,r.y,r.z,r.w); value["scale"] = new JArray(s.x,s.y,s.z); }
        return value;
    }
    private static string TransformPath(Transform t)
    { var parts = new Stack<string>(); while (t.parent) { parts.Push(t.GetSiblingIndex() + ":" + Uri.EscapeDataString(t.name)); t = t.parent; } parts.Push(Uri.EscapeDataString(t.name)); return string.Join("/", parts); }
}

internal static class NativeRouteHooks
{
    private static Harmony? _harmony;
    public static Action<bool, string?, bool>? Capture;
    public static void Install(Action<string> warning)
    {
        _harmony = new Harmony("PeakTrailRecorder.RouteArchive");
        Patch(typeof(MapHandler), "GoToSegment", nameof(BeforeTransition), nameof(AfterTransition));
        Patch(typeof(MapHandler), "JumpToSegmentLogic", nameof(BeforeTransition), nameof(AfterTransition));
        Patch(typeof(CharacterStats), "Win", null, nameof(AfterWin));
        Patch(typeof(Peak.ScoutStatue), "RPC_InsertAmulet", null, nameof(AfterAmulet));
        Patch(typeof(MountainProgressHandler), "SetSegmentComplete", null, nameof(AfterCheckpoint));
        void Patch(Type type, string name, string? prefix, string? postfix)
        {
            try
            {
                var method = AccessTools.Method(type, name);
                if (method == null) { warning("Route archive native hook unavailable: " + type.Name + "." + name); return; }
                _harmony!.Patch(method, prefix == null ? null : new HarmonyMethod(typeof(NativeRouteHooks), prefix), postfix == null ? null : new HarmonyMethod(typeof(NativeRouteHooks), postfix));
            }
            catch (Exception e) { warning("Route archive native hook unavailable (" + e.GetType().Name + ")."); }
        }
    }
    public static void Uninstall() { Capture = null; _harmony?.UnpatchSelf(); _harmony = null; }
    private static void BeforeTransition() => Capture?.Invoke(true, "transition-before", false);
    private static void AfterTransition() => Capture?.Invoke(true, "transition-after", true);
    private static void AfterWin() => Capture?.Invoke(true, "native-win", true);
    private static void AfterAmulet(int amuletType) { if (amuletType == -2) Capture?.Invoke(true, "nadir-ready", false); }
    private static void AfterCheckpoint(int segment) => Capture?.Invoke(true, "local-checkpoint:" + (segment - 1), true);
}
