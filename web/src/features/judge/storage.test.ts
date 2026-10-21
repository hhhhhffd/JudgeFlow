import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JudgeSession } from '@/api/types'
import type { LocalComparison } from './pairwise'
import type { LocalRow } from './scoring'

type Storage = typeof import('./storage')

const DB_NAME = 'judgeflow-judge'

// storage.ts is stateful (cached open promise, timeout flag): load a fresh copy on a fresh IndexedDB per test.
async function freshStorage(): Promise<Storage> {
  vi.resetModules()
  return import('./storage')
}

const row = (team_id: string, edited_at: number, dirty = true, value_x100: number | null = 500): LocalRow => ({ team_id, criterion_id: 'c1', value_x100, note: '', edited_at, dirty })
const cmp = (id: string, edited_at: number | null, dirty = true): LocalComparison => ({ id, team_a: 'a', team_b: 'b', winner: 'a', edited_at, ord: 0, dirty })

function session(judgeId: string, eventId: string): JudgeSession {
  return { judge: { id: judgeId, name: 'J', submitted_at: null }, event: { id: eventId }, teams: [], criteria: [], tracks: [], scores: [] } as unknown as JudgeSession
}

/** The v1 schema as shipped before the comparisons store existed. */
async function createV1(): Promise<ReturnType<typeof openDB>> {
  return openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('sessions', { keyPath: 'k' })
      d.createObjectStore('rows', { keyPath: ['k', 'team_id', 'criterion_id'] }).createIndex('byToken', 'k')
    },
  })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.stubGlobal('window', globalThis)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('upgrade v1 -> v2', () => {
  it('keeps dirty rows and creates the comparisons store', async () => {
    const v1 = await createV1()
    await v1.put('rows', { ...row('t1', 10), k: 'tok' })
    await v1.put('rows', { ...row('t2', 11, false), k: 'tok' })
    v1.close()

    const s = await freshStorage()
    const loaded = await s.loadDesk('tok')
    expect(loaded.rows.map((r) => [r.team_id, r.dirty]).sort()).toEqual([['t1', true], ['t2', false]])
    expect(loaded.comparisons).toEqual([])

    await s.writeComparisons('tok', [cmp('p1', 5)], [])
    expect((await s.loadDesk('tok')).comparisons).toHaveLength(1)
  })
})

describe('blocked upgrade', () => {
  it('reports blocked, fails fast after the timeout and recovers once the old tab lets go', async () => {
    const v1 = await createV1() // an "old tab" that ignores versionchange
    const s = await freshStorage()
    const blocked = vi.fn()
    s.onStorageBlocked(blocked)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const first = s.loadDesk('tok')
    const firstResult = first.then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledWith(true))

    await vi.advanceTimersByTimeAsync(5000)
    expect(await firstResult).toBe('IndexedDB open timed out')
    // Subsequent calls reject immediately, without waiting another 5 s.
    await expect(s.loadDesk('tok')).rejects.toThrow('IndexedDB open is blocked')

    v1.close()
    vi.useRealTimers()
    await vi.waitFor(async () => {
      expect((await s.loadDesk('tok')).rows).toEqual([])
    })
    expect(blocked).toHaveBeenLastCalledWith(false)
  })
})

describe('blocking handler', () => {
  it('closes the open connection when a newer version is requested and drops the cached promise', async () => {
    const s = await freshStorage()
    await s.loadDesk('tok')

    const v3 = await openDB(DB_NAME, 3) // would hang as "blocked" if the desk kept its connection
    v3.close()

    // A cached, closed connection would throw InvalidStateError; a fresh open instead hits the newer schema.
    await expect(s.loadDesk('tok')).rejects.toMatchObject({ name: 'VersionError' })
  })
})

