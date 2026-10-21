using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using Newtonsoft.Json.Linq;
using Photon.Pun;
using UnityEngine;

namespace PeakTrailRecorder;

// Only two observations: a native use and a confirmed final spawn. No simulation,
// nearest-player attribution, transform polling or object-lifecycle tracking.
internal sealed class NativeItemEvents
{
    internal sealed class Actor { public int? Id; public string? LiveId; }
    internal sealed class Use
    {
        public string ActionId = "";
        public JObject Item = new();
        public Actor Actor = new();
        public int Frame, NativeActor;
    }
    internal sealed class Observation
    {
        public string Id = "", ActionId = "", Kind = "";
        public JObject Item = new();
        public Actor Actor = new();
        public Vector3 Position;
    }
    internal sealed class Scope
    {
        public Scope? Previous;
        public Use? Use;
        public bool Projectile;
        public string? ExpectedPrefab;
    }
    private readonly ItemEventIdentity _identity;
    private readonly Func<Character?, Actor> _actor;
    private readonly Action<Observation> _emit;
    private readonly Dictionary<int, Use> _uses = new();
    private readonly Dictionary<int, Use> _spawnSources = new();
    private readonly Dictionary<string, JObject> _deployed = new(StringComparer.Ordinal);
    private readonly HashSet<string> _rpcSpawns = new(StringComparer.Ordinal);
    private Scope? _scope;
    private int _count;
    private bool _catalogRead;
    public NativeItemEvents(string recordingId, Func<Character?, Actor> actor, Action<Observation> emit)
    { _identity = new ItemEventIdentity(recordingId); _actor = actor; _emit = emit; }

