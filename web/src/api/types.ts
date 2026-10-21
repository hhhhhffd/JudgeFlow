// Types for every request/response in docs/SPEC.md §8 (+ Ranking from §5).
// IDs are UUID strings, timestamps are Unix ms, scores are integers in hundredths (`*_x100`).

export type Id = string
export type Role = 'owner' | 'admin'
export type EventStatus = 'draft' | 'judging' | 'locked' | 'finalized' | 'published'
export type ScoringMode = 'team' | 'criterion' | 'pairwise'
export type Normalization = 'none' | 'center'
export type Winner = 'a' | 'b' | 'tie'
export type Visibility = 'hidden' | 'live_totals' | 'live_full'
export type AlertAlign = 'left' | 'center'
export type StageView = 'waiting' | 'leaderboard' | 'podium'
export type StageAction = 'next' | 'prev' | 'reset' | 'all'

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
  /** SPEC §13: rounds are chained through the parent. */
  parent_event_id: Id | null
  round: number
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
  stage_view: StageView
  stage_top_n: number
  stage_revealed: number
  /** Track shown on the stage; null = teams without a track / the only group. */
  stage_track_id: Id | null
  /** Explicit switch for assignments; absent on older servers (then: any assignment row). */
  assignments_enabled?: boolean
  parent_event_id: Id | null
  round: number
  normalization: Normalization
  locked_at: number | null
  created_at: number
  updated_at: number
}

export interface Track {
  id: Id
  name: string
}
export interface Team {
  id: Id
  name: string
  description: string | null
  /** Track the team competes in (SPEC §12), null = none. */
  track_id: Id | null
  sort_order: number
}
export interface Criterion {
  id: Id
  name: string
  description: string | null
  max_x100: number
  step_x100: number
  weight: number
  /** null = applies to every team. */
  track_id: Id | null
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
export interface JudgeTeamPair {
  judge_id: Id
  team_id: Id
}
export interface EventFull {
  event: EventRecord
  teams: Team[]
  criteria: Criterion[]
  judges: JudgeSummary[]
  tracks: Track[]
  /** A judge with no assignment judges every team. */
  assignments: JudgeTeamPair[]
  conflicts: JudgeTeamPair[]
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
    | 'stage_view'
    | 'stage_top_n'
    | 'stage_track_id'
    | 'normalization'
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
  track_id?: Id | null
}
export interface CriterionInput {
  name: string
  description?: string | null
  max_x100: number
  step_x100: number
  weight: number
  track_id?: Id | null
}
export interface AutoAssignRequest {
  judges_per_team: number
  allow_short?: boolean
}
/** 409 details of POST …/assignments/auto when some team cannot get enough judges. */
export interface AutoAssignShortDetails {
  short: { team_id: Id; got: number }[]
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
  /** An explicit assignment row exists; with no assignments in the event every team is in the judge's set. */
  assigned: boolean
  /** Conflict of interest; wins over assignment (total is 0). */
  conflict: boolean
}
export interface Matrix {
  judges: JudgeSummary[]
  teams: { id: Id; name: string; track_id: Id | null }[]
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
  /** Pairwise mode only: decided comparisons of the team. */
  wins?: number
  losses?: number
  ties?: number
  /** Present when centering is on: the score before normalization. */
  raw_score_x100?: number | null
  /** Ranks restart per track. */
  track_id: Id | null
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
  tracks: Track[]
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
export interface ComparisonRecord {
  id: Id
  team_a: Id
  team_b: Id
  winner: Winner | null
  edited_at: number | null
}
export interface JudgeSession {
  judge: { id: Id; name: string; submitted_at: number | null }
  event: JudgeSessionEvent
  teams: Team[]
  criteria: Criterion[]
  tracks: Track[]
  scores: JudgeScoreRecord[]
  /** Pairwise mode only. */
  comparisons?: ComparisonRecord[]
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
  /** e.g. invalid_state, sheet_submitted, validation, not_assigned */
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
  criteria?: Pick<Criterion, 'id' | 'name' | 'track_id'>[]
}
export interface PublicEventResponse {
  event: PublicEvent
  results: PublicRanking | null
}

/** GET /api/public/events/:id/stage (SPEC §11): only revealed rows, never per-judge data. */
export interface StageState {
  view: StageView
  top_n: number
  revealed: number
  total_groups: number
  available: boolean
  /** Track whose rows are shown. */
  track_id: Id | null
}
export interface StageEvent {
  id: Id
  title: string
  status: EventStatus
  background_url: string | null
  overlay: Overlay
  teams_label: string | null
  teams_label_enabled: boolean
  criteria_label: string | null
  criteria_label_enabled: boolean
  criteria: Pick<Criterion, 'id' | 'name' | 'track_id'>[]
}
export interface StageResponse {
  event: StageEvent
  stage: StageState
  tracks: Track[]
  rows: PublicRankingRow[]
}

// ---- stream ----
export type ChangeKind = 'scores' | 'status' | 'event' | 'composition' | 'alert' | 'judges' | 'presence' | 'stage'

// ---- emergency sheet export / import (SPEC §12) ----
export const SHEET_FORMAT = 'judgeflow-sheet/1'
export interface SheetFile {
  format: typeof SHEET_FORMAT
  event_id: Id
  judge_id: Id
  judge_name: string
  /** The judge's raw token: the file is personal. */
  token: string
  exported_at: number
  items: ScoreItem[]
}

// ---- rounds (SPEC §13) ----
export interface NextRoundRequest {
  title: string
  team_ids: Id[]
  scoring_mode: ScoringMode
  copy_criteria: boolean
  copy_judges: boolean
}
export interface NextRoundResponse {
  event: EventFull
  links: JudgeWithLink[]
}

// ---- pairwise comparisons (SPEC §13) ----
export interface ComparisonItem {
  id: Id
  /** null clears the decision. */
  winner: Winner | null
  edited_at: number
}
export type ComparisonResultStatus = 'ok' | 'stale' | 'rejected'
export interface ComparisonResult {
  id: Id
  status: ComparisonResultStatus
  error?: string
  server?: { winner: Winner | null; edited_at: number }
}
export interface PutComparisonsResponse {
  results: ComparisonResult[]
}
export interface ReservePairsResponse {
  comparisons: ComparisonRecord[]
}
/** 409 details of POST /judge/submit in pairwise mode while undecided pairs remain. */
export interface SubmitOpenDetails {
  open: Id[]
}
