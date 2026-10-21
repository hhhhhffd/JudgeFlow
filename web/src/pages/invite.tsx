import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { invitePublicApi } from '@/api/endpoints'
import { AuthShell } from '@/components/auth-shell'
import { TotpEnrollment } from '@/components/totp-enrollment'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { meQueryKey } from '@/features/auth/auth'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { NotFoundView } from './not-found'

export default function InvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')

  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => invitePublicApi.get(token), retry: false })
  const begin = useMutation({ mutationFn: (n: string) => invitePublicApi.begin(token, { name: n }) })
  const complete = useMutation({
    mutationFn: (code: string) => invitePublicApi.complete(token, { code }),
    onSuccess: ({ admin }) => {
      qc.setQueryData(meQueryKey, admin)
      toast.success(ru.invite.welcome(admin.name))
      navigate('/', { replace: true })
    },
  })

  if (invite.isPending) {
    return (
      <AuthShell title={ru.invite.title}>
        <Skeleton className="h-32 w-full" />
      </AuthShell>
    )
  }
  if (invite.error instanceof ApiError && invite.error.status === 404) {
    return <NotFoundView title={ru.invite.invalidTitle} text={ru.invite.invalidText} to="/login" action={ru.login.submit} />
  }
  if (invite.isError) {
    return (
      <AuthShell title={ru.invite.title}>
        <p role="alert" className="text-sm text-destructive">{errorText(invite.error)}</p>
      </AuthShell>
    )
  }

  if (begin.data) {
    return (
      <AuthShell title={ru.invite.title}>
        <TotpEnrollment
          otpauthUri={begin.data.otpauth_uri}
          secret={begin.data.secret}
          pending={complete.isPending}
          error={complete.error ? (complete.error instanceof ApiError && complete.error.status === 401 ? ru.enroll.wrongCode : errorText(complete.error)) : null}
          onSubmit={(code) => !complete.isPending && complete.mutate(code)}
        />
      </AuthShell>
    )
  }

  const error = begin.error ? (begin.error instanceof ApiError && begin.error.status === 409 ? ru.invite.nameTaken : errorText(begin.error)) : null

  return (
    <AuthShell title={ru.invite.title} subtitle={ru.invite.subtitle}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          begin.mutate(name.trim())
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="invite-name">{ru.invite.nameLabel}</Label>
          <Input id="invite-name" autoComplete="username" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!error} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={begin.isPending || !name.trim()}>
          {begin.isPending && <Loader2 className="animate-spin" />}
          {ru.invite.submit}
        </Button>
      </form>
    </AuthShell>
  )
}
