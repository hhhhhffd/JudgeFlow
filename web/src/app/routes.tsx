import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Skeleton } from '@/components/ui/skeleton'
import NotFoundPage from '@/pages/not-found'

// Every area is its own chunk so the judge and live bundles never download admin code.
const AdminShell = lazy(() => import('@/app/admin-shell'))
const EventsPage = lazy(() => import('@/pages/events'))
const AdminsPage = lazy(() => import('@/pages/admins'))
const FirstStartPage = lazy(() => import('@/pages/first-start'))
const LoginPage = lazy(() => import('@/pages/login'))
const InvitePage = lazy(() => import('@/pages/invite'))
const ControlRoom = lazy(() => import('@/features/control-room'))
const JudgeDesk = lazy(() => import('@/features/judge'))
const LiveBoard = lazy(() => import('@/features/live'))

const fallback = <Skeleton className="m-6 h-40" />

export function AppRoutes() {
  return (
    <Suspense fallback={fallback}>
      <Routes>
        <Route path="/firststart" element={<FirstStartPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />

        <Route element={<AdminShell />}>
          <Route index element={<EventsPage />} />
          <Route path="admins" element={<AdminsPage />} />
          <Route path="events/:id/*" element={<ControlRoom />} />
        </Route>

        {/* /j/:token stores the token and redirects to /judge (implemented by the judge feature). */}
        <Route path="/j/:token" element={<JudgeDesk />} />
        <Route path="/judge" element={<JudgeDesk />} />
        <Route path="/live/:eventId" element={<LiveBoard />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  )
}
