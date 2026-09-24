using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading;
using BepInEx.Logging;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

/// <summary>
/// Publishes the session's records to the live relay while the game runs.
/// Everything happens on one background thread over outbound HTTP only — the
/// Unity main thread just enqueues already-materialized POCO dictionaries and
/// never touches sockets. The 4-character run code identifies the run and is
/// confirmed server-side by re-deriving it from the runId; no login is required.
/// </summary>
internal sealed class LivePublisher : IDisposable
{
    private const int FlushIntervalMs = 100;
    private const int BatchSizeLines = 40;
    private const int MaxQueuedRecords = 4000;
    private const int MaxPreRegistrationRecords = 2000;
    private const int MaxRetriesPerBatch = 3;
    private static readonly TimeSpan HttpClientTimeout = TimeSpan.FromSeconds(5);

    private readonly ManualLogSource _log;
    private readonly string _serverUrl;
    private readonly ConcurrentQueue<Dictionary<string, object?>> _queue = new();
    private readonly AutoResetEvent _signal = new(initialState: false);
    private readonly CancellationTokenSource _cancellation = new();

    private readonly HttpClient _http;
    private readonly Thread _thread;
    private readonly List<string> _backlog = new();       // serialized lines waiting for registration
    private readonly List<string> _batch = new();

    private TraceManifest? _manifest;
    private string? _producer;
    private string? _code;
    private bool _registered;
    private int _lastWarningAtMs;
    private bool _disposed;

    public LivePublisher(string serverUrl, ManualLogSource log)
    {
        var connection = new LiveRelayConnection(serverUrl);
        _serverUrl = connection.ServerUrl;
        _log = log;
        _http = connection.CreateHttpClient(HttpClientTimeout);
        _thread = new Thread(RunLoop)
        {
            IsBackground = true,
            Name = "PeakTrailLivePublisher",
        };
        _thread.Start();
    }

    /// <summary>Called once by the recording session after its manifest exists.</summary>
    public void Configure(TraceManifest manifest, string? producer)
    {
        _manifest = manifest;
        _producer = string.IsNullOrWhiteSpace(producer) ? null : producer;
    }

    /// <summary>Enqueue one record on the Unity main thread. The room timestamp is
    /// attached here so the relay can deduplicate the same game frame uploaded by
    /// several teammates. Never throws; drops on overflow instead of blocking.</summary>
    public void Publish(Dictionary<string, object?> record, int roomTimestamp)
    {
        if (_disposed || record == null) return;
        if (_queue.Count >= MaxQueuedRecords)
        {
            WarnThrottled("Live queue is full; dropping records faster than the relay accepts them.");
            return;
        }
        var envelope = new Dictionary<string, object?>(record)
        {
            ["roomTs"] = roomTimestamp,
        };
        _queue.Enqueue(envelope);
        _signal.Set();
    }

    private void RunLoop()
    {
        var pending = new Queue<Dictionary<string, object?>>();
        var preRegistration = new List<string>();
        var backoff = TimeSpan.FromMilliseconds(500);
        while (!_cancellation.IsCancellationRequested)
        {
            try
            {
                _signal.WaitOne(FlushIntervalMs);
                DrainQueue(pending);
                if (!_registered)
                {
                    if (!TryRegister(preRegistration)) continue;
                }
                FlushBatches();
                CapBatchBacklog();
                backoff = TimeSpan.FromMilliseconds(500);
            }
            catch (Exception exception)
            {
                if (!_cancellation.IsCancellationRequested)
                {
                    WarnThrottled("Live publisher retrying after: " + exception.GetType().Name);
                }
                Thread.Sleep(backoff);
                backoff = TimeSpan.FromMilliseconds(Math.Min(backoff.TotalMilliseconds * 2, 8000));
            }
        }
        DrainQueue(pending);
        if (_registered) FlushBatches();
    }

    /// <summary>A dead relay must never grow memory: once the backlog exceeds the
    /// same bound as the main queue, the oldest lines are dropped for good.</summary>
    private void CapBatchBacklog()
    {
        if (_batch.Count <= MaxQueuedRecords) return;
        WarnThrottled("Live relay is unreachable; dropping the oldest queued records.");
        _batch.RemoveRange(0, _batch.Count - MaxQueuedRecords);
    }

