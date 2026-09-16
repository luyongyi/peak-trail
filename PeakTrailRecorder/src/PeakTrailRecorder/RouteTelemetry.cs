using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

/// <summary>The resolved scene route, not a per-character position or progression value.</summary>
internal sealed class RouteTelemetry
{
    [JsonProperty("authority")]
    public string Authority { get; set; } = "maphandler-resolved-biomes";

    [JsonProperty("branch")]
    public string Branch { get; set; } = "unknown";

    [JsonProperty("segments")]
    public List<RouteSegmentTelemetry> Segments { get; set; } = new();

    public static RouteTelemetry FromSegments(List<RouteSegmentTelemetry> segments)
    {
        // In build 25306743 the last two regular stages share a BiomeType, while
        // the public Segment enum retains Caldera/TheKiln for *both* branches.
        // Never identify an ending using the Segment enum or its index alone.
        RouteSegmentTelemetry? approach = segments.SingleOrDefault(segment => segment.Index == 3);
        RouteSegmentTelemetry? ending = segments.SingleOrDefault(segment => segment.Index == 4);
        string branch = approach?.BiomeId == 3 && ending?.BiomeId == 3
            ? "volcano-kiln"
            : approach?.BiomeId == 8 && ending?.BiomeId == 8
                ? "swamp-temple"
                : "unknown";
        return new RouteTelemetry { Branch = branch, Segments = segments };
    }

    public string Fingerprint() => JsonConvert.SerializeObject(this);
}

internal sealed class RouteSegmentTelemetry
{
    [JsonProperty("index")]
    public int Index { get; set; }

    [JsonProperty("biome")]
    public string Biome { get; set; } = string.Empty;

    [JsonProperty("biomeId")]
    public int BiomeId { get; set; }

    [JsonProperty("name")]
    public string Name { get; set; } = string.Empty;

    [JsonProperty("variantSelected")]
    public bool VariantSelected { get; set; }

    [JsonProperty("variantBiomeIndex", NullValueHandling = NullValueHandling.Ignore)]
    public int? VariantBiomeIndex { get; set; }
}
