// Judge Desk engine: local-first edits, outbox sync, session refresh, SSE and heartbeat.
// Framework-free external store (consumed with useSyncExternalStore). All server-affecting
// work runs on one serial queue, so a session snapshot can never race a confirmed send.
import { toast } from 'sonner'
import { ApiError, judgeApi, openStream } from '@/api'
import type { JudgeSession, SheetFile, SubmitMissingDetails } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { errorText } from '@/lib/errors'
import {
  applyEdit,
  applyNote,
  adoptedWins,
  applyResults,
  buildSheet,
  diffRows,
  itemKeys,
  itemNote,
  mergeServer,
  pendingCount,
  pickBatch,
  pruneOutsideSheet,
  readOnlyReason,
  type LocalRow,
  type Rows,
} from './scoring'
import { adoptOrphans, forgetDesk, loadDesk, saveSession, tokenKey, writeRows } from './storage'

export const SYNC_DEBOUNCE_MS = 1500
const REFRESH_DEBOUNCE_MS = 500
const RETRY_MS = 10_000
const HEARTBEAT_MS = 30_000
const MAX_PASSES = 20

export interface DeskState {
  /** loading: nothing to show yet; ready: session available (maybe from cache); revoked: 401; failed: no cache and no server. */
  phase: 'loading' | 'ready' | 'revoked' | 'failed'
  failure: string | null
  session: JudgeSession | null
  /** The session shown comes from the device cache, the server was not reachable. */
  fromCache: boolean
  rows: Rows
  online: boolean
  syncing: boolean
  /** Batch-level failure (network/5xx); per-item rejections live on the rows. */
  syncError: string | null
  storageError: string | null
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: 'pending' }
  | { ok: false; reason: 'missing'; missing: SubmitMissingDetails['missing'] }
  | { ok: false; reason: 'error'; message: string }

export class DeskController {
  private state: DeskState = {
    phase: 'loading',
    failure: null,
    session: null,
    fromCache: false,
    rows: {},
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    syncError: null,
    storageError: null,
  }
  private listeners = new Set<() => void>()
  private queue: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private flushQueued = false
  private refreshQueued = false
  private timers: { flush?: number; refresh?: number; retry?: number; heartbeat?: number } = {}
  private stopStream: (() => void) | null = null
  private running = false
  private adoptionDone = false
  private readonly k: string

