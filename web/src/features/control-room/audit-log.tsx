import { useQuery } from '@tanstack/react-query'
import { eventsApi } from '@/api/endpoints'
import { EmptyState, ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { useFull } from './context'

export function AuditLog() {
  const { event } = useFull()
  const audit = useQuery({ queryKey: ['cr', event.id, 'audit'], queryFn: () => eventsApi.audit(event.id) })

  if (audit.isPending) return <Skeleton className="h-64 rounded-xl" />
  if (audit.isError) return <ErrorState message={errorText(audit.error)} onRetry={() => void audit.refetch()} />
  if (audit.data.length === 0) return <EmptyState title={cr.audit.empty} text={cr.audit.emptyText} />

  return (
    <section aria-labelledby="audit-h">
      <h2 id="audit-h" className="sr-only">{cr.audit.title}</h2>
      <ol className="divide-y rounded-xl border bg-card">
        {audit.data.map((a) => (
          <li key={a.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p>
                <span className="font-mono text-xs font-medium break-all">{a.action}</span>
                <span className="text-muted-foreground"> · {a.admin_name ?? cr.audit.system}</span>
              </p>
              <time className="num text-xs text-muted-foreground" dateTime={new Date(a.created_at).toISOString()}>
                {formatDateTime(a.created_at)}
              </time>
            </div>
            {hasDetails(a.details) && (
              <details className="mt-1.5">
                <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">{cr.audit.details}</summary>
                <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-words whitespace-pre-wrap">{typeof a.details === 'string' ? a.details : JSON.stringify(a.details, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}

function hasDetails(d: unknown): boolean {
  if (d == null || d === '') return false
  if (typeof d === 'object') return Object.keys(d).length > 0
  return true
}
