use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Config;
use crate::crypto::{self, Crypto};
use crate::rate_limit::RateLimiter;
use crate::sse::SseHub;

/// Shared application state; cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    pub crypto: Crypto,
    pub sse: SseHub,
    pub rate_limiter: RateLimiter,
    /// Random password for `/api/setup/first-start/begin`; only valid while no admin exists.
    pub setup_password: Arc<str>,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Config, crypto: Crypto) -> Self {
        Self {
            pool,
            config: Arc::new(config),
            crypto,
            sse: SseHub::default(),
            rate_limiter: RateLimiter::default(),
            setup_password: crypto::random_token().into(),
        }
    }

    /// State backed by a throwaway database in a fresh temp directory, for integration tests.
    #[doc(hidden)]
    pub async fn for_tests() -> Self {
        let data_dir =
            std::env::temp_dir().join(format!("judgeflow-test-{}", crate::util::new_id()));
        let config = Config {
            addr: "127.0.0.1:0".parse().expect("valid socket address"),
            data_dir: data_dir.clone(),
            public_url: Some("http://localhost:8080".into()),
            secret_key: Some("test-secret-key".into()),
            trust_proxy: false,
        };
        let pool = crate::db::connect(&data_dir).await.expect("test database");
        let crypto = Crypto::from_material(b"test-secret-key");
        Self::new(pool, config, crypto)
    }
}
