// Judge module: /j/:token stores the token and redirects to /judge (token leaves the URL and history).
import { useEffect, useMemo, useReducer, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { judgeText } from '@/i18n/judge'
import { DeskController } from './controller'
import { Desk } from './desk'
import { FailedScreen, LoadingScreen, NoTokenScreen, RevokedScreen } from './screens'
import { getStoredToken, setStoredToken } from './storage'

export default function JudgeModule() {
  const { token: linkToken } = useParams()
  const navigate = useNavigate()
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!linkToken) return
    setStoredToken(linkToken)
    navigate('/judge', { replace: true })
  }, [linkToken, navigate])

  if (linkToken) return <LoadingScreen />
  const token = getStoredToken()
  if (!token) return <NoTokenScreen />
  return (
    <DeskRoot
      key={token}
      token={token}
      onForget={() => {
        setStoredToken(null)
        rerender()
      }}
    />
  )
}

function DeskRoot({ token, onForget }: { token: string; onForget: () => void }) {
  const controller = useMemo(() => new DeskController(token), [token])
  useEffect(() => {
    controller.start()
    return () => controller.stop()
  }, [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const title = state.session?.event.title

  useEffect(() => {
    document.title = title ? `${title} — ${judgeText.title}` : judgeText.title
  }, [title])

  if (state.phase === 'revoked') return <RevokedScreen onRecheck={() => controller.recheck()} onForget={onForget} />
  if (state.phase === 'failed') return <FailedScreen message={state.failure} onRetry={() => controller.recheck()} />
  if (!state.session) return <LoadingScreen />
  return <Desk controller={controller} session={state.session} />
}
