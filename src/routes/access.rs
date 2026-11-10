use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Row, SqliteConnection};

use crate::access;
use crate::audit;
use crate::auth::{AdminSession, ClientIp, EventSession, EventUser, event_session_token};
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::domain::{clean_required, load_event};
use crate::error::{AppError, AppResult};
use crate::sse::ChangeKind;
use crate::state::AppState;
use crate::util::{new_id, now_ms};

const LOGIN_LIMIT: u32 = 5;
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const USER_NAME_MAX: usize = 80;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/events/{id}/access/bootstrap", post(bootstrap_organizer))
        .route("/events/{id}/access/enter", post(enter_as_organizer))
        .route("/events/{id}/access/login", post(login))
        .route("/access/magic/{token}", post(magic_login))
        .route("/access/me", get(me))
        .route("/access/logout", post(logout))
        .route("/access/workspace", get(workspace))
        .route("/access/stream", get(stream))
        .route("/access/ws", get(websocket))
        .route("/access/teams", post(create_team))
        .route("/access/users", post(create_user))
        .route("/access/users/{id}/password", post(rotate_password))
        .route("/access/users/{id}/magic", post(rotate_magic))
        .route("/access/questions", post(create_question))
        .route(
            "/access/questions/{id}",
            axum::routing::delete(delete_question),
        )
        .route("/access/phase", patch(set_phase))
        .route("/access/team-draft", patch(save_team_draft))
        .route("/access/submit", post(submit))
}

#[derive(Deserialize)]
struct PasswordRequest {
    password: String,
}

#[derive(Deserialize)]
struct BootstrapRequest {
    name: String,
}

#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    role: String,
    team_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateTeamRequest {
    name: String,
}

#[derive(Deserialize)]
struct CreateQuestionRequest {
    audience: String,
    prompt: String,
    options: Vec<String>,
}

#[derive(Deserialize)]
struct PhaseRequest {
    phase: String,
}

#[derive(Deserialize)]
struct SubmitRequest {
    answers: Vec<AnswerRequest>,
}

#[derive(Deserialize)]
struct AnswerRequest {
    question_id: String,
    option_id: String,
}

#[derive(Deserialize)]
struct TeamDraftRequest {
    question_id: String,
    option_id: String,
}

fn organizer(session: &EventSession) -> AppResult<&EventUser> {
    if session.user.role != "organizer" {
        return Err(AppError::Forbidden("Только организатор может это делать"));
    }
    Ok(&session.user)
}

fn role_valid(role: &str) -> bool {
    matches!(role, "organizer" | "jury" | "teacher" | "student")
}

fn phase_order(phase: &str) -> Option<u8> {
    match phase {
        "setup" => Some(0),
        "teachers" => Some(1),
        "students" => Some(2),
        "finished" => Some(3),
        _ => None,
    }
}

fn access_link(state: &AppState, headers: &HeaderMap, token: &str) -> String {
    format!("{}/m/{token}", state.config.base_url(headers))
}

async fn event_phase(conn: &mut SqliteConnection, event_id: &str) -> AppResult<String> {
    sqlx::query_scalar("SELECT workflow_phase FROM events WHERE id = ?")
        .bind(event_id)
        .fetch_optional(conn)
        .await?
        .ok_or(AppError::NotFound)
}

async fn bootstrap_organizer(
    State(state): State<AppState>,
    session: AdminSession,
    headers: HeaderMap,
    Path(event_id): Path<String>,
    Json(req): Json<BootstrapRequest>,
) -> AppResult<Json<Value>> {
    let name = clean_required(&req.name, "Имя организатора", USER_NAME_MAX)?;
    let password = access::generate_password();
    let magic = random_token();
    let mut tx = begin_write(&state.pool).await?;
    load_event(&mut tx, &event_id).await?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM event_users WHERE event_id = ? AND role = 'organizer' AND is_active = 1)",
    )
    .bind(&event_id)
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        return Err(AppError::Conflict(
            "Организатор мероприятия уже создан".into(),
        ));
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO event_users \
         (id, event_id, name, role, password_hash, magic_token_hash, created_at) \
         VALUES (?, ?, ?, 'organizer', ?, ?, ?)",
    )
    .bind(&id)
    .bind(&event_id)
    .bind(&name)
    .bind(access::hash_password(&password)?)
    .bind(hash_token(&magic))
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "access.organizer_create",
        json!({ "id": id, "name": name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&event_id, ChangeKind::Composition);
    Ok(Json(json!({
        "user": { "id": id, "name": name, "role": "organizer", "team_id": null },
        "password": password,
        "magic_url": access_link(&state, &headers, &magic),
        "login_url": format!("{}/{event_id}/auth", state.config.base_url(&headers)),
    })))
}

