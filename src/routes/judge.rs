//! Judge-facing API (Bearer token): session, score sync, submit/unsubmit, heartbeat, stream.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::audit;
use crate::auth::{AdminSession, JudgeAuth};
use crate::crypto::hash_token;
use crate::db::begin_write;
use crate::domain::{self, Event, Layout, load_event};
use crate::error::{AppError, AppResult};
use crate::pairwise;
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const NOTE_MAX_CHARS: usize = 2000;
const ITEMS_MAX: usize = 5000;
const RESERVE_MAX: i64 = 20;
/// Client clocks are trusted, but not blindly: a timestamp far in the future would block later edits.
const MAX_CLOCK_SKEW_MS: i64 = 24 * 60 * 60 * 1000;
/// Emergency sheet files carry up to `ITEMS_MAX` items plus notes.
const SHEET_MAX_BYTES: usize = 2 * 1024 * 1024;
const SHEET_FORMAT: &str = "judgeflow-sheet/1";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/judge/session", get(session))
        .route("/judge/scores", put(put_scores))
        .route("/judge/pairs/reserve", post(reserve_pairs))
        .route("/judge/comparisons", put(put_comparisons))
        .route("/judge/submit", post(submit))
        .route("/judge/unsubmit", post(unsubmit))
        .route("/judge/heartbeat", post(heartbeat))
        .route("/judge/stream", get(stream))
        .route(
            "/events/{id}/import-sheet",
            post(import_sheet).layer(DefaultBodyLimit::max(SHEET_MAX_BYTES)),
        )
}

async fn session(State(state): State<AppState>, auth: JudgeAuth) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let event = load_event(&mut conn, &auth.event_id).await?;
    let layout = Layout::load(&mut conn, &event.id).await?;
    let teams = layout.judge_teams(&auth.judge_id);
    // Pairwise events have no rubric criteria.
    let criteria: Vec<_> = layout
        .criteria
        .iter()
        .filter(|c| {
            event.scoring_mode != "pairwise" && teams.iter().any(|t| layout.applies(&t.id, c))
        })
        .collect();
    let tracks: Vec<_> = layout
        .tracks
        .iter()
        .filter(|track| {
            teams
                .iter()
                .any(|t| t.track_id.as_deref() == Some(track.id.as_str()))
        })
        .collect();
    let submitted_at: Option<i64> =
        sqlx::query_scalar("SELECT submitted_at FROM judges WHERE id = ?")
            .bind(&auth.judge_id)
            .fetch_one(&mut *conn)
            .await?;
    let scores: Vec<(String, String, i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT team_id, criterion_id, value_x100, note, edited_at FROM scores \
         WHERE judge_id = ? AND value_x100 IS NOT NULL",
    )
    .bind(&auth.judge_id)
    .fetch_all(&mut *conn)
    .await?;
    let required: HashSet<(&str, &str)> = layout
        .required(&auth.judge_id)
        .into_iter()
        .map(|(team, criterion)| (team.id.as_str(), criterion.id.as_str()))
        .collect();
    let scores: Vec<Value> = scores
        .into_iter()
        .filter(|(team_id, criterion_id, ..)| {
            required.contains(&(team_id.as_str(), criterion_id.as_str()))
        })
        .map(|(team_id, criterion_id, value_x100, note, edited_at)| {
            json!({
                "team_id": team_id, "criterion_id": criterion_id,
                "value_x100": value_x100, "note": note, "edited_at": edited_at,
            })
        })
        .collect();
    let mut payload = json!({
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
        "tracks": tracks,
        "scores": scores,
    });
    if event.scoring_mode == "pairwise" {
        payload["comparisons"] = json!(load_comparisons(&mut conn, &auth.judge_id, false).await?);
    }
    Ok(Json(payload))
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct ComparisonRow {
    id: String,
    team_a: String,
    team_b: String,
    winner: Option<String>,
    edited_at: Option<i64>,
}

