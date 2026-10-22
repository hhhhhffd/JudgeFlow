// Pairwise Judge Desk (SPEC §13): two teams side by side, the judge picks the stronger one or a tie.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronLeft, ChevronRight, Lock, Send, Undo2, WifiOff } from 'lucide-react'
import { toast } from 'sonner'
import type { JudgeSession, Team, Winner } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Backdrop } from '@/features/live/backdrop'
import { judgeText } from '@/i18n/judge'
import { ru } from '@/i18n/ru'
import { cn } from '@/lib/utils'
import { AlertModal } from './alert-modal'
import { BackupAlert, BackupMenu, LockedRejectedNotice } from './backup'
import type { DeskController } from './controller'
import { HotkeysHelp, isTyping } from './hotkeys'
import {
  currentPair,
  decidedCount,
  errorComparisons,
  nextOpenAfter,
  openComparisons,
  pendingComparisons,
  sortedComparisons,
  winnerForKey,
} from './pairwise'
import { canRetry, readOnlyReason, syncIndicator } from './scoring'
import { getSeenAlertVersion, setSeenAlertVersion } from './storage'
import { CachedCopyNotice, SyncBadge } from './sync-badge'

const t = judgeText.pairwise

export function PairwiseDesk({ controller, session }: { controller: DeskController; session: JudgeSession }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { event } = session
  const teamsById = useMemo(() => new Map(session.teams.map((team) => [team.id, team])), [session.teams])
  const list = useMemo(() => sortedComparisons(state.comparisons), [state.comparisons])
  const [chosenId, setChosenId] = useState<string | undefined>()
  const [submitOpen, setSubmitOpen] = useState(false)
  const [seenAlert, setSeenAlert] = useState(() => getSeenAlertVersion(event.id))

  const pair = currentPair(list, chosenId)
  const index = pair ? list.indexOf(pair) : -1
  const open = openComparisons(state.comparisons).length
  const decided = decidedCount(state.comparisons)
  const reason = readOnlyReason(event.status, session.judge.submitted_at)
  const readOnly = reason !== null
  const pending = pendingComparisons(state.comparisons)
  const indicator = syncIndicator({
    online: state.online,
    syncing: state.syncing,
    pending,
    rejected: errorComparisons(state.comparisons).length,
    syncError: state.syncError,
  })
  const retryAllowed = canRetry(errorComparisons(state.comparisons).map((c) => c.error), event.status)
  const alertOpen = event.alert.enabled && event.alert.version > seenAlert

  function choose(winner: Winner) {
    if (!pair || readOnly) return
    controller.decide(pair.id, winner)
    setChosenId(nextOpenAfter(list, pair.id)?.id)
  }
  function undo() {
    if (pair && !readOnly) controller.decide(pair.id, null)
  }
  const go = (delta: -1 | 1) => {
    const target = list[index + delta]
    if (target) setChosenId(target.id)
  }

  useEffect(() => {
    if (submitOpen || alertOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || isTyping(e.target) || e.altKey) return
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (!readOnly) setSubmitOpen(true)
        return
      }
      if (e.ctrlKey || e.metaKey) return
      if (e.key === 'Backspace') {
        e.preventDefault()
        go(-1)
        return
      }
      const winner = winnerForKey(e.key)
      if (winner) {
        e.preventDefault()
        choose(winner)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  async function withdraw() {
    const outcome = await controller.unsubmit()
    if (outcome.ok) toast.success(judgeText.submit.withdrawn)
    else if (outcome.reason === 'error') toast.error(outcome.message)
  }

  const teamA = pair && teamsById.get(pair.team_a)
  const teamB = pair && teamsById.get(pair.team_b)

  return (
    <>
      <Backdrop url={event.background_url} overlay={event.overlay} />
      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-card/90 px-4 py-2.5 backdrop-blur">
          <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
            <h1 className="truncate text-base leading-tight font-semibold sm:text-lg">{event.title}</h1>
            <p className="truncate text-xs text-muted-foreground">{session.judge.name}</p>
          </div>
          <SyncBadge kind={indicator.kind} text={indicator.text} pending={pending} fromCache={state.fromCache} canRetry={retryAllowed} onRetry={() => controller.retryRejected()} />
          <BackupMenu controller={controller} />
          <HotkeysHelp rows={judgeText.hotkeys.pairwiseRows} />
          {session.judge.submitted_at !== null ? (
            <Badge variant="success" className="py-1">
              {judgeText.submit.submittedBanner}
            </Badge>
          ) : (
            !readOnly && (
              <Button size="sm" className="h-11 sm:h-8" onClick={() => setSubmitOpen(true)}>
                <Send />
                {judgeText.submit.button}
              </Button>
            )
          )}
        </header>

        <CachedCopyNotice fromCache={state.fromCache} />
        {indicator.kind === 'error' && !retryAllowed && <LockedRejectedNotice controller={controller} />}
        <BackupAlert controller={controller} errorKind={indicator.kind === 'error'} />
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

        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pt-5 pb-8 lg:pt-10">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
            <h2 className="text-2xl font-semibold text-balance lg:text-4xl">{t.question}</h2>
            <p className="num text-sm text-muted-foreground" aria-live="polite">
              {t.progress(decided)} · {t.reserve(open)}
            </p>
          </div>

          {pair ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:gap-5">
                <TeamCard letter="А" hotkey="←" team={teamA} selected={pair.winner === 'a'} dimmed={pair.winner === 'b'} disabled={readOnly} onPick={() => choose('a')} />
                <TeamCard letter="Б" hotkey="→" team={teamB} selected={pair.winner === 'b'} dimmed={pair.winner === 'a'} disabled={readOnly} onPick={() => choose('b')} />
              </div>
              <Button
                variant="outline"
                size="lg"
                disabled={readOnly}
                aria-pressed={pair.winner === 'tie'}
                onClick={() => choose('tie')}
                className={cn('h-14 w-full self-center text-base sm:w-80', pair.winner === 'tie' && 'border-primary bg-primary/10 text-primary')}
              >
                {t.tie}
                <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground lg:inline">↓</kbd>
              </Button>
              {pair.error && (
                <p role="alert" className="text-center text-sm text-destructive">
                  {judgeText.sync.error(pair.error)}
                </p>
              )}
              <nav className="flex items-center justify-between gap-2 border-t pt-4" aria-label={t.position(index + 1, list.length)}>
                <Button variant="ghost" onClick={() => go(-1)} disabled={index <= 0} aria-label={t.back}>
                  <ChevronLeft />
                  <span className="hidden sm:inline">{t.back}</span>
                </Button>
                <div className="flex items-center gap-3">
                  <span className="num text-sm text-muted-foreground">{t.position(index + 1, list.length)}</span>
                  {pair.winner !== null && !readOnly && (
                    <Button variant="outline" size="sm" onClick={undo}>
                      <Undo2 />
                      {t.undo}
                    </Button>
                  )}
                </div>
                <Button variant="ghost" onClick={() => go(1)} disabled={index >= list.length - 1} aria-label={t.forward}>
                  <span className="hidden sm:inline">{t.forward}</span>
                  <ChevronRight />
                </Button>
              </nav>
            </>
          ) : (
            <EmptyPairs
              online={state.online}
              reserving={state.reserving}
              exhausted={state.reserveExhausted}
              readOnly={readOnly}
              onMore={() => void controller.reserveMore()}
            />
          )}

          {pair && open === 0 && !readOnly && (
            <EmptyPairs online={state.online} reserving={state.reserving} exhausted={state.reserveExhausted} readOnly={false} onMore={() => void controller.reserveMore()} compact />
          )}
          {pair && open > 0 && !readOnly && state.online && (
            <Button variant="ghost" className="self-center" disabled={state.reserving} onClick={() => void controller.reserveMore()}>
              {state.reserving ? t.moreLoading : state.reserveExhausted ? t.recheck : t.moreButton}
            </Button>
          )}
        </main>
      </div>

      <PairwiseSubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} controller={controller} decided={decided} open_={open} />
      <AlertModal
        alert={event.alert}
        open={alertOpen}
        onDismiss={() => {
          setSeenAlertVersion(event.id, event.alert.version)
          setSeenAlert(event.alert.version)
        }}
      />
    </>
  )
}