async fn enter_as_organizer(
    State(state): State<AppState>,
    session: AdminSession,
    headers: HeaderMap,
    Path(event_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut tx = begin_write(&state.pool).await?;
    load_event(&mut tx, &event_id).await?;
    let organizer_id = if let Some(id) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM event_users WHERE event_id = ? AND role = 'organizer' AND is_active = 1 LIMIT 1",
    )
    .bind(&event_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        id
    } else {
        let id = new_id();
        let password = access::generate_password();
        sqlx::query(
            "INSERT INTO event_users \
             (id, event_id, name, role, password_hash, magic_token_hash, created_at) \
             VALUES (?, ?, ?, 'organizer', ?, ?, ?)",
        )
        .bind(&id)
        .bind(&event_id)
        .bind(&session.admin.name)
        .bind(access::hash_password(&password)?)
        .bind(hash_token(&random_token()))
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
        id
    };
    let event_session = access::create_session(&mut tx, &organizer_id).await?;
    audit::record(
        &mut *tx,
        Some(&event_id),
        Some(&session.admin.id),
        "access.organizer_enter",
        json!({ "organizer_id": organizer_id }),
    )
    .await?;
    tx.commit().await?;
    Ok((
        [(
            header::SET_COOKIE,
            access::session_cookie(&state.config, &headers, &event_session),
        )],
        Json(json!({ "ok": true })),
    ))
}

async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Path(event_id): Path<String>,
    Json(req): Json<PasswordRequest>,
) -> AppResult<impl IntoResponse> {
    if !state.rate_limiter.allow(
        &format!("access-login:{event_id}:{ip}"),
        LOGIN_LIMIT,
        LOGIN_WINDOW,
    ) {
        return Err(AppError::RateLimited);
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, password_hash FROM event_users WHERE event_id = ? AND is_active = 1",
    )
    .bind(&event_id)
    .fetch_all(&state.pool)
    .await?;
    let user_id = rows
        .iter()
        .find(|(_, hash)| access::verify_password(&req.password, hash))
        .map(|(id, _)| id.clone())
        .ok_or(AppError::BadCredentials("Неверный пароль"))?;
    let mut tx = begin_write(&state.pool).await?;
    let token = access::create_session(&mut tx, &user_id).await?;
    tx.commit().await?;
    Ok((
        [(
            header::SET_COOKIE,
            access::session_cookie(&state.config, &headers, &token),
        )],
        Json(json!({ "ok": true })),
    ))
}

async fn magic_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> AppResult<impl IntoResponse> {
    let user_id: String = sqlx::query_scalar(
        "SELECT id FROM event_users WHERE magic_token_hash = ? AND is_active = 1",
    )
    .bind(hash_token(&token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::Unauthorized)?;
    let mut tx = begin_write(&state.pool).await?;
    let session = access::create_session(&mut tx, &user_id).await?;
    tx.commit().await?;
    Ok((
        [(
            header::SET_COOKIE,
            access::session_cookie(&state.config, &headers, &session),
        )],
        Json(json!({ "ok": true })),
    ))
}

async fn me(session: EventSession) -> Json<Value> {
    Json(json!({ "user": session.user }))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<impl IntoResponse> {
    if let Some(token) = event_session_token(&headers) {
        sqlx::query("DELETE FROM event_sessions WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&state.pool)
            .await?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            access::clear_cookie(&state.config, &headers),
        )],
        StatusCode::NO_CONTENT,
    ))
}