/// The judge's comparisons as `{id, team_a, team_b, winner, edited_at}`, oldest first;
/// `open_only` keeps just the undecided ones.
async fn load_comparisons(
    conn: &mut SqliteConnection,
    judge_id: &str,
    open_only: bool,
) -> AppResult<Vec<Value>> {
    let rows: Vec<ComparisonRow> = sqlx::query_as(
        "SELECT id, team_a, team_b, winner, edited_at FROM comparisons \
         WHERE judge_id = ? AND (? = 0 OR winner IS NULL) ORDER BY created_at, rowid",
    )
    .bind(judge_id)
    .bind(open_only)
    .fetch_all(conn)
    .await?;
    Ok(rows.iter().map(|row| json!(row)).collect())
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
    check_items_count(req.items.len())?;
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
    let (results, applied) =
        apply_score_items(&mut tx, &event, &auth.judge_id, submitted_at, &req.items).await?;
    tx.commit().await?;
    if applied {
        state.sse.notify(&event.id, ChangeKind::Scores);
    }
    Ok(Json(json!({ "results": results })))
}

fn check_items_count(len: usize) -> AppResult<()> {
    if len > ITEMS_MAX {
        return Err(AppError::Validation(format!(
            "Не более {ITEMS_MAX} оценок за один запрос"
        )));
    }
    Ok(())
}

