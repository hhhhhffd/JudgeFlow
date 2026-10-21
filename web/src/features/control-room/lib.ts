import type { EventStatus, JudgeSummary, Matrix, TeamInput } from '@/api/types'

/** Paste import: one team per line, optional `name<TAB>description`. Blank lines are skipped. */
export function parseTeamsPaste(text: string): TeamInput[] {
  const out: TeamInput[] = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    const [rawName = '', ...rest] = line.split('\t')
    const name = rawName.trim()
    if (!name) continue
    const description = rest.join(' ').trim()
    out.push(description ? { name, description } : { name })
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
export function cellState(judge: JudgeSummary, scored: number, total: number): CellState {
  if (!judge.is_active || judge.pending_count > 0) return 'attention'
  if (judge.submitted_at != null && total > 0 && scored >= total) return 'submitted'
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

export function computeKpis(m: Matrix): Kpis {
  const active = new Set(m.judges.filter((j) => j.is_active).map((j) => j.id))
  const scoredTeams = new Set<string>()
  let scored = 0
  let total = 0
  for (const c of m.cells) {
    if (c.scored > 0 && active.has(c.judge_id)) scoredTeams.add(c.team_id)
    if (active.has(c.judge_id)) {
      scored += c.scored
      total += c.total
    }
  }
  return {
    teamsWithScores: scoredTeams.size,
    teamsTotal: m.teams.length,
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
