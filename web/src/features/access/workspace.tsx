import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, Clipboard, KeyRound, LogOut, Plus, RotateCw, Trash2, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { accessApi } from '@/api/endpoints'
import type { AccessCredentials, AccessRole, AccessUser, AccessWorkspace, WorkflowPhase } from '@/api/types'
import { ErrorState } from '@/components/state-views'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { errorText } from '@/lib/errors'
import { openAccessSocket } from './socket'

const roleLabel: Record<AccessRole, string> = { organizer: 'Организатор', jury: 'Жюри', teacher: 'Педагог', student: 'Студент' }
const phases: { value: WorkflowPhase; label: string }[] = [
  { value: 'setup', label: 'Настройка' },
  { value: 'teachers', label: 'Педагоги' },
  { value: 'students', label: 'Студенты' },
  { value: 'finished', label: 'Завершено' },
]

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
        {workspace.current_user.role === 'organizer' && <OrganizerWorkspace data={workspace} />}
        {workspace.current_user.role === 'jury' && <JuryWorkspace data={workspace} />}
        {(workspace.current_user.role === 'teacher' || workspace.current_user.role === 'student') && (
          <ParticipantWorkspace
            key={workspace.team_draft.map((answer) => `${answer.question_id}:${answer.option_id}:${answer.updated_at}`).join('|')}
            data={workspace}
          />
        )}
      </main>
    </div>
  )
}

function useRefresh() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: ['access-workspace'] })
}