    public Use? StartUse(Item? item, Character? actor = null, bool fresh = false)
    {
        if (!item) return null;
        int key = item!.GetInstanceID();
        actor = actor ? actor : item.trueHolderCharacter;
        if (!actor) return _uses.TryGetValue(key, out var previous) ? previous : null;
        if (!fresh && _uses.TryGetValue(key, out var old) && old.Frame == Time.frameCount && old.NativeActor == actor!.GetInstanceID()) return old;
        var value = new Use { ActionId = _identity.Action(), Item = Metadata(item), Actor = _actor(actor), Frame = Time.frameCount, NativeActor = actor!.GetInstanceID() };
        _uses[key] = value;
        Emit(value, "item-use", "use", actor!.Center, value.Item);
        return value;
    }
    public void Thrown(Item item, Character? actor)
    {
        if (!item) return;
        // RPC_SetThrownData leaves lastThrownCharacter unchanged when its new
        // view ID cannot resolve. Never inherit that stale owner or use context.
        if (!actor) { _uses.Remove(item.GetInstanceID()); _spawnSources.Remove(item.gameObject.GetInstanceID()); return; }
        StartUse(item, actor);
    }
    public Use? Existing(Item? item) => item && _uses.TryGetValue(item!.GetInstanceID(), out var use) ? use : null;
    public Scope Push(Use? use, string? prefab = null, bool projectile = false)
    {
        var scope = new Scope { Previous = _scope, Use = use, ExpectedPrefab = prefab == null ? null : Clean(prefab), Projectile = projectile };
        _scope = scope; return scope;
    }
    public void Pop(Scope? scope) { if (scope != null) _scope = scope.Previous; }
    public void NetworkSpawn(GameObject? instance)
    {
        if (!instance) return;
        string prefab = Clean(instance!.name);
        var scope = _scope;
        if (scope != null && (scope.ExpectedPrefab == null || prefab == scope.ExpectedPrefab))
        {
            if (scope.Use != null) _spawnSources[instance.GetInstanceID()] = scope.Use;
            // Shooter instantiation is at the muzzle; rope anchors are committed
            // only by the completed attachment/SpawnRope callback below.
            if (scope.Projectile || instance.GetComponent<RopeAnchor>()) return;
            Spawn(instance, instance.transform.position, scope.Use);
            return;
        }
        Catalog();
        if (!instance.GetComponent<RopeAnchorProjectile>() && !instance.GetComponent<RopeAnchor>() && _deployed.ContainsKey(prefab))
            Spawn(instance, instance.transform.position, null);
    }
    public Use? Source(GameObject? instance) => instance && _spawnSources.TryGetValue(instance!.GetInstanceID(), out var use) ? use : null;
    public void Spawn(GameObject instance, Vector3 position, Use? use)
    {
        string key = NativeKey(instance);
        if (!_identity.FirstSpawn(key)) return;
        use ??= Source(instance);
        var item = SpawnMetadata(instance.name, use, instance.GetComponent<Item>());
        Emit(use, "item-spawn", key, position, item);
    }
    public void Placement(Component source, GameObject prefab, Vector3 position, Use? use)
    {
        // This native RPC calls Object.Instantiate rather than Photon instantiate.
        // Its successful return confirms exactly the supplied final placement.
        string key = "placement:" + NativeKey(source.gameObject);
        if (!_rpcSpawns.Add(key)) return;
        Emit(use, "item-spawn", key, position, SpawnMetadata(prefab.name, use, prefab.GetComponent<Item>()));
    }
    public void Anchor(PhotonView? view, Use? use)
    {
        if (!view) return;
        var anchor = view!.GetComponent<RopeAnchor>();
        if (anchor && anchor!.anchorPoint) Spawn(view.gameObject, anchor.anchorPoint.position, use ?? Source(view.gameObject));
    }
    private void Emit(Use? use, string kind, string nativeKey, Vector3 position, JObject item)
    {
        if (!Finite(position) || item["itemId"] == null && item["prefabName"] == null) return;
        if (_count >= 4096) { if (_count++ == 4096) Plugin.Log.LogWarning("Item event archive limit reached; existing events are retained."); return; }
        _count++;
        string action = use?.ActionId ?? "";
        _emit(new Observation { Id = _identity.Event(action, kind, nativeKey), ActionId = action, Kind = kind,
            Item = (JObject)item.DeepClone(), Actor = use?.Actor ?? new Actor(), Position = position });
    }
    private JObject SpawnMetadata(string prefab, Use? use, Item? actual)
    {
        Catalog();
        string name = Clean(prefab);
        JObject value = use != null ? (JObject)use.Item.DeepClone() : _deployed.TryGetValue(name, out var mapped)
            ? (JObject)mapped.DeepClone() : actual ? Metadata(actual!) : new JObject();
        value["prefabName"] = name;
        return value;
    }
    private void Catalog()
    {
        if (_catalogRead) return;
        var database = Zorro.Core.SingletonAsset<ItemDatabase>.Instance;
        if (database?.itemLookup == null) return;
        _catalogRead = true;
        foreach (var item in database.itemLookup.Values)
        {
            if (!item) continue;
            void Add(GameObject? prefab) { if (prefab) _deployed[Clean(prefab!.name)] = Metadata(item); }
            Add(item.GetComponent<ShelfShroom>()?.instantiateOnBreak);
            Add(item.GetComponent<CloudFungus>()?.instantiateOnBreak);
            Add(item.GetComponent<ClimbingSpikeComponent>()?.hammeredVersionPrefab);
            Add(item.GetComponent<Constructable>()?.constructedPrefab);
            Add(item.GetComponent<RopeTier>()?.anchorPrefab);
            Add(item.GetComponent<RopeShooter>()?.ropeAnchorWithRopePref);
        }
    }
    private static JObject Metadata(Item item) => new() { ["itemId"] = (int)item.itemID, ["name"] = Clean(item.name), ["prefabName"] = Clean(item.gameObject.name) };
    private static string Clean(string value) => new(value.Replace("(Clone)", "").Trim().Where(c => c >= 32 && c != 127).Take(100).ToArray());
    private static bool Finite(Vector3 value) => !float.IsNaN(value.x) && !float.IsInfinity(value.x) && Math.Abs(value.x) <= 1_000_000
        && !float.IsNaN(value.y) && !float.IsInfinity(value.y) && Math.Abs(value.y) <= 1_000_000
        && !float.IsNaN(value.z) && !float.IsInfinity(value.z) && Math.Abs(value.z) <= 1_000_000;
    private static string NativeKey(GameObject instance) => instance.GetInstanceID() + ":" + (instance.GetComponent<PhotonView>()?.ViewID ?? 0);
}

