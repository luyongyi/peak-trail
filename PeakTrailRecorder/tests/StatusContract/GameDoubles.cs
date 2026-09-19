// Isolated read-only character/RPC doubles. The production reader itself is linked into
// this executable; no Unity installation is required and no game method is patched here.
namespace BepInEx.Logging
{
    public class ManualLogSource { public void LogWarning(object value) { } }
}
namespace HarmonyLib
{
    public class Harmony
    {
        public Harmony(string id) { }
        public void Patch(object? original, HarmonyMethod? postfix = null) { }
        public void UnpatchSelf() { }
    }
    public class HarmonyMethod { public HarmonyMethod(Type type, string method) { } }
    public static class AccessTools { public static object? Method(Type type, string method) => null; }
}
namespace Photon.Pun
{
    public static class PhotonNetwork
    {
        public static bool InRoom = true;
        public static object? CurrentRoom = new();
    }
    public class PhotonView
    {
        public bool IsMine = true;
        public int OwnerActorNr = 1;
        public int ViewID = 1001;
    }
}

public class Character
{
    public Photon.Pun.PhotonView photonView = new();
    public CharacterData data = new();
    public CharacterRefs refs = new();
    public CharacterSyncer syncer = new();
    public T? GetComponent<T>() where T : class => syncer as T;
    public float GetMaxStamina() => Math.Max(1 - refs.afflictions.statusSum, 0);
}
public class CharacterRefs { public CharacterAfflictions afflictions = new(); }
public class CharacterData { public bool dead; public int petrifyAmount; }
public class CharacterSyncer { public Optional RemoteValue = new(); }
public class Optional { public bool IsSome; }
public class CharacterAfflictions
{
    public enum STATUSTYPE { Injury, Hunger, Cold, Poison, Crab, Curse, Drowsy, Weight, Hot, Thorns, Spores, Web, Arrow, Petrify, FlyTrap }
    public static readonly int NumStatusTypes = Enum.GetNames<STATUSTYPE>().Length;
    public Character character = null!;
    public float[] currentStatuses = new float[NumStatusTypes];
    public float statusSum => currentStatuses.Sum();
    public List<Affliction> afflictionList = new();
}
public class Affliction(Affliction.Kind kind)
{
    public enum Kind { PoisonOverTime, InfiniteStamina, FasterBoi, Exhausted, Glowing, ColdOverTime }
    public Kind GetAfflictionType() => kind;
}
