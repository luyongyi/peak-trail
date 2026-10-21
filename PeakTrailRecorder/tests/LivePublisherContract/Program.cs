using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using BepInEx.Logging;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;

const string rawPlayer = "76561198000012345";
const string runId = "9bf6aaa3-0712-49e2-83d0-6e54930c3d90";
static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
static async Task Until(Func<bool> predicate, string message, int timeout = 5000)
{
    var clock = Stopwatch.StartNew();
    while (!predicate())
    {
        if (clock.ElapsedMilliseconds >= timeout) throw new TimeoutException(message);
        await Task.Delay(10);
    }
}
static Dictionary<string, object?> Record(string type, long time, params (string Key, object? Value)[] values)
{
    var record = new Dictionary<string, object?> { ["type"] = type, ["t"] = time };
    foreach ((string key, object? value) in values) record[key] = value;
    return record;
}
static HttpResponseMessage Json(HttpStatusCode status, object value)
    => new(status) { Content = new StringContent(JsonConvert.SerializeObject(value)) };
static HttpResponseMessage Registered(int epoch = 1, long acknowledged = 0, char identity = 'a',
    string? watchCode = "ABCD", HttpStatusCode status = HttpStatusCode.Created)
    => Json(status, new
    {
        sessionId = new string(identity, 32), watchId = new string(identity == 'a' ? 'b' : 'd', 32), publishToken = "test-publish-token",
        watchCode = identity == 'a' ? watchCode : "WXYZ",
        epoch, lastProducerSeq = acknowledged, heartbeatMs = 1000, leaseMs = 15000,
    });
static IEnumerable<JObject> Envelopes(Captured request)
    => request.Body.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(JObject.Parse);

// The fixture is made from the same production projection used by the game.
var projector = new LivePayload();
var manifest = new TraceManifest { RunId = runId };
var fixtureRecords = new List<JObject>();
fixtureRecords.Add(projector.Record(Record("participant", 1000,
    ("playerId", rawPlayer), ("nickname", "测试玩家\nName"), ("platform", "steam"), ("idSource", "photon"), ("actorNumber", 1)))!);
fixtureRecords.Add(projector.Record(Record("sample", 1100,
    ("playerId", rawPlayer), ("pos", new[] { 1f, 2f, 3f }), ("yaw", 45f),
    ("stamina", .8f), ("capacityReady", true), ("item", new { id = "rock", itemId = 1, name = "Rock", instanceId = "private-guid", data = new[] { "private" } })))!);
fixtureRecords.Add(projector.Record(Record("state", 1100, ("playerId", rawPlayer), ("stamina", .8f), ("telemetryReady", true)))!);
fixtureRecords.Add(projector.Record(Record("appearance", 1100, ("playerId", rawPlayer),
    ("appearance", new { ready = true, skinIndex = 1, skinColor = new[] { 1f, .5f, .2f, 1f }, formMaterialNames = new[] { "Material" }, steamId = rawPlayer })))!);
fixtureRecords.Add(projector.Record(Record("inventory", 1100, ("playerId", rawPlayer),
    ("inventoryReady", true), ("held", null), ("slots", new[] { new { location = "slot:0", container = "main", index = 0, slotId = 0, empty = false, parentInstanceId = "private-parent", item = new { id = "rock", itemId = 1, name = "Rock" } } })))!);
fixtureRecords.Add(projector.Record(Record("status", 1100, ("playerId", rawPlayer), ("reason", "changed"),
    ("status", new { ready = true, complete = true, dead = false, values = new[] { new { id = 1, type = "Cold", amount = .2f, staminaBlock = .2f, extraStaminaBlock = 0f } }, effects = new[] { new { typeId = 1, type = "Cold" } } })))!);
fixtureRecords.Add(projector.Record(Record("route", 1100,
    ("route", new { authority = "maphandler-resolved-biomes", branch = "volcano-kiln", segments = new[] { new { index = 0, biome = "Shore", biomeId = 0, name = "Shore", variantSelected = false } } })))!);
fixtureRecords.Add(projector.Record(Record("event", 1100, ("playerId", rawPlayer), ("event", "item_thrown"),
    ("pos", new[] { 1f, 2f, 3f }), ("throwCharge", .8f), ("source", "observed"), ("unknownSecret", rawPlayer)))!);
