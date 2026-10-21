import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ClipboardPaste, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { eventsApi } from '@/api/endpoints'
import type { Criterion, ScoringMode, Team, UpdateEventRequest } from '@/api/types'
import { EmptyState } from '@/components/state-views'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { formatX100, parseX100 } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from './confirm-dialog'
import { useEventMutation, useFull, useIsDraft } from './context'
import { moveItem, parseTeamsPaste } from './lib'

export function Setup() {
  const draft = useIsDraft()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {!draft && (
        <div role="status" className="flex gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
          <Lock className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="font-medium">{cr.setup.lockedTitle}</p>
            <p className="mt-0.5 text-muted-foreground">{cr.setup.lockedText}</p>
          </div>
        </div>
      )}
      <BasicsCard />
      <RulesCard />
      <TeamsCard />
      <CriteriaCard />
    </div>
  )
}

function Card({ title, hint, action, children }: { title: string; hint?: string; action?: ReactNode; children: ReactNode }) {
  const id = `card-${title}`
  return (
    <section aria-labelledby={id} className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
        </div>
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function toLocalInput(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function BasicsCard() {
  const { event } = useFull()
  const [title, setTitle] = useState(event.title)
  const [description, setDescription] = useState(event.description)
  const [startsAt, setStartsAt] = useState(toLocalInput(event.starts_at))
  const [location, setLocation] = useState(event.location ?? '')
  const save = useEventMutation((body: UpdateEventRequest) => eventsApi.update(event.id, body), cr.setup.saved)

  return (
    <Card title={cr.setup.basics}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({
            title: title.trim(),
            description: description.trim(),
            starts_at: startsAt ? new Date(startsAt).getTime() : null,
            location: location.trim() || null,
          })
        }}
      >
        <Field label={cr.setup.titleLabel} htmlFor="b-title">
          <Input id="b-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={cr.setup.descriptionLabel} htmlFor="b-desc">
          <Textarea id="b-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={cr.setup.startsAtLabel} htmlFor="b-start">
            <Input id="b-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label={cr.setup.locationLabel} htmlFor="b-loc">
            <Input id="b-loc" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={!title.trim() || save.isPending}>
            {ru.common.save}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function RulesCard() {
  const { event } = useFull()
  const draft = useIsDraft()
  const [mode, setMode] = useState<ScoringMode>(event.scoring_mode)
  const [notes, setNotes] = useState(event.notes_enabled)
  const [quorum, setQuorum] = useState(String(event.quorum))
  const [teamsLabel, setTeamsLabel] = useState(event.teams_label ?? '')
  const [teamsOn, setTeamsOn] = useState(event.teams_label_enabled)
  const [critLabel, setCritLabel] = useState(event.criteria_label ?? '')
  const [critOn, setCritOn] = useState(event.criteria_label_enabled)
  const save = useEventMutation((body: UpdateEventRequest) => eventsApi.update(event.id, body), cr.setup.saved)
  const quorumNum = Number(quorum)
  const valid = Number.isInteger(quorumNum) && quorumNum >= 1

  return (
    <Card title={cr.setup.rules}>
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate({
            // Mode and notes are draft-only; sending them later would be rejected.
            ...(draft ? { scoring_mode: mode, notes_enabled: notes } : {}),
            quorum: quorumNum,
            teams_label: teamsLabel.trim() || null,
            teams_label_enabled: teamsOn,
            criteria_label: critLabel.trim() || null,
            criteria_label_enabled: critOn,
          })
        }}
      >
        <fieldset disabled={!draft} className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">{cr.setup.modeLabel}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['team', 'criterion'] as const).map((m) => (
              <label
                key={m}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-lg border p-3 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50 has-disabled:cursor-not-allowed has-disabled:opacity-70',
                  mode === m && 'border-primary bg-accent/50',
                )}
              >
                <input type="radio" name="mode" className="mt-1 accent-[var(--primary)]" checked={mode === m} onChange={() => setMode(m)} />
                <span>
                  <span className="block text-sm font-medium">{m === 'team' ? cr.setup.modeTeam : cr.setup.modeCriterion}</span>
                  <span className="block text-xs text-muted-foreground">{m === 'team' ? cr.setup.modeTeamHint : cr.setup.modeCriterionHint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-start gap-3">
          <Switch id="r-notes" checked={notes} onCheckedChange={setNotes} disabled={!draft} />
          <div>
            <Label htmlFor="r-notes">{cr.setup.notes}</Label>
            <p className="text-xs text-muted-foreground">{cr.setup.notesHint}</p>
          </div>
        </div>
        <Field label={cr.setup.quorumLabel} htmlFor="r-quorum" hint={cr.setup.quorumHint}>
          <Input id="r-quorum" inputMode="numeric" className="w-24" value={quorum} onChange={(e) => setQuorum(e.target.value)} aria-invalid={!valid} />
        </Field>
        <div className="grid gap-3">
          <div>
            <h3 className="text-sm font-medium">{cr.setup.labels}</h3>
            <p className="text-xs text-muted-foreground">{cr.setup.labelsHint}</p>
          </div>
          <LabelRow id="teams" toggle={cr.setup.teamsLabelToggle} label={cr.setup.teamsLabel} on={teamsOn} setOn={setTeamsOn} value={teamsLabel} setValue={setTeamsLabel} placeholder="Команды" />
          <LabelRow id="crit" toggle={cr.setup.criteriaLabelToggle} label={cr.setup.criteriaLabel} on={critOn} setOn={setCritOn} value={critLabel} setValue={setCritLabel} placeholder="Критерии" />
        </div>
        <div>
          <Button type="submit" disabled={!valid || save.isPending}>
            {ru.common.save}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function LabelRow(p: { id: string; toggle: string; label: string; on: boolean; setOn: (v: boolean) => void; value: string; setValue: (v: string) => void; placeholder: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[14rem_1fr] sm:items-center">
      <div className="flex items-center gap-3">
        <Switch id={`l-${p.id}-on`} checked={p.on} onCheckedChange={p.setOn} />
        <Label htmlFor={`l-${p.id}-on`}>{p.toggle}</Label>
      </div>
      <Input aria-label={p.label} placeholder={p.placeholder} disabled={!p.on} maxLength={60} value={p.value} onChange={(e) => p.setValue(e.target.value)} />
    </div>
  )
}

function RowButtons({ index, count, disabled, onMove, onEdit, onRemove, name }: { index: number; count: number; disabled: boolean; onMove: (d: number) => void; onEdit: () => void; onRemove: () => void; name: string }) {
  return (
    <div className="flex shrink-0 items-center">
      <Button variant="ghost" size="icon" disabled={disabled || index === 0} onClick={() => onMove(-1)} aria-label={`${cr.setup.moveUp}: ${name}`}>
        <ArrowUp />
      </Button>
      <Button variant="ghost" size="icon" disabled={disabled || index === count - 1} onClick={() => onMove(1)} aria-label={`${cr.setup.moveDown}: ${name}`}>
        <ArrowDown />
      </Button>
      <Button variant="ghost" size="icon" disabled={disabled} onClick={onEdit} aria-label={`${cr.setup.edit}: ${name}`}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon" disabled={disabled} onClick={onRemove} aria-label={`${cr.setup.remove}: ${name}`}>
        <Trash2 />
      </Button>
    </div>
  )
}

function TeamsCard() {
  const { event, teams } = useFull()
  const draft = useIsDraft()
  const [editing, setEditing] = useState<Team | 'new' | null>(null)
  const [pasting, setPasting] = useState(false)
  const [removing, setRemoving] = useState<Team | null>(null)
  const reorder = useEventMutation((ids: string[]) => eventsApi.reorderTeams(event.id, ids))
  const remove = useEventMutation((id: string) => eventsApi.removeTeam(id))

  return (
    <Card
      title={cr.setup.teams}
      action={
        <>
          <Button variant="outline" size="sm" disabled={!draft} onClick={() => setPasting(true)}>
            <ClipboardPaste />
            {cr.setup.pasteTeams}
          </Button>
          <Button size="sm" disabled={!draft} onClick={() => setEditing('new')}>
            <Plus />
            {cr.setup.addTeam}
          </Button>
        </>
      }
    >
      {teams.length === 0 ? (
        <EmptyState title={cr.setup.teamsEmpty} text={cr.setup.teamsEmptyText} />
      ) : (
        <ol className="divide-y rounded-lg border">
          {teams.map((t, i) => (
            <li key={t.id} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3">
              <span className="num w-6 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{t.name}</p>
                {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
              </div>
              <RowButtons
                index={i}
                count={teams.length}
                disabled={!draft}
                name={t.name}
                onMove={(d) => reorder.mutate(moveItem(teams, i, d).map((x) => x.id))}
                onEdit={() => setEditing(t)}
                onRemove={() => setRemoving(t)}
              />
            </li>
          ))}
        </ol>
      )}
      {editing && <TeamDialog team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {pasting && <PasteDialog onClose={() => setPasting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={cr.setup.removeTeamTitle(removing?.name ?? '')}
        description={cr.setup.removeText}
        confirmLabel={ru.common.delete}
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })}
      />
    </Card>
  )
}

function TeamDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const { event } = useFull()
  const [name, setName] = useState(team?.name ?? '')
  const [description, setDescription] = useState(team?.description ?? '')
  const save = useEventMutation((body: { name: string; description: string | null }) =>
    team ? eventsApi.updateTeam(team.id, body) : eventsApi.addTeam(event.id, body),
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate({ name: name.trim(), description: description.trim() || null }, { onSuccess: onClose })
          }}
        >
          <DialogHeader>
            <DialogTitle>{team ? cr.setup.editTeam : cr.setup.addTeam}</DialogTitle>
            <DialogDescription className="sr-only">{cr.setup.teams}</DialogDescription>
          </DialogHeader>
          <Field label={cr.setup.teamName} htmlFor="t-name">
            <Input id="t-name" required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={cr.setup.teamDescription} htmlFor="t-desc">
            <Textarea id="t-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {save.isError && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {ru.common.cancel}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {ru.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PasteDialog({ onClose }: { onClose: () => void }) {
  const { event } = useFull()
  const [text, setText] = useState('')
  const [clipboardError, setClipboardError] = useState(false)
  const rows = parseTeamsPaste(text)
  const bulk = useEventMutation((teams: typeof rows) => eventsApi.addTeamsBulk(event.id, teams))

  async function fromClipboard() {
    try {
      setText(await navigator.clipboard.readText())
      setClipboardError(false)
    } catch {
      // Needs a secure context and permission; manual paste into the field still works.
      setClipboardError(true)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            bulk.mutate(rows, { onSuccess: onClose })
          }}
        >
          <DialogHeader>
            <DialogTitle>{cr.setup.pasteTitle}</DialogTitle>
            <DialogDescription>{cr.setup.pasteText}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="paste-text">{cr.setup.teams}</Label>
              <Button type="button" variant="outline" size="sm" onClick={() => void fromClipboard()}>
                <ClipboardPaste />
                {cr.setup.pasteFromClipboard}
              </Button>
            </div>
            <Textarea id="paste-text" rows={6} autoFocus className="font-mono text-sm" placeholder={cr.setup.pastePlaceholder} value={text} onChange={(e) => setText(e.target.value)} />
            {clipboardError && <p role="alert" className="text-xs text-destructive">{cr.setup.pasteClipboardFailed}</p>}
          </div>
          <div aria-live="polite">
            <p className="text-sm font-medium">{rows.length > 0 ? cr.setup.pastePreview(rows.length) : cr.setup.pasteEmpty}</p>
            {rows.length > 0 && (
              <ol className="mt-2 max-h-40 divide-y overflow-y-auto rounded-lg border text-sm">
                {rows.map((r, i) => (
                  <li key={i} className="flex gap-3 px-3 py-1.5">
                    <span className="num w-5 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                    {r.description && <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.description}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {bulk.isError && <p role="alert" className="text-sm text-destructive">{errorText(bulk.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {ru.common.cancel}
            </Button>
            <Button type="submit" disabled={rows.length === 0 || bulk.isPending}>
              {cr.setup.pasteImport(rows.length)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CriteriaCard() {
  const { event, criteria } = useFull()
  const draft = useIsDraft()
  const [editing, setEditing] = useState<Criterion | 'new' | null>(null)
  const [removing, setRemoving] = useState<Criterion | null>(null)
  const reorder = useEventMutation((ids: string[]) => eventsApi.reorderCriteria(event.id, ids))
  const remove = useEventMutation((id: string) => eventsApi.removeCriterion(id))

  return (
    <Card
      title={cr.setup.criteria}
      action={
        <Button size="sm" disabled={!draft} onClick={() => setEditing('new')}>
          <Plus />
          {cr.setup.addCriterion}
        </Button>
      }
    >
      {criteria.length === 0 ? (
        <EmptyState title={cr.setup.criteriaEmpty} text={cr.setup.criteriaEmptyText} />
      ) : (
        <ol className="divide-y rounded-lg border">
          {criteria.map((c, i) => (
            <li key={c.id} className="flex items-center gap-3 py-1.5 pr-1.5 pl-3">
              <span className="num w-6 shrink-0 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="num truncate text-xs text-muted-foreground">{cr.setup.criterionSummary(formatX100(c.max_x100), formatX100(c.step_x100), c.weight)}</p>
              </div>
              <RowButtons
                index={i}
                count={criteria.length}
                disabled={!draft}
                name={c.name}
                onMove={(d) => reorder.mutate(moveItem(criteria, i, d).map((x) => x.id))}
                onEdit={() => setEditing(c)}
                onRemove={() => setRemoving(c)}
              />
            </li>
          ))}
        </ol>
      )}
      {editing && <CriterionDialog criterion={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={cr.setup.removeCriterionTitle(removing?.name ?? '')}
        description={cr.setup.removeText}
        confirmLabel={ru.common.delete}
        destructive
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id, { onSuccess: () => setRemoving(null) })}
      />
    </Card>
  )
}

function CriterionDialog({ criterion, onClose }: { criterion: Criterion | null; onClose: () => void }) {
  const { event } = useFull()
  const [name, setName] = useState(criterion?.name ?? '')
  const [description, setDescription] = useState(criterion?.description ?? '')
  const [max, setMax] = useState(criterion ? formatX100(criterion.max_x100) : '10')
  const [step, setStep] = useState(criterion ? formatX100(criterion.step_x100) : '1')
  const [weight, setWeight] = useState(String(criterion?.weight ?? 1))

  const maxX100 = parseX100(max)
  const stepX100 = parseX100(step)
  const weightNum = Number(weight)
  const valid =
    name.trim() !== '' &&
    maxX100 !== null && maxX100 > 0 &&
    stepX100 !== null && stepX100 > 0 &&
    maxX100 % stepX100 === 0 &&
    Number.isInteger(weightNum) && weightNum >= 1 && weightNum <= 1000

  const save = useEventMutation((body: { name: string; description: string | null; max_x100: number; step_x100: number; weight: number }) =>
    criterion ? eventsApi.updateCriterion(criterion.id, body) : eventsApi.addCriterion(event.id, body),
  )

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid) return
            save.mutate(
              { name: name.trim(), description: description.trim() || null, max_x100: maxX100, step_x100: stepX100, weight: weightNum },
              { onSuccess: onClose },
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{criterion ? cr.setup.editCriterion : cr.setup.addCriterion}</DialogTitle>
            <DialogDescription className="sr-only">{cr.setup.criteria}</DialogDescription>
          </DialogHeader>
          <Field label={cr.setup.criterionName} htmlFor="c-name">
            <Input id="c-name" required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={cr.setup.criterionDescription} htmlFor="c-desc">
            <Textarea id="c-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={cr.setup.criterionMax} htmlFor="c-max">
              <Input id="c-max" inputMode="decimal" className="num font-mono" value={max} onChange={(e) => setMax(e.target.value)} aria-invalid={maxX100 === null || maxX100 <= 0} />
            </Field>
            <Field label={cr.setup.criterionStep} htmlFor="c-step">
              <Input id="c-step" inputMode="decimal" className="num font-mono" value={step} onChange={(e) => setStep(e.target.value)} aria-invalid={stepX100 === null || stepX100 <= 0} />
            </Field>
            <Field label={cr.setup.criterionWeight} htmlFor="c-weight">
              <Input id="c-weight" inputMode="numeric" className="num font-mono" value={weight} onChange={(e) => setWeight(e.target.value)} />
            </Field>
          </div>
          <p className={cn('text-xs', valid ? 'text-muted-foreground' : 'text-destructive')}>{valid ? cr.setup.criterionWeightHint : cr.setup.criterionInvalid}</p>
          {save.isError && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {ru.common.cancel}
            </Button>
            <Button type="submit" disabled={!valid || save.isPending}>
              {ru.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
