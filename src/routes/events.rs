//! Admin event endpoints: CRUD, lifecycle transitions, background image, matrix, results,
//! CSV export, audit log and the admin SSE stream.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::audit;
use crate::auth::AdminSession;
use crate::db::begin_write;
use crate::domain::{
    self, clean_optional, clean_required, double_option, event_full, load_event, load_judges,
    load_teams,
};
use crate::error::{AppError, AppResult};
use crate::ranking::{Mode, stage_slice};
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const TITLE_MAX: usize = 200;
const DESCRIPTION_MAX: usize = 5000;
const LOCATION_MAX: usize = 200;
const LABEL_MAX: usize = 100;
const ALERT_TITLE_MAX: usize = 200;
const ALERT_BUTTON_MAX: usize = 50;
const QUORUM_MAX: i64 = 1000;
pub const STAGE_TOP_N_MAX: i64 = 10;
pub const BACKGROUND_MAX_BYTES: usize = 5 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events", get(list).post(create))
        .route("/events/{id}", get(get_one).patch(patch).delete(delete))
        .route("/events/{id}/transition", post(transition))
        .route("/events/{id}/stage/reveal", post(stage_reveal))
        .route(
            "/events/{id}/background",
            put(put_background)
                .delete(delete_background)
                .layer(DefaultBodyLimit::max(BACKGROUND_MAX_BYTES)),
        )
        .route("/events/{id}/matrix", get(matrix))
        .route("/events/{id}/results", get(results))
        .route("/events/{id}/export.csv", get(export_csv))
        .route("/events/{id}/audit", get(audit_log))
        .route("/events/{id}/stream", get(stream))
}

#[derive(sqlx::FromRow, serde::Serialize)]
struct EventListItem {
    id: String,
    title: String,
    status: String,
    starts_at: Option<i64>,
    location: Option<String>,
    teams_count: i64,
    criteria_count: i64,
    judges_count: i64,
    submitted_count: i64,
    created_at: i64,
}

