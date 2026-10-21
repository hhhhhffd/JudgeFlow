import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, LogOut } from 'lucide-react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { authApi } from '@/api/endpoints'
import { Logo } from '@/components/logo'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useAdmin } from '@/features/auth/auth'
import { ru } from '@/i18n/ru'
import { cn } from '@/lib/utils'

const navClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'relative rounded-md px-2 py-1.5 sm:px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
    isActive && 'text-foreground after:absolute after:inset-x-2 sm:after:inset-x-3 after:-bottom-[13px] after:h-0.5 after:rounded after:bg-signal',
  )

export function AdminLayout() {
  const admin = useAdmin()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const logout = useMutation({
    mutationFn: authApi.logout,
    onSettled: () => {
      qc.clear()
      navigate('/login', { replace: true })
    },
  })

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6">
          <NavLink to="/" aria-label={ru.app.name} className="shrink-0">
            <Logo compact />
          </NavLink>
          <nav className="flex min-w-0 flex-1 items-center gap-0.5 sm:gap-1" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              {ru.nav.events}
            </NavLink>
            {admin.role === 'owner' && (
              <NavLink to="/admins" className={navClass}>
                {ru.nav.admins}
              </NavLink>
            )}
          </nav>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label={`${admin.name}, ${ru.nav.account.toLowerCase()}`}>
                <span className="max-w-20 truncate sm:max-w-28">{admin.name}</span>
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{ru.role[admin.role]}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => logout.mutate()}>
                <LogOut />
                {ru.nav.logout}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Outlet />
    </div>
  )
}

/** Standard page container for admin pages. */
export function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <main className={cn('mx-auto w-full max-w-6xl px-4 py-8', className)}>{children}</main>
}
