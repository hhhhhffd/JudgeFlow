import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { JudgeSession } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { ru } from '@/i18n/ru'
import type { DeskController } from './controller'
import { cellKey, errorRows, missingCells, pendingCount, type Rows } from './scoring'

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
  // Rejected rows of cells that left the sheet cannot be opened; the banner above the desk deals with them.
  const rejected = errorRows(rows)
  const rejectedCells = rejected.filter((r) => teams.some((t) => t.id === r.team_id) && criteria.some((c) => c.id === r.criterion_id))
  const rejectedGroups = byTeam
    ? teams.map((t) => ({ id: t.id, name: t.name, cells: rejectedCells.filter((m) => m.team_id === t.id) }))
    : criteria.map((c) => ({ id: c.id, name: c.name, cells: rejectedCells.filter((m) => m.criterion_id === c.id) }))
  const nameOf = (m: { team_id: string; criterion_id: string }) =>
    (byTeam ? criteria.find((c) => c.id === m.criterion_id) : teams.find((t) => t.id === m.team_id))?.name ?? ''

  function change(next: boolean) {
    if (!next) setProblem(null)
    onOpenChange(next)
  }

  function pick(m: { team_id: string; criterion_id: string }) {
    change(false)
    onJump(m.team_id, m.criterion_id)
  }

  async function submit() {
    setBusy(true)
    setProblem(null)
    const outcome = await controller.submit()
    setBusy(false)
    if (outcome.ok) return change(false)
    if (outcome.reason === 'pending') setProblem(`${judgeText.submit.pendingTitle}. ${judgeText.submit.pendingText}`)
    else if (outcome.reason === 'rejected') setProblem(judgeText.submit.rejectedTitle(outcome.count))
    else if (outcome.reason === 'missing') setProblem(judgeText.submit.missingTitle(outcome.missing.length))
    else if (outcome.reason === 'error') setProblem(outcome.message)
  }

  const pending = pendingCount(rows)
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{judgeText.submit.title}</DialogTitle>
          <DialogDescription>{missing.length > 0 ? judgeText.submit.missingText : rejected.length > 0 ? judgeText.submit.rejectedText : judgeText.submit.confirmText}</DialogDescription>
        </DialogHeader>

        {missing.length > 0 && (
          <CellGroups title={judgeText.submit.missingTitle(missing.length)} groups={groups} tone="warning" nameOf={nameOf} onPick={pick} />
        )}
        {rejected.length > 0 && (
          <div className="space-y-2">
            <CellGroups title={judgeText.submit.rejectedTitle(rejected.length)} groups={rejectedGroups} tone="destructive" nameOf={nameOf} onPick={pick} />
            {rejectedCells.length < rejected.length && <p className="text-sm text-muted-foreground">{judgeText.submit.rejectedOutside}</p>}
          </div>
        )}

        {missing.length === 0 && rejected.length === 0 && pending > 0 && <p className="text-sm text-warning">{judgeText.submit.pendingText}</p>}
        {problem && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)}>
            {missing.length > 0 || rejected.length > 0 ? judgeText.submit.cancel : ru.common.cancel}
          </Button>
          {missing.length === 0 && rejected.length === 0 && (
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? judgeText.submit.sending : judgeText.submit.confirm}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const TONE = {
  warning: 'border-warning/40 bg-warning-soft text-warning hover:bg-warning-soft/70',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15',
} as const

function CellGroups({
  title,
  groups,
  tone,
  nameOf,
  onPick,
}: {
  title: string
  groups: { id: string; name: string; cells: { team_id: string; criterion_id: string }[] }[]
  tone: keyof typeof TONE
  nameOf: (m: { team_id: string; criterion_id: string }) => string
  onPick: (m: { team_id: string; criterion_id: string }) => void
}) {
  return (
    <div className="max-h-[40dvh] space-y-3 overflow-y-auto">
      <p className="font-medium">{title}</p>
      {groups
        .filter((g) => g.cells.length > 0)
        .map((g) => (
          <div key={g.id} className="space-y-1.5">
            <p className="text-sm font-medium">{g.name}</p>
            <div className="flex flex-wrap gap-1.5">
              {g.cells.map((m) => (
                <button
                  key={cellKey(m.team_id, m.criterion_id)}
                  type="button"
                  onClick={() => onPick(m)}
                  className={`min-h-11 rounded-md border px-2.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 ${TONE[tone]}`}
                >
                  {nameOf(m)}
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  )
}