async fn list(
    State(state): State<AppState>,
    _admin: AdminSession,
) -> AppResult<Json<Vec<EventListItem>>> {
    let items = sqlx::query_as::<_, EventListItem>(
        "SELECT e.id, e.title, e.status, e.starts_at, e.location, \
         (SELECT COUNT(*) FROM teams t WHERE t.event_id = e.id) AS teams_count, \
         (SELECT COUNT(*) FROM criteria c WHERE c.event_id = e.id) AS criteria_count, \
         (SELECT COUNT(*) FROM judges j WHERE j.event_id = e.id) AS judges_count, \
         (SELECT COUNT(*) FROM judges j WHERE j.event_id = e.id AND j.submitted_at IS NOT NULL) AS submitted_count, \
         e.created_at FROM events e ORDER BY e.created_at DESC, e.rowid DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(items))
}

#[derive(Deserialize)]
struct CreateRequest {
    title: String,
    description: Option<String>,
    starts_at: Option<i64>,
    location: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    session: AdminSession,
    Json(req): Json<CreateRequest>,
) -> AppResult<Json<Value>> {
    let title = clean_required(&req.title, "Название", TITLE_MAX)?;
    let description = clean_optional(
        req.description.as_deref().unwrap_or(""),
        "Описание",
        DESCRIPTION_MAX,
    )?
    .unwrap_or_default();
    let location = match req.location.as_deref() {
        Some(raw) => clean_optional(raw, "Место", LOCATION_MAX)?,
        None => None,
    };
    let id = new_id();
    let now = now_ms();
    let mut tx = begin_write(&state.pool).await?;
    sqlx::query(
        "INSERT INTO events (id, title, description, starts_at, location, created_by, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&title)
    .bind(&description)
    .bind(req.starts_at)
    .bind(&location)
    .bind(&session.admin.id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.create",
        json!({ "title": title }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(full))
}

async fn get_one(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    Ok(Json(event_full(&mut conn, &id).await?))
}

#[derive(Deserialize)]
struct PatchRequest {
    title: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    starts_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    location: Option<Option<String>>,
    scoring_mode: Option<String>,
    notes_enabled: Option<bool>,
    visibility: Option<String>,
    quorum: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    teams_label: Option<Option<String>>,
    teams_label_enabled: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    criteria_label: Option<Option<String>>,
    criteria_label_enabled: Option<bool>,
    alert_enabled: Option<bool>,
    alert_title: Option<String>,
    alert_text: Option<String>,
    alert_align: Option<String>,
    alert_button_text: Option<String>,
    overlay_enabled: Option<bool>,
    overlay_color: Option<String>,
    overlay_opacity: Option<i64>,
    stage_view: Option<String>,
    stage_top_n: Option<i64>,
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

async fn patch(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<PatchRequest>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let current = load_event(&mut tx, &id).await?;
    let mut event = current.clone();
    let mut changed: Vec<&str> = Vec::new();

    if let Some(title) = &req.title {
        event.title = clean_required(title, "Название", TITLE_MAX)?;
        changed.push("title");
    }
    if let Some(description) = &req.description {
        event.description =
            clean_optional(description, "Описание", DESCRIPTION_MAX)?.unwrap_or_default();
        changed.push("description");
    }
    if let Some(starts_at) = req.starts_at {
        event.starts_at = starts_at;
        changed.push("starts_at");
    }
    if let Some(location) = &req.location {
        event.location = match location {
            Some(raw) => clean_optional(raw, "Место", LOCATION_MAX)?,
            None => None,
        };
        changed.push("location");
    }
    if let Some(mode) = &req.scoring_mode {
        if !matches!(mode.as_str(), "team" | "criterion") {
            return Err(AppError::Validation(
                "Режим оценки: team или criterion".into(),
            ));
        }
        if *mode != current.scoring_mode {
            domain::draft_only(&current)?;
            event.scoring_mode = mode.clone();
            changed.push("scoring_mode");
        }
    }
    if let Some(notes) = req.notes_enabled
        && notes != current.notes_enabled
    {
        domain::draft_only(&current)?;
        event.notes_enabled = notes;
        changed.push("notes_enabled");
    }
    if let Some(visibility) = &req.visibility {
        if !matches!(visibility.as_str(), "hidden" | "live_totals" | "live_full") {
            return Err(AppError::Validation(
                "Видимость: hidden, live_totals или live_full".into(),
            ));
        }
        event.visibility = visibility.clone();
        changed.push("visibility");
    }
    if let Some(quorum) = req.quorum {
        if !(1..=QUORUM_MAX).contains(&quorum) {
            return Err(AppError::Validation(format!(
                "Кворум: целое число от 1 до {QUORUM_MAX}"
            )));
        }
        event.quorum = quorum;
        changed.push("quorum");
    }
    if let Some(label) = &req.teams_label {
        event.teams_label = match label {
            Some(raw) => clean_optional(raw, "Название списка команд", LABEL_MAX)?,
            None => None,
        };
        changed.push("teams_label");
    }
    if let Some(enabled) = req.teams_label_enabled {
        event.teams_label_enabled = enabled;
        changed.push("teams_label_enabled");
    }
    if let Some(label) = &req.criteria_label {
        event.criteria_label = match label {
            Some(raw) => clean_optional(raw, "Название списка критериев", LABEL_MAX)?,
            None => None,
        };
        changed.push("criteria_label");
    }
    if let Some(enabled) = req.criteria_label_enabled {
        event.criteria_label_enabled = enabled;
        changed.push("criteria_label_enabled");
    }

    let mut alert_touched = false;
    if let Some(title) = &req.alert_title {
        event.alert_title =
            clean_optional(title, "Заголовок уведомления", ALERT_TITLE_MAX)?.unwrap_or_default();
        alert_touched = true;
    }
    if let Some(text) = &req.alert_text {
        event.alert_text =
            clean_optional(text, "Текст уведомления", DESCRIPTION_MAX)?.unwrap_or_default();
        alert_touched = true;
    }
    if let Some(align) = &req.alert_align {
        if !matches!(align.as_str(), "left" | "center") {
            return Err(AppError::Validation(
                "Выравнивание уведомления: left или center".into(),
            ));
        }
        event.alert_align = align.clone();
        alert_touched = true;
    }
    if let Some(button) = &req.alert_button_text {
        event.alert_button_text =
            clean_optional(button, "Текст кнопки", ALERT_BUTTON_MAX)?.unwrap_or_default();
        alert_touched = true;
    }
    if let Some(enabled) = req.alert_enabled {
        event.alert_enabled = enabled;
        alert_touched = true;
    }
    if alert_touched {
        changed.push("alert");
        if event.alert_enabled {
            event.alert_version += 1;
        }
    }

    if let Some(enabled) = req.overlay_enabled {
        event.overlay_enabled = enabled;
        changed.push("overlay_enabled");
    }
    if let Some(color) = &req.overlay_color {
        if !is_hex_color(color) {
            return Err(AppError::Validation(
                "Цвет затемнения: формат #rrggbb".into(),
            ));
        }
        event.overlay_color = color.to_ascii_lowercase();
        changed.push("overlay_color");
    }
    if let Some(opacity) = req.overlay_opacity {
        if !(0..=100).contains(&opacity) {
            return Err(AppError::Validation(
                "Непрозрачность затемнения: от 0 до 100".into(),
            ));
        }
        event.overlay_opacity = opacity;
        changed.push("overlay_opacity");
    }

    let mut stage_touched = false;
    if let Some(view) = &req.stage_view {
        if !matches!(view.as_str(), "waiting" | "leaderboard" | "podium") {
            return Err(AppError::Validation(
                "Вид сцены: waiting, leaderboard или podium".into(),
            ));
        }
        event.stage_view = view.clone();
        changed.push("stage_view");
        stage_touched = true;
    }
    if let Some(top_n) = req.stage_top_n {
        if !(1..=STAGE_TOP_N_MAX).contains(&top_n) {
            return Err(AppError::Validation(format!(
                "Число призовых мест: от 1 до {STAGE_TOP_N_MAX}"
            )));
        }
        if top_n != current.stage_top_n {
            event.stage_top_n = top_n;
            event.stage_revealed = 0;
        }
        changed.push("stage_top_n");
        stage_touched = true;
    }

    event.updated_at = now_ms();
    sqlx::query(
        "UPDATE events SET title = ?, description = ?, starts_at = ?, location = ?, scoring_mode = ?, \
         notes_enabled = ?, visibility = ?, quorum = ?, teams_label = ?, teams_label_enabled = ?, \
         criteria_label = ?, criteria_label_enabled = ?, alert_enabled = ?, alert_title = ?, \
         alert_text = ?, alert_align = ?, alert_button_text = ?, alert_version = ?, \
         overlay_enabled = ?, overlay_color = ?, overlay_opacity = ?, stage_view = ?, stage_top_n = ?, \
         stage_revealed = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&event.title)
    .bind(&event.description)
    .bind(event.starts_at)
    .bind(&event.location)
    .bind(&event.scoring_mode)
    .bind(event.notes_enabled)
    .bind(&event.visibility)
    .bind(event.quorum)
    .bind(&event.teams_label)
    .bind(event.teams_label_enabled)
    .bind(&event.criteria_label)
    .bind(event.criteria_label_enabled)
    .bind(event.alert_enabled)
    .bind(&event.alert_title)
    .bind(&event.alert_text)
    .bind(&event.alert_align)
    .bind(&event.alert_button_text)
    .bind(event.alert_version)
    .bind(event.overlay_enabled)
    .bind(&event.overlay_color)
    .bind(event.overlay_opacity)
    .bind(&event.stage_view)
    .bind(event.stage_top_n)
    .bind(event.stage_revealed)
    .bind(event.updated_at)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.update",
        json!({ "fields": changed }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;

    state.sse.notify(&id, ChangeKind::Event);
    if alert_touched {
        state.sse.notify(&id, ChangeKind::Alert);
    }
    if stage_touched {
        state.sse.notify(&id, ChangeKind::Stage);
    }
    Ok(Json(full))
}

async fn delete(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &id).await?;
    sqlx::query("DELETE FROM events WHERE id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.delete",
        json!({ "title": event.title }),
    )
    .await?;
    tx.commit().await?;
    if let Some(file) = &event.background_file {
        remove_upload(&state, file).await;
    }
    state.sse.notify(&id, ChangeKind::Status);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct TransitionRequest {
    to: String,
    reason: Option<String>,
    #[serde(default)]
    force: bool,
}

fn required_reason(reason: &Option<String>) -> AppResult<String> {
    clean_required(reason.as_deref().unwrap_or(""), "Причина", 500)
        .map_err(|_| AppError::Validation("Укажите причину (до 500 символов)".into()))
}

async fn transition(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<TransitionRequest>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &id).await?;
    let from = event.status.as_str();
    let to = req.to.as_str();
    let now = now_ms();
    let mut reason: Option<String> = None;
    let mut locked_at = event.locked_at;

    match (from, to) {
        ("draft", "judging") => {
            let counts: (i64, i64, i64) = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM teams WHERE event_id = ?1), \
                 (SELECT COUNT(*) FROM criteria WHERE event_id = ?1), \
                 (SELECT COUNT(*) FROM judges WHERE event_id = ?1 AND is_active = 1)",
            )
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
            let mut missing = Vec::new();
            if counts.0 == 0 {
                missing.push("teams");
            }
            if counts.1 == 0 {
                missing.push("criteria");
            }
            if counts.2 == 0 {
                missing.push("judges");
            }
            if !missing.is_empty() {
                return Err(AppError::InvalidState(
                    "Для начала оценивания нужна хотя бы одна команда, один критерий и один активный судья"
                        .into(),
                    Some(json!({ "missing": missing })),
                ));
            }
        }
        ("judging", "locked") => locked_at = Some(now),
        ("locked", "judging") => {
            reason = Some(required_reason(&req.reason)?);
            locked_at = None;
        }
        ("locked", "finalized") => {
            let unsubmitted: Vec<(String, String)> = sqlx::query_as(
                "SELECT id, name FROM judges WHERE event_id = ? AND is_active = 1 \
                 AND submitted_at IS NULL ORDER BY created_at, rowid",
            )
            .bind(&id)
            .fetch_all(&mut *tx)
            .await?;
            if !unsubmitted.is_empty() {
                let details: Vec<Value> = unsubmitted
                    .iter()
                    .map(|(id, name)| json!({ "id": id, "name": name }))
                    .collect();
                if !req.force {
                    return Err(AppError::InvalidState(
                        "Не все активные судьи сдали листы".into(),
                        Some(json!({ "unsubmitted": details })),
                    ));
                }
                reason = Some(required_reason(&req.reason)?);
            } else if req.reason.is_some() {
                reason = Some(required_reason(&req.reason)?);
            }
            let ranking = domain::compute_ranking(&mut tx, &event, Mode::Official).await?;
            sqlx::query(
                "INSERT INTO result_snapshots (id, event_id, created_at, created_by, payload) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(new_id())
            .bind(&id)
            .bind(now)
            .bind(&session.admin.id)
            .bind(serde_json::to_string(&ranking).expect("ranking serializes"))
            .execute(&mut *tx)
            .await?;
        }
        ("finalized", "locked") => reason = Some(required_reason(&req.reason)?),
        ("finalized", "published") | ("published", "finalized") => {}
        _ => {
            return Err(AppError::InvalidState(
                format!("Переход «{from}» → «{to}» недопустим"),
                None,
            ));
        }
    }

    sqlx::query("UPDATE events SET status = ?, locked_at = ?, updated_at = ? WHERE id = ?")
        .bind(to)
        .bind(locked_at)
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.transition",
        json!({ "from": from, "to": to, "reason": reason, "force": req.force }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    state.sse.notify(&id, ChangeKind::Status);
    Ok(Json(full))
}

#[derive(Deserialize)]
struct RevealRequest {
    action: String,
}

async fn stage_reveal(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    Json(req): Json<RevealRequest>,
) -> AppResult<Json<Value>> {
    if !matches!(req.action.as_str(), "next" | "prev" | "reset" | "all") {
        return Err(AppError::Validation(
            "Действие: next, prev, reset или all".into(),
        ));
    }
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &id).await?;
    if !domain::is_closed(&event.status) {
        return Err(AppError::InvalidState(
            "Сцена доступна только после утверждения результатов".into(),
            None,
        ));
    }
    let (ranking, _) = domain::resolve_ranking(&mut tx, &event, Mode::Official).await?;
    let ranks: Vec<_> = ranking.rows.iter().map(|row| row.rank).collect();
    let total = stage_slice(&ranks, "podium", event.stage_top_n as u32, 0).total_groups as i64;
    // A stored value above `total` (ranking changed after re-finalizing) is clamped first.
    let current = event.stage_revealed.min(total);
    let revealed = match req.action.as_str() {
        "next" => (current + 1).min(total),
        "prev" => (current - 1).max(0),
        "reset" => 0,
        _ => total,
    };
    sqlx::query("UPDATE events SET stage_revealed = ?, updated_at = ? WHERE id = ?")
        .bind(revealed)
        .bind(now_ms())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.stage_reveal",
        json!({ "action": req.action, "from": event.stage_revealed, "to": revealed }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    state.sse.notify(&id, ChangeKind::Stage);
    Ok(Json(full))
}

// ---- background image ----

/// File extension for a supported image type when the magic bytes match its content type.
fn image_extension(content_type: &str, bytes: &[u8]) -> Option<&'static str> {
    match content_type {
        "image/png" if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) => {
            Some("png")
        }
        "image/jpeg" if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) => Some("jpg"),
        "image/webp" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Some("webp")
        }
        _ => None,
    }
}

pub fn upload_path(state: &AppState, file: &str) -> std::path::PathBuf {
    state.config.data_dir.join("uploads").join(file)
}

async fn remove_upload(state: &AppState, file: &str) {
    if let Err(err) = tokio::fs::remove_file(upload_path(state, file)).await
        && err.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%err, file, "failed to remove upload");
    }
}

