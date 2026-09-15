using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

object current = new();
object oldRoom = new();
Assert(!AppearanceReadiness.IsReady(false, true, current, null, 2500), "Default remote customization must stay unknown before its reliable packet.");
Assert(!AppearanceReadiness.IsReady(false, true, current, oldRoom, 2500), "An actor number reused in a new room must not inherit old readiness.");
Assert(AppearanceReadiness.IsReady(false, false, current, current, 2500), "The synchronized remote snapshot must be accepted without relying on local Steam stats.");
Assert(!AppearanceReadiness.IsReady(false, true, current, current, 1999), "Spawn grace period must prevent transient initial appearance.");
Assert(!AppearanceReadiness.IsReady(true, false, current, current, 2500), "Local player appearance must wait for Steam cosmetics to load.");
Assert(AppearanceReadiness.IsReady(true, true, current, null, 2500), "Local owner appearance does not need a remote packet.");
Assert(!AppearanceReadiness.IsReady(true, true, null, null, 2500), "Missing data must never produce a default outfit.");

var appearance = new AppearanceTelemetry
{
    Ready = true, SkinIndex = 4, EyesIndex = 5, MouthIndex = 12, AccessoryIndex = 5,
    OutfitIndex = 21, HatIndex = 18, EffectiveHatIndex = 18, SashIndex = 9, MedalIndex = 1,
    SkinColor = new[] { 0.1f, 0.2f, 0.3f, 1f }, OutfitName = "Fit_Test", HatName = "Hat_Test",
};
var record = JObject.FromObject(new { type = "appearance", t = 2300, playerId = "stable-id", appearance });
Assert((int?)record["appearance"]?["outfitIndex"] == 21, "Outfit index must remain JSON numeric and retain game array order.");
Assert((int?)record["appearance"]?["effectiveHatIndex"] == 18, "Effective hat override must survive serialization.");
Assert(record["appearance"]?["skinColor"] is JArray { Count: 4 }, "Skin color is the exact RGBA array.");
string before = appearance.Fingerprint();
appearance.OutfitIndex = 22;
Assert(before != appearance.Fingerprint(), "An outfit change must emit a new appearance snapshot.");
var roundTrip = JsonConvert.DeserializeObject<AppearanceTelemetry>(appearance.Fingerprint());
Assert(roundTrip?.OutfitIndex == 22 && roundTrip.HatIndex == 18, "The appearance contract must round-trip.");
Console.WriteLine("PeakTrail appearance contract passed.");
