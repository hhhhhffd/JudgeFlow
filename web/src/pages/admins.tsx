import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, MoreHorizontal, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { adminsApi } from '@/api/endpoints'
import type { Admin, InviteCreated, TotpEnrollment } from '@/api/types'
import { PageContainer } from '@/components/admin-layout'
import { CopyField } from '@/components/copy-field'
import { ErrorState } from '@/components/state-views'
import { TotpDisplay } from '@/components/totp-enrollment'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { useAdmin } from '@/features/auth/auth'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { NotFoundView } from './not-found'

export default function AdminsPage() {
  const me = useAdmin()
  if (me.role !== 'owner') {
    return <NotFoundView title={ru.admins.ownerOnly} text="" />
  }
  return <AdminsContent selfId={me.id} />
}

function AdminsContent({ selfId }: { selfId: string }) {
  const qc = useQueryClient()
  const admins = useQuery({ queryKey: ['admins'], queryFn: adminsApi.list })
  const invites = useQuery({ queryKey: ['admin-invites'], queryFn: adminsApi.listInvites })

  const [invite, setInvite] = useState<InviteCreated | null>(null)
  const [resetTarget, setResetTarget] = useState<Admin | null>(null)
  const [resetResult, setResetResult] = useState<TotpEnrollment | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Admin | null>(null)

  const createInvite = useMutation({
    mutationFn: adminsApi.createInvite,
    onSuccess: (data) => {
      setInvite(data)
      void qc.invalidateQueries({ queryKey: ['admin-invites'] })
    },
    onError: (e) => toast.error(errorText(e)),
  })
  const revoke = useMutation({
    mutationFn: adminsApi.deleteInvite,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-invites'] }),
    onError: (e) => toast.error(errorText(e)),
  })
  const reset = useMutation({
    mutationFn: adminsApi.resetTotp,
    onSuccess: (data) => {
      setResetTarget(null)
      setResetResult(data)
    },
    onError: (e) => toast.error(errorText(e)),
  })
  const remove = useMutation({
    mutationFn: adminsApi.remove,
    onSuccess: () => {
      setDeleteTarget(null)
      toast.success(ru.admins.deleted)
      void qc.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (e) => toast.error(errorText(e)),
  })

  return (
    <PageContainer className="max-w-4xl space-y-10">
      <section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{ru.admins.title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{ru.admins.subtitle}</p>
          </div>
          <Button onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
            <UserPlus />
            {ru.admins.inviteCreate}
          </Button>
        </div>

        {admins.isPending && <Skeleton className="h-40 w-full rounded-xl" />}
        {admins.isError && <ErrorState title={ru.admins.loadFailed} message={errorText(admins.error)} onRetry={() => void admins.refetch()} />}
        {admins.data && (
          <div className="rounded-xl border bg-card">
            <Table>
              <TableBody>
                {admins.data.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">
                      {a.name}
                      {a.id === selfId && <span className="ml-2 text-xs font-normal text-muted-foreground">({ru.admins.you})</span>}
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.role === 'owner' ? 'default' : 'secondary'}>{ru.role[a.role]}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">{ru.admins.joinedAt(formatDateTime(a.created_at))}</TableCell>
                    <TableCell className="w-12 text-right">
                      {a.role !== 'owner' && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={a.name}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setResetTarget(a)}>
                              <KeyRound />
                              {ru.admins.resetTotp}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(a)}>
                              <Trash2 />
                              {ru.common.delete}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">{ru.admins.activeInvites}</h2>
        {invites.data?.length === 0 && <p className="text-sm text-muted-foreground">{ru.admins.noInvites}</p>}
        {invites.isError && <ErrorState message={errorText(invites.error)} onRetry={() => void invites.refetch()} />}
        {invites.data && invites.data.length > 0 && (
          <ul className="divide-y rounded-xl border bg-card">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div>
                  <p>{ru.admins.inviteCreatedAt(formatDateTime(i.created_at))}</p>
                  <p className="text-xs text-muted-foreground">{ru.admins.inviteExpires(formatDateTime(i.expires_at))}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)} disabled={revoke.isPending}>
                  {ru.admins.revoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={!!invite} onOpenChange={(o) => !o && setInvite(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ru.admins.inviteTitle}</DialogTitle>
            <DialogDescription>{ru.admins.inviteText}</DialogDescription>
          </DialogHeader>
          {invite && (
            <>
              <CopyField value={invite.url} label={ru.admins.inviteTitle} />
              <p className="text-xs text-muted-foreground">{ru.admins.inviteExpires(formatDateTime(invite.expires_at))}</p>
            </>
          )}
          <DialogFooter>
            <Button onClick={() => setInvite(null)}>{ru.common.close}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{resetTarget && ru.admins.resetTitle(resetTarget.name)}</AlertDialogTitle>
            <AlertDialogDescription>{ru.admins.resetConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ru.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                if (resetTarget) reset.mutate(resetTarget.id)
              }}
              disabled={reset.isPending}
            >
              {ru.admins.resetTotp}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!resetResult} onOpenChange={(o) => !o && setResetResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ru.admins.resetDone}</DialogTitle>
            <DialogDescription>{ru.admins.resetDoneText}</DialogDescription>
          </DialogHeader>
          {resetResult && <TotpDisplay otpauthUri={resetResult.otpauth_uri} secret={resetResult.secret} />}
          <DialogFooter>
            <Button onClick={() => setResetResult(null)}>{ru.common.close}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteTarget && ru.admins.deleteTitle(deleteTarget.name)}</AlertDialogTitle>
            <AlertDialogDescription>{ru.admins.deleteText}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ru.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget) remove.mutate(deleteTarget.id)
              }}
              disabled={remove.isPending}
            >
              {ru.common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  )
}
