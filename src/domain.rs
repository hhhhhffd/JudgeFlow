//! Shared event data: row types, loaders, input validation helpers and the single place that
//! turns database rows into a ranking (used by results, CSV, public pages and finalize).

use std::collections::HashMap;

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
        "SELECT id, name, description, sort_order FROM teams WHERE event_id = ? \
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
        "SELECT id, name, description, max_x100, step_x100, weight, sort_order FROM criteria \
         WHERE event_id = ? ORDER BY sort_order, rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

pub async fn load_judges(
    conn: &mut SqliteConnection,
    event_id: &str,
) -> AppResult<Vec<JudgeSummary>> {
    Ok(sqlx::query_as::<_, JudgeSummary>(
        "SELECT j.id, j.name, j.is_active, j.submitted_at, j.last_seen_at, j.pending_count, \
         (SELECT COUNT(*) FROM scores s WHERE s.judge_id = j.id) AS scored_count \
         FROM judges j WHERE j.event_id = ? ORDER BY j.created_at, j.rowid",
    )
    .bind(event_id)
    .fetch_all(conn)
    .await?)
}

pub async fn load_judge_summary(
    conn: &mut SqliteConnection,
    judge_id: &str,
) -> AppResult<JudgeSummary> {
    sqlx::query_as::<_, JudgeSummary>(
        "SELECT j.id, j.name, j.is_active, j.submitted_at, j.last_seen_at, j.pending_count, \
         (SELECT COUNT(*) FROM scores s WHERE s.judge_id = j.id) AS scored_count \
         FROM judges j WHERE j.id = ?",
    )
    .bind(judge_id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

/// `EventFull = {event, teams, criteria, judges}`.
pub async fn event_full(conn: &mut SqliteConnection, event_id: &str) -> AppResult<Value> {
    let event = load_event(&mut *conn, event_id).await?;
    let teams = load_teams(&mut *conn, event_id).await?;
    let criteria = load_criteria(&mut *conn, event_id).await?;
    let judges = load_judges(&mut *conn, event_id).await?;
    Ok(json!({
        "event": event.admin_json(),
        "teams": teams,
        "criteria": criteria,
        "judges": judges,
    }))
}

/// The one place that reads scores from the database into the ranking engine's input.
pub async fn ranking_input(conn: &mut SqliteConnection, event: &Event) -> AppResult<Input> {
    let teams = load_teams(&mut *conn, &event.id).await?;
    let criteria = load_criteria(&mut *conn, &event.id).await?;
    let judges: Vec<(String, bool, Option<i64>)> = sqlx::query_as(
        "SELECT id, is_active, submitted_at FROM judges WHERE event_id = ? ORDER BY created_at, rowid",
    )
    .bind(&event.id)
    .fetch_all(&mut *conn)
    .await?;
    let scores: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT s.judge_id, s.team_id, s.criterion_id, s.value_x100 FROM scores s \
         JOIN judges j ON j.id = s.judge_id WHERE j.event_id = ?",
    )
    .bind(&event.id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Input {
        teams: teams.into_iter().map(|t| t.id).collect(),
        criteria: criteria
            .into_iter()
            .map(|c| ranking::CriterionInput {
                id: c.id,
                max_x100: c.max_x100,
                weight: c.weight,
            })
            .collect(),
        judges: judges
            .into_iter()
            .map(|(id, is_active, submitted_at)| ranking::JudgeInput {
                id,
                is_active,
                submitted: submitted_at.is_some(),
            })
            .collect(),
        scores: scores
            .into_iter()
            .map(
                |(judge_id, team_id, criterion_id, value_x100)| ranking::ScoreInput {
                    judge_id,
                    team_id,
                    criterion_id,
                    value_x100,
                },
            )
            .collect(),
        quorum: event.quorum.max(1) as u32,
    })
}

pub async fn compute_ranking(
    conn: &mut SqliteConnection,
    event: &Event,
    mode: Mode,
) -> AppResult<Ranking> {
    let input = ranking_input(conn, event).await?;
    Ok(ranking::compute(&input, mode))
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

/// Serializes a ranking and adds `team_name` to rows and `judge_name` to per-judge entries.
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
    let mut value = serde_json::to_value(ranking).expect("ranking serializes");
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
