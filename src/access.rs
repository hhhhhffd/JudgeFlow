use argon2::password_hash::{SaltString, rand_core::OsRng};
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::http::HeaderMap;
use sqlx::SqliteConnection;

use crate::auth::{EVENT_SESSION_COOKIE, SESSION_TTL_MS};
use crate::config::Config;
use crate::crypto::{hash_token, random_token};
use crate::error::{AppError, AppResult};
use crate::util::now_ms;

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::Internal(anyhow::anyhow!(error.to_string())))
}

pub fn verify_password(password: &str, encoded: &str) -> bool {
    PasswordHash::new(encoded).ok().is_some_and(|hash| {
        Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok()
    })
}

pub fn generate_password() -> String {
    random_token().chars().take(12).collect()
}

pub async fn create_session(conn: &mut SqliteConnection, user_id: &str) -> AppResult<String> {
    let token = random_token();
    let now = now_ms();
    sqlx::query("DELETE FROM event_sessions WHERE expires_at < ?")
        .bind(now)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO event_sessions (token_hash, user_id, created_at, expires_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(now)
    .bind(now + SESSION_TTL_MS)
    .execute(conn)
    .await?;
    Ok(token)
}

pub fn session_cookie(config: &Config, headers: &HeaderMap, token: &str) -> String {
    let secure = if config.secure_cookies(headers) {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{EVENT_SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}",
        SESSION_TTL_MS / 1000
    )
}

pub fn clear_cookie(config: &Config, headers: &HeaderMap) -> String {
    let secure = if config.secure_cookies(headers) {
        "; Secure"
    } else {
        ""
    };
    format!("{EVENT_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0{secure}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_round_trip() {
        let hash = hash_password("personal-password").unwrap();
        assert!(verify_password("personal-password", &hash));
        assert!(!verify_password("wrong-password", &hash));
        assert!(!hash.contains("personal-password"));
    }
}