async fn workspace(State(state): State<AppState>, session: EventSession) -> AppResult<Json<Value>> {
    let event = sqlx::query("SELECT id, title, workflow_phase FROM events WHERE id = ?")
        .bind(&session.user.event_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let teams = sqlx::query(
        "SELECT id, name FROM teams WHERE event_id = ? ORDER BY sort_order, rowid",
    )
    .bind(&session.user.event_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| json!({ "id": row.get::<String, _>("id"), "name": row.get::<String, _>("name") }))
    .collect::<Vec<_>>();
    let users = sqlx::query(
        "SELECT u.id, u.team_id, u.name, u.role, \
         CASE WHEN u.role IN ('teacher', 'student') THEN (ts.team_id IS NOT NULL) ELSE 0 END submitted, \
         ts.submitted_at submitted_at \
         FROM event_users u LEFT JOIN team_form_submissions ts ON ts.team_id = u.team_id AND ts.audience = u.role \
         WHERE u.event_id = ? AND u.is_active = 1 \
         ORDER BY CASE u.role WHEN 'organizer' THEN 1 WHEN 'jury' THEN 2 WHEN 'teacher' THEN 3 ELSE 4 END, u.name",
    )
    .bind(&session.user.event_id)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|row| json!({
        "id": row.get::<String, _>("id"),
        "team_id": row.get::<Option<String>, _>("team_id"),
        "name": row.get::<String, _>("name"),
        "role": row.get::<String, _>("role"),
        "submitted": row.get::<bool, _>("submitted"),
        "submitted_at": row.get::<Option<i64>, _>("submitted_at"),
    }))
    .collect::<Vec<_>>();
    let questions = load_questions(&state, &session.user.event_id).await?;
    let team_draft = if matches!(session.user.role.as_str(), "organizer" | "jury") {
        load_team_draft(&state, &session.user.event_id, None, None).await?
    } else if matches!(session.user.role.as_str(), "teacher" | "student") {
        load_team_draft(
            &state,
            &session.user.event_id,
            session.user.team_id.as_deref(),
            Some(&session.user.role),
        )
        .await?
    } else {
        Vec::new()
    };
    Ok(Json(json!({
        "event": {
            "id": event.get::<String, _>("id"),
            "title": event.get::<String, _>("title"),
            "phase": event.get::<String, _>("workflow_phase"),
        },
        "current_user": session.user,
        "teams": teams,
        "users": users,
        "questions": questions,
        "team_draft": team_draft,
    })))
}

async fn load_team_draft(
    state: &AppState,
    event_id: &str,
    team_id: Option<&str>,
    audience: Option<&str>,
) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT a.team_id, q.audience, a.question_id, a.option_id, a.edited_by, u.name edited_by_name, \
         a.updated_at, (s.team_id IS NOT NULL) submitted \
         FROM team_form_answers a \
         JOIN form_questions q ON q.id = a.question_id \
         JOIN event_users u ON u.id = a.edited_by \
         LEFT JOIN team_form_submissions s ON s.team_id = a.team_id AND s.audience = q.audience \
         WHERE q.event_id = ? AND (? IS NULL OR a.team_id = ?) \
         AND (? IS NULL OR q.audience = ?) ORDER BY a.updated_at",
    )
    .bind(event_id)
    .bind(team_id)
    .bind(team_id)
    .bind(audience)
    .bind(audience)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "team_id": row.get::<String, _>("team_id"),
                "audience": row.get::<String, _>("audience"),
                "question_id": row.get::<String, _>("question_id"),
                "option_id": row.get::<String, _>("option_id"),
                "edited_by": row.get::<String, _>("edited_by"),
                "edited_by_name": row.get::<String, _>("edited_by_name"),
                "updated_at": row.get::<i64, _>("updated_at"),
                "submitted": row.get::<bool, _>("submitted"),
            })
        })
        .collect())
}

async fn create_team(
    State(state): State<AppState>,
    session: EventSession,
    Json(req): Json<CreateTeamRequest>,
) -> AppResult<Json<Value>> {
    let user = organizer(&session)?;
    let name = clean_required(&req.name, "Название команды", 200)?;
    let mut tx = begin_write(&state.pool).await?;
    if event_phase(&mut tx, &user.event_id).await? != "setup" {
        return Err(AppError::InvalidState(
            "Команды можно менять только на этапе настройки".into(),
            None,
        ));
    }
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM teams WHERE event_id = ?",
    )
    .bind(&user.event_id)
    .fetch_one(&mut *tx)
    .await?;
    let id = new_id();
    sqlx::query("INSERT INTO teams (id, event_id, name, sort_order) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.event_id)
        .bind(&name)
        .bind(sort_order)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        Some(&user.event_id),
        None,
        "access.team_create",
        json!({ "id": id, "name": name }),
    )
    .await?;
    tx.commit().await?;
    state.sse.notify(&user.event_id, ChangeKind::Composition);
    Ok(Json(json!({ "id": id, "name": name })))
}

