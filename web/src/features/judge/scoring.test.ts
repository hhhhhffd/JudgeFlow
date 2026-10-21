import { describe, expect, it } from 'vitest'
import type { Criterion, JudgeSession, ScoreItem, ScoreResult, Team } from '@/api/types'
import {
  adoptedWins,
  applyEdit,
  canDeleteStored,
  canOverwriteStored,
  pickOrphanKeys,
  applyNote,
  applyResults,
  buildSheet,
  cellKey,
  diffRows,
  isValidValue,
  itemNote,
  itemProgress,
  overallProgress,
  pruneOutsideSheet,
  mergeServer,
  missingCells,
  pendingCount,
  pickBatch,
  readOnlyReason,
  resolveDigit,
  scaleOf,
  stepValue,
  syncIndicator,
  type LocalRow,
  type Rows,
} from './scoring'

const k = cellKey
const teams = [{ id: 't1' }, { id: 't2' }] as Team[]
const criteria = [{ id: 'c1' }, { id: 'c2' }] as Criterion[]

const edit = (rows: Rows, t: string, c: string, v: number | null, now: number) =>
  applyEdit(rows, t, c, { value_x100: v }, '', now)

describe('applyEdit', () => {
  it('marks the row dirty and keeps edited_at strictly increasing even with a stalled clock', () => {
    let rows = edit({}, 't1', 'c1', 500, 1000)
    rows = edit(rows, 't1', 'c1', 600, 1000)
    expect(rows[k('t1', 'c1')]).toMatchObject({ value_x100: 600, dirty: true, edited_at: 1001 })
  })

  it('clears a previous rejection error', () => {
    let rows = edit({}, 't1', 'c1', 500, 1)
    rows = { ...rows, [k('t1', 'c1')]: { ...rows[k('t1', 'c1')]!, error: 'x' } }
    expect(edit(rows, 't1', 'c1', 600, 2)[k('t1', 'c1')]!.error).toBeUndefined()
  })

  it('new rows inherit the item note', () => {
    const rows = applyEdit({}, 't1', 'c2', { value_x100: 100 }, 'хорошо', 5)
    expect(rows[k('t1', 'c2')]!.note).toBe('хорошо')
  })
})

describe('notes', () => {
  it('writes onto scored rows only', () => {
    let rows = edit({}, 't1', 'c1', 100, 1)
    rows = applyEdit(rows, 't1', 'c2', { value_x100: null }, '', 2)
    rows = applyNote(rows, [k('t1', 'c1'), k('t1', 'c2')], 'заметка', 3)
    expect(rows[k('t1', 'c1')]!.note).toBe('заметка')
    expect(rows[k('t1', 'c2')]!.note).toBe('')
    expect(itemNote(rows, [k('t1', 'c2'), k('t1', 'c1')])).toBe('заметка')
  })
})

describe('mergeServer', () => {
  const server = [{ team_id: 't1', criterion_id: 'c1', value_x100: 700, note: null, edited_at: 50 }]

  it('never overwrites dirty local rows', () => {
    const rows = edit({}, 't1', 'c1', 300, 10)
    expect(mergeServer(rows, server)[k('t1', 'c1')]).toMatchObject({ value_x100: 300, dirty: true })
  })

  it('takes server values for clean rows and drops clean rows the server no longer has', () => {
    const rows: Rows = {
      [k('t1', 'c1')]: { team_id: 't1', criterion_id: 'c1', value_x100: 100, note: '', edited_at: 10, dirty: false },
      [k('t2', 'c2')]: { team_id: 't2', criterion_id: 'c2', value_x100: 100, note: '', edited_at: 10, dirty: false },
    }
    const merged = mergeServer(rows, server)
    expect(merged[k('t1', 'c1')]).toMatchObject({ value_x100: 700, note: '', dirty: false })
    expect(merged[k('t2', 'c2')]).toBeUndefined()
  })

  it('keeps a clean local row that is newer than the server copy', () => {
    const rows: Rows = {
      [k('t1', 'c1')]: { team_id: 't1', criterion_id: 'c1', value_x100: 900, note: '', edited_at: 99, dirty: false },
    }
    expect(mergeServer(rows, server)[k('t1', 'c1')]!.value_x100).toBe(900)
  })
})

