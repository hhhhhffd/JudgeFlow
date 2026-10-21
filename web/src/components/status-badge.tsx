import type { ComponentProps } from 'react'
import type { EventStatus } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { ru } from '@/i18n/ru'

const VARIANT: Record<EventStatus, ComponentProps<typeof Badge>['variant']> = {
  draft: 'secondary',
  judging: 'info',
  locked: 'warning',
  finalized: 'success',
  published: 'default',
}

export function StatusBadge({ status, className }: { status: EventStatus; className?: string }) {
  return (
    <Badge variant={VARIANT[status]} className={className}>
      {ru.status[status]}
    </Badge>
  )
}
