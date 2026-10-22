import { useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { Criterion } from '@/api/types'
import { Input } from '@/components/ui/input'
import { judgeText } from '@/i18n/judge'
import { formatX100 } from '@/lib/format'
import { cn } from '@/lib/utils'
import { commitDraft, scaleOf, stepValue } from './scoring'

interface Props {
  scale: Pick<Criterion, 'max_x100' | 'step_x100'>
  value: number | null
  disabled: boolean
  /** Accessible name of the whole control. */
  label: string
  onChange: (value: number | null) => void
}

export function ScoreInput({ scale, value, disabled, label, onChange }: Props) {
  const shape = scaleOf(scale)
  if (shape.kind === 'segmented') {
    return (
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {shape.values.map((v) => {
          const selected = v === value
          return (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={cn(
                'num min-h-11 min-w-11 flex-1 rounded-md border px-2 text-base font-semibold transition-[background-color,color,border-color,transform] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] disabled:active:scale-100 sm:flex-none sm:min-w-12',
                selected
                  ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                  : 'border-input bg-card hover:bg-accent disabled:hover:bg-card',
                disabled && !selected && 'opacity-60',
              )}
            >
              {formatX100(v)}
            </button>
          )
        })}
      </div>
    )
  }
  return <NumericInput scale={scale} value={value} disabled={disabled} label={label} onChange={onChange} />
}

function NumericInput({ scale, value, disabled, label, onChange }: Props) {
  // While typing, the draft is the source of truth; otherwise the stored value is.
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === null ? '' : formatX100(value))
  const invalid = draft !== null && commitDraft(draft, scale).kind === 'invalid'

  // Committing only when the judge is done typing: "15" on a 0-10 scale must not store "1" on the way.
  function commit() {
    if (draft === null) return
    const result = commitDraft(draft, scale)
    if (result.kind === 'invalid') return
    setDraft(null)
    if (result.value !== value) onChange(result.value)
  }

  function step(dir: 1 | -1) {
    setDraft(null)
    onChange(stepValue(value, dir, scale))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div role="group" aria-label={label} className="flex items-center gap-2">
        <StepButton label={judgeText.item.minus} disabled={disabled || value === 0} onClick={() => step(-1)}>
          <Minus />
        </StepButton>
        <Input
          inputMode="decimal"
          autoComplete="off"
          aria-label={label}
          aria-invalid={invalid}
          disabled={disabled}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="num h-11 w-28 text-center text-lg font-semibold md:text-lg"
        />
        <StepButton label={judgeText.item.plus} disabled={disabled || value === scale.max_x100} onClick={() => step(1)}>
          <Plus />
        </StepButton>
        <span className="num text-sm text-muted-foreground">/ {formatX100(scale.max_x100)}</span>
      </div>
      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {judgeText.item.range(formatX100(scale.max_x100), formatX100(scale.step_x100))}
        </p>
      )}
    </div>
  )
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-input bg-card transition-[background-color,transform] duration-150 outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-5"
    >
      {children}
    </button>
  )
}
