using System;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace PeakTrail.MapExporter;

internal static class MapPackIdentity
{
    public const int Version = 2;

    public static string ComputeId(MapPackManifest manifest)
    {
        var canonical = new StringBuilder(4096);
        canonical.Append("peaktrail-map-pack-identity-v2\n");
        AppendInteger(canonical, "identityVersion", manifest.identityVersion);
        AppendInteger(canonical, "schemaVersion", manifest.schemaVersion);
        AppendInteger(canonical, "projectionVersion", manifest.projectionVersion);
        AppendString(canonical, "coordinateSpace", manifest.coordinateSpace);
        AppendString(canonical, "textureUv", manifest.textureUv);
        AppendString(canonical, "imageOrigin", manifest.imageOrigin);
        AppendString(canonical, "gameVersion", manifest.gameVersion);
        AppendInteger(canonical, "gameBuildId", manifest.gameBuildId);
        AppendString(canonical, "sceneName", manifest.sceneName);
        AppendInteger(canonical, "mapSlot", manifest.mapSlot);

        LayerManifest[] layers = manifest.layers.OrderBy(layer => layer.segment).ToArray();
        AppendInteger(canonical, "layerCount", layers.Length);
        for (int index = 0; index < layers.Length; index++)
        {
            LayerManifest layer = layers[index];
            string prefix = $"layer.{index}";
            AppendString(canonical, prefix + ".id", layer.id);
            AppendInteger(canonical, prefix + ".segment", layer.segment);
            AppendString(canonical, prefix + ".biome", layer.biome);
            AppendString(canonical, prefix + ".texture", layer.texture);
            AppendHash(canonical, prefix + ".textureSha256", layer.textureSha256);
            AppendString(canonical, prefix + ".height", layer.height);
            AppendFloat32(canonical, prefix + ".minX", layer.minX);
            AppendFloat32(canonical, prefix + ".maxX", layer.maxX);
            AppendFloat32(canonical, prefix + ".minY", layer.minY);
            AppendFloat32(canonical, prefix + ".maxY", layer.maxY);
            AppendFloat32(canonical, prefix + ".minZ", layer.minZ);
            AppendFloat32(canonical, prefix + ".maxZ", layer.maxZ);
            AppendInteger(canonical, prefix + ".columns", layer.columns);
            AppendInteger(canonical, prefix + ".rows", layer.rows);
            AppendString(canonical, prefix + ".heightEncoding", layer.heightEncoding);
            AppendString(canonical, prefix + ".noData", layer.noData);
            AppendString(canonical, prefix + ".sampleLocation", layer.sampleLocation);
            AppendHash(canonical, prefix + ".heightSha256", layer.heightSha256);
        }

        byte[] bytes = Encoding.UTF8.GetBytes(canonical.ToString());
        using SHA256 sha = SHA256.Create();
        return "sha256-" + ToHex(sha.ComputeHash(bytes));
    }

    private static void AppendInteger(StringBuilder builder, string key, int value)
    {
        builder.Append(key).Append('=').Append(value.ToString(CultureInfo.InvariantCulture)).Append('\n');
    }

    private static void AppendString(StringBuilder builder, string key, string value)
    {
        builder.Append(key).Append('=');
        builder.Append(Encoding.UTF8.GetByteCount(value).ToString(CultureInfo.InvariantCulture));
        builder.Append(':').Append(value).Append('\n');
    }

    private static void AppendFloat32(StringBuilder builder, string key, float value)
    {
        int signedBits = BitConverter.ToInt32(BitConverter.GetBytes(value), 0);
        uint bits = unchecked((uint)signedBits);
        builder.Append(key).Append("=f32:");
        builder.Append(bits.ToString("x8", CultureInfo.InvariantCulture)).Append('\n');
    }

    private static void AppendHash(StringBuilder builder, string key, string value)
    {
        builder.Append(key).Append('=').Append(value.ToLowerInvariant()).Append('\n');
    }

    private static string ToHex(byte[] bytes)
    {
        var result = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes)
        {
            result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
        }
        return result.ToString();
    }
}
