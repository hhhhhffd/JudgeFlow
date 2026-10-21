import { createContext, useContext, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { EventFull } from '@/api/types'
import { errorText } from '@/lib/errors'

export const EventContext = createContext<EventFull | null>(null)

export function useFull(): EventFull {
  const full = useContext(EventContext)
  if (!full) throw new Error('useFull outside of the event layout')
  return full
}

/** Mutation that refreshes every query of this event (and the event list) and toasts failures. */
export function useEventMutation<V, R>(mutationFn: (v: V) => Promise<R>, successMessage?: string) {
  const qc = useQueryClient()
  const { event } = useFull()
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['cr', event.id] })
      void qc.invalidateQueries({ queryKey: ['events'] })
      if (successMessage) toast.success(successMessage)
    },
    onError: (e) => toast.error(errorText(e)),
  })
}

/** Only drafts allow composition changes (SPEC §4). */
export function useIsDraft() {
  return useFull().event.status === 'draft'
}

/** Current time, refreshed every 30 s, for relative "last seen" labels. */
export function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}
