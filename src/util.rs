use std::time::{SystemTime, UNIX_EPOCH};

/// Current Unix time in milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the Unix epoch")
        .as_millis() as i64
}

/// New UUID v4 string, used for all entity ids.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
