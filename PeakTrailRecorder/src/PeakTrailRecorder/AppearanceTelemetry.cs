using System;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

internal sealed class AppearanceTelemetry
{
    [JsonProperty("ready")] public bool Ready { get; set; }
    [JsonProperty("authority")] public string Authority { get; set; } = "persistent-player-data-sync";
    [JsonProperty("skinIndex")] public int SkinIndex { get; set; }
    [JsonProperty("eyesIndex")] public int EyesIndex { get; set; }
    [JsonProperty("mouthIndex")] public int MouthIndex { get; set; }
    [JsonProperty("accessoryIndex")] public int AccessoryIndex { get; set; }
    [JsonProperty("outfitIndex")] public int OutfitIndex { get; set; }
    [JsonProperty("hatIndex")] public int HatIndex { get; set; }
    [JsonProperty("effectiveHatIndex")] public int EffectiveHatIndex { get; set; }
    [JsonProperty("sashIndex")] public int SashIndex { get; set; }
    [JsonProperty("medalIndex")] public int MedalIndex { get; set; }
    [JsonProperty("skinColor")] public float[] SkinColor { get; set; } = Array.Empty<float>();
    [JsonProperty("outfitName")] public string OutfitName { get; set; } = string.Empty;
    [JsonProperty("hatName")] public string HatName { get; set; } = string.Empty;
    public string Fingerprint() => JsonConvert.SerializeObject(this);
}

internal static class AppearanceReadiness
{
    public static bool IsReady(bool local, bool localStatsReady, object? currentData, object? synchronizedData, long observedForMs)
    {
        return observedForMs >= 2000 && currentData != null
            && (local ? localStatsReady : ReferenceEquals(currentData, synchronizedData));
    }
}
