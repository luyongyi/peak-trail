using Mono.Cecil;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;
using Photon.Pun;
using UnityEngine;

static void Check(bool value,string why) { if(!value) throw new Exception(why); }
string sha(string text) => RouteArchiveIdentity.Hash(text);
var observations = new List<NativeItemEvents.Observation>();
int? knownActor = 1;
var stream = new NativeItemEvents(sha("synthetic-recorder-items"),_ => new() { Id=knownActor,LiveId="synthetic-private-id" },observations.Add);
var character = new GameObject("Synthetic scout").Add(new Character { Center=new(1,2,3) });
Item Item(string name,int id) => new GameObject(name).Add(new Item { itemID=id,trueHolderCharacter=character,lastThrownCharacter=character });
var spike=Item("ClimbingSpike",1);
var first=stream.StartUse(spike,character,true)!;
var scope=stream.Push(first,"ClimbingSpikeHammered");
var placed=new GameObject("ClimbingSpikeHammered(Clone)"); placed.transform.position=new(5,6,7);
stream.NetworkSpawn(placed); stream.NetworkSpawn(placed); stream.Pop(scope);
Check(observations.Count==2,"native overloads duplicated one placement");
Check(observations[0].Kind=="item-use" && observations[1].Kind=="item-spawn" && observations[0].ActionId==observations[1].ActionId,"use/spawn lost exact action link");
Check(observations[0].Position.x==1 && observations[1].Position.x==5,"use point was replaced by spawn point");
Check((string?)observations[1].Item["prefabName"]=="ClimbingSpikeHammered" && (int?)observations[1].Item["itemId"]==1,"spawn must use actual prefab and original item icon ID");
Time.frameCount++;
var shooter=Item("RopeShooter",2);var shot=stream.StartUse(shooter)!;
scope=stream.Push(shot,"RopeAnchorForRopeShooter",projectile:true);
var projectile=new GameObject("RopeAnchorForRopeShooter(Clone)");projectile.Add(new RopeAnchorProjectile());
var view=projectile.Add(new PhotonView{ViewID=42});var anchor=projectile.Add(new RopeAnchor());anchor.anchorPoint=new GameObject("anchorPoint").transform;
anchor.anchorPoint.position=new(20,30,40);
stream.NetworkSpawn(projectile);stream.Pop(scope);
Check(observations.Count==3,"muzzle projectile was exposed as final spawn");
stream.Anchor(view,null);stream.Anchor(view,null);
Check(observations.Count==4 && observations[3].Position.x==20 && observations[3].ActionId==shot.ActionId,"final anchor lost delayed source or buffered RPC duplicated it");
Check((string?)observations[3].Item["prefabName"]=="RopeAnchorForRopeShooter","rope anchor rendered as gun");
Time.frameCount++;
var shelf=Item("ShelfShroom",3);shelf.gameObject.Add(new ShelfShroom{instantiateOnBreak=new GameObject("ShelfShroomSpawn")});
Zorro.Core.SingletonAsset<ItemDatabase>.Instance=new ItemDatabase { itemLookup=new() { [3]=shelf } };
var remote=new GameObject("ShelfShroomSpawn(Clone)");remote.transform.position=new(50,60,70);
stream.NetworkSpawn(remote);
Check(observations.Count==5 && observations[4].Actor.Id==null && observations[4].ActionId.Length==0,"remote placement guessed a nearby actor/use");
stream.Thrown(shelf,character);scope=stream.Push(stream.Existing(shelf),"ShelfShroomSpawn");
var localShelf=new GameObject("ShelfShroomSpawn(Clone)");localShelf.transform.position=new(51,61,71);stream.NetworkSpawn(localShelf);stream.Pop(scope);
Check(observations.Count==7 && observations[5].ActionId==observations[6].ActionId,"thrown deployment lost native source context");
int beforeDuplicate=observations.Count;stream.Thrown(shelf,character);
Check(observations.Count==beforeDuplicate,"same-frame same-actor throw duplicated completed use");
stream.Thrown(shelf,null);scope=stream.Push(stream.Existing(shelf),"ShelfShroomSpawn");
var unknownThrowSpawn=new GameObject("ShelfShroomSpawn(Clone)");stream.NetworkSpawn(unknownThrowSpawn);stream.Pop(scope);
Check(observations[^1].Actor.Id==null && observations[^1].ActionId.Length==0,"unresolved new throw inherited previous actor/action");
// Unknown identity stays unknown for this action even after identity becomes available.
Time.frameCount++; knownActor=null;var unknown=stream.StartUse(spike,character,true)!;knownActor=1;
scope=stream.Push(unknown,"ClimbingSpikeHammered");var unknownPlaced=new GameObject("ClimbingSpikeHammered(Clone)");stream.NetworkSpawn(unknownPlaced);stream.Pop(scope);
Check(observations[^1].Actor.Id==null && observations[^2].Actor.Id==null,"late identity mutated already published action attribution");
var identityA=new ItemEventIdentity(sha("a"));var identityB=new ItemEventIdentity(sha("b"));
Check(identityA.Action()!=identityB.Action(),"independent observers reused action identity");