async fn create_user(
    State(state): State<AppState>,
    session: EventSession,
    headers: HeaderMap,
    Json(req): Json<CreateUserRequest>,
) -> AppResult<Json<Value>> {
    let organizer = organizer(&session)?;
    if !role_valid(&req.role) {
        return Err(AppError::Validation("Неизвестная роль".into()));
    }
    let name = clean_required(&req.name, "Имя", USER_NAME_MAX)?;
    if matches!(req.role.as_str(), "teacher" | "student") && req.team_id.is_none() {
        return Err(AppError::Validation(
            "Педагогу или студенту нужна команда".into(),
        ));
    }
    let mut tx = begin_write(&state.pool).await?;
    if event_phase(&mut tx, &organizer.event_id).await? != "setup" {
        return Err(AppError::InvalidState(
            "Участников можно добавлять только на этапе настройки".into(),
            None,
        ));
    }
    if let Some(team_id) = &req.team_id {
        let valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM teams WHERE id = ? AND event_id = ?)")
                .bind(team_id)
                .bind(&organizer.event_id)
                .fetch_one(&mut *tx)
                .await?;
        if !valid {
            return Err(AppError::Validation("Команда не найдена".into()));
        }
    }
    let password = access::generate_password();
    let magic = random_token();
    let id = new_id();
    let team_id = if matches!(req.role.as_str(), "teacher" | "student") {
        req.team_id.as_deref()
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO event_users \
         (id, event_id, team_id, name, role, password_hash, magic_token_hash, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&organizer.event_id)
    .bind(team_id)
    .bind(&name)
    .bind(&req.role)
    .bind(access::hash_password(&password)?)
    .bind(hash_token(&magic))
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        Some(&organizer.event_id),
        None,
        "access.user_create",
        json!({ "id": id, "name": name, "role": req.role }),
    )
    .await?;
    tx.commit().await?;
    state
        .sse
        .notify(&organizer.event_id, ChangeKind::Composition);
    Ok(Json(json!({
        "user": { "id": id, "team_id": team_id, "name": name, "role": req.role },
        "password": password,
        "magic_url": access_link(&state, &headers, &magic),
    })))
}

async fn rotate_password(
    State(state): State<AppState>,
    session: EventSession,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let organizer = organizer(&session)?;
    let password = access::generate_password();
    let mut tx = begin_write(&state.pool).await?;
    let changed =
        sqlx::query("UPDATE event_users SET password_hash = ? WHERE id = ? AND event_id = ?")
            .bind(access::hash_password(&password)?)
            .bind(&id)
            .bind(&organizer.event_id)
            .execute(&mut *tx)
            .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::NotFound);
    }
    sqlx::query("DELETE FROM event_sessions WHERE user_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .sse
        .notify(&organizer.event_id, ChangeKind::Composition);
    Ok(Json(json!({ "password": password })))
}

async fn rotate_magic(
    State(state): State<AppState>,
    session: EventSession,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let organizer = organizer(&session)?;
    let magic = random_token();
    let mut tx = begin_write(&state.pool).await?;
    let changed =
        sqlx::query("UPDATE event_users SET magic_token_hash = ? WHERE id = ? AND event_id = ?")
            .bind(hash_token(&magic))
            .bind(&id)
            .bind(&organizer.event_id)
            .execute(&mut *tx)
            .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::NotFound);
    }
    sqlx::query("DELETE FROM event_sessions WHERE user_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .sse
        .notify(&organizer.event_id, ChangeKind::Composition);
    Ok(Json(
        json!({ "magic_url": access_link(&state, &headers, &magic) }),
    ))
}

