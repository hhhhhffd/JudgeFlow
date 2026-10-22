import { AlertTriangle, Check, Cloud, HardDrive, Loader2, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { judgeText } from '@/i18n/judge'
import { cn } from '@/lib/utils'
import type { IndicatorKind } from './scoring'

const ICON: Record<IndicatorKind, React.ReactNode> = {
  local: <HardDrive />,
  syncing: <Loader2 className="animate-spin motion-reduce:animate-none" />,
  synced: <Check />,
  offline: <WifiOff />,
  error: <AlertTriangle />,
}
const TONE: Record<IndicatorKind, string> = {
  local: 'text-warning',
  syncing: 'text-info',
  synced: 'text-success',
  offline: 'text-muted-foreground',
  error: 'text-destructive',
}

export function SyncBadge({
  kind,
  text,
  pending,
  fromCache,
  canRetry = true,
  onRetry,
}: {
  kind: IndicatorKind
  text: string
  pending: number
  fromCache: boolean
  /** False when a retry cannot help (e.g. the event is locked and rejects every edit). */
  canRetry?: boolean
  onRetry: () => void
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
      <span role="status" aria-live="polite" className={cn('flex min-w-0 items-center gap-1.5 text-sm font-medium [&_svg]:size-4 [&_svg]:shrink-0', TONE[kind])}>
        {ICON[kind]}
        <span className="truncate">{text}</span>
        {pending > 0 && kind !== 'synced' && (
          <span className="num shrink-0 text-muted-foreground">
            <span className="sm:hidden">· {pending}</span>
            <span className="hidden sm:inline">· {judgeText.sync.pending(pending)}</span>
          </span>
        )}
      </span>
      {fromCache && (
        <span className="hidden items-center gap-1 text-xs text-muted-foreground xl:flex">
          <Cloud className="size-3.5" aria-hidden />
          {judgeText.sync.offlineCopy}
        </span>
      )}
      {kind === 'error' && canRetry && (
        <Button variant="outline" size="sm" className="h-11 sm:h-8" onClick={onRetry}>
          {judgeText.sync.retry}
        </Button>
      )}
    </div>
  )
}

/** Below xl the header has no room for the cached-copy marker, so it gets its own line. */
export function CachedCopyNotice({ fromCache }: { fromCache: boolean }) {
  if (!fromCache) return null
  return (
    <p role="status" className="flex items-center gap-1.5 border-b bg-muted/80 px-4 py-1.5 text-xs text-muted-foreground xl:hidden">
      <Cloud className="size-3.5 shrink-0" aria-hidden />
      {judgeText.sync.offlineCopyShort}
    </p>
  )
}
