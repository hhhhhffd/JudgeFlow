import { useEffect, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { accessApi } from '@/api/endpoints'
import { AuthShell } from '@/components/auth-shell'

export default function AccessMagicPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    history.replaceState(null, '', '/event')
    void accessApi.magic(token).then(() => navigate('/event', { replace: true })).catch(() => navigate('/', { replace: true }))
  }, [navigate, token])

  return <AuthShell title="Выполняется вход" subtitle="Проверяем персональную ссылку…"><div className="h-1 animate-pulse rounded-full bg-primary" /></AuthShell>
}
