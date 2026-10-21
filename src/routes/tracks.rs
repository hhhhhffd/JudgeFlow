//! Tracks: draft-only grouping of teams and criteria (SPEC section 12).

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
use crate::domain::{self, Track, clean_required, load_event};
use crate::error::{AppError, AppResult};
use crate::routes::teams::touch_event;
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::new_id;

const NAME_MAX: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/tracks", post(create))
        .route("/events/{id}/tracks/order", put(order))
        .route("/tracks/{id}", patch(update).delete(remove))
}

#[derive(Deserialize)]
struct NameRequest {
    name: String,
}

async fn create(
    State(state): State<AppState>,
    session: AdminSession,
    Path(event_id): Path<String>,
    Json(req): Json<NameRequest>,
) -> AppResult<Json<Track>> {
    let name = clean_required(&req.name, "Название трека", NAME_MAX)?;
    let mut tx = begin_write(&state.pool).await?;
    domain::draft_only(&load_event(&mut tx, &event_id).await?)?;
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tracks WHERE event_id = ?",
    )
    .bind(&event_id)
    .fetch_one(&mut *tx)
    .await?;
    let track = Track {
        id: new_id(),
        name,
        sort_order,
    };
    sqlx::query("INSERT INTO tracks (id, event_id, name, sort_order) VALUES (?, ?, ?, ?)")
        .bind(&track.id)
        .bind(&event_id)
        .bind(&track.name)
        .bind(track.sort_order)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "track.create",
        json!({ "id": track.id, "name": track.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(track))
}

/// Loads a track and its event id inside the transaction; the event must be a draft.
async fn load_track_in_draft(conn: &mut SqliteConnection, id: &str) -> AppResult<(Track, String)> {
    let row: Option<(String, String, String, i64)> =
        sqlx::query_as("SELECT event_id, id, name, sort_order FROM tracks WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?;
    let (event_id, id, name, sort_order) = row.ok_or(AppError::NotFound)?;
    domain::draft_only(&load_event(conn, &event_id).await?)?;
    Ok((
        Track {
            id,
            name,
            sort_order,
        },
        event_id,
    ))
}

async fn update(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<NameRequest>,
) -> AppResult<Json<Track>> {
    let name = clean_required(&req.name, "Название трека", NAME_MAX)?;
    let mut tx = begin_write(&state.pool).await?;
    let (mut track, event_id) = load_track_in_draft(&mut tx, &id).await?;
    track.name = name;
    sqlx::query("UPDATE tracks SET name = ? WHERE id = ?")
        .bind(&track.name)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "track.update",
        json!({ "id": id, "name": track.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(track))
}

/// Teams of the track become track-less, criteria of the track are deleted (foreign keys).
async fn remove(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let (track, event_id) = load_track_in_draft(&mut tx, &id).await?;
    sqlx::query("DELETE FROM tracks WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    touch_event(&mut tx, &event_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "track.delete",
        json!({ "id": id, "name": track.name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
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
    let mut existing: Vec<String> = domain::load_tracks(&mut tx, &event_id)
        .await?
        .into_iter()
        .map(|t| t.id)
        .collect();
    let mut requested = req.ids.clone();
    existing.sort();
    requested.sort();
    if existing != requested {
        return Err(AppError::Validation(
            "Список должен содержать все треки события ровно по одному разу".into(),
        ));
    }
    for (position, id) in req.ids.iter().enumerate() {
        sqlx::query("UPDATE tracks SET sort_order = ? WHERE id = ? AND event_id = ?")
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
        "track.reorder",
        json!({}),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}
