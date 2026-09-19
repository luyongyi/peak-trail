using System;
using System.Collections.Generic;
using BepInEx.Logging;
using HarmonyLib;
using Photon.Pun;
using UnityEngine;
using Zorro.Core;
using Zorro.PhotonUtility;

namespace PeakTrailRecorder;

/// <summary>Observes the same reliable data packets used by CharacterCustomization.</summary>
internal static class PlayerAppearanceReader
{
    private const string HarmonyId = "PeakTrailRecorder.appearance-sync-observation";
    private static readonly Dictionary<int, PersistentPlayerData> SyncedData = new();
    private static Harmony? _harmony;

    public static void Install(ManualLogSource log)
    {
        if (_harmony != null) return;
        _harmony = new Harmony(HarmonyId);
        try
        {
            // CustomCommandListener keeps a single listener per package type and silently
            // removes earlier registrations, so PersistentPlayerDataService itself
            // displaces any RegisterListener-based observer. Observe the service's own
            // write paths instead; each stores the exact reference that Read() compares.
            _harmony.Patch(AccessTools.Method(typeof(PersistentPlayerDataService), "OnSyncReceived"),
                postfix: new HarmonyMethod(typeof(PlayerAppearanceReader), nameof(AfterSyncReceived)));
            _harmony.Patch(AccessTools.Method(typeof(PersistentPlayerDataService), "SetPlayerData"),
                postfix: new HarmonyMethod(typeof(PlayerAppearanceReader), nameof(AfterSetPlayerData)));
        }
        catch (Exception exception)
        {
            _harmony.UnpatchSelf();
            _harmony = null;
            log.LogWarning("Appearance sync observation unavailable; remote outfits will stay unknown: " + exception.Message);
        }
    }

    public static void Uninstall()
    {
        _harmony?.UnpatchSelf();
        _harmony = null;
        SyncedData.Clear();
    }

    public static void ClearOutsideRoom()
    {
        if (!PhotonNetwork.InRoom) SyncedData.Clear();
    }

    private static void AfterSyncReceived(SyncPersistentPlayerDataPackage package)
    {
        try
        {
            if (package != null) SyncedData[package.ActorNumber] = package.Data;
        }
        catch { /* Never interfere with the game's sync. */ }
    }

    private static void AfterSetPlayerData(Photon.Realtime.Player player, PersistentPlayerData playerData)
    {
        try
        {
            if (player != null && playerData != null) SyncedData[player.ActorNumber] = playerData;
        }
        catch { /* Never interfere with the game's sync. */ }
    }

    public static AppearanceTelemetry? Read(Character character, long observedForMs)
    {
        // Runtime shape is observable even when a remote cosmetic packet has
        // not arrived. Keep it independent of persistent customization readiness.
        AppearanceTelemetry appearance = AppearanceFormReader.Read(character, observedForMs);
        try
        {
            if (character?.photonView?.Owner == null || observedForMs < 2000) return appearance;
            var service = GameHandler.GetService<PersistentPlayerDataService>();
            var customization = Singleton<Customization>.Instance;
            int actor = character.photonView.Owner.ActorNumber;
            if (service == null || customization == null
                || !service.PersistentPlayerDatas.TryGetValue(actor, out PersistentPlayerData data)
                || data.customizationData == null) return appearance;

            bool local = character.photonView.IsMine;
            // GetPlayerData creates an all-zero placeholder. Do not treat it as an outfit.
            SyncedData.TryGetValue(actor, out PersistentPlayerData? synced);
            if (!AppearanceReadiness.IsReady(local, AchievementManager.GotStats, data, synced, observedForMs))
                return appearance;

            int skin = CharacterCustomization.GetSkinIndex(data);
            int fit = CharacterCustomization.GetFitIndex(data);
            var option = customization.fits[fit];
            int hat = data.customizationData.currentHat;
            int effectiveHat = option.overrideHat ? option.overrideHatIndex : hat;
            Color color = customization.skins[skin].color;
            appearance.SkinIndex = skin;
            appearance.EyesIndex = CharacterCustomization.GetEyesIndex(data);
            appearance.MouthIndex = CharacterCustomization.GetMouthIndex(data);
            appearance.AccessoryIndex = CharacterCustomization.GetAccessoryIndex(data);
            appearance.OutfitIndex = fit;
            appearance.HatIndex = hat;
            appearance.EffectiveHatIndex = effectiveHat;
            appearance.SashIndex = CharacterCustomization.GetSashIndex(data);
            appearance.MedalIndex = CharacterCustomization.GetMedalIndex(data);
            appearance.SkinColor = new[] { color.r, color.g, color.b, color.a };
            appearance.OutfitName = option.name;
            appearance.HatName = effectiveHat >= 0 && effectiveHat < customization.hats.Length
                ? customization.hats[effectiveHat].name : "unknown";
            appearance.Authority = local ? "local-player-customization" : "persistent-player-data-sync";
            appearance.Ready = true;
            return appearance;
        }
        catch { return appearance; }
    }
}
