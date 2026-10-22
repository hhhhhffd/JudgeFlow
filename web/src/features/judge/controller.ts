// Judge Desk engine: local-first edits, outbox sync, session refresh, SSE and heartbeat.
// Framework-free external store (consumed with useSyncExternalStore). All server-affecting
// work runs on one serial queue, so a session snapshot can never race a confirmed send.
import { toast } from 'sonner'
import { ApiError, judgeApi, openStream } from '@/api'
import type { JudgeSession, SheetFile, SubmitMissingDetails, SubmitOpenDetails, Winner } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { errorText } from '@/lib/errors'
import {
  applyEdit,
  applyNote,
  adoptedWins,
  applyResults,
  buildSheet,
  dismissOutsideSheet,
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
import {
  addReserved,
  adoptedComparisonWins,
  applyComparisonResults,
  backupComparisons,
  decide,
  diffComparisons,
  mergeComparisons,
  openComparisons,
  pendingComparisons,
  pickComparisonBatch,
  RESERVE_LOW,
  RESERVE_TARGET,
  type Comparisons,
} from './pairwise'
import { adoptOrphans, forgetDesk, loadDesk, onStorageBlocked, saveSession, tokenKey, writeComparisons, writeRows } from './storage'

export const SYNC_DEBOUNCE_MS = 1500
const REFRESH_DEBOUNCE_MS = 500
const RETRY_MS = 10_000
const REFRESH_RETRY_MS = 10_000
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
  /** Pairwise mode: the judge's pairs (open and decided). */
  comparisons: Comparisons
  /** The last reserve call could not fill the target: the judge has seen every pair available to them. */
  reserveExhausted: boolean
  reserving: boolean
  online: boolean
  syncing: boolean
  /** Batch-level failure (network/5xx); per-item rejections live on the rows. */
  syncError: string | null
  storageError: string | null
  /** The device database is held by another tab of this page and cannot be upgraded yet. */
  storageBlocked: boolean
}

export type SubmitOutcome =
  | { ok: true }
  | { ok: false; reason: 'pending' }
  | { ok: false; reason: 'open'; open: number }
  | { ok: false; reason: 'missing'; missing: SubmitMissingDetails['missing'] }
  | { ok: false; reason: 'error'; message: string }

