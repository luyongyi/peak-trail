import { buildWorldTimeline, worldObjectsAtTime } from "./world-timeline.js";

export const WATCH_WINDOW_SECONDS = 120;
const MAX_TRACK_RECORDS = 6000;
const MAX_EVENTS = 2000;

function trimTrack(records, cutoff, limit = MAX_TRACK_RECORDS) {
  if (!records?.length) return;
  // Keep a predecessor so stationary state and interpolation survive the window.
  let index = records.findIndex(record => record.t >= cutoff);
  if (index < 0) index = records.length;
  const remove = Math.max(0, index - 1, records.length - limit);
  if (remove) records.splice(0, remove);
}

/** Bound memory before rebuilding derived scene geometry. Preserve state at the
 * left boundary; never invent empty inventory or an alive player when trimming. */
export function trimWatchTrace(trace, seconds = WATCH_WINDOW_SECONDS) {
  const cutoff = Math.max(0, trace.duration - seconds);
  for (const name of ["tracks", "telemetryTracks", "inventoryTracks", "appearanceTracks", "statusTracks"]) {
    for (const records of trace[name]?.values() || []) trimTrack(records, cutoff);
  }
  trimTrack(trace.routeTracks, cutoff);
  const prior = new Map();
  const recent = [];
  for (const event of trace.events) {
    if (event.t >= cutoff) recent.push(event);
    else if (["death", "revive", "join", "leave", "segment_change"].includes(event.type)) {
      const family = ["death", "revive"].includes(event.type) ? "life"
        : ["join", "leave"].includes(event.type) ? "presence" : "segment";
      prior.set(`${event.playerId || ""}:${family}`, event);
    }
  }
  trace.events = [...prior.values(), ...recent.slice(-MAX_EVENTS)].sort((a, b) => a.t - b.t);
  delete trace.lifeEventsByPlayer;
  if (trace.worldRecords?.length) {
    const ordered = trace.worldRecords.sort((a, b) => a.t - b.t);
    const oldest = ordered[0].t;
    if (oldest < cutoff || ordered.length > MAX_TRACK_RECORDS) {
      const boundary = Math.max(cutoff, ordered[Math.max(0, ordered.length - MAX_TRACK_RECORDS + 1)].t);
      const timeline = buildWorldTimeline(ordered);
      trace.worldRecords = [{ t: boundary, complete: true, objects: worldObjectsAtTime(timeline, boundary), removed: [] },
        ...ordered.filter(record => record.t > boundary)];
    }
  }
  trace.windowStart = cutoff;
  return cutoff;
}
