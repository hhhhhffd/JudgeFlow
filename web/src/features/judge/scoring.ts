// Pure scoring/outbox logic of the Judge Desk. No IO, no React — unit tested.
import type {
  Criterion,
  EventStatus,
  JudgeScoreRecord,
  JudgeSession,
  ScoreItem,
  ScoreResult,
  ScoringMode,
  SheetFile,
  Team,
} from '@/api/types'
import { SHEET_FORMAT } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { criterionApplies } from '@/lib/tracks'

export interface LocalRow {
  team_id: string
  criterion_id: string
  value_x100: number | null
  note: string
  /** Client clock, strictly increasing per row (see nextEditedAt). */
  edited_at: number
  /** Not yet confirmed by the server. */
  dirty: boolean
  /** Server rejected this version; not re-sent until the judge edits the row again. */
  error?: string
}
export type Rows = Record<string, LocalRow>

export const cellKey = (teamId: string, criterionId: string) => `${teamId}:${criterionId}`
const keyOf = (r: { team_id: string; criterion_id: string }) => cellKey(r.team_id, r.criterion_id)

/** Strictly increasing so "unchanged since send" can be decided by comparing edited_at. */
export function nextEditedAt(prev: LocalRow | undefined, now: number): number {
  return Math.max(now, (prev?.edited_at ?? 0) + 1)
}

export function applyEdit(
  rows: Rows,
  teamId: string,
  criterionId: string,
  patch: { value_x100?: number | null; note?: string },
  inheritedNote: string,
  now: number,
): Rows {
  const key = cellKey(teamId, criterionId)
  const prev = rows[key]
  const next: LocalRow = {
    team_id: teamId,
    criterion_id: criterionId,
    value_x100: prev?.value_x100 ?? null,
    note: prev ? prev.note : inheritedNote,
    ...patch,
    edited_at: nextEditedAt(prev, now),
    dirty: true,
  }
  return { ...rows, [key]: next }
}

/** The shared note of an item (team in team mode, criterion in criterion mode). */
export function itemNote(rows: Rows, keys: string[]): string {
  for (const k of keys) {
    const row = rows[k]
    if (row?.note) return row.note
  }
  return ''
}

/** Writes the note onto every scored row of the item. Unscored rows cannot hold a note on the server. */
export function applyNote(rows: Rows, keys: string[], note: string, now: number): Rows {
  let next = rows
  for (const k of keys) {
    const row = rows[k]
    if (!row || row.value_x100 === null || row.note === note) continue
    next = applyEdit(next, row.team_id, row.criterion_id, { note }, '', now)
  }
  return next
}

/**
 * Merges the server snapshot into local rows. Dirty rows are never overwritten.
 * A clean local row survives only when it is newer than the server copy.
 * Callers must serialize this with sync so a stale snapshot cannot race a confirmed send.
 */
export function mergeServer(rows: Rows, server: JudgeScoreRecord[]): Rows {
  const next: Rows = {}
  for (const [k, row] of Object.entries(rows)) if (row.dirty) next[k] = row
  for (const s of server) {
    const k = keyOf(s)
    const local = rows[k]
    if (local?.dirty) continue
    if (local && local.edited_at > s.edited_at) {
      next[k] = local
      continue
    }
    const note = s.note ?? ''
    // Reusing the object keeps unchanged rows out of diffRows, so a refresh does not rewrite IndexedDB.
    next[k] =
      local && local.value_x100 === s.value_x100 && local.note === note && local.edited_at === s.edited_at && !local.error
        ? local
        : { team_id: s.team_id, criterion_id: s.criterion_id, value_x100: s.value_x100, note, edited_at: s.edited_at, dirty: false }
  }
  return next
}

/**
 * Drops rows of cells outside the judge's current sheet (team reassigned, track changed).
 * The server rejects them with `not_assigned`, and the judge cannot see them to clear them.
 * An unsent edit survives until the server has actually rejected it.
 */
export function pruneOutsideSheet(rows: Rows, teams: Team[], criteria: Criterion[]): Rows {
  const allowed = new Set<string>()
  for (const t of teams) for (const c of criteria) if (criterionApplies(c, t)) allowed.add(cellKey(t.id, c.id))
  const next: Rows = {}
  for (const [k, row] of Object.entries(rows)) if (allowed.has(k) || (row.dirty && !row.error)) next[k] = row
  return Object.keys(next).length === Object.keys(rows).length ? rows : next
}

export const BATCH_LIMIT = 100

/** Oldest-first batch of rows that are dirty and not parked after a rejection. */
export function pickBatch(rows: Rows, limit = BATCH_LIMIT): ScoreItem[] {
  return toItems(Object.values(rows).filter((r) => r.dirty && !r.error)).slice(0, limit)
}

const toItems = (rows: LocalRow[]): ScoreItem[] =>
  rows
    .slice()
    .sort((a, b) => a.edited_at - b.edited_at)
    .map((r) => ({
      team_id: r.team_id,
      criterion_id: r.criterion_id,
      value_x100: r.value_x100,
      note: r.value_x100 === null ? null : r.note || null,
      edited_at: r.edited_at,
    }))

