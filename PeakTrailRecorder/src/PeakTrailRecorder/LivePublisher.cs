using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using BepInEx.Logging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace PeakTrailRecorder;

internal enum LivePublisherStatus { WaitingForRun, Connecting, Standby, Live, Reconnecting, Stopped }

/// <summary>
/// Account-free, leased v2 publishing. All game objects are projected on the caller
/// thread; the worker handles only detached JSON and cancellable outbound HTTP.
/// </summary>
internal sealed class LivePublisher : IDisposable
{
    private const int FlushIntervalMs = 100;
    private const int MaxBatchLines = 40;
    private const int MaxBatchBytes = 128 * 1024;
    private readonly ManualLogSource _log;
    private readonly string _serverUrl;
    private readonly string _clientId = Guid.NewGuid().ToString("N");
    private readonly CancellationTokenSource _cancellation = new();
    private readonly HttpClient _http;
    private readonly Thread _thread;
    private readonly LivePayload _payload = new();
    private readonly LiveRecordBuffer _records = new();
    private readonly object _configurationLock = new();
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private TraceManifest? _sourceManifest; // only Configure/Publish on the game thread access this
    private JObject? _manifest;
    private string? _roomKey;
    private string? _configuredRunId;
    private string? _sessionId;
    private string? _publishToken;
    private string? _watchUrl;
    private string? _watchCode;
    private long _epoch = -1;
    private long _sequence;
    private long _epochOrigin;
    private long _nextRegistrationAt;
    private long _nextHeartbeatAt;
    private long _nextUploadAt;
    private int _heartbeatMs = 5000;
    private int _retryMs = 500;
    private string? _pendingBody;
    private volatile LivePublisherStatus _status = LivePublisherStatus.WaitingForRun;
    private int _disposed;
    private long _lastWarningAt = -60_000;

    public LivePublisher(string serverUrl, ManualLogSource log) : this(serverUrl, log, null) { }

