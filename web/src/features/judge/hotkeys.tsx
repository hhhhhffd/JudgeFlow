import { useEffect, useRef } from 'react'
import { Keyboard } from 'lucide-react'
import { Popover } from 'radix-ui'
import { judgeText } from '@/i18n/judge'
import { resolveDigit } from './scoring'

export interface HotkeyActions {
  enabled: boolean
  /** Number of scale positions of the active line when it is segmented, else 0. */
  positions: number
  onPosition: (index: number) => void
  onItem: (delta: -1 | 1) => void
  onLine: (delta: -1 | 1) => void
  onSubmit: () => void
}

export function isTyping(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
}

export function useHotkeys(actions: HotkeyActions) {
  const ref = useRef(actions)
  const lastDigit = useRef<{ digit: number; at: number } | null>(null)
  useEffect(() => {
    ref.current = actions
  })

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const a = ref.current
      if (!a.enabled || e.defaultPrevented || isTyping(e.target)) return
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        a.onSubmit()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        a.onItem(e.key === 'ArrowLeft' ? -1 : 1)
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        a.onLine(e.key === 'ArrowUp' ? -1 : 1)
      } else if (/^[0-9]$/.test(e.key) && a.positions > 0) {
        const digit = Number(e.key)
        const now = Date.now()
        const index = resolveDigit(digit, lastDigit.current, now, a.positions)
        lastDigit.current = { digit, at: now }
        if (index !== null) a.onPosition(index)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function HotkeysHelp({ rows = judgeText.hotkeys.rows }: { rows?: readonly (readonly [string, string])[] }) {
  const t = judgeText.hotkeys
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={t.button}
        className="hidden size-9 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 lg:inline-flex"
      >
        <Keyboard className="size-5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-80 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
          <h2 className="mb-3 text-sm font-semibold">{t.title}</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
            {rows.map(([keys, what]) => (
              <div key={keys} className="contents">
                <dt>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs whitespace-nowrap">{keys}</kbd>
                </dt>
                <dd className="text-muted-foreground">{what}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">{t.note}</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