var header=new RouteArchiveHeader { RecordingId=sha("synthetic-recorder-items"),StartedUtc="2026-10-21T00:00:00.000Z",
 Map=JObject.Parse("{\"buildId\":25739797,\"scene\":\"Level_0\",\"route\":[\"Shore\"],\"stages\":[{\"index\":0,\"name\":\"Shore\"}]}"),
 Difficulty=JObject.Parse("{\"ascent\":0,\"custom\":false,\"mini\":false}") };
var builder=new RouteArchiveBuilder(header);
string run=RouteArchiveIdentity.Run(Guid.Parse("12345678-1234-5678-9012-123456789012"));
string player=RouteArchiveIdentity.Player(run,"synthetic-owner");
builder.Observe(new() { Time=0,Stage=0,Actors=[new(){Id=1,Key=sha("early-key"),Name="Synthetic scout",Position=[100,200,300],Flags=3}] });
Check(builder.Finish()["itemEvents"]==null,"old journals gained an empty itemEvents field");
var events=observations.Select((e,index)=>new RouteArchiveItemEvent { Id=e.Id,ActionId=e.ActionId,Kind=e.Kind,Time=100+index,Stage=0,
 Position=[RouteArchiveIdentity.Cm(e.Position.x),RouteArchiveIdentity.Cm(e.Position.y),RouteArchiveIdentity.Cm(e.Position.z)],Item=e.Item,Actor=e.Actor.Id }).ToList();
builder.Observe(new() { Time=200,Stage=0,RunKey=run,Origin=10000,Keys=new(){[1]=player},ItemEvents=events,
 Actors=[new(){Id=1,Position=[100,200,300],Flags=3}] });
var package=builder.Finish();var exported=(JArray)package["itemEvents"]!;
Check(exported.Count==observations.Count && exported.All(e=>(string?)e["playerKey"]==player || e["playerKey"]==null),"late run identity did not resolve item owner into package players");
string unknownBefore=exported.Single(e=>(string?)e["id"]==observations[^1].Id).ToString(Formatting.None);
Time.frameCount++;var later=stream.StartUse(spike,character,true)!;
var last=observations[^1];builder.Observe(new(){Time=300,Stage=0,ItemEvents=[new(){Id=last.Id,ActionId=last.ActionId,Kind=last.Kind,Time=300,Stage=0,Position=[100,200,300],Item=last.Item,Actor=last.Actor.Id}],Actors=[new(){Id=1,Position=[100,200,300],Flags=3}]});
var after=(JArray)builder.Finish()["itemEvents"]!;
Check(after.Single(e=>(string?)e["id"]==observations[^2].Id).ToString(Formatting.None)==unknownBefore,"previously acknowledged unknown event changed JSON");
Check((string?)after.Single(e=>(string?)e["id"]==last.Id)["playerKey"]==player,"new event failed to use now-known identity");
Check(!package.ToString().Contains("synthetic-private-id") && !package.ToString().Contains("LiveId"),"journal/export leaked live raw identity");
if(args.Length>=2&&args[0]=="--fixture") File.WriteAllText(args[1],package.ToString(Formatting.Indented)+"\n");