describe('mergeServer reuse', () => {
  it('keeps the same row object when nothing changed, so persistence skips it', () => {
    const row = { team_id: 't1', criterion_id: 'c1', value_x100: 700, note: '', edited_at: 50, dirty: false }
    const rows: Rows = { [k('t1', 'c1')]: row }
    const server = [{ team_id: 't1', criterion_id: 'c1', value_x100: 700, note: null, edited_at: 50 }]
    const merged = mergeServer(rows, server)
    expect(merged[k('t1', 'c1')]).toBe(row)
    expect(diffRows(rows, merged)).toEqual({ upserts: [], deletes: [] })
    const changed = mergeServer(rows, [{ ...server[0]!, value_x100: 800 }])
    expect(diffRows(rows, changed).upserts).toHaveLength(1)
  })
})

describe('multi-tab guard', () => {
  const stored = (edited_at: number, dirty: boolean) => ({ team_id: 't1', criterion_id: 'c1', value_x100: 1, note: '', edited_at, dirty })
  it('refuses to replace or delete a newer dirty row', () => {
    expect(canOverwriteStored(stored(20, true), { edited_at: 10 })).toBe(false)
    expect(canDeleteStored(stored(20, true), { edited_at: 10 })).toBe(false)
  })
  it('allows equal/newer writes, clean rows and missing rows', () => {
    expect(canOverwriteStored(stored(10, true), { edited_at: 10 })).toBe(true)
    expect(canOverwriteStored(stored(20, false), { edited_at: 10 })).toBe(true)
    expect(canOverwriteStored(undefined, { edited_at: 10 })).toBe(true)
  })
})

describe('token adoption', () => {
  const id = (key: string, judge_id = 'j1', event_id = 'e1') => ({ k: key, judge_id, event_id })
  it('picks only other keys of the same judge and event', () => {
    const cached = [id('new'), id('old'), id('other-judge', 'j2'), id('other-event', 'j1', 'e2')]
    expect(pickOrphanKeys(id('new'), cached)).toEqual(['old'])
  })
  it('an adopted row wins only against an older or missing row', () => {
    const adopted = { team_id: 't1', criterion_id: 'c1', value_x100: 1, note: '', edited_at: 10, dirty: true }
    expect(adoptedWins(undefined, adopted)).toBe(true)
    expect(adoptedWins({ ...adopted, edited_at: 5 }, adopted)).toBe(true)
    expect(adoptedWins({ ...adopted, edited_at: 10 }, adopted)).toBe(false)
    expect(adoptedWins({ ...adopted, edited_at: 11, dirty: false }, adopted)).toBe(false)
  })
})

