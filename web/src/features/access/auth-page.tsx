import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowRight, KeyRound } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { accessApi } from '@/api/endpoints'
import { AuthShell } from '@/components/auth-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorText } from '@/lib/errors'

export default function AccessAuthPage() {
  const { eventId = '' } = useParams()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => accessApi.login(eventId, password),
    onSuccess: () => navigate('/event', { replace: true }),
  })

  return (
    <AuthShell title="Вход в мероприятие" subtitle="Введите личный пароль. Логин не нужен.">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          login.mutate()
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="event-password">Личный пароль</Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id="event-password"
              className="pl-10"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        {login.isError && <p role="alert" className="text-sm text-destructive">{errorText(login.error)}</p>}
        <Button type="submit" disabled={!password || login.isPending}>
          Войти <ArrowRight className="size-4" aria-hidden />
        </Button>
        <p className="text-center text-xs text-muted-foreground">Также можно открыть персональную magic-ссылку от организатора.</p>
      </form>
    </AuthShell>
  )
}
