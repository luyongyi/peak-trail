using System;
using System.Linq;
using System.Runtime.CompilerServices;
using BepInEx.Logging;
using HarmonyLib;
using Photon.Pun;

namespace PeakTrailRecorder;

/// <summary>All callbacks and reads run on Unity's main thread. No RPCs, status mutations,
/// effect ticks or game lifecycle methods are invoked by this observer.</summary>
internal static class PlayerStatusReader
{
    private const string HarmonyId = "PeakTrailRecorder.status-observation";
    private static ConditionalWeakTable<CharacterAfflictions, StatusReceiptEvidence> _receipts = new();
    private static Harmony? _harmony;

    public static void Install(ManualLogSource log)
    {
        if (_harmony != null) return;
        _harmony = new Harmony(HarmonyId);
        try
        {
            // SetAll is the decoded-array receiver called by SyncStatusesRPC. Observing here
            // also allows us to reject malformed-length packets which the game ignores.
            _harmony.Patch(AccessTools.Method(typeof(CharacterAfflictions), "SetAll"),
                postfix: new HarmonyMethod(typeof(PlayerStatusReader), nameof(AfterStatusArray)));
            _harmony.Patch(AccessTools.Method(typeof(CharacterAfflictions), "SyncAfflictionsRPC"),
                postfix: new HarmonyMethod(typeof(PlayerStatusReader), nameof(AfterEffects)));
        }
        catch (Exception exception)
        {
            _harmony.UnpatchSelf();
            _harmony = null;
            log.LogWarning("Status observation hooks unavailable; remote status will remain unknown: " + exception.Message);
        }
    }

    public static void Uninstall()
    {
        _harmony?.UnpatchSelf();
        _harmony = null;
        _receipts = new();
    }

    public static void ClearOutsideRoom()
    {
        if (!PhotonNetwork.InRoom) _receipts = new();
    }

    private static void AfterStatusArray(CharacterAfflictions __instance, float[] statuses)
    {
        try
        {
            if (statuses == null || __instance.currentStatuses == null
                || statuses.Length != __instance.currentStatuses.Length
                || !statuses.All(FiniteNonNegative)) return;
            ObserveReceipt(__instance, effects: false);
        }
        catch { /* Never interfere with the game's RPC. */ }
    }

    private static void AfterEffects(CharacterAfflictions __instance)
    {
        try { ObserveReceipt(__instance, effects: true); }
        catch { /* Never interfere with the game's RPC. */ }
    }

    private static void ObserveReceipt(CharacterAfflictions afflictions, bool effects)
    {
        Character? character = afflictions.character;
        if (character == null || character.photonView == null || character.photonView.IsMine
            || !PhotonNetwork.InRoom || PhotonNetwork.CurrentRoom == null || afflictions.currentStatuses == null) return;
        _receipts.GetOrCreateValue(afflictions).Observe(PhotonNetwork.CurrentRoom,
            character.photonView.OwnerActorNr, character.photonView.ViewID, afflictions.currentStatuses, effects);
    }

    public static bool HasStatusCapacity(Character character)
    {
        try
        {
            CharacterAfflictions? afflictions = character.refs?.afflictions;
            if (afflictions != null && character.photonView?.IsMine == true)
                _receipts.Remove(afflictions);
            // Evaluate receipt identity even if the character's data/array is invalid now.
            // Detecting an ownership round trip must permanently revoke the old evidence.
            bool received = afflictions != null && character.photonView != null
                && HasReceipt(character, afflictions, effects: false);
            return character.photonView != null && afflictions?.currentStatuses != null
                && afflictions.currentStatuses.Length >= CharacterAfflictions.NumStatusTypes
                && afflictions.currentStatuses.All(FiniteNonNegative)
                && FiniteNonNegative(afflictions.statusSum)
                && (character.photonView.IsMine || received);
        }
        catch { return false; }
    }

    private static bool HasReceipt(Character character, CharacterAfflictions afflictions, bool effects)
        => _receipts.TryGetValue(afflictions, out StatusReceiptEvidence? receipt)
            && receipt.Ready(PhotonNetwork.CurrentRoom, character.photonView.OwnerActorNr,
                character.photonView.ViewID, afflictions.currentStatuses, effects);

    public static StatusTelemetry Read(Character character)
    {
        var result = new StatusTelemetry();
        try
        {
            if (character == null || character.photonView == null || character.data == null
                || character.refs?.afflictions == null) return result;
            bool local = character.photonView.IsMine;
            CharacterAfflictions afflictions = character.refs.afflictions;
            if (local) _receipts.Remove(afflictions);
            result.Authority = local ? "local-owner-authoritative" : "photon-status-rpc-observed";
            result.EffectsAuthority = local ? "local-owner-authoritative" : "photon-affliction-rpc-observed";
            bool dataReady = local || character.GetComponent<CharacterSyncer>()?.RemoteValue.IsSome == true;
            if (dataReady) result.Dead = character.data.dead;
            if (dataReady && HasStatusCapacity(character))
            {
                float petrify = character.data.petrifyAmount * 0.01f;
                if (!FiniteNonNegative(petrify) || petrify > 1f) return result;
                for (int index = 0; index < afflictions.currentStatuses.Length; index++)
                {
                    var type = (CharacterAfflictions.STATUSTYPE)index;
                    float amount = afflictions.currentStatuses[index];
                    bool isPetrify = type == CharacterAfflictions.STATUSTYPE.Petrify;
                    result.Values.Add(new StatusValueTelemetry
                    {
                        Id = index,
                        Type = Enum.IsDefined(typeof(CharacterAfflictions.STATUSTYPE), type) ? type.ToString() : "Unknown_" + index,
                        Amount = isPetrify ? petrify : amount,
                        StaminaBlock = amount,
                        ExtraStaminaBlock = isPetrify ? petrify : 0f,
                    });
                }
                result.Ready = true;
                result.StatusSum = afflictions.statusSum;
                result.BaseMaxStamina = 1f;
                result.MaxStamina = character.GetMaxStamina();
                result.BaseMaxExtraStamina = 1f;
                result.MaxExtraStamina = Math.Max(0f, 1f - petrify);
            }
            if (local || HasReceipt(character, afflictions, effects: true))
            {
                // Remote effects do not Tick(), so their timeElapsed is not an authoritative
                // remaining-time clock. Capture all active identities without inventing timers.
                result.Effects = afflictions.afflictionList.Select(effect => new StatusEffectTelemetry
                {
                    TypeId = (int)effect.GetAfflictionType(),
                    Type = effect.GetAfflictionType().ToString(),
                }).OrderBy(effect => effect.TypeId).ToList();
                result.EffectsReady = true;
            }
        }
        catch
        {
            // Transient spawn/teardown races must invalidate, not preserve a stale valid half-read.
            return new StatusTelemetry { Authority = result.Authority, EffectsAuthority = result.EffectsAuthority };
        }
        return result;
    }

    private static bool FiniteNonNegative(float value) => !float.IsNaN(value) && !float.IsInfinity(value) && value >= 0f;
}