describe('adoptOrphans', () => {
  it('moves dirty rows and comparisons to the new key with last-write-wins and leaves others alone', async () => {
    const s = await freshStorage()
    await s.saveSession('old', session('j1', 'e1'))
    await s.saveSession('new', session('j1', 'e1'))
    await s.saveSession('otherJudge', session('j2', 'e1'))
    await s.saveSession('otherEvent', session('j1', 'e2'))

    const oldRows = [row('t1', 20), row('t2', 20), row('t3', 20), row('t4', 20, false)]
    await s.writeRows('old', oldRows, [])
    await s.writeRows('new', [row('t2', 30), row('t3', 10, true, 111)], [])
    await s.writeRows('otherJudge', [row('t1', 99)], [])
    await s.writeRows('otherEvent', [row('t1', 98)], [])
    await s.writeComparisons('old', [cmp('p1', 20), cmp('p2', 20), cmp('p3', 20, false)], [])
    await s.writeComparisons('new', [cmp('p2', 30)], [])
    await s.writeComparisons('otherJudge', [cmp('p1', 97)], [])

    const adopted = await s.adoptOrphans('new', session('j1', 'e1'))
    expect(adopted.rows.map((r) => r.team_id).sort()).toEqual(['t1', 't3'])
    expect(adopted.comparisons.map((c) => c.id)).toEqual(['p1'])

    const nw = await s.loadDesk('new')
    const byTeam = Object.fromEntries(nw.rows.map((r) => [r.team_id, r]))
    expect(Object.keys(byTeam).sort()).toEqual(['t1', 't2', 't3'])
    expect(byTeam.t2?.edited_at).toBe(30) // newer existing row kept
    expect(byTeam.t3?.edited_at).toBe(20) // older existing row replaced
    expect(nw.comparisons.map((c) => [c.id, c.edited_at]).sort()).toEqual([['p1', 20], ['p2', 30]])

    // Old key range fully removed, including the clean rows that were not adopted.
    const old = await s.loadDesk('old')
    expect(old).toEqual({ session: null, rows: [], comparisons: [] })

    expect((await s.loadDesk('otherJudge')).rows).toHaveLength(1)
    expect((await s.loadDesk('otherJudge')).comparisons).toHaveLength(1)
    expect((await s.loadDesk('otherEvent')).rows).toHaveLength(1)
    expect((await s.loadDesk('otherEvent')).session).not.toBeNull()
  })
})

describe('multi-tab write guards', () => {
  it('writeRows keeps a stored dirty row that is newer than the incoming upsert or delete', async () => {
    const s = await freshStorage()
    await s.writeRows('k', [row('t1', 50, true, 900)], [])

    await s.writeRows('k', [row('t1', 40, true, 100)], [])
    expect((await s.loadDesk('k')).rows[0]?.value_x100).toBe(900)

    await s.writeRows('k', [], [{ team_id: 't1', criterion_id: 'c1', edited_at: 40 }])
    expect((await s.loadDesk('k')).rows).toHaveLength(1)

    await s.writeRows('k', [row('t1', 60, true, 700)], [])
    expect((await s.loadDesk('k')).rows[0]?.value_x100).toBe(700)

    await s.writeRows('k', [], [{ team_id: 't1', criterion_id: 'c1', edited_at: 60 }])
    expect((await s.loadDesk('k')).rows).toEqual([])
  })

  it('writeComparisons keeps a stored dirty decision that is newer than the incoming upsert or delete', async () => {
    const s = await freshStorage()
    await s.writeComparisons('k', [{ ...cmp('p1', 50), winner: 'b' }], [])

    await s.writeComparisons('k', [{ ...cmp('p1', 40), winner: 'a' }], [])
    expect((await s.loadDesk('k')).comparisons[0]?.winner).toBe('b')

    await s.writeComparisons('k', [], [{ id: 'p1', edited_at: 40 }])
    expect((await s.loadDesk('k')).comparisons).toHaveLength(1)

    await s.writeComparisons('k', [], [{ id: 'p1', edited_at: 50 }])
    expect((await s.loadDesk('k')).comparisons).toEqual([])
  })
})

describe('forgetDesk', () => {
  it('erases session, rows and comparisons of that key only', async () => {
    const s = await freshStorage()
    for (const k of ['a', 'ab', 'b']) {
      await s.saveSession(k, session(`j-${k}`, 'e1'))
      await s.writeRows(k, [row('t1', 1, false)], [])
      await s.writeComparisons(k, [cmp('p1', 1, false)], [])
    }
    await s.forgetDesk('a')
    expect(await s.loadDesk('a')).toEqual({ session: null, rows: [], comparisons: [] })
    for (const k of ['ab', 'b']) {
      const d = await s.loadDesk(k)
      expect(d.session).not.toBeNull()
      expect(d.rows).toHaveLength(1)
      expect(d.comparisons).toHaveLength(1)
    }
  })
})
