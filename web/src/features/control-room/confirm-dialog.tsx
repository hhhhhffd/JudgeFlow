import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ru } from '@/i18n/ru'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: string | null
  /** Shows a reason field; confirm is disabled while it is empty. */
  reasonLabel?: string
  /** Shows a field that must equal this text exactly before confirm is enabled. */
  typeToConfirm?: { text: string; label: string }
  children?: ReactNode
  onConfirm: (reason: string) => void
}

/** Confirmation dialog; the form remounts on every open so fields start empty. */
export function ConfirmDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>{props.open && <ConfirmForm {...props} />}</DialogContent>
    </Dialog>
  )
}

function ConfirmForm({ onOpenChange, title, description, confirmLabel, destructive, pending, error, reasonLabel, typeToConfirm, children, onConfirm }: Props) {
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const ready = (!reasonLabel || reason.trim().length > 0) && (!typeToConfirm || typed === typeToConfirm.text)

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onConfirm(reason.trim())
      }}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      {reasonLabel && (
        <div className="grid gap-1.5">
          <Label htmlFor="confirm-reason">{reasonLabel}</Label>
          <Textarea id="confirm-reason" rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      {typeToConfirm && (
        <div className="grid gap-1.5">
          <Label htmlFor="confirm-typed">{typeToConfirm.label}</Label>
          <Input id="confirm-typed" autoFocus autoComplete="off" placeholder={typeToConfirm.text} value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          {ru.common.cancel}
        </Button>
        <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={!ready || pending}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