/**
 * Emergency backup of the whole local sheet (SPEC §12): every row, synced or not, parked or not.
 * The organizer imports it with the usual last-writer-wins rules, so extra rows are harmless.
 */
export function buildSheet(session: JudgeSession, token: string, rows: Rows, now: number): SheetFile {
  return {
    format: SHEET_FORMAT,
    event_id: session.event.id,
    judge_id: session.judge.id,
    judge_name: session.judge.name,
    token,
    exported_at: now,
    items: toItems(Object.values(rows)),
  }
}

export function errorMessage(code: string | undefined): string {
  const e = judgeText.errors
  switch (code) {
    case 'sheet_submitted':
      return e.sheet_submitted
    case 'invalid_state':
      return e.invalid_state
    case 'validation':
      return e.validation
    case 'not_assigned':
      return e.not_assigned
    default:
      return e.fallback
  }
}

export interface ApplyOutcome {
  rows: Rows
  ok: number
  stale: number
  rejected: number
  /** Results that could not be applied because the row changed during the request are not counted as progress. */
  unconfirmed: number
}

/**
 * Applies per-item results of one batch. A row is touched only if it did not change
 * since it was sent (edited_at is strictly increasing, so equality means "unchanged").
 */
export function applyResults(rows: Rows, sent: ScoreItem[], results: ScoreResult[]): ApplyOutcome {
  const sentByKey = new Map(sent.map((s) => [keyOf(s), s]))
  const next: Rows = { ...rows }
  const out: ApplyOutcome = { rows: next, ok: 0, stale: 0, rejected: 0, unconfirmed: 0 }
  const handled = new Set<string>()

  for (const res of results) {
    const k = keyOf(res)
    const item = sentByKey.get(k)
    if (!item || handled.has(k)) continue
    handled.add(k)
    const row = next[k]
    const unchanged = row !== undefined && row.edited_at === item.edited_at

    if (res.status === 'ok') {
      out.ok++
      if (!unchanged) continue
      if (row.value_x100 === null) delete next[k]
      else next[k] = { ...row, dirty: false, error: undefined }
    } else if (res.status === 'stale') {
      if (!unchanged) continue
      if (!res.server) {
        next[k] = { ...row, error: judgeText.errors.staleNoServer }
        out.rejected++
        continue
      }
      out.stale++
      if (res.server.value_x100 === null) delete next[k]
      else {
        next[k] = {
          team_id: row.team_id,
          criterion_id: row.criterion_id,
          value_x100: res.server.value_x100,
          note: res.server.note ?? '',
          edited_at: res.server.edited_at,
          dirty: false,
        }
      }
    } else {
      if (!unchanged) continue
      out.rejected++
      next[k] = { ...row, error: errorMessage(res.error) }
    }
  }
  for (const k of sentByKey.keys()) if (!handled.has(k)) out.unconfirmed++
  return out
}

/** A row removed from memory; edited_at is the version being removed (see canDeleteStored). */
export interface RowRef {
  team_id: string
  criterion_id: string
  edited_at: number
}

/** Rows that differ between two snapshots, for persistence. */
export function diffRows(prev: Rows, next: Rows): {
  upserts: LocalRow[]
  deletes: RowRef[]
} {
  const upserts: LocalRow[] = []
  const deletes: RowRef[] = []
  for (const [k, row] of Object.entries(next)) if (prev[k] !== row) upserts.push(row)
  for (const [k, row] of Object.entries(prev)) if (!(k in next)) deletes.push({ team_id: row.team_id, criterion_id: row.criterion_id, edited_at: row.edited_at })
  return { upserts, deletes }
}

// ---- multi-tab write guard and token adoption ----

/**
 * Several tabs share one IndexedDB. A tab must never replace a dirty stored row
 * that is newer than the version it is writing (it holds an unsynced edit made elsewhere).
 */
export const canOverwriteStored = (stored: LocalRow | undefined, incoming: { edited_at: number }) =>
  !(stored?.dirty && stored.edited_at > incoming.edited_at)

/** Same rule for removals: only the version this tab saw may be deleted. */
export const canDeleteStored = canOverwriteStored

/** An unsynced row carried over from an old token wins only against an older (or missing) row. */
export const adoptedWins = (existing: LocalRow | undefined, adopted: LocalRow) => !existing || adopted.edited_at > existing.edited_at

export interface CachedIdentity {
  k: string
  judge_id: string
  event_id: string
}

/** Cache keys of other tokens that belong to the same judge of the same event. */
export function pickOrphanKeys(current: CachedIdentity, cached: CachedIdentity[]): string[] {
  return cached.filter((c) => c.k !== current.k && c.judge_id === current.judge_id && c.event_id === current.event_id).map((c) => c.k)
}

export const pendingCount = (rows: Rows) => Object.values(rows).filter((r) => r.dirty).length
export const errorRows = (rows: Rows) => Object.values(rows).filter((r) => r.error)

// ---- progress / missing ----

