using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using BepInEx.Logging;
using Newtonsoft.Json;
using Steamworks;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PeakTrailRecorder;

internal sealed class RecordingSession : IDisposable
{
    private const float StaminaChangeThreshold = 0.002f;
    private const long StateHeartbeatMilliseconds = 1_000L;
    private const long InventorySynchronizationGraceMilliseconds = 2_000L;

    private static readonly JsonSerializerSettings CompactJsonSettings = new()
    {
        NullValueHandling = NullValueHandling.Ignore,
        Culture = CultureInfo.InvariantCulture,
    };

    private readonly ManualLogSource _log;
    private readonly FileStream _stream;
    private readonly StreamWriter _writer;
    private readonly AppendOnlyHistoryLog? _history;
    private readonly WorldTelemetryReader _world;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Dictionary<int, TrackedPlayer> _tracked = new();
    private readonly Dictionary<int, PlayerIdentity> _announced = new();
    private readonly string _manifestPartialPath;
    private readonly string _streamPartialPath;
    private int _lastActiveSegment;
    private long _nextRouteCheckAtMs;
    private string _lastRouteFingerprint = string.Empty;
    private bool _disposed;

    public RecordingSession(string outputRoot, float sampleHz, ManualLogSource log)
    {
        _log = log;
        Scene scene = SceneManager.GetActiveScene();
        int levelIndex = GetLevelIndex();
        int mapSlot = ResolveMapSlot(scene.name, levelIndex);
        object gameBuildId = GetGameBuildId();
        Guid runId = RunManager.Instance != null ? RunManager.Instance.RunId : Guid.Empty;
        DateTimeOffset startedAt = DateTimeOffset.UtcNow;
        string sessionId = SessionIdentity.Create(startedAt, Guid.NewGuid());

        string directoryName = SanitizeFileName(
            startedAt.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture)
            + "_" + scene.name + "_" + sessionId[..Math.Min(sessionId.Length, 12)]);
        SessionDirectory = CreateUniqueDirectory(outputRoot, directoryName);
        _manifestPartialPath = Path.Combine(SessionDirectory, "manifest.partial.json");
        _streamPartialPath = Path.Combine(SessionDirectory, "stream.ndjson.partial");

        Manifest = new TraceManifest
        {
            SessionId = sessionId,
            RunId = runId == Guid.Empty ? string.Empty : runId.ToString("D"),
            StartedAtUtc = startedAt.ToString("O", CultureInfo.InvariantCulture),
            GameVersion = string.IsNullOrWhiteSpace(Application.version) ? "unknown" : Application.version,
            GameBuildId = gameBuildId,
            RecorderVersion = Plugin.RecorderVersion,
            SceneName = string.IsNullOrWhiteSpace(scene.name) ? "unknown" : scene.name,
            LevelIndex = levelIndex,
            MapSlot = mapSlot,
            SampleHz = sampleHz,
            Route = RouteTelemetryReader.Read(),
            WorldTelemetry = WorldTelemetryTracker.Capabilities(WorldTelemetryHooks.Installed, WorldTelemetryHooks.NetworkSpawnInstalled),
        };

        RunManagerInstanceId = RunManager.Instance != null ? RunManager.Instance.GetInstanceID() : 0;
        _lastActiveSegment = GetActiveSegment();

        Directory.CreateDirectory(SessionDirectory);
        AtomicWriteManifest();

