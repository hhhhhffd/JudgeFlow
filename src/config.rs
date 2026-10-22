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

    /// Where the client IP (rate limiting) comes from: `none` (peer address), `cloudflare`
    /// (`CF-Connecting-IP`) or `xff` (rightmost `X-Forwarded-For` entry). Use the proxy modes only
    /// behind a proxy or tunnel that sets the header; otherwise clients could spoof their IP.
    #[arg(
        long,
        global = true,
        env = "JUDGEFLOW_TRUST_PROXY",
        value_enum,
        default_value = "none"
    )]
    pub trust_proxy: TrustProxy,
}

/// Which proxy header, if any, is trusted for the client IP and the original scheme.
#[derive(clap::ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrustProxy {
    /// No proxy: the peer address is the client IP.
    #[value(name = "none", alias = "false")]
    None,
    /// Cloudflare (Tunnel): `CF-Connecting-IP`.
    Cloudflare,
    /// Generic reverse proxy: the rightmost `X-Forwarded-For` entry.
    Xff,
}

impl Config {
    /// Cookies get the `Secure` attribute when the public URL is https, or when a trusted proxy
    /// reports the request as https via `X-Forwarded-Proto`.
    pub fn secure_cookies(&self, headers: &HeaderMap) -> bool {
        let public_https = self
            .public_url
            .as_deref()
            .is_some_and(|url| url.starts_with("https"));
        let proxied_https = self.trust_proxy != TrustProxy::None
            && headers
                .get("x-forwarded-proto")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("https"));
        public_https || proxied_https
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
