import type { ReactNode } from 'react'
import { Logo } from '@/components/logo'
import { ru } from '@/i18n/ru'

const BARS = [38, 62, 84, 51, 72]

/** Centered form on the right, quiet ink panel with a score-scale motif on large screens. */
export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside aria-hidden className="relative hidden overflow-hidden bg-[oklch(0.27_0.06_255)] text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Logo className="text-white" />
        <div className="flex h-64 items-end gap-4">
          {BARS.map((h, i) => (
            <div key={i} className="flex-1 rounded-t-md bg-white/10" style={{ height: `${h}%` }}>
              {i === 2 && <div className="h-1.5 w-full rounded-t-md bg-signal" />}
            </div>
          ))}
        </div>
        <div>
          <div className="ticks mb-4 h-3 w-full text-white opacity-40 invert" />
          <p className="max-w-xs text-2xl leading-snug font-medium text-balance">{ru.auth.tagline}</p>
        </div>
      </aside>
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm space-y-6">
          <Logo className="lg:hidden" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="text-sm text-muted-foreground">{footer}</div>}
        </div>
      </main>
    </div>
  )
}
