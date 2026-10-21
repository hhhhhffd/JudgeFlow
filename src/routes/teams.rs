//! Teams: draft-only composition of an event (SPEC section 4 and 8).

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
use crate::domain::{self, Team, clean_optional, clean_required, double_option, load_event};
use crate::error::{AppError, AppResult};
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const NAME_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 2000;
const BULK_MAX: usize = 500;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/teams", post(create))
        .route("/events/{id}/teams/bulk", post(bulk))
        .route("/events/{id}/teams/order", put(order))
        .route("/teams/{id}", patch(update).delete(remove))
}

#[derive(Deserialize)]
struct TeamInput {
    name: String,
    description: Option<String>,
}

async fn insert_team(
    conn: &mut SqliteConnection,
    event_id: &str,
    input: &TeamInput,
) -> AppResult<Team> {
    let name = clean_required(&input.name, "Название команды", NAME_MAX)?;
    let description = match input.description.as_deref() {
        Some(raw) => clean_optional(raw, "Описание команды", DESCRIPTION_MAX)?,
        None => None,
    };
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM teams WHERE event_id = ?",
    )
    .bind(event_id)
    .fetch_one(&mut *conn)
    .await?;
    let team = Team {
        id: new_id(),
        name,
        description,
        sort_order,
    };
    sqlx::query(
        "INSERT INTO teams (id, event_id, name, description, sort_order) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&team.id)
    .bind(event_id)
    .bind(&team.name)
    .bind(&team.description)
    .bind(team.sort_order)
    .execute(conn)
    .await?;
    Ok(team)
}

async fn create(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<TeamInput>,
) -> AppResult<Json<Team>> {
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let team = insert_team(&mut tx, &event_id, &req).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "team.create",
        json!({ "id": team.id, "name": team.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(team))
}

#[derive(Deserialize)]
struct BulkRequest {
    teams: Vec<TeamInput>,
}

async fn bulk(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<BulkRequest>,
) -> AppResult<Json<Vec<Team>>> {
    if req.teams.is_empty() || req.teams.len() > BULK_MAX {
        return Err(AppError::Validation(format!(
            "Нужно от 1 до {BULK_MAX} команд за раз"
        )));
    }
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let mut created = Vec::with_capacity(req.teams.len());
    for input in &req.teams {
        created.push(insert_team(&mut tx, &event_id, input).await?);
    }
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "team.bulk_create",
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
    let mut existing: Vec<String> = domain::load_teams(&mut tx, &event_id)
        .await?
        .into_iter()
        .map(|t| t.id)
        .collect();
    let mut requested = req.ids.clone();
    existing.sort();
    requested.sort();
    if existing != requested {
        return Err(AppError::Validation(
            "Список должен содержать все команды события ровно по одному разу".into(),
        ));
    }
    for (position, id) in req.ids.iter().enumerate() {
        sqlx::query("UPDATE teams SET sort_order = ? WHERE id = ? AND event_id = ?")
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
        "team.reorder",
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
}

/// Loads a team and its event id inside the transaction; the event must be a draft.
async fn load_team_in_draft(conn: &mut SqliteConnection, id: &str) -> AppResult<(Team, String)> {
    let row: Option<(String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT event_id, id, name, description, sort_order FROM teams WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    let (event_id, id, name, description, sort_order) = row.ok_or(AppError::NotFound)?;
    domain::draft_only(&load_event(conn, &event_id).await?)?;
    Ok((
        Team {
            id,
            name,
            description,
            sort_order,
        },
        event_id,
    ))
}

async fn update(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> AppResult<Json<Team>> {
    let mut tx = begin_write(&state.pool).await?;
    let (mut team, event_id) = load_team_in_draft(&mut tx, &id).await?;
    if let Some(name) = &req.name {
        team.name = clean_required(name, "Название команды", NAME_MAX)?;
    }
    if let Some(description) = &req.description {
        team.description = match description {
            Some(raw) => clean_optional(raw, "Описание команды", DESCRIPTION_MAX)?,
            None => None,
        };
    }
    sqlx::query("UPDATE teams SET name = ?, description = ? WHERE id = ?")
        .bind(&team.name)
        .bind(&team.description)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "team.update",
        json!({ "id": id, "name": team.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(team))
}

async fn remove(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let (team, event_id) = load_team_in_draft(&mut tx, &id).await?;
    sqlx::query("DELETE FROM teams WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "team.delete",
        json!({ "id": id, "name": team.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn touch_event(conn: &mut SqliteConnection, event_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE events SET updated_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(event_id)
        .execute(conn)
        .await?;
    Ok(())
}
