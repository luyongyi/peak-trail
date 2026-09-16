using System;
using System.Collections.Generic;
using System.Linq;
using BepInEx.Logging;
using HarmonyLib;
using Peak;
using Photon.Pun;
using UnityEngine;
using UnityEngine.SceneManagement;
using Zorro.Core;

namespace PeakTrailRecorder;

internal sealed class WorldTelemetryReader
{
    private readonly WorldTelemetryTracker _tracker = new();
    private readonly Action<object> _write;
    private readonly Func<long> _clock;
    private readonly ManualLogSource _log;
    private readonly Dictionary<string, int> _deployedPrefabs = new(StringComparer.Ordinal);
    private readonly HashSet<string> _observed = new(StringComparer.Ordinal);
    private readonly HashSet<string> _explodedMines = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _lastExplosionAt = new(StringComparer.Ordinal);
    private SpawnGameObject[] _spawners = Array.Empty<SpawnGameObject>();
    private MushroomZombie[] _zombies = Array.Empty<MushroomZombie>();
    private MushroomZombieSpawner[] _zombieSpawners = Array.Empty<MushroomZombieSpawner>();
    private StatusFieldBase[] _fields = Array.Empty<StatusFieldBase>();
    private StatusEmitter[] _emitters = Array.Empty<StatusEmitter>();
    private GloomSafeZone[] _safeZones = Array.Empty<GloomSafeZone>();
    private PhotonView[] _views = Array.Empty<PhotonView>();
    private long _nextDiscoveryAt;
    private long _nextSampleAt;
    private long _nextErrorLogAt;

    public WorldTelemetryReader(Action<object> write, Func<long> clock, ManualLogSource log)
    {
        _write = write;
        _clock = clock;
        _log = log;
    }

