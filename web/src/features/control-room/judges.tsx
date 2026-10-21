import { useState } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal, Printer } from 'lucide-react'
import { eventsApi } from '@/api/endpoints'
import type { JudgeSummary, JudgeWithLink } from '@/api/types'
import { CopyField } from '@/components/copy-field'
import { QrCode } from '@/components/qr-code'
import { EmptyState } from '@/components/state-views'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { ConfirmDialog } from './confirm-dialog'
import { useEventMutation, useFull, useNow } from './context'
import { Distribution } from './distribution'
import { formatAgo, judgeTotal, parseNames } from './lib'
import { SheetImport } from './sheet-import'
import { pairSet } from '@/lib/tracks'

type Action = { kind: 'rename' | 'rotate' | 'reopen' | 'delete'; judge: JudgeSummary }

export function JudgesSection() {
  const { event, judges, teams, criteria, assignments, conflicts } = useFull()
  const frozen = event.status === 'finalized' || event.status === 'published'
  const [links, setLinks] = useState<JudgeWithLink[] | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const assigned = pairSet(assignments)
  const conflictSet = pairSet(conflicts)
  const now = useNow()
  const toggle = useEventMutation((j: JudgeSummary) => eventsApi.updateJudge(j.id, { is_active: !j.is_active }))

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {frozen && (
        <p role="status" className="rounded-xl border bg-muted/50 p-4 text-sm text-muted-foreground">
          {cr.judges.frozen}
        </p>
      )}
      <AddJudges disabled={frozen} onCreated={setLinks} />
      <section aria-labelledby="judges-h">
        <h2 id="judges-h" className="mb-3 text-base font-semibold">
          {cr.judges.title} <span className="num font-mono text-muted-foreground">{judges.length}</span>
        </h2>
        {judges.length === 0 ? (
          <EmptyState title={cr.judges.empty} text={cr.judges.emptyText} />
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {judges.map((j) => {
              const total = judgeTotal(j.id, teams, criteria, assigned, conflictSet)
              return (
              <li key={j.id} className="flex items-center gap-3 p-3 pl-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="max-w-full truncate font-medium" title={j.name}>
                      {j.name}
                    </p>
                    <JudgeStatus judge={j} />
                    {j.pending_count > 0 && <Badge variant="destructive">{cr.overview.pending(j.pending_count)}</Badge>}
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <div
                      role="progressbar"
                      aria-label={cr.judges.progress(j.scored_count, total)}
                      aria-valuemin={0}
                      aria-valuemax={total}
                      aria-valuenow={j.scored_count}
                      className="h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-muted"
                    >
                      <div className="h-full bg-primary" style={{ width: `${total === 0 ? 0 : Math.min(100, (j.scored_count / total) * 100)}%` }} />
                    </div>
                    <span className="num font-mono text-xs text-muted-foreground">{cr.judges.progress(j.scored_count, total)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cr.judges.lastSeen}: {j.last_seen_at == null ? cr.overview.neverSeen : formatAgo(j.last_seen_at, now)}
                  </p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" disabled={frozen} aria-label={`${cr.judges.actions}: ${j.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setAction({ kind: 'rename', judge: j })}>{cr.judges.rename}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setAction({ kind: 'rotate', judge: j })}>{cr.judges.rotate}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => toggle.mutate(j)}>{j.is_active ? cr.judges.deactivate : cr.judges.activate}</DropdownMenuItem>
                    {j.submitted_at != null && <DropdownMenuItem onSelect={() => setAction({ kind: 'reopen', judge: j })}>{cr.judges.reopen}</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setAction({ kind: 'delete', judge: j })}>
                      {cr.judges.delete}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
              )
            })}
          </ul>
        )}
      </section>
      <Distribution />
      <SheetImport />
      {links && <LinksDialog links={links} onClose={() => setLinks(null)} />}
      {action && <JudgeActionDialog action={action} onClose={() => setAction(null)} onLink={(l) => setLinks([l])} />}
    </div>
  )
}

function JudgeStatus({ judge }: { judge: JudgeSummary }) {
  if (!judge.is_active) return <Badge variant="secondary">{cr.judges.status.inactive}</Badge>
  if (judge.submitted_at != null) return <Badge variant="success">{cr.judges.status.submitted}</Badge>
  if (judge.scored_count > 0) return <Badge variant="warning">{cr.judges.status.progress}</Badge>
  return <Badge variant="outline">{cr.judges.status.none}</Badge>
}

function AddJudges({ disabled, onCreated }: { disabled: boolean; onCreated: (l: JudgeWithLink[]) => void }) {
  const { event } = useFull()
  const [text, setText] = useState('')
  const names = parseNames(text)
  const add = useEventMutation((n: string[]) => eventsApi.addJudges(event.id, n))
  return (
    <section aria-labelledby="add-h" className="rounded-xl border bg-card p-5">
      <h2 id="add-h" className="text-base font-semibold">
        {cr.judges.addTitle}
      </h2>
      <form
        className="mt-3 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          add.mutate(names, {
            onSuccess: (created) => {
              setText('')
              onCreated(created)
            },
          })
        }}
      >
        <Label htmlFor="judge-names" className="font-normal text-muted-foreground">
          {cr.judges.addText}
        </Label>
        <Textarea id="judge-names" rows={3} disabled={disabled} placeholder={cr.judges.addPlaceholder} value={text} onChange={(e) => setText(e.target.value)} />
        <div>
          <Button type="submit" disabled={disabled || names.length === 0 || add.isPending}>
            {cr.judges.addSubmit(names.length)}
          </Button>
        </div>
      </form>
    </section>
  )
}

