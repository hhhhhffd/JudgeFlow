import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ru } from '@/i18n/ru'
import { cn } from '@/lib/utils'

export function EmptyState({
  title,
  text,
  action,
  className,
}: {
  title: string
  text?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center', className)}>
      <div aria-hidden className="ticks h-3 w-24 opacity-70" />
      <h2 className="text-base font-semibold">{title}</h2>
      {text && <p className="max-w-sm text-sm text-muted-foreground">{text}</p>}
      {action}
    </div>
  )
}

export function ErrorState({ title, message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center">
      <AlertCircle className="size-6 text-destructive" aria-hidden />
      <h2 className="text-base font-semibold">{title ?? ru.common.errorTitle}</h2>
      {message && <p className="max-w-sm text-sm text-muted-foreground">{message}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {ru.common.retry}
        </Button>
      )}
    </div>
  )
}