    public void Sample()
    {
        long now = _clock();
        if (now < _nextSampleAt) return;
        _nextSampleAt = now + 250;
        try
        {
            // A single shared discovery pass, never one scan per player. Inactive scene objects
            // are included so state transitions and pooled-object identities remain observable.
            if (now >= _nextDiscoveryAt)
            {
                _nextDiscoveryAt = now + 2_000;
                _spawners = Find<SpawnGameObject>();
                _zombies = Find<MushroomZombie>();
                _zombieSpawners = Find<MushroomZombieSpawner>();
                _fields = Find<StatusFieldBase>();
                _emitters = Find<StatusEmitter>();
                _safeZones = Find<GloomSafeZone>();
                _views = Find<PhotonView>();
                DiscoverDeployedPrefabs();
            }

            _observed.Clear();
            var objects = new List<WorldObjectTelemetry>();
            foreach (Item item in Item.ALL_ITEMS.ToArray())
            {
                if (!InScene(item)) continue;
                WorldObjectTelemetry value = Base(item, "item", "Item.ALL_ITEMS");
                value.ItemId = item.itemID;
                if (item.data != null && item.data.guid != Guid.Empty) value.ItemInstanceId = item.data.guid.ToString("D");
                if (item.lastThrownCharacter != null && item.lastThrownCharacter.photonView?.Owner != null)
                    value.LastThrownByPlayerId = IdentityResolver.FromPhotonPlayer(item.lastThrownCharacter.photonView.Owner).PlayerId;
                value.Activity = item.itemState.ToString().ToLowerInvariant();
                // Held/backpack instances stay in the lifecycle but must not appear as ground loot.
                value.Active = value.Active && item.itemState == ItemState.Ground;
                objects.Add(value);
            }
            foreach (PhotonView view in _views)
            {
                if (!InScene(view) || view.GetComponent<Item>() != null) continue;
                string name = PrefabName(view.gameObject.name);
                if (!_deployedPrefabs.TryGetValue(name, out int itemId)) continue;
                WorldObjectTelemetry value = Base(view, "placed_object", "PhotonView.deployed-item-prefab");
                value.ItemId = itemId;
                value.Activity = value.Active ? "placed" : "inactive";
                objects.Add(value);
            }
            foreach (SpawnGameObject spawner in _spawners)
            {
                if (!InScene(spawner) || !IsMine(spawner)) continue;
                objects.Add(ReadMine(spawner));
            }
            foreach (MushroomZombie zombie in _zombies)
            {
                if (!InScene(zombie)) continue;
                WorldObjectTelemetry value = Base(zombie, "zombie", "MushroomZombie.currentState");
                value.Activity = zombie.currentState.ToString().ToLowerInvariant();
                value.Active = value.Active && zombie.currentState != MushroomZombie.State.Dead;
                if (zombie.character != null) value.Position = Vec(zombie.character.Center);
                AddZombieRanges(value, zombie);
                if (zombie.currentTarget != null && zombie.currentTarget.photonView?.Owner != null)
                    value.TargetPlayerId = IdentityResolver.FromPhotonPlayer(zombie.currentTarget.photonView.Owner).PlayerId;
                objects.Add(value);
            }
            foreach (MushroomZombieSpawner spawner in _zombieSpawners)
            {
                if (!InScene(spawner) || spawner.mushroomZombiePrefab == null) continue;
                WorldObjectTelemetry value = Base(spawner, "zombie_spawn", "MushroomZombieSpawner.surviving-scene-instance");
                value.Activity = spawner.spawned ? "spawned" : "unspawned";
                value.Active = value.Active && !spawner.spawned;
                if (spawner.spawnedZombie != null)
                    value.RelatedObjectId = Id(spawner.spawnedZombie, "zombie");
                value.PrefabName = PrefabName(spawner.mushroomZombiePrefab.gameObject.name);
                AddZombieRanges(value, spawner.mushroomZombiePrefab);
                objects.Add(value);
            }
            foreach (StatusFieldBase field in _fields)
            {
                if (!InScene(field) || field.statusType != CharacterAfflictions.STATUSTYPE.Drowsy) continue;
                WorldObjectTelemetry value = Base(field, "sleep_fog", field.GetType().Name + ".Drowsy");
                value.StatusType = "Drowsy";
                value.StatusAmountPerSecond = field.statusAmountPerSecond;
                value.StatusDelaySeconds = field.delayBeforeStatusOverTime;
                value.StatusEnabled = value.Active;
                if (field is StatusFieldGloom gloom)
                {
                    value.SightDistance = Positive(gloom.InFogSightDistance);
                    value.StatusEnabled = value.Active && RunSettings.GetValue(RunSettings.SETTINGTYPE.Hazard_SleepyGloom) != 0;
                }
                value.Activity = value.Active ? "emitting" : "inactive";
                if (field is StatusFieldBounds bounds)
                {
                    value.Shape = "box";
                    value.Size = Vec(bounds.size);
                    value.Position = Vec(bounds.transform.position - Vector3.up * bounds.size.y / 2f);
                    value.Rotation = new[] { 0f, 0f, 0f, 1f }; // game checks a world-axis Bounds
                }
                else if (field is StatusFieldBox box)
                {
                    value.Shape = "box";
                    value.Size = Vec(box.size);
                    value.Rotation = new[] { 0f, 0f, 0f, 1f };
                }
                else if (field is StatusField sphere)
                {
                    value.Shape = "sphere";
                    value.Radius = Positive(sphere.radius * (sphere.respectScale ? sphere.transform.lossyScale.x : 1f));
                }
                objects.Add(value);
            }
            foreach (GloomSafeZone zone in _safeZones)
            {
                if (!InScene(zone)) continue;
                WorldObjectTelemetry value = Base(zone, "fog_safe_zone", "GloomSafeZone.isLit");
                value.Active = value.Active && zone.isLit;
                value.Activity = zone.isLit ? "lit" : "unlit";
                value.Shape = "sphere";
                value.Radius = Positive(zone.statusProtectionRadius);
                value.VisualRadius = Positive(zone.visualRadius);
                value.Falloff = Positive(zone.falloff);
                objects.Add(value);
            }
            foreach (StatusEmitter emitter in _emitters)
            {
                if (!InScene(emitter)) continue;
                string status = emitter.statusType.ToString();
                if (status != "Drowsy" && status != "Spores" && status != "Poison") continue;
                WorldObjectTelemetry value = Base(emitter, status == "Drowsy" ? "sleep_fog" : "spore_cloud", "StatusEmitter");
                value.Active = value.Active && !emitter.emitterDisabledByWind;
                value.Activity = emitter.emitterDisabledByWind ? "wind_suppressed" : value.Active ? "emitting" : "inactive";
                value.Shape = "sphere";
                value.Radius = Positive(emitter.radius + emitter.outerFade);
                value.StatusType = status;
                value.StatusAmountPerSecond = emitter.amount;
                value.StatusEnabled = value.Active;
                objects.Add(value);
            }
            _tracker.Reconcile(now, objects, _write);
            // References are retained between discoveries. Never retire an object merely because
            // a disabled GameObject or a held item isn't currently rendered in the replay.
            _tracker.RetireMissing(_observed);
        }
        catch (Exception exception)
        {
            // An interrupted/incomplete scan must never emit removals or an empty full snapshot.
            if (now >= _nextErrorLogAt)
            {
                _nextErrorLogAt = now + 30_000;
                _log.LogWarning("World telemetry scan skipped: " + exception.Message);
            }
        }
    }

