//! Public pages (no authentication): live results filtered by visibility (SPEC section 6),
//! the public SSE stream and the event background image.

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::{Value, json};

use crate::domain::{self, Event, load_criteria, load_event};
use crate::error::{AppError, AppResult};
use crate::ranking::Mode;
use crate::routes::events::upload_path;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/public/events/{id}", get(public_event))
        .route("/public/events/{id}/stream", get(stream))
        .route("/public/events/{id}/background", get(background))
}

/// Loads an event that may be shown publicly: drafts do not exist for the public.
async fn load_public(conn: &mut sqlx::SqliteConnection, id: &str) -> AppResult<Event> {
    let event = load_event(conn, id).await?;
    if event.status == "draft" {
        return Err(AppError::NotFound);
    }
    Ok(event)
}

async fn public_event(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let event = load_public(&mut conn, &id).await?;
    let published = event.status == "published";
    let show_criteria = published || event.visibility == "live_full";

    let results = if published {
        // The published ranking is the official snapshot, with per-criterion and per-judge data.
        let (ranking, _) = domain::resolve_ranking(&mut conn, &event, Mode::Official).await?;
        Some(domain::ranking_json(&mut conn, &id, &ranking).await?)
    } else if event.visibility == "hidden" {
        None
    } else {
        let mut ranking = domain::compute_ranking(&mut conn, &event, Mode::Provisional).await?;
        for row in &mut ranking.rows {
            row.judges.clear();
            if !show_criteria {
                row.criteria.clear();
            }
        }
        Some(domain::ranking_json(&mut conn, &id, &ranking).await?)
    };

    let mut event_json = json!({
        "id": event.id,
        "title": event.title,
        "description": event.description,
        "status": event.status,
        "starts_at": event.starts_at,
        "location": event.location,
        "teams_label": event.teams_label,
        "teams_label_enabled": event.teams_label_enabled,
        "criteria_label": event.criteria_label,
        "criteria_label_enabled": event.criteria_label_enabled,
        "background_url": event.background_url(),
        "overlay": event.overlay_json(),
    });
    if show_criteria {
        let criteria: Vec<Value> = load_criteria(&mut conn, &id)
            .await?
            .into_iter()
            .map(|c| json!({ "id": c.id, "name": c.name }))
            .collect();
        event_json["criteria"] = json!(criteria);
    }
    Ok(Json(json!({ "event": event_json, "results": results })))
}

async fn stream(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.pool.acquire().await?;
    load_public(&mut conn, &id).await?;
    drop(conn);
    Ok(state.sse.stream(&id))
}

async fn background(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.pool.acquire().await?;
    let event = load_event(&mut conn, &id).await?;
    drop(conn);
    let file = event.background_file.ok_or(AppError::NotFound)?;
    let content_type = match file.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => return Err(AppError::NotFound),
    };
    let bytes = tokio::fs::read(upload_path(&state, &file))
        .await
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => AppError::NotFound,
            _ => AppError::Internal(err.into()),
        })?;
    Ok((
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    ))
}
