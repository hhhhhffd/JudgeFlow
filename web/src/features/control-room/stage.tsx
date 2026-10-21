import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronsRight, ExternalLink, Play, RotateCcw } from 'lucide-react'
import { eventsApi } from '@/api/endpoints'
import { publicApi } from '@/api'
import type { StageAction, StageView } from '@/api/types'
import { CopyField } from '@/components/copy-field'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useEventMutation, useFull } from './context'

const VIEWS: StageView[] = ['waiting', 'leaderboard', 'podium']
const TOP_N = Array.from({ length: 10 }, (_, i) => i + 1)
const STAGE_W = 1920
const STAGE_H = 1080

/** Interactive elements keep Space/arrows for themselves (a focused button must not fire twice). */
function ownsKey(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, select, button, a, [role="combobox"], [role="listbox"], [role="dialog"]') !== null)
}

export function StageTab() {
  const { event, tracks } = useFull()
  const t = cr.stage
  const available = event.status === 'finalized' || event.status === 'published'
  const state = useQuery({ queryKey: ['cr', event.id, 'stage'], queryFn: () => publicApi.stage(event.id), enabled: available })
  const total = state.data?.stage.total_groups ?? 0
  const revealed = state.data?.stage.revealed ?? event.stage_revealed

  const reveal = useEventMutation((action: StageAction) => eventsApi.revealStage(event.id, action))
  const update = useEventMutation((body: { stage_view?: StageView; stage_top_n?: number; stage_track_id?: string | null }) => eventsApi.update(event.id, body))

  const canNext = available && revealed < total && !reveal.isPending
  const canPrev = available && revealed > 0 && !reveal.isPending
  const run = (action: StageAction) => reveal.mutate(action)

  // Latest handlers for the keyboard listener, so it is bound once.
  const keys = useRef({ canNext, canPrev, run })
  useEffect(() => {
    keys.current = { canNext, canPrev, run }
  })
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || ownsKey(e.target)) return
      const k = keys.current
      if (e.key === ' ' || e.key === 'ArrowRight') {
        e.preventDefault()
        if (k.canNext) k.run('next')
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        if (k.canPrev) k.run('prev')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const stageUrl = `${origin}/stage/${event.id}`

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="grid content-start gap-6">
        <section aria-labelledby="stage-h" className="grid gap-3 rounded-xl border bg-card p-5">
          <div>
            <h2 id="stage-h" className="text-base font-semibold">{t.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t.text}</p>
          </div>
          <h3 className="text-sm font-medium">{t.flowTitle}</h3>
          <ol className="grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
            {t.flow.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </section>

        {!available ? (
          <section role="status" className="rounded-xl border border-dashed bg-card p-5">
            <h2 className="text-base font-semibold">{t.unavailableTitle}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t.unavailableText}</p>
            <p className="mt-2 text-sm">{t.unavailableStatus(ru.status[event.status])}</p>
          </section>
        ) : (
          <>
            <section aria-label={t.viewLabel} className="grid gap-4 rounded-xl border bg-card p-5">
              <div className="grid gap-2">
                <p id="stage-view-l" className="text-sm font-medium">{t.viewLabel}</p>
                <div role="group" aria-labelledby="stage-view-l" className="inline-flex w-fit rounded-lg border bg-background p-0.5">
                  {VIEWS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={event.stage_view === v}
                      disabled={update.isPending}
                      onClick={() => event.stage_view !== v && update.mutate({ stage_view: v })}
                      className={cn(
                        'h-9 rounded-md px-3 text-sm font-medium text-muted-foreground transition-[color,background-color,transform] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] disabled:opacity-60',
                        event.stage_view === v && 'bg-primary text-primary-foreground',
                      )}
                    >
                      {t.views[v]}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">{t.viewHelp[event.stage_view]}</p>
              </div>
              <div className="grid gap-2">
                <p id="stage-topn-l" className="text-sm font-medium">{t.topNLabel}</p>
                <Select value={String(event.stage_top_n)} onValueChange={(v) => update.mutate({ stage_top_n: Number(v) })} disabled={update.isPending}>
                  <SelectTrigger aria-labelledby="stage-topn-l" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOP_N.map((n) => (
                      <SelectItem key={n} value={String(n)}>{t.topN(n)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">{t.topNNote}</p>
              </div>
              {tracks.length > 0 && (
                <div className="grid gap-2">
                  <p id="stage-track-l" className="text-sm font-medium">{t.trackLabel}</p>
                  {/* null on the server means the first group, so the first track is the visible default. */}
                  <Select value={event.stage_track_id ?? tracks[0]!.id} onValueChange={(v) => update.mutate({ stage_track_id: v })} disabled={update.isPending}>
                    <SelectTrigger aria-labelledby="stage-track-l" className="w-full sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tracks.map((tr) => (
                        <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-muted-foreground">{t.trackNote}</p>
                </div>
              )}
            </section>

            <section aria-labelledby="stage-reveal-h" className="grid gap-3 rounded-xl border bg-card p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h2 id="stage-reveal-h" className="text-base font-semibold">{t.revealTitle}</h2>
                <p role="status" className="num text-sm text-muted-foreground">{state.isPending ? '…' : t.progress(revealed, total)}</p>
              </div>
              {state.isError && <p className="text-sm text-destructive">{errorText(state.error)}</p>}
              {state.data && total === 0 && <p className="text-sm text-muted-foreground">{t.noGroups}</p>}
              <Button size="lg" disabled={!canNext} onClick={() => run('next')}>
                <Play />
                {t.next}
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={!canPrev} onClick={() => run('prev')}>
                  <ChevronLeft />
                  {t.prev}
                </Button>
                <Button variant="outline" disabled={!canPrev} onClick={() => run('reset')}>
                  <RotateCcw />
                  {t.reset}
                </Button>
                <Button variant="outline" className="col-span-2" disabled={!canNext} onClick={() => run('all')}>
                  <ChevronsRight />
                  {t.all}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{t.hotkeys}</p>
            </section>
          </>
        )}

        <section aria-label={t.linkLabel} className="grid gap-3 rounded-xl border bg-card p-5">
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">{t.linkLabel}</p>
            <CopyField value={stageUrl} label={t.linkLabel} />
            <p className="text-sm text-muted-foreground">{t.linkHint}</p>
          </div>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">{t.widgetLabel}</p>
            <CopyField value={`${stageUrl}?widget=1`} label={t.widgetLabel} />
            <p className="text-sm text-muted-foreground">{t.widgetHint}</p>
          </div>
          <Button variant="outline" asChild className="w-fit">
            <a href={`/stage/${event.id}`} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t.open}
            </a>
          </Button>
        </section>
      </div>

      <section aria-label={t.previewTitle} className="min-w-0 content-start">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{t.previewTitle}</h2>
        <StagePreview eventId={event.id} />
      </section>
    </div>
  )
}

/** The real stage page in a 1920x1080 iframe scaled to the column width, so the preview cannot drift from the output. */
function StagePreview({ eventId }: { eventId: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setScale(el.clientWidth / STAGE_W)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return (
    <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-xl border bg-black">
      {scale === 0 ? (
        <Skeleton className="absolute inset-0 rounded-none" />
      ) : (
        <iframe
          title={cr.stage.previewFrame}
          src={`/stage/${eventId}`}
          tabIndex={-1}
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
        />
      )}
    </div>
  )
}
