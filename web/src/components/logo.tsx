import { ru } from '@/i18n/ru'
import { cn } from '@/lib/utils'

/** `compact` hides the wordmark below the sm breakpoint (the icon alone remains). */
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold tracking-tight', className)}>
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-primary" />
        <path d="M8 22h16M8 22V10m4 12v-5m4 5v-8m4 8v-3m4 3v-6" strokeWidth="2.4" strokeLinecap="round" fill="none" className="stroke-signal" />
      </svg>
      <span className={cn(compact && 'max-sm:sr-only')}>{ru.app.name}</span>
    </span>
  )
}
