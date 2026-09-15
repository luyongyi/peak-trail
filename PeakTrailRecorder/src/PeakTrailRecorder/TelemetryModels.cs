using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

/// <summary>
/// A point-in-time stamina reading. Remote values are not considered usable until the
/// CharacterSyncer has received its first owner-authored Photon packet.
/// </summary>
internal sealed class StaminaTelemetry
{
    [JsonProperty("telemetryReady")]
    public bool Ready { get; set; }

    [JsonProperty("authority")]
    public string Authority { get; set; } = "unavailable";

    [JsonProperty("stamina", NullValueHandling = NullValueHandling.Ignore)]
    public float? Stamina { get; set; }

    [JsonProperty("maxStamina", NullValueHandling = NullValueHandling.Ignore)]
    public float? MaxStamina { get; set; }

    [JsonProperty("stamina01", NullValueHandling = NullValueHandling.Ignore)]
    public float? Stamina01 { get; set; }

    [JsonProperty("extraStamina", NullValueHandling = NullValueHandling.Ignore)]
    public float? ExtraStamina { get; set; }

    [JsonProperty("maxExtraStamina", NullValueHandling = NullValueHandling.Ignore)]
    public float? MaxExtraStamina { get; set; }

    [JsonProperty("extraStamina01", NullValueHandling = NullValueHandling.Ignore)]
    public float? ExtraStamina01 { get; set; }

    [JsonProperty("totalStamina", NullValueHandling = NullValueHandling.Ignore)]
    public float? TotalStamina { get; set; }
}

internal sealed class InventoryTelemetry
{
    [JsonProperty("inventoryReady")]
    public bool Ready { get; set; }

    [JsonProperty("authority")]
    public string Authority { get; set; } = "unavailable";

    [JsonProperty("selectedSlotKnown")]
    public bool SelectedSlotKnown { get; set; }

    [JsonProperty("selectedSlot", NullValueHandling = NullValueHandling.Ignore)]
    public int? SelectedSlot { get; set; }

    [JsonProperty("heldPresent")]
    public bool HeldPresent { get; set; }

    [JsonProperty("held", NullValueHandling = NullValueHandling.Include)]
    public ItemTelemetry? Held { get; set; }

    [JsonProperty("backpackContentsPresent")]
    public bool BackpackContentsPresent { get; set; }

    [JsonProperty("backpackContentsReady")]
    public bool BackpackContentsReady { get; set; }

    [JsonProperty("slots")]
    public List<InventorySlotTelemetry> Slots { get; set; } = new();

    public string Fingerprint()
    {
        return JsonConvert.SerializeObject(this, Formatting.None, TelemetryChangeDetector.FingerprintJsonSettings);
    }
}

internal sealed class InventorySlotTelemetry
{
    [JsonProperty("location")]
    public string Location { get; set; } = string.Empty;

    [JsonProperty("container")]
    public string Container { get; set; } = string.Empty;

    [JsonProperty("index")]
    public int Index { get; set; }

    [JsonProperty("slotId")]
    public int SlotId { get; set; }

    [JsonProperty("empty")]
    public bool Empty { get; set; }

    [JsonProperty("parentInstanceId", NullValueHandling = NullValueHandling.Ignore)]
    public string? ParentInstanceId { get; set; }

    [JsonProperty("item", NullValueHandling = NullValueHandling.Include)]
    public ItemTelemetry? Item { get; set; }
}

internal sealed class ItemTelemetry
{
    // id/name/slot/count are intentionally compatible with the lightweight viewer item shape.
    [JsonProperty("id")]
    public string Id { get; set; } = string.Empty;

    [JsonProperty("itemId")]
    public int ItemId { get; set; }

    [JsonProperty("name")]
    public string Name { get; set; } = string.Empty;

    [JsonProperty("displayName")]
    public string DisplayName { get; set; } = string.Empty;

    [JsonProperty("prefabName")]
    public string PrefabName { get; set; } = string.Empty;

    [JsonProperty("nameKey")]
    public string NameKey { get; set; } = string.Empty;

    [JsonProperty("slot", NullValueHandling = NullValueHandling.Ignore)]
    public int? Slot { get; set; }