    private void DrainQueue(Queue<Dictionary<string, object?>> pending)
    {
        while (_queue.TryDequeue(out Dictionary<string, object?>? record))
        {
            pending.Enqueue(record);
        }
        while (pending.Count > 0)
        {
            Dictionary<string, object?> record = pending.Dequeue();
            string line;
            try
            {
                line = JsonConvert.SerializeObject(record, Formatting.None, RecordingSession.CompactJsonSettings);
            }
            catch
            {
                continue; // A record that cannot serialize is dropped, never fatal.
            }
            if (_registered) _batch.Add(line);
            else
            {
                _backlog.Add(line);
                if (_backlog.Count > MaxPreRegistrationRecords)
                {
                    _backlog.RemoveRange(0, _backlog.Count - MaxPreRegistrationRecords);
                }
            }
        }
    }

    private bool TryRegister(List<string> preRegistration)
    {
        TraceManifest? manifest = _manifest;
        if (manifest == null || string.IsNullOrEmpty(manifest.RunId)) return false;

        for (int attempt = 0; attempt < RunCode.MaxDerivationAttempts; attempt++)
        {
            string code = RunCode.Derive(manifest.RunId, attempt);
            var payload = new Dictionary<string, object?>
            {
                ["code"] = code,
                ["runId"] = manifest.RunId,
                ["manifest"] = manifest,
            };
            string body = JsonConvert.SerializeObject(payload, Formatting.None, RecordingSession.CompactJsonSettings);
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var response = _http.PostAsync($"{_serverUrl}/api/runs", content).GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode)
            {
                _code = code;
                _registered = true;
                _log.LogInfo($"Live publishing confirmed by relay: run code '{code}' (attempt {attempt}).");
                if (preRegistration.Count > 0)
                {
                    _batch.AddRange(preRegistration);
                    preRegistration.Clear();
                }
                return true;
            }
            bool collision = (int)response.StatusCode == 409;
            if (!collision)
            {
                WarnThrottled($"Relay rejected run registration (HTTP {(int)response.StatusCode}). Check the relay service.");
                return false;
            }
            // Another runId hashed to this code; the deterministic next attempt
            // keeps every teammate on the same (new) code with no coordination.
        }
        WarnThrottled("Every run-code attempt collided; live publishing stays idle this session.");
        return false;
    }

    private void FlushBatches()
    {
        while (_batch.Count > 0)
        {
            int size = Math.Min(BatchSizeLines, _batch.Count);
            string body = string.Join("\n", _batch.GetRange(0, size)) + "\n";
            _batch.RemoveRange(0, size);
            if (!PostBatch(body))
            {
                // Put the batch back at the front for the next cycle; CapBatchBacklog
                // bounds total memory if the relay stays unreachable.
                _batch.InsertRange(0, body.Split('\n', StringSplitOptions.RemoveEmptyEntries));
                return;
            }
        }
    }

    private bool PostBatch(string body)
    {
        for (int attempt = 1; attempt <= MaxRetriesPerBatch; attempt++)
        {
            try
            {
                using var content = new StringContent(body, Encoding.UTF8, "application/x-ndjson");
                using var response = _http.PostAsync($"{_serverUrl}/api/runs/{_code}/records?producer={Uri.EscapeDataString(_producer ?? "")}", content).GetAwaiter().GetResult();
                if (response.IsSuccessStatusCode) return true;
                int status = (int)response.StatusCode;
                if (status == 404)
                {
                    // Relay restarted or the run expired; re-register and replay.
                    _registered = false;
                    return false;
                }
                if (status == 429 || status == 413)
                {
                    WarnThrottled($"Relay throttled a live batch ({status}); dropping it to protect the game.");
                    return true; // Treated as delivered: never block or grow unbounded.
                }
                WarnThrottled($"Relay rejected a live batch (HTTP {status}). Check the relay service.");
            }
            catch (Exception exception)
            {
                WarnThrottled($"Live batch attempt {attempt} failed: {exception.GetType().Name}");
            }
            Thread.Sleep(TimeSpan.FromMilliseconds(250 * attempt));
        }
        return false;
    }

    private void WarnThrottled(string message)
    {
        // Environment.TickCount64 does not exist on netstandard2.1; TickCount wraps,
        // so subtract with int arithmetic (wrap-safe for 60 s windows).
        int now = Environment.TickCount;
        if (now - _lastWarningAtMs < 60_000 && _lastWarningAtMs != 0) return;
        _lastWarningAtMs = now;
        _log.LogWarning(message);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try
        {
            // Cancel first: the run loop's exit path performs the final drain and
            // flush. The offline files remain the archival record regardless.
            _cancellation.Cancel();
            _signal.Set();
            if (!_thread.Join(TimeSpan.FromSeconds(3)))
            {
                _thread.Join(TimeSpan.FromSeconds(1));
            }
        }
        catch { /* shutdown must never take the game down */ }
        finally
        {
            _cancellation.Dispose();
            _http.Dispose();
            _signal.Dispose();
        }
    }
}
