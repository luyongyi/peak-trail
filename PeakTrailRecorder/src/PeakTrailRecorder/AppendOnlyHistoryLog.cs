using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using BepInEx.Logging;
using Newtonsoft.Json;

namespace PeakTrailRecorder;

/// <summary>
/// Mirrors every per-session record into one append-only journal. Individual
/// session files remain authoritative for crash recovery; a journal failure must
/// never stop the main recording.
/// </summary>
internal sealed class AppendOnlyHistoryLog : IDisposable
{
    public const string FileName = "PeakTrailHistory.ndjson";

    private static readonly JsonSerializerSettings JsonSettings = new()
    {
        NullValueHandling = NullValueHandling.Ignore,
        Culture = CultureInfo.InvariantCulture,
    };

    private readonly ManualLogSource _log;
    private readonly FileStream _stream;
    private readonly StreamWriter _writer;
    private bool _failed;
    private bool _disposed;

    private AppendOnlyHistoryLog(string path, ManualLogSource log)
    {
        _log = log;
        _stream = new FileStream(
            path,
            FileMode.Append,
            FileAccess.Write,
            FileShare.Read,
            16 * 1024,
            FileOptions.SequentialScan);
        _writer = new StreamWriter(
            _stream,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
            16 * 1024)
        {
            AutoFlush = true,
        };
    }

    public static AppendOnlyHistoryLog? TryOpen(string outputRoot, ManualLogSource log)
    {
        try
        {
            Directory.CreateDirectory(outputRoot);
            string path = Path.Combine(outputRoot, FileName);
            var history = new AppendOnlyHistoryLog(path, log);
            log.LogInfo($"Appending cross-session PEAK trail history to '{path}'.");
            return history;
        }
        catch (Exception exception)
        {
            log.LogError(
                $"Could not open {FileName}; per-session recording will continue: {exception}");
            return null;
        }
    }

    public void WriteSessionStart(TraceManifest manifest)
    {
        Write(new Dictionary<string, object?>
        {
            ["type"] = "session_start",
            ["sessionId"] = manifest.SessionId,
            ["manifest"] = manifest,
        });
    }

    public void WriteTraceRecord(string sessionId, object record)
    {
        Write(new Dictionary<string, object?>
        {
            ["type"] = "trace_record",
            ["sessionId"] = sessionId,
            ["record"] = record,
        });
    }

    public void WriteSessionEnd(TraceManifest manifest, long durationMs)
    {
        Write(new Dictionary<string, object?>
        {
            ["type"] = "session_end",
            ["sessionId"] = manifest.SessionId,
            ["endedAtUtc"] = manifest.EndedAtUtc,
            ["durationMs"] = durationMs,
            ["status"] = manifest.Status,
            ["endReason"] = manifest.EndReason,
        });
    }

    private void Write(object value)
    {
        if (_disposed || _failed)
        {
            return;
        }

        try
        {
            _writer.WriteLine(JsonConvert.SerializeObject(value, Formatting.None, JsonSettings));
        }
        catch (Exception exception)
        {
            // Avoid one error per sample if the disk becomes unavailable mid-run.
            _failed = true;
            _log.LogError(
                $"Could not append {FileName}; per-session recording is still active: {exception}");
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _writer.Flush();
            _stream.Flush(flushToDisk: true);
        }
        catch (Exception exception)
        {
            _log.LogWarning($"Could not force the final {FileName} flush: {exception.Message}");
        }
        finally
        {
            _writer.Dispose();
            _stream.Dispose();
        }
    }
}
