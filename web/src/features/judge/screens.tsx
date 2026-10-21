import { useState } from 'react'
import { Link2Off, ShieldAlert, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { judgeText } from '@/i18n/judge'
import { ru } from '@/i18n/ru'

function Centered({ icon, title, text, children }: { icon: React.ReactNode; title: string; text: string; children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground [&_svg]:size-6">{icon}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="text-muted-foreground">{text}</p>
        <div className="flex flex-wrap justify-center gap-2">{children}</div>
      </div>
    </main>
  )
}

export function NoTokenScreen() {
  return <Centered icon={<Link2Off />} title={judgeText.noToken.title} text={judgeText.noToken.text} />
}

export function RevokedScreen({ unsynced, onRecheck, onForget }: { unsynced: number; onRecheck: () => void; onForget: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const t = judgeText.revoked
  const warning = unsynced > 0 ? `${t.unsynced(unsynced)} ${t.forgetWarning}` : ''
  return (
    <Centered icon={<ShieldAlert />} title={t.title} text={t.text}>
      {confirming ? (
        <>
          <p role="alert" className="w-full text-sm font-medium text-destructive">
            {warning}
          </p>
          <Button variant="destructive" onClick={onForget}>
            {t.forgetConfirm}
          </Button>
          <Button variant="outline" onClick={() => setConfirming(false)}>
            {t.forgetCancel}
          </Button>
        </>
      ) : (
        <>
          <Button variant="outline" onClick={onRecheck}>
            {t.recheck}
          </Button>
          <Button variant="ghost" onClick={unsynced > 0 ? () => setConfirming(true) : onForget}>
            {t.forget}
          </Button>
        </>
      )}
    </Centered>
  )
}

export function FailedScreen({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <Centered icon={<WifiOff />} title={judgeText.failed.title} text={message ?? ru.common.unknownError}>
      <Button onClick={onRetry}>{ru.common.retry}</Button>
    </Centered>
  )
}

export function LoadingScreen() {
  return (
    <main role="status" aria-label={judgeText.loading} className="flex min-h-dvh flex-col gap-4 p-6">
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-64 w-full" />
    </main>
  )
}