async fn create_question(
    State(state): State<AppState>,
    session: EventSession,
    Json(req): Json<CreateQuestionRequest>,
) -> AppResult<Json<Value>> {
    let organizer = organizer(&session)?;
    if !matches!(req.audience.as_str(), "teacher" | "student") {
        return Err(AppError::Validation("Неизвестная аудитория".into()));
    }
    let prompt = clean_required(&req.prompt, "Вопрос", 500)?;
    let options = req
        .options
        .iter()
        .map(|option| clean_required(option, "Вариант ответа", 300))
        .collect::<AppResult<Vec<_>>>()?;
    if !(2..=12).contains(&options.len()) {
        return Err(AppError::Validation("Нужно от 2 до 12 вариантов".into()));
    }
    let mut tx = begin_write(&state.pool).await?;
    if event_phase(&mut tx, &organizer.event_id).await? != "setup" {
        return Err(AppError::InvalidState(
            "Вопросы можно менять только на этапе настройки".into(),
            None,
        ));
    }
    let sort_order: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM form_questions WHERE event_id = ? AND audience = ?",
    )
    .bind(&organizer.event_id)
    .bind(&req.audience)
    .fetch_one(&mut *tx)
    .await?;
    let question_id = new_id();
    sqlx::query(
        "INSERT INTO form_questions (id, event_id, audience, prompt, sort_order) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&question_id)
    .bind(&organizer.event_id)
    .bind(&req.audience)
    .bind(&prompt)
    .bind(sort_order)
    .execute(&mut *tx)
    .await?;
    let mut option_values = Vec::new();
    for (sort_order, label) in options.into_iter().enumerate() {
        let id = new_id();
        sqlx::query(
            "INSERT INTO form_options (id, question_id, label, sort_order) VALUES (?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&question_id)
        .bind(&label)
        .bind(sort_order as i64)
        .execute(&mut *tx)
        .await?;
        option_values.push(json!({ "id": id, "label": label }));
    }
    tx.commit().await?;
    state
        .sse
        .notify(&organizer.event_id, ChangeKind::Composition);
    Ok(Json(
        json!({ "id": question_id, "audience": req.audience, "prompt": prompt, "options": option_values }),
    ))
}

async fn delete_question(
    State(state): State<AppState>,
    session: EventSession,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let organizer = organizer(&session)?;
    let mut tx = begin_write(&state.pool).await?;
    if event_phase(&mut tx, &organizer.event_id).await? != "setup" {
        return Err(AppError::InvalidState(
            "Вопросы можно менять только на этапе настройки".into(),
            None,
        ));
    }
    let changed = sqlx::query("DELETE FROM form_questions WHERE id = ? AND event_id = ?")
        .bind(&id)
        .bind(&organizer.event_id)
        .execute(&mut *tx)
        .await?;
    if changed.rows_affected() != 1 {
        return Err(AppError::NotFound);
    }
    tx.commit().await?;
    state
        .sse
        .notify(&session.user.event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}

async fn stream(
    State(state): State<AppState>,
    session: EventSession,
) -> AppResult<impl IntoResponse> {
    let slot = state
        .public_streams
        .acquire(&format!("event-user:{}", session.user.id), 3, 2000)
        .ok_or(AppError::RateLimited)?;
    let event_id = session.user.event_id;
    let hold_slot = async move {
        let _slot = slot;
        std::future::pending::<()>().await;
    };
    Ok(state.sse.stream_until(&event_id, hold_slot))
}

async fn websocket(
    State(state): State<AppState>,
    session: EventSession,
    upgrade: WebSocketUpgrade,
) -> AppResult<impl IntoResponse> {
    let slot = state
        .public_streams
        .acquire(&format!("event-user-ws:{}", session.user.id), 3, 2000)
        .ok_or(AppError::RateLimited)?;
    let mut changes = state.sse.subscribe(&session.user.event_id);
    Ok(upgrade.on_upgrade(move |socket| async move {
        let _slot = slot;
        run_websocket(socket, &mut changes).await;
    }))
}

async fn run_websocket(
    mut socket: WebSocket,
    changes: &mut tokio::sync::broadcast::Receiver<ChangeKind>,
) {
    loop {
        tokio::select! {
            change = changes.recv() => {
                let kinds = match change {
                    Ok(kind) => vec![kind],
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => vec![ChangeKind::Event, ChangeKind::Composition, ChangeKind::Status],
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                for kind in kinds {
                    let payload = json!({ "kind": kind }).to_string();
                    if socket.send(Message::Text(payload.into())).await.is_err() {
                        return;
                    }
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                    _ => {}
                }
            }
        }
    }
}

async fn set_phase(
    State(state): State<AppState>,
    session: EventSession,
    Json(req): Json<PhaseRequest>,
) -> AppResult<Json<Value>> {
    let organizer = organizer(&session)?;
    let requested =
        phase_order(&req.phase).ok_or_else(|| AppError::Validation("Неизвестный этап".into()))?;
    let mut tx = begin_write(&state.pool).await?;
    let current_phase = event_phase(&mut tx, &organizer.event_id).await?;
    let current = phase_order(&current_phase).expect("stored phase is valid");
    if requested < current {
        return Err(AppError::InvalidState(
            "Нельзя вернуть мероприятие на предыдущий этап".into(),
            None,
        ));
    }
    if req.phase == "teachers" || req.phase == "students" {
        let audience = if req.phase == "teachers" {
            "teacher"
        } else {
            "student"
        };
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM form_questions WHERE event_id = ? AND audience = ?",
        )
        .bind(&organizer.event_id)
        .bind(audience)
        .fetch_one(&mut *tx)
        .await?;
        if count == 0 {
            return Err(AppError::InvalidState(
                "Сначала добавьте вопросы для этого этапа".into(),
                None,
            ));
        }
    }
    sqlx::query("UPDATE events SET workflow_phase = ?, updated_at = ? WHERE id = ?")
        .bind(&req.phase)
        .bind(now_ms())
        .bind(&organizer.event_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state.sse.notify(&organizer.event_id, ChangeKind::Status);
    Ok(Json(json!({ "phase": req.phase })))
}

async fn load_questions(state: &AppState, event_id: &str) -> AppResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT q.id, q.audience, q.prompt, o.id option_id, o.label option_label \
         FROM form_questions q JOIN form_options o ON o.question_id = q.id \
         WHERE q.event_id = ? ORDER BY q.audience, q.sort_order, q.rowid, o.sort_order, o.rowid",
    )
    .bind(event_id)
    .fetch_all(&state.pool)
    .await?;
    let mut questions: Vec<Value> = Vec::new();
    for row in rows {
        let id = row.get::<String, _>("id");
        if questions
            .last()
            .and_then(|question| question["id"].as_str())
            != Some(&id)
        {
            questions.push(json!({
                "id": id,
                "audience": row.get::<String, _>("audience"),
                "prompt": row.get::<String, _>("prompt"),
                "options": [],
            }));
        }
        questions
            .last_mut()
            .expect("question inserted")
            .get_mut("options")
            .and_then(Value::as_array_mut)
            .expect("options is array")
            .push(json!({
                "id": row.get::<String, _>("option_id"),
                "label": row.get::<String, _>("option_label"),
            }));
    }
    Ok(questions)
}

async fn save_team_draft(
    State(state): State<AppState>,
    session: EventSession,
    Json(req): Json<TeamDraftRequest>,
) -> AppResult<StatusCode> {
    if !matches!(session.user.role.as_str(), "teacher" | "student") {
        return Err(AppError::Forbidden(
            "Эта роль не может менять командный черновик",
        ));
    }
    let team_id = session
        .user
        .team_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidState("Участник не состоит в команде".into(), None))?;
    let expected_phase = if session.user.role == "teacher" {
        "teachers"
    } else {
        "students"
    };
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM form_questions q \
         JOIN form_options o ON o.question_id = q.id \
         JOIN events e ON e.id = q.event_id \
         WHERE q.id = ? AND o.id = ? AND q.event_id = ? AND q.audience = ? \
         AND e.workflow_phase = ?)",
    )
    .bind(&req.question_id)
    .bind(&req.option_id)
    .bind(&session.user.event_id)
    .bind(&session.user.role)
    .bind(expected_phase)
    .fetch_one(&state.pool)
    .await?;
    if !valid {
        return Err(AppError::InvalidState(
            "Этот ответ сейчас нельзя сохранить".into(),
            None,
        ));
    }
    let submitted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_form_submissions WHERE team_id = ? AND audience = ?)",
    )
    .bind(team_id)
    .bind(&session.user.role)
    .fetch_one(&state.pool)
    .await?;
    if submitted {
        return Err(AppError::Conflict("Командная форма уже отправлена".into()));
    }
    let teachers_submitted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_form_submissions WHERE team_id = ? AND audience = 'teacher')",
    ).bind(team_id).fetch_one(&state.pool).await?;
    if session.user.role == "student" && !teachers_submitted {
        return Err(AppError::InvalidState(
            "Сначала форму должны сдать все педагоги команды".into(),
            None,
        ));
    }
    sqlx::query(
        "INSERT INTO team_form_answers \
         (team_id, question_id, option_id, edited_by, updated_at) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(team_id, question_id) DO UPDATE SET \
         option_id = excluded.option_id, edited_by = excluded.edited_by, updated_at = excluded.updated_at",
    )
    .bind(team_id)
    .bind(&req.question_id)
    .bind(&req.option_id)
    .bind(&session.user.id)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    state
        .sse
        .notify(&session.user.event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}

