import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Download, Info, Layers } from 'lucide-react'
import { eventsApi } from '@/api/endpoints'
import type { Criterion, RankingMode, RankingRow, Track } from '@/api/types'
import { EmptyState, ErrorState } from '@/components/state-views'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { formatDateTime, formatX100 } from '@/lib/format'
import { cn } from '@/lib/utils'
import { criteriaOfGroup, groupByTrack } from '@/lib/tracks'
import { RECORD_COLUMNS } from '@/lib/ranking'
import { useFull } from './context'
import { NextRoundDialog } from './next-round'

export function Results() {
  const { event, criteria } = useFull()
  const pairwise = event.scoring_mode === 'pairwise'
  const [nextOpen, setNextOpen] = useState(false)
  const settled = event.status === 'finalized' || event.status === 'published'
  const [picked, setPicked] = useState<RankingMode | null>(null)
  const mode = picked ?? (settled ? 'official' : 'provisional')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const results = useQuery({ queryKey: ['cr', event.id, 'results', mode], queryFn: () => eventsApi.results(event.id, mode) })

  const tracks = results.data?.tracks ?? []
  const groups = groupByTrack(results.data?.rows ?? [], tracks)
  const heading = (track: Track | null) => track?.name ?? cr.results.noTrack

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div role="group" aria-label={cr.results.title} className="inline-flex rounded-lg border bg-card p-0.5">
          {(['provisional', 'official'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setPicked(m)}
              className={cn(
                'h-9 rounded-md px-4 text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                mode === m && 'bg-primary text-primary-foreground',
              )}
            >
              {m === 'provisional' ? cr.results.modeProvisional : cr.results.modeOfficial}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {settled && (
            <Button onClick={() => setNextOpen(true)}>
              <Layers />
              {cr.results.nextRound}
            </Button>
          )}
          <Button variant="outline" asChild>
            <a href={eventsApi.exportCsvUrl(event.id)} download>
              <Download />
              {cr.results.export}
            </a>
          </Button>
        </div>
      </div>
      {nextOpen && <NextRoundDialog onClose={() => setNextOpen(false)} />}
      <p className="text-sm text-muted-foreground">
        {mode === 'official' ? cr.results.modeHelpOfficial : cr.results.modeHelpProvisional}{' '}
        {results.data?.snapshot && mode === 'official' && cr.results.snapshot(formatDateTime(results.data.snapshot.created_at))}
      </p>

      {results.isPending && <Skeleton className="h-72 rounded-xl" />}
      {results.isError && <ErrorState message={errorText(results.error)} onRetry={() => void results.refetch()} />}
      {results.data && results.data.rows.every((r) => r.score_x100 == null) && <EmptyState title={cr.results.empty} text={cr.results.emptyText} />}
      {results.data && results.data.rows.some((r) => r.score_x100 != null) && (
        <>
          {groups.map((g) => (
            <section key={g.track?.id ?? 'none'} aria-label={heading(g.track)} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
              {tracks.length > 0 && <h2 className="text-base font-semibold">{heading(g.track)}</h2>}
              <ResultsTable rows={g.rows} criteria={pairwise ? [] : criteriaOfGroup(criteria, g.track)} pairwise={pairwise} open={open} toggle={toggle} />
            </section>
          ))}
          <p className="text-xs text-muted-foreground">
            {cr.results.quorumNote(results.data.quorum)} {tracks.length > 0 && cr.results.trackNote}{' '}
            <span className="rounded bg-signal px-1 text-[11px] font-semibold text-signal-foreground">=</span> {cr.results.tiesNote}{' '}
            {results.data.rows.some((r) => r.raw_score_x100 != null) && cr.results.normalizedNote}
          </p>
        </>
      )}
    </div>
  )
}

function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`${label}: ${text}`} className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 text-pretty">{text}</TooltipContent>
    </Tooltip>
  )
}

