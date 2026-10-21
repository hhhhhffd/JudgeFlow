use std::net::SocketAddr;

use anyhow::{Context, Result};
use tokio::signal;

use crate::config::Config;
use crate::crypto::Crypto;
use crate::routes::setup::admin_exists;
use crate::state::AppState;
use crate::{build_app, db};

/// Opens the database and crypto key from `config` (shared by `serve` and the admin CLI).
pub async fn open_state(config: Config) -> Result<AppState> {
    let pool = db::connect(&config.data_dir).await?;
    let crypto = Crypto::load(&config.data_dir, config.secret_key.as_deref())?;
    Ok(AppState::new(pool, config, crypto))
}

pub async fn serve(config: Config) -> Result<()> {
    let state = open_state(config).await?;
    if !admin_exists(&state.pool)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        let base = state
            .config
            .public_url
            .clone()
            .unwrap_or_else(|| format!("http://{}", state.config.addr));
        tracing::warn!("==================================================================");
        tracing::warn!("No administrator exists yet. First-start setup is open.");
        tracing::warn!(
            "Open {}/firststart and enter this setup password:",
            base.trim_end_matches('/')
        );
        tracing::warn!("    {}", state.setup_password);
        tracing::warn!("(a new password is generated on every start until an admin exists)");
        tracing::warn!("==================================================================");
    }

    let listener = tokio::net::TcpListener::bind(state.config.addr)
        .await
        .with_context(|| format!("binding {}", state.config.addr))?;
    tracing::info!(addr = %state.config.addr, "listening");

    let sse = state.sse.clone();
    let app = build_app(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        tracing::info!("shutting down");
        // Open SSE streams would otherwise keep graceful shutdown waiting forever.
        sse.shutdown();
    })
    .await
    .context("server error")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("installing Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("installing SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
