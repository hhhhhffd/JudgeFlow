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
use crate::ranking::{Mode, stage_slice};
use crate::routes::events::upload_path;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/public/events/{id}", get(public_event))
        .route("/public/events/{id}/stage", get(public_stage))
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
            .map(|c| json!({ "id": c.id, "name": c.name, "track_id": c.track_id }))
            .collect();
        event_json["criteria"] = json!(criteria);
    }
    Ok(Json(json!({ "event": event_json, "results": results })))
}

/// Stage screen (SPEC section 11): official ranking with unrevealed rows removed server-side
/// and no per-judge data.
async fn public_stage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let event = load_public(&mut conn, &id).await?;
    let available = domain::is_closed(&event.status);
    let top_n = event.stage_top_n as u32;

    let mut shown_track = event.stage_track_id.clone();
    let mut total_groups = 0;
    let mut revealed = 0;
    let mut rows: Vec<Value> = Vec::new();
    if available {
        let (ranking, _) = domain::resolve_ranking(&mut conn, &event, Mode::Official).await?;
        shown_track = domain::stage_track(&ranking, &event.stage_track_id);
        let ranking = domain::stage_group(ranking, &event.stage_track_id);
        let ranks: Vec<_> = ranking.rows.iter().map(|row| row.rank).collect();
        let slice = stage_slice(
            &ranks,
            &event.stage_view,
            top_n,
            event.stage_revealed as u32,
        );
        total_groups = slice.total_groups;
        revealed = (event.stage_revealed as u32).min(total_groups);
        let mut json = domain::ranking_json(&mut conn, &id, &ranking).await?;
        if let Some(all_rows) = json["rows"].as_array_mut() {
            rows = std::mem::take(all_rows)
                .into_iter()
                .zip(slice.visible)
                .filter(|(_, visible)| *visible)
                .map(|(mut row, _)| {
                    row.as_object_mut()
                        .expect("row is an object")
                        .remove("judges");
                    row
                })
                .collect();
        }
    }

    // Only the criteria of the shown group: track-less ones plus those of the stage track.
    let criteria: Vec<Value> = load_criteria(&mut conn, &id)
        .await?
        .into_iter()
        .filter(|c| c.track_id.is_none() || c.track_id == shown_track)
        .map(|c| json!({ "id": c.id, "name": c.name, "track_id": c.track_id }))
        .collect();
    let tracks: Vec<Value> = domain::load_tracks(&mut conn, &id)
        .await?
        .into_iter()
        .map(|t| json!({ "id": t.id, "name": t.name }))
        .collect();
    Ok(Json(json!({
        "event": {
            "id": event.id,
            "title": event.title,
            "status": event.status,
            "teams_label": event.teams_label,
            "teams_label_enabled": event.teams_label_enabled,
            "criteria_label": event.criteria_label,
            "criteria_label_enabled": event.criteria_label_enabled,
            "background_url": event.background_url(),
            "overlay": event.overlay_json(),
            "criteria": criteria,
        },
        "stage": {
            "view": event.stage_view,
            "top_n": event.stage_top_n,
            "revealed": revealed,
            "total_groups": total_groups,
            "available": available,
            "track_id": shown_track,
        },
        "tracks": tracks,
        "rows": rows,
    })))
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
