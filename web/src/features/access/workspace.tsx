import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clipboard, KeyRound, LogOut, Pencil, RotateCw, Users } from 'lucide-react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { accessApi } from '@/api/endpoints'
import type { AccessCredentials, AccessRole, AccessUser, AccessWorkspace, QuestionKind, WorkflowPhase } from '@/api/types'
import { ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { errorText } from '@/lib/errors'
import { openAccessSocket } from './socket'
import { DeleteButton } from './delete-button'
import { ParticipantWorkspace } from './participant-workspace'
import { QuestionEditor } from './question-editor'

const questionKindLabel: Record<QuestionKind, string> = {
  single_choice: 'Один вариант',
  multiple_choice: 'Несколько вариантов',
  text: 'Развёрнутый ответ',
}

const roleLabel: Record<AccessRole, string> = { organizer: 'Организатор', jury: 'Жюри', teacher: 'Педагог', student: 'Студент' }

export default function AccessWorkspacePage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['access-workspace'], queryFn: accessApi.workspace, retry: false })
  useEffect(
    () => openAccessSocket(() => void client.invalidateQueries({ queryKey: ['access-workspace'] })),
    [client],
  )
  if (query.isPending) return <Skeleton className="m-8 h-48" />
  if (query.isError) return <div className="m-8"><ErrorState message={errorText(query.error)} onRetry={() => void query.refetch()} /></div>
  const workspace = query.data
  if (workspace.current_user.role === 'organizer') return <Navigate to={`/events/${workspace.event.id}/questions`} replace />
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold">{workspace.event.title}</p>
            <p className="text-xs text-muted-foreground">{workspace.current_user.name} · {roleLabel[workspace.current_user.role]}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void accessApi.logout().finally(() => navigate(`/${workspace.event.id}/auth`, { replace: true }))}
          >
            <LogOut className="size-4" aria-hidden /> Выйти
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {workspace.current_user.role === 'jury' && <JuryWorkspace data={workspace} />}
        {(workspace.current_user.role === 'teacher' || workspace.current_user.role === 'student') && (
          <ParticipantWorkspace
            key={`${workspace.event.id}:${workspace.current_user.id}:${workspace.event.phase}`}
            data={workspace}
          />
        )}
      </main>
    </div>
  )
}

interface SettingsProps {
  data: AccessWorkspace
  api: typeof accessApi
  refresh: () => Promise<unknown>
}

function CredentialsPanel({ credentials, onClose }: { credentials: AccessCredentials; onClose: () => void }) {
  const copy = (value: string) => void navigator.clipboard.writeText(value).then(() => toast.success('Скопировано'))
  return (
    <Card className="border-signal/60 bg-warning-soft">
      <CardHeader><CardTitle>Сохраните доступ для {credentials.user.name}</CardTitle><CardDescription>Пароль и ссылка показаны только сейчас.</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2 rounded-lg border bg-card p-3"><code className="min-w-0 flex-1 break-all font-mono text-sm">{credentials.password}</code><Button size="icon" variant="ghost" onClick={() => copy(credentials.password)} aria-label="Скопировать пароль"><Clipboard className="size-4" /></Button></div>
        <div className="flex items-center gap-2 rounded-lg border bg-card p-3"><code className="min-w-0 flex-1 break-all font-mono text-xs">{credentials.magic_url}</code><Button size="icon" variant="ghost" onClick={() => copy(credentials.magic_url)} aria-label="Скопировать ссылку"><Clipboard className="size-4" /></Button></div>
        <Button variant="secondary" className="w-fit" onClick={onClose}>Готово</Button>
      </CardContent>
    </Card>
  )
}

