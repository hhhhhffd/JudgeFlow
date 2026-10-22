import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { authApi } from '@/api/endpoints'
import { AuthShell } from '@/components/auth-shell'
import { OtpInput } from '@/components/otp-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { meQueryKey } from '@/features/auth/auth'
import { ru } from '@/i18n/ru'
import { errorText } from '@/lib/errors'
import { useFirstStartAvailable } from './first-start-available'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const firstStart = useFirstStartAvailable()

  const login = useMutation({
    mutationFn: authApi.login,
    onSuccess: ({ admin }) => {
      qc.setQueryData(meQueryKey, admin)
      const from = (location.state as { from?: string } | null)?.from
      navigate(from && from.startsWith('/') ? from : '/', { replace: true })
    },
    onError: () => setCode(''),
  })

  function submit(value: string) {
    if (!login.isPending && name.trim() && value.length === 6) login.mutate({ name: name.trim(), code: value })
  }

  const error = login.error
    ? login.error instanceof ApiError && login.error.status === 401
      ? ru.login.failed
      : login.error instanceof ApiError && login.error.code === 'rate_limited'
        ? ru.login.rateLimited
        : errorText(login.error)
    : null

  return (
    <AuthShell title={ru.login.title} subtitle={ru.login.subtitle} footer={
        <div className="space-y-2">
          {firstStart.data === true && (
            <p>
              {ru.login.firstStartHint}{' '}
              <Link to="/firststart" className="font-medium text-foreground underline underline-offset-4">
                {ru.login.firstStartLink}
              </Link>
            </p>
          )}
          <p>{ru.login.judgeHint}</p>
        </div>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit(code)
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="login-name">{ru.login.nameLabel}</Label>
          <Input id="login-name" autoComplete="username" autoFocus required maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>{ru.otp.label}</Label>
          <OtpInput value={code} onChange={setCode} onComplete={submit} disabled={login.isPending} invalid={!!error} />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={login.isPending || !name.trim() || code.length < 6}>
          {login.isPending && <Loader2 className="animate-spin" />}
          {ru.login.submit}
        </Button>
      </form>
    </AuthShell>
  )
}
