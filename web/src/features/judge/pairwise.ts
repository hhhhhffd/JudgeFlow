// Pure comparison/outbox logic of the pairwise Judge Desk (SPEC §13). No IO, no React — unit tested.
// Mirrors scoring.ts: local-first edits with a strictly increasing edited_at, per-item results.
import type { ComparisonRecord, ComparisonResult, ComparisonItem, Winner } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { errorMessage } from './scoring'

export interface LocalComparison {
  id: string
  team_a: string
  team_b: string
  /** null = open (not decided yet). */
  winner: Winner | null
  /** null until the first decision; client clock afterwards. */
  edited_at: number | null
  /** Position in the judge's list (server order), keeps the sequence stable. */
  ord: number
  /** Not yet confirmed by the server. */
  dirty: boolean
  error?: string
}
export type Comparisons = Record<string, LocalComparison>

export const sortedComparisons = (c: Comparisons): LocalComparison[] => Object.values(c).sort((a, b) => a.ord - b.ord)
export const openComparisons = (c: Comparisons) => sortedComparisons(c).filter((x) => x.winner === null)
export const decidedCount = (c: Comparisons) => Object.values(c).filter((x) => x.winner !== null).length
export const pendingComparisons = (c: Comparisons) => Object.values(c).filter((x) => x.dirty).length
export const errorComparisons = (c: Comparisons) => Object.values(c).filter((x) => x.error)

/** Reserve more pairs automatically when fewer than this many are open. */
export const RESERVE_LOW = 3
/** The reserve target (open pairs kept ready for offline work). */
export const RESERVE_TARGET = 5

export function decide(c: Comparisons, id: string, winner: Winner | null, now: number): Comparisons {
  const prev = c[id]
  if (!prev) return c
  return { ...c, [id]: { ...prev, winner, edited_at: Math.max(now, (prev.edited_at ?? 0) + 1), dirty: true, error: undefined } }
}

/**
 * Merges the server list (session) into local rows: dirty rows win, a clean row survives only
 * when newer than the server copy, rows the server no longer has (released) are dropped.
 */
export function mergeComparisons(local: Comparisons, server: ComparisonRecord[]): Comparisons {
  const next: Comparisons = {}
  for (const [id, row] of Object.entries(local)) if (row.dirty && !row.error) next[id] = row
  let ord = Math.max(-1, ...Object.values(local).map((r) => r.ord))
  server.forEach((s) => {
    const prev = local[s.id]
    if (prev?.dirty && !prev.error) return
    if (prev && prev.edited_at !== null && (s.edited_at ?? 0) < prev.edited_at) {
      next[s.id] = prev
      return
    }
    const same = prev && prev.winner === s.winner && prev.edited_at === s.edited_at && !prev.error
    next[s.id] = same ? prev : { id: s.id, team_a: s.team_a, team_b: s.team_b, winner: s.winner, edited_at: s.edited_at, ord: prev?.ord ?? ++ord, dirty: false }
  })
  return next
}

/** Adds pairs the server just reserved; rows we already hold (maybe decided locally) are kept as they are. */
export function addReserved(local: Comparisons, reserved: ComparisonRecord[]): Comparisons {
  const fresh = reserved.filter((r) => !(r.id in local))
  if (fresh.length === 0) return local
  let ord = Math.max(-1, ...Object.values(local).map((r) => r.ord))
  const next = { ...local }
  for (const r of fresh) next[r.id] = { id: r.id, team_a: r.team_a, team_b: r.team_b, winner: r.winner, edited_at: r.edited_at, ord: ++ord, dirty: false }
  return next
}

export function pickComparisonBatch(c: Comparisons, limit = 100): ComparisonItem[] {
  return Object.values(c)
    .filter((x) => x.dirty && !x.error && x.edited_at !== null)
    .sort((a, b) => (a.edited_at ?? 0) - (b.edited_at ?? 0))
    .slice(0, limit)
    .map((x) => ({ id: x.id, winner: x.winner, edited_at: x.edited_at as number }))
}

export interface ComparisonOutcome {
  comparisons: Comparisons
  ok: number
  stale: number
  rejected: number
  unconfirmed: number
}

/** Same discipline as applyResults: a row is touched only if it did not change since it was sent. */
export function applyComparisonResults(c: Comparisons, sent: ComparisonItem[], results: ComparisonResult[]): ComparisonOutcome {
  const sentById = new Map(sent.map((s) => [s.id, s]))
  const next: Comparisons = { ...c }
  const out: ComparisonOutcome = { comparisons: next, ok: 0, stale: 0, rejected: 0, unconfirmed: 0 }
  const handled = new Set<string>()
  for (const res of results) {
    const item = sentById.get(res.id)
    if (!item || handled.has(res.id)) continue
    handled.add(res.id)
    const row = next[res.id]
    const unchanged = row !== undefined && row.edited_at === item.edited_at
    if (res.status === 'ok') {
      out.ok++
      if (unchanged) next[res.id] = { ...row, dirty: false, error: undefined }
    } else if (res.status === 'stale') {
      if (!unchanged) continue
      if (!res.server) {
        next[res.id] = { ...row, error: judgeText.errors.staleNoServer }
        out.rejected++
        continue
      }
      out.stale++
      next[res.id] = { ...row, winner: res.server.winner, edited_at: res.server.edited_at, dirty: false, error: undefined }
    } else if (unchanged) {
      // The pair is gone on the server (released): nothing to keep.
      if (res.error === 'not_found') delete next[res.id]
      else {
        out.rejected++
        next[res.id] = { ...row, error: errorMessage(res.error) }
      }
    }
  }
  for (const id of sentById.keys()) if (!handled.has(id)) out.unconfirmed++
  return out
}

/** Writes only what changed since the previous snapshot. */
export function diffComparisons(prev: Comparisons, next: Comparisons): { upserts: LocalComparison[]; deletes: string[] } {
  const upserts = Object.entries(next).filter(([id, row]) => prev[id] !== row).map(([, row]) => row)
  const deletes = Object.keys(prev).filter((id) => !(id in next))
  return { upserts, deletes }
}

/**
 * The pair on screen: the explicitly chosen one if it still exists, otherwise the first open
 * pair, otherwise the last decided one (nothing left to do).
 */
export function currentPair(list: LocalComparison[], chosenId: string | undefined): LocalComparison | undefined {
  return list.find((x) => x.id === chosenId) ?? list.find((x) => x.winner === null) ?? list[list.length - 1]
}

/** The open pair after `id` (wrapping to the first open), or undefined when none is open. */
export function nextOpenAfter(list: LocalComparison[], id: string): LocalComparison | undefined {
  const idx = list.findIndex((x) => x.id === id)
  return list.slice(idx + 1).find((x) => x.winner === null) ?? list.find((x) => x.winner === null && x.id !== id)
}

/** Which key choice a hotkey maps to. */
export function winnerForKey(key: string): Winner | null {
  switch (key) {
    case 'ArrowLeft':
    case '1':
      return 'a'
    case 'ArrowDown':
    case '0':
      return 'tie'
    case 'ArrowRight':
    case '2':
      return 'b'
    default:
      return null
  }
}
