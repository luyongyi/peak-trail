using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using PeakTrail.MapExporter;
using PhotonPlayer = Photon.Realtime.Player;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace PeakTrailRecorder;

[BepInAutoPlugin]
public partial class Plugin : BaseUnityPlugin
{
    internal const string RecorderVersion = "0.8.2";

    internal static ManualLogSource Log { get; private set; } = null!;

    private ConfigEntry<bool> _enabled = null!;
    private ConfigEntry<float> _sampleHz = null!;
    private ConfigEntry<float> _minimumDistance = null!;
    private ConfigEntry<float> _minimumYawDegrees = null!;
    private ConfigEntry<float> _maximumSilenceSeconds = null!;
    private ConfigEntry<string> _outputDirectory = null!;
    private ConfigEntry<bool> _liveEnabled = null!;
    private ConfigEntry<string> _liveServerUrl = null!;
    private ConfigEntry<KeyboardShortcut> _mapExportKey = null!;
    private ConfigEntry<string> _mapOutputDirectory = null!;
    private ConfigEntry<int> _mapTextureResolution = null!;
    private ConfigEntry<int> _mapHeightResolution = null!;
    private ConfigEntry<float> _mapBoundsPadding = null!;
    private ConfigEntry<int> _mapHeightRowsPerFrame = null!;
    private ConfigEntry<int> _mapCameraCullingMask = null!;

    private RecordingSession? _session;
    private bool _isExportingMap;
    private float _nextSampleAt;
    private float _nextLiveSampleAt;
    private float _nextSubscriptionRefreshAt;

    /// <summary>Relay-only position sampling rate; offline files keep the
    /// SampleHz config. 20 Hz keeps viewer-side interpolation smooth while the
    /// live gate (0.05 m / 2° / 1 s) suppresses stationary spam.</summary>
    private const float LiveSampleHz = 20f;
    private int _lastFinalizedRunManagerInstanceId;
    private bool _applicationQuitting;
    private float _nextLiveStartAttemptAt;
    private RouteArchiveOutbox? _routeOutbox;
    private NativeRouteArchive? _routeArchive;
    private int _lastArchivedRun;
    private float _nextArchiveStartAttempt;

    private void Awake()
    {
        Log = Logger;
        _enabled = Config.Bind("Recording", "Enabled", true, "Record trails while a PEAK run is active.");
        _sampleHz = Config.Bind("Recording", "SampleHz", 5f, "Maximum sampling frequency (1-30 Hz). Adaptive position filtering can emit fewer stationary samples; player state still has a 1 second heartbeat.");
        _minimumDistance = Config.Bind("Recording", "MinimumDistanceMeters", 0.25f, "Emit a sample after moving this far.");
        _minimumYawDegrees = Config.Bind("Recording", "MinimumYawDegrees", 5f, "Emit a sample after turning this far.");
        _maximumSilenceSeconds = Config.Bind("Recording", "MaximumSilenceSeconds", 1f, "Emit a heartbeat sample after this interval even if stationary.");
        _outputDirectory = Config.Bind(
            "Recording",
            "OutputDirectory",
            "PeakTrailRecordings",
            "Absolute path, or a path relative to BepInEx. Files contain raw stable player IDs and nicknames; do not share without consent.");
        _liveEnabled = Config.Bind(
            "Live",
            "Enabled",
            true,
            "Automatically stream each run's path. Change this immediately in the game's General settings. The live stream uses temporary player IDs; local recordings retain their original format.");
        _liveServerUrl = Config.Bind(
            "Live",
            "ServerUrl",
            LiveRelayConnection.DefaultServerUrl,
            "Base HTTP(S) URL of the PeakTrail live relay, without user information, query or fragment. Publishing credentials and the single active publisher are managed automatically.");

        NativeLiveSettings.Install(_liveEnabled, () => _session?.LiveWatchCode, () => _session?.LiveWatchUrl,
            () => _session?.LiveStatus, Log);

        _mapExportKey = Config.Bind(
            "MapCapture",
            "Hotkey",
            new KeyboardShortcut(KeyCode.F8),
            "Capture the currently loaded PEAK map as a versioned 2.5D map pack. This runs inside PeakTrailRecorder; no second mod is required.");
        _mapOutputDirectory = Config.Bind(
            "MapCapture",
            "OutputDirectory",
            Path.Combine(Paths.BepInExRootPath, "PeakTrailMapPacks"),
            "Destination for 2.5D map packs that can be registered into the static GitHub Pages site.");
        _mapTextureResolution = Config.Bind(
            "MapCapture",
            "TextureResolution",
            2048,
            "Square PNG resolution for each map segment (256-8192).");
        _mapHeightResolution = Config.Bind(
            "MapCapture",
            "HeightResolution",
            512,
            "Square float32 height-field resolution for each map segment (64-2048).");
        _mapBoundsPadding = Config.Bind(
            "MapCapture",
            "BoundsPaddingMeters",
            5f,
            "Padding around each square XZ capture bound.");
        _mapHeightRowsPerFrame = Config.Bind(
            "MapCapture",
            "HeightRowsPerFrame",
            8,
            "Height-field rows processed per rendered frame. Lower values reduce long frame stalls.");
        _mapCameraCullingMask = Config.Bind(
            "MapCapture",
            "CameraCullingMask",
            ~(1 << 5),
            "Unity layer mask for the temporary top-down camera. The default excludes UI.");

        SceneManager.sceneLoaded += OnSceneLoaded;
        // Live publishing stalls when the game loses focus (Unity pauses Update and
        // with it every recorder callback). Spectators watch from another device,
        // so the game must keep ticking while unfocused.
        Application.runInBackground = true;
        PlayerAppearanceReader.Install(Log);
        WorldTelemetryHooks.Install(Log);
        PlayerStatusReader.Install(Log);
        try { _routeOutbox = new RouteArchiveOutbox(Path.Combine(Paths.BepInExRootPath, "PeakTrailRoutes"), message => Log.LogWarning(message)); }
        catch (Exception e) { Log.LogError("Route archive disk initialization failed (" + e.GetType().Name + ")."); }
        NativeRouteHooks.Capture = CaptureRouteBoundary;
        NativeRouteHooks.Install(message => Log.LogWarning(message));
        SubscribeGlobalEvents();
        Log.LogWarning(
            "PeakTrailRecorder records every synchronized human player's location trail, stamina, statuses, appearance, held items and inventory, "
            + "together with raw stable IDs/nicknames. These local files are sensitive multiplayer telemetry; obtain "
            + "every participant's consent before recording or sharing them.");
        Log.LogInfo(
            $"Plugin {Name} {RecorderVersion} loaded (read-only telemetry; observation-only world/status RPC postfixes). "
            + $"Press {_mapExportKey.Value} in a loaded island to create its 2.5D map pack; no separate exporter DLL is needed.");
    }

