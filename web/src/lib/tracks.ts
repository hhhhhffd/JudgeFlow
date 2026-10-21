import type { Criterion, Id, JudgeTeamPair, Team, Track } from '@/api/types'

/** SPEC §12: a criterion applies to a team when it has no track or the team's track. */
export function criterionApplies(criterion: Pick<Criterion, 'track_id'>, team: Pick<Team, 'track_id'>): boolean {
  // Sessions cached before tracks existed have no track_id at all, which also means "no track".
  return !criterion.track_id || criterion.track_id === team.track_id
}

export interface TrackGroup<R> {
  /** null = rows without a track. */
  track: Track | null
  rows: R[]
}

/**
 * Splits rows into groups in track order, rows without a track last; empty groups are dropped.
 * Rows come from the server already ordered group by group, so the order inside a group is kept.
 */
export function groupByTrack<R extends { track_id: Id | null }>(rows: R[], tracks: Track[]): TrackGroup<R>[] {
  const groups: TrackGroup<R>[] = tracks.map((track) => ({ track, rows: rows.filter((r) => r.track_id === track.id) }))
  const known = new Set(tracks.map((t) => t.id))
  groups.push({ track: null, rows: rows.filter((r) => r.track_id === null || !known.has(r.track_id)) })
  return groups.filter((g) => g.rows.length > 0)
}

/** Criteria shown for a group: track-less ones plus those of the group's track. */
export function criteriaOfGroup<C extends { track_id: Id | null }>(criteria: C[], track: Track | null): C[] {
  return criteria.filter((c) => c.track_id === null || c.track_id === (track?.id ?? null))
}

export const pairKey = (judgeId: Id, teamId: Id) => `${judgeId}:${teamId}`

/** A judge is limited to explicit assignments only once the event has at least one (SPEC §12). */
export function inJudgeSet(judgeId: Id, teamId: Id, assigned: Set<string>, conflicts: Set<string>): boolean {
  if (conflicts.has(pairKey(judgeId, teamId))) return false
  return assigned.size === 0 || assigned.has(pairKey(judgeId, teamId))
}

export const pairSet = (pairs: JudgeTeamPair[]) => new Set(pairs.map((p) => pairKey(p.judge_id, p.team_id)))
