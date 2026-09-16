using Newtonsoft.Json.Linq;
using PeakTrailRecorder;

int checks = 0;
void Check(bool ok, string message)
{
    if (!ok) throw new InvalidOperationException(message);
    checks++;
}
var tracker = new WorldTelemetryTracker();
string key = "item:view:31:instance:500";
string id = tracker.GetObjectId(key);
Check(id == tracker.GetObjectId(key), "Repeated observations must keep the same ID");
tracker.RetireMissing(new HashSet<string> { key });
Check(id == tracker.GetObjectId(key), "Held/inactive objects keep their identity");
tracker.RetireMissing(new HashSet<string>());
string newId = tracker.GetObjectId(key);
Check(id != newId, "A recycled Photon/Unity ID must get a new lifecycle ID");
var records = new List<JObject>();
void Write(object record) => records.Add(JObject.FromObject(record));
WorldObjectTelemetry Item(bool active, string activity, float x = 1) => new()
{
    ObjectId = newId, Kind = "item", PrefabName = "ShelfShroom", Position = new[] { x, 2f, 3f },
    Active = active, Activity = activity, Source = "Item.ALL_ITEMS", ItemId = 1,
};
tracker.Reconcile(0, new[] { Item(true, "ground") }, Write);
Check(records.Count == 1 && (string?)records[0]["type"] == "world_snapshot" && (bool)records[0]["complete"]!, "Initial record is a complete snapshot");
Check(records[0]["objects"]![0]!["pos"]!.Count() == 3 && records[0]["objects"]![0]!["rot"]!.Count() == 4, "Pose schema uses XYZ + quaternion");
tracker.Reconcile(250, new[] { Item(true, "ground") }, Write);
Check(records.Count == 1, "Unchanged stationary state must not emit a delta");
tracker.Reconcile(500, new[] { Item(false, "held") }, Write);
Check(records.Count == 2 && (string?)records[1]["type"] == "world_delta" && !(bool)records[1]["upserts"]![0]!["active"]!, "Pickup hides ground model with stable identity");
tracker.Reconcile(750, new[] { Item(true, "ground", 5) }, Write);
Check((string?)records[^1]["upserts"]![0]!["objectId"] == newId, "Drop of same live instance retains ID");
tracker.Reconcile(1000, Array.Empty<WorldObjectTelemetry>(), Write);
Check((string?)records[^1]["removed"]![0] == newId, "Destruction records a removal");
Check(records.All(r => (string?)r["type"] != "world_event"), "Pickup/despawn must not masquerade as an explosion");
tracker.Reconcile(10_000, Array.Empty<WorldObjectTelemetry>(), Write);
Check((string?)records[^1]["type"] == "world_snapshot" && !records[^1]["objects"]!.Any(), "Periodic empty snapshots clear obsolete state");
WorldObjectTelemetry Zombie(string state) => new()
{
    ObjectId = "zombie:1", Kind = "zombie", PrefabName = "Zombie", Position = new[] { 0f, 0f, 0f },
    Active = state != "dead", Activity = state, Source = "MushroomZombie.currentState", ActivationRadius = 20, WarningRadius = 40,
};
tracker.Reconcile(10_250, new[] { Zombie("sleeping") }, Write);
tracker.Reconcile(10_500, new[] { Zombie("wakingup") }, Write);
Check((string?)records[^1]["event"] == "zombie_state", "Real observed zombie transition is an event");
Check(records.All(r => (string?)r["event"] != "mine_explosion"), "Enemy activity cannot produce a mine explosion");
var mine = new WorldObjectTelemetry { ObjectId = "mine:1", Kind = "mine", Position = new[] { 1f, 2f, 3f }, Radius = 5, Activity = "exploded" };
var explosion = JObject.FromObject(WorldTelemetryTracker.Event(11000, "mine_explosion", mine, "SpawnGameObject.Go.postfix"));
Check((string?)explosion["type"] == "world_event" && (string?)explosion["source"] == "SpawnGameObject.Go.postfix" && (float)explosion["radius"]! == 5, "Mine event retains observed source and effect radius");
var instantTracker = new WorldTelemetryTracker();
var immediate = new List<JObject>();
void InstantWrite(object record) => immediate.Add(JObject.FromObject(record));
var placed = new WorldObjectTelemetry
{
    ObjectId = instantTracker.GetObjectId("placed_object:view:55:instance:111"), Kind = "placed_object",
    PrefabName = "BounceShroomSpawn", ItemId = 79, Position = new[] { 9f, 10f, 11f }, Active = true,
    Activity = "placed", Source = "PhotonView.deployed-item-prefab",
};
instantTracker.ObserveImmediate(1, placed, InstantWrite);
instantTracker.ObserveImmediate(1, placed, InstantWrite);
Check(immediate.Count == 1, "Nested Photon overload postfixes must not duplicate the same spawn");
Check((string?)immediate[0]["type"] == "world_delta" && (float)immediate[0]["upserts"]![0]!["pos"]![1]! == 10, "Immediate spawn retains actual returned-instance pose");
instantTracker.Reconcile(250, new[] { placed }, InstantWrite);
Check((string?)immediate[^1]["type"] == "world_snapshot" && immediate[^1]["objects"]!.Count() == 1, "First checkpoint includes observed immediate spawn");
instantTracker.Reconcile(500, Array.Empty<WorldObjectTelemetry>(), InstantWrite);
Check((string?)immediate[^1]["removed"]![0] == placed.ObjectId, "A fast destroyed deployed object is retired next sample");
WorldObjectTelemetry Fog(bool enabled, bool statusEnabled = true) => new()
{
    ObjectId = "gloom:1", Kind = "sleep_fog", PrefabName = "SleepyFog", Position = new[] { 0f, 10f, 0f },
    Active = enabled, Activity = enabled ? "emitting" : "inactive", Source = "StatusFieldGloom.Drowsy",
    Shape = "box", Size = new[] { 50f, 20f, 50f }, SightDistance = 25, StatusEnabled = statusEnabled,
};
instantTracker.Reconcile(750, new[] { Fog(true) }, InstantWrite);
instantTracker.Reconcile(1000, new[] { Fog(true, false) }, InstantWrite);
Check(!(bool)immediate[^1]["upserts"]![0]!["statusEnabled"]!, "Run-setting change updates hazard status without inventing a different volume");
instantTracker.Reconcile(1250, new[] { Fog(false, false) }, InstantWrite);
Check((string?)immediate[^1]["event"] == "fog_disabled", "Observed fog disable produces an explicit event");
var capability = JObject.FromObject(WorldTelemetryTracker.Capabilities(false, false));
Check((string?)capability["mineExplosionObservation"] == "unavailable" && (string?)capability["networkSpawnObservation"] == "polling-only", "Hook failure must remain visible as degraded coverage");
Console.WriteLine($"World contract: {checks} checks passed.");
