import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clipboard, KeyRound, LogOut, Plus, RotateCw, Trash2, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
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

const questionKindLabel: Record<QuestionKind, string> = {
  single_choice: 'Один вариант',
  multiple_choice: 'Несколько вариантов',
  text: 'Развёрнутый ответ',
}

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
            key={`${workspace.event.id}:${workspace.current_user.id}:${workspace.event.phase}`}
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
                    <DeleteButton label={`Удалить команду ${team.name}`} title={`Удалить команду «${team.name}»?`} description="Команду можно удалить, если в ней нет участников." onDelete={() => deleteTeam.mutateAsync(team.id)} />
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
                  {data.event.phase === 'setup' && user.role !== 'organizer' && <DeleteButton label={`Удалить ${user.name}`} title={`Удалить пользователя «${user.name}»?`} description="Его пароль и персональная ссылка перестанут работать." onDelete={() => deleteUser.mutateAsync(user.id)} />}
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
  const [kind, setKind] = useState<QuestionKind>('single_choice')
  const [required, setRequired] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [options, setOptions] = useState(['', ''])
  const create = useMutation({
    mutationFn: accessApi.createQuestion,
    onSuccess: () => { setPrompt(''); setOptions(['', '']); void refresh() },
  })
  const remove = useMutation({ mutationFn: accessApi.deleteQuestion, onSuccess: refresh })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    create.mutate({ audience, prompt, kind, required, options: kind === 'text' ? [] : options.map((item) => item.trim()) })
  }
  return (
    <Card>
      <CardHeader><CardTitle>Формы заданий</CardTitle><CardDescription>Выбор одного или нескольких вариантов и развёрнутые ответы.</CardDescription></CardHeader>
      <CardContent className="grid gap-5">
        {data.event.phase === 'setup' && (
          <form className="grid gap-3 rounded-lg border bg-muted/35 p-3" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5"><Label htmlFor="question-audience">Для кого</Label><Select value={audience} onValueChange={(value) => setAudience(value as 'teacher' | 'student')}><SelectTrigger id="question-audience" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="teacher">Педагоги</SelectItem><SelectItem value="student">Студенты</SelectItem></SelectContent></Select></div>
              <div className="grid gap-1.5"><Label htmlFor="question-kind">Тип вопроса</Label><Select value={kind} onValueChange={(value) => setKind(value as QuestionKind)}><SelectTrigger id="question-kind" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(questionKindLabel).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="grid gap-1.5"><Label htmlFor="question-prompt">Вопрос</Label><Input id="question-prompt" required maxLength={500} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></div>
            {kind === 'text' ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Участники напишут ответ в большом текстовом поле. До 20 000 символов.</p>
            ) : (
              <div className="grid gap-2">
                {options.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <span aria-hidden className={`size-4 shrink-0 border border-muted-foreground ${kind === 'single_choice' ? 'rounded-full' : 'rounded-sm'}`} />
                    <Input aria-label={`Вариант ${index + 1}`} placeholder={`Вариант ${index + 1}`} required maxLength={300} value={option} onChange={(event) => setOptions((current) => current.map((item, at) => at === index ? event.target.value : item))} />
                    <Button type="button" size="icon" variant="ghost" aria-label={`Убрать вариант ${index + 1}`} disabled={options.length <= 2} onClick={() => setOptions((current) => current.filter((_, at) => at !== index))}><Trash2 className="size-4" /></Button>
                  </div>
                ))}
                <Button type="button" variant="ghost" className="w-fit" disabled={options.length >= 12} onClick={() => setOptions((current) => [...current, ''])}><Plus className="size-4" />Добавить вариант</Button>
                <p className="text-xs text-muted-foreground">От 2 до 12 вариантов. {kind === 'multiple_choice' ? 'Участник сможет отметить несколько ответов.' : 'Участник выберет один ответ.'}</p>
              </div>
            )}
            <label className="flex cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={required} onChange={(event) => setRequired(event.target.checked)} />Обязательный вопрос</label>
            <Button type="submit" disabled={!prompt.trim() || (kind !== 'text' && options.some((option) => !option.trim())) || create.isPending}>Добавить вопрос</Button>
          </form>
        )}
        {(create.isError || remove.isError) && <p role="alert" className="text-sm text-destructive">{errorText((create.error || remove.error)!)}</p>}
        <div className="grid gap-3">
          {data.questions.map((question, index) => (
            <div key={question.id} className="rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><Badge variant="outline">{question.audience === 'teacher' ? 'Педагоги' : 'Студенты'}</Badge><p className="mt-2 break-words font-medium">{index + 1}. {question.prompt}{question.required && <span className="ml-1 text-destructive" aria-label="Обязательный вопрос">*</span>}</p><p className="mt-1 text-xs text-muted-foreground">{questionKindLabel[question.kind]}</p></div>{data.event.phase === 'setup' && <DeleteButton label={`Удалить вопрос ${question.prompt}`} title="Удалить вопрос?" description={question.prompt} onDelete={() => remove.mutateAsync(question.id)} />}</div>
              {question.kind !== 'text' && <p className="mt-2 break-words text-xs text-muted-foreground">{question.options.map((option) => option.label).join(' · ')}</p>}
            </div>
          ))}
          {!data.questions.length && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Добавьте вопросы для педагогов и студентов.</p>}
        </div>
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
