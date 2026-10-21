using System.Reflection;
namespace UnityEngine
{
    public class Object
    {
        static int next;
        readonly int id = ++next;
        public string name = "";
        public int GetInstanceID() => id;
        public static implicit operator bool(Object? value) => value is not null;
    }
    public class Component : Object
    {
        public GameObject gameObject = null!;
        public Transform transform => gameObject.transform;
        public T? GetComponent<T>() where T : class => gameObject.GetComponent<T>();
    }
    public class GameObject : Object
    {
        readonly Dictionary<Type, Component> components = new();
        public Transform transform;
        public GameObject(string name) { this.name = name; transform = Add(new Transform()); }
        public T Add<T>(T value) where T : Component { value.gameObject = this; value.name = name; components[typeof(T)] = value; return value; }
        public T? GetComponent<T>() where T : class => components.Values.OfType<T>().FirstOrDefault();
    }
    public class Transform : Component { public Vector3 position; }
    public struct Vector3
    {
        public float x,y,z;
        public Vector3(float x,float y,float z) { this.x=x; this.y=y; this.z=z; }
    }
    public static class Time { public static int frameCount; }
}
namespace Photon.Pun
{
    public class PhotonView : UnityEngine.Component { public int ViewID; }
    public static class PhotonNetwork { public static PhotonView? GetPhotonView(int id) => null; }
}
namespace HarmonyLib
{
    public class Harmony
    {
        public Harmony(string id) { }
        public void Patch(MethodInfo method, HarmonyMethod? prefix = null, HarmonyMethod? postfix = null, HarmonyMethod? transpiler = null, HarmonyMethod? finalizer = null) { }
        public void UnpatchSelf() { }
    }
    public class HarmonyMethod { public HarmonyMethod(Type type,string method) { } }
    public static class AccessTools
    {
        public static FieldInfo? Field(Type type,string name) => type.GetField(name,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic);
        public static MethodInfo? Method(Type type,string name) => type.GetMethod(name,BindingFlags.Instance|BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic);
        public static IEnumerable<MethodInfo> GetDeclaredMethods(Type type) => type.GetMethods();
    }
}
namespace Zorro.Core { public static class SingletonAsset<T> { public static T? Instance; } }
namespace PeakTrailRecorder { internal static class Plugin { public static TestLog Log = new(); } internal class TestLog { public void LogWarning(string value) { } } }
public class Item : UnityEngine.Component { public int itemID; public Character? trueHolderCharacter, lastThrownCharacter; }
public class Character : UnityEngine.Component { public UnityEngine.Vector3 Center; }
public class ItemSlot { public Item? prefab; }
public class CharacterItems : UnityEngine.Component { }
public class ItemDatabase { public Dictionary<int,Item> itemLookup = new(); }
public class ShelfShroom : UnityEngine.Component { public UnityEngine.GameObject instantiateOnBreak = null!; }
public class CloudFungus : UnityEngine.Component { public UnityEngine.GameObject instantiateOnBreak = null!; }
public class ClimbingSpikeComponent : UnityEngine.Component { public UnityEngine.GameObject hammeredVersionPrefab = null!; }
public class Constructable : UnityEngine.Component { public UnityEngine.GameObject constructedPrefab = null!; }
public class RopeTier : UnityEngine.Component { public UnityEngine.GameObject anchorPrefab = null!; }
public class RopeShooter : UnityEngine.Component { public UnityEngine.GameObject ropeAnchorWithRopePref = null!; }
public class RopeSpool : UnityEngine.Component { }
public class Rope : UnityEngine.Component { }
public class RopeAnchor : UnityEngine.Component { public UnityEngine.Transform anchorPoint = null!; }
public class RopeAnchorProjectile : UnityEngine.Component { }
public class RopeAnchorWithRope : UnityEngine.Component { }
