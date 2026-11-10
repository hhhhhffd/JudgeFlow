import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { accessApi } from '@/api/endpoints'
import type { AccessAnswer, AccessQuestion, AccessWorkspace } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { errorText } from '@/lib/errors'

export function ParticipantWorkspace({ data }: { data: AccessWorkspace }) {
  const client = useQueryClient()
  const user = data.current_user
  const questions = data.questions.filter((question) => question.audience === user.role)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const onSavingChange = useCallback((id: string, value: boolean) => setSaving((current) => ({ ...current, [id]: value })), [])
  const submitted = data.users.find((item) => item.id === user.id)?.submitted
  const teachersDone = data.users.some((item) => item.team_id === user.team_id && item.role === 'teacher' && item.submitted)
  const locked = user.role === 'teacher' ? data.event.phase !== 'teachers' : data.event.phase !== 'students' || !teachersDone
  const pending = Object.values(saving).some(Boolean)
  const complete = questions.length > 0 && questions.every((question) => {
    const answer = data.team_draft.find((item) => item.question_id === question.id)
    return !question.required || (question.kind === 'text' ? Boolean(answer?.text.trim()) : Boolean(answer?.option_ids.length))
  })
  const submit = useMutation({
    mutationFn: accessApi.submit,
    onSuccess: () => client.invalidateQueries({ queryKey: ['access-workspace'] }),
  })
  if (submitted) return <div className="mx-auto mt-20 max-w-lg text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-success-soft text-success"><Check className="size-8" /></div><h1 className="mt-5 text-3xl font-semibold">Ответы приняты</h1><p className="mt-2 text-muted-foreground">Статус уже виден организатору и жюри.</p></div>
  if (locked) return <div className="mx-auto mt-20 max-w-lg text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-warning-soft text-warning"><ChevronDown className="size-8" /></div><h1 className="mt-5 text-3xl font-semibold">Задание пока закрыто</h1><p className="mt-2 text-muted-foreground">{user.role === 'student' && data.event.phase === 'students' ? 'Ждём, пока педагоги вашей команды сдадут работу.' : 'Организатор ещё не открыл ваш этап.'}</p></div>
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{user.role === 'teacher' ? 'Педагоги' : 'Студенты'} · общая работа команды</p><h1 className="mt-2 text-3xl font-semibold">Ответьте на вопросы</h1><p className="mt-2 text-sm text-muted-foreground">Ответы сохраняются автоматически и видны вашей команде. Звёздочкой отмечены обязательные вопросы.</p></div>
      {questions.map((question, index) => <AnswerField key={question.id} question={question} index={index} shared={data.team_draft.find((item) => item.question_id === question.id)} onSavingChange={onSavingChange} />)}
      {submit.isError && <p role="alert" className="text-sm text-destructive">{errorText(submit.error)}</p>}
      <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-4 rounded-xl bg-primary p-4 text-primary-foreground shadow-xl">
        <div className="text-sm"><p>После отправки изменить ответы нельзя.</p><p aria-live="polite" className="mt-1 opacity-80">{pending ? 'Сохраняем изменения…' : complete ? 'Все обязательные вопросы заполнены.' : 'Заполните обязательные вопросы.'}</p></div>
        <Button variant="secondary" disabled={!complete || pending || submit.isPending} onClick={() => submit.mutate()}>Сдать работу</Button>
      </div>
    </div>
  )
}

function AnswerField({ question, index, shared, onSavingChange }: {
  question: AccessQuestion
  index: number
  shared: AccessWorkspace['team_draft'][number] | undefined
  onSavingChange: (id: string, pending: boolean) => void
}) {
  const client = useQueryClient()
  const [local, setLocal] = useState<AccessAnswer | null>(null)
  const { mutate, isPending, isError, error } = useMutation({
    mutationKey: ['access-draft', question.id],
    scope: { id: `access-draft:${question.id}` },
    mutationFn: accessApi.saveTeamDraft,
    onSuccess: async (_, saved) => {
      await client.invalidateQueries({ queryKey: ['access-workspace'] })
      setLocal((current) => current === saved ? null : current)
    },
  })
  useEffect(() => {
    if (!local) return
    const timer = window.setTimeout(() => mutate(local), question.kind === 'text' ? 400 : 0)
    return () => window.clearTimeout(timer)
  }, [local, mutate, question.kind])
  useEffect(() => {
    onSavingChange(question.id, local !== null || isPending)
  }, [local, isPending, onSavingChange, question.id])
  const answer = local ?? shared ?? { question_id: question.id, option_ids: [], text: '' }
  const hint = question.kind === 'text' ? 'Напишите развёрнутый ответ' : question.kind === 'multiple_choice' ? 'Можно выбрать несколько вариантов' : 'Выберите один вариант'
  return (
    <Card>
      <CardHeader><CardTitle id={`question-${question.id}`} className="break-words text-lg"><span className="mr-2 text-primary">{index + 1}.</span>{question.prompt}{question.required && <span className="ml-1 text-destructive" aria-label="Обязательный вопрос">*</span>}</CardTitle><CardDescription>{hint}{shared && <span className="mt-1 block">Последнее изменение: {shared.edited_by_name}</span>}</CardDescription></CardHeader>
      <CardContent className="grid gap-2">
        {question.kind === 'text' ? (
          <><Textarea aria-labelledby={`question-${question.id}`} aria-required={question.required} rows={7} maxLength={20000} placeholder="Ваш ответ" value={answer.text} onChange={(event) => setLocal({ question_id: question.id, option_ids: [], text: event.target.value })} /><p className="text-right text-xs text-muted-foreground">{answer.text.length} / 20 000</p></>
        ) : (
          <div role={question.kind === 'single_choice' ? 'radiogroup' : 'group'} aria-labelledby={`question-${question.id}`} className="grid gap-2">
            {question.options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent"><input className="size-4 shrink-0 accent-primary" type={question.kind === 'single_choice' ? 'radio' : 'checkbox'} name={question.id} value={option.id} checked={answer.option_ids.includes(option.id)} onChange={(event) => setLocal({ question_id: question.id, option_ids: question.kind === 'single_choice' ? [option.id] : event.target.checked ? [...answer.option_ids, option.id] : answer.option_ids.filter((id) => id !== option.id), text: '' })} /><span className="min-w-0 break-words">{option.label}</span></label>)}
          </div>
        )}
        {isError && <div role="alert" className="text-sm text-destructive"><p>{errorText(error)}</p><Button variant="outline" size="sm" className="mt-2" onClick={() => { if (local) mutate(local) }}>Повторить сохранение</Button></div>}
      </CardContent>
    </Card>
  )
}
