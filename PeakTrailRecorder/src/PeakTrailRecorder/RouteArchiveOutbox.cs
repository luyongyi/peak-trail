using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace PeakTrailRecorder;

internal sealed class RouteArchiveJournal : IDisposable
{
    private readonly FileStream _stream;
    private readonly StreamWriter _writer;
    private readonly RouteArchiveOutbox _outbox;
    private readonly Stopwatch _flushClock = Stopwatch.StartNew();
    private bool _closed;
    public string Path { get; }
    public RouteArchiveJournal(RouteArchiveOutbox outbox, RouteArchiveHeader header)
    {
        _outbox = outbox;
        Path = System.IO.Path.Combine(outbox.Root, header.RecordingId + ".ndjson");
        _stream = new FileStream(Path, FileMode.CreateNew, FileAccess.Write, FileShare.Read, 4096);
        _writer = new StreamWriter(_stream, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        _writer.WriteLine(JsonConvert.SerializeObject(header));
        _stream.Flush(true);
        outbox.Register(Path, recovery: false);
    }
    public void Append(RouteArchiveFrame frame, bool critical)
    {
        if (_closed) return;
        _writer.WriteLine(JsonConvert.SerializeObject(frame));
        if (critical || frame.Seal || _flushClock.ElapsedMilliseconds >= 900)
        { _stream.Flush(true); _flushClock.Restart(); }
        if (frame.Seal) _outbox.Request(Path, _stream.Position);
    }
    public void FlushIfDue()
    {
        if (!_closed && _flushClock.ElapsedMilliseconds >= 900) { _writer.Flush(); _stream.Flush(true); _flushClock.Restart(); }
    }
    public void Dispose()
    {
        if (_closed) return;
        _closed = true;
        try { _writer.Flush(); _stream.Flush(true); _outbox.Request(Path, _stream.Position, recovery: true); }
        finally { _writer.Dispose(); _stream.Dispose(); }
    }
}

// No Unity/game reads, no network or compression on Update. ACK receipts advance
// only after a successful durable server response. Journals are never deleted.
// An unfinished journal is itself the crash-recovery outbox, including its tail.
internal sealed class RouteArchiveOutbox
{
    private sealed class Job
    {
        public string Path = "";
        public long Requested, Acknowledged;
        public bool Recovery;
        public DateTime RetryAt;
        public int Failures;
    }
    private readonly ConcurrentDictionary<string, Job> _jobs = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly Action<string> _warning;
    public string Root { get; }
    public RouteArchiveOutbox(string root, Action<string> warning, bool startWorker = true)
    {
        Root = root; _warning = warning; Directory.CreateDirectory(root);
        foreach (string path in Directory.EnumerateFiles(root, "*.ndjson", SearchOption.TopDirectoryOnly))
            try { Register(path, true); } catch (Exception e) { warning("Route journal recovery pending (" + e.GetType().Name + ")."); }
        if (startWorker) _ = Task.Run(Work);
    }
    public void Register(string path, bool recovery)
    {
        _jobs.GetOrAdd(path, p =>
        {
            long acknowledged = 0;
            try { acknowledged = (long?)JObject.Parse(File.ReadAllText(p + ".receipt.json"))["length"] ?? 0; } catch { }
            return new Job { Path = p, Acknowledged = acknowledged, Requested = recovery ? new FileInfo(p).Length : 0, Recovery = recovery };
        });
    }
    public void Request(string path, long length, bool recovery = false)
    {
        if (_jobs.TryGetValue(path, out var job)) lock (job)
        { job.Requested = Math.Max(job.Requested, length); job.Recovery |= recovery; }
        try { _wake.Release(); } catch (SemaphoreFullException) { }
    }
    private async Task Work()
    {
        while (true)
        {
            foreach (var job in _jobs.Values)
            {
                long length; bool recovery;
                lock (job) { length = job.Requested; recovery = job.Recovery; }
                if (length <= job.Acknowledged || DateTime.UtcNow < job.RetryAt) continue;
                try
                {
                    var upload = Prepare(job.Path, length);
                    if (upload.Package["runKey"] == null && !recovery) continue;
                    if (((JArray)upload.Package["players"]!).Count == 0) continue;
                    using var client = new LiveRelayConnection(upload.Header.Server).CreateHttpClient(TimeSpan.FromSeconds(45));
                    client.MaxResponseContentBufferSize = 64 * 1024;
                    using var stream = File.OpenRead(upload.GzipPath);
                    using var content = new StreamContent(stream);
                    content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
                    content.Headers.ContentEncoding.Add("gzip");
                    using var request = new HttpRequestMessage(HttpMethod.Post, "api/route-uploads") { Content = content };
                    request.Headers.TryAddWithoutValidation("X-Trajectory-Format", "trajectory-v1");
                    request.Headers.TryAddWithoutValidation("Prefer", "return=minimal");
                    using var response = await client.SendAsync(request).ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode) throw new IOException("Route archive HTTP " + (int)response.StatusCode);
                    string body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var receipt = JObject.Parse(body);
                    string? id = (string?)receipt["uploadId"];
                    if (id == null || id.Length != 64) throw new IOException("Route archive receipt is invalid.");
                    receipt["length"] = length;
                    AtomicText(job.Path + ".receipt.json", receipt.ToString(Formatting.None));
                    job.Acknowledged = length; job.Failures = 0;
                }
                catch (Exception e)
                {
                    job.Failures++;
                    job.RetryAt = DateTime.UtcNow.AddSeconds(Math.Min(300, 5 * Math.Pow(2, Math.Min(6, job.Failures - 1))));
                    if (e is RouteArchiveBudgetException budget)
                    {
                        try { AtomicText(job.Path + ".failure.json", new JObject { ["status"] = "pending-budget", ["reason"] = budget.Message,
                            ["length"] = length, ["journalRetained"] = true }.ToString(Formatting.None)); } catch { }
                        job.RetryAt = DateTime.UtcNow.AddHours(1);
                    }
                    if (job.Failures == 1 || job.Failures % 10 == 0)
                        _warning("Route upload is pending; durable local journal retained (" + e.GetType().Name + ").");
                }
            }
            await _wake.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
        }
    }
    internal sealed class Prepared
    {
        public RouteArchiveHeader Header = null!;
        public JObject Package = null!;
        public string GzipPath = "";
    }
    internal static Prepared Prepare(string path, long length)
    {
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var bounded = new PrefixStream(input, Math.Min(length, input.Length));
        using var reader = new StreamReader(bounded, new UTF8Encoding(false));
        string? headerLine = reader.ReadLine();
        var header = JsonConvert.DeserializeObject<RouteArchiveHeader>(headerLine ?? "") ?? throw new IOException("Missing route header.");
        if (header.Kind != "header") throw new IOException("Invalid route header.");
        var builder = new RouteArchiveBuilder(header);
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            RouteArchiveFrame? frame;
            try { frame = JsonConvert.DeserializeObject<RouteArchiveFrame>(line); }
            catch (JsonException) when (reader.EndOfStream) { break; } // torn final crash record only
            if (frame != null) builder.Observe(frame);
        }
        var package = builder.Finish();
        string gzip = path + ".pending.gz", temporary = gzip + ".tmp";
        using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            using (var zip = new GZipStream(output, CompressionLevel.Optimal, true))
            using (var limited = new BudgetStream(zip, 64L * 1024 * 1024))
            using (var text = new StreamWriter(limited, new UTF8Encoding(false)))
            using (var json = new JsonTextWriter(text)) package.WriteTo(json);
            if (output.Length > 12L * 1024 * 1024) throw new RouteArchiveBudgetException("compressed-over-12MiB");
            output.Flush(true);
        }
        Replace(temporary, gzip);
        return new Prepared { Header = header, Package = package, GzipPath = gzip };
    }
    internal static void AtomicText(string path, string text)
    {
        string temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        { byte[] bytes = Encoding.UTF8.GetBytes(text); stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
        Replace(temporary, path);
    }
    private static void Replace(string source, string target)
    { if (File.Exists(target)) File.Replace(source, target, null); else File.Move(source, target); }
    private sealed class PrefixStream : Stream
    {
        private readonly Stream _source; private long _remaining;
        public PrefixStream(Stream source, long length) { _source = source; _remaining = length; }
        public override int Read(byte[] buffer, int offset, int count) { int read = _source.Read(buffer, offset, (int)Math.Min(count, _remaining)); _remaining -= read; return read; }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer,int offset,int count) => throw new NotSupportedException();
    }
    private sealed class BudgetStream : Stream
    {
        private readonly Stream _target; private readonly long _limit; private long _written;
        public BudgetStream(Stream target, long limit) { _target = target; _limit = limit; }
        public override void Write(byte[] buffer, int offset, int count)
        { if (_written + count > _limit) throw new RouteArchiveBudgetException("decoded-over-64MiB"); _target.Write(buffer,offset,count); _written += count; }
        public override void Flush() => _target.Flush();
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => _written; public override long Position { get => _written; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer,int offset,int count) => throw new NotSupportedException();
        public override long Seek(long offset,SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException();
    }
}
