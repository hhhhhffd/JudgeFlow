import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { eventsApi } from '@/api/endpoints'
import { openStream } from '@/api/sse'
import { PageContainer } from '@/components/admin-layout'
import { EmptyState, ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { AlertEditor } from './alert-editor'
import { Appearance } from './appearance'
import { AuditLog } from './audit-log'
import { EventContext } from './context'
import { EventHeader } from './header'
import { JudgesSection } from './judges'
import { Overview } from './overview'
import { Results } from './results'
import { Setup } from './setup'

const TABS = [
  { to: '', label: cr.nav.overview, end: true },
  { to: 'setup', label: cr.nav.setup },
  { to: 'judges', label: cr.nav.judges },
  { to: 'results', label: cr.nav.results },
  { to: 'alert', label: cr.nav.alert },
  { to: 'appearance', label: cr.nav.appearance },
  { to: 'audit', label: cr.nav.audit },
]

/** Any server change hint refetches everything of this event after a short quiet period. */
function useLiveInvalidation(id: string) {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ['cr', id] }), 500)
    }
    const close = openStream(eventsApi.streamUrl(id), {
      onChange: refresh,
      // After a reconnect we may have missed hints.
      onOpen: ({ reconnect }) => reconnect && refresh(),
    })
    return () => {
      clearTimeout(timer)
      close()
    }
  }, [id, qc])
}

function EventLayout() {
  const { id = '' } = useParams()
  useLiveInvalidation(id)
  const query = useQuery({ queryKey: ['cr', id, 'event'], queryFn: () => eventsApi.get(id), retry: (n, e) => !(e instanceof ApiError && e.isNotFound) && n < 2 })

  if (query.isPending) {
    return (
      <PageContainer className="grid gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </PageContainer>
    )
  }
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.isNotFound
    return (
      <PageContainer>
        {notFound ? (
          <EmptyState title={cr.notFoundTitle} text={cr.notFoundText} />
        ) : (
          <ErrorState title={cr.loadFailed} message={errorText(query.error)} onRetry={() => void query.refetch()} />
        )}
      </PageContainer>
    )
  }

  return (
    <EventContext.Provider value={query.data}>
      <PageContainer>
        <EventHeader />
        <nav aria-label={cr.nav.label} className="-mx-4 mb-6 overflow-x-auto overflow-y-hidden border-b px-4">
          <ul className="flex w-max min-w-full gap-1">
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink
                  to={t.to ? `/events/${id}/${t.to}` : `/events/${id}`}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      '-mb-px inline-flex h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      isActive && 'border-primary text-foreground',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="setup" element={<Setup />} />
          <Route path="judges" element={<JudgesSection />} />
          <Route path="results" element={<Results />} />
          <Route path="alert" element={<AlertEditor />} />
          <Route path="appearance" element={<Appearance />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="*" element={<Navigate to="." replace />} />
        </Routes>
      </PageContainer>
    </EventContext.Provider>
  )
}

export default EventLayout
