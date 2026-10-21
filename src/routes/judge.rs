//! Judge-facing API (Bearer token): session, score sync, submit/unsubmit, heartbeat, stream.

use std::collections::{HashMap, HashSet};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::JudgeAuth;
use crate::db::begin_write;
use crate::domain::{load_criteria, load_event, load_teams};
use crate::error::{AppError, AppResult};
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::now_ms;

const NOTE_MAX_CHARS: usize = 2000;
const ITEMS_MAX: usize = 5000;
/// Client clocks are trusted, but not blindly: a timestamp far in the future would block later edits.
const MAX_CLOCK_SKEW_MS: i64 = 24 * 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/judge/session", get(session))
        .route("/judge/scores", put(put_scores))
        .route("/judge/submit", post(submit))
        .route("/judge/unsubmit", post(unsubmit))
        .route("/judge/heartbeat", post(heartbeat))
        .route("/judge/stream", get(stream))
}

async fn session(State(state): State<AppState>, auth: JudgeAuth) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let event = load_event(&mut conn, &auth.event_id).await?;
    let teams = load_teams(&mut conn, &event.id).await?;
    let criteria = load_criteria(&mut conn, &event.id).await?;
    let submitted_at: Option<i64> =
        sqlx::query_scalar("SELECT submitted_at FROM judges WHERE id = ?")
            .bind(&auth.judge_id)
            .fetch_one(&mut *conn)
            .await?;
    let scores: Vec<(String, String, i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT team_id, criterion_id, value_x100, note, edited_at FROM scores WHERE judge_id = ?",
    )
    .bind(&auth.judge_id)
    .fetch_all(&mut *conn)
    .await?;
    let scores: Vec<Value> = scores
        .into_iter()
        .map(|(team_id, criterion_id, value_x100, note, edited_at)| {
            json!({
                "team_id": team_id, "criterion_id": criterion_id,
                "value_x100": value_x100, "note": note, "edited_at": edited_at,
            })
        })
        .collect();
    Ok(Json(json!({
        "judge": { "id": auth.judge_id, "name": auth.name, "submitted_at": submitted_at },
        "event": {
            "id": event.id,
            "title": event.title,
            "description": event.description,
            "status": event.status,
            "scoring_mode": event.scoring_mode,
            "notes_enabled": event.notes_enabled,
            "locked_at": event.locked_at,
            "teams_label": event.teams_label,
            "teams_label_enabled": event.teams_label_enabled,
            "criteria_label": event.criteria_label,
            "criteria_label_enabled": event.criteria_label_enabled,
            "alert": event.alert_json(),
            "background_url": event.background_url(),
            "overlay": event.overlay_json(),
        },
        "teams": teams,
        "criteria": criteria,
        "scores": scores,
    })))
}

#[derive(Deserialize)]
struct ScoresRequest {
    items: Vec<ScoreItem>,
}

#[derive(Deserialize)]
struct ScoreItem {
    team_id: String,
    criterion_id: String,
    value_x100: Option<i64>,
    note: Option<String>,
    edited_at: i64,
}

/// Why a score item cannot be applied (the `error` code of a `rejected` result).
fn rejection(item: &ScoreItem, error: &str) -> Value {
    json!({
        "team_id": item.team_id, "criterion_id": item.criterion_id,
        "status": "rejected", "error": error,
    })
}

