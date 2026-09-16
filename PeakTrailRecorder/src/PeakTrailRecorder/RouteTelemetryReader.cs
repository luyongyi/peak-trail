using System.Collections.Generic;

namespace PeakTrailRecorder;

internal static class RouteTelemetryReader
{
    public static RouteTelemetry? Read()
    {
        try
        {
            if (!MapHandler.ExistsAndInitialized || MapHandler.Instance?.segments == null)
                return null;

            MapHandler map = MapHandler.Instance;
            var segments = new List<RouteSegmentTelemetry>();
            for (int index = 0; index < map.segments.Length; index++)
            {
                MapHandler.MapSegment segment = map.segments[index];
                if (segment == null || segment.segmentParent == null) return null;

                // Public getters resolve hasVariant through BiomeIsPresent. Inactive
                // stage parents are still part of the route: PEAK deliberately hides
                // future/past stages during play, so activeSelf is NOT a route filter.
                Biome.BiomeType biome = segment.biome;
                bool variantSelected = segment.hasVariant
                    && map.BiomeIsPresent(map.GetVariantSegmentFromBiome(segment.variantBiomeIndex).biome);
                segments.Add(new RouteSegmentTelemetry
                {
                    Index = index,
                    Biome = biome.ToString(),
                    BiomeId = (int)biome,
                    Name = segment.segmentParent.name,
                    VariantSelected = variantSelected,
                    VariantBiomeIndex = variantSelected ? segment.variantBiomeIndex : null,
                });
            }

            return segments.Count == 0 ? null : RouteTelemetry.FromSegments(segments);
        }
        catch
        {
            // Missing or transitioning game state must not invent a default branch.
            return null;
        }
    }
}
