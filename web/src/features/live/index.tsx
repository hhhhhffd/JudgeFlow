// Public live leaderboard (/live/:eventId): provisional totals or published results, updated over SSE.
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Hourglass, WifiOff } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { ApiError, openStream, publicApi } from '@/api'
import type { ChangeKind, PublicEvent, PublicRanking, PublicRankingRow } from '@/api/types'
import { ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { liveText } from '@/i18n/judge'
import { formatX100 } from '@/lib/format'
import { errorText } from '@/lib/errors'
import { boardColumns } from '@/lib/ranking'
import { criteriaOfGroup, groupByTrack } from '@/lib/tracks'
import { cn } from '@/lib/utils'
import { Backdrop } from './backdrop'

const REFETCH_DEBOUNCE_MS = 500
const PROBE_MS = 30_000
const FALLBACK_POLL_MS = 15_000

const LIVE_KINDS: readonly ChangeKind[] = ['scores', 'status', 'event', 'composition', 'stage']

export default function LiveBoard() {
  const { eventId = '' } = useParams()
  const client = useQueryClient()
  const key = ['public-event', eventId]
  const [streamOpen, setStreamOpen] = useState(false)
  const query = useQuery({
    queryKey: key,
    queryFn: () => publicApi.event(eventId),
    retry: (count, e) => !(e instanceof ApiError && (e.isNotFound || e.status === 400)) && count < 2,
    // A draft event is 404 until it opens; keep probing so the page comes alive on its own.
    // Without a live stream (rejected, proxy-buffered, offline) the board falls back to polling.
    refetchInterval: (q) => (q.state.data ? (streamOpen ? false : FALLBACK_POLL_MS) : PROBE_MS),
  })
  const hasData = query.data !== undefined

  useEffect(() => {
    if (!hasData) return
    let timer: number | undefined
    const stop = openStream(publicApi.streamUrl(eventId), {
      onChange: (kind) => {
        // presence/judges/alert hints never change the public board.
        if (!LIVE_KINDS.includes(kind)) return
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void client.invalidateQueries({ queryKey: ['public-event', eventId] }), REFETCH_DEBOUNCE_MS)
      },
      onOpen: ({ reconnect }) => {
        setStreamOpen(true)
        if (reconnect) void client.invalidateQueries({ queryKey: ['public-event', eventId] })
      },
      onError: (e) => {
        setStreamOpen(false)
        console.warn('live: stream error', e)
      },
    })
    return () => {
      window.clearTimeout(timer)
      stop()
    }
  }, [eventId, hasData, client])

  const title = query.data?.event.title
  useEffect(() => {
    document.title = title ?? liveText.title
  }, [title])

  if (query.isPending) {
    return (
      <main role="status" aria-label={liveText.loading} className="flex min-h-dvh flex-col gap-6 p-8">
        <Skeleton className="h-14 w-1/2" />
        <Skeleton className="h-64 w-full" />
      </main>
    )
  }
  if (!query.data) {
    const notFound = query.error instanceof ApiError && query.error.isNotFound
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        {notFound ? (
          <div className="max-w-lg text-center">
            <h1 className="text-3xl font-semibold">{liveText.notFound.title}</h1>
            <p className="mt-3 text-lg text-muted-foreground">{liveText.notFound.text}</p>
          </div>
        ) : (
          <ErrorState title={liveText.error.title} message={errorText(query.error)} onRetry={() => void query.refetch()} />
        )}
      </main>
    )
  }

  const { event, results } = query.data
  return (
    <>
      <Backdrop url={event.background_url} overlay={event.overlay} />
      <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[110rem] flex-col gap-8 px-4 py-6 sm:px-8 lg:px-12 lg:py-10">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            {results?.mode === 'provisional' && (
              <span className="inline-flex items-center gap-2 rounded-full bg-signal px-4 py-1.5 text-sm font-semibold tracking-wide text-signal-foreground uppercase sm:text-base">
                <Hourglass className="size-4" aria-hidden />
                {liveText.provisional.badge}
              </span>
            )}
            {results?.mode === 'official' && (
              <span className="inline-flex rounded-full bg-primary px-4 py-1.5 text-sm font-semibold tracking-wide text-primary-foreground uppercase sm:text-base">
                {liveText.published.badge}
              </span>
            )}
            {query.isError && (
              <span role="status" className="inline-flex items-center gap-2 rounded-full bg-card/85 px-3 py-1.5 text-sm text-muted-foreground backdrop-blur">
                <WifiOff className="size-4" aria-hidden />
                {liveText.connection.offline}
              </span>
            )}
          </div>
          <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl [overflow-wrap:anywhere] lg:text-7xl">{event.title}</h1>
          {event.description && <p className="max-w-4xl text-lg whitespace-pre-line [overflow-wrap:anywhere] text-foreground/75 lg:text-2xl">{event.description}</p>}
          {results?.mode === 'provisional' && <p className="max-w-4xl text-base text-foreground/75 lg:text-xl">{liveText.provisional.text}</p>}
        </header>

        {results === null || results.rows.length === 0 ? (
          <Placeholder hidden={results === null} />
        ) : (
          <Board event={event} results={results} />
        )}
      </main>
    </>
  )
}

function Placeholder({ hidden }: { hidden: boolean }) {
  const t = hidden ? liveText.hidden : liveText.waiting
  return (
    <section className="rounded-2xl border bg-card/85 p-8 backdrop-blur lg:p-14">
      <h2 className="text-2xl font-semibold lg:text-4xl">{t.title}</h2>
      <p className="mt-3 max-w-2xl text-lg text-muted-foreground lg:text-xl">{t.text}</p>
    </section>
  )
}

