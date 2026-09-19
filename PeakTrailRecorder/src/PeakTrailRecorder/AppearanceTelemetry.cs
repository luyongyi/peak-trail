using System;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

internal sealed class AppearanceTelemetry
{
    [JsonProperty("ready")] public bool Ready { get; set; }
    [JsonProperty("authority")] public string Authority { get; set; } = "cosmetics-unavailable";
    // Missing cosmetic packets must not fabricate the all-zero default outfit.
    [JsonProperty("skinIndex")] public int? SkinIndex { get; set; }
    [JsonProperty("eyesIndex")] public int? EyesIndex { get; set; }
    [JsonProperty("mouthIndex")] public int? MouthIndex { get; set; }
    [JsonProperty("accessoryIndex")] public int? AccessoryIndex { get; set; }
    [JsonProperty("outfitIndex")] public int? OutfitIndex { get; set; }
    [JsonProperty("hatIndex")] public int? HatIndex { get; set; }
    [JsonProperty("effectiveHatIndex")] public int? EffectiveHatIndex { get; set; }
    [JsonProperty("sashIndex")] public int? SashIndex { get; set; }
    [JsonProperty("medalIndex")] public int? MedalIndex { get; set; }
    [JsonProperty("skinColor")] public float[]? SkinColor { get; set; }
    [JsonProperty("outfitName")] public string OutfitName { get; set; } = string.Empty;
    [JsonProperty("hatName")] public string HatName { get; set; } = string.Empty;
    // Runtime form is independent of persistent outfit readiness. It is sampled
    // for both the local owner and observable, RPC-synchronized remote players.
    [JsonProperty("formReady")] public bool FormReady { get; set; }
    [JsonProperty("form")] public string Form { get; set; } = "unknown";
    [JsonProperty("formAuthority")] public string FormAuthority { get; set; } = "character-form-unavailable";
    [JsonProperty("formMeshName")] public string? FormMeshName { get; set; }
    [JsonProperty("formMaterialNames")] public string[] FormMaterialNames { get; set; } = Array.Empty<string>();
    [JsonProperty("formRendererActive")] public bool? FormRendererActive { get; set; }
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
