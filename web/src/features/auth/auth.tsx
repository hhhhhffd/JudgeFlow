import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, useLocation } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { authApi } from '@/api/endpoints'
import type { Admin } from '@/api/types'
import { ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'

export const meQueryKey = ['me'] as const

const AdminContext = createContext<Admin | null>(null)

/** Current admin; only valid below <AdminGuard>. */
export function useAdmin(): Admin {
  const admin = useContext(AdminContext)
  if (!admin) throw new Error('useAdmin must be used inside <AdminGuard>')
  return admin
}

export function AdminGuard({ children }: { children: ReactNode }) {
  const location = useLocation()
  const me = useQuery({
    queryKey: meQueryKey,
    queryFn: async () => (await authApi.me()).admin,
    retry: (count, e) => !(e instanceof ApiError && e.status === 401) && count < 2,
    staleTime: 60_000,
  })

  if (me.isPending) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6" role="status" aria-label={ru.guard.checking}>
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState message={errorText(me.error)} onRetry={() => void me.refetch()} />
      </div>
    )
  }
  return (
    <AdminContext.Provider value={me.data}>
      {children}
    </AdminContext.Provider>
  )
}