async fn put_background(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Json<Value>> {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if body.is_empty() || body.len() > BACKGROUND_MAX_BYTES {
        return Err(AppError::Validation("Размер изображения: до 5 МБ".into()));
    }
    let ext = image_extension(&content_type, &body).ok_or_else(|| {
        AppError::Validation("Допустимы только изображения PNG, JPEG и WebP".into())
    })?;
    let file = format!("{id}.{ext}");

    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &id).await?;
    let dir = state.config.data_dir.join("uploads");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|err| AppError::Internal(err.into()))?;
    let tmp = dir.join(format!("{file}.tmp"));
    tokio::fs::write(&tmp, &body)
        .await
        .map_err(|err| AppError::Internal(err.into()))?;
    tokio::fs::rename(&tmp, dir.join(&file))
        .await
        .map_err(|err| AppError::Internal(err.into()))?;
    sqlx::query("UPDATE events SET background_file = ?, updated_at = ? WHERE id = ?")
        .bind(&file)
        .bind(now_ms())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.background_set",
        json!({ "file": file, "bytes": body.len() }),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    if let Some(old) = event.background_file.filter(|old| *old != file) {
        remove_upload(&state, &old).await;
    }
    state.sse.notify(&id, ChangeKind::Event);
    Ok(Json(full))
}

