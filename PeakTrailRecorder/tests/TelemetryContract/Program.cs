using PeakTrailRecorder;

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

var staminaA = NewStamina(ready: true, stamina: 0.800f);
var staminaBelowThreshold = NewStamina(ready: true, stamina: 0.799f);
var staminaAtThreshold = NewStamina(ready: true, stamina: 0.798f);
var staminaUnavailable = new StaminaTelemetry
{
    Ready = false,
    Authority = "photon-owner-sync",
};

Assert(!TelemetryChangeDetector.HasMeaningfulStaminaChange(staminaA, staminaBelowThreshold, 0.002f),
    "A sub-threshold stamina delta should not emit a change.");
Assert(TelemetryChangeDetector.HasMeaningfulStaminaChange(staminaA, staminaAtThreshold, 0.002f),
    "A stamina delta at the threshold should emit a change.");
Assert(TelemetryChangeDetector.HasMeaningfulStaminaChange(staminaUnavailable, staminaA, 0.002f),
    "The remote-ready transition must emit a state record.");

var capacityUnknown = NewStamina(ready: true, stamina: .8f);
capacityUnknown.CapacityReady = false;
capacityUnknown.MaxStamina = null;
capacityUnknown.Stamina01 = null;
var capacityKnown = NewStamina(ready: true, stamina: .8f);
capacityKnown.CapacityReady = true;
Assert(TelemetryChangeDetector.HasMeaningfulStaminaChange(capacityUnknown, capacityKnown, .002f),
    "A separately received status-capacity packet must emit state even when current stamina did not change.");
Assert(TelemetryChangeDetector.HasMeaningfulStaminaChange(capacityKnown, capacityUnknown, .002f),
    "Losing status readiness must invalidate previous capacity.");
string incompleteJson = Newtonsoft.Json.JsonConvert.SerializeObject(capacityUnknown);
Assert(!incompleteJson.Contains("maxStamina") && !incompleteJson.Contains("stamina01"),
    "Unknown capacity must be omitted, not serialized as a fabricated healthy maximum.");

var oldInventory = NewInventory(ready: true);
var movedInventory = NewInventory(ready: true);
AddSlot(oldInventory, "slot/0", "hotbar", 0, NewItem("7", "rope", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0, uses: 3));
AddSlot(movedInventory, "backpack/1", "backpack", 1, NewItem("7", "rope", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 1, uses: 3));
string[] moveEvents = TelemetryChangeDetector.DiffInventory(oldInventory, movedInventory)
    .Select(delta => delta.EventName)
    .ToArray();
Assert(moveEvents.SequenceEqual(new[] { "item_moved" }),
    "Moving an item must not also fabricate item_state_changed.");

var changedInventory = NewInventory(ready: true);
AddSlot(changedInventory, "slot/0", "hotbar", 0, NewItem("7", "rope", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0, uses: 2));
string[] stateEvents = TelemetryChangeDetector.DiffInventory(oldInventory, changedInventory)
    .Select(delta => delta.EventName)
    .ToArray();
Assert(stateEvents.SequenceEqual(new[] { "item_state_changed" }),
    "A real instance-data change should emit item_state_changed.");

var unequippedInventory = NewInventory(ready: true);
var equippedInventory = NewInventory(ready: true);
equippedInventory.Held = NewItem("7", "rope", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", 0, uses: 3);
equippedInventory.HeldPresent = true;
string[] equipEvents = TelemetryChangeDetector.DiffInventory(unequippedInventory, equippedInventory)
    .Select(delta => delta.EventName)
    .ToArray();
Assert(equipEvents.SequenceEqual(new[] { "item_equipped" }),
    "A held-state transition should emit item_equipped without acquired/lost.");

var unavailableInventory = NewInventory(ready: false);
Assert(TelemetryChangeDetector.DiffInventory(unavailableInventory, oldInventory).Count == 0,
    "Recovering from an unavailable snapshot must not fabricate acquisitions.");

DateTimeOffset sameStart = DateTimeOffset.Parse(
    "2026-09-15T10:00:00.1234567+00:00",
    System.Globalization.CultureInfo.InvariantCulture);
string sessionA = SessionIdentity.Create(sameStart, Guid.Parse("11111111-1111-1111-1111-111111111111"));
string sessionB = SessionIdentity.Create(sameStart, Guid.Parse("22222222-2222-2222-2222-222222222222"));
Assert(sessionA != sessionB, "Every RecordingSession needs a unique journal key even within one run.");
Assert(sessionA.StartsWith("20260915T100000.1234567Z-", StringComparison.Ordinal),
    "Session IDs should retain a sortable UTC start timestamp.");

Console.WriteLine("PeakTrail telemetry contract passed.");

static StaminaTelemetry NewStamina(bool ready, float stamina)
{
    return new StaminaTelemetry
    {
        Ready = ready,
        Authority = "photon-owner-sync",
        Stamina = stamina,
        MaxStamina = 1f,
        Stamina01 = stamina,
        ExtraStamina = 0.2f,
        MaxExtraStamina = 1f,
        ExtraStamina01 = 0.2f,
        TotalStamina = stamina + 0.2f,
    };
}

static InventoryTelemetry NewInventory(bool ready)
{
    return new InventoryTelemetry
    {
        Ready = ready,
        Authority = "master-client-rpc-snapshot",
    };
}

static ItemTelemetry NewItem(string id, string prefabName, string instanceId, int slot, int uses)
{
    return new ItemTelemetry
    {
        Id = id,
        ItemId = int.Parse(id, System.Globalization.CultureInfo.InvariantCulture),
        Name = prefabName,
        DisplayName = prefabName,
        PrefabName = prefabName,
        NameKey = prefabName,
        Slot = slot,
        InstanceIdKnown = true,
        InstanceId = instanceId,
        Data = new List<ItemDataTelemetry>
        {
            new()
            {
                Key = "ItemUses",
                Type = "OptionableIntItemData",
                HasValue = true,
                Value = uses,
            },
        },
    };
}

static void AddSlot(
    InventoryTelemetry inventory,
    string location,
    string container,
    int index,
    ItemTelemetry item)
{
    inventory.Slots.Add(new InventorySlotTelemetry
    {
        Location = location,
        Container = container,
        Index = index,
        SlotId = index,
        Empty = false,
        Item = item,
    });
}
