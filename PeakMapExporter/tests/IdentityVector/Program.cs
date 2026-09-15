using System.Text.Json;
using PeakTrail.MapExporter;

if (args.Length != 1)
{
    Console.Error.WriteLine("Usage: IdentityVector <map-pack-identity-v2.json>");
    return 2;
}

string json = File.ReadAllText(args[0]);
using JsonDocument document = JsonDocument.Parse(json);
string expected = document.RootElement.GetProperty("expectedMapPackId").GetString()
    ?? throw new InvalidDataException("The vector lacks expectedMapPackId.");
var options = new JsonSerializerOptions { IncludeFields = true };
MapPackManifest manifest = JsonSerializer.Deserialize<MapPackManifest>(json, options)
    ?? throw new InvalidDataException("The vector could not be parsed.");
string actual = MapPackIdentity.ComputeId(manifest);
if (!string.Equals(actual, expected, StringComparison.Ordinal))
{
    Console.Error.WriteLine($"C# identity mismatch. Expected {expected}; actual {actual}.");
    return 1;
}

Console.WriteLine($"C# identity vector passed: {actual}");
return 0;
