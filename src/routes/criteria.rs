//! Criteria: draft-only composition of an event (SPEC section 4 and 8).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit;
use crate::auth::AdminSession;
use crate::db::begin_write;
use crate::domain::{self, Criterion, clean_optional, clean_required, double_option, load_event};
use crate::error::{AppError, AppResult};
use crate::routes::teams::touch_event;
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::new_id;

const NAME_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 2000;
const BULK_MAX: usize = 100;
const MAX_X100_LIMIT: i64 = 1_000_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/criteria", post(create))
        .route("/events/{id}/criteria/bulk", post(bulk))
        .route("/events/{id}/criteria/order", put(order))
        .route("/criteria/{id}", patch(update).delete(remove))
}

#[derive(Deserialize)]
struct CriterionInput {
    name: String,
    description: Option<String>,
    max_x100: i64,
    step_x100: i64,
    weight: i64,
}

/// Checks scale numbers: 0 < step <= max <= limit, max divisible by step, weight 1..=1000.
fn validate_scale(max_x100: i64, step_x100: i64, weight: i64) -> AppResult<()> {
    if !(1..=MAX_X100_LIMIT).contains(&max_x100) {
        return Err(AppError::Validation(format!(
            "Максимальный балл: от 0,01 до {}",
            MAX_X100_LIMIT / 100
        )));
    }
    if step_x100 < 1 || step_x100 > max_x100 {
        return Err(AppError::Validation(
            "Шаг оценки должен быть больше нуля и не больше максимума".into(),
        ));
    }
    if max_x100 % step_x100 != 0 {
        return Err(AppError::Validation(
            "Максимальный балл должен делиться на шаг без остатка".into(),
        ));
    }
    if !(1..=1000).contains(&weight) {
        return Err(AppError::Validation("Вес критерия: от 1 до 1000".into()));
    }
    Ok(())
}

async fn insert_criterion(
    conn: &mut SqliteConnection,
    event_id: &str,
    input: &CriterionInput,
) -> AppResult<Criterion> {
    let name = clean_required(&input.name, "Название критерия", NAME_MAX)?;
    let description = match input.description.as_deref() {
        Some(raw) => clean_optional(raw, "Описание критерия", DESCRIPTION_MAX)?,
        None => None,
    };
    validate_scale(input.max_x100, input.step_x100, input.weight)?;
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM criteria WHERE event_id = ?",
    )
    .bind(event_id)
    .fetch_one(&mut *conn)
    .await?;
    let criterion = Criterion {
        id: new_id(),
        name,
        description,
        max_x100: input.max_x100,
        step_x100: input.step_x100,
        weight: input.weight,
        sort_order,
    };
    sqlx::query(
        "INSERT INTO criteria (id, event_id, name, description, max_x100, step_x100, weight, sort_order) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&criterion.id)
    .bind(event_id)
    .bind(&criterion.name)
    .bind(&criterion.description)
    .bind(criterion.max_x100)
    .bind(criterion.step_x100)
    .bind(criterion.weight)
    .bind(criterion.sort_order)
    .execute(conn)
    .await?;
    Ok(criterion)
}

async fn create(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<CriterionInput>,
) -> AppResult<Json<Criterion>> {
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let criterion = insert_criterion(&mut tx, &event_id, &req).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "criterion.create",
        json!({ "id": criterion.id, "name": criterion.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(criterion))
}

#[derive(Deserialize)]
struct BulkRequest {
    criteria: Vec<CriterionInput>,
}

async fn bulk(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<BulkRequest>,
) -> AppResult<Json<Vec<Criterion>>> {
    if req.criteria.is_empty() || req.criteria.len() > BULK_MAX {
        return Err(AppError::Validation(format!(
            "Нужно от 1 до {BULK_MAX} критериев за раз"
        )));
    }
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let mut created = Vec::with_capacity(req.criteria.len());
    for input in &req.criteria {
        created.push(insert_criterion(&mut tx, &event_id, input).await?);
    }
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "criterion.bulk_create",
        json!({ "count": created.len() }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(created))
}

#[derive(Deserialize)]
struct OrderRequest {
    ids: Vec<String>,
}

async fn order(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<OrderRequest>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let mut existing: Vec<String> = domain::load_criteria(&mut tx, &event_id)
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect();
    let mut requested = req.ids.clone();
    existing.sort();
    requested.sort();
    if existing != requested {
        return Err(AppError::Validation(
            "Список должен содержать все критерии события ровно по одному разу".into(),
        ));
    }
    for (position, id) in req.ids.iter().enumerate() {
        sqlx::query("UPDATE criteria SET sort_order = ? WHERE id = ? AND event_id = ?")
            .bind(position as i64)
            .bind(id)
            .bind(&event_id)
            .execute(&mut *tx)
            .await?;
    }
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "criterion.reorder",
        json!({}),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UpdateRequest {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    max_x100: Option<i64>,
    step_x100: Option<i64>,
    weight: Option<i64>,
}

async fn load_criterion_in_draft(
    conn: &mut SqliteConnection,
    id: &str,
) -> AppResult<(Criterion, String)> {
    let event_id: String = sqlx::query_scalar("SELECT event_id FROM criteria WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(AppError::NotFound)?;
    domain::draft_only(&load_event(&mut *conn, &event_id).await?)?;
    let criterion = domain::load_criteria(conn, &event_id)
        .await?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or(AppError::NotFound)?;
    Ok((criterion, event_id))
}

async fn update(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<Criterion>> {
    let mut tx = begin_write(&state.pool).await?;
    let (mut criterion, event_id) = load_criterion_in_draft(&mut tx, &id).await?;
    if let Some(name) = &req.name {
        criterion.name = clean_required(name, "Название критерия", NAME_MAX)?;
    }
    if let Some(description) = &req.description {
        criterion.description = match description {
            Some(raw) => clean_optional(raw, "Описание критерия", DESCRIPTION_MAX)?,
            None => None,
        };
    }
    criterion.max_x100 = req.max_x100.unwrap_or(criterion.max_x100);
    criterion.step_x100 = req.step_x100.unwrap_or(criterion.step_x100);
    criterion.weight = req.weight.unwrap_or(criterion.weight);
    validate_scale(criterion.max_x100, criterion.step_x100, criterion.weight)?;
    sqlx::query(
        "UPDATE criteria SET name = ?, description = ?, max_x100 = ?, step_x100 = ?, weight = ? WHERE id = ?",
    )
    .bind(&criterion.name)
    .bind(&criterion.description)
    .bind(criterion.max_x100)
    .bind(criterion.step_x100)
    .bind(criterion.weight)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "criterion.update",
        json!({ "id": id, "name": criterion.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(criterion))
}

async fn remove(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let (criterion, event_id) = load_criterion_in_draft(&mut tx, &id).await?;
    sqlx::query("DELETE FROM criteria WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "criterion.delete",
        json!({ "id": id, "name": criterion.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}
