import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { eventsApi } from '@/api/endpoints'
import type { UnsubmittedDetails } from '@/api/types'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { ConfirmDialog } from './confirm-dialog'
import { useFull } from './context'
import { LIFECYCLE, type LifecycleAction } from './lib'

export function EventHeader() {
  const { event } = useFull()
  const [action, setAction] = useState<LifecycleAction | null>(null)
  const [deleting, setDeleting] = useState(false)
  const actions = LIFECYCLE[event.status]
  const events = useQuery({ queryKey: ['events'], queryFn: eventsApi.list })
  const parent = events.data?.find((e) => e.id === event.parent_event_id)
  const children = events.data?.filter((e) => e.parent_event_id === event.id) ?? []

  return (
    <header className="mb-4 grid gap-3">
      <Link to="/" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        {cr.back}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">{event.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={event.status} />
            {(event.round > 1 || children.length > 0) && <Badge variant="outline">{cr.header.round(event.round)}</Badge>}
          </div>
          {(parent || children.length > 0) && (
            <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {parent && (
                <Link to={`/events/${parent.id}`} className="underline-offset-4 hover:text-foreground hover:underline">
                  {cr.header.fromRound(parent.title)}
                </Link>
              )}
              {children.length > 0 && (
                <span className="flex flex-wrap items-center gap-x-3">
                  {cr.header.nextRounds}:
                  {children.map((c) => (
                    <Link key={c.id} to={`/events/${c.id}`} className="underline-offset-4 hover:text-foreground hover:underline">
                      {c.title}
                    </Link>
                  ))}
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions.map((a) => (
            <Button key={a.to + a.key} variant={a.primary ? 'default' : 'outline'} onClick={() => setAction(a)}>
              {cr.lifecycle.actions[a.key]}
            </Button>
          ))}
          {event.status !== 'draft' && (
            <Button variant="outline" asChild>
              <a href={`/live/${event.id}`} target="_blank" rel="noreferrer">
                <ExternalLink />
                {cr.header.live}
              </a>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={cr.header.more}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                <Trash2 />
                {cr.header.delete}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {action && <TransitionDialog action={action} onClose={() => setAction(null)} />}
      <DeleteDialog open={deleting} onOpenChange={setDeleting} />
    </header>
  )
}

function TransitionDialog({ action, onClose }: { action: LifecycleAction; onClose: () => void }) {
  const { event } = useFull()
  const qc = useQueryClient()

  const transition = useMutation({
    mutationFn: ({ reason, force }: { reason: string; force: boolean }) =>
      eventsApi.transition(event.id, { to: action.to, ...(reason ? { reason } : {}), ...(force ? { force: true } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cr', event.id] })
      void qc.invalidateQueries({ queryKey: ['events'] })
      toast.success(cr.lifecycle.done)
      onClose()
    },
  })

  const conflict = transition.error instanceof ApiError && transition.error.status === 409 && action.key === 'finalize' ? transition.error : null
  const names = ((conflict?.details as UnsubmittedDetails | undefined)?.unsubmitted ?? []).map((j) => j.name)
  const needsReason = action.reasonRequired || conflict !== null

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={cr.lifecycle.actions[action.key]}
      description={cr.lifecycle.descriptions[action.key]}
      confirmLabel={conflict ? cr.lifecycle.force : cr.lifecycle.actions[action.key]}
      destructive={Boolean(conflict)}
      pending={transition.isPending}
      error={conflict ? null : transition.isError ? errorText(transition.error) : null}
      reasonLabel={needsReason ? (conflict ? cr.lifecycle.forceReason : cr.lifecycle.reasonLabel) : undefined}
      onConfirm={(reason) => {
        // Escalate to force only after the server has reported unsubmitted judges.
        transition.mutate({ reason, force: conflict !== null })
      }}
    >
      {conflict && (
        <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
          <p className="font-medium">{cr.lifecycle.unsubmittedTitle}</p>
          <p className="mt-1 text-muted-foreground">{conflict.message || cr.lifecycle.unsubmittedText}</p>
          {names.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {names.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">{cr.lifecycle.unsubmittedUnknown}</p>
          )}
        </div>
      )}
    </ConfirmDialog>
  )
}

function DeleteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { event } = useFull()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () => eventsApi.remove(event.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['cr', event.id] })
      void qc.invalidateQueries({ queryKey: ['events'] })
      navigate('/', { replace: true })
    },
  })
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={cr.delete.title}
      description={cr.delete.text}
      confirmLabel={cr.delete.submit}
      destructive
      pending={remove.isPending}
      error={remove.isError ? errorText(remove.error) : null}
      typeToConfirm={{ text: event.title, label: cr.delete.confirmLabel }}
      onConfirm={() => remove.mutate()}
    />
  )
}

