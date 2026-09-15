using System;

namespace PeakTrail.MapExporter;

internal readonly struct ExportSettings
{
    public ExportSettings(
        string outputDirectory,
        int textureResolution,
        int heightResolution,
        float boundsPadding,
        int heightRowsPerFrame,
        int cameraCullingMask
    )
    {
        OutputDirectory = outputDirectory;
        TextureResolution = textureResolution;
        HeightResolution = heightResolution;
        BoundsPadding = boundsPadding;
        HeightRowsPerFrame = heightRowsPerFrame;
        CameraCullingMask = cameraCullingMask;
    }

    public string OutputDirectory { get; }
    public int TextureResolution { get; }
    public int HeightResolution { get; }
    public float BoundsPadding { get; }
    public int HeightRowsPerFrame { get; }
    public int CameraCullingMask { get; }
}

[Serializable]
internal sealed class MapPackManifest
{
    public int schemaVersion = 1;
    public int identityVersion = MapPackIdentity.Version;
    public string mapPackId = string.Empty;
    public string generatedAtUtc = string.Empty;
    public string gameVersion = string.Empty;
    public int gameBuildId;
    public string sceneName = string.Empty;
    public int mapSlot;
    public int projectionVersion = 1;
    public string coordinateSpace = "unity-world-meters";
    public string textureUv = "u=(x-minX)/(maxX-minX);v=(z-minZ)/(maxZ-minZ)";
    public string imageOrigin = "bottom-left-in-uv;viewer-flips-for-top-left-images";
    public LayerManifest[] layers = Array.Empty<LayerManifest>();
}

[Serializable]
internal sealed class LayerManifest
{
    public string id = string.Empty;
    public string name = string.Empty;
    public int segment;
    public string biome = string.Empty;
    public string texture = string.Empty;
    public string textureSha256 = string.Empty;
    public string height = string.Empty;
    public string heightSha256 = string.Empty;
    public int columns;
    public int rows;
    public float minX;
    public float maxX;
    public float minY;
    public float maxY;
    public float minZ;
    public float maxZ;
    public string heightEncoding = "float32-le-row-major-minz-minx";
    public string noData = "NaN";
    public string sampleLocation = "cell-centers";
    public int validHeightSamples;
}
