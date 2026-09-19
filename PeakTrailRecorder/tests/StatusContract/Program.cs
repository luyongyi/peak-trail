using System.Reflection;
using Newtonsoft.Json.Linq;
using PeakTrailRecorder;
using Photon.Pun;

int checks = 0;
void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
    checks++;
}
static Character NewCharacter(bool local)
{
    var character = new Character();
    character.photonView.IsMine = local;
    character.refs.afflictions.character = character;
    return character;
}
static void StatusRpc(Character character, float[]? packet = null)
    => typeof(PlayerStatusReader).GetMethod("AfterStatusArray", BindingFlags.NonPublic | BindingFlags.Static)!
        .Invoke(null, new object?[] { character.refs.afflictions, packet ?? character.refs.afflictions.currentStatuses });
static void EffectsRpc(Character character)
    => typeof(PlayerStatusReader).GetMethod("AfterEffects", BindingFlags.NonPublic | BindingFlags.Static)!
        .Invoke(null, new object[] { character.refs.afflictions });

var local = NewCharacter(true);
local.refs.afflictions.currentStatuses[2] = .25f;
local.refs.afflictions.currentStatuses[5] = .125f;
local.data.petrifyAmount = 40;
var status = PlayerStatusReader.Read(local);
Check(status.Ready && status.Complete && status.EffectsReady, "Local fully initialized readings must be ready.");
Check(status.Values.Count == 15 && status.Values.Select(v => v.Id).SequenceEqual(Enumerable.Range(0, 15)), "Capture every enum ID including zero values.");
Check(status.Authority == "local-owner-authoritative", "Local authority must be explicit.");
Check(status.Values.Single(v => v.Type == "Cold").StaminaBlock == .25f, "Cold directly occupies ordinary stamina.");
Check(status.Values.Single(v => v.Type == "Curse").StaminaBlock == .125f, "Curse directly occupies ordinary stamina.");
Check(status.StatusSum == .375f && status.MaxStamina == .625f, "Do not renormalize damaged ordinary capacity to one.");
Check(status.BaseMaxStamina == 1f && status.BaseMaxExtraStamina == 1f, "Both bars use the original base capacity.");
var stone = status.Values.Single(v => v.Type == "Petrify");
Check(Math.Abs(stone.Amount - .4f) < .00001f && stone.StaminaBlock == 0 && Math.Abs(stone.ExtraStaminaBlock - .4f) < .00001f, "Petrify is sourced from CharacterData, not the normally-zero ordinary slot.");
Check(Math.Abs(status.MaxExtraStamina!.Value - .6f) < .00001f, "Petrify caps only extra stamina.");
Check(status.Values.Single(v => v.Type == "Hot").Amount == 0, "Observed zero statuses must survive serialization.");
Check(status.Source == "recorded" && !status.Values.Any(v => v.Type == "Frozen"), "Do not invent a Frozen type or non-historical source.");

local.refs.afflictions.currentStatuses[0] = 1.5f;
status = PlayerStatusReader.Read(local);
Check(status.StatusSum > 1 && status.MaxStamina == 0, "Retain overflow damage; only remaining capacity clamps to zero.");
local.refs.afflictions.currentStatuses[0] = 0;
local.refs.afflictions.afflictionList.Add(new(Affliction.Kind.InfiniteStamina));
local.refs.afflictions.afflictionList.Add(new(Affliction.Kind.ColdOverTime));
status = PlayerStatusReader.Read(local);
Check(status.Effects.Select(e => e.Type).SequenceEqual(new[] { "InfiniteStamina", "ColdOverTime" }), "Capture positive and negative effects, deterministically ordered.");
Check(!JObject.Parse(status.Fingerprint())["effects"]![0]!.Children<JProperty>().Any(p => p.Name.Contains("time", StringComparison.OrdinalIgnoreCase)), "No unverified timer fields.");
local.data.dead = true;
var dead = PlayerStatusReader.Read(local);
Check(dead.Dead == true && dead.StatusSum == status.StatusSum && dead.Effects.Count == status.Effects.Count, "Death must not fabricate zero/clear game values.");
Check(dead.ChangeReason(status) == "death", "A death transition must be identified.");
local.data.dead = false;
local.refs.afflictions.currentStatuses = new float[15];
local.refs.afflictions.currentStatuses[5] = .2f;
local.refs.afflictions.afflictionList.Clear();
var revived = PlayerStatusReader.Read(local);
Check(revived.ChangeReason(dead) == "revive" && revived.Values.Single(v => v.Type == "Curse").Amount == .2f, "Revive retains actually observed curse.");
local.refs.afflictions.currentStatuses[5] = 0;
local.data.petrifyAmount = 0;
var cleared = PlayerStatusReader.Read(local);
Check(cleared.ChangeReason(revived) == "cleared" && cleared.Effects.Count == 0, "An observed clear must replace older values and effects.");
Check(cleared.ChangeReason(null) == "initial" && cleared.Fingerprint() != revived.Fingerprint(), "Initial and cleared snapshots are distinct.");

