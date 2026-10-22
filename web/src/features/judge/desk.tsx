import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronLeft, ChevronRight, ListChecks, Lock, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Criterion, JudgeSession } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Backdrop } from '@/features/live/backdrop'
import { judgeText } from '@/i18n/judge'
import { formatX100 } from '@/lib/format'
import { criterionApplies, groupByTrack } from '@/lib/tracks'
import { cn } from '@/lib/utils'
import { AlertModal } from './alert-modal'
import { BackupAlert, BackupMenu, LockedRejectedNotice } from './backup'
import type { DeskController } from './controller'
import { HotkeysHelp, useHotkeys } from './hotkeys'
import { Queue } from './queue'
import { ScoreInput } from './score-input'
import {
  canRetry,
  cellKey,
  errorRows,
  rejectedOutsideSheet,
  itemKeys,
  itemLines,
  itemNote,
  overallProgress,
  pendingCount,
  readOnlyReason,
  scaleOf,
  syncIndicator,
} from './scoring'
import { getSeenAlertVersion, setSeenAlertVersion } from './storage'
import { SubmitDialog } from './submit-dialog'
import { CachedCopyNotice, SyncBadge } from './sync-badge'

// Mirrors NOTE_MAX_CHARS of the server (src/routes/judge.rs).
const NOTE_MAX_CHARS = 2000
const NOTE_COUNTER_FROM = 1800

type Item = { id: string; name: string; description: string | null; track_id: string | null }

const label = (enabled: boolean, custom: string | null, fallback: string) => (enabled && custom?.trim() ? custom.trim() : fallback)