function OrganizerWorkspace({ data }: { data: AccessWorkspace }) {
  const refresh = useRefresh()
  const [credentials, setCredentials] = useState<AccessCredentials | null>(null)
  const phase = useMutation({ mutationFn: accessApi.setPhase, onSuccess: refresh })
  const reset = useMutation({ mutationFn: accessApi.resetWorkflow, onSuccess: refresh })
  const index = phases.findIndex((item) => item.value === data.event.phase)
  return (
    <div className="grid gap-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Управление мероприятием</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Команды, доступы и задания</h1>
      </section>
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-4">
        {phases.map((item, itemIndex) => (
          <button
            key={item.value}
            type="button"
            disabled={itemIndex < index || itemIndex > index + 1 || phase.isPending}
            onClick={() => phase.mutate(item.value)}
            className={`flex min-h-14 items-center gap-2 border-r px-3 text-left text-sm font-medium last:border-r-0 disabled:cursor-not-allowed disabled:opacity-45 ${item.value === data.event.phase ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            <span className="num text-xs opacity-70">0{itemIndex + 1}</span>{item.label}
          </button>
        ))}
      </div>
      {data.event.phase !== 'setup' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4">
          <p className="text-sm">Чтобы изменить команды или задания, верните мероприятие в настройку. Старые ответы будут удалены.</p>
          <Button variant="secondary" disabled={reset.isPending} onClick={() => reset.mutate()}>Вернуть в настройку</Button>
        </div>
      )}
      {(phase.isError || reset.isError) && <p role="alert" className="text-sm text-destructive">{errorText((phase.error || reset.error)!)}</p>}
      {credentials && <CredentialsPanel credentials={credentials} onClose={() => setCredentials(null)} />}
      <div className="grid gap-6 xl:grid-cols-2">
        <PeopleCard data={data} onCredentials={setCredentials} />
        <QuestionsCard data={data} />
      </div>
    </div>
  )
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

function PeopleCard({ data, onCredentials }: { data: AccessWorkspace; onCredentials: (value: AccessCredentials) => void }) {
  const refresh = useRefresh()
  const [teamName, setTeamName] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<AccessRole>('teacher')
  const [teamId, setTeamId] = useState<string>('')
  const createTeam = useMutation({ mutationFn: accessApi.createTeam, onSuccess: () => { setTeamName(''); void refresh() } })
  const deleteTeam = useMutation({ mutationFn: accessApi.deleteTeam, onSuccess: refresh })
  const createUser = useMutation({
    mutationFn: accessApi.createUser,
    onSuccess: (result) => { setName(''); onCredentials(result); void refresh() },
  })
  const deleteUser = useMutation({ mutationFn: accessApi.deleteUser, onSuccess: refresh })
  const rotatePassword = useMutation({
    mutationFn: async (user: AccessUser) => ({ user, result: await accessApi.rotatePassword(user.id) }),
    onSuccess: ({ user, result }) => onCredentials({ user, password: result.password, magic_url: 'Magic-ссылка не изменялась' }),
  })
  const rotateMagic = useMutation({
    mutationFn: async (user: AccessUser) => ({ user, result: await accessApi.rotateMagic(user.id) }),
    onSuccess: ({ user, result }) => onCredentials({ user, password: 'Пароль не изменялся', magic_url: result.magic_url }),
  })
  const teamRequired = role === 'teacher' || role === 'student'
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-5" />Команды и люди</CardTitle><CardDescription>У каждого человека собственный пароль и magic-ссылка.</CardDescription></CardHeader>
      <CardContent className="grid gap-5">
        {data.event.phase === 'setup' && (
          <>
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); createTeam.mutate(teamName) }}>
              <Input aria-label="Название новой команды" required maxLength={200} placeholder="Новая команда" value={teamName} onChange={(event) => setTeamName(event.target.value)} />
              <Button type="submit" variant="secondary" disabled={!teamName.trim() || createTeam.isPending}><Plus className="size-4" />Команда</Button>
            </form>
            <form
              className="grid gap-3 rounded-lg border bg-muted/35 p-3 sm:grid-cols-2"
              onSubmit={(event) => { event.preventDefault(); createUser.mutate({ name, role, team_id: teamRequired ? teamId || null : null }) }}
            >
              <div className="grid gap-1.5 sm:col-span-2"><Label htmlFor="member-name">Имя</Label><Input id="member-name" required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></div>
              <div className="grid gap-1.5"><Label>Роль</Label><Select value={role} onValueChange={(value) => setRole(value as AccessRole)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(['jury', 'teacher', 'student'] as const).map((value) => <SelectItem key={value} value={value}>{roleLabel[value]}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid gap-1.5"><Label>Команда</Label><Select value={teamId || '__none__'} onValueChange={(value) => setTeamId(value === '__none__' ? '' : value)} disabled={!teamRequired}><SelectTrigger><SelectValue placeholder="Выберите" /></SelectTrigger><SelectContent><SelectItem value="__none__">Без команды</SelectItem>{data.teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div>
              <Button type="submit" className="sm:col-span-2" disabled={!name.trim() || (teamRequired && !teamId) || createUser.isPending}>Создать и показать доступ</Button>
            </form>
            {data.teams.length > 0 && (
              <div className="grid gap-2">
                <p className="text-sm font-medium">Команды</p>
                {data.teams.map((team) => (
                  <div key={team.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
                    <span className="text-sm">{team.name}</span>
                    <Button size="icon" variant="ghost" aria-label={`Удалить команду ${team.name}`} onClick={() => { if (window.confirm(`Удалить команду «${team.name}»?`)) deleteTeam.mutate(team.id) }}><Trash2 className="size-4 text-destructive" /></Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {(createTeam.isError || createUser.isError || deleteTeam.isError || deleteUser.isError) && <p role="alert" className="text-sm text-destructive">{errorText((createTeam.error || createUser.error || deleteTeam.error || deleteUser.error)!)}</p>}
        <div className="divide-y rounded-lg border">
          {data.users.map((user) => {
            const team = data.teams.find((item) => item.id === user.team_id)
            return (
              <div key={user.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div><p className="font-medium">{user.name}</p><p className="text-xs text-muted-foreground">{roleLabel[user.role]}{team ? ` · ${team.name}` : ''}</p></div>
                <div className="flex items-center gap-2">
                  {(user.role === 'teacher' || user.role === 'student') && <Badge variant={user.submitted ? 'default' : 'secondary'}>{user.submitted ? 'Сдано' : 'Не сдано'}</Badge>}
                  {user.role !== 'organizer' && <Button size="icon" variant="ghost" aria-label={`Новый пароль для ${user.name}`} onClick={() => rotatePassword.mutate(user)}><KeyRound className="size-4" /></Button>}
                  {user.role !== 'organizer' && <Button size="icon" variant="ghost" aria-label={`Новая ссылка для ${user.name}`} onClick={() => rotateMagic.mutate(user)}><RotateCw className="size-4" /></Button>}
                  {data.event.phase === 'setup' && user.role !== 'organizer' && <Button size="icon" variant="ghost" aria-label={`Удалить ${user.name}`} onClick={() => { if (window.confirm(`Удалить пользователя «${user.name}»?`)) deleteUser.mutate(user.id) }}><Trash2 className="size-4 text-destructive" /></Button>}
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function QuestionsCard({ data }: { data: AccessWorkspace }) {
  const refresh = useRefresh()
  const [audience, setAudience] = useState<'teacher' | 'student'>('teacher')
  const [prompt, setPrompt] = useState('')
  const [options, setOptions] = useState('')
  const create = useMutation({
    mutationFn: accessApi.createQuestion,
    onSuccess: () => { setPrompt(''); setOptions(''); void refresh() },
  })
  const remove = useMutation({ mutationFn: accessApi.deleteQuestion, onSuccess: refresh })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate({ audience, prompt, options: options.split('\n').map((item) => item.trim()).filter(Boolean) })
  }
  return (
    <Card>
      <CardHeader><CardTitle>Формы заданий</CardTitle><CardDescription>Вопросы с одним вариантом ответа — как в Google Forms.</CardDescription></CardHeader>
      <CardContent className="grid gap-5">
        {data.event.phase === 'setup' && (
          <form className="grid gap-3 rounded-lg border bg-muted/35 p-3" onSubmit={submit}>
            <div className="grid gap-1.5"><Label>Для кого</Label><Select value={audience} onValueChange={(value) => setAudience(value as 'teacher' | 'student')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="teacher">Педагоги</SelectItem><SelectItem value="student">Студенты</SelectItem></SelectContent></Select></div>
            <div className="grid gap-1.5"><Label htmlFor="question-prompt">Вопрос</Label><Input id="question-prompt" required maxLength={500} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="question-options">Варианты</Label><Textarea id="question-options" required rows={4} placeholder="Каждый вариант с новой строки" value={options} onChange={(event) => setOptions(event.target.value)} /></div>
            <p className="text-xs text-muted-foreground">Нужно минимум два непустых варианта, каждый с новой строки.</p>
            <Button type="submit" disabled={!prompt.trim() || options.split('\n').filter((item) => item.trim()).length < 2 || create.isPending}>Добавить вопрос</Button>
          </form>
        )}
        {(create.isError || remove.isError) && <p role="alert" className="text-sm text-destructive">{errorText((create.error || remove.error)!)}</p>}
        <div className="grid gap-3">
          {data.questions.map((question, index) => (
            <div key={question.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3"><div><Badge variant="outline">{question.audience === 'teacher' ? 'Педагоги' : 'Студенты'}</Badge><p className="mt-2 font-medium">{index + 1}. {question.prompt}</p></div>{data.event.phase === 'setup' && <Button size="icon" variant="ghost" aria-label="Удалить вопрос" onClick={() => remove.mutate(question.id)}><Trash2 className="size-4 text-destructive" /></Button>}</div>
              <p className="mt-2 text-xs text-muted-foreground">{question.options.map((option) => option.label).join(' · ')}</p>
            </div>
          ))}
          {!data.questions.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Добавьте вопросы для педагогов и студентов.</p>}
        </div>
      </CardContent>
    </Card>
  )
}

function ParticipantWorkspace({ data }: { data: AccessWorkspace }) {
  const refresh = useRefresh()
  const user = data.current_user
  const record = data.users.find((item) => item.id === user.id)
  const submitted = record?.submitted ?? false
  const questions = data.questions.filter((question) => question.audience === user.role)
  const sharedAnswers = Object.fromEntries(data.team_draft.map((answer) => [answer.question_id, answer.option_id]))
  const [answers, setAnswers] = useState<Record<string, string>>(sharedAnswers)
  const saveDraft = useMutation({ mutationFn: ({ questionId, optionId }: { questionId: string; optionId: string }) => accessApi.saveTeamDraft(questionId, optionId) })
  const submit = useMutation({
    mutationFn: () => accessApi.submit(questions.map((question) => ({ question_id: question.id, option_id: answers[question.id]! }))),
    onSuccess: refresh,
  })
  const teamTeachers = data.users.filter((item) => item.team_id === user.team_id && item.role === 'teacher')
  const locked = user.role === 'teacher'
    ? data.event.phase !== 'teachers'
    : data.event.phase !== 'students' || teamTeachers.some((teacher) => !teacher.submitted)
  if (submitted) return <Completion />
  if (locked) return <Locked role={user.role} phase={data.event.phase} />
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{roleLabel[user.role]}</p><h1 className="mt-2 text-3xl font-semibold">Ответьте на вопросы</h1></div>
      {questions.map((question, index) => {
        const shared = data.team_draft.find((answer) => answer.question_id === question.id)
        return (
          <Card key={question.id}><CardHeader><CardTitle className="text-lg"><span className="mr-2 text-primary">{index + 1}.</span>{question.prompt}</CardTitle>{shared && <CardDescription>Последнее изменение: {shared.edited_by_name}</CardDescription>}</CardHeader><CardContent className="grid gap-2">{question.options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent"><input type="radio" name={question.id} value={option.id} checked={answers[question.id] === option.id} onChange={() => { setAnswers((current) => ({ ...current, [question.id]: option.id })); saveDraft.mutate({ questionId: question.id, optionId: option.id }) }} /><span>{option.label}</span></label>)}</CardContent></Card>
        )
      })}
      {(submit.isError || saveDraft.isError) && <p role="alert" className="text-sm text-destructive">{errorText((submit.error || saveDraft.error)!)}</p>}
      <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl bg-primary p-4 text-primary-foreground shadow-xl"><p className="text-sm">После отправки изменить ответы нельзя.</p><Button variant="secondary" disabled={Object.keys(answers).length !== questions.length || submit.isPending} onClick={() => submit.mutate()}>Сдать работу</Button></div>
    </div>
  )
}

function Completion() {
  return <div className="mx-auto mt-20 max-w-lg text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-success-soft text-success"><Check className="size-8" /></div><h1 className="mt-5 text-3xl font-semibold">Ответы приняты</h1><p className="mt-2 text-muted-foreground">Статус уже виден организатору и жюри.</p></div>
}

function Locked({ role, phase }: { role: AccessRole; phase: WorkflowPhase }) {
  const text = role === 'student' && phase === 'students' ? 'Ждём, пока все педагоги вашей команды отправят ответы.' : 'Организатор ещё не открыл ваш этап.'
  return <div className="mx-auto mt-20 max-w-lg text-center"><div className="mx-auto grid size-16 place-items-center rounded-full bg-warning-soft text-warning"><ChevronDown className="size-8" /></div><h1 className="mt-5 text-3xl font-semibold">Задание пока закрыто</h1><p className="mt-2 text-muted-foreground">{text}</p></div>
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
      {submitted && <div className="mt-4 grid gap-3 border-t pt-4">{answers.map((answer) => { const question = data.questions.find((item) => item.id === answer.question_id); const option = question?.options.find((item) => item.id === answer.option_id); return <div key={answer.question_id}><p className="text-xs text-muted-foreground">{question?.prompt}</p><p className="font-medium">{option?.label}</p><p className="text-xs text-muted-foreground">Последнее изменение: {answer.edited_by_name}</p></div> })}</div>}
    </details>
  )
}