    // The injectable transport keeps network/failure tests independent of Unity.
    internal LivePublisher(string serverUrl, ManualLogSource log, HttpMessageHandler? handler)
    {
        var connection = new LiveRelayConnection(serverUrl);
        _serverUrl = connection.ServerUrl;
        _log = log;
        _http = handler == null
            ? connection.CreateHttpClient(TimeSpan.FromSeconds(5))
            : new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(5) };
        _thread = new Thread(RunLoop) { IsBackground = true, Name = "PeakTrailLivePublisherV2" };
        _thread.Start();
    }

    public LivePublisherStatus Status => Volatile.Read(ref _disposed) != 0 ? LivePublisherStatus.Stopped : _status;
    public string? WatchUrl => Volatile.Read(ref _disposed) != 0 ? null : Volatile.Read(ref _watchUrl);
    public string? WatchCode => Volatile.Read(ref _disposed) != 0 ? null : Volatile.Read(ref _watchCode);

    /// <summary>The legacy producer argument is intentionally never transmitted.</summary>
    public void Configure(TraceManifest manifest, string? producer)
    {
        _sourceManifest = manifest;
        RefreshManifest();
    }

    /// <summary>Call on the game thread when a previously missing RunId becomes available.</summary>
    public void RefreshManifest()
    {
        if (Volatile.Read(ref _disposed) != 0 || _sourceManifest == null) return;
        string runId = RunCode.Normalize(_sourceManifest.RunId);
        if (runId.Length == 0 || string.Equals(runId, _configuredRunId, StringComparison.Ordinal)) return;
        JObject safe = LivePayload.Manifest(_sourceManifest);
        string key = LivePayload.RoomKey(runId, _sourceManifest.SceneName);
        lock (_configurationLock)
        {
            _manifest = safe;
            _roomKey = key;
            _configuredRunId = runId;
        }
    }

    /// <summary>No sockets, waits, or Unity access. Incoming POCOs are detached and anonymized.</summary>
    public void Publish(Dictionary<string, object?> record, int roomTimestamp)
    {
        if (Volatile.Read(ref _disposed) != 0 || record == null) return;
        try
        {
            RefreshManifest();
            JObject? safe = _payload.Record(record);
            if (safe != null) _records.Add(safe);
        }
        catch (Exception exception) { WarnThrottled("Live record skipped: " + exception.GetType().Name); }
    }

    private void RunLoop()
    {
        long nextTick = FlushIntervalMs;
        try
        {
            while (!_cancellation.IsCancellationRequested)
            {
                // Publish never wakes this clock: no tiny requests per individual sample.
                int wait = (int)Math.Max(0, nextTick - _clock.ElapsedMilliseconds);
                if (_cancellation.Token.WaitHandle.WaitOne(wait)) break;
                nextTick = _clock.ElapsedMilliseconds + FlushIntervalMs;
                try { Tick(); }
                catch (OperationCanceledException) when (_cancellation.IsCancellationRequested) { break; }
                catch (Exception exception)
                {
                    if (_cancellation.IsCancellationRequested) break;
                    _status = LivePublisherStatus.Reconnecting;
                    WarnThrottled("Live relay unavailable: " + exception.GetType().Name);
                    Backoff();
                }
            }
        }
        finally
        {
            TryEnd();
            _http.Dispose();
            _cancellation.Dispose();
        }
    }

    private void Tick()
    {
        long now = _clock.ElapsedMilliseconds;
        if (_publishToken == null)
        {
            if (now >= _nextRegistrationAt) TryRegister();
            return;
        }
        if (now >= _nextHeartbeatAt)
        {
            using HttpResponseMessage heartbeat = Post("heartbeat", "{}", "application/json");
            if (LeaseLost(heartbeat)) return;
            if (!heartbeat.IsSuccessStatusCode)
            {
                _nextHeartbeatAt = now + RetryDelay(heartbeat, 1000);
                _status = LivePublisherStatus.Reconnecting;
                return;
            }
            _nextHeartbeatAt = _clock.ElapsedMilliseconds + _heartbeatMs;
        }
        if (_clock.ElapsedMilliseconds < _nextUploadAt) return;
        if (_pendingBody == null) _pendingBody = BuildBatch();
        if (_pendingBody == null) { _status = LivePublisherStatus.Live; return; }
        using HttpResponseMessage response = Post("records", _pendingBody, "application/x-ndjson");
        if (LeaseLost(response)) return;
        if (response.IsSuccessStatusCode)
        {
            _pendingBody = null;
            _retryMs = 500;
            _status = LivePublisherStatus.Live;
            _nextUploadAt = _clock.ElapsedMilliseconds + FlushIntervalMs;
            return;
        }
        _status = LivePublisherStatus.Reconnecting;
        if ((int)response.StatusCode == 429)
        {
            // Preserve exactly the same envelope and sequence numbers until acknowledged.
            _nextUploadAt = _clock.ElapsedMilliseconds + RetryDelay(response, 1000);
        }
        else
        {
            WarnThrottled("Live relay rejected a batch (HTTP " + (int)response.StatusCode + ").");
            Backoff();
        }
    }

    private void TryRegister()
    {
        JObject? manifest;
        string? roomKey;
        lock (_configurationLock)
        {
            manifest = _manifest == null ? null : (JObject)_manifest.DeepClone();
            roomKey = _roomKey;
        }
        if (manifest == null || roomKey == null) { _status = LivePublisherStatus.WaitingForRun; return; }
        _status = _epoch < 0 ? LivePublisherStatus.Connecting : LivePublisherStatus.Reconnecting;
        var requestBody = new JObject { ["roomKey"] = roomKey, ["clientId"] = _clientId, ["manifest"] = manifest };
        using var request = new HttpRequestMessage(HttpMethod.Post, _serverUrl + "/api/live/v2/sessions")
        {
            Content = new StringContent(requestBody.ToString(Formatting.None), Encoding.UTF8, "application/json"),
        };
        using HttpResponseMessage response = _http.SendAsync(request, _cancellation.Token).GetAwaiter().GetResult();
        JObject body = ReadObject(response);
        if ((int)response.StatusCode == 409 && (string?)body["error"] == "publisher-active")
        {
            SetWatchDetails((string?)body["watchId"], (string?)body["watchCode"]);
            _status = LivePublisherStatus.Standby;
            _nextRegistrationAt = _clock.ElapsedMilliseconds + Math.Clamp((int?)body["retryAfterMs"] ?? 5000, 1000, 30_000);
            return;
        }
        if (!response.IsSuccessStatusCode)
        {
            _status = LivePublisherStatus.Reconnecting;
            _nextRegistrationAt = _clock.ElapsedMilliseconds + RetryDelay(response, _retryMs);
            _retryMs = Math.Min(_retryMs * 2, 8000);
            WarnThrottled("Live registration rejected (HTTP " + (int)response.StatusCode + ").");
            return;
        }
        string? sessionId = (string?)body["sessionId"];
        string? token = (string?)body["publishToken"];
        string? watchId = (string?)body["watchId"];
        long epoch = (long?)body["epoch"] ?? -1;
        if (string.IsNullOrEmpty(sessionId) || string.IsNullOrEmpty(token) || string.IsNullOrEmpty(watchId) || epoch < 0)
            throw new InvalidOperationException("Incomplete live registration response.");
        bool newEpoch = epoch != _epoch || !string.Equals(sessionId, _sessionId, StringComparison.Ordinal);
        _sessionId = sessionId;
        _publishToken = token;
        _epoch = epoch;
        SetWatchDetails(watchId, (string?)body["watchCode"]);
        _heartbeatMs = Math.Clamp((int?)body["heartbeatMs"] ?? 5000, 1000, 5000);
        _nextHeartbeatAt = _clock.ElapsedMilliseconds + _heartbeatMs;
        if (newEpoch)
        {
            _sequence = 0;
            _epochOrigin = _records.LatestTime;
            _pendingBody = null;
            _records.ReplaySnapshot(includeRecentEvents: true);
        }
        else if (body["lastProducerSeq"] != null)
        {
            long acknowledged = (long)body["lastProducerSeq"]!;
            RestoreUnacknowledgedEvents(acknowledged);
            _sequence = acknowledged;
            _pendingBody = null;
            _records.ReplaySnapshot(includeRecentEvents: false);
        }
        _retryMs = 500;
        _nextUploadAt = _clock.ElapsedMilliseconds + FlushIntervalMs;
        _status = LivePublisherStatus.Live;
    }

    private string? BuildBatch()
    {
        List<JObject> records = _records.Take(MaxBatchLines, MaxBatchBytes - 4096);
        if (records.Count == 0) return null;
        var body = new StringBuilder();
        foreach (JObject record in records)
        {
            record["t"] = Math.Max(0, ((long?)record["t"] ?? 0) - _epochOrigin);
            body.Append(new JObject { ["producerSeq"] = ++_sequence, ["record"] = record }.ToString(Formatting.None)).Append('\n');
        }
        return body.ToString();
    }

    private HttpResponseMessage Post(string operation, string body, string contentType)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post,
            _serverUrl + "/api/live/v2/sessions/" + Uri.EscapeDataString(_sessionId!) + "/" + operation);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _publishToken);
        request.Content = new StringContent(body, Encoding.UTF8, contentType);
        return _http.SendAsync(request, _cancellation.Token).GetAwaiter().GetResult();
    }

    private void RestoreUnacknowledgedEvents(long acknowledged)
    {
        if (_pendingBody == null) return;
        foreach (string line in _pendingBody.Split('\n'))
        {
            if (line.Length == 0) continue;
            JObject envelope = JObject.Parse(line);
            if ((long?)envelope["producerSeq"] <= acknowledged || envelope["record"] is not JObject record) continue;
            if ((string?)record["type"] != "event") continue;
            record["t"] = ((long?)record["t"] ?? 0) + _epochOrigin;
            _records.Add(record);
        }
    }

    private bool LeaseLost(HttpResponseMessage response)
    {
        int status = (int)response.StatusCode;
        // 410 means the former session ended (disconnect retention or TTL). Its
        // capability cannot be renewed: register a fresh session/watch instead.
        if (status != 401 && status != 404 && status != 409 && status != 410) return false;
        _publishToken = null;
        if (status == 404 || status == 410) ClearWatchDetails();
        _status = LivePublisherStatus.Reconnecting;
        _nextRegistrationAt = _clock.ElapsedMilliseconds + 500;
        return true;
    }

    private static JObject ReadObject(HttpResponseMessage response)
    {
        string text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (text.Length > 32 * 1024) throw new InvalidOperationException("Oversized relay response.");
        try { return JObject.Parse(text); }
        catch (JsonException) { return new JObject(); }
    }

    private void SetWatchDetails(string? watchId, string? watchCode)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        bool validId = !string.IsNullOrEmpty(watchId) && watchId.Length <= 128;
        bool validCode = validId && watchCode?.Length == 4;
        if (validCode)
            foreach (char letter in watchCode!) validCode &= letter >= 'A' && letter <= 'Z';
        // Never navigate to a URL supplied by the relay response.
        Volatile.Write(ref _watchUrl, validId ? _serverUrl + "/?watch=" + Uri.EscapeDataString(watchId!) : null);
        // Codes are assigned to the shared session by the relay, including standby clients.
        // A missing/invalid code never disables a legacy viewing link or retains an old code.
        Volatile.Write(ref _watchCode, validCode ? watchCode : null);
        if (Volatile.Read(ref _disposed) != 0) ClearWatchDetails();
    }

    private void ClearWatchDetails()
    {
        Volatile.Write(ref _watchUrl, null);
        Volatile.Write(ref _watchCode, null);
    }

    private static int RetryDelay(HttpResponseMessage response, int fallback)
    {
        TimeSpan? delta = response.Headers.RetryAfter?.Delta;
        if (delta == null && response.Headers.RetryAfter?.Date is DateTimeOffset date) delta = date - DateTimeOffset.UtcNow;
        return Math.Clamp((int)(delta?.TotalMilliseconds ?? fallback), 500, 30_000);
    }

    private void Backoff()
    {
        _nextUploadAt = _nextRegistrationAt = _clock.ElapsedMilliseconds + _retryMs;
        _nextHeartbeatAt = Math.Max(_nextHeartbeatAt, _nextUploadAt);
        _retryMs = Math.Min(_retryMs * 2, 8000);
    }

    private void TryEnd()
    {
        if (_sessionId == null || _publishToken == null) return;
        try
        {
            // A separate deadline permits end after cancellation without delaying Dispose.
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var request = new HttpRequestMessage(HttpMethod.Post,
                _serverUrl + "/api/live/v2/sessions/" + Uri.EscapeDataString(_sessionId) + "/end");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _publishToken);
            request.Content = new StringContent("{\"reason\":\"publisher-stopped\"}", Encoding.UTF8, "application/json");
            using HttpResponseMessage response = _http.SendAsync(request, deadline.Token).GetAwaiter().GetResult();
        }
        catch { /* The lease expires if a final notification cannot arrive. */ }
    }

    private void WarnThrottled(string message)
    {
        long now = _clock.ElapsedMilliseconds;
        if (now - Interlocked.Read(ref _lastWarningAt) < 60_000) return;
        Interlocked.Exchange(ref _lastWarningAt, now);
        _log.LogWarning(message);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _status = LivePublisherStatus.Stopped;
        ClearWatchDetails();
        _cancellation.Cancel();
    }
}