async fn delete_background(
    State(state): State<AppState>,
    session: AdminSession,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut tx = begin_write(&state.pool).await?;
    let event = load_event(&mut tx, &id).await?;
    sqlx::query("UPDATE events SET background_file = NULL, updated_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&id),
        Some(&session.admin.id),
        "event.background_delete",
        json!({}),
    )
    .await?;
    let full = event_full(&mut tx, &id).await?;
    tx.commit().await?;
    if let Some(old) = &event.background_file {
        remove_upload(&state, old).await;
    }
    state.sse.notify(&id, ChangeKind::Event);
    Ok(Json(full))
}

// ---- matrix, results, export, audit, stream ----

async fn matrix(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    load_event(&mut conn, &id).await?;
    let judges = load_judges(&mut conn, &id).await?;
    let teams = load_teams(&mut conn, &id).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM criteria WHERE event_id = ?")
        .bind(&id)
        .fetch_one(&mut *conn)
        .await?;
    let counts: HashMap<(String, String), i64> = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT s.judge_id, s.team_id, COUNT(*) FROM scores s \
         JOIN judges j ON j.id = s.judge_id WHERE j.event_id = ? AND s.value_x100 IS NOT NULL \
         GROUP BY s.judge_id, s.team_id",
    )
    .bind(&id)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|(judge, team, n)| ((judge, team), n))
    .collect();
    let mut cells = Vec::with_capacity(judges.len() * teams.len());
    for judge in &judges {
        for team in &teams {
            let scored = counts
                .get(&(judge.id.clone(), team.id.clone()))
                .copied()
                .unwrap_or(0);
            cells.push(json!({
                "judge_id": judge.id, "team_id": team.id, "scored": scored, "total": total,
            }));
        }
    }
    let teams: Vec<Value> = teams
        .iter()
        .map(|t| json!({ "id": t.id, "name": t.name }))
        .collect();
    Ok(Json(
        json!({ "judges": judges, "teams": teams, "cells": cells }),
    ))
}

