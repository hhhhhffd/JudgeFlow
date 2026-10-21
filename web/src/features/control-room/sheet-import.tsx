import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp } from 'lucide-react'
import { eventsApi } from '@/api/endpoints'
import { SHEET_FORMAT, type PutScoresResponse, type SheetFile } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cr } from '@/i18n/control-room'
import { errorText } from '@/lib/errors'
import { useFull } from './context'

const MAX_LISTED = 50

interface Outcome {
  judge: string
  results: PutScoresResponse['results']
}

/** Reads a file as a judge sheet; returns the error text for files that cannot be one. */
function parseSheet(text: string, eventId: string): { sheet: SheetFile } | { error: string } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { error: cr.sheet.notJson }
  }
  const sheet = data as Partial<SheetFile> | null
  if (!sheet || typeof sheet !== 'object' || sheet.format !== SHEET_FORMAT || !Array.isArray(sheet.items) || typeof sheet.token !== 'string') return { error: cr.sheet.wrongFormat }
  if (sheet.event_id !== eventId) return { error: cr.sheet.wrongEvent }
  return { sheet: sheet as SheetFile }
}

export function SheetImport() {
  const { event, teams, criteria } = useFull()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const frozen = event.status === 'finalized' || event.status === 'published'

  const send = useMutation({
    mutationFn: (sheet: SheetFile) => eventsApi.importSheet(event.id, sheet).then((r) => ({ judge: sheet.judge_name, results: r.results })),
    onSuccess: (o) => {
      setOutcome(o)
      void qc.invalidateQueries({ queryKey: ['cr', event.id] })
    },
  })

  async function onFile(file: File | undefined) {
    if (!file) return
    setOutcome(null)
    send.reset()
    const parsed = parseSheet(await file.text(), event.id)
    if ('error' in parsed) {
      setFileError(parsed.error)
      return
    }
    setFileError(null)
    send.mutate(parsed.sheet)
  }

  const count = (status: string) => outcome?.results.filter((r) => r.status === status).length ?? 0
  const rejected = outcome?.results.filter((r) => r.status === 'rejected') ?? []

  return (
    <section aria-labelledby="sheet-h" className="grid gap-3 rounded-xl border bg-card p-5">
      <div>
        <h2 id="sheet-h" className="text-base font-semibold">
          {cr.sheet.title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{frozen ? cr.sheet.frozen : cr.sheet.text}</p>
      </div>
      <div>
        <input ref={input} type="file" accept="application/json,.json" aria-label={cr.sheet.fileLabel} className="sr-only" tabIndex={-1} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
        <Button variant="outline" disabled={frozen || send.isPending} onClick={() => input.current?.click()}>
          <FileUp />
          {send.isPending ? cr.sheet.reading : cr.sheet.choose}
        </Button>
      </div>
      {fileError && <p role="alert" className="text-sm text-destructive">{fileError}</p>}
      {send.isError && <p role="alert" className="text-sm text-destructive">{errorText(send.error)}</p>}
      {outcome && (
        <div role="status" className="grid gap-2 text-sm">
          <p className="font-medium">{cr.sheet.resultTitle(outcome.judge)}</p>
          {outcome.results.length === 0 && <p className="text-muted-foreground">{cr.sheet.empty}</p>}
          <div className="flex flex-wrap gap-2">
            <Badge variant="success">{cr.sheet.ok(count('ok'))}</Badge>
            <Badge variant="secondary">{cr.sheet.stale(count('stale'))}</Badge>
            <Badge variant={rejected.length > 0 ? 'destructive' : 'secondary'}>{cr.sheet.rejected(rejected.length)}</Badge>
          </div>
          {count('stale') > 0 && <p className="text-muted-foreground">{cr.sheet.staleHint}</p>}
          {rejected.length > 0 && (
            <div>
              <p className="mb-1 font-medium">{cr.sheet.rejectedTitle}</p>
              <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
                {rejected.slice(0, MAX_LISTED).map((r) => (
                  <li key={`${r.team_id}:${r.criterion_id}`} className="px-3 py-1.5">
                    {cr.sheet.reason(
                      teams.find((t) => t.id === r.team_id)?.name ?? '—',
                      criteria.find((c) => c.id === r.criterion_id)?.name ?? '—',
                      cr.sheet.reasons[r.error ?? ''] ?? cr.sheet.reasons.fallback!,
                    )}
                  </li>
                ))}
              </ul>
              {rejected.length > MAX_LISTED && <p className="mt-1 text-xs text-muted-foreground">…</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
