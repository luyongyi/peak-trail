using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

/// <summary>A complete observed bar snapshot, never a reconstruction from item uses.</summary>
internal sealed class StatusTelemetry
{
    [JsonProperty("ready")] public bool Ready { get; set; }
    [JsonProperty("complete")] public bool Complete => Ready;
    [JsonProperty("authority")] public string Authority { get; set; } = "unavailable";
    [JsonProperty("source")] public string Source { get; set; } = "recorded";
    [JsonProperty("gameSource")] public string GameSource { get; set; } = "CharacterAfflictions.currentStatuses+CharacterData.petrifyAmount";
    [JsonProperty("dead", NullValueHandling = NullValueHandling.Ignore)] public bool? Dead { get; set; }
    [JsonProperty("values")] public List<StatusValueTelemetry> Values { get; set; } = new();
    [JsonProperty("statusSum", NullValueHandling = NullValueHandling.Ignore)] public float? StatusSum { get; set; }
    [JsonProperty("baseMaxStamina", NullValueHandling = NullValueHandling.Ignore)] public float? BaseMaxStamina { get; set; }
    [JsonProperty("maxStamina", NullValueHandling = NullValueHandling.Ignore)] public float? MaxStamina { get; set; }
    [JsonProperty("baseMaxExtraStamina", NullValueHandling = NullValueHandling.Ignore)] public float? BaseMaxExtraStamina { get; set; }
    [JsonProperty("maxExtraStamina", NullValueHandling = NullValueHandling.Ignore)] public float? MaxExtraStamina { get; set; }
    [JsonProperty("effectsReady")] public bool EffectsReady { get; set; }
    [JsonProperty("effectsAuthority")] public string EffectsAuthority { get; set; } = "unavailable";
    [JsonProperty("effects")] public List<StatusEffectTelemetry> Effects { get; set; } = new();

    public string Fingerprint() => JsonConvert.SerializeObject(this, Formatting.None, TelemetryChangeDetector.FingerprintJsonSettings);

    public string ChangeReason(StatusTelemetry? previous)
    {
        if (previous == null) return "initial";
        if (Dead == true && previous.Dead != true) return "death";
        if (Dead == false && previous.Dead == true) return "revive";
        if (Ready && previous.Ready && Values.All(value => value.Amount == 0f)
            && previous.Values.Any(value => value.Amount > 0f)) return "cleared";
        return "changed";
    }
}

internal sealed class StatusValueTelemetry
{
    [JsonProperty("id")] public int Id { get; set; }
    [JsonProperty("type")] public string Type { get; set; } = string.Empty;
    [JsonProperty("amount")] public float Amount { get; set; }
    [JsonProperty("staminaBlock")] public float StaminaBlock { get; set; }
    [JsonProperty("extraStaminaBlock")] public float ExtraStaminaBlock { get; set; }
}

internal sealed class StatusEffectTelemetry
{
    [JsonProperty("typeId")] public int TypeId { get; set; }
    [JsonProperty("type")] public string Type { get; set; } = string.Empty;
}

/// <summary>Receipt identity includes room, owner, view and the initialized status array.
/// A fresh zero array, reused view ID or ownership transfer is not synchronization evidence.</summary>
internal sealed class StatusReceiptEvidence
{
    private object? _room;
    private object? _statusArray;
    private int _owner;
    private int _view;
    private bool _statuses;
    private bool _effects;

    public void Observe(object room, int owner, int view, object statusArray, bool effects)
    {
        if (!Matches(room, owner, view, statusArray))
        {
            _room = room;
            _owner = owner;
            _view = view;
            _statusArray = statusArray;
            _statuses = _effects = false;
        }
        if (effects) _effects = true;
        else _statuses = true;
    }

    public bool Ready(object? room, int owner, int view, object? statusArray, bool effects)
    {
        if (!Matches(room, owner, view, statusArray))
        {
            // A later return to the same IDs/array must not resurrect an earlier receipt.
            _room = _statusArray = null;
            _owner = _view = 0;
            _statuses = _effects = false;
            return false;
        }
        return effects ? _effects : _statuses;
    }

    private bool Matches(object? room, int owner, int view, object? statusArray)
        => room != null && statusArray != null && owner > 0 && view > 0
            && ReferenceEquals(_room, room) && ReferenceEquals(_statusArray, statusArray)
            && _owner == owner && _view == view;
}
