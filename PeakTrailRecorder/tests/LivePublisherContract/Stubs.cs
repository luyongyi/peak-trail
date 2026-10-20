namespace BepInEx.Logging
{
    internal sealed class ManualLogSource
    {
        public void LogWarning(object value) { }
    }
}

namespace PeakTrailRecorder
{
    internal sealed class TraceManifest
    {
        public string RunId { get; set; } = "";
        public string StartedAtUtc { get; set; } = "2026-10-20T00:00:00.0000000+00:00";
        public string GameVersion { get; set; } = "test";
        public object GameBuildId { get; set; } = 25306743;
        public string RecorderVersion { get; set; } = "test";
        public string SceneName { get; set; } = "Level_0";
        public int LevelIndex { get; set; } = 0;
        public int MapSlot { get; set; } = 0;
        public int ProjectionVersion { get; set; } = 1;
        public float SampleHz { get; set; } = 5;
        public string CoordinateSpace { get; set; } = "unity-world-meters";
        public string PositionAuthority { get; set; } = "xyz";
        public string SegmentResolution { get; set; } = "unassigned";
        public string ActiveSegmentSemantics { get; set; } = "global-maphandler-segments-index";
        public object? Route { get; set; }
    }
}
