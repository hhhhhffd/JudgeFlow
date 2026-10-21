import { useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { eventsApi, publicApi } from '@/api/endpoints'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cr } from '@/i18n/control-room'
import { useEventMutation, useFull } from './context'

const MAX_BYTES = 5 * 1024 * 1024
const TYPES = ['image/png', 'image/jpeg', 'image/webp']

export function Appearance() {
  const { event } = useFull()
  const input = useRef<HTMLInputElement>(null)
  const [broken, setBroken] = useState(false)
  const [enabled, setEnabled] = useState(event.overlay_enabled)
  const [color, setColor] = useState(event.overlay_color)
  const [opacity, setOpacity] = useState(event.overlay_opacity)

  const upload = useEventMutation((f: File) => eventsApi.uploadBackground(event.id, f), cr.setup.saved)
  const remove = useEventMutation(() => eventsApi.removeBackground(event.id), cr.setup.saved)
  const save = useEventMutation(
    () => eventsApi.update(event.id, { overlay_enabled: enabled, overlay_color: color, overlay_opacity: opacity }),
    cr.setup.saved,
  )

  const hasBackground = event.background_file != null
  const bgUrl = `${publicApi.backgroundUrl(event.id)}?v=${event.updated_at}`

  function onPick(file: File | undefined) {
    if (input.current) input.current.value = ''
    if (!file) return
    if (!TYPES.includes(file.type)) return void toast.error(cr.appearance.badType)
    if (file.size > MAX_BYTES) return void toast.error(cr.appearance.tooBig)
    setBroken(false)
    upload.mutate(file)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid content-start gap-6">
        <section aria-labelledby="bg-h" className="grid gap-3 rounded-xl border bg-card p-5">
          <div>
            <h2 id="bg-h" className="text-base font-semibold">{cr.appearance.background}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{cr.appearance.text} {cr.appearance.backgroundHint}</p>
          </div>
          <input ref={input} type="file" accept={TYPES.join(',')} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => onPick(e.target.files?.[0])} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={upload.isPending} onClick={() => input.current?.click()}>
              <ImagePlus />
              {hasBackground ? cr.appearance.replace : cr.appearance.upload}
            </Button>
            {hasBackground && (
              <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
                <Trash2 />
                {cr.appearance.remove}
              </Button>
            )}
          </div>
        </section>

        <form
          className="grid gap-4 rounded-xl border bg-card p-5"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate(undefined)
          }}
        >
          <div>
            <h2 className="text-base font-semibold">{cr.appearance.overlay}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{cr.appearance.overlayHint}</p>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="o-on" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="o-on">{cr.appearance.overlayEnabled}</Label>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="o-color">{cr.appearance.overlayColor}</Label>
            <input id="o-color" type="color" disabled={!enabled} value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 cursor-pointer rounded-md border bg-card p-1 disabled:opacity-50" />
            <span className="num font-mono text-xs text-muted-foreground">{color}</span>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="o-opacity">{cr.appearance.overlayOpacity(opacity)}</Label>
            <input id="o-opacity" type="range" min={0} max={100} step={5} disabled={!enabled} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full accent-[var(--primary)]" />
          </div>
          <div>
            <Button type="submit" disabled={save.isPending}>{cr.appearance.save}</Button>
          </div>
        </form>
      </div>

      <section aria-labelledby="pv-h" className="content-start">
        <h2 id="pv-h" className="mb-3 text-base font-semibold">{cr.appearance.preview}</h2>
        <div className="relative isolate flex aspect-video items-center justify-center overflow-hidden rounded-xl border bg-muted">
          {hasBackground && !broken ? (
            <img src={bgUrl} alt="" className="absolute inset-0 -z-20 size-full object-cover" onError={() => setBroken(true)} />
          ) : (
            <p className="absolute top-3 left-3 -z-10 max-w-[80%] text-xs text-muted-foreground">
              {hasBackground ? cr.appearance.previewUnavailable : cr.appearance.noBackground}
            </p>
          )}
          {enabled && <div className="absolute inset-0 -z-10" style={{ backgroundColor: color, opacity: opacity / 100 }} />}
          <p className="rounded-lg bg-card/90 px-4 py-2 text-sm font-medium shadow-sm">{cr.appearance.previewSample}</p>
        </div>
      </section>
    </div>
  )
}
