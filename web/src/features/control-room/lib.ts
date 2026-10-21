import type { Criterion, EventStatus, JudgeSummary, Matrix, RankingRow, Team, TeamInput, Track } from '@/api/types'
import { criterionApplies, inJudgeSet, pairKey } from '@/lib/tracks'

export type PasteRow = TeamInput & {
  /** Track name from the third column that matched no track: shown as a warning, the team is added without a track. */
  unknown_track?: string
}

/**
 * Paste import: one team per line, `name<TAB>description<TAB>track`; the last two are optional.
 * Track names are matched case-insensitively. Blank lines are skipped.
 */
export function parseTeamsPaste(text: string, tracks: Track[] = []): PasteRow[] {
  const byName = new Map(tracks.map((t) => [t.name.trim().toLowerCase(), t.id]))
  const out: PasteRow[] = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    const [rawName = '', rawDescription = '', rawTrack = ''] = line.split('\t')
    const name = rawName.trim()
    if (!name) continue
    const description = rawDescription.trim()
    const trackName = rawTrack.trim()
    const row: PasteRow = description ? { name, description } : { name }
    if (trackName) {
      const id = byName.get(trackName.toLowerCase())
      if (id) row.track_id = id
      else row.unknown_track = trackName
    }
    out.push(row)
  }
  return out
}

/** Names for judges: one per line, trimmed, blanks and exact duplicates dropped. */
export function parseNames(text: string): string[] {
  return [...new Set(text.split(/\r\n|\r|\n/).map((s) => s.trim()).filter(Boolean))]
}

export interface LifecycleAction {
  to: EventStatus
  /** Key of `cr.lifecycle.actions`. */
  key: 'start' | 'lock' | 'reopen' | 'finalize' | 'unfinalize' | 'publish' | 'unpublish'
  reasonRequired: boolean
  primary: boolean
}

/** Valid next transitions per SPEC §4. */
export const LIFECYCLE: Record<EventStatus, LifecycleAction[]> = {
  draft: [{ to: 'judging', key: 'start', reasonRequired: false, primary: true }],
  judging: [{ to: 'locked', key: 'lock', reasonRequired: false, primary: true }],
  locked: [
    { to: 'finalized', key: 'finalize', reasonRequired: false, primary: true },
    { to: 'judging', key: 'reopen', reasonRequired: true, primary: false },
  ],
  finalized: [
    { to: 'published', key: 'publish', reasonRequired: false, primary: true },
    { to: 'locked', key: 'unfinalize', reasonRequired: true, primary: false },
  ],
  published: [{ to: 'finalized', key: 'unpublish', reasonRequired: false, primary: false }],
}

export type CellState = 'attention' | 'submitted' | 'partial' | 'empty'

/** SPEC §9: green submitted, yellow partial/unsubmitted, grey not started, red inactive/pending sync. */
export function cellState(judge: JudgeSummary, scored: number, total: number, pairwise = false): CellState {
  if (!judge.is_active || judge.pending_count > 0) return 'attention'
  // Pairwise has no fixed total: a submitted sheet is complete by definition.
  if (judge.submitted_at != null && (pairwise || (total > 0 && scored >= total))) return 'submitted'
  if (scored > 0 || judge.submitted_at != null) return 'partial'
  return 'empty'
}

export interface Kpis {
  teamsWithScores: number
  teamsTotal: number
  judgesSubmitted: number
  judgesActive: number
  attention: number
  coveragePct: number
}

export function computeKpis(m: Matrix, pairwise = false, hasAssignments = false): Kpis {
  const active = new Set(m.judges.filter((j) => j.is_active).map((j) => j.id))
  const scoredTeams = new Set<string>()
  const coveredTeams = new Set<string>()
  let scored = 0
  let total = 0
  for (const c of m.cells) {
    if (c.scored > 0 && active.has(c.judge_id)) scoredTeams.add(c.team_id)
    if (active.has(c.judge_id)) {
      scored += c.scored
      total += c.total
      if (pairwise ? !c.conflict && (!hasAssignments || c.assigned) : c.total > 0) coveredTeams.add(c.team_id)
    }
  }
  return {
    teamsWithScores: scoredTeams.size,
    // Teams nobody active has to score (unassigned, conflicts) do not count.
    teamsTotal: coveredTeams.size,
    judgesSubmitted: m.judges.filter((j) => j.is_active && j.submitted_at != null).length,
    judgesActive: active.size,
    attention: m.judges.filter((j) => !j.is_active || j.pending_count > 0).length,
    coveragePct: total === 0 ? 0 : Math.round((scored / total) * 100),
  }
}

/** Moves item `index` by `delta` positions; returns the same array when out of range. */
export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const to = index + delta
  if (to < 0 || to >= items.length) return items
  const next = items.slice()
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item!)
  return next
}

/** Short Russian "N min ago" for last_seen; null -> "—". */
export function formatAgo(ms: number | null, now: number): string {
  if (ms == null) return '—'
  const sec = Math.max(0, Math.round((now - ms) / 1000))
  if (sec < 45) return 'только что'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} мин назад`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.round(h / 24)} дн назад`
}

/** Teams a judge works on (SPEC §12): all while the event has no assignments, else the assigned ones, minus conflicts. */
export function judgeTeams(judgeId: string, teams: Team[], assigned: Set<string>, conflicts: Set<string>, enabled?: boolean): Team[] {
  return teams.filter((t) => inJudgeSet(judgeId, t.id, assigned, conflicts, enabled))
}

/** Number of score cells a judge has to fill: judge's teams × criteria that apply to each team. */
export function judgeTotal(judgeId: string, teams: Team[], criteria: Criterion[], assigned: Set<string>, conflicts: Set<string>, enabled?: boolean): number {
  return judgeTeams(judgeId, teams, assigned, conflicts, enabled).reduce((n, t) => n + criteria.filter((c) => criterionApplies(c, t)).length, 0)
}

/** Only a complete set of assignments equal to "everything" is stored as the empty list. */
export function assignmentPairs(judges: { id: string }[], teams: Team[], assigned: Set<string>): { judge_id: string; team_id: string }[] {
  const all = judges.every((j) => teams.every((t) => assigned.has(pairKey(j.id, t.id))))
  if (all) return []
  return judges.flatMap((j) => teams.filter((t) => assigned.has(pairKey(j.id, t.id))).map((t) => ({ judge_id: j.id, team_id: t.id })))
}

export const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))

/**
 * Teams to carry over to the next round: per track group, every team ranked within the top `n`
 * (ties for the last place all pass). Teams without a place never pass.
 */
export function topTeamIds(rows: RankingRow[], n: number): string[] {
  return rows.filter((r) => r.rank !== null && r.rank <= n).map((r) => r.team_id)
}
