import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { eventsApi } from '@/api/endpoints'
import type { RankingRow, ScoringMode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { groupByTrack } from '@/lib/tracks'
import { cn } from '@/lib/utils'
import { useFull } from './context'
import { topTeamIds } from './lib'

const MODES: { value: ScoringMode; label: string; hint: string }[] = [
  { value: 'team', label: cr.setup.modeTeam, hint: cr.setup.modeTeamHint },
  { value: 'criterion', label: cr.setup.modeCriterion, hint: cr.setup.modeCriterionHint },
  { value: 'pairwise', label: cr.setup.modePairwise, hint: cr.setup.modePairwiseHint },
]

/** Creates the next round from the official ranking; opens the new event with the judges' fresh links. */
export function NextRoundDialog({ onClose }: { onClose: () => void }) {
  const { event } = useFull()
  const official = useQuery({ queryKey: ['cr', event.id, 'results', 'official'], queryFn: () => eventsApi.results(event.id, 'official') })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{cr.nextRound.title}</DialogTitle>
          <DialogDescription>{cr.nextRound.text}</DialogDescription>
        </DialogHeader>
        {official.isPending && <Skeleton className="h-64 rounded-xl" />}
        {official.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errorText(official.error)}
          </p>
        )}
        {official.data && <NextRoundForm rows={official.data.rows} tracks={official.data.tracks} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

function NextRoundForm({ rows, tracks, onClose }: { rows: RankingRow[]; tracks: { id: string; name: string }[]; onClose: () => void }) {
  const { event, teams } = useFull()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState(cr.nextRound.defaultTitle(event.title, event.round + 1))
  const [top, setTop] = useState('3')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(topTeamIds(rows, 3)))
  const [mode, setMode] = useState<ScoringMode>('team')
  const [copyCriteria, setCopyCriteria] = useState(true)
  const [copyJudges, setCopyJudges] = useState(true)
  const topNum = Number(top)
  const topValid = Number.isInteger(topNum) && topNum >= 1

  const create = useMutation({
    mutationFn: () =>
      eventsApi.nextRound(event.id, {
        title: title.trim(),
        // Keep the parent's team order regardless of the order of clicks.
        team_ids: teams.filter((t) => picked.has(t.id)).map((t) => t.id),
        scoring_mode: mode,
        copy_criteria: copyCriteria && mode !== 'pairwise',
        copy_judges: copyJudges,
      }),
    onSuccess: ({ event: next, links }) => {
      void qc.invalidateQueries({ queryKey: ['events'] })
      toast.success(cr.nextRound.created)
      onClose()
      // Tokens are shown once: hand them to the judges page of the new event.
      navigate(links.length > 0 ? `/events/${next.event.id}/judges` : `/events/${next.event.id}/setup`, { state: { links } })
    },
  })

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (!n.delete(id)) n.add(id)
      return n
    })
  const rowOf = new Map(rows.map((r) => [r.team_id, r]))
  const groups = groupByTrack(teams, tracks.length > 0 ? tracks : [])
  const tooFew = mode === 'pairwise' && picked.size < 2
  const valid = title.trim().length > 0 && picked.size > 0 && !tooFew

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="nr-title">{cr.nextRound.titleLabel}</Label>
        <Input id="nr-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{cr.nextRound.teams}</legend>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="nr-top">{cr.nextRound.topLabel}</Label>
            <Input id="nr-top" inputMode="numeric" className="w-24" value={top} onChange={(e) => setTop(e.target.value)} aria-invalid={!topValid} />
          </div>
          <Button type="button" variant="outline" disabled={!topValid} onClick={() => setPicked(new Set(topTeamIds(rows, topNum)))}>
            {cr.nextRound.topApply}
          </Button>
          <p className="num ml-auto text-sm text-muted-foreground" aria-live="polite">
            {cr.nextRound.selected(picked.size, teams.length)}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">{cr.nextRound.topHint}</p>
        <div className="grid max-h-64 gap-3 overflow-y-auto rounded-lg border p-2">
          {groups.map((g) => (
            <div key={g.track?.id ?? 'none'}>
              {tracks.length > 0 && <p className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{g.track?.name ?? cr.results.noTrack}</p>}
              <ul>
                {g.rows
                  .slice()
                  .sort((a, b) => (rowOf.get(a.id)?.rank ?? Infinity) - (rowOf.get(b.id)?.rank ?? Infinity))
                  .map((t) => {
                    const rank = rowOf.get(t.id)?.rank
                    return (
                      <li key={t.id}>
                        <label className="flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent/50 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50">
                          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
                          <span className="num w-14 shrink-0 font-mono text-sm text-muted-foreground">{rank ?? cr.nextRound.noRank}</span>
                          <span className="min-w-0 truncate" title={t.name}>
                            {t.name}
                          </span>
                        </label>
                      </li>
                    )
                  })}
              </ul>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{cr.nextRound.modeLabel}</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={cn('flex cursor-pointer gap-2 rounded-lg border p-3 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50', mode === m.value && 'border-primary bg-accent/50')}
            >
              <input type="radio" name="nr-mode" className="mt-1 accent-[var(--primary)]" checked={mode === m.value} onChange={() => setMode(m.value)} />
              <span>
                <span className="block text-sm font-medium">{m.label}</span>
                <span className="block text-xs text-muted-foreground">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {tooFew && <p className="text-sm text-warning">{cr.nextRound.pairwiseNeed}</p>}
      </fieldset>

      <div className="grid gap-3">
        {mode !== 'pairwise' && (
          <div className="flex items-start gap-3">
            <Switch id="nr-criteria" checked={copyCriteria} onCheckedChange={setCopyCriteria} />
            <div>
              <Label htmlFor="nr-criteria">{cr.nextRound.copyCriteria}</Label>
              <p className="text-xs text-muted-foreground">{cr.nextRound.copyCriteriaHint}</p>
            </div>
          </div>
        )}
        <div className="flex items-start gap-3">
          <Switch id="nr-judges" checked={copyJudges} onCheckedChange={setCopyJudges} />
          <div>
            <Label htmlFor="nr-judges">{cr.nextRound.copyJudges}</Label>
            <p className="text-xs text-muted-foreground">{cr.nextRound.copyJudgesHint}</p>
          </div>
        </div>
      </div>

      {create.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(create.error)}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {ru.common.cancel}
        </Button>
        <Button type="submit" disabled={!valid || create.isPending}>
          {create.isPending ? cr.nextRound.creating : cr.nextRound.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}