export function Desk({ controller, session }: { controller: DeskController; session: JudgeSession }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { rows } = state
  const { event, teams, criteria } = session
  // Pairwise events render PairwiseDesk instead (see index.tsx).
  const mode = event.scoring_mode === 'criterion' ? 'criterion' : 'team'

  const teamsLabel = label(event.teams_label_enabled, event.teams_label, judgeText.defaultTeams)
  const criteriaLabel = label(event.criteria_label_enabled, event.criteria_label, judgeText.defaultCriteria)
  const tracks = useMemo(() => session.tracks ?? [], [session.tracks])
  // The queue is shown grouped by track, so navigation follows the same order.
  const items: Item[] = useMemo(() => {
    const raw: Item[] = mode === 'team' ? teams : criteria.filter((c) => teams.some((t) => criterionApplies(c, t)))
    return groupByTrack(raw, tracks).flatMap((g) => g.rows)
  }, [mode, teams, criteria, tracks])
  const itemsLabel = mode === 'team' ? teamsLabel : criteriaLabel
  const linesLabel = mode === 'team' ? criteriaLabel : teamsLabel

  const [itemId, setItemId] = useState<string | undefined>()
  const [lineId, setLineId] = useState<string | undefined>()
  const [submitOpen, setSubmitOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [seenAlert, setSeenAlert] = useState(() => getSeenAlertVersion(event.id))

  const itemIndex = Math.max(0, items.findIndex((i) => i.id === itemId))
  const item = items[itemIndex]
  const lines: Item[] = useMemo(() => (item ? itemLines(mode, item.id, teams, criteria) : []), [mode, item, teams, criteria])
  const lineIndex = Math.max(0, lines.findIndex((l) => l.id === lineId))
  const line = lines[lineIndex]

  const reason = readOnlyReason(event.status, session.judge.submitted_at)
  const readOnly = reason !== null
  const progress = useMemo(() => overallProgress(teams, criteria, rows), [teams, criteria, rows])
  const pending = pendingCount(rows)
  const rejected = errorRows(rows).length
  const outsideSheet = useMemo(() => rejectedOutsideSheet(rows, teams, criteria).length, [rows, teams, criteria])
  const indicator = syncIndicator({ online: state.online, syncing: state.syncing, pending, rejected, syncError: state.syncError })
  const retryAllowed = canRetry(errorRows(rows).map((r) => r.error), event.status)
  const alertOpen = event.alert.enabled && event.alert.version > seenAlert

  const cellOf = (l: Item) => (mode === 'team' ? cellKey(item?.id ?? '', l.id) : cellKey(l.id, item?.id ?? ''))
  const scaleOfLine = (l: Item) => (mode === 'team' ? (l as Criterion) : (item as Criterion))
  const setValue = (l: Item, value: number | null) => {
    if (!item) return
    if (mode === 'team') controller.setScore(item.id, l.id, value)
    else controller.setScore(l.id, item.id, value)
  }

  function goItem(delta: -1 | 1) {
    const next = items[itemIndex + delta]
    if (!next) return
    setItemId(next.id)
    setLineId(undefined)
  }
  function goLine(delta: -1 | 1) {
    const next = lines[lineIndex + delta]
    if (next) setLineId(next.id)
  }
  function jump(teamId: string, criterionId: string) {
    setItemId(mode === 'team' ? teamId : criterionId)
    setLineId(mode === 'team' ? criterionId : teamId)
  }
  const canSubmit = reason === null
  const openSubmit = () => canSubmit && setSubmitOpen(true)

  const activeScale = line && item ? scaleOf(scaleOfLine(line)) : null
  useHotkeys({
    enabled: !submitOpen && !alertOpen && !queueOpen,
    positions: !readOnly && activeScale?.kind === 'segmented' ? activeScale.values.length : 0,
    onPosition: (index) => {
      if (line && activeScale?.kind === 'segmented') setValue(line, activeScale.values[index] ?? null)
    },
    onItem: goItem,
    onLine: goLine,
    onSubmit: openSubmit,
  })

  // A new queue item starts at the top (the scroll container is the window on mobile, <main> on desktop).
  const mainRef = useRef<HTMLElement>(null)
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [item?.id])

  useEffect(() => {
    if (!line) return
    document.querySelector(`[data-line="${CSS.escape(line.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [line, item?.id])

  const note = item ? itemNote(rows, itemKeys(mode, item.id, teams, criteria)) : ''
  const hasScoreInItem = item ? itemKeys(mode, item.id, teams, criteria).some((k) => rows[k]?.value_x100 != null) : false

  function dismissAlert() {
    setSeenAlertVersion(event.id, event.alert.version)
    setSeenAlert(event.alert.version)
  }

  async function withdraw() {
    const outcome = await controller.unsubmit()
    if (outcome.ok) toast.success(judgeText.submit.withdrawn)
    else if (outcome.reason === 'error') toast.error(outcome.message)
  }

  const queue = (
    <Queue
      mode={mode}
      heading={itemsLabel}
      items={items}
      tracks={tracks}
      allTracksLabel={mode === 'team' ? judgeText.queue.noTrack : judgeText.queue.allTracks}
      teams={teams}
      criteria={criteria}
      rows={rows}
      currentId={item?.id}
      progress={progress}
      onSelect={(id) => {
        setItemId(id)
        setLineId(undefined)
        setQueueOpen(false)
      }}
    />
  )
  const isLast = itemIndex >= items.length - 1

  return (
    <>
      <Backdrop url={event.background_url} overlay={event.overlay} />
      <div className="relative z-10 flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card/90 px-4 py-2.5 backdrop-blur lg:static">
          <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
            <h1 className="truncate text-base leading-tight font-semibold sm:text-lg">{event.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{session.judge.name}</p>
          </div>
          <SyncBadge kind={indicator.kind} text={indicator.text} pending={pending} fromCache={state.fromCache} canRetry={retryAllowed} onRetry={() => controller.retryRejected()} />
          <BackupMenu controller={controller} />
          <HotkeysHelp />
          {session.judge.submitted_at !== null ? (
            <Badge variant="success" className="py-1">
              {judgeText.submit.submittedBanner}
            </Badge>
          ) : (
            canSubmit && (
              <Button size="sm" className="h-11 sm:h-8" onClick={openSubmit}>
                <Send />
                {judgeText.submit.button}
              </Button>
            )
          )}
        </header>

        <CachedCopyNotice fromCache={state.fromCache} />
        {indicator.kind === 'error' && !retryAllowed && <LockedRejectedNotice controller={controller} />}
        <BackupAlert controller={controller} errorKind={indicator.kind === 'error'} />
        {outsideSheet > 0 && (
          <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{judgeText.sync.outsideSheet(outsideSheet)}.</span> {judgeText.sync.outsideSheetHint}
            </span>
            <Button size="sm" variant="outline" onClick={() => controller.dismissOutsideSheet()}>
              {judgeText.sync.outsideSheetDismiss}
            </Button>
          </div>
        )}
        {state.storageError && (
          <p role="alert" className="border-b border-warning/30 bg-warning-soft px-4 py-2 text-sm text-warning">
            {state.storageError}
          </p>
        )}
        {reason && (
          <div role="status" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-info-soft px-4 py-2.5 text-sm text-info">
            <Lock className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">{judgeText.readOnly[reason]}</span>
            {reason === 'submitted' && (
              <Button variant="outline" size="sm" onClick={() => void withdraw()}>
                {judgeText.submit.withdraw}
              </Button>
            )}
          </div>
        )}

        <div className="grid min-h-0 flex-1 lg:grid-cols-[17rem_minmax(0,1fr)_19rem] xl:grid-cols-[20rem_minmax(0,1fr)_24rem]">
          <aside className="hidden min-h-0 flex-col border-r bg-card/85 p-4 backdrop-blur lg:flex">{queue}</aside>

          <main ref={mainRef} className="min-w-0 px-4 pt-5 pb-32 lg:overflow-y-auto lg:p-8">
            {item ? (
              <div className="flex flex-col gap-5">
                <div>
                  <p className="num text-sm text-muted-foreground">
                    {itemsLabel} · {judgeText.queue.position(itemIndex + 1, items.length)}
                  </p>
                  <h2 className="mt-1 text-2xl leading-tight font-semibold text-balance lg:text-4xl">{item.name}</h2>
                  {mode === 'criterion' && item.description && <p className="mt-2 max-w-3xl whitespace-pre-line text-muted-foreground">{item.description}</p>}
                  <p className="mt-4 text-sm font-medium text-muted-foreground">{linesLabel}</p>
                </div>

                <div className="grid gap-3 2xl:grid-cols-2">
                  {lines.map((l) => {
                    const crit = scaleOfLine(l) as Criterion
                    const row = rows[cellOf(l)]
                    const active = l.id === line?.id
                    return (
                      <section
                        key={l.id}
                        data-line={l.id}
                        aria-label={l.name}
                        onFocusCapture={() => setLineId(l.id)}
                        onPointerDownCapture={() => setLineId(l.id)}
                        className={cn(
                          'flex flex-col gap-3 rounded-xl border bg-card/95 p-4 shadow-xs transition-[border-color,box-shadow] duration-150 backdrop-blur-sm',
                          active && 'border-primary/50 ring-2 ring-primary/15',
                          row?.error && 'border-destructive/50',
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-base font-semibold lg:text-lg">{l.name}</h3>
                            <p className="num text-xs text-muted-foreground">
                              {judgeText.item.max(formatX100(crit.max_x100))} · {judgeText.item.step(formatX100(crit.step_x100))}
                              {mode === 'team' && ` · ${judgeText.item.weight((l as Criterion).weight)}`}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className={cn('num text-2xl leading-none font-semibold', row?.value_x100 == null && 'text-muted-foreground')}>
                              {row?.value_x100 == null ? '—' : formatX100(row.value_x100)}
                            </p>
                            {row?.dirty && !row.error && <p className="mt-1 text-xs text-warning">{judgeText.item.pendingMark}</p>}
                          </div>
                        </div>
                        <ScoreInput
                          key={cellOf(l)}
                          scale={crit}
                          value={row?.value_x100 ?? null}
                          disabled={readOnly}
                          label={judgeText.item.scoreOf(l.name)}
                          onChange={(v) => setValue(l, v)}
                        />
                        <div className="flex items-center justify-between gap-3">
                          {row?.error ? (
                            <p role="alert" className="text-sm text-destructive">
                              {judgeText.sync.error(row.error)}
                            </p>
                          ) : (
                            <span />
                          )}
                          {!readOnly && row?.value_x100 != null && (
                            <Button variant="ghost" size="sm" onClick={() => setValue(l, null)}>
                              <X />
                              {judgeText.item.clear}
                            </Button>
                          )}
                        </div>
                      </section>
                    )
                  })}
                </div>
              </div>
            ) : null}
          </main>

          <aside className="flex flex-col gap-6 border-t bg-card/85 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] backdrop-blur lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-5">
            {event.notes_enabled && item && (
              <div className="flex flex-col gap-2">
                <label htmlFor="judge-note" className="text-sm font-semibold">
                  {judgeText.notes.title}
                  <span className="ml-2 font-normal text-muted-foreground">{item.name}</span>
                </label>
                <Textarea
                  id="judge-note"
                  value={note}
                  disabled={readOnly || !hasScoreInItem}
                  placeholder={judgeText.notes.placeholder}
                  onChange={(e) => controller.setNote(item.id, e.target.value)}
                  maxLength={NOTE_MAX_CHARS}
                  className="min-h-28"
                />
                <p className="flex justify-between gap-3 text-xs text-muted-foreground">
                  <span>{hasScoreInItem ? judgeText.notes.autosave : judgeText.notes.needScore}</span>
                  {note.length >= NOTE_COUNTER_FROM && <span className="num shrink-0">{judgeText.notes.counter(note.length, NOTE_MAX_CHARS)}</span>}
                </p>
              </div>
            )}
            <Help mode={mode} item={item} entries={lines} activeLineId={line?.id} />
          </aside>
        </div>

        <nav
          aria-label={itemsLabel}
          className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t bg-card/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden"
        >
          <Button variant="outline" size="lg" className="h-12 flex-1" disabled={itemIndex === 0} onClick={() => goItem(-1)}>
            <ChevronLeft />
            {judgeText.nav.back}
          </Button>
          <Button variant="ghost" size="lg" className="num h-12 px-3" onClick={() => setQueueOpen(true)} aria-label={`${itemIndex + 1}/${items.length}, ${judgeText.queue.open.toLowerCase()}`}>
            <ListChecks />
            {itemIndex + 1}/{items.length}
          </Button>
          {isLast && canSubmit ? (
            <Button size="lg" className="h-12 flex-1" onClick={openSubmit}>
              <Send />
              {judgeText.submit.button}
            </Button>
          ) : (
            <Button size="lg" className="h-12 flex-1" disabled={isLast} onClick={() => goItem(1)}>
              {judgeText.nav.next}
              <ChevronRight />
            </Button>
          )}
        </nav>
      </div>

      <Dialog open={queueOpen} onOpenChange={setQueueOpen}>
        <DialogContent className="top-auto bottom-0 flex h-[85dvh] max-w-full translate-y-0 flex-col rounded-b-none sm:max-w-full lg:hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>{itemsLabel}</DialogTitle>
            <DialogDescription>{judgeText.queue.open}</DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col pr-7">{queue}</div>
        </DialogContent>
      </Dialog>

      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} session={session} rows={rows} controller={controller} onJump={jump} />
      <AlertModal alert={event.alert} open={alertOpen} onDismiss={dismissAlert} />
    </>
  )
}

function Help({
  mode,
  item,
  entries,
  activeLineId,
}: {
  mode: 'team' | 'criterion'
  item: Item | undefined
  entries: Item[]
  activeLineId: string | undefined
}) {
  // Team mode: what the item is + what each applicable criterion means. Criterion mode: who the teams are.
  const described = entries.filter((e) => e.description)
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">{judgeText.help.title}</h2>
      {mode === 'team' && item?.description && (
        <div className="rounded-lg border bg-card/95 p-3">
          <p className="text-xs font-medium text-muted-foreground">{judgeText.help.teamTitle}</p>
          <p className="mt-1 text-sm whitespace-pre-line">{item.description}</p>
        </div>
      )}
      {described.length === 0 && !(mode === 'team' && item?.description) && <p className="text-sm text-muted-foreground">{judgeText.help.empty}</p>}
      <ul className="flex flex-col gap-2">
        {described.map((e) => (
          <li key={e.id} className={cn('rounded-lg border bg-card/95 p-3 transition-colors', e.id === activeLineId && 'border-primary/50')}>
            <p className="text-sm font-medium">{e.name}</p>
            <p className="mt-1 text-sm whitespace-pre-line text-muted-foreground">{e.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
