import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { accessApi } from '@/api/endpoints'
import type { AccessQuestion, QuestionKind } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorText } from '@/lib/errors'

export function QuestionEditor({ question, api, onSaved, onCancel }: {
  question?: AccessQuestion
  api: typeof accessApi
  onSaved: () => void
  onCancel?: () => void
}) {
  const [audience, setAudience] = useState<'teacher' | 'student'>(question?.audience ?? 'teacher')
  const [kind, setKind] = useState<QuestionKind>(question?.kind ?? 'single_choice')
  const [required, setRequired] = useState(question?.required ?? true)
  const [prompt, setPrompt] = useState(question?.prompt ?? '')
  const [options, setOptions] = useState<{ id?: string; label: string }[]>(question?.options.length ? question.options : [{ label: '' }, { label: '' }])
  const save = useMutation({
    mutationFn: async () => {
      const values = kind === 'text' ? [] : options.map((option) => ({ ...option, label: option.label.trim() }))
      const body = { audience, kind, required, prompt: prompt.trim() }
      if (question) await api.updateQuestion(question.id, { ...body, options: values })
      else await api.createQuestion({ ...body, options: values.map((option) => option.label) })
    },
    onSuccess: () => {
      if (!question) { setPrompt(''); setOptions([{ label: '' }, { label: '' }]) }
      onSaved()
    },
  })
  const submit = (event: FormEvent) => { event.preventDefault(); if (!save.isPending) save.mutate() }
  const prefix = question?.id ?? 'new'
  return (
    <form className="grid gap-3 rounded-lg border bg-muted/35 p-3" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5"><Label htmlFor={`${prefix}-audience`}>Для кого</Label><Select value={audience} onValueChange={(value) => setAudience(value as 'teacher' | 'student')}><SelectTrigger id={`${prefix}-audience`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="teacher">Педагоги</SelectItem><SelectItem value="student">Студенты</SelectItem></SelectContent></Select></div>
        <div className="grid gap-1.5"><Label htmlFor={`${prefix}-kind`}>Тип вопроса</Label><Select value={kind} onValueChange={(value) => setKind(value as QuestionKind)}><SelectTrigger id={`${prefix}-kind`} className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single_choice">Один вариант</SelectItem><SelectItem value="multiple_choice">Несколько вариантов</SelectItem><SelectItem value="text">Развёрнутый ответ</SelectItem></SelectContent></Select></div>
      </div>
      <div className="grid gap-1.5"><Label htmlFor={`${prefix}-prompt`}>Вопрос</Label><Input id={`${prefix}-prompt`} required maxLength={500} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></div>
      {kind === 'text' ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Участники напишут развёрнутый ответ. До 20 000 символов.</p> : (
        <div className="grid gap-2">
          {options.map((option, index) => (
            <div key={option.id ?? index} className="flex items-center gap-2">
              <span aria-hidden className={`size-4 shrink-0 border border-muted-foreground ${kind === 'single_choice' ? 'rounded-full' : 'rounded-sm'}`} />
              <Input aria-label={`Вариант ${index + 1}`} placeholder={`Вариант ${index + 1}`} required maxLength={300} value={option.label} onChange={(event) => setOptions((current) => current.map((item, at) => at === index ? { ...item, label: event.target.value } : item))} />
              <Button type="button" size="icon" variant="ghost" aria-label={`Убрать вариант ${index + 1}`} disabled={options.length <= 2} onClick={() => setOptions((current) => current.filter((_, at) => at !== index))}><Trash2 className="size-4" /></Button>
            </div>
          ))}
          <Button type="button" variant="ghost" className="w-fit" disabled={options.length >= 12} onClick={() => setOptions((current) => [...current, { label: '' }])}><Plus className="size-4" />Добавить вариант</Button>
          <p className="text-xs text-muted-foreground">От 2 до 12 вариантов. {kind === 'multiple_choice' ? 'Можно выбрать несколько ответов.' : 'Можно выбрать один ответ.'}</p>
        </div>
      )}
      <label className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={required} onChange={(event) => setRequired(event.target.checked)} />Обязательный вопрос</label>
      {save.isError && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!prompt.trim() || (kind !== 'text' && options.some((option) => !option.label.trim())) || save.isPending}>{question ? 'Сохранить изменения' : 'Добавить вопрос'}</Button>
        {onCancel && <Button type="button" variant="outline" disabled={save.isPending} onClick={onCancel}>Отмена</Button>}
      </div>
    </form>
  )
}
