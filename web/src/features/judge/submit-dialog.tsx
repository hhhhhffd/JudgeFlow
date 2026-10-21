import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { JudgeSession } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { ru } from '@/i18n/ru'
import type { DeskController } from './controller'
import { missingCells, pendingCount, type Rows } from './scoring'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  session: JudgeSession
  rows: Rows
  controller: DeskController
  onJump: (teamId: string, criterionId: string) => void
}

export function SubmitDialog({ open, onOpenChange, session, rows, controller, onJump }: Props) {
  const { teams, criteria } = session
  const byTeam = session.event.scoring_mode === 'team'
  const missing = missingCells(teams, criteria, rows)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const groups = byTeam
    ? teams.map((t) => ({ id: t.id, name: t.name, cells: missing.filter((m) => m.team_id === t.id) }))
    : criteria.map((c) => ({ id: c.id, name: c.name, cells: missing.filter((m) => m.criterion_id === c.id) }))
  const nameOf = (m: { team_id: string; criterion_id: string }) =>
    (byTeam ? criteria.find((c) => c.id === m.criterion_id) : teams.find((t) => t.id === m.team_id))?.name ?? ''

  function change(next: boolean) {
    if (!next) setProblem(null)
    onOpenChange(next)
  }

  async function submit() {
    setBusy(true)
    setProblem(null)
    const outcome = await controller.submit()
    setBusy(false)
    if (outcome.ok) return change(false)
    if (outcome.reason === 'pending') setProblem(`${judgeText.submit.pendingTitle}. ${judgeText.submit.pendingText}`)
    else if (outcome.reason === 'missing') setProblem(judgeText.submit.missingTitle(outcome.missing.length))
    else setProblem(outcome.message)
  }

  const pending = pendingCount(rows)
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{judgeText.submit.title}</DialogTitle>
          <DialogDescription>{missing.length > 0 ? judgeText.submit.missingText : judgeText.submit.confirmText}</DialogDescription>
        </DialogHeader>

        {missing.length > 0 && (
          <div className="max-h-[50dvh] space-y-3 overflow-y-auto">
            <p className="font-medium">{judgeText.submit.missingTitle(missing.length)}</p>
            {groups
              .filter((g) => g.cells.length > 0)
              .map((g) => (
                <div key={g.id} className="space-y-1.5">
                  <p className="text-sm font-medium">{g.name}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {g.cells.map((m) => (
                      <button
                        key={`${m.team_id}:${m.criterion_id}`}
                        type="button"
                        onClick={() => {
                          change(false)
                          onJump(m.team_id, m.criterion_id)
                        }}
                        className="min-h-9 rounded-md border border-warning/40 bg-warning-soft px-2.5 text-sm text-warning transition-colors outline-none hover:bg-warning-soft/70 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {nameOf(m)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        {missing.length === 0 && pending > 0 && <p className="text-sm text-warning">{judgeText.submit.pendingText}</p>}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)}>
            {missing.length > 0 ? judgeText.submit.cancel : ru.common.cancel}
          </Button>
          {missing.length === 0 && (
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? judgeText.submit.sending : judgeText.submit.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
