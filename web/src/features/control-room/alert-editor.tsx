import { useState } from 'react'
import { eventsApi } from '@/api/endpoints'
import type { AlertAlign } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cr } from '@/i18n/control-room'
import { cn } from '@/lib/utils'
import { useEventMutation, useFull } from './context'

export function AlertEditor() {
  const { event } = useFull()
  const [enabled, setEnabled] = useState(event.alert_enabled)
  const [title, setTitle] = useState(event.alert_title)
  const [text, setText] = useState(event.alert_text)
  const [align, setAlign] = useState<AlertAlign>(event.alert_align)
  const [button, setButton] = useState(event.alert_button_text)
  const save = useEventMutation(
    () => eventsApi.update(event.id, { alert_enabled: enabled, alert_title: title.trim(), alert_text: text.trim(), alert_align: align, alert_button_text: button.trim() }),
    cr.setup.saved,
  )

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form
        className="grid content-start gap-4 rounded-xl border bg-card p-5"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate(undefined)
        }}
      >
        <div>
          <h2 className="text-base font-semibold">{cr.alert.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{cr.alert.text}</p>
        </div>
        <div className="flex items-center gap-3">
          <Switch id="a-on" checked={enabled} onCheckedChange={setEnabled} />
          <Label htmlFor="a-on">{cr.alert.enabled}</Label>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-title">{cr.alert.titleLabel}</Label>
          <Input id="a-title" maxLength={120} placeholder={cr.alert.titlePlaceholder} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-text">{cr.alert.bodyLabel}</Label>
          <Textarea id="a-text" rows={5} placeholder={cr.alert.bodyPlaceholder} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div role="group" aria-labelledby="a-align" className="grid gap-1.5">
          <span id="a-align" className="text-sm font-medium">{cr.alert.alignLabel}</span>
          <div className="inline-flex w-fit rounded-lg border p-0.5">
            {(['left', 'center'] as const).map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={align === a}
                onClick={() => setAlign(a)}
                className={cn('h-8 rounded-md px-4 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', align === a ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
              >
                {a === 'left' ? cr.alert.left : cr.alert.center}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="a-btn">{cr.alert.buttonLabel}</Label>
          <Input id="a-btn" maxLength={60} placeholder={cr.alert.buttonPlaceholder} value={button} onChange={(e) => setButton(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">{cr.alert.versionNote(event.alert_version)}</p>
        <div>
          <Button type="submit" disabled={save.isPending}>
            {cr.alert.save}
          </Button>
        </div>
      </form>

      <section aria-labelledby="a-prev" className="content-start">
        <h2 id="a-prev" className="mb-3 text-base font-semibold">{cr.alert.preview}</h2>
        <div className="rounded-xl border bg-muted/50 p-4 sm:p-8">
          <div className={cn('mx-auto grid max-w-sm gap-3 rounded-2xl border bg-card p-6 shadow-md', align === 'center' ? 'text-center' : 'text-left', !enabled && 'opacity-50')}>
            {title.trim() || text.trim() ? (
              <>
                {title.trim() && <h3 className="text-lg font-semibold break-words">{title}</h3>}
                {text.trim() && <p className="text-sm whitespace-pre-line break-words text-muted-foreground">{text}</p>}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{cr.alert.previewEmpty}</p>
            )}
            <span className="mt-1 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
              {button.trim() || cr.alert.buttonPlaceholder}
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}
