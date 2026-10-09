import { digest, validHash, extractInspectionStage, playerSummitCompleted } from "./trajectory-contract.mjs";

export const TEAM_LIMITS = Object.freeze({ results: 100, pageBytes: 12 * 1024 * 1024 });

export function inspectTeamStage(trajectory, player, stage, options) {
  try { return extractInspectionStage(trajectory, player, stage, options); }
  catch (error) {
    // Legacy records without gates or a native stage timeline remain accepted.
    // Their unassignable points must not be guessed into an arbitrary stage.
    if (error.statusCode === 409 && error.message === "stage boundaries unavailable") {
      return { points: [], breaks: [], completion: "unknown", gameCompleted: null };
    }
    throw error;
  }
}

// A nickname is searchable display text, never an identity or a team key.
export function teamIdentity(entry) {
  let scope = `recording:${entry.recordingId}`;
  if ([1, 2].includes(entry.team?.version) && validHash(entry.team.scope)) scope = entry.team.scope;
  else {
    // Old complete routes already encode whether a shared clock was proven.
    const scopes = new Set((entry.routes ?? []).map(route => route.dedupe?.scope));
    if (scopes.size === 1 && validHash([...scopes][0])) scope = [...scopes][0];
  }
  return { id: digest({ groupId: entry.groupId, difficulty: entry.difficulty.key, scope }), scope };
}

export function makeTeamMetadata(trajectory, { version = 2 } = {}) {
  const shared = Boolean(trajectory.runKey && Number.isSafeInteger(trajectory.timeOriginMs));
  return { version, scope: shared ? trajectory.runKey : `recording:${trajectory.recordingId}`,
    ...(shared ? { timeOriginMs: trajectory.timeOriginMs } : {}),
    members: trajectory.players.map(player => ({ key: player.key, pointCount: player.points.length,
      ...(version >= 2 ? { summitCompleted: playerSummitCompleted(trajectory, player) } : {}),
      nativeProgress: player.events.some(event => event.kind === "game-stage"),
      stages: trajectory.map.stages.map(stage => {
        const extracted = inspectTeamStage(trajectory, player, stage, { includeInactive: version === 1 });
        return { index: stage.index, pointCount: extracted.points.length, completion: extracted.completion,
          gameCompleted: extracted.gameCompleted, breakCount: extracted.breaks.length };
      }) })) };
}

export function collectTeams(entries) {
  const teams = new Map();
  for (const entry of entries) {
    if (entry.moderationStatus !== "approved") continue;
    const identity = teamIdentity(entry);
    if (!teams.has(identity.id)) teams.set(identity.id, { ...identity, groupId: entry.groupId,
      difficulty: entry.difficulty, map: entry.map, entries: [], members: new Map(), times: [] });
    const team = teams.get(identity.id); team.entries.push(entry);
    if (Number.isFinite(Date.parse(entry.startedUtc))) team.times.push(entry.startedUtc);
    const metadata = new Map((entry.team?.members ?? []).map(member => [member.key, member]));
    for (const player of entry.players ?? []) {
      if (!validHash(player.key)) continue;
      if (!team.members.has(player.key)) team.members.set(player.key, []);
      team.members.get(player.key).push({ entry, player, metadata: metadata.get(player.key) });
    }
  }
  return teams;
}

export function sourceOrder(a, b, stage) {
  const summary = source => source.metadata?.stages?.find(value => value.index === stage);
  const points = source => summary(source)?.pointCount ?? source.entry.routes
    .filter(route => route.playerKey === source.player.key && route.stageIndex === stage)
    .reduce((count, route) => count + route.pointCount, 0);
  // Prefer a real observation of this stage over an empty one, then the player's
  // own recording and native progress. Never concatenate observations.
  return Number(points(b) > 0) - Number(points(a) > 0)
    || Number(b.player.owner) - Number(a.player.owner)
    || Number(b.metadata?.nativeProgress === true) - Number(a.metadata?.nativeProgress === true)
    || points(b) - points(a) || a.entry.id.localeCompare(b.entry.id);
}

export function teamDescriptor(team) {
  const allMembers = [...team.members].sort(([a], [b]) => a.localeCompare(b));
  const members = allMembers.map(([playerKey, sources]) => {
    const selected = [...sources].sort((a, b) => Number(b.player.owner) - Number(a.player.owner)
      || Date.parse(b.entry.startedUtc) - Date.parse(a.entry.startedUtc) || a.entry.id.localeCompare(b.entry.id))[0];
    return { playerKey, name: selected.player.name,
      summitCompleted: sources.some(source => source.metadata?.summitCompleted === true) };
  });
  const times = [...team.times].sort((a, b) => Date.parse(a) - Date.parse(b));
  return { id: team.id, groupId: team.groupId, startedUtc: times[0] ?? null, lastStartedUtc: times.at(-1) ?? null,
    difficulty: team.difficulty, map: { buildId: team.map.buildId, scene: team.map.scene,
      ...(team.map.levelIndex !== undefined ? { levelIndex: team.map.levelIndex } : {}) }, members,
    summitCompleted: members.some(member => member.summitCompleted),
    finisherKeys: members.filter(member => member.summitCompleted).map(member => member.playerKey),
    stageSummaries: team.map.stages.map(stage => {
      let memberCount = 0, completedCount = 0;
      for (const [, sources] of allMembers) {
        const summary = [...sources].sort((a, b) => sourceOrder(a, b, stage.index))[0];
        const meta = summary.metadata?.stages?.find(value => value.index === stage.index);
        const old = summary.player.stages?.find(value => value.index === stage.index);
        if (meta ? meta.pointCount > 0 : old?.routeCount > 0) memberCount += 1;
        if (meta ? meta.gameCompleted === true || meta.completion === "complete" : old?.completion === "complete") completedCount += 1;
      }
      return { index: stage.index, name: stage.name, memberCount, completedCount, completed: completedCount > 0 };
    }) };
}

export function memberMatches(team, text) {
  const needle = text.normalize("NFKC").toLocaleLowerCase("und");
  return !needle || [...team.members.values()].some(sources => sources.some(source =>
    String(source.player.name).normalize("NFKC").toLocaleLowerCase("und").includes(needle)));
}
