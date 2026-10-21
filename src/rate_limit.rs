use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const CLEANUP_THRESHOLD: usize = 10_000;

/// Tiny in-memory fixed-window rate limiter keyed by an arbitrary string.
#[derive(Clone, Default)]
pub struct RateLimiter {
    windows: Arc<Mutex<HashMap<String, Window>>>,
}

struct Window {
    started: Instant,
    count: u32,
}

impl RateLimiter {
    /// Registers one attempt for `key`; returns `false` when more than `limit` attempts
    /// were made within the current `window`.
    pub fn allow(&self, key: &str, limit: u32, window: Duration) -> bool {
        let now = Instant::now();
        let mut windows = self.windows.lock().expect("rate limiter mutex poisoned");
        if windows.len() > CLEANUP_THRESHOLD {
            windows.retain(|_, w| now.duration_since(w.started) < window);
        }
        let entry = windows.entry(key.to_string()).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(entry.started) >= window {
            entry.started = now;
            entry.count = 0;
        }
        entry.count += 1;
        entry.count <= limit
    }
}
