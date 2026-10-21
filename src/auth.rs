//! Authentication building blocks: admin sessions (cookie), judge tokens (Bearer), extractors.

use std::net::SocketAddr;
use std::ops::Deref;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::HeaderMap;
use axum::http::header::{AUTHORIZATION, COOKIE};
use axum::http::request::Parts;
use serde::Serialize;
use serde_json::json;
use sqlx::SqliteConnection;

use crate::audit;
use crate::config::Config;
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::totp;
use crate::util::now_ms;

pub const SESSION_COOKIE: &str = "jf_session";
pub const SESSION_TTL_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const NAME_MAX_CHARS: usize = 64;

/// The `admin` object of the API (SPEC section 8).
#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
pub struct Admin {
    pub id: String,
    pub name: String,
    pub role: String,
    pub created_at: i64,
}

impl Admin {
    pub fn is_owner(&self) -> bool {
        self.role == "owner"
    }
}

/// Trims and validates a human name (admin name).
pub fn clean_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.chars().count() > NAME_MAX_CHARS
        || name.chars().any(char::is_control)
    {
        return Err(AppError::Validation(format!(
            "Имя должно быть от 1 до {NAME_MAX_CHARS} символов без управляющих символов"
        )));
    }
    Ok(name.to_string())
}

/// Creates a session for `admin_id` and returns the raw token (only its hash is stored).
pub async fn create_session(conn: &mut SqliteConnection, admin_id: &str) -> AppResult<String> {
    let token = random_token();
    let now = now_ms();
    sqlx::query("DELETE FROM sessions WHERE expires_at < ?")
        .bind(now)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO sessions (token_hash, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(admin_id)
    .bind(now)
    .bind(now + SESSION_TTL_MS)
    .execute(conn)
    .await?;
    Ok(token)
}

/// `Set-Cookie` value that installs the session cookie.
pub fn session_cookie(config: &Config, token: &str) -> String {
    let secure = if config.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}",
        SESSION_TTL_MS / 1000
    )
}

/// `Set-Cookie` value that removes the session cookie.
pub fn clear_session_cookie(config: &Config) -> String {
    let secure = if config.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}")
}

/// Raw session token from the `Cookie` header(s), if any.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == SESSION_COOKIE && !value.is_empty()).then(|| value.to_string())
        })
}

/// Extractor for admin endpoints: valid, unexpired `jf_session` cookie. Else 401.
pub struct AdminSession {
    pub admin: Admin,
    pub token_hash: String,
}

impl FromRequestParts<AppState> for AdminSession {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let token = session_token(&parts.headers).ok_or(AppError::Unauthorized)?;
        let token_hash = hash_token(&token);
        let admin = sqlx::query_as::<_, Admin>(
            "SELECT a.id, a.name, a.role, a.created_at FROM sessions s \
             JOIN admins a ON a.id = s.admin_id \
             WHERE s.token_hash = ? AND s.expires_at > ?",
        )
        .bind(&token_hash)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::Unauthorized)?;
        Ok(Self { admin, token_hash })
    }
}

/// Like [`AdminSession`] but only for the owner. Else 403. Derefs to [`AdminSession`].
pub struct OwnerSession(pub AdminSession);

impl Deref for OwnerSession {
    type Target = AdminSession;
    fn deref(&self) -> &AdminSession {
        &self.0
    }
}

impl FromRequestParts<AppState> for OwnerSession {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let session = AdminSession::from_request_parts(parts, state).await?;
        if !session.admin.is_owner() {
            return Err(AppError::Forbidden("Только владелец может это делать"));
        }
        Ok(Self(session))
    }
}

/// Extractor for judge endpoints: `Authorization: Bearer <token>` of an active judge. Else 401.
#[derive(Clone, Debug)]
pub struct JudgeAuth {
    pub judge_id: String,
    pub event_id: String,
    pub name: String,
    pub submitted_at: Option<i64>,
}

impl FromRequestParts<AppState> for JudgeAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let (scheme, token) = header.split_once(' ').ok_or(AppError::Unauthorized)?;
        if !scheme.eq_ignore_ascii_case("bearer") || token.trim().is_empty() {
            return Err(AppError::Unauthorized);
        }
        let row: Option<(String, String, String, Option<i64>)> = sqlx::query_as(
            "SELECT id, event_id, name, submitted_at FROM judges \
             WHERE token_hash = ? AND is_active = 1",
        )
        .bind(hash_token(token.trim()))
        .fetch_optional(&state.pool)
        .await?;
        let (judge_id, event_id, name, submitted_at) = row.ok_or(AppError::Unauthorized)?;
        Ok(Self {
            judge_id,
            event_id,
            name,
            submitted_at,
        })
    }
}

/// Client IP for rate limiting (peer address; behind a reverse proxy this is the proxy's).
pub struct ClientIp(pub String);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &AppState) -> Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        Ok(Self(ip))
    }
}

/// Generates a new TOTP secret for `admin`, invalidates all their sessions, writes the audit entry.
/// `actor_id` is `None` when done from the CLI. Returns `(otpauth_uri, secret)`.
pub async fn reset_totp(
    state: &AppState,
    admin: &Admin,
    actor_id: Option<&str>,
) -> AppResult<(String, String)> {
    let fresh = totp::generate(&state.crypto, &admin.name)?;
    let mut tx = begin_write(&state.pool).await?;
    sqlx::query("UPDATE admins SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?")
        .bind(&fresh.encrypted)
        .bind(&admin.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE admin_id = ?")
        .bind(&admin.id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        None,
        actor_id,
        "admin.reset_totp",
        json!({ "admin_id": admin.id, "name": admin.name }),
    )
    .await?;
    tx.commit().await?;
    Ok((fresh.otpauth_uri, fresh.secret))
}
