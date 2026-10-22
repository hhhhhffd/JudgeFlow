import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronDown, ChevronRight, MapPin, Plus } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { eventsApi } from '@/api/endpoints'
import type { EventListItem } from '@/api/types'
import { PageContainer } from '@/components/admin-layout'
import { EmptyState, ErrorState } from '@/components/state-views'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { CRITERIA_TEMPLATES } from '@/features/control-room/templates'
import { cr } from '@/i18n/control-room'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'

export default function EventsPage() {
  const [creating, setCreating] = useState(false)
  const events = useQuery({ queryKey: ['events'], queryFn: eventsApi.list })

  const createButton = (
    <Button onClick={() => setCreating(true)}>
      <Plus />
      {ru.events.create}
    </Button>
  )

  return (
    <PageContainer>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{ru.events.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{ru.events.subtitle}</p>
        </div>
        {events.data && events.data.length > 0 && createButton}
      </div>

      {events.isPending && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      )}
      {events.isError && <ErrorState title={ru.events.loadFailed} message={errorText(events.error)} onRetry={() => void events.refetch()} />}
      {events.data?.length === 0 && <EmptyState title={ru.events.emptyTitle} text={ru.events.emptyText} action={createButton} />}
      {events.data && events.data.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groupRounds(events.data).map(({ root, rounds }) => (
            <li key={root.id} className="flex flex-col gap-2">
              <EventCard event={root} />
              {rounds.length > 0 && <RoundsList rounds={rounds} />}
            </li>
          ))}
        </ul>
      )}

      <CreateEventDialog open={creating} onOpenChange={setCreating} />
    </PageContainer>
  )
}

/** Rounds hang under the first event of their chain; an event whose parent is gone becomes a root itself. */
function groupRounds(events: EventListItem[]): { root: EventListItem; rounds: EventListItem[] }[] {
  const byParent = new Map<string, EventListItem[]>()
  for (const e of events) {
    if (e.parent_event_id) byParent.set(e.parent_event_id, [...(byParent.get(e.parent_event_id) ?? []), e])
  }
  const known = new Set(events.map((e) => e.id))
  const descendants = (id: string): EventListItem[] => (byParent.get(id) ?? []).flatMap((c) => [c, ...descendants(c.id)])
  return events
    .filter((e) => !e.parent_event_id || !known.has(e.parent_event_id))
    .map((root) => ({ root, rounds: descendants(root.id).sort((a, b) => a.round - b.round) }))
}

function RoundsList({ rounds }: { rounds: EventListItem[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="ml-4 border-l pl-3">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="-ml-2">
        {open ? <ChevronDown /> : <ChevronRight />}
        {open ? ru.events.hideRounds : ru.events.showRounds(rounds.length)}
      </Button>
      {open && (
        <ul className="mt-2 grid gap-2">
          {rounds.map((r) => (
            <li key={r.id}>
              <EventCard event={r} compact />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EventCard({ event, compact = false }: { event: EventListItem; compact?: boolean }) {
  return (
    <Link
      to={`/events/${event.id}`}
      className="group flex h-full flex-col gap-4 rounded-xl border bg-card p-5 shadow-xs transition-[border-color,box-shadow] outline-none hover:border-primary/40 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="line-clamp-2 text-base leading-snug font-semibold break-words">{event.title}</h2>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={event.status} />
          {event.round > 1 && <Badge variant="outline">{ru.events.round(event.round)}</Badge>}
        </div>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p className="flex items-center gap-2">
          <CalendarDays className="size-4 shrink-0" aria-hidden />
          {event.starts_at ? formatDateTime(event.starts_at) : ru.events.noDate}
        </p>
        {event.location && (
          <p className="flex items-center gap-2">
            <MapPin className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{event.location}</span>
          </p>
        )}
      </div>
      <dl className={compact ? 'sr-only' : 'mt-auto grid grid-cols-4 gap-2 border-t pt-4 text-center'}>
        <Stat label={ru.events.teams} value={event.teams_count} />
        <Stat label={ru.events.criteria} value={event.criteria_count} />
        <Stat label={ru.events.judges} value={event.judges_count} />
        <Stat label={ru.events.submitted} value={`${event.submitted_count}/${event.judges_count}`} />
      </dl>
    </Link>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dd className="num font-mono text-lg font-medium">{value}</dd>
      <dt className="text-[11px] leading-tight text-muted-foreground">{label}</dt>
    </div>
  )
}

function CreateEventDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [location, setLocation] = useState('')
  const [templateId, setTemplateId] = useState('none')
  const template = CRITERIA_TEMPLATES.find((t) => t.id === templateId)

  const create = useMutation({
    mutationFn: async (body: Parameters<typeof eventsApi.create>[0]) => {
      const full = await eventsApi.create(body)
      if (template) {
        try {
          await eventsApi.addCriteriaBulk(full.event.id, template.criteria)
        } catch (e) {
          // The event exists already: open it and let the organizer add criteria by hand.
          toast.error(errorText(e))
        }
      }
      return full
    },
    onSuccess: ({ event }) => {
      void qc.invalidateQueries({ queryKey: ['events'] })
      onOpenChange(false)
      navigate(`/events/${event.id}`)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate({
              title: title.trim(),
              description: description.trim() || undefined,
              starts_at: startsAt ? new Date(startsAt).getTime() : undefined,
              location: location.trim() || undefined,
            })
          }}
        >
          <DialogHeader>
            <DialogTitle>{ru.events.createTitle}</DialogTitle>
            <DialogDescription>{ru.events.createText}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ev-title">{ru.events.titleLabel}</Label>
            <Input id="ev-title" required autoFocus maxLength={200} placeholder={ru.events.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ev-desc">{ru.events.descriptionLabel}</Label>
            <Textarea id="ev-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ev-start">{ru.events.startsAtLabel}</Label>
              <Input id="ev-start" type="datetime-local" lang="ru" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ev-loc">{ru.events.locationLabel}</Label>
              <Input id="ev-loc" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label id="ev-template-l">{cr.createTemplate.label}</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger aria-labelledby="ev-template-l" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{cr.createTemplate.none}</SelectItem>
                {CRITERIA_TEMPLATES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{template ? `${template.description} ${cr.setup.templateCriteria(template.criteria.length)}. ${cr.createTemplate.hint}` : cr.createTemplate.hint}</p>
          </div>
          {create.isError && <p role="alert" className="text-sm text-destructive">{errorText(create.error)}</p>}
          {!title.trim() && <p className="text-xs text-muted-foreground">{ru.events.createHint}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {ru.common.cancel}
            </Button>
            <Button type="submit" disabled={!title.trim() || create.isPending}>
              {ru.common.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
