//! Admin login (name + TOTP), logout, current admin.

use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::{self, Admin, AdminSession, ClientIp};
use crate::crypto::hash_token;
use crate::db::begin_write;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::totp;

const LOGIN_LIMIT_PER_NAME: u32 = 5;
const LOGIN_LIMIT_PER_IP: u32 = 20;
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const BAD_LOGIN: &str = "Неверное имя или код";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    #[sqlx(flatten)]
    admin: Admin,
    totp_secret_enc: Vec<u8>,
    totp_last_step: Option<i64>,
}

#[derive(Deserialize)]
struct LoginRequest {
    name: String,
    code: String,
}

async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let name = req.name.trim();
    if !state
        .rate_limiter
        .allow(&format!("login:ip:{ip}"), LOGIN_LIMIT_PER_IP, LOGIN_WINDOW)
        || !state.rate_limiter.allow(
            &format!("login:name:{}", name.to_lowercase()),
            LOGIN_LIMIT_PER_NAME,
            LOGIN_WINDOW,
        )
    {
        return Err(AppError::RateLimited);
    }

    // The write lock is held from the replay check until the step is stored, so two concurrent
    // logins with the same code cannot both succeed.
    let mut tx = begin_write(&state.pool).await?;
    let row = sqlx::query_as::<_, LoginRow>(
        "SELECT id, name, role, created_at, totp_secret_enc, totp_last_step \
         FROM admins WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(AppError::BadCredentials(BAD_LOGIN))?;
    let LoginRow {
        admin,
        totp_secret_enc,
        totp_last_step,
    } = row;
    let step = totp::check_code(&state.crypto, &totp_secret_enc, &admin.name, &req.code)?
        .and_then(|step| i64::try_from(step).ok())
        .filter(|step| totp_last_step.is_none_or(|last| *step > last))
        .ok_or(AppError::BadCredentials(BAD_LOGIN))?;
    let stored = sqlx::query(
        "UPDATE admins SET totp_last_step = ? \
         WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
    )
    .bind(step)
    .bind(&admin.id)
    .bind(step)
    .execute(&mut *tx)
    .await?;
    if stored.rows_affected() != 1 {
        return Err(AppError::BadCredentials(BAD_LOGIN));
    }
    let session = auth::create_session(&mut tx, &admin.id).await?;
    tx.commit().await?;

    let cookie = auth::session_cookie(&state.config, &session);
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "admin": admin })),
    ))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<impl IntoResponse> {
    if let Some(token) = auth::session_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(&token))
            .execute(&state.pool)
            .await?;
    }
    let cookie = auth::clear_session_cookie(&state.config);
    Ok(([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT))
}

async fn me(session: AdminSession) -> Json<serde_json::Value> {
    Json(json!({ "admin": session.admin }))
}
