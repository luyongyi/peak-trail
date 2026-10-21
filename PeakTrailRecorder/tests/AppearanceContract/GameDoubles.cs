// Production readers run unchanged. Material-instance getters deliberately throw.
namespace UnityEngine
{
    public class Object
    {
        public bool Destroyed;
        public string name = "";
        public static bool operator ==(Object? a, Object? b)
        {
            bool an = ReferenceEquals(a, null) || a.Destroyed;
            bool bn = ReferenceEquals(b, null) || b.Destroyed;
            return an || bn ? an == bn : ReferenceEquals(a, b);
        }
        public static bool operator !=(Object? a, Object? b) => !(a == b);
        public override bool Equals(object? other) => ReferenceEquals(this, other);
        public override int GetHashCode() => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(this);
    }
    public class GameObject : Object { public bool activeInHierarchy = true, activeSelf = true; }
    public class Transform { public Vector3 position; public Quaternion rotation = new(0, 0, 0, 1); }
    public struct Vector3(float x, float y, float z) { public float x = x, y = y, z = z; }
    public struct Quaternion(float x, float y, float z, float w) { public float x = x, y = y, z = z, w = w; }
    public class MonoBehaviour : Object { public GameObject gameObject = new(); public Transform transform = new(); }
    public class Mesh : Object { }
    public class MeshFilter { public Mesh? sharedMesh = new() { name = "Synthetic mesh" }; }
    public class Material : Object
    {
        public bool ThrowOnRead;
        public Dictionary<string, float> Floats = new();
        public bool HasProperty(string key) => ThrowOnRead ? throw new InvalidOperationException("Disposed material") : Floats.ContainsKey(key);
        public float GetFloat(string key) => ThrowOnRead ? throw new InvalidOperationException("Disposed material") : Floats[key];
    }
    public class Renderer : MonoBehaviour
    {
        public bool enabled = true;
        public Material[] sharedMaterials = Array.Empty<Material>();
        public Material material => throw new InvalidOperationException("Instanced a live material");
        public Material[] materials => throw new InvalidOperationException("Instanced live materials");
        public MeshFilter Filter = new();
        public T? GetComponent<T>() where T : class => Filter as T;
    }
    public class SkinnedMeshRenderer : Renderer { public Mesh? sharedMesh = new() { name = "Synthetic skinned mesh" }; }
}
namespace Photon.Pun
{
    public static class PhotonNetwork { public static bool InRoom = true; }
    public class PhotonView { public bool IsMine; public Player? Owner = new(); }
    public class Player { public bool IsInactive; }
}
public class Character : UnityEngine.MonoBehaviour
{
    public Photon.Pun.PhotonView photonView = new();
    public CharacterData? data = new();
    public CharacterRefs? refs = new();
    public PlayerGhost? Ghost;
    public UnityEngine.Vector3 Center = new(1, 2, 3);
}
public class CharacterData { public bool isSkeleton, dead, shouldPetrify; public float passOutValue; public int petrifyAmount; }
public class CharacterRefs { public CharacterCustomization? customization = new(); }
public class CharacterCustomization { public CustomizationRefs? refs = new(); public bool isCannibalizable; }
public class CustomizationRefs
{
    public UnityEngine.Renderer? skeletonRenderer = Inactive();
    public UnityEngine.Mesh mushroomManMesh = new();
    public UnityEngine.Renderer? chickenRenderer = Inactive();
    public UnityEngine.Renderer? mainRenderer = new();
    public UnityEngine.Renderer[]? stoneRenderers = new[] { Inactive(), Inactive() };
    public UnityEngine.Renderer? blindRenderer = Inactive();
    private static UnityEngine.Renderer Inactive()
        => new() { gameObject = new() { activeInHierarchy = false, activeSelf = false }, sharedMaterials = new[] {
            new UnityEngine.Material { name = "Synthetic stone", Floats = new() { ["_Petrify"] = .625f } } } };
}
public class PlayerGhost : UnityEngine.MonoBehaviour
{
    public Character? m_owner;
    public Character? m_target;
    public UnityEngine.Renderer[]? PlayerRenderers = new[] { new UnityEngine.Renderer {
        sharedMaterials = new[] { new UnityEngine.Material { name = "Synthetic ghost" } } } };
}