#[derive(Deserialize)]
struct ResultsQuery {
    mode: Option<Mode>,
}

async fn results(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
    Query(query): Query<ResultsQuery>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let event = load_event(&mut conn, &id).await?;
    let mode = query.mode.unwrap_or(Mode::Provisional);
    let (ranking, snapshot) = domain::resolve_ranking(&mut conn, &event, mode).await?;
    let mut value = domain::ranking_json(&mut conn, &id, &ranking).await?;
    if let Some(snapshot) = snapshot {
        value["snapshot"] = json!(snapshot);
    }
    Ok(Json(value))
}

/// Formats hundredths as a decimal with a comma (what a Russian-locale spreadsheet expects).
fn format_x100(value: i64) -> String {
    format!("{},{:02}", value / 100, value % 100)
}

/// Quotes a CSV cell; text starting with a formula character is neutralized with a leading `'`.
fn csv_text_cell(raw: &str) -> String {
    let mut cell = raw.to_string();
    if cell.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        cell.insert(0, '\'');
    }
    csv_quote(&cell)
}

fn csv_quote(cell: &str) -> String {
    if cell.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_string()
    }
}

async fn export_csv(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.pool.acquire().await?;
    let event = load_event(&mut conn, &id).await?;
    let mode = if domain::is_closed(&event.status) {
        Mode::Official
    } else {
        Mode::Provisional
    };
    let (ranking, _) = domain::resolve_ranking(&mut conn, &event, mode).await?;
    let teams: HashMap<String, String> = load_teams(&mut conn, &id)
        .await?
        .into_iter()
        .map(|t| (t.id, t.name))
        .collect();
    let criteria = domain::load_criteria(&mut conn, &id).await?;
    let judges = load_judges(&mut conn, &id).await?;

    let mut header = vec![
        "Место".to_string(),
        "Команда".to_string(),
        "Балл".to_string(),
        "Листов".to_string(),
        "Кворум".to_string(),
    ];
    header.extend(criteria.iter().map(|c| csv_text_cell(&c.name)));
    header.extend(judges.iter().map(|j| csv_text_cell(&j.name)));
    let mut lines = vec![header.join(";")];
    for row in &ranking.rows {
        let mut cells = vec![
            row.rank.map(|r| r.to_string()).unwrap_or_default(),
            csv_text_cell(teams.get(&row.team_id).map_or("", String::as_str)),
            row.score_x100.map(format_x100).unwrap_or_default(),
            row.sheets.to_string(),
            if row.meets_quorum { "да" } else { "нет" }.to_string(),
        ];
        cells.extend(
            row.criteria
                .iter()
                .map(|c| c.avg_x100.map(format_x100).unwrap_or_default()),
        );
        cells.extend(judges.iter().map(|j| {
            row.judges
                .iter()
                .find(|s| s.judge_id == j.id)
                .map(|s| format_x100(s.score_x100))
                .unwrap_or_default()
        }));
        lines.push(cells.join(";"));
    }
    let body = format!("\u{feff}{}\r\n", lines.join("\r\n"));
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"results-{id}.csv\""),
            ),
        ],
        body,
    ))
}

async fn audit_log(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<Value>>> {
    let mut conn = state.pool.acquire().await?;
    load_event(&mut conn, &id).await?;
    let rows: Vec<(i64, Option<String>, String, String, i64)> = sqlx::query_as(
        "SELECT l.id, a.name, l.action, l.details, l.created_at FROM audit_log l \
         LEFT JOIN admins a ON a.id = l.admin_id WHERE l.event_id = ? \
         ORDER BY l.id DESC LIMIT 1000",
    )
    .bind(&id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, admin_name, action, details, created_at)| {
                let details: Value = serde_json::from_str(&details).unwrap_or(Value::Null);
                json!({
                    "id": id, "admin_name": admin_name, "action": action,
                    "details": details, "created_at": created_at,
                })
            })
            .collect(),
    ))
}

async fn stream(
    State(state): State<AppState>,
    _admin: AdminSession,
    Path(id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut conn = state.pool.acquire().await?;
    load_event(&mut conn, &id).await?;
    drop(conn);
    Ok(state.sse.stream(&id))
}
