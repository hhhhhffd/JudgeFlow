import { cr } from '@/i18n/control-room'
import { formatX100 } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CRITERIA_TEMPLATES, type CriteriaTemplate } from './templates'

/** Radio list of presets with a preview of the chosen one. */
export function TemplatePicker({ value, onChange, label }: { value: string; onChange: (id: CriteriaTemplate['id']) => void; label: string }) {
  const current = CRITERIA_TEMPLATES.find((t) => t.id === value)
  return (
    <div className="grid gap-3">
      <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-3">
        {CRITERIA_TEMPLATES.map((t) => (
          <label key={t.id} className={cn('flex cursor-pointer flex-col gap-0.5 rounded-lg border p-3 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50', value === t.id && 'border-primary bg-accent/50')}>
            <input type="radio" name="criteria-template" className="sr-only" checked={value === t.id} onChange={() => onChange(t.id)} />
            <span className="text-sm font-medium">{t.name}</span>
            <span className="num text-xs text-muted-foreground">{cr.setup.templateCriteria(t.criteria.length)}</span>
          </label>
        ))}
      </div>
      {current && (
        <div>
          <p className="mb-1.5 text-sm text-muted-foreground">{current.description}</p>
          <ul className="divide-y rounded-lg border text-sm">
            {current.criteria.map((c) => (
              <li key={c.name} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                <span className="min-w-0 truncate">{c.name}</span>
                <span className="num shrink-0 text-xs text-muted-foreground">{cr.setup.criterionSummary(formatX100(c.max_x100), formatX100(c.step_x100), c.weight)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