function TeamCard({
  letter,
  hotkey,
  team,
  selected,
  dimmed,
  disabled,
  onPick,
}: {
  letter: string
  hotkey: string
  team: Team | undefined
  selected: boolean
  dimmed: boolean
  disabled: boolean
  onPick: () => void
}) {
  const name = team?.name ?? '—'
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        'group flex min-h-48 flex-col gap-3 rounded-2xl border bg-card/95 p-5 text-left shadow-xs backdrop-blur-sm transition-[border-color,background-color,box-shadow,transform,opacity] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 enabled:active:scale-[0.99] disabled:cursor-not-allowed lg:min-h-72 lg:p-8',
        'enabled:hover:border-primary/50',
        selected && 'border-primary bg-primary/5 ring-2 ring-primary/30',
        dimmed && 'opacity-60',
      )}
    >
      <span className="sr-only">{t.chooseLead}</span>
      <span aria-hidden className="flex items-center justify-between gap-3">
        <span className={cn('flex size-9 items-center justify-center rounded-full bg-secondary text-base font-semibold', selected && 'bg-primary text-primary-foreground')}>{letter}</span>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground lg:inline">{hotkey}</kbd>
      </span>
      <span className="text-2xl leading-tight font-semibold text-balance break-words lg:text-3xl">{name}</span>
      <span className={cn('text-sm whitespace-pre-line text-muted-foreground lg:text-base', !team?.description && 'italic')}>{team?.description || t.noDescription}</span>
    </button>
  )
}

