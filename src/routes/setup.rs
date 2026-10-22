//! First-start setup: creates the owner when no admin exists yet.

use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::auth::{self, Admin, ClientIp};
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::totp;
use crate::util::{new_id, now_ms};

const ENROLLMENT_TTL_MS: i64 = 30 * 60 * 1000;
const BEGIN_LIMIT_PER_MIN: u32 = 5;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup/first-start", get(status))
        .route("/setup/first-start/begin", post(begin))
        .route("/setup/first-start/complete", post(complete))
}

pub async fn admin_exists(pool: &sqlx::SqlitePool) -> AppResult<bool> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM admins)")
        .fetch_one(pool)
        .await?;
    Ok(exists)
}

async fn status(State(state): State<AppState>) -> AppResult<StatusCode> {
    if admin_exists(&state.pool).await? {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct BeginRequest {
    setup_password: String,
    name: String,
}

async fn begin(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Json(req): Json<BeginRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if admin_exists(&state.pool).await? {
        return Err(AppError::NotFound);
    }
    if !state.rate_limiter.allow(
        &format!("first-start:ip:{ip}"),
        BEGIN_LIMIT_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err(AppError::RateLimited);
    }
    // Compare digests so the comparison time does not depend on the matching prefix length.
    if Sha256::digest(req.setup_password.trim()) != Sha256::digest(state.setup_password.as_bytes())
    {
        return Err(AppError::BadCredentials("Неверный пароль установки"));
    }
    let name = auth::clean_name(&req.name)?;
    let fresh = totp::generate(&state.crypto, &name)?;
    let token = random_token();
    let now = now_ms();

    let mut tx = begin_write(&state.pool).await?;
    // Calling begin again replaces the previous attempt.
    sqlx::query("DELETE FROM enrollments WHERE kind = 'first_start'")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO enrollments (token_hash, kind, name, secret_enc, created_at, expires_at) \
         VALUES (?, 'first_start', ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(&name)
    .bind(&fresh.encrypted)
    .bind(now)
    .bind(now + ENROLLMENT_TTL_MS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(json!({
        "enrollment_token": token,
        "otpauth_uri": fresh.otpauth_uri,
        "secret": fresh.secret,
    })))
}

#[derive(Deserialize)]
struct CompleteRequest {
    enrollment_token: String,
    code: String,
}

async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CompleteRequest>,
) -> AppResult<impl IntoResponse> {
    let token_hash = hash_token(&req.enrollment_token);
    let mut tx = begin_write(&state.pool).await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM admins)")
        .fetch_one(&mut *tx)
        .await?;
    if exists {
        return Err(AppError::NotFound);
    }
    let enrollment: Option<(Option<String>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT name, secret_enc FROM enrollments \
         WHERE token_hash = ? AND kind = 'first_start' AND expires_at > ?",
    )
    .bind(&token_hash)
    .bind(now_ms())
    .fetch_optional(&mut *tx)
    .await?;
    let (Some(name), Some(secret_enc)) = enrollment.ok_or(AppError::NotFound)? else {
        return Err(AppError::NotFound);
    };
    let step = totp::check_code(&state.crypto, &secret_enc, &name, &req.code)?
        .ok_or(AppError::BadCredentials("Неверный код"))?;

    let admin = Admin {
        id: new_id(),
        name,
        role: "owner".into(),
        created_at: now_ms(),
    };
    // The enrolment code counts as used so it cannot be replayed to log in right away.
    sqlx::query(
        "INSERT INTO admins (id, name, role, totp_secret_enc, totp_last_step, created_at) \
         VALUES (?, ?, 'owner', ?, ?, ?)",
    )
    .bind(&admin.id)
    .bind(&admin.name)
    .bind(&secret_enc)
    .bind(step as i64)
    .bind(admin.created_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM enrollments WHERE kind = 'first_start'")
        .execute(&mut *tx)
        .await?;
    let session = auth::create_session(&mut tx, &admin.id).await?;
    crate::audit::record(
        &mut *tx,
        None,
        Some(&admin.id),
        "admin.create_owner",
        json!({ "admin_id": admin.id, "name": admin.name }),
    )
    .await?;
    tx.commit().await?;

    let cookie = auth::session_cookie(&state.config, &headers, &session);
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "admin": admin })),
    ))
}