export function ParticipantsSettings({ data, api, refresh }: SettingsProps) {
  const [credentials, setCredentials] = useState<AccessCredentials | null>(null)
  const [name, setName] = useState('')
  const [role, setRole] = useState<AccessRole>('teacher')
  const [teamId, setTeamId] = useState<string>('')
  const createUser = useMutation({
    mutationFn: api.createUser,
    onSuccess: (result) => { setName(''); setCredentials(result); void refresh() },
  })
  const deleteUser = useMutation({ mutationFn: api.deleteUser, onSuccess: refresh })
  const rotatePassword = useMutation({
    mutationFn: async (user: AccessUser) => ({ user, result: await api.rotatePassword(user.id) }),
    onSuccess: ({ user, result }) => setCredentials({ user, password: result.password, magic_url: 'Magic-ссылка не изменялась' }),
  })
  const rotateMagic = useMutation({
    mutationFn: async (user: AccessUser) => ({ user, result: await api.rotateMagic(user.id) }),
    onSuccess: ({ user, result }) => setCredentials({ user, password: 'Пароль не изменялся', magic_url: result.magic_url }),
  })
  const teamRequired = role === 'teacher' || role === 'student'
  return (
    <div className="grid gap-6">
    {credentials && <CredentialsPanel credentials={credentials} onClose={() => setCredentials(null)} />}
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-5" />Участники</CardTitle><CardDescription>Педагоги, студенты и жюри. У каждого собственный пароль и персональная ссылка.</CardDescription></CardHeader>
      <CardContent className="grid gap-5">
        <p className="text-sm text-muted-foreground">Команды добавляются в <Link className="underline underline-offset-4" to={`/events/${data.event.id}/setup`}>настройке мероприятия</Link>.</p>
        {data.event.phase === 'setup' && (
          <>
            <form
              className="grid gap-3 rounded-lg border bg-muted/35 p-3 sm:grid-cols-2"
              onSubmit={(event) => { event.preventDefault(); createUser.mutate({ name, role, team_id: teamRequired ? teamId || null : null }) }}
            >
              <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="member-name">Имя</Label><Input id="member-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div className="grid gap-1.5"><Label>Роль</Label><Select value={role} onValueChange={(value) => setRole(value as AccessRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['jury', 'teacher', 'student'] as const).map((value) => <SelectItem key={value} value={value}>{roleLabel[value]}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1.5"><Label>Команда</Label><Select value={teamId || '__none__'} onValueChange={(value) => setTeamId(value === '__none__' ? '' : value)} disabled={!teamRequired}><SelectTrigger><SelectValue placeholder="Выберите" /></SelectTrigger><SelectContent><SelectItem value="__none__">Без команды</SelectItem>{data.teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div>
              <Button type="submit" className="sm:col-span-2" disabled={!name.trim() || (teamRequired && !teamId) || createUser.isPending}>Создать и показать доступ</Button>
            </form>
          </>
        )}
        {(createUser.isError || deleteUser.isError) && <p role="alert" className="text-sm text-destructive">{errorText((createUser.error || deleteUser.error)!)}</p>}
        <div className="divide-y rounded-lg border">
          {data.users.filter((user) => user.role !== 'organizer').map((user) => {
            const team = data.teams.find((item) => item.id === user.team_id)
            return (
              <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div><p className="font-medium">{user.name}</p><p className="text-xs text-muted-foreground">{roleLabel[user.role]}{team ? ` · ${team.name}` : ''}</p></div>
                <div className="flex items-center gap-2">
                  {(user.role === 'teacher' || user.role === 'student') && <Badge variant={user.submitted ? 'default' : 'secondary'}>{user.submitted ? 'Сдано' : 'Не сдано'}</Badge>}
                  {user.role !== 'organizer' && <Button size="icon" variant="ghost" aria-label={`Новый пароль для ${user.name}`} onClick={() => rotatePassword.mutate(user)}><KeyRound className="size-4" /></Button>}
                  {user.role !== 'organizer' && <Button size="icon" variant="ghost" aria-label={`Новая ссылка для ${user.name}`} onClick={() => rotateMagic.mutate(user)}><RotateCw className="size-4" /></Button>}
                  {data.event.phase === 'setup' && user.role !== 'organizer' && <DeleteButton label={`Удалить ${user.name}`} title={`Удалить пользователя «${user.name}»?`} description="Его пароль и персональная ссылка перестанут работать." onDelete={() => deleteUser.mutateAsync(user.id)} />}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
    </div>
  )
}

export function QuestionsSettings({ data, api, refresh }: SettingsProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const publish = useMutation({ mutationFn: api.setPhase, onSuccess: refresh })
  const next: Record<WorkflowPhase, { phase: WorkflowPhase; label: string } | null> = {
    setup: { phase: 'teachers', label: 'Открыть задания педагогам' },
    teachers: { phase: 'students', label: 'Открыть задания студентам' },
    students: { phase: 'finished', label: 'Закрыть приём ответов' },
    finished: null,
  }
  const action = next[data.event.phase]
  const status: Record<WorkflowPhase, string> = { setup: 'Задания пока скрыты от участников.', teachers: 'Задания открыты педагогам.', students: 'Задания открыты студентам после сдачи педагогами команды.', finished: 'Приём ответов завершён.' }
  const remove = useMutation({ mutationFn: api.deleteQuestion, onSuccess: refresh })
  return (
    <Card>
      <CardHeader><CardTitle>Формы заданий</CardTitle><CardDescription>Выбор одного или нескольких вариантов и развёрнутые ответы.</CardDescription></CardHeader>
      <CardContent className="grid gap-5">
        {data.event.phase === 'setup' && editing === null && <QuestionEditor api={api} onSaved={() => void refresh()} />}
        {remove.isError && <p role="alert" className="text-sm text-destructive">{errorText(remove.error)}</p>}
        <div className="grid gap-3">
          {data.questions.map((question, index) => (
            <div key={question.id} className="grid gap-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><Badge variant="outline">{question.audience === 'teacher' ? 'Педагоги' : 'Студенты'}</Badge><p className="mt-2 break-words font-medium">{index + 1}. {question.prompt}{question.required && <span className="ml-1 text-destructive" aria-label="Обязательный вопрос">*</span>}</p><p className="mt-1 text-xs text-muted-foreground">{questionKindLabel[question.kind]}</p></div><div className="flex items-center gap-2"><Button variant="outline" size="sm" aria-label={`Редактировать вопрос ${question.prompt}`} onClick={() => setEditing(question.id)}><Pencil className="size-4" />Редактировать</Button>{data.event.phase === 'setup' && <DeleteButton label={`Удалить вопрос ${question.prompt}`} title="Удалить вопрос?" description={question.prompt} onDelete={() => remove.mutateAsync(question.id)} />}</div></div>
              {editing === question.id && <QuestionEditor key={question.id} question={question} api={api} onSaved={() => { setEditing(null); void refresh() }} onCancel={() => setEditing(null)} />}
              {question.kind !== 'text' && <p className="mt-2 break-words text-xs text-muted-foreground">{question.options.map((option) => option.label).join(' · ')}</p>}
            </div>
          ))}
          {!data.questions.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Добавьте вопросы для педагогов и студентов.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-sm text-muted-foreground">{status[data.event.phase]}</p>{action && <Button variant="outline" disabled={publish.isPending || editing !== null} onClick={() => publish.mutate(action.phase)}>{action.label}</Button>}</div>
        {publish.isError && <p role="alert" className="text-sm text-destructive">{errorText(publish.error)}</p>}
      </CardContent>
    </Card>
  )
}

function JuryWorkspace({ data }: { data: AccessWorkspace }) {
  const participants = data.users.filter((user) => user.role === 'teacher' || user.role === 'student')
  const teamWorks = data.teams.flatMap((team) => (['teacher', 'student'] as const).filter((role) => participants.some((user) => user.team_id === team.id && user.role === role)).map((role) => ({ team, role })))
  const submittedWorks = teamWorks.filter(({ team, role }) => participants.some((user) => user.team_id === team.id && user.role === role && user.submitted)).length
  return (
    <div className="grid gap-6">
      <section><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Экран жюри</p><h1 className="mt-2 text-3xl font-semibold">{submittedWorks} / {teamWorks.length} командных работ отправлено</h1></section>
      {data.teams.map((team) => {
        const members = participants.filter((user) => user.team_id === team.id)
        const teachers = members.filter((user) => user.role === 'teacher')
        const students = members.filter((user) => user.role === 'student')
        const studentDone = students.some((user) => user.submitted)
        const teacherDone = teachers.some((user) => user.submitted)
        const completed = (teacherDone ? 1 : 0) + (studentDone ? 1 : 0)
        const total = (teachers.length ? 1 : 0) + (students.length ? 1 : 0)
        return <Card key={team.id}><CardHeader><CardTitle>{team.name}</CardTitle><CardDescription>{completed} из {total} работ готово</CardDescription></CardHeader><CardContent className="divide-y rounded-lg border">{teachers.length > 0 && <JuryTeamForm teamId={team.id} members={teachers} audience="teacher" data={data} />}{students.length > 0 && <JuryTeamForm teamId={team.id} members={students} audience="student" data={data} />}</CardContent></Card>
      })}
    </div>
  )
}

function JuryTeamForm({ teamId, members, audience, data }: { teamId: string; members: AccessUser[]; audience: 'teacher' | 'student'; data: AccessWorkspace }) {
  const answers = data.team_draft.filter((answer) => answer.team_id === teamId && answer.audience === audience)
  const submitted = members.some((member) => member.submitted)
  return (
    <details className="group p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4"><div><p className="font-medium">{audience === 'teacher' ? 'Педагоги команды' : 'Студенты команды'}</p><p className="text-xs text-muted-foreground">{members.map((member) => member.name).join(', ')}</p></div><Badge variant={submitted ? 'default' : 'secondary'}>{submitted ? 'Сделано' : 'Не сделано'}</Badge></summary>
      {submitted && <div className="mt-4 grid gap-3 border-t pt-4">{answers.map((answer) => { const question = data.questions.find((item) => item.id === answer.question_id); const labels = question?.options.filter((item) => answer.option_ids.includes(item.id)).map((item) => item.label); return <div key={answer.question_id}><p className="text-xs text-muted-foreground">{question?.prompt}</p><p className="whitespace-pre-wrap break-words font-medium">{question?.kind === 'text' ? answer.text : labels?.join(', ')}</p><p className="text-xs text-muted-foreground">Последнее изменение: {answer.edited_by_name}</p></div> })}</div>}
    </details>
  )
}
