import { useEffect, useState } from 'react'
import { LifeBuoy, Download } from 'lucide-react'
import { Popover } from 'radix-ui'
import { Button } from '@/components/ui/button'
import { judgeText } from '@/i18n/judge'
import type { DeskController } from './controller'

const ERROR_ALERT_MS = 60_000
const REVOKE_DELAY_MS = 30_000

/** True once `active` has been continuously true for `delayMs`. */
export function useActiveFor(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    if (!active) return
    const t = window.setTimeout(() => setElapsed(true), delayMs)
    return () => {
      window.clearTimeout(t)
      setElapsed(false)
    }
  }, [active, delayMs])
  return active && elapsed
}

export function downloadBackup(controller: DeskController): boolean {
  const sheet = controller.exportSheet()
  if (!sheet) return false
  const url = URL.createObjectURL(new Blob([JSON.stringify(sheet, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `judgeflow-sheet-${sheet.judge_id.slice(0, 8)}.json`
  document.body.append(a)
  a.click()
  a.remove()
  // WebKit starts the download asynchronously: revoking at once can cancel it.
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  return true
}

export function BackupMenu({ controller }: { controller: DeskController }) {
  const t = judgeText.backup
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={t.menu}
        title={t.menu}
        className="inline-flex size-11 shrink-0 sm:size-9 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <LifeBuoy className="size-5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">{t.text}</p>
          <p className="mt-2 rounded-md bg-warning-soft p-2 text-xs text-warning">{t.warning}</p>
          <Button className="mt-3 w-full" variant="outline" onClick={() => downloadBackup(controller)}>
            <Download />
            {t.download}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Shown when sync keeps failing: the backup is the judge's way out. */
export function BackupAlert({ controller, errorKind }: { controller: DeskController; errorKind: boolean }) {
  const long = useActiveFor(errorKind, ERROR_ALERT_MS)
  if (!long) return null
  const t = judgeText.backup
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t.alertTitle}</span> {t.alertText} {t.warning}
      </span>
      <Button size="sm" onClick={() => downloadBackup(controller)}>
        <Download />
        {t.download}
      </Button>
    </div>
  )
}

/** The event is locked and the server refuses the rejected scores: retrying is pointless, the backup is the way out. */
export function LockedRejectedNotice({ controller }: { controller: DeskController }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
      <span className="min-w-0 flex-1">{judgeText.sync.lockedRejected}</span>
      <Button size="sm" className="h-11 sm:h-8" onClick={() => downloadBackup(controller)}>
        <Download />
        {judgeText.backup.download}
      </Button>
    </div>
  )
}
