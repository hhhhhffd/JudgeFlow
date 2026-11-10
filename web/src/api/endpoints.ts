import { request } from './client'
import type * as T from './types'

const j = (token: string) => ({ token })

// ---- setup / auth (cookie session) ----
export const setupApi = {
  /** Resolves if no admin exists yet (204); rejects with ApiError 404 otherwise. */
  checkFirstStart: () => request<void>('/api/setup/first-start'),
  begin: (body: T.FirstStartBeginRequest) =>
    request<T.FirstStartBeginResponse>('/api/setup/first-start/begin', { method: 'POST', body }),
  complete: (body: T.FirstStartCompleteRequest) =>
    request<T.AdminResponse>('/api/setup/first-start/complete', { method: 'POST', body }),
}

export const authApi = {
  login: (body: T.LoginRequest) => request<T.AdminResponse>('/api/auth/login', { method: 'POST', body }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  me: () => request<T.AdminResponse>('/api/auth/me'),
}

export const accessApi = {
  bootstrap: (eventId: T.Id, name: string) =>
    request<T.AccessCredentials>(`/api/events/${eventId}/access/bootstrap`, { method: 'POST', body: { name } }),
  enterAsOrganizer: (eventId: T.Id) =>
    request<{ ok: true }>(`/api/events/${eventId}/access/enter`, { method: 'POST' }),
  login: (eventId: T.Id, password: string) =>
    request<{ ok: true }>(`/api/events/${eventId}/access/login`, { method: 'POST', body: { password } }),
  magic: (token: string) => request<{ ok: true }>(`/api/access/magic/${encodeURIComponent(token)}`, { method: 'POST' }),
  me: () => request<{ user: T.AccessUser }>('/api/access/me'),
  logout: () => request<void>('/api/access/logout', { method: 'POST' }),
  workspace: () => request<T.AccessWorkspace>('/api/access/workspace'),
  createTeam: (name: string) => request<{ id: T.Id; name: string }>('/api/access/teams', { method: 'POST', body: { name } }),
  createUser: (body: { name: string; role: T.AccessRole; team_id: T.Id | null }) =>
    request<T.AccessCredentials>('/api/access/users', { method: 'POST', body }),
  rotatePassword: (id: T.Id) => request<{ password: string }>(`/api/access/users/${id}/password`, { method: 'POST' }),
  rotateMagic: (id: T.Id) => request<{ magic_url: string }>(`/api/access/users/${id}/magic`, { method: 'POST' }),
  createQuestion: (body: { audience: 'teacher' | 'student'; prompt: string; options: string[] }) =>
    request<T.AccessQuestion>('/api/access/questions', { method: 'POST', body }),
  deleteQuestion: (id: T.Id) => request<void>(`/api/access/questions/${id}`, { method: 'DELETE' }),
  setPhase: (phase: T.WorkflowPhase) => request<{ phase: T.WorkflowPhase }>('/api/access/phase', { method: 'PATCH', body: { phase } }),
  resetWorkflow: () => request<{ phase: 'setup' }>('/api/access/reset', { method: 'POST' }),
  saveTeamDraft: (question_id: T.Id, option_id: T.Id) =>
    request<void>('/api/access/team-draft', { method: 'PATCH', body: { question_id, option_id } }),
  submit: (answers: { question_id: T.Id; option_id: T.Id }[]) => request<void>('/api/access/submit', { method: 'POST', body: { answers } }),
}

export const invitePublicApi = {
  get: (token: string) => request<T.InviteInfo>(`/api/invites/${encodeURIComponent(token)}`),
  begin: (token: string, body: { name: string }) =>
    request<T.TotpEnrollment>(`/api/invites/${encodeURIComponent(token)}/begin`, { method: 'POST', body }),
  complete: (token: string, body: { code: string }) =>
    request<T.AdminResponse>(`/api/invites/${encodeURIComponent(token)}/complete`, { method: 'POST', body }),
}

// ---- admin ----
export const adminsApi = {
  list: () => request<T.Admin[]>('/api/admins'),
  createInvite: () => request<T.InviteCreated>('/api/admins/invites', { method: 'POST' }),
  listInvites: () => request<T.InviteListItem[]>('/api/admins/invites'),
  deleteInvite: (id: string) => request<void>(`/api/admins/invites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  remove: (id: T.Id) => request<void>(`/api/admins/${id}`, { method: 'DELETE' }),
  resetTotp: (id: T.Id) => request<T.TotpEnrollment>(`/api/admins/${id}/reset-totp`, { method: 'POST' }),
}

export const eventsApi = {
  list: () => request<T.EventListItem[]>('/api/events'),
  create: (body: T.CreateEventRequest) => request<T.EventFull>('/api/events', { method: 'POST', body }),
  get: (id: T.Id) => request<T.EventFull>(`/api/events/${id}`),
  update: (id: T.Id, body: T.UpdateEventRequest) => request<T.EventFull>(`/api/events/${id}`, { method: 'PATCH', body }),
  remove: (id: T.Id) => request<void>(`/api/events/${id}`, { method: 'DELETE' }),
  transition: (id: T.Id, body: T.TransitionRequest) =>
    request<T.EventFull>(`/api/events/${id}/transition`, { method: 'POST', body }),

  nextRound: (id: T.Id, body: T.NextRoundRequest) =>
    request<T.NextRoundResponse>(`/api/events/${id}/next-round`, { method: 'POST', body }),

  addTeam: (id: T.Id, body: T.TeamInput) => request<T.Team>(`/api/events/${id}/teams`, { method: 'POST', body }),
  addTeamsBulk: (id: T.Id, teams: T.TeamInput[]) =>
    request<T.Team[]>(`/api/events/${id}/teams/bulk`, { method: 'POST', body: { teams } }),
  updateTeam: (teamId: T.Id, body: Partial<T.TeamInput>) => request<T.Team>(`/api/teams/${teamId}`, { method: 'PATCH', body }),
  removeTeam: (teamId: T.Id) => request<void>(`/api/teams/${teamId}`, { method: 'DELETE' }),
  reorderTeams: (id: T.Id, ids: T.Id[]) =>
    request<void>(`/api/events/${id}/teams/order`, { method: 'PUT', body: { ids } satisfies T.OrderRequest }),

  addCriterion: (id: T.Id, body: T.CriterionInput) =>
    request<T.Criterion>(`/api/events/${id}/criteria`, { method: 'POST', body }),
  addCriteriaBulk: (id: T.Id, criteria: T.CriterionInput[]) =>
    request<T.Criterion[]>(`/api/events/${id}/criteria/bulk`, { method: 'POST', body: { criteria } }),
  updateCriterion: (criterionId: T.Id, body: Partial<T.CriterionInput>) =>
    request<T.Criterion>(`/api/criteria/${criterionId}`, { method: 'PATCH', body }),
  removeCriterion: (criterionId: T.Id) => request<void>(`/api/criteria/${criterionId}`, { method: 'DELETE' }),
  reorderCriteria: (id: T.Id, ids: T.Id[]) =>
    request<void>(`/api/events/${id}/criteria/order`, { method: 'PUT', body: { ids } satisfies T.OrderRequest }),

  addTrack: (id: T.Id, name: string) => request<T.Track>(`/api/events/${id}/tracks`, { method: 'POST', body: { name } }),
  updateTrack: (trackId: T.Id, name: string) => request<T.Track>(`/api/tracks/${trackId}`, { method: 'PATCH', body: { name } }),
  removeTrack: (trackId: T.Id) => request<void>(`/api/tracks/${trackId}`, { method: 'DELETE' }),
  reorderTracks: (id: T.Id, ids: T.Id[]) =>
    request<void>(`/api/events/${id}/tracks/order`, { method: 'PUT', body: { ids } satisfies T.OrderRequest }),

  putAssignments: (id: T.Id, pairs: T.JudgeTeamPair[]) =>
    request<T.EventFull>(`/api/events/${id}/assignments`, { method: 'PUT', body: { pairs } }),
  autoAssign: (id: T.Id, body: T.AutoAssignRequest) =>
    request<T.EventFull>(`/api/events/${id}/assignments/auto`, { method: 'POST', body }),
  putConflicts: (id: T.Id, pairs: T.JudgeTeamPair[]) =>
    request<T.EventFull>(`/api/events/${id}/conflicts`, { method: 'PUT', body: { pairs } }),
  /** Applies a `judgeflow-sheet/1` file with the rules of PUT /api/judge/scores. */
  importSheet: (id: T.Id, sheet: unknown) =>
    request<T.ImportSheetResponse>(`/api/events/${id}/import-sheet`, { method: 'POST', body: sheet }),

  addJudges: (id: T.Id, names: string[]) =>
    request<T.JudgeWithLink[]>(`/api/events/${id}/judges`, { method: 'POST', body: { names } satisfies T.CreateJudgesRequest }),
  updateJudge: (judgeId: T.Id, body: T.UpdateJudgeRequest) =>
    request<T.JudgeSummary>(`/api/judges/${judgeId}`, { method: 'PATCH', body }),
  removeJudge: (judgeId: T.Id) => request<void>(`/api/judges/${judgeId}`, { method: 'DELETE' }),
  rotateJudge: (judgeId: T.Id) => request<T.JudgeWithLink>(`/api/judges/${judgeId}/rotate`, { method: 'POST' }),
  reopenJudge: (judgeId: T.Id, reason: string) =>
    request<T.JudgeSummary>(`/api/judges/${judgeId}/reopen`, { method: 'POST', body: { reason } satisfies T.ReopenJudgeRequest }),

  /** `file` must be image/png|jpeg|webp, ≤ 5 MB. */
  uploadBackground: (id: T.Id, file: Blob) =>
    request<T.EventFull>(`/api/events/${id}/background`, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    }),
  removeBackground: (id: T.Id) => request<T.EventFull>(`/api/events/${id}/background`, { method: 'DELETE' }),

  revealStage: (id: T.Id, action: T.StageAction) =>
    request<T.EventFull>(`/api/events/${id}/stage/reveal`, { method: 'POST', body: { action } }),

  matrix: (id: T.Id) => request<T.Matrix>(`/api/events/${id}/matrix`),
  results: (id: T.Id, mode: T.RankingMode) => request<T.ResultsResponse>(`/api/events/${id}/results?mode=${mode}`),
  /** Plain URL for a download link (cookie-authenticated). */
  exportCsvUrl: (id: T.Id) => `/api/events/${id}/export.csv`,
  audit: (id: T.Id) => request<T.AuditEntry[]>(`/api/events/${id}/audit`),
  streamUrl: (id: T.Id) => `/api/events/${id}/stream`,
}

// ---- judge (Bearer token) ----
export const judgeApi = {
  session: (token: string, signal?: AbortSignal) => request<T.JudgeSession>('/api/judge/session', { ...j(token), signal }),
  putScores: (token: string, items: T.ScoreItem[], signal?: AbortSignal) =>
    request<T.PutScoresResponse>('/api/judge/scores', { method: 'PUT', body: { items } satisfies T.PutScoresRequest, ...j(token), signal }),
  reservePairs: (token: string, count: number) =>
    request<T.ReservePairsResponse>('/api/judge/pairs/reserve', { method: 'POST', body: { count }, ...j(token) }),
  putComparisons: (token: string, items: T.ComparisonItem[], signal?: AbortSignal) =>
    request<T.PutComparisonsResponse>('/api/judge/comparisons', { method: 'PUT', body: { items }, ...j(token), signal }),
  /** `releaseOpen` discards the judge's undecided pairs (pairwise mode). */
  submit: (token: string, releaseOpen = false) =>
    request<T.JudgeSubmitResponse>('/api/judge/submit', { method: 'POST', body: releaseOpen ? { release_open: true } : undefined, ...j(token) }),
  unsubmit: (token: string) => request<T.JudgeSubmitResponse>('/api/judge/unsubmit', { method: 'POST', ...j(token) }),
  heartbeat: (token: string, pending_count: number) =>
    request<void>('/api/judge/heartbeat', { method: 'POST', body: { pending_count } satisfies T.HeartbeatRequest, ...j(token) }),
  streamUrl: '/api/judge/stream',
}

// ---- public ----
export const publicApi = {
  event: (id: T.Id) => request<T.PublicEventResponse>(`/api/public/events/${id}`),
  stage: (id: T.Id) => request<T.StageResponse>(`/api/public/events/${id}/stage`),
  streamUrl: (id: T.Id) => `/api/public/events/${id}/stream`,
  backgroundUrl: (id: T.Id) => `/api/public/events/${id}/background`,
}