function Board({ event, results }: { event: PublicEvent; results: PublicRanking }) {
  const groups = groupByTrack(results.rows, results.tracks)
  const withHeadings = results.tracks.length > 0
  return (
    <>
      {groups.map((g) => (
        <section key={g.track?.id ?? 'none'} aria-label={withHeadings ? (g.track?.name ?? liveText.table.noTrack) : undefined} className="flex flex-col gap-8">
          {withHeadings && <h2 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere] lg:text-5xl">{g.track?.name ?? liveText.table.noTrack}</h2>}
          <GroupBoard event={event} rows={g.rows} quorum={results.quorum} criteria={criteriaOfGroup(event.criteria ?? [], g.track)} />
        </section>
      ))}
    </>
  )
}

function GroupBoard({ event, rows, quorum, criteria }: { event: PublicEvent; rows: PublicRankingRow[]; quorum: number; criteria: NonNullable<PublicEvent['criteria']> }) {
  const podium = rows.filter((r) => r.rank !== null).slice(0, 3)
  const columns = boardColumns(rows, criteria)
  const teamsHeading = event.teams_label_enabled && event.teams_label?.trim() ? event.teams_label.trim() : liveText.table.team

  return (
    <>
      {podium.length > 0 && (
        <ol aria-label={teamsHeading} className="flex flex-col gap-4 md:flex-row md:items-end md:justify-center">
          {podium.map((row, i) => (
            <PodiumCard key={row.team_id} row={row} index={i} />
          ))}
        </ol>
      )}

      <section className="overflow-hidden rounded-2xl border bg-card/90 backdrop-blur">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse md:min-w-[34rem] text-left">
            <thead>
              <tr className="border-b text-sm text-muted-foreground lg:text-base">
                <th scope="col" className="w-14 px-3 py-3 font-medium sm:w-24 sm:px-4 lg:px-6">
                  {liveText.table.rank}
                </th>
                <th scope="col" className="px-3 py-3 font-medium sm:px-4">
                  {teamsHeading}
                </th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="hidden px-4 py-3 text-right font-medium md:table-cell">
                    {c.label}
                  </th>
                ))}
                <th scope="col" className="px-3 py-3 text-right font-medium sm:px-4 lg:px-6">
                  {liveText.table.score}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.team_id} className="border-b last:border-b-0">
                  <td className="num px-3 py-4 text-xl font-semibold sm:px-4 sm:text-2xl lg:px-6 lg:text-4xl">
                    <RankMark row={row} />
                  </td>
                  <td className="min-w-0 px-3 py-4 sm:px-4">
                    <p className="text-lg font-medium [overflow-wrap:anywhere] sm:text-xl lg:text-3xl">{row.team_name}</p>
                    <RowNote row={row} quorum={quorum} />
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} className="num hidden px-4 py-4 text-right text-lg text-muted-foreground md:table-cell lg:text-2xl">
                      {c.value(row)}
                    </td>
                  ))}
                  <td className="num px-3 py-4 text-right font-mono text-xl font-semibold whitespace-nowrap sm:px-4 sm:text-2xl lg:px-6 lg:text-5xl">{formatX100(row.score_x100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function RankMark({ row }: { row: PublicRankingRow }) {
  if (row.rank === null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-baseline gap-1">
      {row.rank}
      {row.tie && (
        <>
          <span aria-hidden className="text-lg text-muted-foreground lg:text-2xl">
            =
          </span>
          <span className="sr-only">{liveText.table.tie}</span>
        </>
      )}
    </span>
  )
}

function RowNote({ row, quorum }: { row: PublicRankingRow; quorum: number }) {
  const parts: string[] = []
  if (row.score_x100 === null) parts.push(liveText.table.noScore)
  else if (!row.meets_quorum) parts.push(liveText.table.lowQuorum(quorum))
  if (row.tie) parts.push(liveText.table.tie)
  if (parts.length === 0) return null
  return <p className="mt-0.5 text-sm text-muted-foreground lg:text-lg">{parts.join(' · ')}</p>
}

const PODIUM_STYLE = [
  { order: 'md:order-2', height: 'md:min-h-80', tone: 'border-signal bg-signal/20' },
  { order: 'md:order-1', height: 'md:min-h-64', tone: 'bg-card/90' },
  { order: 'md:order-3', height: 'md:min-h-52', tone: 'bg-card/90' },
] as const

function PodiumCard({ row, index }: { row: PublicRankingRow; index: number }) {
  const s = PODIUM_STYLE[index]!
  return (
    <li className={cn('flex flex-col justify-between gap-6 rounded-2xl border p-6 backdrop-blur min-w-0 md:max-w-lg md:flex-1 lg:p-8', s.order, s.height, s.tone)}>
      <div className="min-w-0">
        <p className="num text-lg font-medium text-muted-foreground lg:text-2xl">
          {liveText.podium.place(row.rank ?? index + 1)}
          {row.tie && <span className="ml-2">· {liveText.table.tie}</span>}
        </p>
        <p className="mt-2 text-3xl leading-tight font-semibold text-balance [overflow-wrap:anywhere] lg:text-5xl">{row.team_name}</p>
      </div>
      <p className="num font-mono text-5xl font-semibold lg:text-7xl">{formatX100(row.score_x100)}</p>
    </li>
  )
}