var fixture = new JObject { ["manifest"] = LivePayload.Manifest(manifest), ["records"] = new JArray(fixtureRecords) };
string projected = fixture.ToString(Formatting.None);
Check(!projected.Contains(rawPlayer) && !projected.Contains(runId) && !projected.Contains("private"), "Projection leaked raw identity or item metadata.");
Check(!projected.Contains("actorNumber") && !projected.Contains("idSource") && !projected.Contains("platform"), "Projection leaked platform identity fields.");
Check(fixtureRecords.Take(6).All(record => (string?)record["playerId"] == "p1"), "A player must keep one anonymous identity.");
Check((string?)fixtureRecords[0]["nickname"] == "测试玩家Name", "Control characters must not poison a valid batch.");
Check(projector.Record(Record("world_snapshot", 1, ("objects", new object[0]))) == null, "World data is outside the public v2 contract.");
var itemAction = new string('c',64);
var itemEvent = projector.Record(Record("event",1100,("event","item-spawn"),("id",new string('d',64)),("actionId",itemAction),
    ("playerId",rawPlayer),("pos",new[]{5f,6f,7f}),("item",new{itemId=1,prefabName="ClimbingSpikeHammered",instanceId="private-guid"})))!;
Check((string?)itemEvent["id"]==new string('d',64) && (string?)itemEvent["actionId"]==itemAction && (string?)itemEvent["playerId"]=="p1",
    "Item event identity/anonymous player mapping was stripped.");
Check(!itemEvent.ToString().Contains("private-guid") && !itemEvent.ToString().Contains(rawPlayer),"Item event leaked private IDs.");
Check(projector.Record(Record("inventory", 1, ("playerId", rawPlayer), ("slots",
    Enumerable.Range(0, 32).Select(i => new { location = "slot" + i, item = new { id = "x", name = new string('界', 256), displayName = new string('界', 256) } }).ToArray()))) == null,
    "An oversized DTO must not poison an otherwise valid batch.");
Check(LivePayload.RoomKey(runId, "Level_0") != LivePayload.RoomKey(runId, "Level_1"), "Scene changes require a distinct room.");
if (args.Length == 2 && args[0] == "--fixture") File.WriteAllText(args[1], fixture.ToString(Formatting.Indented));

var buffer = new LiveRecordBuffer();
buffer.Add(fixtureRecords[0]);
for (int i = 0; i < 5000; i++) buffer.Add(new JObject { ["type"] = "sample", ["playerId"] = "p1", ["t"] = i, ["pos"] = new JArray(i, 0, 0) });
buffer.ReplaySnapshot(true);
List<JObject> snapshot = buffer.Take(40, 128 * 1024);
Check(snapshot.Count == 2 && (string?)snapshot[0]["type"] == "participant", "Initial participant must survive registration and precede latest sample.");
Check((int)snapshot[1]["pos"]![0]! == 4999 && (long)snapshot[0]["t"]! == 4999, "Outage positions should coalesce to the latest snapshot.");

// A missing RunId must not register; the original manifest may acquire it later.
using (var handler = new FakeHandler((request, _) => Task.FromResult(request.Path.EndsWith("/sessions") ? Registered() : Json(HttpStatusCode.OK, new { }))))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    var delayed = new TraceManifest();
    live.Configure(delayed, rawPlayer);
    live.Publish(Record("participant", 10, ("playerId", rawPlayer), ("nickname", "Player")), 999);
    await Task.Delay(250);
    Check(handler.Requests.IsEmpty, "Empty RunId should not produce a registration request.");
    delayed.RunId = runId;
    live.RefreshManifest();
    await Until(() => handler.Requests.Any(request => request.Path.EndsWith("/records")), "initial snapshot not uploaded");
    Captured registration = handler.Requests.First(request => request.Path.EndsWith("/sessions"));
    Check(!registration.Body.Contains(runId) && !registration.Body.Contains(rawPlayer), "Registration leaked raw identifiers.");
    Check(registration.Authorization == null && (string?)JObject.Parse(registration.Body)["roomKey"] == LivePayload.RoomKey(runId, "Level_0"), "Registration contract mismatch.");
    Captured first = handler.Requests.First(request => request.Path.EndsWith("/records"));
    Check(first.Authorization == "Bearer test-publish-token" && !first.Path.Contains("producer"), "Publishing capability must be private header-only.");
    Check((string?)Envelopes(first).First()["record"]!["type"] == "participant", "Pre-registration participant was lost.");
    Check(live.WatchUrl == "https://relay.invalid/?watch=" + new string('b', 32), "Watch URL must never contain the publishing token.");
    Check(live.WatchCode == "ABCD", "Registration must expose the relay-assigned live code.");
    await Until(() => handler.Requests.Any(request => request.Path.EndsWith("/heartbeat")), "idle publisher failed to renew lease");
}