    public void ObserveSpawnEffect(SpawnGameObject spawner)
    {
        if (!InScene(spawner) || !IsMine(spawner)) return;
        WorldObjectTelemetry value = ReadMine(spawner);
        long now = _clock();
        // Several UnityEvent paths can invoke the effect on the same frame. Coalesce duplicate
        // callbacks, but do not infer an explosion from a disabled/despawned mesh or player death.
        if (_lastExplosionAt.TryGetValue(value.ObjectId, out long previous) && now - previous < 100) return;
        _lastExplosionAt[value.ObjectId] = now;
        _explodedMines.Add(value.ObjectId);
        value.Activity = "exploded";
        _write(WorldTelemetryTracker.Event(now, "mine_explosion", value, "SpawnGameObject.Go.postfix"));
        _nextSampleAt = 0;
    }

    public void ObserveNetworkSpawn(GameObject instance)
    {
        if (instance == null) return;
        PhotonView? view = instance.GetComponent<PhotonView>();
        if (!InScene(view)) return;
        if (_deployedPrefabs.Count == 0) DiscoverDeployedPrefabs();
        string name = PrefabName(instance.name);
        if (!_deployedPrefabs.TryGetValue(name, out int itemId)) return;
        // Observe the actual returned instance (including remote Photon instantiations), not
        // the thrower's old position or a guessed impact coordinate. The two internal Photon
        // overloads can return the same object; both cache and immediate delta are idempotent.
        if (!_views.Contains(view!)) _views = _views.Concat(new[] { view! }).ToArray();
        WorldObjectTelemetry value = Base(view!, "placed_object", "PhotonView.deployed-item-prefab");
        value.ItemId = itemId;
        value.Activity = value.Active ? "placed" : "inactive";
        _tracker.ObserveImmediate(_clock(), value, _write);
        _nextSampleAt = 0;
        _nextDiscoveryAt = 0;
    }

    private WorldObjectTelemetry ReadMine(SpawnGameObject spawner)
    {
        WorldObjectTelemetry value = Base(spawner, "mine", "SpawnGameObject.toSpawn.VFX_SporeExplo");
        value.Activity = _explodedMines.Contains(value.ObjectId) ? "exploded" : value.Active ? "armed" : "inactive";
        value.Active = value.Active && !_explodedMines.Contains(value.ObjectId);
        StatusField? field = spawner.toSpawn.GetComponentInChildren<StatusField>(true);
        ExplosionEffect? explosion = spawner.toSpawn.GetComponentInChildren<ExplosionEffect>(true);
        value.Radius = field != null ? Positive(field.radius * (field.respectScale ? field.transform.lossyScale.x : 1f))
            : explosion != null ? Positive(explosion.explosionRadius) : null;
        if (field != null) value.StatusType = field.statusType.ToString();
        return value;
    }

    private static bool IsMine(SpawnGameObject spawner) => spawner.toSpawn != null
        && spawner.toSpawn.name.StartsWith("VFX_SporeExplo", StringComparison.Ordinal)
        && spawner.gameObject.name.StartsWith("Jungle_SporeMushroom", StringComparison.Ordinal);

    private void DiscoverDeployedPrefabs()
    {
        ItemDatabase? database = SingletonAsset<ItemDatabase>.Instance;
        if (database?.itemLookup == null) return;
        foreach (Item item in database.itemLookup.Values)
        {
            if (item == null) continue;
            ShelfShroom? shelf = item.GetComponent<ShelfShroom>();
            CloudFungus? cloud = item.GetComponent<CloudFungus>();
            GameObject? prefab = shelf != null ? shelf.instantiateOnBreak : cloud != null ? cloud.instantiateOnBreak : null;
            if (prefab != null) _deployedPrefabs[PrefabName(prefab.name)] = item.itemID;
        }
    }

    private WorldObjectTelemetry Base(Component component, string kind, string source)
    {
        Transform transform = component.transform;
        PhotonView? view = component.GetComponentInParent<PhotonView>();
        return new WorldObjectTelemetry
        {
            ObjectId = Id(component, kind), Kind = kind, Source = source,
            PrefabName = PrefabName(component.gameObject.name), Position = Vec(transform.position),
            Rotation = new[] { Round(transform.rotation.x), Round(transform.rotation.y), Round(transform.rotation.z), Round(transform.rotation.w) },
            Scale = Vec(transform.lossyScale), Active = component.gameObject.activeInHierarchy && (component is not Behaviour behaviour || behaviour.enabled),
            PhotonViewId = view != null && view.ViewID != 0 ? view.ViewID : null,
            ScenePath = ScenePath(transform),
        };
    }

