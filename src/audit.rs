use serde_json::Value;
use sqlx::{Executor, Sqlite};

use crate::error::AppResult;
use crate::util::now_ms;

/// Appends an `audit_log` row. `event_id` is `None` for admin-management actions.
/// Pass `&mut *tx` to make the entry part of the caller's transaction.
pub async fn record<'e, E>(
    db: E,
    event_id: Option<&str>,
    admin_id: Option<&str>,
    action: &str,
    details: Value,
) -> AppResult<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO audit_log (event_id, admin_id, action, details, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(event_id)
    .bind(admin_id)
    .bind(action)
    .bind(details.to_string())
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}