export class DeskController {
  private state: DeskState = {
    phase: 'loading',
    failure: null,
    session: null,
    fromCache: false,
    rows: {},
    comparisons: {},
    reserveExhausted: false,
    reserving: false,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    syncError: null,
    storageError: null,
    storageBlocked: false,
  }
  private listeners = new Set<() => void>()
  private queue: Promise<void> = Promise.resolve()
  private writes: Promise<void> = Promise.resolve()
  private flushQueued = false
  private refreshQueued = false
  private timers: { flush?: number; refresh?: number; refreshRetry?: number; retry?: number; heartbeat?: number } = {}
  private stopStream: (() => void) | null = null
  private running = false
  /** Bumped by every start/stop so a boot that outlived its start (React StrictMode) can tell and bail out. */
  private generation = 0
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
    const generation = ++this.generation
    onStorageBlocked((storageBlocked) => this.set({ storageBlocked }))
    window.addEventListener('online', this.onOnline)
    window.addEventListener('offline', this.onOffline)
    document.addEventListener('visibilitychange', this.onVisibility)
    void this.boot(generation)
  }

  /** Stops the desk and erases this token's cached session and score rows from the device. */
  async forget() {
    this.stop()
    await this.writes
    await forgetDesk(this.k)
  }

  stop() {
    this.running = false
    this.generation++
    onStorageBlocked(null)
    window.removeEventListener('online', this.onOnline)
    window.removeEventListener('offline', this.onOffline)
    document.removeEventListener('visibilitychange', this.onVisibility)
    for (const t of Object.values(this.timers)) window.clearTimeout(t)
    this.timers = {}
    this.stopStream?.()
    this.stopStream = null
  }

  private async boot(generation: number) {
    const current = () => this.running && generation === this.generation
    try {
      const { session, rows, comparisons } = await loadDesk(this.k)
      if (!current()) return
      const byKey: Rows = {}
      for (const r of rows) byKey[`${r.team_id}:${r.criterion_id}`] = r
      this.set({ rows: byKey, comparisons: Object.fromEntries(comparisons.map((c) => [c.id, c])), ...(session ? { session, phase: 'ready', fromCache: true } : {}) })
    } catch (e) {
      console.error('judge: cannot read device storage', e)
      this.set({ storageError: judgeText.sync.storage })
    }
    if (!current()) return
    await this.refresh()
    if (!current()) return
    this.openEventStream()
    this.timers.heartbeat = window.setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    void this.heartbeat()
    void this.flush()
  }

  /** (Re)opens the change stream; any previous one is closed first. */
  private openEventStream() {
    this.stopStream?.()
    this.stopStream = openStream(judgeApi.streamUrl, {
      token: this.token,
      onChange: (kind) => {
        // scores are our own echo; presence is judges' heartbeats: neither changes what a judge sees.
        if (kind !== 'scores' && kind !== 'presence' && kind !== 'stage') this.scheduleRefresh()
      },
      onOpen: ({ reconnect }) => {
        // A first open after a failed boot also needs a refresh: the cached session is still on screen.
        if (!reconnect && !this.state.fromCache) return
        void this.refresh()
        void this.flush()
      },
      onError: (e) => {
        // A rejected stream usually means the token was revoked; a refresh makes that explicit.
        if (e instanceof Error && e.message.startsWith('stream rejected')) this.scheduleRefresh()
      },
    })
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

  private persistComparisons(prev: Comparisons, next: Comparisons) {
    const { upserts, deletes } = diffComparisons(prev, next)
    if (upserts.length === 0 && deletes.length === 0) return
    this.writes = this.writes
      .then(() => writeComparisons(this.k, upserts, deletes))
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
      window.clearTimeout(this.timers.refreshRetry)
      this.timers.refreshRetry = window.setTimeout(() => void this.refresh(), REFRESH_RETRY_MS)
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
        // Pairwise sessions carry no criteria or scores.
        const rows = pruneOutsideSheet(mergeServer(prev, session.scores ?? []), session.teams, session.criteria ?? [])
        const prevComparisons = this.state.comparisons
        const comparisons = session.comparisons ? mergeComparisons(prevComparisons, session.comparisons) : prevComparisons
        // Whatever stopped the last reserve (status, teams, assignments) may have changed: look again.
        window.clearTimeout(this.timers.refreshRetry)
        this.set({ session, rows, comparisons, phase: 'ready', fromCache: false, failure: null, reserveExhausted: false })
        this.persist(prev, rows, session)
        this.persistComparisons(prevComparisons, comparisons)
        void this.ensureReserve()
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
      if (adopted.rows.length === 0 && adopted.comparisons.length === 0) return
      const rows = { ...this.state.rows }
      for (const r of adopted.rows) {
        const key = `${r.team_id}:${r.criterion_id}`
        if (adoptedWins(rows[key], r)) rows[key] = r
      }
      const prevComparisons = this.state.comparisons
      const comparisons = { ...prevComparisons }
      let ord = Math.max(-1, ...Object.values(comparisons).map((c) => c.ord))
      for (const c of adopted.comparisons) {
        if (adoptedComparisonWins(comparisons[c.id], c)) comparisons[c.id] = { ...c, ord: comparisons[c.id]?.ord ?? ++ord }
      }
      this.set({ rows, comparisons })
      this.persistComparisons(prevComparisons, comparisons)
      if (adopted.rows.length > 0) toast.info(judgeText.sync.adoptedToast(adopted.rows.length))
      if (adopted.comparisons.length > 0) toast.info(judgeText.sync.adoptedPairsToast(adopted.comparisons.length))
      void this.flush()
    } catch (e) {
      console.error('judge: cannot adopt edits of a previous link', e)
      this.adoptionDone = false
    }
  }

  /** Leaves the revoked screen to retry from scratch. */
  recheck() {
    this.set({ phase: this.state.session ? 'ready' : 'loading' })
    // A revoked token ended the stream for good; reopen it once the server accepts the token again.
    void this.refresh().then(() => {
      if (this.running && this.state.phase !== 'revoked') this.openEventStream()
    })
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

  /** Pairwise: records (or with null clears) the decision for a pair. */
  decide(id: string, winner: Winner | null) {
    if (!this.editable()) return
    const prev = this.state.comparisons
    const next = decide(prev, id, winner, Date.now())
    if (next === prev) return
    this.set({ comparisons: next, syncError: null })
    this.persistComparisons(prev, next)
    window.clearTimeout(this.timers.flush)
    this.timers.flush = window.setTimeout(() => void this.flush(), SYNC_DEBOUNCE_MS)
    void this.ensureReserve()
  }

  /** Tops the reserve up while online and few pairs are open; no-op otherwise. */
  ensureReserve(): Promise<void> {
    const open = openComparisons(this.state.comparisons).length
    if (open >= RESERVE_LOW || this.state.reserveExhausted) return Promise.resolve()
    return this.reserve(RESERVE_TARGET)
  }

  /** Manual «Ещё пары»: asks for `extra` more open pairs on top of the current ones. */
  reserveMore(extra = RESERVE_TARGET): Promise<void> {
    return this.reserve(openComparisons(this.state.comparisons).length + extra)
  }

  private reserve(count: number): Promise<void> {
    const s = this.state.session
    if (!s || s.event.scoring_mode !== 'pairwise' || !this.editable() || !navigator.onLine || this.state.reserving) return Promise.resolve()
    this.set({ reserving: true })
    return this.enqueue(async () => {
      try {
        const want = Math.min(20, count)
        // Decisions go first so the server's pairs list reflects them.
        await this.doFlush()
        const res = await judgeApi.reservePairs(this.token, want)
        const prev = this.state.comparisons
        const next = addReserved(prev, res.comparisons)
        this.set({ comparisons: next, reserveExhausted: res.comparisons.length < want, syncError: null })
        this.persistComparisons(prev, next)
      } catch (e) {
        this.handleApiError(e, 'sync')
      } finally {
        this.set({ reserving: false })
      }
    })
  }

  /** The judge's explicit «убрать»: forgets rejected scores of cells that left their sheet. */
  dismissOutsideSheet() {
    const s = this.state.session
    if (!s) return
    const prev = this.state.rows
    const rows = dismissOutsideSheet(prev, s.teams, s.criteria ?? [])
    if (rows === prev) return
    this.set({ rows })
    this.persist(prev, rows)
  }

  /** Makes rejected rows eligible for sending again. */
  retryRejected() {
    const rows: Rows = {}
    for (const [k, r] of Object.entries(this.state.rows)) {
      rows[k] = r.error ? ({ ...r, error: undefined } satisfies LocalRow) : r
    }
    this.commit(rows)
    const parked = this.state.comparisons
    const comparisons = Object.fromEntries(Object.entries(parked).map(([id, c]) => [id, c.error ? { ...c, error: undefined } : c]))
    this.set({ comparisons })
    this.persistComparisons(parked, comparisons)
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
    staleTotal += await this.flushComparisons()
    if (this.state.syncing) this.set({ syncing: false })
    if (staleTotal > 0) toast.info(judgeText.sync.staleToast(staleTotal))
  }

  /** Sends dirty pairwise decisions; returns how many came back stale. */
  private async flushComparisons(): Promise<number> {
    let stale = 0
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const items = pickComparisonBatch(this.state.comparisons)
      if (items.length === 0) break
      this.set({ syncing: true })
      let outcome
      try {
        const res = await judgeApi.putComparisons(this.token, items)
        outcome = applyComparisonResults(this.state.comparisons, items, res.results)
      } catch (e) {
        this.handleApiError(e, 'sync')
        break
      }
      const prev = this.state.comparisons
      this.set({ comparisons: outcome.comparisons, syncing: false, syncError: null })
      this.persistComparisons(prev, outcome.comparisons)
      stale += outcome.stale
      if (outcome.unconfirmed > 0 && outcome.ok + outcome.stale + outcome.rejected === 0) {
        this.set({ syncError: judgeText.errors.notConfirmed(outcome.unconfirmed) })
        break
      }
    }
    return stale
  }

  private async heartbeat() {
    if (!navigator.onLine) return
    try {
      await judgeApi.heartbeat(this.token, pendingCount(this.state.rows) + pendingComparisons(this.state.comparisons))
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.set({ phase: 'revoked' })
      else console.warn('judge: heartbeat failed', e)
    }
  }

  // ---- emergency backup ----

  /** The whole local sheet including the judge's token, or null before a session exists. */
  exportSheet(): SheetFile | null {
    const session = this.state.session
    if (!session) return null
    const comparisons = session.event.scoring_mode === 'pairwise' ? backupComparisons(this.state.comparisons) : undefined
    return buildSheet(session, this.token, this.state.rows, Date.now(), comparisons)
  }

  // ---- sheet submission ----

  private setSubmitted(judge: JudgeSession['judge']) {
    const session = this.state.session
    if (!session) return
    const next = { ...session, judge }
    this.set({ session: next })
    this.persist(this.state.rows, this.state.rows, next)
  }

  /** `releaseOpen` (pairwise): give up the pairs that were reserved but not decided. */
  async submit(releaseOpen = false): Promise<SubmitOutcome> {
    await this.flush()
    if (pendingCount(this.state.rows) + pendingComparisons(this.state.comparisons) > 0) return { ok: false, reason: 'pending' }
    try {
      const res = await judgeApi.submit(this.token, releaseOpen)
      this.setSubmitted(res.judge)
      if (releaseOpen) await this.refresh()
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
      const open = (e.details as Partial<SubmitOpenDetails> | undefined)?.open
      if (e.status === 409 && Array.isArray(open)) return { ok: false, reason: 'open', open: open.length }
      if (e.status === 409 && Array.isArray(missing)) return { ok: false, reason: 'missing', missing }
    }
    return { ok: false, reason: 'error', message: errorText(e) }
  }
}
