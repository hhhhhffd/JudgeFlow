import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ApiError } from '@/api/client'
import { setupApi } from '@/api/endpoints'
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

export default function FirstStartPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const available = useQuery({
    queryKey: ['first-start'],
    queryFn: async () => {
      try {
        await setupApi.checkFirstStart()
        return true
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return false
        throw e
      }
    },
    retry: false,
  })

  const begin = useMutation({ mutationFn: setupApi.begin })
  const complete = useMutation({
    mutationFn: setupApi.complete,
    onSuccess: ({ admin }) => {
      qc.setQueryData(meQueryKey, admin)
      toast.success(ru.firstStart.done)
      navigate('/', { replace: true })
    },
  })

  if (available.isPending) {
    return (
      <AuthShell title={ru.firstStart.title}>
        <Skeleton className="h-40 w-full" />
      </AuthShell>
    )
  }
  if (available.data === false) {
    return <NotFoundView title={ru.firstStart.notFoundTitle} text={ru.firstStart.notFoundText} to="/login" action={ru.firstStart.toLogin} />
  }
  if (available.isError) {
    return (
      <AuthShell title={ru.firstStart.title}>
        <p role="alert" className="text-sm text-destructive">{errorText(available.error)}</p>
        <Button variant="outline" onClick={() => void available.refetch()}>{ru.common.retry}</Button>
      </AuthShell>
    )
  }

  if (begin.data) {
    return (
      <AuthShell title={ru.firstStart.title}>
        <TotpEnrollment
          otpauthUri={begin.data.otpauth_uri}
          secret={begin.data.secret}
          pending={complete.isPending}
          error={complete.error ? (complete.error instanceof ApiError && complete.error.status === 401 ? ru.enroll.wrongCode : errorText(complete.error)) : null}
          onSubmit={(code) => !complete.isPending && complete.mutate({ enrollment_token: begin.data.enrollment_token, code })}
        />
      </AuthShell>
    )
  }

  const beginError = begin.error
    ? beginErrorText(begin.error)
    : null

  return (
    <AuthShell title={ru.firstStart.title} subtitle={ru.firstStart.subtitle}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          begin.mutate({ setup_password: password, name: name.trim() })
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="setup-password">{ru.firstStart.passwordLabel}</Label>
          <Input id="setup-password" type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!beginError} />
          <p className="text-xs text-muted-foreground">{ru.firstStart.passwordHint}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="setup-name">{ru.firstStart.nameLabel}</Label>
          <Input id="setup-name" autoComplete="username" required maxLength={64} placeholder={ru.firstStart.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {beginError && <p role="alert" className="text-sm text-destructive">{beginError}</p>}
        <Button type="submit" className="w-full" disabled={begin.isPending || !password || !name.trim()}>
          {begin.isPending && <Loader2 className="animate-spin" />}
          {ru.firstStart.submit}
        </Button>
      </form>
    </AuthShell>
  )
}

function beginErrorText(e: unknown) {
  return e instanceof ApiError && e.status === 401 ? ru.firstStart.wrongPassword : errorText(e)
}