function LinksDialog({ links, onClose }: { links: JudgeWithLink[]; onClose: () => void }) {
  const { event } = useFull()
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{cr.judges.linksTitle}</DialogTitle>
          <DialogDescription>{cr.judges.linksText}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-3">
          {links.map(({ judge, link }) => (
            <li key={judge.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
              <QrCode value={link} size={112} />
              <div className="min-w-0 flex-1">
                <p className="mb-1.5 truncate font-medium">{judge.name}</p>
                <CopyField value={link} label={cr.judges.linkLabel(judge.name)} />
              </div>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => window.print()}>
            <Printer />
            {cr.judges.print}
          </Button>
          <Button onClick={onClose}>{cr.judges.done}</Button>
        </DialogFooter>
        <PrintSheet title={event.title} links={links} />
      </DialogContent>
    </Dialog>
  )
}

/** Printed cards live in a body-level portal; everything else on the page is hidden in print. */
function PrintSheet({ title, links }: { title: string; links: JudgeWithLink[] }) {
  return createPortal(
    <div className="judge-print-root hidden bg-white p-6 text-black print:block">
      <style>{`@media print { body > *:not(.judge-print-root) { display: none !important; } .judge-print-card { break-inside: avoid; } }`}</style>
      <h1 className="mb-1 text-xl font-semibold">{title}</h1>
      <p className="mb-4 text-sm">{cr.judges.printHeading}</p>
      <div className="grid grid-cols-2 gap-4">
        {links.map(({ judge, link }) => (
          <div key={judge.id} className="judge-print-card flex flex-col items-center gap-2 rounded-lg border border-black p-4 text-center">
            <p className="text-lg font-semibold break-words">{judge.name}</p>
            <QrCode value={link} size={180} />
            <p className="text-xs">{cr.judges.printHint}</p>
            <p className="font-mono text-[10px] break-all">{link}</p>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  )
}

function JudgeActionDialog({ action, onClose, onLink }: { action: Action; onClose: () => void; onLink: (l: JudgeWithLink) => void }) {
  const { judge } = action
  const rename = useEventMutation((name: string) => eventsApi.updateJudge(judge.id, { name }))
  const rotate = useEventMutation(() => eventsApi.rotateJudge(judge.id))
  const reopen = useEventMutation((reason: string) => eventsApi.reopenJudge(judge.id, reason))
  const remove = useEventMutation(() => eventsApi.removeJudge(judge.id))

  if (action.kind === 'rename') return <RenameDialog name={judge.name} pending={rename.isPending} error={rename.isError ? errorText(rename.error) : null} onClose={onClose} onSave={(n) => rename.mutate(n, { onSuccess: onClose })} />

  const common = { open: true, onOpenChange: (o: boolean) => !o && onClose() }
  if (action.kind === 'rotate')
    return (
      <ConfirmDialog {...common} title={cr.judges.rotateTitle(judge.name)} description={cr.judges.rotateText} confirmLabel={cr.judges.rotate} pending={rotate.isPending} error={rotate.isError ? errorText(rotate.error) : null}
        onConfirm={() => rotate.mutate(undefined, { onSuccess: (l) => (onClose(), onLink(l)) })} />
    )
  if (action.kind === 'reopen')
    return (
      <ConfirmDialog {...common} title={cr.judges.reopenTitle(judge.name)} description={cr.judges.reopenText} confirmLabel={cr.judges.reopen} reasonLabel={ru.common.reason} pending={reopen.isPending} error={reopen.isError ? errorText(reopen.error) : null}
        onConfirm={(reason) => reopen.mutate(reason, { onSuccess: onClose })} />
    )
  return (
    <ConfirmDialog {...common} title={cr.judges.deleteTitle(judge.name)} description={cr.judges.deleteText} confirmLabel={cr.judges.delete} destructive pending={remove.isPending} error={remove.isError ? errorText(remove.error) : null}
      onConfirm={() => remove.mutate(undefined, { onSuccess: onClose })} />
  )
}

function RenameDialog({ name, pending, error, onClose, onSave }: { name: string; pending: boolean; error: string | null; onClose: () => void; onSave: (n: string) => void }) {
  const [value, setValue] = useState(name)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form className="grid gap-4" onSubmit={(e) => (e.preventDefault(), onSave(value.trim()))}>
          <DialogHeader>
            <DialogTitle>{cr.judges.rename}</DialogTitle>
            <DialogDescription className="sr-only">{cr.judges.renameTitle}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="judge-rename">{cr.judges.renameTitle}</Label>
            <Input id="judge-rename" required autoFocus maxLength={120} value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>{ru.common.cancel}</Button>
            <Button type="submit" disabled={!value.trim() || pending}>{ru.common.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