        _stream = new FileStream(
            _streamPartialPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.Read,
            16 * 1024,
            FileOptions.SequentialScan);
        _writer = new StreamWriter(_stream, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), 16 * 1024)
        {
            AutoFlush = true,
        };

        _history = AppendOnlyHistoryLog.TryOpen(outputRoot, _log);
        _world = new WorldTelemetryReader(WriteRecord, () => ElapsedMilliseconds, _log);
        WorldTelemetryHooks.Active = _world;
        _history?.WriteSessionStart(Manifest);
        WriteRouteIfChanged(Manifest.Route, 0);
        WriteEvent("segment_change", null, _lastActiveSegment, null, "session_start");
        _log.LogInfo($"Recording PEAK trail to '{SessionDirectory}'.");
    }

    public string SessionDirectory { get; }

    public int RunManagerInstanceId { get; }

    public TraceManifest Manifest { get; }

    public string SceneName => Manifest.SceneName;

    public long ElapsedMilliseconds => _clock.ElapsedMilliseconds;

    public void SampleWorld()
    {
        if (!_disposed) _world.Sample();
    }

    public void UpdateRunId()
    {
        if (_disposed || RunManager.Instance == null || RunManager.Instance.RunId == Guid.Empty)
        {
            return;
        }

        string current = RunManager.Instance.RunId.ToString("D");
        if (string.Equals(Manifest.RunId, current, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        Manifest.RunId = current;
        // A timestamp session ID remains valid when the host had not assigned RunId yet.
        AtomicWriteManifest();
    }

    public void ReconcilePlayers(IReadOnlyCollection<Character> characters)
    {
        if (_disposed)
        {
            return;
        }

        var presentActors = new HashSet<int>();
        foreach (Character character in characters)
        {
            if (character == null || character.isBot || character.photonView == null || character.photonView.Owner == null)
            {
                continue;
            }

            int actorNumber = character.photonView.Owner.ActorNumber;
            presentActors.Add(actorNumber);
            EnsureTracked(character);
        }

        foreach (int actorNumber in _tracked.Keys.Where(actor => !presentActors.Contains(actor)).ToArray())
        {
            RemovePlayer(actorNumber, "poll_reconciliation");
        }
    }

    public void OnPhotonPlayerConnected(Photon.Realtime.Player player)
    {
        if (_disposed || player == null)
        {
            return;
        }

        PlayerIdentity identity = IdentityResolver.FromPhotonPlayer(player);
        Announce(identity, emitJoin: true, "photon_event");
    }

    public void OnPhotonPlayerDisconnected(Photon.Realtime.Player player)
    {
        if (_disposed || player == null)
        {
            return;
        }

        RemovePlayer(player.ActorNumber, "photon_event");
    }

    public void OnCharacterPassedOut(Character character)
    {
        TrackedPlayer? player = EnsureTracked(character);
        if (player == null)
        {
            return;
        }

        player.WasPassedOut = true;
        WritePlayerEvent("passed_out", player, "game_event");
    }

    public void OnCharacterDied(Character character)
    {
        TrackedPlayer? player = EnsureTracked(character);
        if (player == null)
        {
            return;
        }

        player.WasDead = true;
        player.WasPassedOut = true;
        WritePlayerEvent("death", player, "game_event");
    }

    public void OnItemConsumed(Item item, Character character)
    {
        TrackedPlayer? player = EnsureTracked(character);
        if (player == null)
        {
            return;
        }

        WriteItemEvent(
            "item_consumed",
            player,
            PlayerTelemetryReader.ReadLiveItem(item, GetSelectedSlot(character)),
            ElapsedMilliseconds,
            GetPosition(character),
            "game_event",
            "authoritative-rpc",
            "consumed");
    }

    public void OnItemThrown(Item item)
    {
        if (item == null)
        {
            return;
        }

        Character? character;
        try
        {
            character = item.lastThrownCharacter;
        }
        catch
        {
            return;
        }

        TrackedPlayer? player = EnsureTracked(character);
        if (player == null)
        {
            return;
        }

        Vector3 position;
        try
        {
            position = item.transform.position;
        }
        catch
        {
            position = GetPosition(character);
        }

        var extra = new Dictionary<string, object?>();
        try
        {
            extra["throwCharge"] = item.lastThrownAmount;
        }
        catch
        {
            // Older builds may not expose the throw-charge diagnostic.
        }

        WriteItemEvent(
            "item_thrown",
            player,
            PlayerTelemetryReader.ReadLiveItem(item),
            ElapsedMilliseconds,
            position,
            "game_event",
            "authoritative-rpc",
            "thrown",
            extra: extra);
    }

    public void SamplePlayers(float minimumDistance, float minimumYawDegrees, float maximumSilenceSeconds)
    {
        if (_disposed)
        {
            return;
        }

        long routeCheckAtMs = ElapsedMilliseconds;
        if (routeCheckAtMs >= _nextRouteCheckAtMs)
        {
            _nextRouteCheckAtMs = routeCheckAtMs + 1_000L;
            WriteRouteIfChanged(RouteTelemetryReader.Read(), routeCheckAtMs);
        }

        int activeSegment = GetActiveSegment();
        if (activeSegment != _lastActiveSegment)
        {
            _lastActiveSegment = activeSegment;
            WriteEvent("segment_change", null, activeSegment, null, "poll_reconciliation");
            foreach (TrackedPlayer player in _tracked.Values)
            {
                player.HasSample = false;
            }
        }

        long nowMs = ElapsedMilliseconds;
        long maxSilenceMs = Math.Max(1L, (long)Math.Round(maximumSilenceSeconds * 1000.0));
        foreach (TrackedPlayer player in _tracked.Values.ToArray())
        {
            Character character = player.Character;
            if (character == null)
            {
                continue;
            }

            bool isDead = character.data != null && character.data.dead;
            bool isPassedOut = character.data != null
                && (character.data.passedOut || character.data.fullyPassedOut);

            if (isDead != player.WasDead)
            {
                player.WasDead = isDead;
                if (isDead)
                {
                    WritePlayerEvent("death", player, "poll_reconciliation");
                }
                else
                {
                    WritePlayerEvent("revive", player, "poll_reconciliation");
                }
            }
            if (isPassedOut != player.WasPassedOut)
            {
                player.WasPassedOut = isPassedOut;
                WritePlayerEvent(isPassedOut ? "passed_out" : "recovered", player, "poll_reconciliation");
            }

            Vector3 position = GetPosition(character);
            float yaw = GetYaw(character);

            AppearanceTelemetry? appearance = PlayerAppearanceReader.Read(character, nowMs - player.FirstObservedAtMs);
            if (appearance != null)
            {
                string appearanceFingerprint = appearance.Fingerprint();
                if (!string.Equals(player.LastAppearanceFingerprint, appearanceFingerprint, StringComparison.Ordinal))
                {
                    WriteRecord(new Dictionary<string, object?>
                    {
                        ["type"] = "appearance",
                        ["t"] = nowMs,
                        ["playerId"] = player.Identity.PlayerId,
                        ["appearance"] = appearance,
                    });
                    player.LastAppearanceFingerprint = appearanceFingerprint;
                }
            }

            StaminaTelemetry stamina = PlayerTelemetryReader.ReadStamina(character);
            bool staminaChanged = TelemetryChangeDetector.HasMeaningfulStaminaChange(
                player.LastStamina,
                stamina,
                StaminaChangeThreshold);
            bool staminaHeartbeat = player.LastStamina == null
                || nowMs - player.LastStateAtMs >= StateHeartbeatMilliseconds;
            if (staminaChanged || staminaHeartbeat)
            {
                WriteState(player.Identity.PlayerId, stamina, activeSegment, nowMs);
                player.LastStamina = stamina;
                player.LastStateAtMs = nowMs;
            }

            bool inventorySynchronizationReady = IsInventorySynchronizationReady(
                character,
                stamina,
                player.FirstObservedAtMs,
                nowMs);
            InventoryTelemetry inventory = PlayerTelemetryReader.ReadInventory(
                character,
                inventorySynchronizationReady);
            string inventoryFingerprint = inventory.Fingerprint();
            bool inventoryChanged = player.LastInventory == null
                || !string.Equals(
                    player.LastInventoryFingerprint,
                    inventoryFingerprint,
                    StringComparison.Ordinal);
            if (inventoryChanged)
            {
                WriteInventory(player.Identity.PlayerId, inventory, activeSegment, nowMs);
                if (player.LastInventory != null)
                {
                    WriteInventoryEvents(player, player.LastInventory, inventory, position, activeSegment, nowMs);
                }
                player.LastInventory = inventory;
                player.LastInventoryFingerprint = inventoryFingerprint;
            }

            bool moved = !player.HasSample
                || Vector3.Distance(position, player.LastPosition) >= minimumDistance;
            bool turned = !player.HasSample
                || Mathf.Abs(Mathf.DeltaAngle(yaw, player.LastYaw)) >= minimumYawDegrees;
            bool stale = !player.HasSample || nowMs - player.LastSampleAtMs >= maxSilenceMs;

            if (!moved && !turned && !stale)
            {
                continue;
            }

            WriteSample(player.Identity.PlayerId, position, yaw, activeSegment, nowMs, stamina, inventory);
            player.HasSample = true;
            player.LastPosition = position;
            player.LastYaw = yaw;
            player.LastSampleAtMs = nowMs;
        }
    }

    public void Complete(string reason)
    {
        if (_disposed)
        {
            return;
        }

        WriteEvent("run_end", null, GetActiveSegment(), null, reason);
        Manifest.Status = "complete";
        Manifest.EndReason = reason;
        Manifest.EndedAtUtc = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        // Persist completion state to the partial manifest before any rename. If the process
        // exits between the following operations, either the partial or final pair is usable.
        AtomicWriteManifest();
        _history?.WriteSessionEnd(Manifest, ElapsedMilliseconds);
        DisposeWriter();

        string finalStream = Path.Combine(SessionDirectory, "stream.ndjson");
        string finalManifest = Path.Combine(SessionDirectory, "manifest.json");
        try
        {
            File.Move(_streamPartialPath, finalStream);
            AtomicWriteJson(finalManifest, Manifest);
            if (File.Exists(_manifestPartialPath))
            {
                File.Delete(_manifestPartialPath);
            }
            _log.LogInfo($"Completed PEAK trail recording '{SessionDirectory}'.");
        }
        catch (Exception exception)
        {
            // Leave partial files intact whenever finalization is interrupted. The viewer can
            // recover every complete NDJSON line without trusting the possibly truncated tail.
            _log.LogError($"Could not finalize trail recording; partial files remain: {exception}");
        }
    }

    public void Dispose()
    {
        if (!_disposed)
        {
            Complete("recorder_disposed");
        }
    }

    private TrackedPlayer? EnsureTracked(Character character)
    {
        if (_disposed || character == null || character.isBot || character.photonView?.Owner == null)
        {
            return null;
        }

        int actorNumber = character.photonView.Owner.ActorNumber;
        if (_tracked.TryGetValue(actorNumber, out TrackedPlayer? existing))
        {
            if (existing.Character == character)
            {
                return existing;
            }
            DetachCharacterCallbacks(existing);
        }

        PlayerIdentity identity;
        if (!_announced.TryGetValue(actorNumber, out identity!))
        {
            identity = IdentityResolver.FromCharacter(character);
            Announce(identity, emitJoin: true, "poll_reconciliation");
        }

        var player = new TrackedPlayer
        {
            Character = character,
            Identity = identity,
            FirstObservedAtMs = ElapsedMilliseconds,
            WasDead = character.data != null && character.data.dead,
            WasPassedOut = character.data != null
                && (character.data.passedOut || character.data.fullyPassedOut),
        };
        player.ReviveHandler = () => OnRevived(player);
        player.WarpHandler = _ => OnWarped(player);
        character.reviveAction += player.ReviveHandler;
        character.WarpCompleted += player.WarpHandler;
        _tracked[actorNumber] = player;
        return player;
    }

    private void Announce(PlayerIdentity identity, bool emitJoin, string source)
    {
        if (_announced.ContainsKey(identity.ActorNumber))
        {
            return;
        }

        _announced[identity.ActorNumber] = identity;
        long nowMs = ElapsedMilliseconds;
        Manifest.Participants.Add(new ParticipantInfo
        {
            PlayerId = identity.PlayerId,
            Nickname = identity.Nickname,
            ActorNumber = identity.ActorNumber,
            Platform = identity.Platform,
            IdSource = identity.IdSource,
            FirstSeenAtMs = nowMs,
        });

        WriteRecord(new Dictionary<string, object?>
        {
            ["type"] = "participant",
            ["t"] = nowMs,
            ["playerId"] = identity.PlayerId,
            ["nickname"] = identity.Nickname,
            ["actorNumber"] = identity.ActorNumber,
            ["platform"] = identity.Platform,
            ["idSource"] = identity.IdSource,
        });
        if (emitJoin)
        {
            WriteEvent("join", identity.PlayerId, GetActiveSegment(), null, source);
        }
        AtomicWriteManifest();
    }

    private void RemovePlayer(int actorNumber, string source)
    {
        if (_tracked.TryGetValue(actorNumber, out TrackedPlayer? tracked))
        {
            WritePlayerEvent("leave", tracked, source);
            DetachCharacterCallbacks(tracked);
            _tracked.Remove(actorNumber);
            _announced.Remove(actorNumber);
            return;
        }

        if (_announced.TryGetValue(actorNumber, out PlayerIdentity? identity))
        {
            WriteEvent("leave", identity.PlayerId, GetActiveSegment(), null, source);
            _announced.Remove(actorNumber);
        }
    }

    private void OnRevived(TrackedPlayer player)
    {
        player.WasDead = false;
        player.WasPassedOut = false;
        player.HasSample = false;
        WritePlayerEvent("revive", player, "character_callback");
    }

    private void OnWarped(TrackedPlayer player)
    {
        player.HasSample = false;
        WritePlayerEvent("warp", player, "character_callback");
    }

    private void WriteSample(
        string playerId,
        Vector3 position,
        float yaw,
        int activeSegment,
        long nowMs,
        StaminaTelemetry stamina,
        InventoryTelemetry inventory)
    {
        var record = new Dictionary<string, object?>
        {
            ["type"] = "sample",
            ["t"] = nowMs,
            ["playerId"] = playerId,
            ["pos"] = PositionArray(position),
            ["yaw"] = yaw,
            // MapHandler exposes one scene-wide progression value, not a reliable owning
            // layer for each synchronized character. Preserve it under an explicit name;
            // XYZ remains authoritative and segment stays absent until it can be inferred.
            ["activeSegment"] = activeSegment,
        };
        AddStaminaFields(record, stamina);
        if (inventory.Ready && inventory.HeldPresent && inventory.Held != null)
        {
            record["item"] = inventory.Held;
        }
        WriteRecord(record);
    }

    private void WriteState(string playerId, StaminaTelemetry stamina, int activeSegment, long nowMs)
    {
        var record = new Dictionary<string, object?>
        {
            ["type"] = "state",
            ["t"] = nowMs,
            ["playerId"] = playerId,
            ["telemetryReady"] = stamina.Ready,
            ["authority"] = stamina.Authority,
            ["activeSegment"] = activeSegment,
        };
        AddStaminaFields(record, stamina);
        WriteRecord(record);
    }

    private void WriteInventory(string playerId, InventoryTelemetry inventory, int activeSegment, long nowMs)
    {
        WriteRecord(new Dictionary<string, object?>
        {
            ["type"] = "inventory",
            ["t"] = nowMs,
            ["playerId"] = playerId,
            ["inventoryReady"] = inventory.Ready,
            ["authority"] = inventory.Authority,
            ["selectedSlotKnown"] = inventory.SelectedSlotKnown,
            ["selectedSlot"] = inventory.SelectedSlot,
            ["heldPresent"] = inventory.HeldPresent,
            ["held"] = inventory.Held,
            ["backpackContentsPresent"] = inventory.BackpackContentsPresent,
            ["backpackContentsReady"] = inventory.BackpackContentsReady,
            ["slots"] = inventory.Slots,
            ["activeSegment"] = activeSegment,
            ["source"] = "synchronized-snapshot",
        });
    }

    private void WriteInventoryEvents(
        TrackedPlayer player,
        InventoryTelemetry previous,
        InventoryTelemetry current,
        Vector3 position,
        int activeSegment,
        long nowMs)
    {
        foreach (InventoryDelta delta in TelemetryChangeDetector.DiffInventory(previous, current))
        {
            WriteItemEvent(
                delta.EventName,
                player,
                delta.Item,
                nowMs,
                position,
                "snapshot_diff",
                "observed-state-transition",
                "unknown",
                delta.FromLocation,
                delta.ToLocation,
                activeSegment);
        }
    }

    private void WriteItemEvent(
        string eventName,
        TrackedPlayer player,
        ItemTelemetry? item,
        long nowMs,
        Vector3 position,
        string source,
        string confidence,
        string cause,
        string? fromLocation = null,
        string? toLocation = null,
        int? activeSegment = null,
        Dictionary<string, object?>? extra = null)
    {
        var record = new Dictionary<string, object?>
        {
            ["type"] = "event",
            ["event"] = eventName,
            ["t"] = nowMs,
            ["playerId"] = player.Identity.PlayerId,
            ["activeSegment"] = activeSegment ?? GetActiveSegment(),
            ["pos"] = PositionArray(position),
            ["source"] = source,
            ["confidence"] = confidence,
            ["cause"] = cause,
            ["item"] = item,
            ["fromLocation"] = fromLocation,
            ["toLocation"] = toLocation,
        };
        if (extra != null)
        {
            foreach (KeyValuePair<string, object?> pair in extra)
            {
                record[pair.Key] = pair.Value;
            }
        }
        WriteRecord(record);
    }

    private static void AddStaminaFields(Dictionary<string, object?> record, StaminaTelemetry stamina)
    {
        if (!stamina.Ready)
        {
            return;
        }

        record["stamina"] = stamina.Stamina;
        record["maxStamina"] = stamina.MaxStamina;
        record["stamina01"] = stamina.Stamina01;
        record["extraStamina"] = stamina.ExtraStamina;
        record["maxExtraStamina"] = stamina.MaxExtraStamina;
        record["extraStamina01"] = stamina.ExtraStamina01;
        record["totalStamina"] = stamina.TotalStamina;
    }

    private void WritePlayerEvent(string eventName, TrackedPlayer player, string source)
    {
        Vector3 position = GetPosition(player.Character);
        WriteEvent(eventName, player.Identity.PlayerId, GetActiveSegment(), position, source);
    }

    private void WriteEvent(
        string eventName,
        string? playerId,
        int activeSegment,
        Vector3? position,
        string? source)
    {
        WriteRecord(new Dictionary<string, object?>
        {
            ["type"] = "event",
            ["event"] = eventName,
            ["t"] = ElapsedMilliseconds,
            ["playerId"] = playerId,
            ["activeSegment"] = activeSegment,
            ["pos"] = position.HasValue ? PositionArray(position.Value) : null,
            ["source"] = source,
        });
    }

    private void WriteRecord(object record)
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            _writer.WriteLine(JsonConvert.SerializeObject(record, Formatting.None, CompactJsonSettings));
            _history?.WriteTraceRecord(Manifest.SessionId, record);
        }
        catch (Exception exception)
        {
            _log.LogError($"Failed to append trail record: {exception}");
        }
    }

    private void AtomicWriteManifest()
    {
        try
        {
            AtomicWriteJson(_manifestPartialPath, Manifest);
        }
        catch (Exception exception)
        {
            _log.LogError($"Failed to update trail manifest: {exception}");
        }
    }

    private static void AtomicWriteJson(string path, object value)
    {
        string temporaryPath = path + ".tmp";
        string json = JsonConvert.SerializeObject(value, Formatting.Indented, CompactJsonSettings);
        File.WriteAllText(temporaryPath, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        if (!File.Exists(path))
        {
            File.Move(temporaryPath, path);
            return;
        }

        try
        {
            File.Replace(temporaryPath, path, null);
        }
        catch (PlatformNotSupportedException)
        {
            File.Delete(path);
            File.Move(temporaryPath, path);
        }
    }

    private void DisposeWriter()
    {
        if (_disposed)
        {
            return;
        }

        foreach (TrackedPlayer player in _tracked.Values)
        {
            DetachCharacterCallbacks(player);
        }
        _tracked.Clear();
        _announced.Clear();
        if (ReferenceEquals(WorldTelemetryHooks.Active, _world)) WorldTelemetryHooks.Active = null;

        try
        {
            _writer.Flush();
            _stream.Flush(flushToDisk: true);
        }
        catch (Exception exception)
        {
            _log.LogWarning($"Could not force the final trail flush: {exception.Message}");
        }
        finally
        {
            _writer.Dispose();
            _stream.Dispose();
            _history?.Dispose();
            _disposed = true;
            _clock.Stop();
        }
    }

    private static void DetachCharacterCallbacks(TrackedPlayer player)
    {
        if (player.Character == null)
        {
            return;
        }

        player.Character.reviveAction -= player.ReviveHandler;
        player.Character.WarpCompleted -= player.WarpHandler;
    }

    private static Vector3 GetPosition(Character character)
    {
        try
        {
            Vector3 position = character.data != null && character.data.dead
                ? character.LastLivingPosition
                : character.Center;
            if (IsFinite(position))
            {
                return position;
            }
        }
        catch
        {
            // Character refs can be incomplete for a frame during spawn/reconnect.
        }

        Vector3 fallback = character.transform.position;
        return IsFinite(fallback) ? fallback : Vector3.zero;
    }

    private static int? GetSelectedSlot(Character character)
    {
        try
        {
            if (character?.refs?.items != null && character.refs.items.currentSelectedSlot.IsSome)
            {
                return character.refs.items.currentSelectedSlot.Value;
            }
        }
        catch
        {
            // Equipment can be between RPC/coroutine phases for a frame.
        }
        return null;
    }

    private static bool IsInventorySynchronizationReady(
        Character character,
        StaminaTelemetry stamina,
        long firstObservedAtMs,
        long nowMs)
    {
        try
        {
            // The master owns the canonical Player inventory and does not wait for an RPC echo.
            if (Photon.Pun.PhotonNetwork.IsMasterClient)
            {
                return true;
            }

            // Player.Awake constructs apparently empty slots before SyncInventoryRPC arrives.
            // There is no receipt flag in Player, so non-master observers use a conservative
            // stability window. Remote characters additionally need an owner-authored sync
            // packet, which proves that their network object has entered its steady state.
            if (nowMs - firstObservedAtMs < InventorySynchronizationGraceMilliseconds)
            {
                return false;
            }

            if (character.photonView != null && character.photonView.IsMine)
            {
                return true;
            }

            return stamina.Ready && string.Equals(
                stamina.Authority,
                "photon-owner-sync",
                StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }

    private static float GetYaw(Character character)
    {
        Vector3 look = character.data != null ? character.data.lookDirection_Flat : Vector3.zero;
        if (look.sqrMagnitude > 0.0001f)
        {
            return Mathf.Repeat(Mathf.Atan2(look.x, look.z) * Mathf.Rad2Deg, 360f);
        }
        return Mathf.Repeat(character.transform.eulerAngles.y, 360f);
    }

    private static bool IsFinite(Vector3 value)
    {
        return !float.IsNaN(value.x) && !float.IsInfinity(value.x)
            && !float.IsNaN(value.y) && !float.IsInfinity(value.y)
            && !float.IsNaN(value.z) && !float.IsInfinity(value.z);
    }

    private static float[] PositionArray(Vector3 position)
    {
        return new[] { position.x, position.y, position.z };
    }

    private static int GetActiveSegment()
    {
        try
        {
            if (!MapHandler.Exists || MapHandler.Instance?.segments == null)
            {
                return -1;
            }

            // This is the scene-wide MapHandler progression value, not a per-character
            // location. Resolve it to the map-pack array index without claiming that every
            // synchronized character currently belongs to that layer. The public Segment enum
            // is not a stable array index: Peak/TheKiln share the final regular layer and Void
            // is appended at index 5 while Segment.Void has enum value 6.
            MapHandler.MapSegment current = MapHandler.CurrentMapSegment;
            MapHandler.MapSegment[] segments = MapHandler.Instance.segments;
            for (int index = 0; index < segments.Length; index++)
            {
                if (ReferenceEquals(segments[index], current))
                {
                    return index;
                }
            }

            return -1;
        }
        catch
        {
            return -1;
        }
    }

    private void WriteRouteIfChanged(RouteTelemetry? route, long nowMs)
    {
        if (route == null) return;
        string fingerprint = route.Fingerprint();
        if (string.Equals(_lastRouteFingerprint, fingerprint, StringComparison.Ordinal)) return;

        Manifest.Route = route;
        AtomicWriteManifest();
        WriteRecord(new Dictionary<string, object?>
        {
            ["type"] = "route",
            ["t"] = nowMs,
            ["route"] = route,
        });
        _lastRouteFingerprint = fingerprint;
    }

    private static int GetLevelIndex()
    {
        try
        {
            NextLevelService? service = GameHandler.GetService<NextLevelService>();
            return service?.NextLevelIndexOrFallback ?? -1;
        }
        catch
        {
            return -1;
        }
    }

    private static int ResolveMapSlot(string sceneName, int levelIndex)
    {
        const string prefix = "Level_";
        if (sceneName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && int.TryParse(sceneName.Substring(prefix.Length), NumberStyles.Integer, CultureInfo.InvariantCulture, out int sceneSlot)
            && sceneSlot >= 0)
        {
            return sceneSlot;
        }

        try
        {
            int count = MapBaker.Instance?.ScenePaths?.Length ?? 0;
            if (count > 0 && levelIndex >= 0)
            {
                return ((levelIndex % count) + count) % count;
            }
        }
        catch
        {
            // Asset singleton may not be initialized on custom maps.
        }
        return 0;
    }

    private static object GetGameBuildId()
    {
        try
        {
            int buildId = SteamApps.GetAppBuildId();
            return buildId > 0 ? buildId : "unknown";
        }
        catch
        {
            return "unknown";
        }
    }

    private static string CreateUniqueDirectory(string root, string requestedName)
    {
        Directory.CreateDirectory(root);
        string candidate = Path.Combine(root, requestedName);
        int suffix = 2;
        while (Directory.Exists(candidate))
        {
            candidate = Path.Combine(root, requestedName + "-" + suffix.ToString(CultureInfo.InvariantCulture));
            suffix++;
        }
        Directory.CreateDirectory(candidate);
        return candidate;
    }

    private static string SanitizeFileName(string value)
    {
        char[] invalid = Path.GetInvalidFileNameChars();
        var builder = new StringBuilder(value.Length);
        foreach (char character in value)
        {
            builder.Append(invalid.Contains(character) ? '_' : character);
        }
        return builder.ToString();
    }
}