  constructor(private readonly token: string) {
    this.k = tokenKey(token)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = () => this.state

  private set(patch: Partial<DeskState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((l) => l())
  }

  // ---- lifecycle ----

  start() {
    this.running = true
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    document.addEventListener('visibilitychange', this.onVisibility)
    void this.boot()
  }

  /** Stops the desk and erases this token's cached session and score rows from the device. */
  async forget() {
    this.stop()
    await this.writes
    await forgetDesk(this.k)
  }

  stop() {
    this.running = false
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    document.removeEventListener('visibilitychange', this.onVisibility)
    for (const t of Object.values(this.timers)) window.clearTimeout(t)
    this.timers = {}
    this.stopStream?.()
    this.stopStream = null
  }

  private async boot() {
    try {
      const { session, rows } = await loadDesk(this.k)
      if (!this.running) return
      const byKey: Rows = {}
      for (const r of rows) byKey[`${r.team_id}:${r.criterion_id}`] = r
      this.set({ rows: byKey, ...(session ? { session, phase: 'ready', fromCache: true } : {}) })
    } catch (e) {
      console.error('judge: cannot read device storage', e)
      this.set({ storageError: judgeText.sync.storage })
    }
    if (!this.running) return
    await this.refresh()
    if (!this.running) return
    this.stopStream = openStream(judgeApi.streamUrl, {
      token: this.token,
      onChange: (kind) => {
        // scores are our own echo; presence is judges' heartbeats: neither changes what a judge sees.
        if (kind !== 'scores' && kind !== 'presence' && kind !== 'stage') this.scheduleRefresh()
      },
      onOpen: ({ reconnect }) => {
        if (!reconnect) return
        void this.refresh()
        void this.flush()
      },
      onError: (e) => {
        // A rejected stream usually means the token was revoked; a refresh makes that explicit.
        if (e instanceof Error && e.message.startsWith('stream rejected')) this.scheduleRefresh()
      },
    })
    this.timers.heartbeat = window.setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    void this.heartbeat()
    void this.flush()
  }

  private onOnline = () => {
    this.set({ online: true })
    void this.refresh()
    void this.flush()
  }
  private onOffline = () => this.set({ online: false })
  private onVisibility = () => {
    if (document.visibilityState === 'visible') {
      this.set({ online: navigator.onLine })
      void this.refresh()
    }
    void this.flush()
  }

  // ---- queue ----

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn)
    // fn reports its own failures into state; this only keeps the chain alive.
    this.queue = run.catch(() => undefined)
    return run
  }

  private persist(prev: Rows, next: Rows, session?: JudgeSession) {
    const { upserts, deletes } = diffRows(prev, next)
    if (upserts.length === 0 && deletes.length === 0 && !session) return
    this.writes = this.writes
      .then(async () => {
        if (session) await saveSession(this.k, session)
        if (upserts.length || deletes.length) await writeRows(this.k, upserts, deletes)
      })
      .catch((e) => {
        console.error('judge: cannot write device storage', e)
        this.set({ storageError: judgeText.sync.storage })
      })
  }

  private handleApiError(e: unknown, context: 'refresh' | 'sync'): void {
    if (e instanceof ApiError && e.status === 401) {
      this.set({ phase: 'revoked', syncing: false })
      return
    }
    const message = errorText(e)
    const network = e instanceof ApiError && e.status === 0
    if (context === 'refresh') {
      if (this.state.session) this.set({ fromCache: true })
      else this.set({ phase: 'failed', failure: network ? judgeText.failed.offlineText : message })
      return
    }
    this.set({ syncing: false, syncError: network && !this.state.online ? null : message })
    window.clearTimeout(this.timers.retry)
    this.timers.retry = window.setTimeout(() => void this.flush(), RETRY_MS)
  }

  // ---- refresh ----

  scheduleRefresh() {
    window.clearTimeout(this.timers.refresh)
    this.timers.refresh = window.setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS)
  }

  refresh(): Promise<void> {
    if (this.refreshQueued) return this.queue
    this.refreshQueued = true
    return this.enqueue(async () => {
      this.refreshQueued = false
      try {
        const session = await judgeApi.session(this.token)
        await this.adoptOrphans(session)
        const prev = this.state.rows
        const rows = pruneOutsideSheet(mergeServer(prev, session.scores), session.teams, session.criteria)
        this.set({ session, rows, phase: 'ready', fromCache: false, failure: null })
        this.persist(prev, rows, session)
      } catch (e) {
        this.handleApiError(e, 'refresh')
      }
    })
  }

  /** Once per start: takes over unsynced edits stored under a previous token of this judge. */
  private async adoptOrphans(session: JudgeSession) {
    if (this.adoptionDone) return
    this.adoptionDone = true
    try {
      await this.writes
      const adopted = await adoptOrphans(this.k, session)
      if (adopted.length === 0) return
      const rows = { ...this.state.rows }
      for (const r of adopted) {
        const key = `${r.team_id}:${r.criterion_id}`
        if (adoptedWins(rows[key], r)) rows[key] = r
      }
      this.set({ rows })
      toast.info(judgeText.sync.adoptedToast(adopted.length))
      void this.flush()
    } catch (e) {
      console.error('judge: cannot adopt edits of a previous link', e)
      this.adoptionDone = false
    }
  }

  /** Leaves the revoked screen to retry from scratch. */
  recheck() {
    this.set({ phase: this.state.session ? 'ready' : 'loading' })
    void this.refresh()
  }

  // ---- edits ----

  private editable(): JudgeSession | null {
    const s = this.state.session
    return s && readOnlyReason(s.event.status, s.judge.submitted_at) === null ? s : null
  }

  private commit(rows: Rows) {
    const prev = this.state.rows
    this.set({ rows, syncError: null })
    this.persist(prev, rows)
    window.clearTimeout(this.timers.flush)
    this.timers.flush = window.setTimeout(() => void this.flush(), SYNC_DEBOUNCE_MS)
  }

  setScore(teamId: string, criterionId: string, value: number | null) {
    const s = this.editable()
    if (!s) return
    const mode = s.event.scoring_mode
    const itemId = mode === 'team' ? teamId : criterionId
    const note = itemNote(this.state.rows, itemKeys(mode, itemId, s.teams, s.criteria))
    this.commit(applyEdit(this.state.rows, teamId, criterionId, { value_x100: value }, note, Date.now()))
  }

  setNote(itemId: string, note: string) {
    const s = this.editable()
    if (!s) return
    const keys = itemKeys(s.event.scoring_mode, itemId, s.teams, s.criteria)
    const rows = applyNote(this.state.rows, keys, note, Date.now())
    if (rows !== this.state.rows) this.commit(rows)
  }

  /** Makes rejected rows eligible for sending again. */
  retryRejected() {
    const rows: Rows = {}
    for (const [k, r] of Object.entries(this.state.rows)) {
      rows[k] = r.error ? ({ ...r, error: undefined } satisfies LocalRow) : r
    }
    this.commit(rows)
    void this.flush()
  }

  // ---- sync ----

  flush(): Promise<void> {
    window.clearTimeout(this.timers.flush)
    if (this.flushQueued) return this.queue
    this.flushQueued = true
    return this.enqueue(async () => {
      this.flushQueued = false
      await this.doFlush()
    })
  }

  private async doFlush() {
    if (!navigator.onLine) {
      this.set({ online: false })
      return
    }
    let staleTotal = 0
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const items = pickBatch(this.state.rows)
      if (items.length === 0) break
      this.set({ syncing: true })
      let outcome
      try {
        const res = await judgeApi.putScores(this.token, items)
        outcome = applyResults(this.state.rows, items, res.results)
      } catch (e) {
        this.handleApiError(e, 'sync')
        break
      }
      const prev = this.state.rows
      this.set({ rows: outcome.rows, syncing: false, syncError: null })
      this.persist(prev, outcome.rows)
      staleTotal += outcome.stale
      if (outcome.unconfirmed > 0 && outcome.ok + outcome.stale + outcome.rejected === 0) {
        this.set({ syncError: judgeText.errors.notConfirmed(outcome.unconfirmed) })
        break
      }
    }
    if (this.state.syncing) this.set({ syncing: false })
    if (staleTotal > 0) toast.info(judgeText.sync.staleToast(staleTotal))
  }

  private async heartbeat() {
    if (!navigator.onLine) return
    try {
      await judgeApi.heartbeat(this.token, pendingCount(this.state.rows))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.set({ phase: 'revoked' })
      else console.warn('judge: heartbeat failed', e)
    }
  }

  // ---- emergency backup ----

  /** The whole local sheet including the judge's token, or null before a session exists. */
  exportSheet(): SheetFile | null {
    const session = this.state.session
    return session ? buildSheet(session, this.token, this.state.rows, Date.now()) : null
  }

  // ---- sheet submission ----

  private setSubmitted(judge: JudgeSession['judge']) {
    const session = this.state.session
    if (!session) return
    const next = { ...session, judge }
    this.set({ session: next })
    this.persist(this.state.rows, this.state.rows, next)
  }

  async submit(): Promise<SubmitOutcome> {
    await this.flush()
    if (pendingCount(this.state.rows) > 0) return { ok: false, reason: 'pending' }
    try {
      const res = await judgeApi.submit(this.token)
      this.setSubmitted(res.judge)
      return { ok: true }
    } catch (e) {
      return this.submitFailure(e)
    }
  }

  async unsubmit(): Promise<SubmitOutcome> {
    try {
      const res = await judgeApi.unsubmit(this.token)
      this.setSubmitted(res.judge)
      return { ok: true }
    } catch (e) {
      return this.submitFailure(e)
    }
  }

  private submitFailure(e: unknown): SubmitOutcome {
    if (e instanceof ApiError) {
      if (e.status === 401) this.set({ phase: 'revoked' })
      const missing = (e.details as Partial<SubmitMissingDetails> | undefined)?.missing
      if (e.status === 409 && Array.isArray(missing)) return { ok: false, reason: 'missing', missing }
    }
    return { ok: false, reason: 'error', message: errorText(e) }
  }
}
