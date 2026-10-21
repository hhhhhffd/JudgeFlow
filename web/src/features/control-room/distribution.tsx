import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ShieldAlert, Users } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { eventsApi } from '@/api/endpoints'
import type { AutoAssignShortDetails, JudgeSummary } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { inJudgeSet, pairKey, pairSet } from '@/lib/tracks'
import { ConfirmDialog } from './confirm-dialog'
import { useEventMutation, useFull } from './context'
import { assignmentPairs, sameSet } from './lib'

/** Remounts the editor when the server copy changes, so a fresh state never mixes with stale local edits. */
export function Distribution() {
  const { event, judges, teams, assignments, conflicts } = useFull()
  const frozen = event.status === 'finalized' || event.status === 'published'
  const sig = JSON.stringify([assignments.map((p) => pairKey(p.judge_id, p.team_id)).sort(), conflicts.map((p) => pairKey(p.judge_id, p.team_id)).sort()])
  return (
    <Section>
      {judges.length === 0 || teams.length === 0 ? (
        <p className="text-sm text-muted-foreground">{cr.assign.noTeams}</p>
      ) : (
        <>
          {frozen && <p role="status" className="text-sm text-muted-foreground">{cr.assign.frozen}</p>}
          <AutoAssign disabled={frozen} hasAssignments={assignments.length > 0} />
          <DistributionEditor key={sig} />
        </>
      )}
    </Section>
  )
}