/// Drops the judge's undecided pairs that no longer make sense after assignments, conflicts or
/// tracks changed: both teams must still be covered by the judge and share a track group.
async fn delete_stale_open_pairs(
    tx: &mut SqliteConnection,
    layout: &Layout,
    judge_id: &str,
) -> AppResult<()> {
    let open: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, team_a, team_b FROM comparisons WHERE judge_id = ? AND winner IS NULL",
    )
    .bind(judge_id)
    .fetch_all(&mut *tx)
    .await?;
    for (id, a, b) in open {
        if layout.judge_covers(judge_id, &a)
            && layout.judge_covers(judge_id, &b)
            && layout.same_group(&a, &b)
        {
            continue;
        }
        sqlx::query("DELETE FROM comparisons WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    Ok(())
}

/// Applies a batch of score items for one judge inside the caller's write transaction. Shared by
/// `PUT /judge/scores` and the emergency sheet import so both follow exactly the same rules
/// (submitted sheet, status window, assignments, validation, last-writer-wins).
/// Returns the per-item results and whether anything was written.
async fn apply_score_items(
    tx: &mut SqliteConnection,
    event: &Event,
    judge_id: &str,
    submitted_at: Option<i64>,
    items: &[ScoreItem],
) -> AppResult<(Vec<Value>, bool)> {
    let now = now_ms();
    let layout = Layout::load(&mut *tx, &event.id).await?;
    let pairwise = event.scoring_mode == "pairwise";
    let criteria: HashMap<&str, &domain::Criterion> =
        layout.criteria.iter().map(|c| (c.id.as_str(), c)).collect();
    let teams: HashSet<&str> = layout.teams.iter().map(|t| t.id.as_str()).collect();

    let mut results = Vec::with_capacity(items.len());
    let mut applied = false;
    for item in items {
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
        if pairwise {
            results.push(rejection(item, "invalid_state"));
            continue;
        }
        let Some(&criterion) = criteria.get(item.criterion_id.as_str()) else {
            results.push(rejection(item, "not_found"));
            continue;
        };
        if !teams.contains(item.team_id.as_str()) {
            results.push(rejection(item, "not_found"));
            continue;
        }
        if !layout.is_required(judge_id, &item.team_id, criterion) {
            results.push(rejection(item, "not_assigned"));
            continue;
        }
        let (max, step) = (criterion.max_x100, criterion.step_x100);
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

        let existing: Option<(Option<i64>, Option<String>, i64)> = sqlx::query_as(
            "SELECT value_x100, note, edited_at FROM scores \
             WHERE judge_id = ? AND team_id = ? AND criterion_id = ?",
        )
        .bind(judge_id)
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
                .bind(judge_id)
                .bind(&item.team_id)
                .bind(&item.criterion_id)
                .bind(value)
                .bind(note)
                .bind(item.edited_at)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
            // Tombstone: keeps edited_at so an older offline edit cannot resurrect the score.
            None => {
                sqlx::query(
                    "INSERT INTO scores (judge_id, team_id, criterion_id, value_x100, note, edited_at, updated_at) \
                     VALUES (?, ?, ?, NULL, NULL, ?, ?) \
                     ON CONFLICT (judge_id, team_id, criterion_id) DO UPDATE SET \
                     value_x100 = NULL, note = NULL, \
                     edited_at = excluded.edited_at, updated_at = excluded.updated_at",
                )
                .bind(judge_id)
                .bind(&item.team_id)
                .bind(&item.criterion_id)
                .bind(item.edited_at)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
        }
        applied = true;
        results.push(json!({
            "team_id": item.team_id, "criterion_id": item.criterion_id, "status": "ok",
        }));
    }
    Ok((results, applied))
}

#[derive(Deserialize)]
struct ReserveRequest {
    count: i64,
}

/// Returns the judge's open pairs and tops them up to `count` with new ones (SPEC section 13).
/// Pairs are only created while the event is `judging` and the sheet is not submitted; in other
/// states the call is read-only.
async fn reserve_pairs(
    State(state): State<AppState>,
    auth: JudgeAuth,
    Json(req): Json<ReserveRequest>,
) -> AppResult<Json<Value>> {
    if !(1..=RESERVE_MAX).contains(&req.count) {
        return Err(AppError::Validation(format!(
            "count: от 1 до {RESERVE_MAX}"
        )));
    }
    let mut tx = begin_write(&state.pool).await?;
    let submitted_at: Option<i64> =
        sqlx::query_scalar("SELECT submitted_at FROM judges WHERE id = ? AND is_active = 1")
            .bind(&auth.judge_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::Unauthorized)?;
    let event = load_event(&mut tx, &auth.event_id).await?;
    if event.scoring_mode != "pairwise" {
        return Err(AppError::InvalidState(
            "Событие не использует попарное сравнение".into(),
            None,
        ));
    }
    let layout = Layout::load(&mut tx, &event.id).await?;
    delete_stale_open_pairs(&mut tx, &layout, &auth.judge_id).await?;
    let open = load_comparisons(&mut tx, &auth.judge_id, true).await?;
    let want = req.count as usize;
    if event.status != "judging" || submitted_at.is_some() || open.len() >= want {
        return Ok(Json(json!({ "comparisons": open })));
    }

    let groups: Vec<Vec<String>> = layout
        .groups()
        .into_iter()
        .map(|(_, teams)| {
            teams
                .into_iter()
                .filter(|t| layout.judge_covers(&auth.judge_id, &t.id))
                .map(|t| t.id.clone())
                .collect()
        })
        .collect();
    let existing: Vec<(String, String, String)> =
        sqlx::query_as("SELECT judge_id, team_a, team_b FROM comparisons WHERE event_id = ?")
            .bind(&event.id)
            .fetch_all(&mut *tx)
            .await?;
    let seen: Vec<(String, String)> = existing
        .iter()
        .filter(|(judge, ..)| *judge == auth.judge_id)
        .map(|(_, a, b)| (a.clone(), b.clone()))
        .collect();
    let all: Vec<(String, String)> = existing.into_iter().map(|(_, a, b)| (a, b)).collect();
    let now = now_ms();
    for (team_a, team_b) in pairwise::next_pairs(&groups, &all, &seen, want - open.len()) {
        sqlx::query(
            "INSERT INTO comparisons (id, event_id, judge_id, team_a, team_b, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id())
        .bind(&event.id)
        .bind(&auth.judge_id)
        .bind(team_a)
        .bind(team_b)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    let open = load_comparisons(&mut tx, &auth.judge_id, true).await?;
    tx.commit().await?;
    Ok(Json(json!({ "comparisons": open })))
}

#[derive(Deserialize)]
struct ComparisonsRequest {
    items: Vec<ComparisonItem>,
}

#[derive(Deserialize)]
struct ComparisonItem {
    id: String,
    winner: Option<String>,
    edited_at: i64,
}

fn comparison_rejection(item: &ComparisonItem, error: &str) -> Value {
    json!({ "id": item.id, "status": "rejected", "error": error })
}

/// Same per-item semantics as scores: last-writer-wins by `edited_at`; `winner: null` clears the
/// decision but keeps the row (open, with `edited_at`) so an older offline edit cannot resurrect it.
async fn put_comparisons(
    State(state): State<AppState>,
    auth: JudgeAuth,
    Json(req): Json<ComparisonsRequest>,
) -> AppResult<Json<Value>> {
    check_items_count(req.items.len())?;
    let mut tx = begin_write(&state.pool).await?;
    let submitted_at: Option<i64> =
        sqlx::query_scalar("SELECT submitted_at FROM judges WHERE id = ? AND is_active = 1")
            .bind(&auth.judge_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::Unauthorized)?;
    let event = load_event(&mut tx, &auth.event_id).await?;
    let now = now_ms();
    let mut results = Vec::with_capacity(req.items.len());
    let mut applied = false;
    for item in &req.items {
        if submitted_at.is_some() {
            results.push(comparison_rejection(item, "sheet_submitted"));
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
            results.push(comparison_rejection(item, "invalid_state"));
            continue;
        }
        let existing: Option<(Option<String>, Option<i64>)> = sqlx::query_as(
            "SELECT winner, edited_at FROM comparisons WHERE id = ? AND judge_id = ?",
        )
        .bind(&item.id)
        .bind(&auth.judge_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((server_winner, server_edited_at)) = existing else {
            results.push(comparison_rejection(item, "not_found"));
            continue;
        };
        let invalid_winner = item
            .winner
            .as_deref()
            .is_some_and(|w| !matches!(w, "a" | "b" | "tie"));
        if invalid_winner || item.edited_at < 0 || item.edited_at > now + MAX_CLOCK_SKEW_MS {
            results.push(comparison_rejection(item, "validation"));
            continue;
        }
        if let Some(edited_at) = server_edited_at
            && edited_at > item.edited_at
        {
            results.push(json!({
                "id": item.id, "status": "stale",
                "server": { "winner": server_winner, "edited_at": edited_at },
            }));
            continue;
        }
        sqlx::query("UPDATE comparisons SET winner = ?, edited_at = ? WHERE id = ?")
            .bind(&item.winner)
            .bind(item.edited_at)
            .bind(&item.id)
            .execute(&mut *tx)
            .await?;
        applied = true;
        results.push(json!({ "id": item.id, "status": "ok" }));
    }
    tx.commit().await?;
    if applied {
        state.sse.notify(&event.id, ChangeKind::Scores);
    }
    Ok(Json(json!({ "results": results })))
}

#[derive(Deserialize)]
struct SheetFile {
    format: String,
    token: String,
    items: Vec<ScoreItem>,
}

/// Emergency import (SPEC section 12): the organizer uploads a sheet file exported by a judge.
/// The token must belong to a judge of this event (inactive judges are fine); the items go
/// through the same function as `PUT /judge/scores`. The token is never logged or audited.
async fn import_sheet(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<SheetFile>,
) -> AppResult<Json<Value>> {
    if req.format != SHEET_FORMAT {
        return Err(AppError::Validation(
            "Неизвестный формат файла листа".into(),
        ));
    }
    check_items_count(req.items.len())?;
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &event_id).await?;
    if event.scoring_mode == "pairwise" {
        return Err(AppError::Validation(
            "Импорт листа недоступен для попарного сравнения".into(),
        ));
    }
    if domain::is_closed(&event.status) {
        return Err(AppError::InvalidState(
            "Импорт листа недоступен после завершения оценивания".into(),
            None,
        ));
    }
    let judge: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT id, name, submitted_at FROM judges WHERE token_hash = ? AND event_id = ?",
    )
    .bind(hash_token(req.token.trim()))
    .bind(&event_id)
    .fetch_optional(&mut *tx)
    .await?;
    let (judge_id, judge_name, submitted_at) = judge.ok_or_else(|| {
        AppError::Validation("Токен из файла не относится к судьям этого события".into())
    })?;
    let (results, applied) =
        apply_score_items(&mut tx, &event, &judge_id, submitted_at, &req.items).await?;
    let count = |status: &str| results.iter().filter(|r| r["status"] == status).count();
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.sheet_import",
        json!({
            "judge_id": judge_id,
            "judge_name": judge_name,
            "items": results.len(),
            "ok": count("ok"),
            "stale": count("stale"),
            "rejected": count("rejected"),
        }),
    )
    .await?;
    tx.commit().await?;
    if applied {
        state.sse.notify(&event_id, ChangeKind::Scores);
    }
    Ok(Json(json!({ "results": results })))
}

fn judge_json(auth: &JudgeAuth, submitted_at: Option<i64>) -> Value {
    json!({ "judge": { "id": auth.judge_id, "name": auth.name, "submitted_at": submitted_at } })
}

#[derive(Deserialize, Default)]
struct SubmitRequest {
    #[serde(default)]
    release_open: bool,
}

/// Rubric events: every required (team, criterion) of the judge must be scored.
async fn check_sheet_complete(
    tx: &mut SqliteConnection,
    judge_id: &str,
    event_id: &str,
) -> AppResult<()> {
    let scored: HashSet<(String, String)> = sqlx::query_as::<_, (String, String)>(
        "SELECT team_id, criterion_id FROM scores WHERE judge_id = ? AND value_x100 IS NOT NULL",
    )
    .bind(judge_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    let layout = Layout::load(&mut *tx, event_id).await?;
    let missing: Vec<Value> = layout
        .required(judge_id)
        .into_iter()
        .filter(|(team, criterion)| !scored.contains(&(team.id.clone(), criterion.id.clone())))
        .map(|(team, criterion)| json!({ "team_id": team.id, "criterion_id": criterion.id }))
        .collect();
    if !missing.is_empty() {
        return Err(AppError::InvalidState(
            "Не все оценки выставлены".into(),
            Some(json!({ "missing": missing })),
        ));
    }
    Ok(())
}

/// The body is optional (rubric events send none), so it is parsed by hand.
async fn submit(
    State(state): State<AppState>,
    auth: JudgeAuth,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let req: SubmitRequest = if body.is_empty() {
        SubmitRequest::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|_| AppError::Validation("Некорректное тело запроса".into()))?
    };
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
    if event.scoring_mode == "pairwise" {
        let layout = Layout::load(&mut tx, &event.id).await?;
        delete_stale_open_pairs(&mut tx, &layout, &auth.judge_id).await?;
        let open: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM comparisons WHERE judge_id = ? AND winner IS NULL \
             ORDER BY created_at, rowid",
        )
        .bind(&auth.judge_id)
        .fetch_all(&mut *tx)
        .await?;
        if !open.is_empty() && !req.release_open {
            return Err(AppError::InvalidState(
                "Есть нерешённые пары".into(),
                Some(json!({ "open": open })),
            ));
        }
        sqlx::query("DELETE FROM comparisons WHERE judge_id = ? AND winner IS NULL")
            .bind(&auth.judge_id)
            .execute(&mut *tx)
            .await?;
    } else {
        check_sheet_complete(&mut tx, &auth.judge_id, &event.id).await?;
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
    state.sse.notify(&auth.event_id, ChangeKind::Presence);
    Ok(StatusCode::NO_CONTENT)
}

/// How often an open judge stream re-checks that its token is still valid.
const STREAM_RECHECK: Duration = Duration::from_secs(30);

/// The stream ends when the judge is deactivated or the token is rotated, so a revoked token
/// stops receiving hints within `STREAM_RECHECK`.
async fn stream(State(state): State<AppState>, auth: JudgeAuth) -> impl IntoResponse {
    let pool = state.pool.clone();
    let event_id = auth.event_id.clone();
    let stop = async move {
        loop {
            tokio::time::sleep(STREAM_RECHECK).await;
            let valid = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM judges WHERE id = ? AND token_hash = ? AND is_active = 1",
            )
            .bind(&auth.judge_id)
            .bind(&auth.token_hash)
            .fetch_one(&pool)
            .await;
            // A transient DB error keeps the stream open; the next tick re-checks.
            if matches!(valid, Ok(0)) {
                return;
            }
        }
    };
    state.sse.stream_until(&event_id, stop)
}
