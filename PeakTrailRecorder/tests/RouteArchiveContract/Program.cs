using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;

void Check(bool value, string why) { if (!value) throw new Exception(why); }
string Sha(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
JObject Parse(string value) { using var reader=new JsonTextReader(new StringReader(value)) { DateParseHandling=DateParseHandling.None }; return JObject.Load(reader); }
string run = RouteArchiveIdentity.Run(Guid.Parse("12345678-1234-5678-9012-123456789012"));
Check(run == Sha("peak-memories/run/v1/12345678-1234-5678-9012-123456789012"), "Memories shared run identity diverged");
Check(RouteArchiveIdentity.Player(run, "synthetic-owner") == Sha("peak-memories/player/v1/" + run + "/synthetic-owner"), "Memories player scope diverged");
Check(RouteArchiveIdentity.Cm(-1.125f) == -113, "centimeter rounding differs from Memories");
var header = new RouteArchiveHeader { Server = "http://127.0.0.1:1", RecordingId = Sha("synthetic-route-archive"), StartedUtc = "2026-10-21T00:00:00.0000000Z",
    Map = JObject.Parse("{\"buildId\":25739797,\"scene\":\"Level_0\",\"route\":[\"Shore\",\"Tropics\",\"Void\"],\"stages\":[{\"index\":0,\"name\":\"Shore\",\"enterZCm\":0,\"exitZCm\":1000},{\"index\":1,\"name\":\"Tropics\",\"enterZCm\":1000,\"exitZCm\":2000},{\"index\":2,\"name\":\"Void\"}]}"),
    Difficulty = JObject.Parse("{\"ascent\":8,\"custom\":false,\"mini\":false}") };
RouteArchiveActor Actor(int id, int z, int flags = 1) => new() { Id = id, Key = RouteArchiveIdentity.Player(run, "synthetic-" + id), Name = "Synthetic " + id, Position = [0, 0, z], Flags = flags, Warp=0 };
var frames = new List<RouteArchiveFrame>();
for (int i = 0; i <= 12; i++) frames.Add(new() { Time = i * 100, Stage = 0, RunKey = run, Origin = -2000, Actors = [Actor(1, i * 100, 3), Actor(2, i * 100)] });
frames.Add(new() { Time = 1300, Stage = 1, RunKey = run, Origin = -2000, Checkpoint = 0, Seal = true, Actors = [Actor(1,1300,3), Actor(2,1300)] });
frames.Add(new() { Time = 1400, Stage = 2, RunKey = run, Origin = -2000, Actors = [Actor(1,5000,7), Actor(2,1300,0)] });
frames.Add(new() { Time = 1500, Stage = 2, RunKey = run, Origin = -2000, Actors = [Actor(1,5000,3), Actor(2,1300,0)] });
frames.Add(new() { Time = 1550, Stage = 2, RunKey = run, Origin = -2000, Event = "nadir-wall", Actors = [Actor(1,5025,3), Actor(2,1300,0)] });
frames.Add(new() { Time = 1550, Stage = 2, RunKey = run, Origin = -2000, Event = "nadir-chase", Actors = [Actor(1,5025,3), Actor(2,1300,0)] });
frames.Add(new() { Time = 1600, Stage = 2, RunKey = run, Origin = -2000, Actors = [Actor(1,5050,3), Actor(2,1300,0)] });
frames.Add(new() { Time = 1650, Stage = 2, RunKey = run, Origin = -2000, Seal = true, Closed=true, Actors = [Actor(1,5075,27), Actor(2,1300,0)] });
var builder = new RouteArchiveBuilder(header); foreach (var frame in frames) builder.Observe(frame);
var package = builder.Finish();
var owner = ((JArray)package["players"]!).Cast<JObject>().Single(p => (bool)p["owner"]!);
var other = ((JArray)package["players"]!).Cast<JObject>().Single(p => !(bool)p["owner"]!);
JObject[] Events(JObject p, string kind) => ((JArray)p["events"]!).Cast<JObject>().Where(e => (string?)e["kind"] == kind).ToArray();
Check(Events(owner,"native-checkpoint").Length == 1 && Events(other,"native-checkpoint").Length == 0, "global stage manufactured another player's checkpoint");
Check(Events(owner,"nadir-entry").Single().Value<int>("tMs") == 1500, "Void entry preceded completed warp");
Check(Events(owner,"nadir-wall").Length == 1 && Events(owner,"nadir-chase").Length == 1, "same-frame phases were merged");
Check(Events(owner,"nadir").Single()["positionCm"]![2]!.Value<int>() == 5075, "same bucket final outcome anchor was lost");
Check(Events(owner,"summit").Length == 0 && Events(other,"nadir").Length == 0, "Nadir outcome assigned to wrong player or peak");
Check(Events(owner,"break").Length > 0, "warp was connected into route");
Check((long)package["timeOriginMs"]! == -2000, "negative shared anchor was clamped");
var lateVoid = new RouteArchiveBuilder(header);
lateVoid.Observe(new() { Time=0, Stage=2, RunKey=run, Origin=100_000, Actors=[Actor(1,5000,3)] });
Check(Events((JObject)lateVoid.Finish()["players"]![0]!,"nadir-entry").Length==0,"starting midway through Void fabricated a realm entry");
var late = new RouteArchiveBuilder(header);
late.Observe(new() { Time = 0, Stage = 0, Actors = [new() { Id=1,Key=Sha("old-recording-scope"),Name="Synthetic",Position=[0,0,0],Flags=1 }] });
late.Observe(new() { Time = 100, Stage=0, RunKey=run,Origin=-2000,Keys=new() { [1]=RouteArchiveIdentity.Player(run,"synthetic-1") } });
Check((string?)late.Finish()["players"]![0]!["key"] == RouteArchiveIdentity.Player(run,"synthetic-1"), "late RunId failed to rekey a departed actor's history");
bool budget = false; try { late.Observe(new() { Time=14_400_001 }); } catch (RouteArchiveBudgetException) { budget=true; }
Check(budget,"four-hour excess silently exported");

string temp = Path.Combine(Path.GetTempPath(), "PeakTrailRouteContract-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temp);
// This is exclusively synthetic data, and is intentionally retained on failure.
var outbox = new RouteArchiveOutbox(temp, _ => { }, startWorker:false);
string journal;
using (var writer = new RouteArchiveJournal(outbox, header)) { journal=writer.Path; foreach(var frame in frames) writer.Append(frame,true); }
var prepared = RouteArchiveOutbox.Prepare(journal,new FileInfo(journal).Length);
Check(JToken.DeepEquals(prepared.Package,package),"durable round-trip changed trajectory");
using(var zip=new GZipStream(File.OpenRead(prepared.GzipPath),CompressionMode.Decompress))
using(var reader=new StreamReader(zip)) Check(JToken.DeepEquals(Parse(reader.ReadToEnd()),package),"gzip payload changed trajectory");
long completeLength = new FileInfo(journal).Length;
File.AppendAllText(journal,"{\"t\":1700,\"a\":[{\"n\":\"断",new UTF8Encoding(false));
var recovered=RouteArchiveOutbox.Prepare(journal,new FileInfo(journal).Length);
Check(JToken.DeepEquals(recovered.Package,package),"crash tail prevented valid prefix recovery");
var beforeTail=RouteArchiveOutbox.Prepare(journal,completeLength);
Check(JToken.DeepEquals(beforeTail.Package,package),"prefix seal read beyond requested bytes");

var socket=new TcpListener(IPAddress.Loopback,0);socket.Start();int port=((IPEndPoint)socket.LocalEndpoint).Port;socket.Stop();
using var listener=new HttpListener();listener.Prefixes.Add($"http://127.0.0.1:{port}/");listener.Start();
string resumeRoot=Path.Combine(temp,"resume");Directory.CreateDirectory(resumeRoot);
header.Server=$"http://127.0.0.1:{port}";
string resumePath=Path.Combine(resumeRoot,header.RecordingId+".ndjson");
File.WriteAllText(resumePath,JsonConvert.SerializeObject(header)+"\n"+string.Join("\n",frames.Select(JsonConvert.SerializeObject))+"\n",new UTF8Encoding(false));
// No seal file, gzip or clean Dispose: startup must recover the journal itself.
int requests=0;
var responder=Task.Run(async()=>{
    while(requests<2) {
        var context=await listener.GetContextAsync(); requests++;
        Check(context.Request.Url!.AbsolutePath=="/api/route-uploads","wrong upload endpoint");
        using(var zip=new GZipStream(context.Request.InputStream,CompressionMode.Decompress))
        using(var reader=new StreamReader(zip)) Check(JToken.DeepEquals(Parse(await reader.ReadToEndAsync()),package),"recovered HTTP payload differs");
        context.Response.StatusCode=requests==1?503:201;
        byte[] reply=Encoding.UTF8.GetBytes(requests==1?"{}":"{\"uploadId\":\""+new string('a',64)+"\",\"groupId\":\""+new string('b',64)+"\",\"moderationStatus\":\"approved\"}");
        await context.Response.OutputStream.WriteAsync(reply);context.Response.Close();
    }
});
_ = new RouteArchiveOutbox(resumeRoot,_=>{});
var deadline=DateTime.UtcNow.AddSeconds(20);
while(!File.Exists(resumePath+".receipt.json")&&DateTime.UtcNow<deadline) await Task.Delay(50);
Check(File.Exists(resumePath+".receipt.json")&&requests==2,"failed HTTP did not retry from durable startup journal");
await responder;
Check(File.Exists(resumePath),"ACK deleted permanent local journal");
Check((long)JObject.Parse(File.ReadAllText(resumePath+".receipt.json"))["length"]! == new FileInfo(resumePath).Length,"receipt advanced wrong prefix");
// Optional explicit fixture path makes cross-language validation repeatable.
if(args.Length==2&&args[0]=="--fixture") File.WriteAllText(args[1],package.ToString(Formatting.Indented)+"\n",new UTF8Encoding(false));
Console.WriteLine("Route archive contract passed: native outcomes/owner checkpoint/late identity/shared clock/crash-tail/gzip/startup recovery/retry/budgets.");