function EmptyPairs({
  online,
  reserving,
  exhausted,
  readOnly,
  onMore,
  compact = false,
}: {
  online: boolean
  reserving: boolean
  exhausted: boolean
  readOnly: boolean
  onMore: () => void
  compact?: boolean
}) {
  if (readOnly) return null
  const body = !online ? t.exhaustedOffline : exhausted ? t.exhaustedAll : null
  return (
    <div
      role="status"
      className={cn('flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card/90 p-8 text-center', compact && 'p-5')}
    >
      {!online && <WifiOff className="size-6 text-muted-foreground" aria-hidden />}
      <p className="text-lg font-semibold">{body ? body.title : t.loadingPairs}</p>
      {body && <p className="max-w-md text-muted-foreground">{body.text}</p>}
      {online && (
        <Button variant="outline" disabled={reserving} onClick={onMore}>
          {reserving ? t.moreLoading : exhausted ? t.recheck : t.moreButton}
        </Button>
      )}
    </div>
  )
}

function PairwiseSubmitDialog({
  open,
  onOpenChange,
  controller,
  decided,
  open_,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  controller: DeskController
  decided: number
  open_: number
}) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [serverOpen, setServerOpen] = useState<number | null>(null)
  const remaining = serverOpen ?? open_

  function change(next: boolean) {
    if (!next) {
      setProblem(null)
      setServerOpen(null)
    }
    onOpenChange(next)
  }

  async function submit() {
    setBusy(true)
    setProblem(null)
    // With open pairs on screen the judge's choice is explicit: this is the release button.
    const outcome = await controller.submit(remaining > 0)
    setBusy(false)
    if (outcome.ok) return change(false)
    if (outcome.reason === 'pending') setProblem(`${judgeText.submit.pendingTitle}. ${judgeText.submit.pendingText}`)
    else if (outcome.reason === 'rejected') setProblem(`${judgeText.submit.rejectedTitle(outcome.count)}. ${judgeText.submit.rejectedText}`)
    else if (outcome.reason === 'open') setServerOpen(outcome.open)
    else if (outcome.reason === 'error') setProblem(outcome.message)
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.submit.title}</DialogTitle>
          <DialogDescription>{decided === 0 ? t.submit.noneDecided : `${t.submit.decided(decided)} ${t.submit.confirmText}`}</DialogDescription>
        </DialogHeader>
        {remaining > 0 && <p className="rounded-md bg-warning-soft p-3 text-sm text-warning">{t.submit.openText(remaining)}</p>}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)}>
            {remaining > 0 ? judgeText.submit.cancel : ru.common.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || decided === 0}>
            {busy ? judgeText.submit.sending : remaining > 0 ? t.submit.release : t.submit.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
