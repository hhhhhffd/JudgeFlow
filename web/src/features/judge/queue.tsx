import { useMemo, useState } from 'react'
import { AlertTriangle, Check, CloudUpload, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { judgeText } from '@/i18n/judge'
import { cn } from '@/lib/utils'
import { itemProgress, type Rows } from './scoring'
import type { Criterion, ScoringMode, Team } from '@/api/types'

interface Props {
  mode: ScoringMode
  heading: string
  items: { id: string; name: string }[]
  teams: Team[]
  criteria: Criterion[]
  rows: Rows
  currentId: string | undefined
  progress: { done: number; total: number }
  onSelect: (id: string) => void
}

export function Queue({ mode, heading, items, teams, criteria, rows, currentId, progress, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items
  }, [items, query])
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{heading}</h2>
          <span className="num text-xs text-muted-foreground">{judgeText.queue.progress(progress.done, progress.total)}</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={judgeText.queue.progress(progress.done, progress.total)}
          className="h-1.5 overflow-hidden rounded-full bg-secondary"
        >
          <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={judgeText.queue.searchPlaceholder}
          aria-label={judgeText.queue.search}
          className="h-10 pl-9"
        />
      </div>
      <ul className="-mx-1 min-h-0 flex-1 space-y-1 overflow-y-auto px-1 pb-2">
        {shown.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">{judgeText.queue.nothingFound}</li>}
        {shown.map((item) => {
          const p = itemProgress(mode, item.id, teams, criteria, rows)
          const complete = p.total > 0 && p.done === p.total
          const current = item.id === currentId
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(item.id)}
                className={cn(
                  'flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  current ? 'border-primary/40 bg-accent' : 'border-transparent hover:bg-accent/60',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    complete ? 'bg-success-soft text-success' : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  {complete ? <Check className="size-3.5" aria-label={judgeText.queue.itemDone} /> : <span className="num">{p.done}</span>}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                {p.error ? (
                  <AlertTriangle className="size-4 shrink-0 text-destructive" aria-label={judgeText.queue.itemError} />
                ) : p.pending ? (
                  <CloudUpload className="size-4 shrink-0 text-warning" aria-label={judgeText.queue.itemPending} />
                ) : null}
                <span className="num shrink-0 text-xs text-muted-foreground">{judgeText.queue.itemProgress(p.done, p.total)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