    private string Id(Component component, string kind)
    {
        PhotonView? view = component.GetComponentInParent<PhotonView>();
        string key = kind + ":view:" + (view != null ? view.ViewID : 0) + ":instance:" + component.GetInstanceID();
        _observed.Add(key);
        return _tracker.GetObjectId(key);
    }

    private static void AddZombieRanges(WorldObjectTelemetry value, MushroomZombie zombie)
    {
        value.ActivationRadius = Positive(zombie.distanceBeforeWakeup);
        value.SpawnRadius = Positive(zombie.distanceToEnable);
        value.WarningRadius = value.ActivationRadius.HasValue ? value.ActivationRadius.Value + 20f : null;
        value.WarningRadiusSource = "replay-ui-margin-20m-not-game-activation";
        value.ActivationRequires = new[] { "visible", "player-look-angle", "line-of-sight", "valid-target" };
    }

    private static T[] Find<T>() where T : UnityEngine.Object => UnityEngine.Object.FindObjectsByType<T>(FindObjectsInactive.Include, FindObjectsSortMode.None);
    private static bool InScene(Component? component) => component != null && component.gameObject.scene.IsValid()
        && component.gameObject.scene == SceneManager.GetActiveScene();
    private static float Round(float value)
    {
        if (float.IsNaN(value) || float.IsInfinity(value))
            throw new InvalidOperationException("A world transform is not finite; retaining the last complete snapshot.");
        return (float)Math.Round(value, 3);
    }
    private static float[] Vec(Vector3 value) => new[] { Round(value.x), Round(value.y), Round(value.z) };
    private static float? Positive(float value) => !float.IsNaN(value) && !float.IsInfinity(value) && value > 0f ? value : null;
    private static string PrefabName(string value) => value.Replace("(Clone)", string.Empty).Trim();
    private static string ScenePath(Transform transform)
    {
        var parts = new List<string>();
        for (Transform current = transform; current != null && parts.Count < 32; current = current.parent)
            parts.Add(current.name + "[" + current.GetSiblingIndex() + "]");
        parts.Reverse();
        return string.Join("/", parts);
    }
}

// The postfix observes a completed visual-effect instantiation. It neither skips nor mutates
// game methods, arguments, AI, damage or network traffic, and never lets recorder errors escape.
internal static class WorldTelemetryHooks
{
    private static Harmony? _harmony;
    internal static WorldTelemetryReader? Active { get; set; }
    internal static bool Installed { get; private set; }
    internal static bool NetworkSpawnInstalled { get; private set; }

    public static void Install(ManualLogSource log)
    {
        try
        {
            _harmony = new Harmony("PeakTrailRecorder.world-observation");
            _harmony.Patch(AccessTools.Method(typeof(SpawnGameObject), nameof(SpawnGameObject.Go)),
                postfix: new HarmonyMethod(typeof(WorldTelemetryHooks), nameof(SpawnPostfix)));
            Installed = true;
        }
        catch (Exception exception) { log.LogWarning("Mine effect observation unavailable: " + exception.Message); }
        try
        {
            _harmony ??= new Harmony("PeakTrailRecorder.world-observation");
            var methods = AccessTools.GetDeclaredMethods(typeof(PhotonNetwork))
                .Where(method => method.Name == "NetworkInstantiate" && method.ReturnType == typeof(GameObject)).ToArray();
            foreach (var method in methods)
                _harmony.Patch(method, postfix: new HarmonyMethod(typeof(WorldTelemetryHooks), nameof(NetworkSpawnPostfix)));
            NetworkSpawnInstalled = methods.Length > 0;
        }
        catch (Exception exception) { log.LogWarning("Immediate world-spawn observation unavailable; polling remains active: " + exception.Message); }
    }

    private static void SpawnPostfix(SpawnGameObject __instance)
    {
        try { Active?.ObserveSpawnEffect(__instance); }
        catch (Exception exception) { Plugin.Log.LogWarning("Mine effect telemetry skipped: " + exception.Message); }
    }

    private static void NetworkSpawnPostfix(GameObject __result)
    {
        try { Active?.ObserveNetworkSpawn(__result); }
        catch (Exception exception) { Plugin.Log.LogWarning("World-spawn telemetry skipped: " + exception.Message); }
    }

    public static void Uninstall()
    {
        Active = null;
        _harmony?.UnpatchSelf();
        Installed = false;
        NetworkSpawnInstalled = false;
    }
}