function ResultsTable({ rows, criteria, pairwise, open, toggle }: { rows: RankingRow[]; criteria: Criterion[]; pairwise: boolean; open: Set<string>; toggle: (id: string) => void }) {
  const normalized = rows.some((r) => r.raw_score_x100 != null)
  const extra = pairwise ? RECORD_COLUMNS.length : criteria.length
  return (
    <div className="max-w-full min-w-0 rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead className="w-16">{cr.results.rank}</TableHead>
            <TableHead>{cr.results.team}</TableHead>
            <TableHead className="text-right">
              <span className="inline-flex items-center justify-end gap-1">
                {pairwise ? cr.results.pairwiseScore : cr.results.score}
                {pairwise && <InfoTip label={cr.results.pairwiseScore} text={cr.results.pairwiseScoreHint} />}
                {normalized && <InfoTip label={cr.results.rawScore} text={cr.results.rawScoreHint} />}
              </span>
            </TableHead>
            <TableHead className="text-right">{pairwise ? cr.results.comparisons : cr.results.sheets}</TableHead>
            {pairwise &&
              RECORD_COLUMNS.map((c) => (
                <TableHead key={c.key} className="text-right">
                  {c.label}
                </TableHead>
              ))}
            {criteria.map((c) => (
              <TableHead key={c.id} className="hidden text-right xl:table-cell">
                <span className="ml-auto block max-w-24 truncate" title={c.name}>
                  {c.name}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const expanded = open.has(row.team_id)
            const name = row.team_name
            return (
              <Fragment key={row.team_id}>
                <TableRow>
                  <TableCell className="p-1">
                    <Button variant="ghost" size="icon" aria-expanded={expanded} aria-label={`${expanded ? cr.results.collapse : cr.results.expand}: ${name}`} onClick={() => toggle(row.team_id)}>
                      {expanded ? <ChevronDown /> : <ChevronRight />}
                    </Button>
                  </TableCell>
                  <TableCell className="num font-mono">
                    {row.rank ?? '—'}
                    {row.tie && (
                      <span role="img" title={cr.results.tie} aria-label={cr.results.tie} className="ml-1 inline-block rounded bg-signal px-1 text-[11px] font-semibold text-signal-foreground">
                        =
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-48 font-medium">
                    <span className="block [overflow-wrap:anywhere] whitespace-normal" title={name}>{name}</span>
                    <span className="mt-0.5 block">
                      {row.score_x100 == null ? (
                        <span className="text-xs font-normal text-muted-foreground">{cr.results.noScore}</span>
                      ) : (
                        !row.meets_quorum && <Badge variant="warning">{cr.results.quorumNo}</Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="num text-right font-mono text-base font-medium">
                    {formatX100(row.score_x100)}
                    {row.raw_score_x100 != null && (
                      <span className="block text-xs font-normal text-muted-foreground" title={cr.results.rawScoreHint}>
                        {cr.results.rawScore}: {formatX100(row.raw_score_x100)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="num text-right font-mono">{row.sheets}</TableCell>
                  {pairwise &&
                    RECORD_COLUMNS.map((c) => (
                      <TableCell key={c.key} className="num text-right font-mono">
                        {row[c.key] ?? 0}
                      </TableCell>
                    ))}
                  {criteria.map((c) => (
                    <TableCell key={c.id} className="num hidden text-right font-mono xl:table-cell">
                      {formatX100(row.criteria.find((a) => a.criterion_id === c.id)?.avg_x100)}
                    </TableCell>
                  ))}
                </TableRow>
                {expanded && (
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell />
                    <TableCell colSpan={4 + extra} className="whitespace-normal">
                      <div className="grid gap-4 py-1 sm:grid-cols-2">
                        {!pairwise && <Breakdown title={cr.results.byCriteria} empty={cr.results.noJudges} items={criteria.map((c) => ({ key: c.id, label: c.name, value: row.criteria.find((a) => a.criterion_id === c.id)?.avg_x100 ?? null }))} />}
                        <Breakdown title={pairwise ? cr.results.byJudgesPairwise : cr.results.byJudges} empty={cr.results.noJudges} items={row.judges.map((j) => ({ key: j.judge_id, label: j.judge_name, value: j.score_x100 }))} />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function Breakdown({ title, items, empty }: { title: string; items: { key: string; label: string; value: number | null }[]; empty: string }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {items.map((i) => (
            <li key={i.key} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">{i.label}</span>
              <span className="num font-mono">{formatX100(i.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