var remote = NewCharacter(false);
var unavailable = PlayerStatusReader.Read(remote);
Check(!unavailable.Ready && !unavailable.EffectsReady && unavailable.Values.Count == 0 && unavailable.MaxStamina == null, "Unreceived remote zeros are unknown, not healthy.");
remote.syncer.RemoteValue.IsSome = true;
unavailable = PlayerStatusReader.Read(remote);
Check(!unavailable.Ready && !PlayerStatusReader.HasStatusCapacity(remote), "Movement/stamina readiness alone cannot certify status capacity.");
StatusRpc(remote, new float[14]);
Check(!PlayerStatusReader.HasStatusCapacity(remote), "Wrong-length status packets cannot establish readiness.");
var malformed = new float[15];
malformed[2] = float.NaN;
StatusRpc(remote, malformed);
Check(!PlayerStatusReader.HasStatusCapacity(remote), "NaN status packets cannot establish readiness.");
malformed[2] = float.PositiveInfinity;
StatusRpc(remote, malformed);
Check(!PlayerStatusReader.HasStatusCapacity(remote), "Infinite status packets cannot establish readiness.");
malformed[2] = -.25f;
StatusRpc(remote, malformed);
Check(!PlayerStatusReader.HasStatusCapacity(remote), "Negative status packets cannot establish readiness.");
StatusRpc(remote);
var received = PlayerStatusReader.Read(remote);
Check(received.Ready && received.Values.Count == 15 && !received.EffectsReady, "Status RPC proves the bar but not the independent effect list.");
Check(received.Authority == "photon-status-rpc-observed", "Do not claim stronger remote sender verification than the game provides.");
EffectsRpc(remote);
received = PlayerStatusReader.Read(remote);
Check(received.EffectsReady && received.Effects.Count == 0, "Received empty effect list is genuine absence.");
remote.refs.afflictions.afflictionList.Add(new(Affliction.Kind.Exhausted));
Check(PlayerStatusReader.Read(remote).Effects.Single().Type == "Exhausted", "Read active remote effects after their independent receipt.");

remote.photonView.OwnerActorNr++;
Check(!PlayerStatusReader.Read(remote).Ready && !PlayerStatusReader.Read(remote).EffectsReady, "Ownership transfers invalidate both channels.");
StatusRpc(remote);
Check(PlayerStatusReader.Read(remote).Ready && !PlayerStatusReader.Read(remote).EffectsReady, "New-owner status receipt must not resurrect old effects evidence.");
remote.photonView.ViewID++;
Check(!PlayerStatusReader.Read(remote).Ready, "View changes invalidate synchronization evidence.");
StatusRpc(remote);
remote.refs.afflictions.currentStatuses = new float[15];
Check(!PlayerStatusReader.Read(remote).Ready, "Reinitialized zero arrays invalidate previous evidence.");
StatusRpc(remote);
PhotonNetwork.CurrentRoom = new object();
Check(!PlayerStatusReader.Read(remote).Ready, "New rooms cannot inherit matching actor/view evidence.");
StatusRpc(remote);
var replacement = NewCharacter(false);
replacement.photonView.OwnerActorNr = remote.photonView.OwnerActorNr;
replacement.photonView.ViewID = remote.photonView.ViewID;
replacement.syncer.RemoteValue.IsSome = true;
Check(!PlayerStatusReader.Read(replacement).Ready, "Recycled Photon IDs on a new component cannot inherit evidence.");
PhotonNetwork.InRoom = false;
PlayerStatusReader.ClearOutsideRoom();
PhotonNetwork.InRoom = true;
Check(!PlayerStatusReader.Read(remote).Ready, "Leaving the room explicitly clears receipt evidence.");
EffectsRpc(remote);
Check(PlayerStatusReader.Read(remote).EffectsReady && !PlayerStatusReader.Read(remote).Ready, "Effects can independently be known while bar statuses remain unknown.");
StatusRpc(remote);
remote.syncer.RemoteValue.IsSome = false;
Check(!PlayerStatusReader.Read(remote).Ready, "Petrify/data channel is also required for a complete two-bar snapshot.");
local.refs.afflictions.currentStatuses[0] = float.NaN;
Check(!PlayerStatusReader.Read(local).Ready && PlayerStatusReader.Read(local).Values.Count == 0, "Invalid local arrays must not leak half-valid values.");
local.refs.afflictions.currentStatuses = new float[1];
Check(!PlayerStatusReader.Read(local).Ready, "Incomplete local enum arrays are not complete snapshots.");
PlayerStatusReader.Uninstall();
Check(!PlayerStatusReader.Read(remote).Ready, "Plugin teardown clears evidence without game mutation.");

