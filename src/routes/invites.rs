//! Public invite flow: an admin invited by the owner enrolls their own TOTP device.

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use crate::audit;
use crate::auth::{self, Admin, ClientIp};
use crate::crypto::hash_token;
use crate::db::begin_write;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::totp;
use crate::util::{new_id, now_ms};

const BEGIN_LIMIT_PER_MIN: u32 = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invites/{token}", get(status))
        .route("/invites/{token}/begin", post(begin))
        .route("/invites/{token}/complete", post(complete))
}

#[derive(sqlx::FromRow)]
struct Invite {
    created_by: Option<String>,
    name: Option<String>,
    secret_enc: Option<Vec<u8>>,
    expires_at: i64,
}

/// Loads an unexpired invite or fails with 404.
async fn load_invite(conn: &mut SqliteConnection, token: &str) -> AppResult<Invite> {
    sqlx::query_as::<_, Invite>(
        "SELECT created_by, name, secret_enc, expires_at FROM enrollments \
         WHERE token_hash = ? AND kind = 'invite' AND expires_at > ?",
    )
    .bind(hash_token(token))
    .bind(now_ms())
    .fetch_optional(conn)
    .await?
    .ok_or(AppError::NotFound)
}

async fn status(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> AppResult<Json<Value>> {
    let mut conn = state.pool.acquire().await?;
    let invite = load_invite(&mut conn, &token).await?;
    Ok(Json(json!({ "expires_at": invite.expires_at })))
}

#[derive(Deserialize)]
struct BeginRequest {
    name: String,
}

async fn begin(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    Path(token): Path<String>,
    Json(req): Json<BeginRequest>,
) -> AppResult<Json<Value>> {
    if !state.rate_limiter.allow(
        &format!("invite:ip:{ip}"),
        BEGIN_LIMIT_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err(AppError::RateLimited);
    }
    let name = auth::clean_name(&req.name)?;
    let fresh = totp::generate(&state.crypto, &name)?;

    let mut tx = begin_write(&state.pool).await?;
    load_invite(&mut tx, &token).await?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM admins WHERE name = ?)")
        .bind(&name)
        .fetch_one(&mut *tx)
        .await?;
    if taken {
        return Err(AppError::Conflict("Это имя уже занято".into()));
    }
    // Calling begin again regenerates the secret.
    sqlx::query("UPDATE enrollments SET name = ?, secret_enc = ? WHERE token_hash = ?")
        .bind(&name)
        .bind(&fresh.encrypted)
        .bind(hash_token(&token))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(
        json!({ "otpauth_uri": fresh.otpauth_uri, "secret": fresh.secret }),
    ))
}

#[derive(Deserialize)]
struct CompleteRequest {
    code: String,
}

async fn complete(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(req): Json<CompleteRequest>,
) -> AppResult<impl IntoResponse> {
    let mut tx = begin_write(&state.pool).await?;
    let invite = load_invite(&mut tx, &token).await?;
    let (Some(name), Some(secret_enc)) = (invite.name, invite.secret_enc) else {
        return Err(AppError::InvalidState(
            "Сначала введите имя и отсканируйте QR-код".into(),
            None,
        ));
    };
    let step = totp::check_code(&state.crypto, &secret_enc, &name, &req.code)?
        .ok_or(AppError::BadCredentials("Неверный код"))?;

    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM admins WHERE name = ?)")
        .bind(&name)
        .fetch_one(&mut *tx)
        .await?;
    if taken {
        return Err(AppError::Conflict("Это имя уже занято".into()));
    }
    let admin = Admin {
        id: new_id(),
        name,
        role: "admin".into(),
        created_at: now_ms(),
    };
    sqlx::query(
        "INSERT INTO admins (id, name, role, totp_secret_enc, totp_last_step, created_at) \
         VALUES (?, ?, 'admin', ?, ?, ?)",
    )
    .bind(&admin.id)
    .bind(&admin.name)
    .bind(&secret_enc)
    .bind(step as i64)
    .bind(admin.created_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM enrollments WHERE token_hash = ?")
        .bind(hash_token(&token))
        .execute(&mut *tx)
        .await?;
    let session = auth::create_session(&mut tx, &admin.id).await?;
    audit::record(
        &mut *tx,
        None,
        invite.created_by.as_deref(),
        "admin.create",
        json!({ "admin_id": admin.id, "name": admin.name }),
    )
    .await?;
    tx.commit().await?;

    let cookie = auth::session_cookie(&state.config, &session);
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(json!({ "admin": admin })),
    ))
}