    private void Update()
    {
        PlayerAppearanceReader.ClearOutsideRoom();
        PlayerStatusReader.ClearOutsideRoom();
        TryStartMapExport();
        NativeLiveSettings.EnsureRegistered();
        if (!_liveEnabled.Value) _session?.SetLivePublisher(null);
        SynchronizeRouteArchive();

        if (Time.realtimeSinceStartup >= _nextSubscriptionRefreshAt)
        {
            _nextSubscriptionRefreshAt = Time.realtimeSinceStartup + 1f;
            // PEAK clears GlobalEvents during scene transitions. Remove/add is idempotent and
            // restores our listeners without patching the game.
            SubscribeGlobalEvents();
            // The game can re-disable background running on scene changes; keep live
            // publishing (and the whole recorder) alive while the window is unfocused.
            Application.runInBackground = true;
        }

        if (!_enabled.Value && !_liveEnabled.Value)
        {
            FinalizeSession("recording_and_live_disabled");
            _lastFinalizedRunManagerInstanceId = 0;
            return;
        }

        if (_session != null && _session.RecordsLocally != _enabled.Value)
        {
            FinalizeSession("local_recording_setting_changed");
            _lastFinalizedRunManagerInstanceId = 0;
        }

        if (_session != null)
        {
            if (RunManager.Instance == null
                || RunManager.Instance.GetInstanceID() != _session.RunManagerInstanceId
                || !IsPlayableRunReady()
                || !string.Equals(SceneManager.GetActiveScene().name, _session.SceneName, StringComparison.Ordinal))
            {
                FinalizeSession("run_or_scene_changed");
                return;
            }

            _session.UpdateRunId();
        }
        else if (!TryStartSession())
        {
            return;
        }

        _session!.SampleWorld();

        SynchronizeLiveSetting();
        // Live sampling has its own clock. Do not put it behind the file sampler's return.
        if (_session.LiveEnabled && Time.realtimeSinceStartup >= _nextLiveSampleAt)
        {
            _nextLiveSampleAt = Time.realtimeSinceStartup + 1f / LiveSampleHz;
            _session.SampleLivePositions(0.05f, 2f, 1f);
        }

        float hz = Mathf.Clamp(_sampleHz.Value, 1f, 30f);
        if (Time.realtimeSinceStartup < _nextSampleAt)
        {
            return;
        }
        _nextSampleAt = Time.realtimeSinceStartup + 1f / hz;

        IReadOnlyCollection<Character> characters = GetPlayerCharacters();
        _session!.ReconcilePlayers(characters);
        _session.SamplePlayers(
            Mathf.Max(0f, _minimumDistance.Value),
            Mathf.Max(0f, _minimumYawDegrees.Value),
            Mathf.Max(0.1f, _maximumSilenceSeconds.Value));

    }

