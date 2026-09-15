using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using UnityEngine;

namespace PeakTrailRecorder;

internal static class PlayerTelemetryReader
{
    public static StaminaTelemetry ReadStamina(Character character)
    {
        const string remoteAuthority = "photon-owner-sync";
        try
        {
            if (character == null || character.data == null || character.photonView == null)
            {
                return UnavailableStamina("unavailable");
            }

            bool isLocalOwner = character.photonView.IsMine;
            if (!isLocalOwner)
            {
                CharacterSyncer? syncer = character.GetComponent<CharacterSyncer>();
                if (syncer == null || syncer.RemoteValue.IsNone)
                {
                    // CharacterData float fields default to zero. That value is indistinguishable
                    // from exhausted stamina until the first owner-authored sync packet arrives.
                    return UnavailableStamina(remoteAuthority);
                }
            }

            float stamina = character.data.currentStamina;
            float extraStamina = character.data.extraStamina;
            float maxStamina = character.GetMaxStamina();
            float maxExtraStamina = Mathf.Clamp01(1f - character.data.petrifyAmount * 0.01f);
            float totalStamina = stamina + extraStamina;
            if (!IsFinite(stamina) || !IsFinite(extraStamina) || !IsFinite(maxStamina)
                || !IsFinite(maxExtraStamina) || !IsFinite(totalStamina))
            {
                return UnavailableStamina(isLocalOwner ? "local-owner-authoritative" : remoteAuthority);
            }

            return new StaminaTelemetry
            {
                Ready = true,
                Authority = isLocalOwner ? "local-owner-authoritative" : remoteAuthority,
                Stamina = stamina,
                MaxStamina = maxStamina,
                Stamina01 = SafeRatio(stamina, maxStamina),
                ExtraStamina = extraStamina,
                MaxExtraStamina = maxExtraStamina,
                ExtraStamina01 = SafeRatio(extraStamina, maxExtraStamina),
                TotalStamina = totalStamina,
            };
        }
        catch
        {
            return UnavailableStamina("unavailable");
        }
    }

    public static InventoryTelemetry ReadInventory(Character character, bool synchronizationReady)
    {
        const string authority = "master-client-rpc-snapshot";
        var result = new InventoryTelemetry
        {
            Authority = authority,
            BackpackContentsReady = true,
        };

        try
        {
            if (character == null || !synchronizationReady)
            {
                return result;
            }

            Player? player = character.player;
            if (player == null || player.itemSlots == null || player.itemSlots.Length < 3
                || player.backpackSlot == null || player.tempFullSlot == null)
            {
                return result;
            }

            result.Ready = true;
            CharacterItems? items = character.refs?.items;
            if (items != null && items.currentSelectedSlot.IsSome)
            {
                result.SelectedSlotKnown = true;
                result.SelectedSlot = items.currentSelectedSlot.Value;
            }

            Item? currentItem = character.data?.currentItem;
            if (currentItem != null)
            {
                result.Held = ReadLiveItem(currentItem, result.SelectedSlot);
                result.HeldPresent = result.Held != null;
            }

            for (int index = 0; index < 3; index++)
            {
                result.Slots.Add(ReadSlot(
                    player.itemSlots[index],
                    "slot/" + index.ToString(CultureInfo.InvariantCulture),
                    "hotbar",
                    index,
                    index,
                    null));
            }

            InventorySlotTelemetry backpackSlot = ReadSlot(
                player.backpackSlot,
                "slot/3",
                "backpack-slot",
                3,
                3,
                null);
            result.Slots.Add(backpackSlot);

            result.Slots.Add(ReadSlot(
                player.tempFullSlot,
                "slot/250",
                "temporary-overflow",
                250,
                250,
                null));

            if (!backpackSlot.Empty)
            {
                result.BackpackContentsPresent = true;
                result.BackpackContentsReady = false;
                ItemInstanceData? backpackInstance = player.backpackSlot.data;
                if (backpackInstance != null
                    && backpackInstance.TryGetDataEntry<BackpackData>(DataEntryKey.BackpackData, out BackpackData? backpackData)
                    && backpackData?.itemSlots != null)
                {
                    result.BackpackContentsReady = true;
                    string? parentId = backpackSlot.Item?.InstanceId;
                    for (int index = 0; index < backpackData.itemSlots.Length; index++)
                    {
                        result.Slots.Add(ReadSlot(
                            backpackData.itemSlots[index],
                            "backpack/" + index.ToString(CultureInfo.InvariantCulture),
                            "backpack",
                            index,
                            index,
                            parentId));
                    }
                }
            }

            return result;
        }
        catch
        {
            // Never turn a transient spawn/RPC race into a fabricated empty inventory.
            return new InventoryTelemetry
            {
                Ready = false,
                Authority = authority,
                BackpackContentsReady = false,
            };
        }
    }