describe('outbox', () => {
  it('sends only dirty, non-rejected rows, oldest first; null value carries no note', () => {
    let rows = edit({}, 't1', 'c1', 100, 5)
    rows = edit(rows, 't1', 'c2', null, 3)
    rows = edit(rows, 't2', 'c1', 200, 4)
    rows = { ...rows, [k('t2', 'c1')]: { ...rows[k('t2', 'c1')]!, error: 'no' } }
    const batch = pickBatch(rows)
    expect(batch.map((i) => [i.team_id, i.criterion_id])).toEqual([
      ['t1', 'c2'],
      ['t1', 'c1'],
    ])
    expect(batch[0]!.note).toBeNull()
  })

  const result = (r: Partial<ScoreResult> & Pick<ScoreResult, 'status'>, t = 't1', c = 'c1'): ScoreResult => ({
    team_id: t,
    criterion_id: c,
    ...r,
  })

  it('ok marks clean only if the row did not change since it was sent', () => {
    const rows = edit(edit({}, 't1', 'c1', 100, 1), 't1', 'c2', 100, 1)
    const sent: ScoreItem[] = pickBatch(rows)
    // c1 edited again while the request was in flight
    const racing = edit(rows, 't1', 'c1', 150, 5)
    const out = applyResults(racing, sent, [result({ status: 'ok' }), result({ status: 'ok' }, 't1', 'c2')])
    expect(out.rows[k('t1', 'c1')]).toMatchObject({ value_x100: 150, dirty: true })
    expect(out.rows[k('t1', 'c2')]!.dirty).toBe(false)
    expect(pendingCount(out.rows)).toBe(1)
  })

  it('ok for a cleared score removes the row', () => {
    const rows = edit({}, 't1', 'c1', null, 1)
    const out = applyResults(rows, pickBatch(rows), [result({ status: 'ok' })])
    expect(out.rows[k('t1', 'c1')]).toBeUndefined()
  })

  it('stale takes the server version and counts it', () => {
    const rows = edit({}, 't1', 'c1', 100, 1)
    const out = applyResults(rows, pickBatch(rows), [
      result({ status: 'stale', server: { value_x100: 800, note: 'с сервера', edited_at: 99 } }),
    ])
    expect(out.stale).toBe(1)
    expect(out.rows[k('t1', 'c1')]).toMatchObject({ value_x100: 800, note: 'с сервера', edited_at: 99, dirty: false })
  })

  it('stale does not clobber an edit made while the request was in flight', () => {
    const rows = edit({}, 't1', 'c1', 100, 1)
    const sent = pickBatch(rows)
    const racing = edit(rows, 't1', 'c1', 120, 9)
    const out = applyResults(racing, sent, [result({ status: 'stale', server: { value_x100: 800, note: null, edited_at: 99 } })])
    expect(out.rows[k('t1', 'c1')]).toMatchObject({ value_x100: 120, dirty: true })
    expect(out.stale).toBe(0)
  })

  it('rejected keeps the local value, records a message and parks the row; other items are unaffected', () => {
    const rows = edit(edit({}, 't1', 'c1', 100, 1), 't1', 'c2', 100, 1)
    const out = applyResults(rows, pickBatch(rows), [
      result({ status: 'rejected', error: 'sheet_submitted' }),
      result({ status: 'ok' }, 't1', 'c2'),
    ])
    expect(out.rejected).toBe(1)
    expect(out.rows[k('t1', 'c1')]).toMatchObject({ value_x100: 100, dirty: true, error: 'Лист уже сдан' })
    expect(out.rows[k('t1', 'c2')]!.dirty).toBe(false)
    expect(pickBatch(out.rows)).toHaveLength(0)
  })

  it('reports items the server did not answer as unconfirmed', () => {
    const rows = edit({}, 't1', 'c1', 100, 1)
    expect(applyResults(rows, pickBatch(rows), []).unconfirmed).toBe(1)
  })

  it('diffRows lists changed and removed rows', () => {
    const a = edit({}, 't1', 'c1', 100, 1)
    const b = applyResults(a, pickBatch(a), [result({ status: 'ok' })]).rows
    expect(diffRows(a, b).upserts).toHaveLength(1)
    const c = edit(a, 't1', 'c1', null, 2)
    const d = applyResults(c, pickBatch(c), [result({ status: 'ok' })]).rows
    expect(diffRows(c, d).deletes).toEqual([{ team_id: 't1', criterion_id: 'c1', edited_at: 2 }])
  })
})

describe('progress', () => {
  it('lists missing cells and item progress in both modes', () => {
    const rows = edit(edit({}, 't1', 'c1', 100, 1), 't2', 'c1', 100, 1)
    expect(missingCells(teams, criteria, rows)).toEqual([
      { team_id: 't1', criterion_id: 'c2' },
      { team_id: 't2', criterion_id: 'c2' },
    ])
    expect(itemProgress('team', 't1', teams, criteria, rows)).toMatchObject({ done: 1, total: 2, pending: true })
    expect(itemProgress('criterion', 'c1', teams, criteria, rows)).toMatchObject({ done: 2, total: 2 })
  })
})

