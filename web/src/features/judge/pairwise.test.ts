import { describe, expect, it } from 'vitest'
import {
  addReserved,
  applyComparisonResults,
  currentPair,
  decide,
  mergeComparisons,
  nextOpenAfter,
  pickComparisonBatch,
  sortedComparisons,
  winnerForKey,
  type Comparisons,
} from './pairwise'

const rec = (id: string, winner: 'a' | 'b' | 'tie' | null = null, edited_at: number | null = null) => ({ id, team_a: 'x', team_b: 'y', winner, edited_at })
const base = (): Comparisons => addReserved({}, [rec('c1'), rec('c2'), rec('c3')])

describe('pairwise outbox', () => {
  it('keeps the server order of reserved pairs', () => {
    expect(sortedComparisons(base()).map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(sortedComparisons(addReserved(base(), [rec('c0'), rec('c2')])).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c0'])
  })

  it('decide marks the row dirty with a strictly increasing edited_at', () => {
    const a = decide(base(), 'c1', 'a', 1000)
    const b = decide(a, 'c1', 'b', 1000)
    expect(b.c1).toMatchObject({ winner: 'b', dirty: true, edited_at: 1001 })
    expect(decide(b, 'missing', 'a', 5)).toBe(b)
  })

  it('sends only dirty decided rows, oldest first', () => {
    let c = decide(base(), 'c2', 'tie', 20)
    c = decide(c, 'c1', null, 10)
    expect(pickComparisonBatch(c)).toEqual([
      { id: 'c1', winner: null, edited_at: 10 },
      { id: 'c2', winner: 'tie', edited_at: 20 },
    ])
  })

  it('applies ok, stale and rejected results only to unchanged rows', () => {
    let c = decide(decide(decide(base(), 'c1', 'a', 10), 'c2', 'b', 20), 'c3', 'tie', 30)
    const sent = pickComparisonBatch(c)
    c = decide(c, 'c3', 'a', 40) // changed while the request was in flight
    const out = applyComparisonResults(c, sent, [
      { id: 'c1', status: 'ok' },
      { id: 'c2', status: 'stale', server: { winner: 'a', edited_at: 50 } },
      { id: 'c3', status: 'ok' },
    ])
    expect(out.comparisons.c1?.dirty).toBe(false)
    expect(out.comparisons.c2).toMatchObject({ winner: 'a', edited_at: 50, dirty: false })
    expect(out.comparisons.c3?.dirty).toBe(true)
    expect(out).toMatchObject({ ok: 2, stale: 1, rejected: 0 })

    const rejected = applyComparisonResults(decide(base(), 'c1', 'a', 10), [{ id: 'c1', winner: 'a', edited_at: 10 }], [{ id: 'c1', status: 'rejected', error: 'sheet_submitted' }])
    expect(rejected.comparisons.c1?.error).toBeTruthy()
    expect(pickComparisonBatch(rejected.comparisons)).toEqual([])
    const gone = applyComparisonResults(decide(base(), 'c1', 'a', 10), [{ id: 'c1', winner: 'a', edited_at: 10 }], [{ id: 'c1', status: 'rejected', error: 'not_found' }])
    expect(gone.comparisons.c1).toBeUndefined()
  })

  it('merge keeps dirty rows, adopts server decisions and drops released pairs', () => {
    const local = decide(base(), 'c1', 'a', 100)
    const merged = mergeComparisons(local, [rec('c1', 'b', 50), rec('c2', 'tie', 60)])
    expect(merged.c1?.winner).toBe('a')
    expect(merged.c2).toMatchObject({ winner: 'tie', dirty: false })
    expect(merged.c3).toBeUndefined()
  })
})

describe('pairwise navigation', () => {
  it('shows the chosen pair, else the first open, else the last', () => {
    const list = sortedComparisons(decide(base(), 'c1', 'a', 1))
    expect(currentPair(list, undefined)?.id).toBe('c2')
    expect(currentPair(list, 'c1')?.id).toBe('c1')
    const done = sortedComparisons(decide(decide(decide(base(), 'c1', 'a', 1), 'c2', 'a', 2), 'c3', 'a', 3))
    expect(currentPair(done, undefined)?.id).toBe('c3')
  })

  it('finds the next open pair after the current one', () => {
    const list = sortedComparisons(decide(base(), 'c2', 'a', 1))
    expect(nextOpenAfter(list, 'c1')?.id).toBe('c3')
    expect(nextOpenAfter(list, 'c3')?.id).toBe('c1')
  })

  it('maps hotkeys', () => {
    expect([winnerForKey('ArrowLeft'), winnerForKey('1'), winnerForKey('ArrowDown'), winnerForKey('0'), winnerForKey('ArrowRight'), winnerForKey('2'), winnerForKey('x')]).toEqual(['a', 'a', 'tie', 'tie', 'b', 'b', null])
  })
})
