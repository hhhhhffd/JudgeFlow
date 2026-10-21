import { AdminLayout } from '@/components/admin-layout'
import { AdminGuard } from '@/features/auth/auth'

// Lazy-loaded boundary for everything behind the organizer login.
export default function AdminShell() {
  return (
    <AdminGuard>
      <AdminLayout />
    </AdminGuard>
  )
}
