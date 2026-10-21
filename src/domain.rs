//! Shared event data: row types, loaders, input validation helpers and the single place that
//! turns database rows into a ranking (used by results, CSV, public pages and finalize).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::error::{AppError, AppResult};
use crate::ranking::{self, Input, Mode, Ranking};

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Event {
    pub id: String,
    pub title: String,
    pub description: String,
    pub starts_at: Option<i64>,
    pub location: Option<String>,
    pub status: String,
    pub scoring_mode: String,
    pub notes_enabled: bool,
    pub visibility: String,
    pub quorum: i64,
    pub teams_label: Option<String>,
    pub teams_label_enabled: bool,
    pub criteria_label: Option<String>,
    pub criteria_label_enabled: bool,
    pub alert_enabled: bool,
    pub alert_title: String,
    pub alert_text: String,
    pub alert_align: String,
    pub alert_button_text: String,
    pub alert_version: i64,
    #[serde(skip)]
    pub background_file: Option<String>,
    pub overlay_enabled: bool,
    pub overlay_color: String,
    pub overlay_opacity: i64,
    pub stage_view: String,
    pub stage_top_n: i64,
    pub stage_revealed: i64,
    pub stage_track_id: Option<String>,
    pub parent_event_id: Option<String>,
    pub round: i64,
    pub normalization: String,
    pub locked_at: Option<i64>,
    #[serde(skip)]
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Event {
    /// URL of the public background endpoint; `v` busts browser caches after a change.
    pub fn background_url(&self) -> Option<String> {
        self.background_file.as_ref().map(|_| {
            format!(
                "/api/public/events/{}/background?v={}",
                self.id, self.updated_at
            )
        })
    }

    /// Flat admin representation (`event` of `EventFull`).
    pub fn admin_json(&self) -> Value {
        let mut value = serde_json::to_value(self).expect("event serializes");
        value["background_url"] = json!(self.background_url());
        value
    }

    pub fn alert_json(&self) -> Value {
        json!({
            "enabled": self.alert_enabled,
            "title": self.alert_title,
            "text": self.alert_text,
            "align": self.alert_align,
            "button_text": self.alert_button_text,
            "version": self.alert_version,
        })
    }

    pub fn overlay_json(&self) -> Value {
        json!({
            "enabled": self.overlay_enabled,
            "color": self.overlay_color,
            "opacity": self.overlay_opacity,
        })
    }
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sort_order: i64,
    pub track_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Track {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Criterion {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub max_x100: i64,
    pub step_x100: i64,
    pub weight: i64,
    pub sort_order: i64,
    /// `None` = applies to every team.
    pub track_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct JudgeSummary {
    pub id: String,
    pub name: String,
    pub is_active: bool,
    pub submitted_at: Option<i64>,
    pub last_seen_at: Option<i64>,
    pub pending_count: i64,
    pub scored_count: i64,
}

pub async fn load_event(conn: &mut SqliteConnection, id: &str) -> AppResult<Event> {
    sqlx::query_as::<_, Event>("SELECT * FROM events WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

pub async fn load_teams(conn: &mut SqliteConnection, event_id: &str) -> AppResult<Vec<Team>> {
    Ok(sqlx::query_as::<_, Team>(
        "SELECT id, name, description, sort_order, track_id FROM teams WHERE event_id = ? \
         ORDER BY sort_order, rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

pub async fn load_criteria(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Vec<Criterion>> {
    Ok(sqlx::query_as::<_, Criterion>(
        "SELECT id, name, description, max_x100, step_x100, weight, sort_order, track_id FROM criteria \
         WHERE event_id = ? ORDER BY sort_order, rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

pub async fn load_tracks(conn: &mut SqliteConnection, event_id: &str) -> AppResult<Vec<Track>> {
    Ok(sqlx::query_as::<_, Track>(
        "SELECT id, name, sort_order FROM tracks WHERE event_id = ? ORDER BY sort_order, rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

/// Explicit `(judge_id, team_id)` assignments of the event.
pub async fn load_assignments(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT a.judge_id, a.team_id FROM assignments a JOIN judges j ON j.id = a.judge_id \
         WHERE j.event_id = ? ORDER BY a.rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

/// `(judge_id, team_id)` conflicts of interest of the event.
pub async fn load_conflicts(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT c.judge_id, c.team_id FROM conflicts c JOIN judges j ON j.id = c.judge_id \
         WHERE j.event_id = ? ORDER BY c.rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

/// Checks that `track_id` (when given) is a track of `event_id`.
pub async fn check_track(
    conn: &mut SqliteConnection,
    event_id: &str,
    track_id: Option<&str>,
) -> AppResult<()> {
    let Some(track_id) = track_id else {
        return Ok(());
    };
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM tracks WHERE id = ? AND event_id = ?")
            .bind(track_id)
            .bind(event_id)
            .fetch_optional(conn)
            .await?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::Validation("Трек не найден в этом событии".into()))
}

/// Teams, criteria, tracks, assignments and conflicts of an event, with the one definition of
/// which teams a judge covers and which criteria apply to a team (SPEC section 12). Judge
/// session, score writes, submit, progress counters, the matrix and ranking all go through it.
pub struct Layout {
    pub tracks: Vec<Track>,
    pub teams: Vec<Team>,
    pub criteria: Vec<Criterion>,
    team_track: HashMap<String, Option<String>>,
    assigned: HashMap<String, HashSet<String>>,
    conflicts: HashSet<(String, String)>,
}

impl Layout {
    pub async fn load(conn: &mut SqliteConnection, event_id: &str) -> AppResult<Self> {
        let tracks = load_tracks(&mut *conn, event_id).await?;
        let teams = load_teams(&mut *conn, event_id).await?;
        let criteria = load_criteria(&mut *conn, event_id).await?;
        let mut assigned: HashMap<String, HashSet<String>> = HashMap::new();
        for (judge, team) in load_assignments(&mut *conn, event_id).await? {
            assigned.entry(judge).or_default().insert(team);
        }
        let conflicts = load_conflicts(&mut *conn, event_id)
            .await?
            .into_iter()
            .collect();
        let team_track = teams
            .iter()
            .map(|t| (t.id.clone(), t.track_id.clone()))
            .collect();
        Ok(Self {
            tracks,
            teams,
            criteria,
            team_track,
            assigned,
            conflicts,
        })
    }

    pub fn has_assignment(&self, judge_id: &str, team_id: &str) -> bool {
        self.assigned
            .get(judge_id)
            .is_some_and(|teams| teams.contains(team_id))
    }

    pub fn has_conflict(&self, judge_id: &str, team_id: &str) -> bool {
        self.conflicts
            .contains(&(judge_id.to_string(), team_id.to_string()))
    }

    /// All teams while the event has no assignments; afterwards only the judge's assigned teams
    /// (a judge without assignments covers nothing). A conflict always wins.
    pub fn judge_covers(&self, judge_id: &str, team_id: &str) -> bool {
        !self.has_conflict(judge_id, team_id)
            && (self.assigned.is_empty() || self.has_assignment(judge_id, team_id))
    }

    /// Whether `criterion` is scored for `team_id` (unknown teams get only track-less criteria).
    pub fn applies(&self, team_id: &str, criterion: &Criterion) -> bool {
        criterion.track_id.is_none()
            || self
                .team_track
                .get(team_id)
                .is_some_and(|track| *track == criterion.track_id)
    }

    /// The judge's teams in display order.
    pub fn judge_teams(&self, judge_id: &str) -> Vec<&Team> {
        self.teams
            .iter()
            .filter(|t| self.judge_covers(judge_id, &t.id))
            .collect()
    }

    /// Every `(team, criterion)` the judge must score for a complete sheet.
    pub fn required(&self, judge_id: &str) -> Vec<(&Team, &Criterion)> {
        self.judge_teams(judge_id)
            .into_iter()
            .flat_map(|team| {
                self.criteria
                    .iter()
                    .filter(|c| self.applies(&team.id, c))
                    .map(move |c| (team, c))
            })
            .collect()
    }

    /// Whether the judge has to score `criterion_id` for `team_id`.
    pub fn is_required(&self, judge_id: &str, team_id: &str, criterion: &Criterion) -> bool {
        self.team_track.contains_key(team_id)
            && self.judge_covers(judge_id, team_id)
            && self.applies(team_id, criterion)
    }

    /// Saved scores per `(judge, team)` that count: inside the judge's teams and team criteria.
    /// `saved` is `(judge_id, team_id, criterion_id)`.
    pub fn scored_per_cell<'a>(
        &self,
        saved: &'a [(String, String, String)],
    ) -> HashMap<(&'a str, &'a str), i64> {
        let criteria: HashMap<&str, &Criterion> =
            self.criteria.iter().map(|c| (c.id.as_str(), c)).collect();
        let mut counts = HashMap::new();
        for (judge, team, criterion) in saved {
            if criteria
                .get(criterion.as_str())
                .is_some_and(|c| self.is_required(judge, team, c))
            {
                *counts.entry((judge.as_str(), team.as_str())).or_default() += 1;
            }
        }
        counts
    }

    /// Track groups in ranking order: tracks in order, then teams without a track. Empty groups
    /// are skipped; an event without tracks is a single group.
    fn groups(&self) -> Vec<(Option<String>, Vec<&Team>)> {
        let mut groups: Vec<(Option<String>, Vec<&Team>)> = self
            .tracks
            .iter()
            .map(|track| {
                let teams = self
                    .teams
                    .iter()
                    .filter(|t| t.track_id.as_deref() == Some(track.id.as_str()))
                    .collect();
                (Some(track.id.clone()), teams)
            })
            .collect();
        groups.push((
            None,
            self.teams.iter().filter(|t| t.track_id.is_none()).collect(),
        ));
        groups.retain(|(_, teams)| !teams.is_empty());
        groups
    }
}

/// Fills `scored_count` (saved scores inside the judge's teams x team criteria).
async fn fill_scored_counts(
    conn: &mut SqliteConnection,
    event_id: &str,
    judges: &mut [JudgeSummary],
) -> AppResult<()> {
    let layout = Layout::load(&mut *conn, event_id).await?;
    let saved: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT s.judge_id, s.team_id, s.criterion_id FROM scores s \
         JOIN judges j ON j.id = s.judge_id WHERE j.event_id = ? AND s.value_x100 IS NOT NULL",
    )
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut counts: HashMap<&str, i64> = HashMap::new();
    for ((judge, _), n) in layout.scored_per_cell(&saved) {
        *counts.entry(judge).or_default() += n;
    }
    for judge in judges {
        judge.scored_count = counts.get(judge.id.as_str()).copied().unwrap_or(0);
    }
    Ok(())
}

pub async fn load_judges(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Vec<JudgeSummary>> {
    let mut judges = sqlx::query_as::<_, JudgeSummary>(
        "SELECT j.id, j.name, j.is_active, j.submitted_at, j.last_seen_at, j.pending_count, \
         0 AS scored_count FROM judges j WHERE j.event_id = ? ORDER BY j.created_at, j.rowid",
    )
    .bind(event_id)
    .fetch_all(&mut *conn)
    .await?;
    fill_scored_counts(conn, event_id, &mut judges).await?;
    Ok(judges)
}

pub async fn load_judge_summary(
    conn: &mut SqliteConnection,
    judge_id: &str,
) -> AppResult<JudgeSummary> {
    let (event_id, summary) = {
        let summary = sqlx::query_as::<_, JudgeSummary>(
            "SELECT j.id, j.name, j.is_active, j.submitted_at, j.last_seen_at, j.pending_count, \
             0 AS scored_count FROM judges j WHERE j.id = ?",
        )
        .bind(judge_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(AppError::NotFound)?;
        let event_id: String = sqlx::query_scalar("SELECT event_id FROM judges WHERE id = ?")
            .bind(judge_id)
            .fetch_one(&mut *conn)
            .await?;
        (event_id, summary)
    };
    let mut judges = [summary];
    fill_scored_counts(conn, &event_id, &mut judges).await?;
    let [summary] = judges;
    Ok(summary)
}

/// `EventFull = {event, teams, criteria, judges, tracks, assignments, conflicts}`.
pub async fn event_full(conn: &mut SqliteConnection, event_id: &str) -> AppResult<Value> {
    let event = load_event(&mut *conn, event_id).await?;
    let teams = load_teams(&mut *conn, event_id).await?;
    let criteria = load_criteria(&mut *conn, event_id).await?;
    let judges = load_judges(&mut *conn, event_id).await?;
    let tracks = load_tracks(&mut *conn, event_id).await?;
    let pairs = |pairs: Vec<(String, String)>| -> Vec<Value> {
        pairs
            .into_iter()
            .map(|(judge_id, team_id)| json!({ "judge_id": judge_id, "team_id": team_id }))
            .collect()
    };
    let assignments = pairs(load_assignments(&mut *conn, event_id).await?);
    let conflicts = pairs(load_conflicts(&mut *conn, event_id).await?);
    Ok(json!({
        "event": event.admin_json(),
        "teams": teams,
        "criteria": criteria,
        "judges": judges,
        "tracks": tracks,
        "assignments": assignments,
        "conflicts": conflicts,
    }))
}

/// The one place that reads scores from the database into the ranking engine's input: one
/// `Input` per track group (SPEC section 12), keyed by the group's track id. A judge's scores
/// count only for teams the judge covers; criteria are the group's (track-less plus its own).
pub async fn ranking_inputs(
    conn: &mut SqliteConnection,
    event: &Event,
) -> AppResult<Vec<(Option<String>, Input)>> {
    let layout = Layout::load(&mut *conn, &event.id).await?;
    let judges: Vec<(String, bool, Option<i64>)> = sqlx::query_as(
        "SELECT id, is_active, submitted_at FROM judges WHERE event_id = ? ORDER BY created_at, rowid",
    )
    .bind(&event.id)
    .fetch_all(&mut *conn)
    .await?;
    let scores: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT s.judge_id, s.team_id, s.criterion_id, s.value_x100 FROM scores s \
         JOIN judges j ON j.id = s.judge_id \
         WHERE j.event_id = ? AND s.value_x100 IS NOT NULL",
    )
    .bind(&event.id)
    .fetch_all(&mut *conn)
    .await?;
    let judge_inputs: Vec<ranking::JudgeInput> = judges
        .into_iter()
        .map(|(id, is_active, submitted_at)| ranking::JudgeInput {
            id,
            is_active,
            submitted: submitted_at.is_some(),
        })
        .collect();
    let quorum = event.quorum.max(1) as u32;

    Ok(layout
        .groups()
        .into_iter()
        .map(|(track_id, teams)| {
            let team_ids: HashSet<&str> = teams.iter().map(|t| t.id.as_str()).collect();
            let criteria = layout
                .criteria
                .iter()
                .filter(|c| c.track_id.is_none() || c.track_id == track_id)
                .map(|c| ranking::CriterionInput {
                    id: c.id.clone(),
                    max_x100: c.max_x100,
                    weight: c.weight,
                })
                .collect();
            let scores = scores
                .iter()
                .filter(|(judge, team, _, _)| {
                    team_ids.contains(team.as_str()) && layout.judge_covers(judge, team)
                })
                .map(
                    |(judge_id, team_id, criterion_id, value_x100)| ranking::ScoreInput {
                        judge_id: judge_id.clone(),
                        team_id: team_id.clone(),
                        criterion_id: criterion_id.clone(),
                        value_x100: *value_x100,
                    },
                )
                .collect();
            let input = Input {
                teams: teams.iter().map(|t| t.id.clone()).collect(),
                criteria,
                judges: judge_inputs.clone(),
                scores,
                quorum,
                normalization: if event.normalization == "center" {
                    ranking::Normalization::Center
                } else {
                    ranking::Normalization::None
                },
            };
            (track_id, input)
        })
        .collect())
}

/// Ranks every track group independently and concatenates the rows in group order.
pub async fn compute_ranking(
    conn: &mut SqliteConnection,
    event: &Event,
    mode: Mode,
) -> AppResult<Ranking> {
    let mut rows = Vec::new();
    for (track_id, input) in ranking_inputs(conn, event).await? {
        let group = ranking::compute(&input, mode);
        rows.extend(group.rows.into_iter().map(|mut row| {
            row.track_id = track_id.clone();
            row
        }));
    }
    Ok(Ranking {
        mode,
        quorum: event.quorum.max(1) as u32,
        rows,
    })
}

/// The track the stage shows: the selected one, or the first group in ranking order (`None`
/// inside `Some` is the group of teams without a track).
pub fn stage_track(ranking: &Ranking, stage_track_id: &Option<String>) -> Option<String> {
    match stage_track_id {
        Some(_) => stage_track_id.clone(),
        None => ranking.rows.first().and_then(|row| row.track_id.clone()),
    }
}

/// Keeps only the rows of the group the stage shows.
pub fn stage_group(mut ranking: Ranking, stage_track_id: &Option<String>) -> Ranking {
    let track = stage_track(&ranking, stage_track_id);
    ranking.rows.retain(|row| row.track_id == track);
    ranking
}

#[derive(Clone, Debug, Serialize)]
pub struct SnapshotMeta {
    pub id: String,
    pub created_at: i64,
    pub created_by: Option<String>,
}

/// Latest official snapshot of the event, if any.
pub async fn latest_snapshot(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Option<(SnapshotMeta, Ranking)>> {
    let row: Option<(String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT id, created_at, created_by, payload FROM result_snapshots \
         WHERE event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
    .bind(event_id)
    .fetch_optional(conn)
    .await?;
    row.map(|(id, created_at, created_by, payload)| {
        let ranking = serde_json::from_str(&payload)
            .map_err(|err| AppError::Internal(anyhow::anyhow!("corrupt snapshot {id}: {err}")))?;
        Ok((
            SnapshotMeta {
                id,
                created_at,
                created_by,
            },
            ranking,
        ))
    })
    .transpose()
}

pub fn is_closed(status: &str) -> bool {
    matches!(status, "finalized" | "published")
}

/// Ranking for `mode`: the latest snapshot for official results of a finalized/published event,
/// otherwise a fresh computation. The snapshot meta is returned for finalized/published events.
pub async fn resolve_ranking(
    conn: &mut SqliteConnection,
    event: &Event,
    mode: Mode,
) -> AppResult<(Ranking, Option<SnapshotMeta>)> {
    if is_closed(&event.status)
        && let Some((meta, snapshot)) = latest_snapshot(&mut *conn, &event.id).await?
    {
        if mode == Mode::Official {
            return Ok((snapshot, Some(meta)));
        }
        return Ok((compute_ranking(conn, event, mode).await?, Some(meta)));
    }
    Ok((compute_ranking(conn, event, mode).await?, None))
}

/// Serializes a ranking and adds `tracks` plus `team_name` to rows and `judge_name` to per-judge entries.
pub async fn ranking_json(
    conn: &mut SqliteConnection,
    event_id: &str,
    ranking: &Ranking,
) -> AppResult<Value> {
    let teams: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM teams WHERE event_id = ?")
            .bind(event_id)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let judges: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT id, name FROM judges WHERE event_id = ?")
            .bind(event_id)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let tracks: Vec<Value> = load_tracks(&mut *conn, event_id)
        .await?
        .into_iter()
        .map(|t| json!({ "id": t.id, "name": t.name }))
        .collect();
    let mut value = serde_json::to_value(ranking).expect("ranking serializes");
    value["tracks"] = json!(tracks);
    if let Some(rows) = value["rows"].as_array_mut() {
        for row in rows {
            let team_name = row["team_id"]
                .as_str()
                .and_then(|id| teams.get(id))
                .cloned()
                .unwrap_or_default();
            row["team_name"] = json!(team_name);
            if let Some(entries) = row["judges"].as_array_mut() {
                for entry in entries {
                    let name = entry["judge_id"]
                        .as_str()
                        .and_then(|id| judges.get(id))
                        .cloned()
                        .unwrap_or_default();
                    entry["judge_name"] = json!(name);
                }
            }
        }
    }
    Ok(value)
}

// ---- validation helpers (messages are user-facing Russian text) ----

/// Trims `raw` and checks it is non-empty, at most `max` chars and has no control characters.
pub fn clean_required(raw: &str, field: &str, max: usize) -> AppResult<String> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(AppError::Validation(format!(
            "{field}: от 1 до {max} символов без управляющих символов"
        )));
    }
    Ok(value.to_string())
}

/// Optional free text (newlines and tabs allowed). Empty becomes `None`.
pub fn clean_optional(raw: &str, field: &str, max: usize) -> AppResult<Option<String>> {
    let value = raw.trim();
    if value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(AppError::Validation(format!(
            "{field}: не более {max} символов"
        )));
    }
    Ok((!value.is_empty()).then(|| value.to_string()))
}

/// Deserializes `"field": null` as `Some(None)` and a missing field as `None` (PATCH semantics).
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

pub fn draft_only(event: &Event) -> AppResult<()> {
    if event.status != "draft" {
        return Err(AppError::InvalidState(
            "Это можно менять только в черновике".into(),
            None,
        ));
    }
    Ok(())
}