    public static ItemTelemetry? ReadLiveItem(Item item, int? slot = null)
    {
        if (item == null)
        {
            return null;
        }

        try
        {
            Item canonical = item;
            try
            {
                if (ItemDatabase.TryGetItem(item.itemID, out Item? prefab) && prefab != null)
                {
                    canonical = prefab;
                }
            }
            catch
            {
                // Custom maps/modded items may not be registered in the vanilla database.
            }

            return ReadItem(canonical, item.data, slot);
        }
        catch
        {
            return null;
        }
    }

    private static InventorySlotTelemetry ReadSlot(
        ItemSlot? slot,
        string location,
        string container,
        int index,
        int slotId,
        string? parentInstanceId)
    {
        var result = new InventorySlotTelemetry
        {
            Location = location,
            Container = container,
            Index = index,
            SlotId = slotId,
            Empty = true,
            ParentInstanceId = parentInstanceId,
        };

        if (slot == null || slot.IsEmpty() || slot.prefab == null)
        {
            return result;
        }

        result.Item = ReadItem(slot.prefab, slot.data, slotId);
        result.Empty = result.Item == null;
        return result;
    }

    private static ItemTelemetry? ReadItem(Item prefab, ItemInstanceData? instanceData, int? slot)
    {
        if (prefab == null)
        {
            return null;
        }

        try
        {
            string prefabName = prefab.gameObject != null ? prefab.gameObject.name : prefab.name;
            string nameKey = prefab.UIData?.itemName ?? string.Empty;
            string name = string.IsNullOrWhiteSpace(nameKey) ? prefabName : nameKey;
            Guid guid = instanceData?.guid ?? Guid.Empty;
            return new ItemTelemetry
            {
                Id = prefab.itemID.ToString(CultureInfo.InvariantCulture),
                ItemId = prefab.itemID,
                Name = name,
                DisplayName = name,
                PrefabName = prefabName ?? string.Empty,
                NameKey = nameKey,
                Slot = slot,
                InstanceIdKnown = guid != Guid.Empty,
                InstanceId = guid == Guid.Empty ? null : guid.ToString("D"),
                Data = ReadItemData(instanceData),
            };
        }
        catch
        {
            return null;
        }
    }

    private static List<ItemDataTelemetry> ReadItemData(ItemInstanceData? instanceData)
    {
        var result = new List<ItemDataTelemetry>();
        if (instanceData?.data == null)
        {
            return result;
        }

        KeyValuePair<DataEntryKey, DataEntryValue>[] entries;
        try
        {
            entries = instanceData.data.OrderBy(pair => (int)pair.Key).ToArray();
        }
        catch
        {
            return result;
        }

        foreach (KeyValuePair<DataEntryKey, DataEntryValue> entry in entries)
        {
            ItemDataTelemetry? value = ReadDataEntry(entry.Key, entry.Value);
            if (value != null)
            {
                result.Add(value);
            }
        }
        return result;
    }

    private static ItemDataTelemetry? ReadDataEntry(DataEntryKey key, DataEntryValue? value)
    {
        if (value == null)
        {
            return null;
        }

        var result = new ItemDataTelemetry
        {
            Key = key.ToString(),
            Type = value.GetType().Name,
            HasValue = true,
        };

        switch (value)
        {
            case IntItemData integer:
                result.Value = integer.Value;
                break;
            case OptionableIntItemData optionalInteger:
                result.HasValue = optionalInteger.HasData;
                result.Value = optionalInteger.HasData ? optionalInteger.Value : null;
                break;
            case BoolItemData boolean:
                result.Value = boolean.Value;
                break;
            case OptionableBoolItemData optionalBoolean:
                result.HasValue = optionalBoolean.HasData;
                result.Value = optionalBoolean.HasData ? optionalBoolean.Value : null;
                break;
            case FloatItemData number when IsFinite(number.Value):
                result.Value = number.Value;
                break;
            case ColorItemData color:
                result.Value = new[] { color.Value.r, color.Value.g, color.Value.b, color.Value.a };
                break;
            case BackpackData:
                // Nested item slots are represented structurally in InventoryTelemetry.Slots.
                result.HasValue = false;
                break;
            default:
                return null;
        }

        return result;
    }

    private static StaminaTelemetry UnavailableStamina(string authority)
    {
        return new StaminaTelemetry
        {
            Ready = false,
            Authority = authority,
        };
    }

    private static float SafeRatio(float value, float maximum)
    {
        return maximum <= 0.000001f ? 0f : Mathf.Clamp01(value / maximum);
    }

    private static bool IsFinite(float value)
    {
        return !float.IsNaN(value) && !float.IsInfinity(value);
    }
}