async fn submit(
    State(state): State<AppState>,
    session: EventSession,
    Json(req): Json<SubmitRequest>,
) -> AppResult<StatusCode> {
    if !matches!(session.user.role.as_str(), "teacher" | "student") {
        return Err(AppError::Forbidden("Эта роль не сдаёт форму"));
    }
    let phase: String = sqlx::query_scalar("SELECT workflow_phase FROM events WHERE id = ?")
        .bind(&session.user.event_id)
        .fetch_one(&state.pool)
        .await?;
    let expected_phase = if session.user.role == "teacher" {
        "teachers"
    } else {
        "students"
    };
    if phase != expected_phase {
        return Err(AppError::InvalidState(
            "Ваш этап сейчас закрыт".into(),
            None,
        ));
    }
    let team_id = session
        .user
        .team_id
        .as_deref()
        .ok_or_else(|| AppError::InvalidState("Участник не состоит в команде".into(), None))?;
    if session.user.role == "student" {
        let teachers_submitted: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM team_form_submissions WHERE team_id = ? AND audience = 'teacher')",
        ).bind(team_id).fetch_one(&state.pool).await?;
        if !teachers_submitted {
            return Err(AppError::InvalidState(
                "Сначала форму должны сдать все педагоги вашей команды".into(),
                None,
            ));
        }
    }
    let questions = load_questions(&state, &session.user.event_id).await?;
    let relevant = questions
        .iter()
        .filter(|question| question["audience"] == session.user.role)
        .collect::<Vec<_>>();
    if relevant.is_empty() || req.answers.len() != relevant.len() {
        return Err(AppError::Validation("Ответьте на все вопросы".into()));
    }
    for question in &relevant {
        let question_id = question["id"].as_str().expect("question id");
        let answer = req
            .answers
            .iter()
            .find(|answer| answer.question_id == question_id)
            .ok_or_else(|| AppError::Validation("Ответьте на все вопросы".into()))?;
        let valid = question["options"]
            .as_array()
            .expect("options")
            .iter()
            .any(|option| option["id"] == answer.option_id);
        if !valid {
            return Err(AppError::Validation("Некорректный вариант ответа".into()));
        }
    }
    let mut tx = begin_write(&state.pool).await?;
    for answer in &req.answers {
        sqlx::query(
                "INSERT INTO team_form_answers \
                 (team_id, question_id, option_id, edited_by, updated_at) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(team_id, question_id) DO UPDATE SET \
                 option_id = excluded.option_id, edited_by = excluded.edited_by, updated_at = excluded.updated_at",
        )
            .bind(team_id)
            .bind(&answer.question_id)
            .bind(&answer.option_id)
            .bind(&session.user.id)
            .bind(now_ms())
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
            "INSERT INTO team_form_submissions (team_id, audience, submitted_by, submitted_at) VALUES (?, ?, ?, ?)",
    )
        .bind(team_id)
        .bind(&session.user.role)
        .bind(&session.user.id)
        .bind(now_ms())
        .execute(&mut *tx)
        .await
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                AppError::Conflict("Командная форма уже отправлена".into())
            } else {
                error.into()
            }
        })?;
    tx.commit().await?;
    state
        .sse
        .notify(&session.user.event_id, ChangeKind::Composition);
    Ok(StatusCode::NO_CONTENT)
}
