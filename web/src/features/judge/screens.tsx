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

export function RevokedScreen({ onRecheck, onForget }: { onRecheck: () => void; onForget: () => void }) {
  return (
    <Centered icon={<ShieldAlert />} title={judgeText.revoked.title} text={judgeText.revoked.text}>
      <Button variant="outline" onClick={onRecheck}>
        {judgeText.revoked.recheck}
      </Button>
      <Button variant="ghost" onClick={onForget}>
        {judgeText.revoked.forget}
      </Button>
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
