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

Assert(AppearanceFormEvidence.Resolve(2500, false, false, false, false, false) == "normal", "A fully observed ordinary renderer state is normal.");
Assert(AppearanceFormEvidence.Resolve(1999, true, true, false, false, false) == "unknown", "Spawn defaults must remain unknown before the grace period.");
Assert(AppearanceFormEvidence.Resolve(2500, null, false, false, false, false) == "unknown", "Missing CharacterData is not a normal form.");
Assert(AppearanceFormEvidence.Resolve(2500, false, null, false, false, false) == "unknown", "Missing visual refs must not prove a normal form.");
Assert(AppearanceFormEvidence.Resolve(2500, true, true, false, false, false) == "skeleton", "RPC-synchronized isSkeleton proves the form without cosmetics.");
Assert(AppearanceFormEvidence.Resolve(2500, true, null, false, null, null) == "skeleton", "Positive skeleton state remains observable while renderer refs are unavailable.");
Assert(AppearanceFormEvidence.Resolve(2500, false, true, false, false, false) == "unknown", "An unknown active replacement mesh is not the ordinary player.");
Assert(AppearanceFormEvidence.Resolve(2500, false, true, true, false, false) == "mushroom", "Mushroom form requires the actual active replacement mesh.");
Assert(AppearanceFormEvidence.Resolve(2500, false, false, true, false, false) == "normal", "An inactive leftover mushroom mesh must not persist after changing back.");
Assert(AppearanceFormEvidence.Resolve(2500, true, true, true, false, false) == "mushroom", "A visible mushroom replacement takes precedence over a stale skeleton flag.");
Assert(AppearanceFormEvidence.Resolve(2500, false, false, false, true, true) == "chicken", "Chicken requires both actual activated renderer and customization state.");
Assert(AppearanceFormEvidence.Resolve(2500, false, false, false, true, false) == "unknown", "A cross-fading chicken/human transition is not confirmed normal.");
Assert(AppearanceFormEvidence.Resolve(2500, false, false, false, false, true) == "unknown", "A hidden chicken flag without its visual must remain unknown.");

var partial = new AppearanceTelemetry { FormReady = true, Form = "skeleton", FormAuthority = "replicated-character-data-and-renderers",
    FormMeshName = "qa-skeleton-third-person", FormMaterialNames = new[] { "qa-skeleton-material" }, FormRendererActive = true };
var partialJson = JObject.FromObject(partial);
Assert(!partial.Ready && partial.FormReady, "Runtime form must not depend on outfit/Steam-data readiness.");
Assert(partialJson["skinIndex"]?.Type == JTokenType.Null && partialJson["hatIndex"]?.Type == JTokenType.Null,
    "Unknown cosmetics must stay null, never the all-zero starter outfit.");
Assert(partialJson["skinColor"]?.Type == JTokenType.Null, "Unknown skin has no fabricated RGBA.");
Assert((string?)partialJson["form"] == "skeleton" && partialJson["formMaterialNames"] is JArray { Count: 1 },
    "Form and original material evidence must serialize as part of appearance.");
string skeletonFingerprint = partial.Fingerprint();
partial.Form = "normal";
Assert(skeletonFingerprint != partial.Fingerprint(), "Changing back must emit a new appearance even while the character stands still.");
partial.FormReady = false;
partial.Form = "unknown";
Assert(JsonConvert.DeserializeObject<AppearanceTelemetry>(partial.Fingerprint())?.Form == "unknown",
    "Lost observation must explicitly clear a previous transformed form, not retain the skull.");
Console.WriteLine("PeakTrail appearance contract passed.");
