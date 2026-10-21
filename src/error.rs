use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

/// API error. Renders as `{ "error": <code>, "message": <Russian text>, "details"?: any }` (SPEC section 2).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 401 `unauthorized`: no or invalid session / judge token.
    #[error("unauthorized")]
    Unauthorized,
    /// 401 `unauthorized` with a specific message (wrong login code, wrong setup password).
    #[error("bad credentials")]
    BadCredentials(&'static str),
    /// 403 `forbidden`.
    #[error("forbidden")]
    Forbidden(&'static str),
    /// 404 `not_found`.
    #[error("not found")]
    NotFound,
    /// 400 `validation`.
    #[error("validation: {0}")]
    Validation(String),
    /// 409 `conflict`: uniqueness and similar clashes.
    #[error("conflict: {0}")]
    Conflict(String),
    /// 409 `invalid_state`: operation not allowed in the current state; `details` is optional context.
    #[error("invalid state: {0}")]
    InvalidState(String, Option<Value>),
    /// 429 `rate_limited`.
    #[error("rate limited")]
    RateLimited,
    /// 500 `internal`: logged, never shown to the client.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Internal(err.into())
    }
}

impl AppError {
    fn parts(&self) -> (StatusCode, &'static str, String, Option<Value>) {
        match self {
            AppError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Требуется вход".into(),
                None,
            ),
            AppError::BadCredentials(msg) => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                (*msg).into(),
                None,
            ),
            AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, "forbidden", (*msg).into(), None),
            AppError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "Не найдено".into(),
                None,
            ),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, "validation", msg.clone(), None),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, "conflict", msg.clone(), None),
            AppError::InvalidState(msg, details) => (
                StatusCode::CONFLICT,
                "invalid_state",
                msg.clone(),
                details.clone(),
            ),
            AppError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "Слишком много попыток, попробуйте позже".into(),
                None,
            ),
            AppError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "Внутренняя ошибка сервера".into(),
                None,
            ),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if let AppError::Internal(err) = &self {
            tracing::error!(error = ?err, "internal error");
        }
        let (status, code, message, details) = self.parts();
        let mut body = json!({ "error": code, "message": message });
        if let Some(details) = details {
            body["details"] = details;
        }
        (status, Json(body)).into_response()
    }
}
