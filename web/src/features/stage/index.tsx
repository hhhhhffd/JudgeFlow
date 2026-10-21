// Projector / OBS screen (/stage/:eventId): official ranking revealed place by place (SPEC §11).
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { WifiOff } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ApiError, openStream, publicApi } from '@/api'
import type { ChangeKind, StageResponse } from '@/api/types'
import { stageText } from '@/i18n/stage'
import { Backdrop } from '@/features/live/backdrop'
import { cn } from '@/lib/utils'
import './stage.css'
import { Hero, Leaderboard, Podium, SeenContext } from './views'

const REFETCH_DEBOUNCE_MS = 200
const PROBE_MS = 15_000
const SAFETY_REFRESH_MS = 30_000
const STAGE_KINDS: readonly ChangeKind[] = ['stage', 'status', 'event', 'composition']

/** Scales every rem on the page with the screen, so the same layout reads from the back of a hall and on a phone. */
function useScreenScale() {
  useEffect(() => {
    const root = document.documentElement
    const prev = root.style.fontSize
    root.style.fontSize = 'clamp(15px, min(1.05vw, 1.9vh), 44px)'
    return () => {
      root.style.fontSize = prev
    }
  }, [])
}

/** OBS browser sources composite the page over video, so every layer must be transparent. */
function useTransparentCanvas(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const els = [document.documentElement, document.body]
    const prev = els.map((el) => el.style.background)
    for (const el of els) el.style.background = 'transparent'
    return () => els.forEach((el, i) => (el.style.background = prev[i]!))
  }, [enabled])
}

export default function StageScreen() {
  const { eventId = '' } = useParams()
  const widget = useSearchParams()[0].get('widget') === '1'
  const client = useQueryClient()
  const key = ['stage', eventId]
  useScreenScale()
  useTransparentCanvas(widget)

  const query = useQuery({
    queryKey: key,
    queryFn: () => publicApi.stage(eventId),
    retry: (count, e) => !(e instanceof ApiError && (e.isNotFound || e.status === 400)) && count < 2,
    // Not found (draft) probes until it opens; otherwise a slow poll backs up the stream.
    refetchInterval: (q) => (q.state.data ? SAFETY_REFRESH_MS : PROBE_MS),
  })
  const hasData = query.data !== undefined

  useEffect(() => {
    if (!hasData) return
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void client.invalidateQueries({ queryKey: ['stage', eventId] }), REFETCH_DEBOUNCE_MS)
    }
    const stop = openStream(publicApi.streamUrl(eventId), {
      onChange: (kind) => STAGE_KINDS.includes(kind) && refresh(),
      onOpen: ({ reconnect }) => reconnect && refresh(),
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [eventId, hasData, client])

  const title = query.data?.event.title
  useEffect(() => {
    document.title = title ? `${title} — ${stageText.title}` : stageText.title
  }, [title])

  const frame = (children: React.ReactNode, backdrop?: StageResponse['event']) => (
    <div className={cn('stage-root relative min-h-dvh', widget && 'stage-widget')}>
      {!widget && <Backdrop url={backdrop?.background_url ?? null} overlay={backdrop?.overlay ?? { enabled: false, color: '#000000', opacity: 0 }} />}
      {!widget && <div aria-hidden className="pointer-events-none fixed inset-0 z-[1] bg-[radial-gradient(120%_70%_at_50%_0%,oklch(0.32_0.09_262/0.55),transparent_65%)]" />}
      <main className="relative z-10 flex min-h-dvh flex-col p-[max(4vmin,1rem)]">{children}</main>
    </div>
  )

  if (query.isPending) {
    return widget ? null : frame(<p role="status" className="m-auto text-[1.5rem] text-muted-foreground">{stageText.loading}</p>)
  }
  if (!query.data) {
    if (widget) return null
    const notFound = query.error instanceof ApiError && query.error.isNotFound
    return frame(
      <Hero
        title={notFound ? stageText.notFound.title : stageText.error.title}
        text={notFound ? stageText.notFound.text : (query.error instanceof Error ? query.error.message : '')}
      />,
    )
  }

  return frame(<StageBoard data={query.data} widget={widget} offline={query.isError} />, query.data.event)
}

function StageBoard({ data, widget, offline }: { data: StageResponse; widget: boolean; offline: boolean }) {
  const { event, stage, rows } = data
  const [seen] = useState(() => new Set(stage.view === 'waiting' ? [] : rows.map((r) => r.team_id)))
  // Rows of one track only; the server resolves a missing stage track to the first group.
  const trackName = data.tracks.length > 0 ? (data.tracks.find((t) => t.id === (stage.track_id ?? rows[0]?.track_id)) ?? data.tracks[0])?.name : undefined
  const teamsLabel = event.teams_label_enabled && event.teams_label?.trim() ? event.teams_label.trim() : stageText.team

  let body: React.ReactNode
  if (!stage.available) body = widget ? null : <Hero title={event.title} text={stageText.soon.text} eyebrow={stageText.soon.title} />
  else if (stage.view === 'waiting' || (stage.view === 'leaderboard' && rows.length === 0))
    body = widget ? null : <Hero title={event.title} text={stageText.waiting.text} eyebrow={stageText.waiting.title} />
  else if (stage.view === 'podium') body = <Podium data={data} teamsLabel={teamsLabel} />
  else body = <Leaderboard data={data} teamsLabel={teamsLabel} />

  const showHeader = !widget && stage.available && (stage.view === 'podium' || (stage.view === 'leaderboard' && rows.length > 0))

  return (
    <SeenContext.Provider value={seen}>
      {showHeader && (
        <header className="mb-[2.5vmin] flex flex-col gap-2">
          <p className="text-[1rem] font-semibold tracking-[0.28em] text-signal uppercase">{stageText.eyebrow}</p>
          <h1 className="text-[clamp(1.8rem,3.4vw,3.4rem)] leading-[1.05] font-extrabold tracking-tight text-balance">{event.title}</h1>
          {trackName && <p className="text-[clamp(1.2rem,2vw,2rem)] font-semibold text-signal">{trackName}</p>}
        </header>
      )}
      {body}
      {offline && !widget && (
        <p role="status" className="fixed right-4 bottom-4 z-20 inline-flex items-center gap-2 rounded-full border bg-card/90 px-4 py-2 text-[0.95rem] text-muted-foreground backdrop-blur">
          <WifiOff className="size-4" aria-hidden />
          {stageText.offline}
        </p>
      )}
    </SeenContext.Provider>
  )
}
