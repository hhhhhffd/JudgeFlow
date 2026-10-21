// Types for every request/response in docs/SPEC.md §8 (+ Ranking from §5).
// IDs are UUID strings, timestamps are Unix ms, scores are integers in hundredths (`*_x100`).

export type Id = string
export type Role = 'owner' | 'admin'
export type EventStatus = 'draft' | 'judging' | 'locked' | 'finalized' | 'published'
export type ScoringMode = 'team' | 'criterion'
export type Visibility = 'hidden' | 'live_totals' | 'live_full'
export type AlertAlign = 'left' | 'center'

export interface Admin {
  id: Id
  name: string
  role: Role
  created_at: number
}
export interface AdminResponse {
  admin: Admin
}

// ---- setup / auth ----
export interface FirstStartBeginRequest {
  setup_password: string
  name: string
}
export interface FirstStartBeginResponse {
  enrollment_token: string
  otpauth_uri: string
  secret: string
}
export interface FirstStartCompleteRequest {
  enrollment_token: string
  code: string
}
export interface LoginRequest {
  name: string
  code: string
}

// ---- admins / invites ----
export interface InviteCreated {
  url: string
  expires_at: number
}
export interface InviteListItem {
  id: string
  created_at: number
  expires_at: number
}
export interface TotpEnrollment {
  otpauth_uri: string
  secret: string
}
export interface InviteInfo {
  expires_at: number
}

// ---- events ----
export interface EventListItem {
  id: Id
  title: string
  status: EventStatus
  starts_at: number | null
  location: string | null
  teams_count: number
  criteria_count: number
  judges_count: number
  submitted_count: number
  created_at: number
}

export interface EventRecord {
  id: Id
  title: string
  description: string
  starts_at: number | null
  location: string | null
  status: EventStatus
  scoring_mode: ScoringMode
  notes_enabled: boolean
  visibility: Visibility
  quorum: number
  teams_label: string | null
  teams_label_enabled: boolean
  criteria_label: string | null
  criteria_label_enabled: boolean
  alert_enabled: boolean
  alert_title: string
  alert_text: string
  alert_align: AlertAlign
  alert_button_text: string
  alert_version: number
  /** `/api/public/events/{id}/background?v=…` or null. */
  background_url: string | null
  overlay_enabled: boolean
  overlay_color: string
  overlay_opacity: number
  locked_at: number | null
  created_at: number
  updated_at: number
}

export interface Team {
  id: Id
  name: string
  description: string | null
  sort_order: number
}
export interface Criterion {
  id: Id
  name: string
  description: string | null
  max_x100: number
  step_x100: number
  weight: number
  sort_order: number
}
export interface JudgeSummary {
  id: Id
  name: string
  is_active: boolean
  submitted_at: number | null
  last_seen_at: number | null
  pending_count: number
  scored_count: number
}
export interface EventFull {
  event: EventRecord
  teams: Team[]
  criteria: Criterion[]
  judges: JudgeSummary[]
}

export interface CreateEventRequest {
  title: string
  description?: string
  starts_at?: number | null
  location?: string | null
}
/** Any subset of editable fields; scoring_mode / notes_enabled only in draft. */
export type UpdateEventRequest = Partial<
  Pick<
    EventRecord,
    | 'title'
    | 'description'
    | 'starts_at'
    | 'location'
    | 'scoring_mode'
    | 'notes_enabled'
    | 'visibility'
    | 'quorum'
    | 'teams_label'
    | 'teams_label_enabled'
    | 'criteria_label'
    | 'criteria_label_enabled'
    | 'alert_enabled'
    | 'alert_title'
    | 'alert_text'
    | 'alert_align'
    | 'alert_button_text'
    | 'overlay_enabled'
    | 'overlay_color'
    | 'overlay_opacity'
  >
>

export interface TransitionRequest {
  to: EventStatus
  reason?: string
  force?: boolean
}

export interface TeamInput {
  name: string
  description?: string | null
}
export interface CriterionInput {
  name: string
  description?: string | null
  max_x100: number
  step_x100: number
  weight: number
}
export interface OrderRequest {
  ids: Id[]
}

export interface CreateJudgesRequest {
  names: string[]
}
export interface JudgeWithLink {
  judge: JudgeSummary
  link: string
}
export interface UpdateJudgeRequest {
  name?: string
  is_active?: boolean
}
export interface ReopenJudgeRequest {
  reason: string
}

