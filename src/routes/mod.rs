//! Router assembly. Each submodule exposes `pub fn router() -> Router<AppState>` with its
//! absolute `/api/...` paths removed of the `/api` prefix (it is added by `nest` below).

use std::time::Instant;

use axum::Router;
use axum::extract::Request;
use axum::middleware::{self, Next};
use axum::response::Response;

use crate::error::AppError;
use crate::state::AppState;
use crate::static_files;

pub mod admins;
pub mod assignments;
pub mod auth;
pub mod criteria;
pub mod events;
pub mod invites;
pub mod judge;
pub mod judges;
pub mod public;
pub mod rounds;
pub mod setup;
pub mod teams;
pub mod tracks;

/// Full application: `/api/**` JSON API, everything else embedded static files (SPA).
pub fn router(state: AppState) -> Router {
    Router::new()
        .nest("/api", api())
        .fallback(static_files::handler)
        .layer(middleware::from_fn(log_requests))
        .with_state(state)
}

/// All API routes. New feature modules (events, judge, public, ...) are added with `.merge(...)`.
fn api() -> Router<AppState> {
    Router::new()
        .merge(setup::router())
        .merge(auth::router())
        .merge(admins::router())
        .merge(invites::router())
        .merge(events::router())
        .merge(rounds::router())
        .merge(teams::router())
        .merge(tracks::router())
        .merge(assignments::router())
        .merge(criteria::router())
        .merge(judges::router())
        .merge(judge::router())
        .merge(public::router())
        .fallback(api_not_found)
}

async fn api_not_found() -> AppError {
    AppError::NotFound
}

async fn log_requests(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = redact_path(request.uri().path());
    let started = Instant::now();
    let response = next.run(request).await;
    tracing::info!(
        %method,
        %path,
        status = response.status().as_u16(),
        elapsed_ms = started.elapsed().as_millis() as u64,
        "request"
    );
    response
}

/// Replaces the secret token segment of `/j/<token>`, `/invite/<token>` and
/// `/api/invites/<token>/...` so tokens never reach the logs.
fn redact_path(path: &str) -> String {
    let mut segments: Vec<&str> = path.split('/').collect();
    // segments[0] is the empty string before the leading slash.
    let token_index = match segments.as_slice() {
        ["", "j" | "invite", _, ..] => Some(2),
        ["", "api", "invites", _, ..] => Some(3),
        _ => None,
    };
    if let Some(index) = token_index {
        segments[index] = "***";
    }
    segments.join("/")
}

#[cfg(test)]
mod tests {
    use super::redact_path;

    #[test]
    fn redacts_token_segments_only() {
        assert_eq!(redact_path("/j/secret123"), "/j/***");
        assert_eq!(redact_path("/invite/secret123"), "/invite/***");
        assert_eq!(
            redact_path("/api/invites/secret123/accept"),
            "/api/invites/***/accept"
        );
        assert_eq!(redact_path("/api/invites"), "/api/invites");
        assert_eq!(
            redact_path("/api/events/abc/stream"),
            "/api/events/abc/stream"
        );
        assert_eq!(redact_path("/"), "/");
    }
}