// Read the actual installed binaries, without loading Unity or starting the game.
int managedArg=Array.IndexOf(args,"--managed");
if(managedArg>=0)
{
 string managed=args[managedArg+1];using var game=AssemblyDefinition.ReadAssembly(Path.Combine(managed,"Assembly-CSharp.dll"));
 using var photon=AssemblyDefinition.ReadAssembly(Path.Combine(managed,"PhotonUnityNetworking.dll"));
 TypeDefinition Type(string name)=>game.MainModule.Types.Single(t=>t.Name==name);
 MethodDefinition Method(string type,string name)=>Type(type).Methods.Single(m=>m.Name==name);
 void Signature(string type,string name,string result,params string[] parameters) { var m=Method(type,name);Check(m.ReturnType.Name==result && m.Parameters.Select(p=>p.ParameterType.Name).SequenceEqual(parameters),"native signature changed: "+type+"."+name); }
 Signature("Item","FinishCastPrimary","Void");Signature("Item","FinishCastSecondary","Void");Signature("Item","RPC_SetThrownData","Void","Int32","Single");Signature("Item","Consume","Void","Int32");
 Signature("CharacterItems","HammerClimbingSpike","Void","RaycastHit");Signature("Constructable","FinishConstruction","GameObject");Signature("Constructable","CreatePrefabRPC","Void","Vector3","Quaternion");
 Signature("ShelfShroom","Break","Void","Collision");Signature("CloudFungus","Break","Void");Signature("RopeTier","SpawnRope","Void","Vector3","Quaternion");Signature("RopeShooter","OnPrimaryFinishedCast","Void");
 Signature("Rope","AttachToAnchor_Rpc","Void","PhotonView","Single");Signature("RopeAnchorWithRope","SpawnRope","Rope");
 Check(Method("Constructable","CreatePrefabRPC").Parameters[0].Name=="position" && Method("Rope","AttachToAnchor_Rpc").Parameters[0].Name=="anchorView","Harmony parameter binding changed");
 Check(Method("Item","RPC_SetThrownData").Parameters[0].Name=="characterID","throw actor must bind this RPC's character ID");
 foreach(string field in new[]{"currentClimbingSpikeItemSlot","currentClimbingSpikeComponent","character"}) Check(Type("CharacterItems").Fields.Any(f=>f.Name==field),"spike context field missing: "+field);
 Check(Type("Rope").Fields.Any(f=>f.Name=="spool"),"rope source context disappeared");
 var network=photon.MainModule.Types.Single(t=>t.Name=="PhotonNetwork");
 var overloads=network.Methods.Where(m=>m.Name=="NetworkInstantiate").ToArray();Check(overloads.Length>0 && overloads.All(m=>m.ReturnType.Name=="GameObject"),"network spawn return contract changed");
 var room=network.Methods.Single(m=>m.Name=="InstantiateItemRoom");
 bool ReachesNetwork(MethodDefinition method,HashSet<string> seen)
 {
  if(!seen.Add(method.FullName)||!method.HasBody)return false;
  foreach(var reference in method.Body.Instructions.Select(i=>i.Operand).OfType<MethodReference>())
  {
   if(reference.DeclaringType.FullName!=network.FullName)continue;
   if(reference.Name=="NetworkInstantiate")return true;
   var next=network.Methods.FirstOrDefault(m=>m.FullName==reference.FullName);
   if(next!=null&&ReachesNetwork(next,seen))return true;
  }
  return false;
 }
 Check(ReachesNetwork(room,new()),"item room spawn bypasses observed network path");
 Check(Method("CharacterItems","HammerClimbingSpike").Body.Instructions.Any(i=>i.Operand is MethodReference m && m.Name=="InstantiateItemRoom"),"spike native implementation changed");
 Console.WriteLine("Native 25739797 boundary signatures/fields/Photon instantiate path passed; MVID="+game.MainModule.Mvid);
}
Console.WriteLine("Item event contract passed: exact source scope, remote unknown, real final anchor, duplicate RPC, late identity, immutable previous prefix, optional legacy field, private-ID exclusion.");