export function missingCells(teams: Team[], criteria: Criterion[], rows: Rows) {
  const out: { team_id: string; criterion_id: string }[] = []
  for (const t of teams) {
    for (const c of criteria) {
      if (!criterionApplies(c, t)) continue
      if (rows[cellKey(t.id, c.id)]?.value_x100 == null) out.push({ team_id: t.id, criterion_id: c.id })
    }
  }
  return out
}

export interface ItemProgress {
  done: number
  total: number
  pending: boolean
  error: boolean
}

/** Progress of one queue item: a team (all criteria) or a criterion (all teams). */
export function itemProgress(
  mode: ScoringMode,
  itemId: string,
  teams: Team[],
  criteria: Criterion[],
  rows: Rows,
): ItemProgress {
  const keys = itemKeys(mode, itemId, teams, criteria)
  let done = 0
  let pending = false
  let error = false
  for (const k of keys) {
    const r = rows[k]
    if (!r) continue
    if (r.value_x100 !== null) done++
    if (r.dirty) pending = true
    if (r.error) error = true
  }
  return { done, total: keys.length, pending, error }
}

/** Criteria that apply to a team / teams a criterion applies to: the lines of one queue item. */
export function itemLines(mode: ScoringMode, itemId: string, teams: Team[], criteria: Criterion[]): (Team | Criterion)[] {
  if (mode === 'team') {
    const team = teams.find((t) => t.id === itemId)
    return team ? criteria.filter((c) => criterionApplies(c, team)) : []
  }
  const criterion = criteria.find((c) => c.id === itemId)
  return criterion ? teams.filter((t) => criterionApplies(criterion, t)) : []
}

export function itemKeys(mode: ScoringMode, itemId: string, teams: Team[], criteria: Criterion[]): string[] {
  return itemLines(mode, itemId, teams, criteria).map((l) => (mode === 'team' ? cellKey(itemId, l.id) : cellKey(l.id, itemId)))
}

export function overallProgress(teams: Team[], criteria: Criterion[], rows: Rows) {
  const total = teams.reduce((n, t) => n + criteria.filter((c) => criterionApplies(c, t)).length, 0)
  return { done: total - missingCells(teams, criteria, rows).length, total }
}

// ---- scale ----

export type Scale = { kind: 'segmented'; values: number[] } | { kind: 'numeric' }

/** Segmented buttons when the scale has at most 11 positions, otherwise a numeric stepper. */
export function scaleOf(c: Pick<Criterion, 'max_x100' | 'step_x100'>): Scale {
  const count = Math.floor(c.max_x100 / c.step_x100) + 1
  if (count > 11) return { kind: 'numeric' }
  return { kind: 'segmented', values: Array.from({ length: count }, (_, i) => i * c.step_x100) }
}

export function isValidValue(v: number, c: Pick<Criterion, 'max_x100' | 'step_x100'>): boolean {
  return Number.isInteger(v) && v >= 0 && v <= c.max_x100 && v % c.step_x100 === 0
}

/** Stepper: from "not scored" plus goes to one step, minus to zero. */
export function stepValue(current: number | null, dir: 1 | -1, c: Pick<Criterion, 'max_x100' | 'step_x100'>): number {
  if (current === null) return dir > 0 ? Math.min(c.step_x100, c.max_x100) : 0
  return Math.min(c.max_x100, Math.max(0, current + dir * c.step_x100))
}

export const DIGIT_CHORD_MS = 600

/**
 * Digit hotkey -> index of the scale position. A digit selects position `digit`;
 * "1" followed quickly by "0" selects the 11th position (index 10) when it exists.
 */
export function resolveDigit(
  digit: number,
  prev: { digit: number; at: number } | null,
  now: number,
  positions: number,
): number | null {
  if (digit === 0 && prev?.digit === 1 && now - prev.at <= DIGIT_CHORD_MS && positions > 10) return 10
  return digit < positions ? digit : null
}

// ---- editability ----

/** null when the judge may edit; otherwise the reason (key of judgeText.readOnly). */
export function readOnlyReason(status: EventStatus, submittedAt: number | null): keyof typeof judgeText.readOnly | null {
  if (status !== 'judging') return status
  return submittedAt !== null ? 'submitted' : null
}

export const canUnsubmit = (session: JudgeSession) => session.event.status === 'judging' && session.judge.submitted_at !== null

// ---- sync indicator ----

export type IndicatorKind = 'local' | 'syncing' | 'synced' | 'offline' | 'error'

export function syncIndicator(s: {
  online: boolean
  syncing: boolean
  pending: number
  rejected: number
  syncError: string | null
}): { kind: IndicatorKind; text: string } {
  const t = judgeText.sync
  if (s.rejected > 0) return { kind: 'error', text: t.error(t.rejectedCount(s.rejected)) }
  if (!s.online) return { kind: 'offline', text: t.offline }
  if (s.syncError) return { kind: 'error', text: t.error(s.syncError) }
  if (s.syncing) return { kind: 'syncing', text: t.syncing }
  if (s.pending > 0) return { kind: 'local', text: t.local }
  return { kind: 'synced', text: t.synced }
}
