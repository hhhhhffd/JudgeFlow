use std::net::SocketAddr;
use std::path::PathBuf;

use axum::http::{HeaderMap, header};

/// Runtime configuration (SPEC section 1). Every field can come from the environment or a CLI flag.
#[derive(clap::Args, Clone, Debug)]
pub struct Config {
    /// Listen address.
    #[arg(
        long,
        global = true,
        env = "JUDGEFLOW_ADDR",
        default_value = "0.0.0.0:8080"
    )]
    pub addr: SocketAddr,

    /// Directory for the database, uploads and `secret.key`.
    #[arg(
        long,
        global = true,
        env = "JUDGEFLOW_DATA_DIR",
        default_value = "./data"
    )]
    pub data_dir: PathBuf,

    /// Base URL used in judge/invite links, e.g. https://judge.example.com.
    #[arg(long, global = true, env = "JUDGEFLOW_PUBLIC_URL")]
    pub public_url: Option<String>,

    /// Key material for encrypting TOTP secrets (default: auto-generated `DATA_DIR/secret.key`).
    #[arg(
        long,
        global = true,
        env = "JUDGEFLOW_SECRET_KEY",
        hide_env_values = true
    )]
    pub secret_key: Option<String>,
}

impl Config {
    /// Cookies get the `Secure` attribute only when the public URL is https.
    pub fn secure_cookies(&self) -> bool {
        self.public_url
            .as_deref()
            .is_some_and(|url| url.starts_with("https"))
    }

    /// Base URL for links: `PUBLIC_URL`, else built from the request `Host` and `X-Forwarded-Proto`.
    pub fn base_url(&self, headers: &HeaderMap) -> String {
        if let Some(url) = self.public_url.as_deref().filter(|u| !u.is_empty()) {
            return url.trim_end_matches('/').to_string();
        }
        let header_str = |name| headers.get(name).and_then(|v| v.to_str().ok());
        let scheme = header_str("x-forwarded-proto")
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| matches!(*v, "http" | "https"))
            .unwrap_or("http");
        let host = header_str(header::HOST.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| self.addr.to_string());
        format!("{scheme}://{host}")
    }
}
