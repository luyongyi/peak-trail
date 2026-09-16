using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static MapHandler.MapSegment Segment(Biome.BiomeType biome, string name) =>
    new() { RawBiome = biome, RawParent = new GameObject { name = name } };

var map = new MapHandler
{
    segments = new[]
    {
        Segment(Biome.BiomeType.Shore, "Shore_Segment"),
        Segment(Biome.BiomeType.Roots, "Roots_Segment"),
        Segment(Biome.BiomeType.Mesa, "Mesa_Segment"),
        Segment(Biome.BiomeType.Volcano, "Caldera_Segment"),
        Segment(Biome.BiomeType.Volcano, "Volcano_Segment"),
    },
    variantSegments = new[]
    {
        Segment(Biome.BiomeType.Swamp, "Swamp_Segment"),
        Segment(Biome.BiomeType.Swamp, "Temple_Segment"),
    },
};
MapHandler.Instance = map;
MapHandler.ExistsAndInitialized = true;
map.segments[3].hasVariant = true;
map.segments[3].variantBiomeIndex = 0;
map.segments[4].hasVariant = true;
map.segments[4].variantBiomeIndex = 1;
map.biomes.Add(Biome.BiomeType.Volcano);

var volcano = RouteTelemetryReader.Read();
Assert(volcano?.Branch == "volcano-kiln", "The active Volcano biome pair must select Volcano -> Kiln.");
Assert(volcano!.Segments.Count == 5, "Inactive future stages must not be omitted from route metadata.");
Assert(volcano.Segments[3].Name == "Caldera_Segment" && volcano.Segments[4].Name == "Volcano_Segment",
    "Distinct stage parents must survive even when the stages share a biome enum.");
Assert(!volcano.Segments[3].VariantSelected, "The mere presence of a variant object must not select that branch.");

map.biomes.Clear();
map.biomes.Add(Biome.BiomeType.Swamp);
var swamp = RouteTelemetryReader.Read();
Assert(swamp?.Branch == "swamp-temple", "The resolved Swamp pair must select Mist Island -> Citadel.");
Assert(swamp!.Segments[3].BiomeId == 8 && swamp.Segments[4].BiomeId == 8,
    "The ending is biome Swamp, not the unrelated Temple enum.");
Assert(swamp.Segments[3].Name == "Swamp_Segment" && swamp.Segments[4].Name == "Temple_Segment",
    "Capture must use the game's variant-resolving parent getter.");
Assert(swamp.Segments[3].VariantSelected && swamp.Segments[4].VariantBiomeIndex == 1,
    "The selected variant index must be preserved as independent evidence.");
Assert(swamp.Fingerprint() != volcano.Fingerprint(), "A resolved route change must emit a fresh record.");

var record = JObject.FromObject(new { type = "route", t = 0, route = swamp });
Assert((string?)record["route"]?["authority"] == "maphandler-resolved-biomes", "Runtime evidence needs an explicit authority.");
Assert((int?)record["route"]?["segments"]?[4]?["index"] == 4, "The index is MapHandler's array index, not a public Segment enum.");
Assert(JObject.FromObject(volcano)["segments"]?[3]?["variantBiomeIndex"] == null,
    "An unselected variant must not advertise an active variant index.");
Assert(JsonConvert.DeserializeObject<RouteTelemetry>(swamp.Fingerprint())?.Branch == "swamp-temple", "Route snapshots must round-trip.");

map.segments[4].hasVariant = false;
Assert(RouteTelemetryReader.Read()?.Branch == "unknown", "An inconsistent/modded pair must be preserved as unknown, not silently corrected.");
map.segments[4].RawParent = null;
Assert(RouteTelemetryReader.Read() == null, "A missing resolved parent must not fabricate a usable route.");
MapHandler.ExistsAndInitialized = false;
Assert(RouteTelemetryReader.Read() == null, "Uninitialized maps must not invent a default route.");
Console.WriteLine("PeakTrail route contract passed.");

// Minimal test doubles for the read-only game boundary. The getters mirror
// MapHandler.MapSegment in PEAK 2.4.c; these are not linked into the DLL.
internal sealed class GameObject
{
    public string name = string.Empty;
}

internal sealed class Biome
{
    public enum BiomeType { Shore = 0, Volcano = 3, Mesa = 6, Roots = 7, Swamp = 8 }
}

internal sealed class MapHandler
{
    public static MapHandler? Instance;
    public static bool ExistsAndInitialized;
    public MapSegment[] segments = Array.Empty<MapSegment>();
    public MapSegment[] variantSegments = Array.Empty<MapSegment>();
    public List<Biome.BiomeType> biomes = new();
    public bool BiomeIsPresent(Biome.BiomeType type) => biomes.Contains(type);
    public MapSegment GetVariantSegmentFromBiome(int index) =>
        index < 0 || index >= variantSegments.Length ? segments[0] : variantSegments[index];

    public sealed class MapSegment
    {
        public Biome.BiomeType RawBiome;
        public GameObject? RawParent;
        public bool hasVariant;
        public int variantBiomeIndex;
        private bool UseVariant => hasVariant
            && Instance!.BiomeIsPresent(Instance.GetVariantSegmentFromBiome(variantBiomeIndex).biome);
        public Biome.BiomeType biome => UseVariant
            ? Instance!.GetVariantSegmentFromBiome(variantBiomeIndex).biome : RawBiome;
        public GameObject? segmentParent => UseVariant
            ? Instance!.GetVariantSegmentFromBiome(variantBiomeIndex).segmentParent : RawParent;
    }
}