function DistributionEditor() {
  const { event, judges, teams, assignments, conflicts: serverConflicts } = useFull()
  const frozen = event.status === 'finalized' || event.status === 'published'
  const baseAssigned = pairSet(assignments)
  const baseConflicts = pairSet(serverConflicts)
  // No assignments at all means everyone judges everything: show that explicitly in the grid.
  const initialAssigned = () => (baseAssigned.size === 0 ? new Set(judges.flatMap((j) => teams.map((t) => pairKey(j.id, t.id)))) : baseAssigned)
  const [assigned, setAssigned] = useState(initialAssigned)
  const [conflicts, setConflicts] = useState(baseConflicts)

  const dirty = !sameSet(assigned, initialAssigned()) || !sameSet(conflicts, baseConflicts)
  const pairs = assignmentPairs(judges, teams, assigned)
  const allOff = pairs.length === 0 && assigned.size === 0 && judges.length > 0 && teams.length > 0
  const everyone = pairs.length === 0 && !allOff

  const inSet = (j: JudgeSummary, teamId: string) => inJudgeSet(j.id, teamId, everyone ? new Set() : assigned, conflicts)
  const loads = judges.map((j) => teams.filter((t) => inSet(j, t.id)).length)
  const idle = judges.filter((_, i) => loads[i] === 0)
  const uncovered = teams.filter((t) => !judges.some((j) => j.is_active && inSet(j, t.id)))

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }

  const save = useEventMutation(async () => {
    if (!sameSet(assigned, initialAssigned())) await eventsApi.putAssignments(event.id, pairs)
    if (!sameSet(conflicts, baseConflicts)) await eventsApi.putConflicts(event.id, [...conflicts].map((k) => ({ judge_id: k.split(':')[0]!, team_id: k.split(':')[1]! })))
  }, cr.assign.saved)

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{cr.assign.gridTitle}</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">{cr.assign.gridText}</p>
        </div>
        <Button variant="outline" size="sm" disabled={frozen || everyone} onClick={() => setAssigned(new Set(judges.flatMap((j) => teams.map((t) => pairKey(j.id, t.id)))))} title={cr.assign.everyoneHint}>
          <Users />
          {cr.assign.everyone}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 min-w-44 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                {cr.assign.judgeCol}
              </th>
              {teams.map((t) => (
                <th key={t.id} scope="col" className="px-1 py-2 text-xs font-medium text-muted-foreground">
                  <span className="mx-auto block max-w-20 truncate" title={t.name}>
                    {t.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {judges.map((j, ji) => (
              <tr key={j.id} className="border-t">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                  <p className={cn('max-w-44 truncate font-medium', !j.is_active && 'text-muted-foreground')} title={j.name}>
                    {j.name}
                  </p>
                  <p className={cn('num text-[11px]', loads[ji] === 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                    {loads[ji] === 0 ? cr.judges.loadNone : cr.judges.load(loads[ji]!, teams.length)}
                  </p>
                </th>
                {teams.map((t) => {
                  const key = pairKey(j.id, t.id)
                  const on = assigned.has(key)
                  const conflict = conflicts.has(key)
                  return (
                    <td key={t.id} className="p-1">
                      <div className="mx-auto flex w-10 flex-col items-center gap-0.5">
                        <button
                          type="button"
                          aria-pressed={on}
                          aria-label={cr.assign.assignToggle(j.name, t.name)}
                          disabled={frozen}
                          onClick={() => setAssigned((s) => toggle(s, key))}
                          className={cn(
                            'flex size-8 items-center justify-center rounded-md border transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60',
                            on ? 'border-primary bg-primary text-primary-foreground' : 'bg-muted text-transparent hover:text-muted-foreground',
                            conflict && 'opacity-40',
                          )}
                        >
                          <Check className="size-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-pressed={conflict}
                          aria-label={cr.assign.conflictToggle(j.name, t.name)}
                          title={cr.assign.conflictToggle(j.name, t.name)}
                          disabled={frozen}
                          onClick={() => setConflicts((s) => toggle(s, key))}
                          className={cn(
                            'flex h-5 w-8 items-center justify-center rounded transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60',
                            conflict ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground/40 hover:text-muted-foreground',
                          )}
                        >
                          <ShieldAlert className="size-3.5" aria-hidden />
                        </button>
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t">
              <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                {cr.assign.load}
              </th>
              {teams.map((t) => {
                const n = judges.filter((j) => inSet(j, t.id)).length
                return (
                  <td key={t.id} className={cn('num px-1 py-2 text-center font-mono text-xs', n === 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                    {cr.assign.teamsCol(n)}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5"><span className="flex size-4 items-center justify-center rounded border border-primary bg-primary text-primary-foreground"><Check className="size-3" aria-hidden /></span>{cr.assign.legendAssigned}</li>
        <li className="flex items-center gap-1.5"><span className="size-4 rounded border bg-muted" aria-hidden />{cr.assign.legendOff}</li>
        <li className="flex items-center gap-1.5"><ShieldAlert className="size-4 text-destructive" aria-hidden />{cr.assign.legendConflict}</li>
      </ul>

      <div aria-live="polite" className="grid gap-1 text-sm">
        {allOff && <p role="alert" className="text-destructive">{cr.assign.allOff}</p>}
        {!allOff && idle.length > 0 && <p className="text-warning">{cr.assign.zeroJudge(idle.map((j) => j.name).join(', '))}</p>}
        {!allOff && uncovered.length > 0 && <p className="text-warning">{cr.assign.zeroTeam(uncovered.map((t) => t.name).join(', '))}</p>}
        {dirty && <p className="text-muted-foreground">{cr.assign.dirty}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={frozen || !dirty || allOff || save.isPending} onClick={() => save.mutate()}>
          {cr.assign.save}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty}
          onClick={() => {
            setAssigned(initialAssigned())
            setConflicts(baseConflicts)
          }}
        >
          {cr.assign.revert}
        </Button>
      </div>
    </div>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  const { judges } = useFull()
  return (
    <section aria-labelledby="assign-h" className="grid gap-5 rounded-xl border bg-card p-5">
      <div>
        <h2 id="assign-h" className="text-base font-semibold">
          {cr.assign.title} <span className="num font-mono text-muted-foreground">{judges.length}</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{cr.assign.text}</p>
      </div>
      {children}
    </section>
  )
}

function AutoAssign({ disabled, hasAssignments }: { disabled: boolean; hasAssignments: boolean }) {
  const { event, judges } = useFull()
  const qc = useQueryClient()
  const [perTeam, setPerTeam] = useState('2')
  const [confirming, setConfirming] = useState(false)
  const [short, setShort] = useState<AutoAssignShortDetails['short'] | null>(null)
  const count = Number(perTeam)
  const valid = Number.isInteger(count) && count >= 1 && count <= Math.max(1, judges.length)

  const run = useMutation({
    mutationFn: (allowShort: boolean) => eventsApi.autoAssign(event.id, { judges_per_team: count, allow_short: allowShort }),
    onSuccess: () => {
      setShort(null)
      void qc.invalidateQueries({ queryKey: ['cr', event.id] })
      toast.success(cr.assign.autoDone)
    },
    onError: (e) => {
      const details = e instanceof ApiError && e.status === 409 ? (e.details as Partial<AutoAssignShortDetails> | undefined) : undefined
      if (details && Array.isArray(details.short)) setShort(details.short)
      else toast.error(errorText(e))
    },
  })

  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-sm font-semibold">{cr.assign.autoTitle}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{cr.assign.autoText}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (hasAssignments) setConfirming(true)
          else run.mutate(false)
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="auto-per-team">{cr.assign.perTeam}</Label>
          <Input id="auto-per-team" inputMode="numeric" className="num w-28 font-mono" disabled={disabled} value={perTeam} onChange={(e) => setPerTeam(e.target.value)} aria-invalid={!valid} />
        </div>
        <Button type="submit" variant="outline" disabled={disabled || !valid || run.isPending}>
          {cr.assign.autoRun}
        </Button>
      </form>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={cr.assign.autoReplaceTitle}
        description={cr.assign.autoReplaceText}
        confirmLabel={cr.assign.autoRun}
        pending={run.isPending}
        onConfirm={() => {
          setConfirming(false)
          run.mutate(false)
        }}
      />
      <ShortDialog short={short} perTeam={count} pending={run.isPending} onClose={() => setShort(null)} onConfirm={() => run.mutate(true)} />
    </div>
  )
}

function ShortDialog({ short, perTeam, pending, onClose, onConfirm }: { short: AutoAssignShortDetails['short'] | null; perTeam: number; pending: boolean; onClose: () => void; onConfirm: () => void }) {
  const { teams } = useFull()
  return (
    <Dialog open={short !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cr.assign.shortTitle}</DialogTitle>
          <DialogDescription>{cr.assign.shortText(perTeam)}</DialogDescription>
        </DialogHeader>
        <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border text-sm">
          {short?.map((s) => (
            <li key={s.team_id} className="num px-3 py-1.5">
              {cr.assign.shortItem(teams.find((t) => t.id === s.team_id)?.name ?? '—', s.got, perTeam)}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {ru.common.cancel}
          </Button>
          <Button disabled={pending} onClick={onConfirm}>
            {cr.assign.shortConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