    [JsonProperty("count")]
    public int Count { get; set; } = 1;

    [JsonProperty("instanceIdKnown")]
    public bool InstanceIdKnown { get; set; }

    [JsonProperty("instanceId", NullValueHandling = NullValueHandling.Ignore)]
    public string? InstanceId { get; set; }

    [JsonProperty("data")]
    public List<ItemDataTelemetry> Data { get; set; } = new();

    [JsonIgnore]
    public string IdentityFingerprint => ItemId.ToString(CultureInfo.InvariantCulture) + "\n" + PrefabName;

    [JsonIgnore]
    public string StateFingerprint => string.Join(
        "\n",
        Id,
        ItemId.ToString(CultureInfo.InvariantCulture),
        PrefabName,
        NameKey,
        InstanceId ?? string.Empty,
        JsonConvert.SerializeObject(Data, Formatting.None, TelemetryChangeDetector.FingerprintJsonSettings));

    [JsonIgnore]
    public string TrackingKey => InstanceIdKnown && !string.IsNullOrWhiteSpace(InstanceId)
        ? "guid:" + InstanceId
        : "item:" + IdentityFingerprint;
}

internal sealed class ItemDataTelemetry
{
    [JsonProperty("key")]
    public string Key { get; set; } = string.Empty;

    [JsonProperty("type")]
    public string Type { get; set; } = string.Empty;

    [JsonProperty("hasValue")]
    public bool HasValue { get; set; }

    [JsonProperty("value", NullValueHandling = NullValueHandling.Ignore)]
    public object? Value { get; set; }
}

internal sealed class InventoryDelta
{
    public string EventName { get; set; } = string.Empty;

    public ItemTelemetry Item { get; set; } = null!;

    public string? FromLocation { get; set; }

    public string? ToLocation { get; set; }
}

internal static class TelemetryChangeDetector
{
    internal static readonly JsonSerializerSettings FingerprintJsonSettings = new()
    {
        Culture = CultureInfo.InvariantCulture,
        NullValueHandling = NullValueHandling.Include,
    };

    public static bool HasMeaningfulStaminaChange(
        StaminaTelemetry? previous,
        StaminaTelemetry current,
        float threshold)
    {
        if (previous == null || previous.Ready != current.Ready
            || !string.Equals(previous.Authority, current.Authority, StringComparison.Ordinal))
        {
            return true;
        }

        if (!current.Ready)
        {
            return false;
        }

        return Different(previous.Stamina, current.Stamina, threshold)
            || Different(previous.MaxStamina, current.MaxStamina, threshold)
            || Different(previous.ExtraStamina, current.ExtraStamina, threshold)
            || Different(previous.MaxExtraStamina, current.MaxExtraStamina, threshold)
            || Different(previous.TotalStamina, current.TotalStamina, threshold);
    }

    public static IReadOnlyList<InventoryDelta> DiffInventory(
        InventoryTelemetry previous,
        InventoryTelemetry current)
    {
        if (!previous.Ready || !current.Ready)
        {
            return Array.Empty<InventoryDelta>();
        }

        Dictionary<string, InventorySlotTelemetry> oldItems = IndexOccupiedSlots(previous.Slots);
        Dictionary<string, InventorySlotTelemetry> newItems = IndexOccupiedSlots(current.Slots);
        var changes = new List<InventoryDelta>();

        foreach (KeyValuePair<string, InventorySlotTelemetry> pair in oldItems.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!newItems.TryGetValue(pair.Key, out InventorySlotTelemetry? next))
            {
                changes.Add(new InventoryDelta
                {
                    EventName = "item_lost",
                    Item = pair.Value.Item!,
                    FromLocation = pair.Value.Location,
                });
                continue;
            }

            ItemTelemetry beforeItem = pair.Value.Item!;
            ItemTelemetry afterItem = next.Item!;
            if (!string.Equals(beforeItem.IdentityFingerprint, afterItem.IdentityFingerprint, StringComparison.Ordinal))
            {
                // A GUID-less slot replacement uses its location as a fallback key. Treat it as
                // a loss plus acquisition instead of claiming the object changed type in place.
                changes.Add(new InventoryDelta
                {
                    EventName = "item_lost",
                    Item = beforeItem,
                    FromLocation = pair.Value.Location,
                });
                changes.Add(new InventoryDelta
                {
                    EventName = "item_acquired",
                    Item = afterItem,
                    ToLocation = next.Location,
                });
                continue;
            }

            if (!string.Equals(pair.Value.Location, next.Location, StringComparison.Ordinal))
            {
                changes.Add(new InventoryDelta
                {
                    EventName = "item_moved",
                    Item = afterItem,
                    FromLocation = pair.Value.Location,
                    ToLocation = next.Location,
                });
            }

            if (!string.Equals(beforeItem.StateFingerprint, afterItem.StateFingerprint, StringComparison.Ordinal))
            {
                changes.Add(new InventoryDelta
                {
                    EventName = "item_state_changed",
                    Item = afterItem,
                    FromLocation = pair.Value.Location,
                    ToLocation = next.Location,
                });
            }
        }

