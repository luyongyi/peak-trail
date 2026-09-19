# Player status capture, recorder 0.7

Verified against the locally installed PEAK build **25306743** (`Assembly-CSharp.dll`).
These are observations of local game code and synchronized client state, not new gameplay rules.

## Source facts

- `CharacterAfflictions.STATUSTYPE`: Injury, Hunger, Cold, Poison, Crab, Curse, Drowsy,
  Weight, Hot, Thorns, Spores, Web, Arrow, Petrify, FlyTrap (IDs 0–14).
- `CharacterAfflictions.statusSum` sums the actual `currentStatuses` array, including
  overflow beyond 1. `Character.GetMaxStamina()` is `max(1 - statusSum, 0)`.
- `StaminaBar.Update` sizes normal and extra fills using raw current stamina times the
  original full bar width. Dividing by the reduced maximum visually hides status damage.
- `SetStatus(Petrify, amount)` instead calls `CharacterData.SetPetrify(floor(amount*100))`.
  `Character.SetExtraStamina` caps extra stamina at `1 - petrifyAmount*.01`.
  `BarAffliction.ChangeAffliction` reads normal `GetCurrentStatus` or, for its dedicated
  petrify bar, `petrifyAmount/100`. Do not attribute stone blocking to Cold/Curse.
- There is no independent Frozen enum in this build. Do not invent it from Cold.
- `CharacterSyncer.RemoteValue` carries current/extra stamina and petrify; it does **not**
  carry the status array. `SyncStatusesRPC` decodes a separate packet and calls `SetAll`.
  Freshly initialized zero arrays therefore cannot establish healthy remote status.
- `SetAll` rejects arrays of the wrong length and skips Petrify index 13; the recorder
  observes its completed call and validates length/finiteness. Source authority is labelled
  `photon-status-rpc-observed`: the vanilla RPC has no sender argument to cryptographically
  verify. It is the observed game replica, not a server-truth claim.
- `SyncAfflictionsRPC` independently updates the active `afflictionList`. All identities
  are captured, not just detrimental effects. Only owners call `Affliction.Tick`; remote
  `timeElapsed` is not a synchronized timer, so the contract deliberately omits countdowns.
- Death does not clear the status array. Revive calls `ClearAllStatus()` (defaults preserve
  curse/petrify), then subtracts .75 petrify and clears afflictions. Post-revive rules may add
  curse/injury. A death snapshot retains the actual values with `dead:true`; never synthesize
  a healthy zero array. Later clear/revive snapshots replace rather than merge values.
- The host's last `RPCA_Die` sets dead state, then `CheckEndGame` can synchronously raise
  `RunEnded`, before its later `CharacterDied` callback. Finalization therefore performs a
  last read-only player reconciliation before writing `run_end` or closing the files.
  It neither delays game callbacks nor invokes gameplay mutations; a teardown read failure
  is logged but does not prevent closing the already-recoverable log.

## Additive v1 stream contract

`type:status` has `t`, `playerId`, `activeSegment`, `reason` and `status`. `status.values`
is complete when `ready:true`; it includes zero entries. Missing/false readiness invalidates
prior bar-status knowledge. Each value has `id`, `type`, `amount`, `staminaBlock` and
`extraStaminaBlock`. Ordinary blocks sum to `statusSum`; Petrify's display `amount` and
extra block come from the data field rather than its normally-zero ordinary-array slot.
`effectsReady` is independent; `effects` replaces the complete active identity list and only
contains `type` and `typeId`. An empty list is evidence of absence only with its ready flag.

The manifest adds `status` to `telemetryFields` and a `statusTelemetry` capability marker.
Pre-0.7 logs remain unknown, and must not inherit today's game state or item-based guesses.
Remote receipt evidence is invalidated by owner/view/room or array changes and weakly keys
the character component, so a recycled Photon view cannot borrow an earlier player's proof.
An observed identity mismatch permanently revokes the old receipt, even if the IDs later
return to their previous values. Temporary local control also revokes old remote receipts.
Sampling follows the configured player sampling frequency; unchanged snapshots heartbeat
at 1 second. Effects that begin and end between samples may be missed. No omniscience or
retroactive recovery is claimed.

## Verification and deployment boundary

`StatusContract` tests actual reader code with isolated game doubles, all 15 entries,
local/remote independent readiness, petrify capacity, empty/clear/death/revive semantics,
nonfinite packet rejection and owner/view/room/array identity invalidation.
The contract also covers identity round trips, remote/local/remote ownership, and final
state capture before end-of-run closure (including the teardown-failure path). Build with
`-p:DeployModFiles=false`; this task does not replace the installed game DLL.