async fn put_scores(
    State(state): State<AppState>,
    auth: JudgeAuth,
    Json(req): Json<ScoresRequest>,
) -> AppResult<Json<Value>> {
    if req.items.len() > ITEMS_MAX {
        return Err(AppError::Validation(format!(
            "Не более {ITEMS_MAX} оценок за один запрос"
        )));
    }
    let now = now_ms();
    let mut tx = begin_write(&state.pool).await?;
    // Re-read judge and event inside the write lock: closing the event, submitting and
    // reopening are serialized with this batch.
    let judge: Option<(bool, Option<i64>)> =
        sqlx::query_as("SELECT is_active, submitted_at FROM judges WHERE id = ?")
            .bind(&auth.judge_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (true, submitted_at) = judge.ok_or(AppError::Unauthorized)? else {
        return Err(AppError::Unauthorized);
    };
    let event = load_event(&mut tx, &auth.event_id).await?;
    let teams: HashSet<String> = load_teams(&mut tx, &event.id)
        .await?
        .into_iter()
        .map(|t| t.id)
        .collect();
    let criteria: HashMap<String, (i64, i64)> = load_criteria(&mut tx, &event.id)
        .await?
        .into_iter()
        .map(|c| (c.id, (c.max_x100, c.step_x100)))
        .collect();

    let mut results = Vec::with_capacity(req.items.len());
    let mut applied = false;
    for item in &req.items {
        if submitted_at.is_some() {
            results.push(rejection(item, "sheet_submitted"));
            continue;
        }
        let in_window = match event.status.as_str() {
            "judging" => true,
            "locked" => event
                .locked_at
                .is_some_and(|locked| item.edited_at <= locked),
            _ => false,
        };
        if !in_window {
            results.push(rejection(item, "invalid_state"));
            continue;
        }
        let Some(&(max, step)) = criteria.get(&item.criterion_id) else {
            results.push(rejection(item, "not_found"));
            continue;
        };
        if !teams.contains(&item.team_id) {
            results.push(rejection(item, "not_found"));
            continue;
        }
        let note = item
            .note
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty() && event.notes_enabled);
        let invalid_value = item
            .value_x100
            .is_some_and(|v| v < 0 || v > max || v % step != 0);
        let invalid_note = note.is_some_and(|n| n.chars().count() > NOTE_MAX_CHARS);
        if invalid_value
            || invalid_note
            || item.edited_at < 0
            || item.edited_at > now + MAX_CLOCK_SKEW_MS
        {
            results.push(rejection(item, "validation"));
            continue;
        }

        let existing: Option<(i64, Option<String>, i64)> = sqlx::query_as(
            "SELECT value_x100, note, edited_at FROM scores \
             WHERE judge_id = ? AND team_id = ? AND criterion_id = ?",
        )
        .bind(&auth.judge_id)
        .bind(&item.team_id)
        .bind(&item.criterion_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some((value_x100, note, edited_at)) = &existing
            && *edited_at > item.edited_at
        {
            results.push(json!({
                "team_id": item.team_id, "criterion_id": item.criterion_id, "status": "stale",
                "server": { "value_x100": value_x100, "note": note, "edited_at": edited_at },
            }));
            continue;
        }

        match item.value_x100 {
            Some(value) => {
                sqlx::query(
                    "INSERT INTO scores (judge_id, team_id, criterion_id, value_x100, note, edited_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?) \
                     ON CONFLICT (judge_id, team_id, criterion_id) DO UPDATE SET \
                     value_x100 = excluded.value_x100, note = excluded.note, \
                     edited_at = excluded.edited_at, updated_at = excluded.updated_at",
                )
                .bind(&auth.judge_id)
                .bind(&item.team_id)
                .bind(&item.criterion_id)
                .bind(value)
                .bind(note)
                .bind(item.edited_at)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
            None => {
                sqlx::query(
                    "DELETE FROM scores WHERE judge_id = ? AND team_id = ? AND criterion_id = ?",
                )
                .bind(&auth.judge_id)
                .bind(&item.team_id)
                .bind(&item.criterion_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        applied = true;
        results.push(json!({
            "team_id": item.team_id, "criterion_id": item.criterion_id, "status": "ok",
        }));
    }
    tx.commit().await?;
    if applied {
        state.sse.notify(&event.id, ChangeKind::Scores);
    }
    Ok(Json(json!({ "results": results })))
}

fn judge_json(auth: &JudgeAuth, submitted_at: Option<i64>) -> Value {
    json!({ "judge": { "id": auth.judge_id, "name": auth.name, "submitted_at": submitted_at } })
}

async fn submit(State(state): State<AppState>, auth: JudgeAuth) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &auth.event_id).await?;
    if event.status != "judging" {
        return Err(AppError::InvalidState(
            "Сдавать лист можно только во время оценивания".into(),
            None,
        ));
    }
    let submitted_at: Option<i64> =
        sqlx::query_scalar("SELECT submitted_at FROM judges WHERE id = ? AND is_active = 1")
            .bind(&auth.judge_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::Unauthorized)?;
    if submitted_at.is_some() {
        return Ok(Json(judge_json(&auth, submitted_at)));
    }
    let scored: HashSet<(String, String)> = sqlx::query_as::<_, (String, String)>(
        "SELECT team_id, criterion_id FROM scores WHERE judge_id = ?",
    )
    .bind(&auth.judge_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    let teams = load_teams(&mut tx, &event.id).await?;
    let criteria = load_criteria(&mut tx, &event.id).await?;
    let mut missing = Vec::new();
    for team in &teams {
        for criterion in &criteria {
            if !scored.contains(&(team.id.clone(), criterion.id.clone())) {
                missing.push(json!({ "team_id": team.id, "criterion_id": criterion.id }));
            }
        }
    }
    if !missing.is_empty() {
        return Err(AppError::InvalidState(
            "Не все оценки выставлены".into(),
            Some(json!({ "missing": missing })),
        ));
    }
    let now = now_ms();
    sqlx::query("UPDATE judges SET submitted_at = ? WHERE id = ?")
        .bind(now)
        .bind(&auth.judge_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.sse.notify(&event.id, ChangeKind::Judges);
    state.sse.notify(&event.id, ChangeKind::Scores);
    Ok(Json(judge_json(&auth, Some(now))))
}

async fn unsubmit(State(state): State<AppState>, auth: JudgeAuth) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &auth.event_id).await?;
    if event.status != "judging" {
        return Err(AppError::InvalidState(
            "Отозвать лист можно только во время оценивания".into(),
            None,
        ));
    }
    let active =
        sqlx::query("UPDATE judges SET submitted_at = NULL WHERE id = ? AND is_active = 1")
            .bind(&auth.judge_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    if active == 0 {
        return Err(AppError::Unauthorized);
    }
    tx.commit().await?;
    state.sse.notify(&event.id, ChangeKind::Judges);
    state.sse.notify(&event.id, ChangeKind::Scores);
    Ok(Json(judge_json(&auth, None)))
}

#[derive(Deserialize)]
struct HeartbeatRequest {
    pending_count: i64,
}

async fn heartbeat(
    State(state): State<AppState>,
    auth: JudgeAuth,
    Json(req): Json<HeartbeatRequest>,
) -> AppResult<StatusCode> {
    sqlx::query("UPDATE judges SET last_seen_at = ?, pending_count = ? WHERE id = ?")
        .bind(now_ms())
        .bind(req.pending_count.max(0))
        .bind(&auth.judge_id)
        .execute(&state.pool)
        .await?;
    state.sse.notify(&auth.event_id, ChangeKind::Judges);
    Ok(StatusCode::NO_CONTENT)
}

async fn stream(State(state): State<AppState>, auth: JudgeAuth) -> impl IntoResponse {
    state.sse.stream(&auth.event_id)
}
