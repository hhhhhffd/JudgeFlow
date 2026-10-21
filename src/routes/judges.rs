//! Judge management by admins: bulk create (links are shown only here and on rotate), rename,
//! (de)activate, delete, rotate token, reopen a submitted sheet.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::audit;
use crate::auth::AdminSession;
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::domain::{self, JudgeSummary, clean_required, load_event, load_judge_summary};
use crate::error::{AppError, AppResult};
use crate::routes::teams::touch_event;
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const NAME_MAX: usize = 64;
const BULK_MAX: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/judges", post(create))
        .route("/judges/{id}", patch(update).delete(remove))
        .route("/judges/{id}/rotate", post(rotate))
        .route("/judges/{id}/reopen", post(reopen))
}

pub fn judge_link(state: &AppState, headers: &HeaderMap, token: &str) -> String {
    format!("{}/j/{token}", state.config.base_url(headers))
}

fn judges_editable(status: &str) -> AppResult<()> {
    if domain::is_closed(status) {
        return Err(AppError::InvalidState(
            "Судей нельзя менять после завершения оценивания".into(),
            None,
        ));
    }
    Ok(())
}

/// Returns `(event_id, status)` of the judge's event, or 404.
async fn judge_event(conn: &mut SqliteConnection, judge_id: &str) -> AppResult<(String, String)> {
    sqlx::query_as(
        "SELECT e.id, e.status FROM judges j JOIN events e ON e.id = j.event_id WHERE j.id = ?",
    )
    .bind(judge_id)
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct CreateRequest {
    names: Vec<String>,
}

async fn create(
    State(state): State<AppState>,
    session: AdminSession,
    headers: HeaderMap,
    Path(event_id): Path<String>,
    Json(req): Json<CreateRequest>,
) -> AppResult<Json<Vec<Value>>> {
    if req.names.is_empty() || req.names.len() > BULK_MAX {
        return Err(AppError::Validation(format!(
            "Нужно от 1 до {BULK_MAX} имён судей за раз"
        )));
    }
    let names = req
        .names
        .iter()
        .map(|n| clean_required(n, "Имя судьи", NAME_MAX))
        .collect::<AppResult<Vec<_>>>()?;

    let mut tx = begin_write(&state.pool).await?;
    judges_editable(&load_event(&mut tx, &event_id).await?.status)?;
    let mut out = Vec::with_capacity(names.len());
    let mut created_ids = Vec::new();
    for name in &names {
        let id = new_id();
        let token = random_token();
        sqlx::query(
            "INSERT INTO judges (id, event_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&event_id)
        .bind(name)
        .bind(hash_token(&token))
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
        let judge = load_judge_summary(&mut tx, &id).await?;
        out.push(json!({ "judge": judge, "link": judge_link(&state, &headers, &token) }));
        created_ids.push(id);
    }
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.create",
        json!({ "ids": created_ids, "names": names }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Judges);
    Ok(Json(out))
}

#[derive(Deserialize)]
struct UpdateRequest {
    name: Option<String>,
    is_active: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<JudgeSummary>> {
    let mut tx = begin_write(&state.pool).await?;
    let (event_id, status) = judge_event(&mut tx, &id).await?;
    judges_editable(&status)?;
    if let Some(name) = &req.name {
        let name = clean_required(name, "Имя судьи", NAME_MAX)?;
        sqlx::query("UPDATE judges SET name = ? WHERE id = ?")
            .bind(name)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(is_active) = req.is_active {
        sqlx::query("UPDATE judges SET is_active = ? WHERE id = ?")
            .bind(is_active)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    touch_event(&mut tx, &event_id).await?;
    let judge = load_judge_summary(&mut tx, &id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.update",
        json!({ "id": id, "name": judge.name, "is_active": judge.is_active }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Judges);
    if req.is_active.is_some() {
        state.sse.notify(&event_id, ChangeKind::Scores);
    }
    Ok(Json(judge))
}

async fn remove(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let (event_id, status) = judge_event(&mut tx, &id).await?;
    judges_editable(&status)?;
    let judge = load_judge_summary(&mut tx, &id).await?;
    sqlx::query("DELETE FROM judges WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.delete",
        json!({ "id": id, "name": judge.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Judges);
    state.sse.notify(&event_id, ChangeKind::Scores);
    Ok(StatusCode::NO_CONTENT)
}

async fn rotate(
    State(state): State<AppState>,
    session: AdminSession,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let (event_id, status) = judge_event(&mut tx, &id).await?;
    judges_editable(&status)?;
    let token = random_token();
    sqlx::query("UPDATE judges SET token_hash = ? WHERE id = ?")
        .bind(hash_token(&token))
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let judge = load_judge_summary(&mut tx, &id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.rotate",
        json!({ "id": id, "name": judge.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Judges);
    Ok(Json(
        json!({ "judge": judge, "link": judge_link(&state, &headers, &token) }),
    ))
}

#[derive(Deserialize)]
struct ReopenRequest {
    reason: Option<String>,
}

async fn reopen(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<ReopenRequest>,
) -> AppResult<Json<JudgeSummary>> {
    let reason = clean_required(req.reason.as_deref().unwrap_or(""), "Причина", 500)
        .map_err(|_| AppError::Validation("Укажите причину (до 500 символов)".into()))?;
    let mut tx = begin_write(&state.pool).await?;
    let (event_id, status) = judge_event(&mut tx, &id).await?;
    judges_editable(&status)?;
    sqlx::query("UPDATE judges SET submitted_at = NULL WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let judge = load_judge_summary(&mut tx, &id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "judge.reopen",
        json!({ "id": id, "name": judge.name, "reason": reason }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Judges);
    state.sse.notify(&event_id, ChangeKind::Scores);
    Ok(Json(judge))
}
