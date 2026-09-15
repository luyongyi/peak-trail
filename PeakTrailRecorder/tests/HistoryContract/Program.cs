using System.Reflection;
using System.Text.Json;
using BepInEx.Logging;

static void Assert(bool condition, string message)
{
    if (!condition)
    {
        throw new InvalidOperationException(message);
    }
}

string recorderPath = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory,
    "..",
    "..",
    "PeakTrailRecorder",
    "release",
    "PeakTrailRecorder.dll"));
Assembly.LoadFrom(Path.Combine(AppContext.BaseDirectory, "Newtonsoft.Json.dll"));
Assembly recorder = Assembly.LoadFrom(recorderPath);
Type manifestType = recorder.GetType("PeakTrailRecorder.TraceManifest", throwOnError: true)!;
Type historyType = recorder.GetType("PeakTrailRecorder.AppendOnlyHistoryLog", throwOnError: true)!;
object manifest = Activator.CreateInstance(manifestType)!;

void SetManifest(string property, object? value) =>
    manifestType.GetProperty(property)!.SetValue(manifest, value);

SetManifest("SessionId", "history-contract-session");
SetManifest("StartedAtUtc", "2026-09-15T10:00:00.0000000+00:00");

string root = Path.Combine(Path.GetTempPath(), "peaktrail-history-contract-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var log = new ManualLogSource("PeakTrailHistoryContract");
    object history = historyType.GetMethod("TryOpen")!.Invoke(null, new object[] { root, log })!;
    MethodInfo start = historyType.GetMethod("WriteSessionStart")!;
    MethodInfo trace = historyType.GetMethod("WriteTraceRecord")!;
    MethodInfo end = historyType.GetMethod("WriteSessionEnd")!;

    start.Invoke(history, new[] { manifest });
    trace.Invoke(history, new object[]
    {
        "history-contract-session",
        new Dictionary<string, object?>
        {
            ["type"] = "sample",
            ["t"] = 123L,
            ["playerId"] = "steam:42",
        },
    });

    SetManifest("EndedAtUtc", "2026-09-15T10:01:00.0000000+00:00");
    SetManifest("Status", "complete");
    SetManifest("EndReason", "contract_test");
    end.Invoke(history, new object[] { manifest, 60_000L });

    string path = Path.Combine(root, "PeakTrailHistory.ndjson");
    // AutoFlush plus FileShare.Read makes complete lines readable before Dispose.
    string[] lines;
    using (var readStream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
    using (var reader = new StreamReader(readStream))
    {
        lines = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
    }
    Assert(lines.Length == 3, $"Expected 3 journal lines, received {lines.Length}.");
    using JsonDocument first = JsonDocument.Parse(lines[0]);
    using JsonDocument second = JsonDocument.Parse(lines[1]);
    using JsonDocument third = JsonDocument.Parse(lines[2]);
    Assert(first.RootElement.GetProperty("type").GetString() == "session_start", "session_start missing");
    Assert(first.RootElement.GetProperty("manifest").GetProperty("sessionId").GetString() == "history-contract-session", "manifest not embedded");
    Assert(second.RootElement.GetProperty("type").GetString() == "trace_record", "trace_record missing");
    Assert(second.RootElement.GetProperty("record").GetProperty("t").GetInt64() == 123L, "record not preserved");
    Assert(third.RootElement.GetProperty("type").GetString() == "session_end", "session_end missing");
    Assert(third.RootElement.GetProperty("durationMs").GetInt64() == 60_000L, "duration missing");
    Assert(third.RootElement.GetProperty("status").GetString() == "complete", "status missing");
    Assert(third.RootElement.GetProperty("endReason").GetString() == "contract_test", "reason missing");

    ((IDisposable)history).Dispose();
    Console.WriteLine("PeakTrailHistory contract passed.");
}
finally
{
    Directory.Delete(root, recursive: true);
}
