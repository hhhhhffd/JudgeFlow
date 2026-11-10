import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { errorText } from '@/lib/errors'

const SKIP_CONFIRMATION_KEY = 'jf.access.skip-delete-confirmation'

export function DeleteButton({ label, title, description, onDelete }: {
  label: string
  title: string
  description: string
  onDelete: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [remember, setRemember] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(skipNextTime: boolean) {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await onDelete()
      if (skipNextTime) {
        try {
          localStorage.setItem(SKIP_CONFIRMATION_KEY, 'true')
        } catch {
          toast.error('Удалено, но сохранить настройку подтверждения не удалось')
        }
      }
      setOpen(false)
    } catch (cause) {
      const message = errorText(cause)
      setError(message)
      if (!open) toast.error(message)
    } finally {
      setPending(false)
    }
  }

  function requestDelete() {
    let skip = false
    try {
      skip = localStorage.getItem(SKIP_CONFIRMATION_KEY) === 'true'
    } catch (cause) {
      console.warn('access: delete confirmation preference unavailable', cause)
    }
    if (skip) {
      void remove(false)
    } else {
      setRemember(false)
      setError(null)
      setOpen(true)
    }
  }

  return (
    <>
      <Button size="icon" variant="ghost" aria-label={label} disabled={pending} onClick={requestDelete}><Trash2 className="size-4 text-destructive" /></Button>
      <Dialog open={open} onOpenChange={(value) => { if (!pending) setOpen(value) }}>
        <DialogContent>
          <DialogHeader><DialogTitle className="break-words">{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={remember} disabled={pending} onChange={(event) => setRemember(event.target.checked)} />
            Больше не спрашивать
          </label>
          <p className="text-xs text-muted-foreground">Для удаления команд, участников и вопросов в этом браузере.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="ghost" autoFocus disabled={pending} onClick={() => setOpen(false)}>Отмена</Button>
            <Button variant="destructive" disabled={pending} onClick={() => void remove(remember)}>{pending ? 'Удаление…' : 'Удалить'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
