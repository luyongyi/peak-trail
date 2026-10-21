using Mono.Cecil;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;
using Photon.Pun;
using UnityEngine;

internal static class AppearanceStateContract
{
    public static void Run(string[] args)
    {
        int checks = 0;
        void Check(bool value, string why) { checks++; if (!value) throw new InvalidOperationException(why); }
        var fixture = new JArray();
        var payload = new LivePayload();
        fixture.Add(payload.Record(new() { ["type"] = "participant", ["t"] = 0, ["playerId"] = "synthetic-private-owner", ["nickname"] = "Synthetic scout" }) ?? throw new InvalidOperationException("Participant projection was rejected."));
        void Capture(long t, AppearanceTelemetry appearance, int stage = 0)
            => fixture.Add(payload.Record(new() { ["type"] = "appearance", ["t"] = t, ["activeSegment"] = stage, ["playerId"] = "synthetic-private-owner", ["appearance"] = appearance }) ?? throw new InvalidOperationException("Appearance projection was rejected."));
        var c = new Character();
        AppearanceTelemetry Read(long age = 2500) => AppearanceFormReader.Read(c, age);
        var initial = Read();
        Check(initial.Form == "normal" && initial.GhostReady && initial.GhostActive == false, "Observed absence is inactive, not ghost-by-default.");
        Check(initial.PetrificationReady && initial.PetrificationActive == false && initial.BlindnessReady && initial.BlindnessActive == false, "Available inactive renderers explicitly clear state.");
        Capture(100, initial);
        c.data!.dead = true; c.data.petrifyAmount = 100;
        var noInferred = Read();
        Check(noInferred.Form != "ghost" && noInferred.GhostActive == false, "Death cannot prove an actual ghost instance.");
        Check(noInferred.PetrificationActive == false && noInferred.BlindnessActive == false, "Status values cannot activate a visual layer.");
        c.Ghost = new PlayerGhost { m_owner = new Character() };
        Check(!Read().GhostReady && Read().GhostActive == null, "A different owner's ghost must remain unknown.");
        c.Ghost = new PlayerGhost { m_owner = c, transform = new() { position = new(40, 50, 60), rotation = new(0, .6f, 0, .8f) } };
        c.Ghost.PlayerRenderers![0].enabled = false;
        var originalRefs = c.refs; c.refs = null;
        var ghost = Read(1);
        Check(ghost.Form == "ghost" && ghost.FormReady && ghost.GhostReady && ghost.GhostActive == true, "Owned ghost must survive missing body refs and spawn grace period.");
        Check(ghost.GhostVisible == false && ghost.FormRendererActive == false, "Local render suppression is not entity absence.");
        Check(ghost.GhostPosition!.SequenceEqual(new[] { 40f, 50f, 60f }) && ghost.GhostRotation!.SequenceEqual(new[] { 0f, .6f, 0f, .8f }), "Ghost pose must use the actual ghost transform.");
        Check(c.Center.x == 1 && c.Center.y == 2 && c.Center.z == 3 && c.data.dead, "Visual reading must never move or revive the route character.");
        Check(!ghost.PetrificationReady && ghost.PetrificationActive == null && !ghost.BlindnessReady && ghost.BlindnessActive == null, "Unknown independent state is nullable, not fabricated inactive.");
        Capture(200, ghost);
        string fingerprint = ghost.Fingerprint();
        c.Ghost.transform.position = new(41, 52, 63);
        var moved = Read(1);
        Check(moved.Fingerprint() != fingerprint, "Ghost movement must change the appearance fingerprint.");
        Capture(250, moved, 1);
        c.Ghost.transform.position = new(float.NaN, 1, 2); c.Ghost.transform.rotation = new(0, 0, 0, 2);
        var invalidPose = Read();
        Check(invalidPose.GhostActive == true && invalidPose.GhostPosition == null && invalidPose.GhostRotation == null, "Invalid transform must be omitted without fabricating a position.");
        c.Ghost.Destroyed = true; c.refs = originalRefs; c.data.dead = false;
        var revived = Read();
        Check(revived.Form == "normal" && revived.GhostReady && revived.GhostActive == false && revived.GhostPosition == null, "Destroyed ghost must clear after revive, including stale Unity references.");
        Capture(300, revived, 1);
        c.Ghost = null;
        var visuals = c.refs!.customization!.refs!;
        foreach (Renderer r in visuals.stoneRenderers!) r.gameObject.activeSelf = true;
        c.data.shouldPetrify = true; c.data.passOutValue = .5f;
        visuals.blindRenderer!.gameObject.activeSelf = true;
        var active = Read();
        Check(active.PetrificationReady && active.PetrificationActive == true && active.PetrificationTriggered == true, "Stone activity must use real enabled layer objects and retain native trigger.");
        Check(active.PetrificationProgress == .5f && active.PetrificationAmount == .625f, "Capture actual shared shader amount, not the status/progress fraction.");
        Check(active.BlindnessReady && active.BlindnessActive == true, "Native Blind Card must be independently captured.");
        Check(!visuals.blindRenderer.gameObject.activeInHierarchy && active.BlindnessActive == true, "A hidden camera parent must not clear a native enabled state layer.");
        Capture(400, active, 1);
        foreach (Renderer r in visuals.stoneRenderers!) r.sharedMaterials[0].Floats["_Petrify"] = 1.25f;
        Check(Read().PetrificationAmount == 1.25f, "Native shader amount must not be clamped to a presumed percentage.");
        visuals.stoneRenderers![1].sharedMaterials[0].Floats["_Petrify"] = .75f;
        Check(Read().PetrificationActive == true && Read().PetrificationAmount == null, "Different native material amounts cannot become a fabricated unified amount.");
        visuals.stoneRenderers[0].sharedMaterials[0].Floats["_Petrify"] = float.PositiveInfinity;
        Check(Read().PetrificationAmount == null, "Non-finite material data must never enter JSON.");
        visuals.stoneRenderers[0].sharedMaterials[0].ThrowOnRead = true;
        c.Ghost = new PlayerGhost { m_owner = c };
        Check(Read().GhostActive == true && Read().Form == "ghost" && !Read().PetrificationReady, "Failure of one visual must not erase independently proven ghost state.");
        c.Ghost = null;
        foreach (Renderer r in visuals.stoneRenderers!) r.gameObject.activeSelf = false;
        visuals.blindRenderer.enabled = false; c.data.shouldPetrify = false; c.data.passOutValue = 0;
        var cleared = Read();
        Check(cleared.PetrificationActive == false && cleared.PetrificationAmount == null && cleared.BlindnessActive == false, "Disabled renderers explicitly clear older active amounts and overlays.");
        Check(cleared.Fingerprint() != active.Fingerprint(), "Native clears must be observable without movement.");
        Capture(500, cleared, 1);
        visuals.stoneRenderers = null; visuals.blindRenderer = null;
        var unknown = Read();
        Check(!unknown.PetrificationReady && unknown.PetrificationActive == null && !unknown.BlindnessReady && unknown.BlindnessActive == null, "Destroyed/missing refs must replace state with unknown.");
        Capture(600, unknown, 1);
        c.Ghost = new PlayerGhost { m_owner = c }; PhotonNetwork.InRoom = false;
        var disconnected = Read();
        Check(!disconnected.GhostReady && disconnected.GhostActive == null && disconnected.Form != "ghost", "Disconnect must not preserve ghost evidence.");
        Capture(700, new AppearanceTelemetry(), 1);
        PhotonNetwork.InRoom = true; c.photonView.Owner!.IsInactive = true;
        Check(!Read().GhostReady, "Inactive Photon owner cannot supply visual evidence.");
        c.photonView.Owner.IsInactive = false; c.Ghost.m_owner = null;
        Check(!Read().GhostReady, "An uninitialized ghost does not establish ownership.");
        string json = fixture.ToString(Formatting.None);
        Check(!json.Contains("synthetic-private-owner") && json.Contains("\"playerId\":\"p1\""), "New appearance fields must retain session anonymity.");
        var projectedGhost = (JObject)fixture[2]!["appearance"]!;
        Check((bool?)projectedGhost["ghostActive"] == true && projectedGhost["ghostPosition"] is JArray { Count: 3 }
            && projectedGhost["ghostRotation"] is JArray { Count: 4 }, "Live allowlist discarded ghost evidence.");
        var projectedActive = (JObject)fixture[5]!["appearance"]!;
        Check((bool?)projectedActive["blindnessActive"] == true && (float?)projectedActive["petrificationAmount"] == .625f, "Live allowlist discarded state evidence.");
        Check(fixture.All(item => (string?)item!["type"] != "sample") && (int?)fixture[3]!["activeSegment"] == 1, "Ghost evidence must be separate from route points and retain the live stage.");
        var buffer = new LiveRecordBuffer(); buffer.Add((JObject)fixture[2]!); buffer.Add((JObject)fixture[fixture.Count - 1]!); buffer.ReplaySnapshot(false);
        var latest = buffer.Take(256, 256 * 1024).Single();
        Check((bool?)latest["appearance"]?["ghostReady"] == false && latest["appearance"]?["ghostPosition"] == null, "Reconnect snapshot resurrected a cleared ghost.");
        int managedArg = Array.IndexOf(args, "--managed");
        if (managedArg >= 0) VerifyNative(args[managedArg + 1], Check);
        int fixtureArg = Array.IndexOf(args, "--fixture");
        if (fixtureArg >= 0)
        {
            var output = new JObject { ["manifest"] = LivePayload.Manifest(new TraceManifest { GameBuildId = "25739797", RecorderVersion = "0.8.5" }), ["records"] = fixture };
            string path = Path.GetFullPath(args[fixtureArg + 1]); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, output.ToString(Formatting.Indented));
        }
        Console.WriteLine($"Appearance state contract passed: {checks} checks; actual ghost ownership/pose, nullable readiness, state layers, clear/revive/disconnect, no material instancing, anonymity and reconnect snapshots.");
    }

    private static void VerifyNative(string managed, Action<bool, string> check)
    {
        using var assembly = AssemblyDefinition.ReadAssembly(Path.Combine(managed, "Assembly-CSharp.dll"));
        var types = assembly.MainModule.Types.ToDictionary(type => type.FullName);
        TypeDefinition Type(string name) => types[name];
        void Field(string type, string name, string fieldType) => check(Type(type).Fields.Any(field => field.Name == name && field.FieldType.FullName == fieldType), $"Native field changed: {type}.{name}");
        string[] Calls(string type, string method) => Type(type).Methods.Single(value => value.Name == method).Body.Instructions.Select(value => value.Operand?.ToString() ?? "").ToArray();
        Field("PlayerGhost", "m_owner", "Character"); Field("PlayerGhost", "PlayerRenderers", "UnityEngine.Renderer[]");
        check(Type("Character").Properties.Any(property => property.Name == "Ghost" && property.PropertyType.FullName == "PlayerGhost"), "Character.Ghost binding changed.");
        check(Calls("PlayerGhost", "RPCA_InitGhost").Any(value => value.Contains("Character::set_Ghost")) && Calls("PlayerGhost", "RPCA_InitGhost").Any(value => value.Contains("PlayerGhost::m_owner")), "Native ghost initialization no longer establishes reciprocal owner binding.");
        check(Calls("MainCameraMovement", "StopSpectating").Any(value => value.Contains("Photon.Pun.PhotonNetwork::Destroy")), "Native spectate exit no longer destroys ghost.");
        Field("CharacterData", "passOutValue", "System.Single");
        check(Type("CharacterData").Properties.Any(property => property.Name == "shouldPetrify" && property.PropertyType.FullName == "System.Boolean"), "Native petrify trigger changed.");
        Field("CustomizationRefs", "stoneRenderers", "UnityEngine.Renderer[]"); Field("CustomizationRefs", "blindRenderer", "UnityEngine.Renderer");
        check(Calls("CharacterCustomization", "SetPetrifyAmount").Contains("_Petrify") && Calls("CharacterCustomization", "SetPetrifyAmount").Any(value => value.Contains("UnityEngine.Material::SetFloat")), "Native petrification shader boundary changed.");
        foreach (string method in new[] { "OnApplied", "OnRemoved" }) check(Calls("Peak.Afflictions.Affliction_Blind", method).Any(value => value.Contains("CustomizationRefs::blindRenderer")) && Calls("Peak.Afflictions.Affliction_Blind", method).Any(value => value.Contains("UnityEngine.GameObject::SetActive")), "Native Blind Card activation boundary changed.");
        Console.WriteLine("Appearance native boundary signatures/owner bindings verified; MVID=" + assembly.MainModule.Mvid);
    }
}
