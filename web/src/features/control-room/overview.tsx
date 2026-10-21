import { useQuery } from '@tanstack/react-query'
import { Check, ExternalLink, Minus, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { eventsApi } from '@/api/endpoints'
import type { JudgeSummary, Visibility } from '@/api/types'
import { CopyField } from '@/components/copy-field'
import { EmptyState, ErrorState } from '@/components/state-views'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { useEventMutation, useFull, useNow } from './context'
import { cellState, computeKpis, formatAgo, type CellState } from './lib'

const CELL_STYLE: Record<CellState | 'unassigned' | 'conflict', string> = {
  unassigned: 'border border-dashed bg-transparent text-muted-foreground/50',
  conflict: 'bg-destructive/10 text-destructive',
  submitted: 'bg-success-soft text-success',
  partial: 'bg-warning-soft text-warning',
  empty: 'bg-muted text-muted-foreground',
  attention: 'bg-destructive/15 text-destructive',
}

export function Overview() {
  const { event } = useFull()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {event.status === 'draft' ? <Readiness /> : <Monitoring />}
      <PublicBoard />
    </div>
  )
}

function Readiness() {
  const { teams, criteria, judges } = useFull()
  const items = [
    { label: cr.overview.ready.teams, count: teams.length, to: 'setup' },
    { label: cr.overview.ready.criteria, count: criteria.length, to: 'setup' },
    { label: cr.overview.ready.judges, count: judges.filter((j) => j.is_active).length, to: 'judges' },
  ]
  return (
    <section aria-labelledby="ready-h" className="rounded-xl border bg-card p-5">
      <h2 id="ready-h" className="text-base font-semibold">
        {cr.overview.readinessTitle}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{cr.overview.readinessText}</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-3">
        {items.map((i) => (
          <li key={i.label} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              {i.count > 0 ? <Check className="size-4 text-success" aria-hidden /> : <Minus className="size-4 text-muted-foreground" aria-hidden />}
              {i.label}
              <span className="num font-mono text-muted-foreground">{i.count}</span>
            </span>
            {i.count === 0 && (
              <Button asChild size="sm" variant="outline">
                <Link to={i.to}>{cr.overview.fill}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Monitoring() {
  const { event, assignments } = useFull()
  const hasAssignments = assignments.length > 0
  const matrix = useQuery({ queryKey: ['cr', event.id, 'matrix'], queryFn: () => eventsApi.matrix(event.id) })

  if (matrix.isPending) return <Skeleton className="h-72 rounded-xl" />
  if (matrix.isError) return <ErrorState message={errorText(matrix.error)} onRetry={() => void matrix.refetch()} />
  const m = matrix.data
  const k = computeKpis(m)
  const tiles = [
    { label: cr.overview.kpiTeams, value: `${k.teamsWithScores}/${k.teamsTotal}` },
    { label: cr.overview.kpiJudges, value: `${k.judgesSubmitted}/${k.judgesActive}` },
    { label: cr.overview.kpiAttention, value: String(k.attention), hint: cr.overview.attentionHint, warn: k.attention > 0 },
    { label: cr.overview.kpiCoverage, value: `${k.coveragePct}%` },
  ]

  return (
    <>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t.label}</dt>
            <dd className={cn('num mt-1 font-mono text-2xl font-medium', t.warn && 'text-destructive')}>{t.value}</dd>
            {t.hint && <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{t.hint}</p>}
          </div>
        ))}
      </dl>
      <section aria-labelledby="matrix-h">
        <h2 id="matrix-h" className="mb-3 text-base font-semibold">
          {cr.overview.matrixTitle}
        </h2>
        {m.judges.length === 0 || m.teams.length === 0 ? (
          <EmptyState title={cr.overview.matrixTitle} text={cr.overview.matrixEmpty} />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="sticky left-0 z-10 min-w-40 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                      {cr.overview.judgeCol}
                    </th>
                    {m.teams.map((t) => (
                      <th key={t.id} scope="col" className="px-1 py-2 text-xs font-medium text-muted-foreground">
                        <span className="mx-auto block max-w-20 truncate" title={t.name}>
                          {t.name}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {m.judges.map((j) => (
                    <tr key={j.id} className="border-t">
                      <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                        <JudgeCell judge={j} />
                      </th>
                      {m.teams.map((t) => {
                        const cell = m.cells.find((c) => c.judge_id === j.id && c.team_id === t.id)
                        const scored = cell?.scored ?? 0
                        const total = cell?.total ?? 0
                        // A conflict wins over an assignment; with assignments present, a team without one is outside the judge's set.
                        const kind = cell?.conflict ? 'conflict' : hasAssignments && !cell?.assigned ? 'unassigned' : cellState(j, scored, total)
                        const title = kind === 'conflict' ? cr.overview.cellConflict(j.name, t.name) : kind === 'unassigned' ? cr.overview.cellNotAssigned(j.name, t.name) : cr.overview.cellTitle(j.name, t.name, scored, total)
                        return (
                          <td key={t.id} className="p-1">
                            <div title={title} className={cn('num mx-auto flex h-9 min-w-12 items-center justify-center rounded-md font-mono text-xs', CELL_STYLE[kind])}>
                              {kind === 'conflict' ? <ShieldAlert className="size-4" aria-label={title} /> : kind === 'unassigned' ? <span aria-label={title}>—</span> : `${scored}/${total}`}
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
              {(Object.keys(cr.overview.legend) as CellState[]).map((s) => (
                <li key={s} className="flex items-center gap-1.5">
                  <span className={cn('size-3 rounded-sm', CELL_STYLE[s])} aria-hidden />
                  {cr.overview.legend[s]}
                </li>
              ))}
              {hasAssignments && (
                <li className="flex items-center gap-1.5">
                  <span className={cn('size-3 rounded-sm', CELL_STYLE.unassigned)} aria-hidden />
                  {cr.overview.legendNotAssigned}
                </li>
              )}
              {m.cells.some((c) => c.conflict) && (
                <li className="flex items-center gap-1.5">
                  <span className={cn('size-3 rounded-sm', CELL_STYLE.conflict)} aria-hidden />
                  {cr.overview.legendConflict}
                </li>
              )}
            </ul>
          </>
        )}
      </section>
    </>
  )
}

function JudgeCell({ judge }: { judge: JudgeSummary }) {
  const now = useNow()
  return (
    <div className="min-w-0">
      <p className="max-w-44 truncate font-medium" title={judge.name}>
        {judge.name}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {judge.last_seen_at == null ? cr.overview.neverSeen : cr.overview.lastSeen(formatAgo(judge.last_seen_at, now))}
        {judge.pending_count > 0 && <span className="ml-1.5 font-medium text-destructive">· {cr.overview.pending(judge.pending_count)}</span>}
      </p>
    </div>
  )
}

function PublicBoard() {
  const { event } = useFull()
  const save = useEventMutation((visibility: Visibility) => eventsApi.update(event.id, { visibility }), cr.overview.saved)
  const url = `${window.location.origin}/live/${event.id}`
  const draft = event.status === 'draft'
  return (
    <section aria-labelledby="pub-h" className="grid gap-4 rounded-xl border bg-card p-5">
      <div>
        <h2 id="pub-h" className="text-base font-semibold">
          {cr.overview.publicTitle}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{draft ? cr.overview.publicDraft : cr.overview.publicText}</p>
      </div>
      {!draft && (
        <div className="flex gap-2">
          <CopyField value={url} label={cr.overview.publicLink} className="min-w-0 flex-1" />
          <Button variant="outline" size="icon" asChild>
            <a href={url} target="_blank" rel="noreferrer" aria-label={cr.header.live}>
              <ExternalLink />
            </a>
          </Button>
        </div>
      )}
      <div className="grid gap-1.5">
        <label id="vis-l" className="text-sm font-medium">
          {cr.overview.visibilityLabel}
        </label>
        <Select value={event.visibility} onValueChange={(v) => save.mutate(v as Visibility)} disabled={save.isPending}>
          <SelectTrigger aria-labelledby="vis-l" className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(cr.overview.visibility) as Visibility[]).map((v) => (
              <SelectItem key={v} value={v}>
                {cr.overview.visibility[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {cr.overview.visibilityHelp[event.visibility]} {cr.overview.visibilityNote}
        </p>
      </div>
    </section>
  )
}
