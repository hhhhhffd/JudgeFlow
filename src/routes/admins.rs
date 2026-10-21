//! Admin management. Reading is open to any admin, mutations are owner-only.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::audit;
use crate::auth;
use crate::auth::{Admin, AdminSession, OwnerSession};
use crate::crypto::{hash_token, random_token};
use crate::db::begin_write;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::util::now_ms;

pub const INVITE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Invites are identified publicly by this many leading characters of their token hash.
const INVITE_ID_LEN: i64 = 16;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admins", get(list))
        .route("/admins/invites", get(list_invites).post(create_invite))
        .route("/admins/invites/{id}", delete(delete_invite))
        .route("/admins/{id}", delete(delete_admin))
        .route("/admins/{id}/reset-totp", post(reset_totp))
}

async fn list(_: AdminSession, State(state): State<AppState>) -> AppResult<Json<Vec<Admin>>> {
    let admins = sqlx::query_as::<_, Admin>(
        "SELECT id, name, role, created_at FROM admins ORDER BY created_at, name",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(admins))
}

async fn create_invite(
    owner: OwnerSession,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let token = random_token();
    let now = now_ms();
    let expires_at = now + INVITE_TTL_MS;
    let mut tx = begin_write(&state.pool).await?;
    sqlx::query("DELETE FROM enrollments WHERE kind = 'invite' AND expires_at < ?")
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO enrollments (token_hash, kind, created_by, created_at, expires_at) \
         VALUES (?, 'invite', ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(&owner.admin.id)
    .bind(now)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    audit::record(
        &mut *tx,
        None,
        Some(&owner.admin.id),
        "admin.invite_create",
        json!({}),
    )
    .await?;
    tx.commit().await?;

    let url = format!("{}/invite/{token}", state.config.base_url(&headers));
    Ok(Json(json!({ "url": url, "expires_at": expires_at })))
}

async fn list_invites(_: AdminSession, State(state): State<AppState>) -> AppResult<Json<Value>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT substr(token_hash, 1, ?), created_at, expires_at FROM enrollments \
         WHERE kind = 'invite' AND expires_at > ? ORDER BY created_at",
    )
    .bind(INVITE_ID_LEN)
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;
    let invites: Vec<Value> = rows
        .into_iter()
        .map(|(id, created_at, expires_at)| {
            json!({ "id": id, "created_at": created_at, "expires_at": expires_at })
        })
        .collect();
    Ok(Json(Value::Array(invites)))
}

async fn delete_invite(
    owner: OwnerSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let mut tx = begin_write(&state.pool).await?;
    let deleted = sqlx::query(
        "DELETE FROM enrollments WHERE kind = 'invite' AND substr(token_hash, 1, ?) = ?",
    )
    .bind(INVITE_ID_LEN)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(
        &mut *tx,
        None,
        Some(&owner.admin.id),
        "admin.invite_delete",
        json!({ "invite_id": id }),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn find_admin(state: &AppState, id: &str) -> AppResult<Admin> {
    sqlx::query_as::<_, Admin>("SELECT id, name, role, created_at FROM admins WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)
}

async fn delete_admin(
    owner: OwnerSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    let target = find_admin(&state, &id).await?;
    if target.id == owner.admin.id {
        return Err(AppError::Forbidden("Нельзя удалить самого себя"));
    }
    if target.is_owner() {
        return Err(AppError::Forbidden("Нельзя удалить владельца"));
    }
    let mut tx = begin_write(&state.pool).await?;
    // Sessions are removed by ON DELETE CASCADE.
    sqlx::query("DELETE FROM admins WHERE id = ?")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    audit::record(
        &mut *tx,
        None,
        Some(&owner.admin.id),
        "admin.delete",
        json!({ "admin_id": target.id, "name": target.name }),
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reset_totp(
    owner: OwnerSession,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let target = find_admin(&state, &id).await?;
    if target.is_owner() {
        return Err(AppError::Forbidden(
            "TOTP владельца сбрасывается только через CLI: judgeflow admin reset-totp",
        ));
    }
    let (otpauth_uri, secret) = auth::reset_totp(&state, &target, Some(&owner.admin.id)).await?;
    Ok(Json(
        json!({ "otpauth_uri": otpauth_uri, "secret": secret }),
    ))
}