    private void SynchronizeLiveSetting()
    {
        if (_session == null) return;
        if (!_liveEnabled.Value)
        {
            _session.SetLivePublisher(null);
            _nextLiveStartAttemptAt = 0f;
            return;
        }
        if (_session.LiveEnabled || Time.realtimeSinceStartup < _nextLiveStartAttemptAt) return;
        try
        {
            _session.SetLivePublisher(new LivePublisher(_liveServerUrl.Value.Trim(), Log));
            _nextLiveSampleAt = 0f;
        }
        catch (Exception exception)
        {
            _nextLiveStartAttemptAt = Time.realtimeSinceStartup + 10f;
            Log.LogWarning($"Live connection unavailable ({exception.GetType().Name}); local recording continues.");
        }
    }

    private void SynchronizeRouteArchive()
    {
        bool ready = IsPlayableRunReady();
        if (_routeArchive != null && (!_liveEnabled.Value || !ready || RunManager.Instance.GetInstanceID() != _routeArchive.RunManagerId
            || SceneManager.GetActiveScene().name != _routeArchive.Scene)) CloseRouteArchive();
        if (!_liveEnabled.Value) { _lastArchivedRun = 0; return; }
        if (!ready || _routeOutbox == null) return;
        if (_routeArchive == null && RunManager.Instance.GetInstanceID() != _lastArchivedRun && Time.realtimeSinceStartup >= _nextArchiveStartAttempt)
        {
            try
            {
                _routeArchive = new NativeRouteArchive(_routeOutbox, _liveServerUrl.Value,
                    (kind, player, stage, position) => _session?.RecordNativeRouteEvent(kind, player, stage, position));
            }
            catch (Exception e) { _nextArchiveStartAttempt = Time.realtimeSinceStartup + 10; Log.LogError("Route archive could not start (" + e.GetType().Name + "); retrying."); }
        }
        try { _routeArchive?.Tick(); }
        catch (Exception e) { Log.LogError("Route archive capture failed (" + e.GetType().Name + "). Existing journal retained."); CloseRouteArchive(); }
    }

    private void CaptureRouteBoundary(bool critical, string? kind, bool seal)
    {
        try { _routeArchive?.Capture(critical, kind, seal); }
        catch (Exception e) { Log.LogError("Route archive boundary write failed (" + e.GetType().Name + ")."); }
    }

    private void CloseRouteArchive()
    {
        var archive = _routeArchive; _routeArchive = null;
        if (archive == null) return;
        _lastArchivedRun = archive.RunManagerId;
        try { archive.Dispose(); }
        catch (Exception e) { Log.LogError("Route archive final flush failed (" + e.GetType().Name + "). Existing journal retained."); }
    }

    private void TryStartMapExport()
    {
        if (!_mapExportKey.Value.IsDown())
        {
            return;
        }

        if (_isExportingMap)
        {
            Log.LogWarning("A PeakTrail map capture is already running.");
            return;
        }

        if (!MapHandler.Exists || MapHandler.Instance == null || MapHandler.Instance.segments == null)
        {
            Log.LogWarning("No initialized PEAK map is loaded. Enter the island before capturing its 2.5D map pack.");
            return;
        }

        StartCoroutine(ExportCurrentMap());
    }

    private IEnumerator ExportCurrentMap()
    {
        _isExportingMap = true;
        try
        {
            var settings = new ExportSettings(
                _mapOutputDirectory.Value,
                Mathf.Clamp(_mapTextureResolution.Value, 256, 8192),
                Mathf.Clamp(_mapHeightResolution.Value, 64, 2048),
                Mathf.Max(0f, _mapBoundsPadding.Value),
                Mathf.Clamp(_mapHeightRowsPerFrame.Value, 1, 128),
                _mapCameraCullingMask.Value);
            var exporter = new MapPackExporter(Log, settings);
            yield return exporter.ExportCurrentScene();
        }
        finally
        {
            _isExportingMap = false;
        }
    }

    private bool TryStartSession()
    {
        if (!IsPlayableRunReady()
            || RunManager.Instance == null
            || RunManager.Instance.GetInstanceID() == _lastFinalizedRunManagerInstanceId)
        {
            return false;
        }

        IReadOnlyCollection<Character> characters = GetPlayerCharacters();
        if (characters.Count == 0)
        {
            return false;
        }

        try
        {
            string configured = Environment.ExpandEnvironmentVariables(_outputDirectory.Value.Trim());
            string root = Path.IsPathRooted(configured)
                ? configured
                : Path.Combine(Paths.BepInExRootPath, configured);
            _session = new RecordingSession(root, Mathf.Clamp(_sampleHz.Value, 1f, 30f), Log, recordLocal: _enabled.Value);
            _session.ReconcilePlayers(characters);
            _nextSampleAt = 0f;
            _nextLiveSampleAt = 0f;
            _nextLiveStartAttemptAt = 0f;
            SynchronizeLiveSetting();
            return true;
        }
        catch (Exception exception)
        {
            Log.LogError($"Could not start trail recording: {exception}");
            return false;
        }
    }

