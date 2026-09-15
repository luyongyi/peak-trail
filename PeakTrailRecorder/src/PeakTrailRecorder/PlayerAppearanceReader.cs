using System;
using System.Collections.Generic;
using Photon.Pun;
using UnityEngine;
using Zorro.Core;
using Zorro.PhotonUtility;

namespace PeakTrailRecorder;

/// <summary>Observes the same reliable data packets used by CharacterCustomization.</summary>
internal static class PlayerAppearanceReader
{
    private static readonly Dictionary<int, PersistentPlayerData> SyncedData = new();
    private static ListenerHandle _listener;
    private static bool _subscribed;

    public static void Subscribe()
    {
        if (_subscribed) return;
        _listener = CustomCommands<CustomCommandType>.RegisterListener<SyncPersistentPlayerDataPackage>(
            package => SyncedData[package.ActorNumber] = package.Data);
        _subscribed = true;
    }

    public static void Unsubscribe()
    {
        if (!_subscribed) return;
        CustomCommands<CustomCommandType>.UnregisterListener(_listener);
        _subscribed = false;
        SyncedData.Clear();
    }

    public static void ClearOutsideRoom()
    {
        if (!PhotonNetwork.InRoom) SyncedData.Clear();
    }

    public static AppearanceTelemetry? Read(Character character, long observedForMs)
    {
        try
        {
            if (character?.photonView?.Owner == null || observedForMs < 2000) return null;
            var service = GameHandler.GetService<PersistentPlayerDataService>();
            var customization = Singleton<Customization>.Instance;
            int actor = character.photonView.Owner.ActorNumber;
            if (service == null || customization == null
                || !service.PersistentPlayerDatas.TryGetValue(actor, out PersistentPlayerData data)
                || data.customizationData == null) return null;

            bool local = character.photonView.IsMine;
            // GetPlayerData creates an all-zero placeholder. Do not treat it as an outfit.
            SyncedData.TryGetValue(actor, out PersistentPlayerData? synced);
            if (!AppearanceReadiness.IsReady(local, AchievementManager.GotStats, data, synced, observedForMs))
                return null;

            int skin = CharacterCustomization.GetSkinIndex(data);
            int fit = CharacterCustomization.GetFitIndex(data);
            var option = customization.fits[fit];
            int hat = data.customizationData.currentHat;
            int effectiveHat = option.overrideHat ? option.overrideHatIndex : hat;
            Color color = customization.skins[skin].color;
            return new AppearanceTelemetry
            {
                Ready = true,
                Authority = local ? "local-player-customization" : "persistent-player-data-sync",
                SkinIndex = skin,
                EyesIndex = CharacterCustomization.GetEyesIndex(data),
                MouthIndex = CharacterCustomization.GetMouthIndex(data),
                AccessoryIndex = CharacterCustomization.GetAccessoryIndex(data),
                OutfitIndex = fit,
                HatIndex = hat,
                EffectiveHatIndex = effectiveHat,
                SashIndex = CharacterCustomization.GetSashIndex(data),
                MedalIndex = CharacterCustomization.GetMedalIndex(data),
                SkinColor = new[] { color.r, color.g, color.b, color.a },
                OutfitName = option.name,
                HatName = effectiveHat >= 0 && effectiveHat < customization.hats.Length
                    ? customization.hats[effectiveHat].name : "unknown",
            };
        }
        catch { return null; }
    }
}
