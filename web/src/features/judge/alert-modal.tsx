import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { JudgeAlert } from '@/api/types'
import { judgeText } from '@/i18n/judge'
import { cn } from '@/lib/utils'

/** Organizer announcement; shown once per alert version (the seen version is stored by the caller). */
export function AlertModal({ alert, open, onDismiss }: { alert: JudgeAlert; open: boolean; onDismiss: () => void }) {
  const center = alert.align === 'center'
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onDismiss()}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} className={cn('sm:max-w-lg', center && 'text-center')}>
        <DialogHeader className={cn('pr-0', center && 'items-center')}>
          <DialogTitle className="text-xl">{alert.title}</DialogTitle>
          <DialogDescription asChild>
            <p className="text-base whitespace-pre-line text-foreground/80">{alert.text}</p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className={cn(center && 'sm:justify-center')}>
          <Button size="lg" onClick={onDismiss}>
            {alert.button_text || judgeText.alert.defaultButton}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