    private static bool IsPlayableRunReady()
    {
        if (RunManager.Instance == null
            || !MapHandler.ExistsAndInitialized
            || Character.localCharacter == null)
        {
            return false;
        }

        try
        {
            // RunManager may exist in/around Airport initialization while its Start coroutine
            // exits without beginning a climb. Never create a lobby-only trace.
            return !Character.localCharacter.inAirport;
        }
        catch
        {
            return false;
        }
    }

    private static IReadOnlyCollection<Character> GetPlayerCharacters()
    {
        try
        {
            return PlayerHandler.GetAllPlayerCharacters().ToArray();
        }
        catch
        {
            return Array.Empty<Character>();
        }
    }

    private void SubscribeGlobalEvents()
    {
        UnsubscribeGlobalEvents();
        GlobalEvents.OnPlayerConnected += OnPlayerConnected;
        GlobalEvents.OnPlayerDisconnected += OnPlayerDisconnected;
        GlobalEvents.OnCharacterPassedOut += OnCharacterPassedOut;
        GlobalEvents.OnCharacterDied += OnCharacterDied;
        GlobalEvents.OnItemConsumed += OnItemConsumed;
        GlobalEvents.OnItemThrown += OnItemThrown;
        GlobalEvents.OnRunEnded += OnRunEnded;
        GlobalEvents.OnSoulFreed += OnSoulFreed;
        GlobalEvents.OnBeforeSceneLoad += OnBeforeSceneLoad;
    }

    private void UnsubscribeGlobalEvents()
    {
        GlobalEvents.OnPlayerConnected -= OnPlayerConnected;
        GlobalEvents.OnPlayerDisconnected -= OnPlayerDisconnected;
        GlobalEvents.OnCharacterPassedOut -= OnCharacterPassedOut;
        GlobalEvents.OnCharacterDied -= OnCharacterDied;
        GlobalEvents.OnItemConsumed -= OnItemConsumed;
        GlobalEvents.OnItemThrown -= OnItemThrown;
        GlobalEvents.OnRunEnded -= OnRunEnded;
        GlobalEvents.OnSoulFreed -= OnSoulFreed;
        GlobalEvents.OnBeforeSceneLoad -= OnBeforeSceneLoad;
    }

    private void OnPlayerConnected(PhotonPlayer player)
    {
        _session?.OnPhotonPlayerConnected(player);
    }

    private void OnPlayerDisconnected(PhotonPlayer player)
    {
        _session?.OnPhotonPlayerDisconnected(player);
    }

    private void OnCharacterPassedOut(Character character)
    {
        _session?.OnCharacterPassedOut(character);
    }

    private void OnCharacterDied(Character character)
    {
        _session?.OnCharacterDied(character);
    }

    private void OnItemConsumed(Item item, Character character)
    {
        _session?.OnItemConsumed(item, character);
    }

    private void OnItemThrown(Item item)
    {
        _session?.OnItemThrown(item);
    }

    private void OnRunEnded()
    {
        CaptureRouteBoundary(true, "run-end", true);
        CloseRouteArchive();
        FinalizeSession("game_run_end");
    }

    private void OnSoulFreed(int phase)
    {
        if (phase == 0 || phase == 1) CaptureRouteBoundary(true, phase == 0 ? "nadir-wall" : "nadir-chase", false);
    }

    private void OnBeforeSceneLoad(string scene)
    {
        CaptureRouteBoundary(true, "scene-exit", true);
        CloseRouteArchive();
    }

    private void OnSceneLoaded(Scene _, LoadSceneMode __)
    {
        _nextSubscriptionRefreshAt = 0f;
    }

    private void FinalizeSession(string reason)
    {
        if (_session == null)
        {
            return;
        }

        _lastFinalizedRunManagerInstanceId = _session.RunManagerInstanceId;
        _session.Complete(reason);
        _session = null;
    }

    private void OnApplicationQuit()
    {
        _applicationQuitting = true;
        CloseRouteArchive();
        FinalizeSession("application_quit");
    }

    private void OnDestroy()
    {
        CloseRouteArchive();
        NativeRouteHooks.Uninstall();
        NativeLiveSettings.Uninstall();
        PlayerAppearanceReader.Uninstall();
        WorldTelemetryHooks.Uninstall();
        PlayerStatusReader.Uninstall();
        SceneManager.sceneLoaded -= OnSceneLoaded;
        UnsubscribeGlobalEvents();
        if (!_applicationQuitting)
        {
            FinalizeSession("plugin_destroyed");
        }
    }
}