var roundTrip = NewCharacter(false);
roundTrip.syncer.RemoteValue.IsSome = true;
StatusRpc(roundTrip);
EffectsRpc(roundTrip);
roundTrip.photonView.OwnerActorNr = 2;
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Observe owner mismatch before a round trip.");
roundTrip.photonView.OwnerActorNr = 1;
Check(!PlayerStatusReader.Read(roundTrip).Ready && !PlayerStatusReader.Read(roundTrip).EffectsReady,
    "Returning to a previous owner must not resurrect old status/effect receipts.");
StatusRpc(roundTrip);
int originalView = roundTrip.photonView.ViewID;
roundTrip.photonView.ViewID++;
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Observe view mismatch before a round trip.");
roundTrip.photonView.ViewID = originalView;
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Returning to a previous view cannot resurrect evidence.");
StatusRpc(roundTrip);
var originalArray = roundTrip.refs.afflictions.currentStatuses;
roundTrip.refs.afflictions.currentStatuses = new float[15];
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Observe status-array replacement before restoration.");
roundTrip.refs.afflictions.currentStatuses = originalArray;
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Restoring a previous array cannot restore receipt proof.");
StatusRpc(roundTrip);
var originalRoom = PhotonNetwork.CurrentRoom;
PhotonNetwork.CurrentRoom = new object();
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Observe room mismatch before a round trip.");
PhotonNetwork.CurrentRoom = originalRoom;
Check(!PlayerStatusReader.Read(roundTrip).Ready, "Returning to a previous room object cannot resurrect proof.");
StatusRpc(roundTrip);
EffectsRpc(roundTrip);
roundTrip.photonView.IsMine = true;
Check(PlayerStatusReader.Read(roundTrip).Ready, "Temporarily controlled characters can read local authoritative data.");
roundTrip.photonView.IsMine = false;
Check(!PlayerStatusReader.Read(roundTrip).Ready && !PlayerStatusReader.Read(roundTrip).EffectsReady,
    "Remote-local-remote transitions invalidate both remote channels even when owner/view IDs stay unchanged.");

// Reproduce PEAK's ordering: the last death sets game state, then raises RunEnded,
// and only afterwards raises CharacterDied. The writer must already contain the
// terminal observation when it closes; no extra game frame or callback is needed.
var finalPlayer = NewCharacter(true);
finalPlayer.refs.afflictions.currentStatuses[5] = .25f;
finalPlayer.data.dead = true;
var journal = new List<string>();
StatusTelemetry? terminal = null;
SessionFinalization.Run(() =>
{
    terminal = PlayerStatusReader.Read(finalPlayer);
    journal.Add("status");
}, () => journal.Add("run_end"), _ => journal.Add("error"));
Check(journal.SequenceEqual(new[] { "status", "run_end" }), "Final snapshot must be written before the run-end marker.");
Check(terminal?.Dead == true && terminal.Values.Single(v => v.Type == "Curse").Amount == .25f,
    "Pre-close observation captures already-dead state without inventing cleared curse.");
journal.Clear();
SessionFinalization.Run(() => throw new InvalidOperationException("teardown"),
    () => journal.Add("run_end"), _ => journal.Add("error"));
Check(journal.SequenceEqual(new[] { "error", "run_end" }), "A teardown read failure must not prevent closing a recoverable session.");
Console.WriteLine($"Status contract passed: {checks} checks.");
