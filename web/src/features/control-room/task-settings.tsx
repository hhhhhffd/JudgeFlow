import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { createAccessApi } from '@/api/endpoints'
import { ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { ParticipantsSettings, QuestionsSettings } from '@/features/access/workspace'
import { errorText } from '@/lib/errors'
import { useFull } from './context'

const titles = { questions: 'Вопросы', participants: 'Участники' }

export function TaskSettings({ section }: { section: keyof typeof titles }) {
  const { event } = useFull()
  const client = useQueryClient()
  const api = useMemo(() => createAccessApi(event.id), [event.id])
  const queryKey = ['cr', event.id, 'task-workspace']
  const query = useQuery({ queryKey, queryFn: api.workspace, retry: false })
  if (query.isPending) return <Skeleton className="h-64" />
  if (query.isError) return <ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} />
  const props = { data: query.data, api, refresh: () => client.invalidateQueries({ queryKey }) }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="sm"><Link to={`/events/${event.id}/setup`}><ArrowLeft className="size-4" />Назад</Link></Button>
        <h2 className="text-lg font-semibold">{titles[section]}</h2>
      </div>
      {section === 'participants' && query.data.event.phase !== 'setup' && (
        <p className="rounded-xl border bg-muted/50 p-4 text-sm text-muted-foreground">Участники уже выполняют задания. Управление доступом находится во <Link className="underline underline-offset-4" to={`/events/${event.id}/questions`}>вопросах</Link>.</p>
      )}
      {section === 'questions' && <QuestionsSettings {...props} />}
      {section === 'participants' && <ParticipantsSettings {...props} />}
    </div>
  )
}