        foreach (KeyValuePair<string, InventorySlotTelemetry> pair in newItems.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (!oldItems.ContainsKey(pair.Key))
            {
                changes.Add(new InventoryDelta
                {
                    EventName = "item_acquired",
                    Item = pair.Value.Item!,
                    ToLocation = pair.Value.Location,
                });
            }
        }

        AppendHeldChanges(previous.Held, current.Held, changes);

        return changes;
    }

    private static bool Different(float? left, float? right, float threshold)
    {
        if (!left.HasValue || !right.HasValue)
        {
            return left.HasValue != right.HasValue;
        }

        return Math.Abs(left.Value - right.Value) >= Math.Max(0f, threshold);
    }

    private static Dictionary<string, InventorySlotTelemetry> IndexOccupiedSlots(
        IEnumerable<InventorySlotTelemetry> slots)
    {
        var result = new Dictionary<string, InventorySlotTelemetry>(StringComparer.Ordinal);
        foreach (InventorySlotTelemetry slot in slots)
        {
            if (slot.Empty || slot.Item == null)
            {
                continue;
            }

            string key = slot.Item.InstanceIdKnown && !string.IsNullOrWhiteSpace(slot.Item.InstanceId)
                ? "guid:" + slot.Item.InstanceId
                : "location:" + slot.Location;

            // A duplicate instance GUID is malformed/transient. Retaining the first observation
            // prevents a later duplicate from fabricating a move between two simultaneous slots.
            result.TryAdd(key, slot);
        }
        return result;
    }

    private static void AppendHeldChanges(
        ItemTelemetry? previous,
        ItemTelemetry? current,
        List<InventoryDelta> changes)
    {
        if (previous == null && current == null)
        {
            return;
        }

        if (previous == null)
        {
            changes.Add(new InventoryDelta
            {
                EventName = "item_equipped",
                Item = current!,
                ToLocation = HeldLocation(current!),
            });
            return;
        }

        if (current == null)
        {
            changes.Add(new InventoryDelta
            {
                EventName = "item_unequipped",
                Item = previous,
                FromLocation = HeldLocation(previous),
            });
            return;
        }

        if (!string.Equals(previous.TrackingKey, current.TrackingKey, StringComparison.Ordinal))
        {
            changes.Add(new InventoryDelta
            {
                EventName = "item_unequipped",
                Item = previous,
                FromLocation = HeldLocation(previous),
            });
            changes.Add(new InventoryDelta
            {
                EventName = "item_equipped",
                Item = current,
                ToLocation = HeldLocation(current),
            });
            return;
        }

        if (previous.Slot != current.Slot)
        {
            changes.Add(new InventoryDelta
            {
                EventName = "item_moved",
                Item = current,
                FromLocation = HeldLocation(previous),
                ToLocation = HeldLocation(current),
            });
        }
    }

    private static string HeldLocation(ItemTelemetry item)
    {
        return item.Slot.HasValue
            ? "held/" + item.Slot.Value.ToString(CultureInfo.InvariantCulture)
            : "held/unknown";
    }
}
