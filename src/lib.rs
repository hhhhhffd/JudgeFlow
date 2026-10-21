pub mod audit;
pub mod auth;
pub mod cli;
pub mod config;
pub mod crypto;
pub mod db;
pub mod domain;
pub mod error;
pub mod ranking;
pub mod rate_limit;
pub mod routes;
pub mod server;
pub mod sse;
pub mod state;
pub mod static_files;
pub mod totp;
pub mod util;

use axum::Router;

use crate::state::AppState;

/// Builds the complete HTTP application (API + embedded frontend).
pub fn build_app(state: AppState) -> Router {
    routes::router(state)
}