describe('scale', () => {
  it('uses segmented buttons up to 11 positions', () => {
    expect(scaleOf({ max_x100: 1000, step_x100: 100 })).toEqual({ kind: 'segmented', values: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000] })
    expect(scaleOf({ max_x100: 1001, step_x100: 1 }).kind).toBe('numeric')
    expect(scaleOf({ max_x100: 5000, step_x100: 500 }).kind).toBe('segmented')
    expect(scaleOf({ max_x100: 10000, step_x100: 500 }).kind).toBe('numeric')
  })

  it('validates and steps within bounds', () => {
    const c = { max_x100: 1000, step_x100: 250 }
    expect(isValidValue(750, c)).toBe(true)
    expect(isValidValue(700, c)).toBe(false)
    expect(isValidValue(1250, c)).toBe(false)
    expect(stepValue(null, 1, c)).toBe(250)
    expect(stepValue(null, -1, c)).toBe(0)
    expect(stepValue(1000, 1, c)).toBe(1000)
    expect(stepValue(0, -1, c)).toBe(0)
    expect(stepValue(500, 1, c)).toBe(750)
  })

  it('digit hotkeys: position by digit, 1 then 0 reaches the 11th position', () => {
    expect(resolveDigit(3, null, 0, 11)).toBe(3)
    expect(resolveDigit(7, null, 0, 6)).toBeNull()
    expect(resolveDigit(0, { digit: 1, at: 0 }, 300, 11)).toBe(10)
    expect(resolveDigit(0, { digit: 1, at: 0 }, 900, 11)).toBe(0)
    expect(resolveDigit(0, { digit: 1, at: 0 }, 100, 6)).toBe(0)
  })
})

describe('read-only and indicator', () => {
  it('explains why the sheet is read-only', () => {
    expect(readOnlyReason('judging', null)).toBeNull()
    expect(readOnlyReason('judging', 5)).toBe('submitted')
    expect(readOnlyReason('locked', null)).toBe('locked')
  })

  const base = { online: true, syncing: false, pending: 0, rejected: 0, syncError: null }
  it('picks the indicator state by priority', () => {
    expect(syncIndicator(base).kind).toBe('synced')
    expect(syncIndicator({ ...base, pending: 2 }).kind).toBe('local')
    expect(syncIndicator({ ...base, pending: 2, syncing: true }).kind).toBe('syncing')
    expect(syncIndicator({ ...base, online: false, pending: 2 }).kind).toBe('offline')
    const err = syncIndicator({ ...base, rejected: 2, syncing: true })
    expect(err.kind).toBe('error')
    expect(err.text).toContain('Ошибка')
  })
})

describe('tracks', () => {
  const ts = [
    { id: 't1', track_id: 'a' },
    { id: 't2', track_id: 'b' },
  ] as Team[]
  const cs = [
    { id: 'c1', track_id: null },
    { id: 'c2', track_id: 'a' },
  ] as Criterion[]

  it('limits progress to criteria that apply to the team', () => {
    expect(itemProgress('team', 't2', ts, cs, {})).toMatchObject({ total: 1 })
    expect(itemProgress('criterion', 'c2', ts, cs, {})).toMatchObject({ total: 1 })
    expect(overallProgress(ts, cs, {})).toEqual({ done: 0, total: 3 })
    expect(missingCells(ts, cs, {})).toHaveLength(3)
  })

  it('prunes rows outside the sheet but keeps unsent edits', () => {
    const row = (team_id: string, criterion_id: string, patch: Partial<LocalRow> = {}): LocalRow => ({ team_id, criterion_id, value_x100: 100, note: '', edited_at: 1, dirty: false, ...patch })
    const rows: Rows = {
      't1:c2': row('t1', 'c2'),
      't2:c2': row('t2', 'c2'),
      't9:c1': row('t9', 'c1', { dirty: true }),
      'x:c1': row('x', 'c1', { dirty: true, error: 'rejected' }),
    }
    expect(Object.keys(pruneOutsideSheet(rows, ts, cs)).sort()).toEqual(['t1:c2', 't9:c1'])
  })

  it('exports every local row including parked ones', () => {
    const session = { event: { id: 'e' }, judge: { id: 'j', name: 'J' } } as JudgeSession
    const rows: Rows = {
      a: { team_id: 't1', criterion_id: 'c1', value_x100: 500, note: 'n', edited_at: 2, dirty: true, error: 'x' },
      b: { team_id: 't1', criterion_id: 'c2', value_x100: 300, note: '', edited_at: 1, dirty: false },
    }
    const sheet = buildSheet(session, 'tok', rows, 9)
    expect(sheet).toMatchObject({ format: 'judgeflow-sheet/1', event_id: 'e', judge_id: 'j', token: 'tok', exported_at: 9 })
    expect(sheet.items.map((i) => i.criterion_id)).toEqual(['c2', 'c1'])
  })
})
