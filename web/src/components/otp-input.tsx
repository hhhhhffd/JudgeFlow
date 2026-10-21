import { useRef } from 'react'
import { ru } from '@/i18n/ru'
import { cn } from '@/lib/utils'

const LENGTH = 6

/**
 * Six-box one-time-code input. Value is a contiguous digit string; supports
 * paste, OS autofill (one-time-code) and Backspace/Arrow navigation.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onComplete?: (v: string) => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const focus = (i: number) => refs.current[Math.max(0, Math.min(LENGTH - 1, i))]?.focus()

  function update(next: string, focusAt: number) {
    onChange(next)
    focus(focusAt)
    if (next.length === LENGTH) onComplete?.(next)
  }

  return (
    <div role="group" aria-label={ru.otp.label} className="flex items-center gap-2">
      {Array.from({ length: LENGTH }, (_, i) => (
        <div key={i} className="contents">
          {i === 3 && <span aria-hidden className="h-0.5 w-2 rounded bg-border" />}
          <input
            ref={(el) => {
              refs.current[i] = el
            }}
            value={value[i] ?? ''}
            inputMode="numeric"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={LENGTH}
            disabled={disabled}
            autoFocus={autoFocus && i === 0}
            aria-label={ru.otp.digit(i + 1)}
            aria-invalid={invalid || undefined}
            onFocus={(e) => e.currentTarget.select()}
            onMouseDown={(e) => {
              // Keep the caret on the first empty box (pointer only: programmatic focus runs before state updates).
              if (i > value.length) {
                e.preventDefault()
                focus(value.length)
              }
            }}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '')
              if (!digits) return
              const next = (value.slice(0, i) + digits).slice(0, LENGTH)
              update(next, next.length < LENGTH ? next.length : LENGTH - 1)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace') {
                e.preventDefault()
                if (value[i]) update(value.slice(0, i), i)
                else if (i > 0) update(value.slice(0, i - 1), i - 1)
              } else if (e.key === 'ArrowLeft') {
                e.preventDefault()
                focus(i - 1)
              } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                focus(i + 1)
              }
            }}
            className={cn(
              'num h-14 w-11 rounded-lg border border-input bg-card text-center font-mono text-2xl font-medium shadow-xs transition-[border-color,box-shadow] outline-none sm:w-12',
              'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
              'aria-invalid:border-destructive aria-invalid:ring-destructive/20 disabled:opacity-50',
            )}
          />
        </div>
      ))}
    </div>
  )
}