// 429 and a lost HTTP response both retry byte-for-byte, then deliver fresh state.
int attempts = 0;
using (var handler = new FakeHandler((request, _) =>
{
    if (request.Path.EndsWith("/sessions")) return Task.FromResult(Registered());
    if (request.Path.EndsWith("/records"))
    {
        int attempt = Interlocked.Increment(ref attempts);
        if (attempt == 1) return Task.FromResult(Json((HttpStatusCode)429, new { error = "rate-limited" }));
        if (attempt == 2) throw new HttpRequestException("Simulated lost acknowledgement.");
    }
    return Task.FromResult(Json(HttpStatusCode.OK, new { }));
}))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    live.Configure(new TraceManifest { RunId = runId }, rawPlayer);
    live.Publish(Record("participant", 1, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    await Until(() => attempts >= 1, "initial upload missing");
    for (int i = 0; i < 80; i++)
    {
        live.Publish(Record("sample", 100 + i, ("playerId", rawPlayer), ("pos", new[] { i, 0, 0 }), ("yaw", 0)), 0);
        await Task.Delay(5);
    }
    await Until(() => attempts >= 4, "retry/fresh state sequence incomplete");
    Captured[] uploads = handler.Requests.Where(request => request.Path.EndsWith("/records")).ToArray();
    Check(uploads[0].Body == uploads[1].Body && uploads[1].Body == uploads[2].Body, "Retries must preserve producer sequence and body.");
    Check(uploads[1].AtMs - uploads[0].AtMs >= 900, "429 must back off.");
    Check(uploads.Zip(uploads.Skip(1)).All(pair => pair.Second.AtMs - pair.First.AtMs >= 90), "Uploading faster than the fixed 100 ms tick.");
    Check(Envelopes(uploads[3]).Any(envelope => (int?)envelope["record"]?["pos"]?[0] == 79), "Outage recovery should send the latest position.");
}

// Lease revocation creates a fresh epoch, reset sequence and coherent state snapshot.
int registrations = 0, recordCalls = 0;
using (var handler = new FakeHandler((request, _) =>
{
    if (request.Path.EndsWith("/sessions")) return Task.FromResult(Registered(Interlocked.Increment(ref registrations)));
    if (request.Path.EndsWith("/records") && Interlocked.Increment(ref recordCalls) == 1)
        return Task.FromResult(Json(HttpStatusCode.Unauthorized, new { error = "lease-expired" }));
    return Task.FromResult(Json(HttpStatusCode.OK, new { }));
}))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    live.Configure(new TraceManifest { RunId = runId }, null);
    live.Publish(Record("participant", 9000, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    live.Publish(Record("sample", 9500, ("playerId", rawPlayer), ("pos", new[] { 1, 2, 3 }), ("yaw", 0)), 0);
    await Until(() => recordCalls >= 2, "lease was not reacquired");
    Captured upload = handler.Requests.Last(request => request.Path.EndsWith("/records"));
    JObject[] records = Envelopes(upload).ToArray();
    Check((int)records[0]["producerSeq"]! == 1 && records.All(record => (int)record["record"]!["t"]! == 0), "New epoch must restart sequence and rebase full snapshot.");
    Check(records.Any(record => (string?)record["record"]!["type"] == "participant"), "Reacquisition lost participant.");
    Check(live.WatchCode == "ABCD", "Lease recovery must preserve the shared session's live code.");
}

// Ended sessions return 410 for both upload and heartbeat. Renewing their old
// token cannot work: create a new session/watch and publish its full snapshot.
foreach (string expiresAt in new[] { "records", "heartbeat" })
{
    int creates = 0, expired = 0;
    using var handler = new FakeHandler((request, _) =>
    {
        if (request.Path.EndsWith("/sessions"))
            return Task.FromResult(Registered(identity: Interlocked.Increment(ref creates) == 1 ? 'a' : 'c'));
        if (request.Path.EndsWith("/" + expiresAt) && Interlocked.Increment(ref expired) == 1)
            return Task.FromResult(Json(HttpStatusCode.Gone, new { error = "session-ended" }));
        return Task.FromResult(Json(HttpStatusCode.OK, new { }));
    });
    using var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler);
    live.Configure(new TraceManifest { RunId = runId }, null);
    live.Publish(Record("participant", 5000, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    await Until(() => handler.Requests.Any(request => request.Path.Contains(new string('c', 32)) && request.Path.EndsWith("/records")),
        "410 " + expiresAt + " failed to start a new session");
    Check(live.WatchUrl == "https://relay.invalid/?watch=" + new string('d', 32), "Ended-session recovery must replace the old watch link.");
    Check(live.WatchCode == "WXYZ", "A new session must replace the ended session's live code.");
    JObject first = Envelopes(handler.Requests.First(request => request.Path.Contains(new string('c', 32)) && request.Path.EndsWith("/records"))).First();
    Check((long)first["producerSeq"]! == 1 && (long)first["record"]!["t"]! == 0
        && (string?)first["record"]!["type"] == "participant", "New session must reset sequence and send its participant snapshot.");
}

// Same-epoch registration may acknowledge a prefix; preserve its unacknowledged event.
int sameEpochRegistrations = 0, sameEpochUploads = 0;
using (var handler = new FakeHandler((request, _) =>
{
    if (request.Path.EndsWith("/sessions"))
        return Task.FromResult(Registered(1, Interlocked.Increment(ref sameEpochRegistrations) == 1 ? 0 : 1));
    if (request.Path.EndsWith("/records") && Interlocked.Increment(ref sameEpochUploads) == 1)
        return Task.FromResult(Json(HttpStatusCode.Conflict, new { error = "producer-sequence-gap" }));
    return Task.FromResult(Json(HttpStatusCode.OK, new { }));
}))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    live.Configure(new TraceManifest { RunId = runId }, null);
    live.Publish(Record("participant", 100, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    live.Publish(Record("event", 101, ("playerId", rawPlayer), ("event", "death")), 0);
    await Until(() => sameEpochUploads >= 2, "same-epoch recovery did not upload");
    JObject[] records = Envelopes(handler.Requests.Last(request => request.Path.EndsWith("/records"))).ToArray();
    Check((int)records[0]["producerSeq"]! == 2, "Same epoch must continue from server-confirmed sequence.");
    Check(records.Any(record => (string?)record["record"]!["event"] == "death"), "Recovery lost an unacknowledged event.");
}

// Standby keeps current values and only takes over after retrying registration.
int standbyCreates = 0;
using (var handler = new FakeHandler((request, _) =>
{
    if (request.Path.EndsWith("/sessions") && Interlocked.Increment(ref standbyCreates) == 1)
        return Task.FromResult(Json(HttpStatusCode.Conflict, new { error = "publisher-active", retryAfterMs = 1000, watchId = new string('b', 32), watchCode = "ABCD" }));
    return Task.FromResult(request.Path.EndsWith("/sessions") ? Registered(2) : Json(HttpStatusCode.OK, new { }));
}))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    live.Configure(new TraceManifest { RunId = runId }, null);
    live.Publish(Record("participant", 1, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    await Until(() => live.Status == LivePublisherStatus.Standby, "publisher did not enter standby");
    Check(!handler.Requests.Any(request => request.Path.EndsWith("/records")) && live.WatchUrl != null, "Standby must expose viewing but never upload without a token.");
    Check(live.WatchCode == "ABCD", "Standby teammates must expose the same relay-assigned live code.");
    live.Publish(Record("sample", 6000, ("playerId", rawPlayer), ("pos", new[] { 8, 2, 3 }), ("yaw", 0)), 0);
    await Until(() => handler.Requests.Any(request => request.Path.EndsWith("/records")), "standby never took over");
    Check(live.WatchCode == "ABCD", "Taking over a shared session must not replace its live code.");
}

// Both success statuses and standby accept only the four ASCII capitals supplied by the relay.
// Missing codes from an older relay must not break existing watch links or publishing.
foreach (HttpStatusCode status in new[] { HttpStatusCode.Created, HttpStatusCode.OK, HttpStatusCode.Conflict })
foreach (string? code in new string?[] { "PEAK", null, "", "abcD", "ABC", "ABCDE", "AB1D", "ABCD\n", "ＡBCD" })
{
    using var handler = new FakeHandler((request, _) => Task.FromResult(!request.Path.EndsWith("/sessions")
        ? Json(HttpStatusCode.OK, new { })
        : status == HttpStatusCode.Conflict
            ? Json(status, new { error = "publisher-active", retryAfterMs = 30_000, watchId = new string('b', 32), watchCode = code })
            : Registered(watchCode: code, status: status)));
    using var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler);
    live.Configure(new TraceManifest { RunId = runId }, null);
    await Until(() => live.Status == (status == HttpStatusCode.Conflict ? LivePublisherStatus.Standby : LivePublisherStatus.Live),
        "Registration with optional watch code did not finish");
    Check(live.WatchCode == (code == "PEAK" ? code : null), "Invalid watch code was exposed: " + code);
    Check(live.WatchUrl == "https://relay.invalid/?watch=" + new string('b', 32), "Optional watch code broke the compatible watch URL.");
    live.Dispose();
    Check(live.WatchCode == null && live.WatchUrl == null, "Stopping active or standby publishing must immediately clear viewing details.");
}

// Do not keep a previous code if re-registration no longer supplies one.
int codeCreates = 0;
using (var handler = new FakeHandler((request, _) => Task.FromResult(request.Path.EndsWith("/sessions")
    ? Registered(watchCode: Interlocked.Increment(ref codeCreates) == 1 ? "ABCD" : null)
    : request.Path.EndsWith("/records") && Volatile.Read(ref codeCreates) == 1
        ? Json(HttpStatusCode.Unauthorized, new { error = "lease-expired" })
        : Json(HttpStatusCode.OK, new { }))))
using (var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler))
{
    live.Configure(new TraceManifest { RunId = runId }, null);
    await Until(() => live.WatchCode == "ABCD", "Initial live code missing");
    live.Publish(Record("participant", 1, ("playerId", rawPlayer)), 0);
    await Until(() => Volatile.Read(ref codeCreates) >= 2 && live.Status == LivePublisherStatus.Live, "Code-less recovery did not finish");
    Check(live.WatchCode == null && live.WatchUrl != null, "Code-less recovery retained a stale code or lost its viewing link.");
}

// Dispose must cancel in-flight HTTP immediately and never wait for an end request.
var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
using (var handler = new FakeHandler(async (request, cancellation) =>
{
    if (request.Path.EndsWith("/sessions")) return Registered();
    if (request.Path.EndsWith("/records"))
    {
        started.TrySetResult();
        try { await Task.Delay(Timeout.Infinite, cancellation); }
        catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
    }
    return Json(HttpStatusCode.OK, new { });
}))
{
    var live = new LivePublisher("https://relay.invalid", new ManualLogSource(), handler);
    live.Configure(new TraceManifest { RunId = runId }, null);
    live.Publish(Record("participant", 1, ("playerId", rawPlayer), ("nickname", "Player")), 0);
    await started.Task.WaitAsync(TimeSpan.FromSeconds(3));
    var elapsed = Stopwatch.StartNew();
    live.Dispose();
    Check(elapsed.ElapsedMilliseconds < 100 && live.Status == LivePublisherStatus.Stopped, "Dispose blocked the caller.");
    Check(live.WatchCode == null && live.WatchUrl == null, "Dispose retained viewing details while HTTP was in flight.");
    await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(1));
    await Until(() => handler.Requests.Any(request => request.Path.EndsWith("/end")), "best-effort end missing");
}
Console.WriteLine("PeakTrail live publisher contract passed: privacy, snapshot/coalescing, fixed cadence, retry, lease, standby, live codes, legacy links, heartbeat, cancellation.");

internal sealed record Captured(string Path, string Body, string? Authorization, long AtMs);
internal sealed class FakeHandler(Func<Captured, CancellationToken, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    public ConcurrentQueue<Captured> Requests { get; } = new();
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string body = request.Content == null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        var captured = new Captured(request.RequestUri!.AbsolutePath, body, request.Headers.Authorization?.ToString(), _clock.ElapsedMilliseconds);
        Requests.Enqueue(captured);
        return await respond(captured, cancellationToken);
    }
}