// Prefixes only capture source context; postfixes observe completed native calls.
// Finalizers restore nested context even if a game callback throws, preserving the
// original exception and never changing gameplay arguments or return values.
internal static class NativeItemHooks
{
    internal static NativeItemEvents? Active;
    private static Harmony? _harmony;
    private static readonly FieldInfo? SpikeSlot = AccessTools.Field(typeof(CharacterItems), "currentClimbingSpikeItemSlot");
    private static readonly FieldInfo? SpikeComponent = AccessTools.Field(typeof(CharacterItems), "currentClimbingSpikeComponent");
    private static readonly FieldInfo? ItemsCharacter = AccessTools.Field(typeof(CharacterItems), "character");
    private static readonly FieldInfo? RopeSpoolField = AccessTools.Field(typeof(Rope), "spool");
    public static void Install(Action<string> warning)
    {
        _harmony = new Harmony("PeakTrailRecorder.item-events");
        Patch(typeof(Item), "FinishCastPrimary", nameof(BeforeUse));
        Patch(typeof(Item), "FinishCastSecondary", nameof(BeforeUse));
        Patch(typeof(Item), "Consume", nameof(BeforeConsume));
        Patch(typeof(Item), "RPC_SetThrownData", null, nameof(AfterThrow));
        Patch(typeof(CharacterItems), "HammerClimbingSpike", nameof(BeforeSpike), null, true);
        Patch(typeof(Constructable), "FinishConstruction", nameof(BeforeConstruction), null, true);
        Patch(typeof(Constructable), "CreatePrefabRPC", nameof(BeforeConstruction), nameof(AfterPlacement), true);
        Patch(typeof(ShelfShroom), "Break", nameof(BeforeShelf), null, true);
        Patch(typeof(CloudFungus), "Break", nameof(BeforeCloud), null, true);
        Patch(typeof(RopeTier), "SpawnRope", nameof(BeforeRopeTier), null, true);
        Patch(typeof(RopeShooter), "OnPrimaryFinishedCast", nameof(BeforeRopeShooter), null, true);
        Patch(typeof(Rope), "AttachToAnchor_Rpc", nameof(BeforeAttach), nameof(AfterAttach), true);
        Patch(typeof(RopeAnchorWithRope), "SpawnRope", null, nameof(AfterRope));
        // This also observes remote native instantiations whose actor was not witnessed.
        foreach (var method in AccessTools.GetDeclaredMethods(typeof(PhotonNetwork)).Where(m => m.Name == "NetworkInstantiate" && m.ReturnType == typeof(GameObject)))
            try { _harmony!.Patch(method, postfix: new HarmonyMethod(typeof(NativeItemHooks), nameof(AfterNetworkSpawn))); }
            catch (Exception e) { warning("Item network observation unavailable (" + e.GetType().Name + ")."); }
        void Patch(Type type, string name, string? prefix = null, string? postfix = null, bool scope = false)
        {
            try
            {
                var method = AccessTools.Method(type, name) ?? throw new MissingMethodException(type.Name, name);
                _harmony!.Patch(method, prefix == null ? null : new HarmonyMethod(typeof(NativeItemHooks), prefix),
                    postfix == null ? null : new HarmonyMethod(typeof(NativeItemHooks), postfix),
                    finalizer: scope ? new HarmonyMethod(typeof(NativeItemHooks), nameof(AfterScope)) : null);
            }
            catch (Exception e) { warning("Item native observation unavailable: " + type.Name + "." + name + " (" + e.GetType().Name + ")."); }
        }
    }
    public static void Uninstall() { Active = null; _harmony?.UnpatchSelf(); _harmony = null; }
    private static void Safe(Action action) { try { action(); } catch (Exception e) { Plugin.Log.LogWarning("Item observation skipped (" + e.GetType().Name + ")."); } }
    private static Item? ItemOf(Component component) => component.GetComponent<Item>();
    private static void BeforeUse(Item __instance) => Safe(() => Active?.StartUse(__instance));
    private static void BeforeConsume(Item __instance) => Safe(() => { if (Active?.Existing(__instance) == null) Active?.StartUse(__instance); });
    private static void AfterThrow(Item __instance, int characterID) => Safe(() =>
    {
        if (Active == null) return;
        var view = PhotonNetwork.GetPhotonView(characterID);
        Active.Thrown(__instance, view ? view!.GetComponent<Character>() : null);
    });
    private static void BeforeSpike(CharacterItems __instance, out NativeItemEvents.Scope? __state)
    {
        __state = null; if (Active == null) return;
        try
        {
            var slot = SpikeSlot?.GetValue(__instance) as ItemSlot;
            var spike = SpikeComponent?.GetValue(__instance) as ClimbingSpikeComponent;
            var actor = ItemsCharacter?.GetValue(__instance) as Character;
            if (slot?.prefab && spike) __state = Active.Push(Active.StartUse(slot!.prefab, actor, fresh: true), spike!.hammeredVersionPrefab.name);
        }
        catch (Exception e) { Plugin.Log.LogWarning("Spike observation skipped (" + e.GetType().Name + ")."); }
    }
    private static void BeforeConstruction(Constructable __instance, out NativeItemEvents.Scope? __state)
    {
        __state = null; if (Active == null) return;
        try { __state = Active.Push(Active.Existing(ItemOf(__instance)) ?? Active.StartUse(ItemOf(__instance)), __instance.constructedPrefab.name); }
        catch (Exception e) { Plugin.Log.LogWarning("Construction observation skipped (" + e.GetType().Name + ")."); }
    }
    private static void AfterPlacement(Constructable __instance, Vector3 position, NativeItemEvents.Scope? __state)
        => Safe(() => Active?.Placement(__instance, __instance.constructedPrefab, position, __state?.Use));
    private static void BeforeShelf(ShelfShroom __instance, out NativeItemEvents.Scope? __state)
    { __state = null; if (Active != null) SafeScope(() => Active.Push(Active.Existing(ItemOf(__instance)), __instance.instantiateOnBreak.name), out __state); }
    private static void BeforeCloud(CloudFungus __instance, out NativeItemEvents.Scope? __state)
    { __state = null; if (Active != null) SafeScope(() => Active.Push(Active.Existing(ItemOf(__instance)), __instance.instantiateOnBreak.name), out __state); }
    private static void BeforeRopeTier(RopeTier __instance, out NativeItemEvents.Scope? __state)
    { __state = null; if (Active != null) SafeScope(() => Active.Push(Active.StartUse(ItemOf(__instance)), __instance.anchorPrefab.name), out __state); }
    private static void BeforeRopeShooter(RopeShooter __instance, out NativeItemEvents.Scope? __state)
    { __state = null; if (Active != null) SafeScope(() => Active.Push(Active.Existing(ItemOf(__instance)) ?? Active.StartUse(ItemOf(__instance)), __instance.ropeAnchorWithRopePref.name, projectile: true), out __state); }
    private static void BeforeAttach(Rope __instance, PhotonView anchorView, out NativeItemEvents.Scope? __state)
    {
        __state = null; if (Active == null) return;
        SafeScope(() => { var spool = RopeSpoolField?.GetValue(__instance) as RopeSpool;
            return Active.Push(Active.Source(anchorView ? anchorView.gameObject : null) ?? (spool ? Active.Existing(ItemOf(spool!)) : null)); }, out __state);
    }
    private static void AfterAttach(PhotonView anchorView, NativeItemEvents.Scope? __state) => Safe(() => Active?.Anchor(anchorView, __state?.Use));
    private static void AfterRope(RopeAnchorWithRope __instance, Rope? __result)
        => Safe(() => { if (__result) Active?.Anchor(__instance.GetComponent<PhotonView>(), Active.Source(__instance.gameObject)); });
    private static void AfterNetworkSpawn(GameObject __result) => Safe(() => Active?.NetworkSpawn(__result));
    private static Exception? AfterScope(Exception? __exception, NativeItemEvents.Scope? __state)
    { Safe(() => Active?.Pop(__state)); return __exception; }
    private static void SafeScope(Func<NativeItemEvents.Scope> create, out NativeItemEvents.Scope? state)
    { state = null; try { state = create(); } catch (Exception e) { Plugin.Log.LogWarning("Item source observation skipped (" + e.GetType().Name + ")."); } }
}