export interface MatrixCell {
  judge_id: Id
  team_id: Id
  scored: number
  total: number
}
export interface Matrix {
  judges: JudgeSummary[]
  teams: { id: Id; name: string }[]
  cells: MatrixCell[]
}

export interface AuditEntry {
  id: number
  admin_name: string | null
  action: string
  details: unknown
  created_at: number
}

// ---- ranking (SPEC §5) ----
export type RankingMode = 'official' | 'provisional'
export interface CriterionAvg {
  criterion_id: Id
  avg_x100: number | null
}
export interface JudgeScore {
  judge_id: Id
  judge_name: string
  score_x100: number
}
export interface RankingRow {
  rank: number | null
  tie: boolean
  team_id: Id
  team_name: string
  score_x100: number | null
  sheets: number
  meets_quorum: boolean
  criteria: CriterionAvg[]
  judges: JudgeScore[]
}
export interface Ranking {
  mode: RankingMode
  quorum: number
  rows: RankingRow[]
}
/** Public payloads share the admin ranking shape. */
export type PublicRankingRow = RankingRow
export type PublicRanking = Ranking
export interface ResultSnapshot {
  id: Id
  created_at: number
  created_by: Id | null
}
export interface ResultsResponse extends Ranking {
  snapshot?: ResultSnapshot
}

// ---- judge ----
export interface JudgeAlert {
  enabled: boolean
  title: string
  text: string
  align: AlertAlign
  button_text: string
  version: number
}
export interface Overlay {
  enabled: boolean
  color: string
  opacity: number
}
export interface JudgeSessionEvent {
  id: Id
  title: string
  description: string
  status: EventStatus
  scoring_mode: ScoringMode
  notes_enabled: boolean
  locked_at: number | null
  teams_label: string | null
  teams_label_enabled: boolean
  criteria_label: string | null
  criteria_label_enabled: boolean
  alert: JudgeAlert
  background_url: string | null
  overlay: Overlay
}
export interface JudgeScoreRecord {
  team_id: Id
  criterion_id: Id
  value_x100: number
  note: string | null
  edited_at: number
}
export interface JudgeSession {
  judge: { id: Id; name: string; submitted_at: number | null }
  event: JudgeSessionEvent
  teams: Team[]
  criteria: Criterion[]
  scores: JudgeScoreRecord[]
}
export interface ScoreItem {
  team_id: Id
  criterion_id: Id
  /** null deletes the score. */
  value_x100: number | null
  note: string | null
  edited_at: number
}
export interface PutScoresRequest {
  items: ScoreItem[]
}
export type ScoreResultStatus = 'ok' | 'stale' | 'rejected'
export interface ScoreResult {
  team_id: Id
  criterion_id: Id
  status: ScoreResultStatus
  /** e.g. invalid_state, sheet_submitted, validation */
  error?: string
  server?: { value_x100: number | null; note: string | null; edited_at: number }
}
export interface PutScoresResponse {
  results: ScoreResult[]
}
export interface JudgeSubmitResponse {
  judge: { id: Id; name: string; submitted_at: number | null }
}
export interface SubmitMissingDetails {
  missing: { team_id: Id; criterion_id: Id }[]
}
/** 409 invalid_state details when finalizing with unsubmitted judges. */
export interface UnsubmittedDetails {
  unsubmitted: { id: Id; name: string }[]
}
/** 409 invalid_state details when draft -> judging lacks content. */
export interface MissingContentDetails {
  missing: ('teams' | 'criteria' | 'judges')[]
}
export interface HeartbeatRequest {
  pending_count: number
}

// ---- public ----
export interface PublicEvent {
  id: Id
  title: string
  description: string
  status: EventStatus
  teams_label: string | null
  teams_label_enabled: boolean
  criteria_label: string | null
  criteria_label_enabled: boolean
  background_url: string | null
  overlay: Overlay
  /** Present for published events or visibility live_full; used to label per-criterion columns. */
  criteria?: Pick<Criterion, 'id' | 'name'>[]
}
export interface PublicEventResponse {
  event: PublicEvent
  results: PublicRanking | null
}

// ---- stream ----
export type ChangeKind = 'scores' | 'status' | 'event' | 'composition' | 'alert' | 'judges'
