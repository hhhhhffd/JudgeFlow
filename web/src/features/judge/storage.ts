// Device storage of the Judge Desk: last active token (localStorage) and
// per-judge session cache + score rows (IndexedDB).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { JudgeSession } from '@/api/types'
import { adoptedWins, canDeleteStored, canOverwriteStored, pickOrphanKeys, type LocalRow, type RowRef } from './scoring'

const TOKEN_KEY = 'jf.judge.token'
const alertKey = (eventId: string) => `jf.judge.alert.${eventId}`

// localStorage can throw (private mode, blocked storage): the desk still works, just without memory.
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch (e) {
    console.warn('judge: localStorage unavailable', e)
  }
}

export const getStoredToken = () => lsGet(TOKEN_KEY)
export const setStoredToken = (token: string | null) => lsSet(TOKEN_KEY, token)

export function getSeenAlertVersion(eventId: string): number {
  const n = Number(lsGet(alertKey(eventId)))
  return Number.isFinite(n) ? n : 0
}
export const setSeenAlertVersion = (eventId: string, version: number) => lsSet(alertKey(eventId), String(version))

/** Short non-cryptographic fingerprint (cyrb53): keeps raw tokens out of IndexedDB keys and works on plain-HTTP LANs. */
export function tokenKey(token: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < token.length; i++) {
    const ch = token.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

type StoredRow = LocalRow & { k: string }

interface DeskDB extends DBSchema {
  sessions: { key: string; value: { k: string; session: JudgeSession; saved_at: number } }
  rows: { key: [string, string, string]; value: StoredRow; indexes: { byToken: string } }
}

let dbPromise: Promise<IDBPDatabase<DeskDB>> | null = null
function db() {
  dbPromise ??= openDB<DeskDB>('judgeflow-judge', 1, {
    upgrade(d) {
      d.createObjectStore('sessions', { keyPath: 'k' })
      d.createObjectStore('rows', { keyPath: ['k', 'team_id', 'criterion_id'] }).createIndex('byToken', 'k')
    },
  }).catch((e) => {
    dbPromise = null
    throw e
  })
  return dbPromise
}

export async function loadDesk(k: string): Promise<{ session: JudgeSession | null; rows: LocalRow[] }> {
  const d = await db()
  const [saved, stored] = await Promise.all([d.get('sessions', k), d.getAllFromIndex('rows', 'byToken', k)])
  return { session: saved?.session ?? null, rows: stored.map((r): LocalRow => ({ team_id: r.team_id, criterion_id: r.criterion_id, value_x100: r.value_x100, note: r.note, edited_at: r.edited_at, dirty: r.dirty, error: r.error })) }
}

export async function saveSession(k: string, session: JudgeSession) {
  await (await db()).put('sessions', { k, session, saved_at: Date.now() })
}

/** Read-compare-write in one transaction, so a concurrent tab's newer unsynced edit is never clobbered. */
export async function writeRows(k: string, upserts: LocalRow[], deletes: RowRef[]) {
  const d = await db()
  const tx = d.transaction('rows', 'readwrite')
  const ops = [
    ...upserts.map(async (r) => {
      if (canOverwriteStored(await tx.store.get([k, r.team_id, r.criterion_id]), r)) await tx.store.put({ ...r, k })
    }),
    ...deletes.map(async (r) => {
      const key: [string, string, string] = [k, r.team_id, r.criterion_id]
      if (canDeleteStored(await tx.store.get(key), r)) await tx.store.delete(key)
    }),
  ]
  await Promise.all([...ops, tx.done])
}

/** Unsynced rows stored under other tokens of the same judge+event (identity comes from the cached session). */
export async function adoptOrphans(k: string, session: JudgeSession): Promise<LocalRow[]> {
  const d = await db()
  const tx = d.transaction(['sessions', 'rows'], 'readwrite')
  const cached = (await tx.objectStore('sessions').getAll()).map((c) => ({ k: c.k, judge_id: c.session.judge.id, event_id: c.session.event.id }))
  const orphans = pickOrphanKeys({ k, judge_id: session.judge.id, event_id: session.event.id }, cached)
  const adopted: LocalRow[] = []
  for (const old of orphans) {
    for (const row of await tx.objectStore('rows').index('byToken').getAll(old)) {
      if (!row.dirty) continue
      const local: LocalRow = { team_id: row.team_id, criterion_id: row.criterion_id, value_x100: row.value_x100, note: row.note, edited_at: row.edited_at, dirty: row.dirty, error: row.error }
      const existing = await tx.objectStore('rows').get([k, local.team_id, local.criterion_id])
      if (adoptedWins(existing, local)) {
        await tx.objectStore('rows').put({ ...local, k })
        adopted.push(local)
      }
    }
    let cursor = await tx.objectStore('rows').index('byToken').openKeyCursor(old)
    while (cursor) {
      await tx.objectStore('rows').delete(cursor.primaryKey)
      cursor = await cursor.continue()
    }
    await tx.objectStore('sessions').delete(old)
  }
  await tx.done
  return adopted
}
