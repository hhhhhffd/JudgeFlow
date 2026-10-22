use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::response::sse::{Event, KeepAlive, Sse};
use futures::Stream;
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::{broadcast, watch};
use tokio_stream::wrappers::BroadcastStream;

const CHANNEL_CAPACITY: usize = 64;
const KEEP_ALIVE: Duration = Duration::from_secs(15);

/// What changed. Messages are invalidation hints: clients refetch the relevant endpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Scores,
    Status,
    Event,
    Composition,
    Alert,
    Judges,
    /// Judge heartbeat only (last seen / pending count); judge clients ignore it.
    Presence,
    /// Stage Mode view, top N or reveal progress changed.
    Stage,
}

const ALL_KINDS: [ChangeKind; 8] = [
    ChangeKind::Scores,
    ChangeKind::Status,
    ChangeKind::Event,
    ChangeKind::Composition,
    ChangeKind::Alert,
    ChangeKind::Judges,
    ChangeKind::Presence,
    ChangeKind::Stage,
];

/// Counts open SSE streams per key (client IP, judge id) and in total, so one client cannot
/// exhaust file descriptors and memory with endless connections.
#[derive(Clone, Default)]
pub struct StreamLimiter {
    counts: Arc<Mutex<StreamCounts>>,
}

#[derive(Default)]
struct StreamCounts {
    per_key: HashMap<String, usize>,
    total: usize,
}

/// A held stream slot; dropping it (when the response stream is dropped) frees the slot.
pub struct StreamSlot {
    counts: Arc<Mutex<StreamCounts>>,
    key: String,
}

impl StreamLimiter {
    /// Takes a slot for `key`, or `None` when it already holds `per_key_max` streams or `total_max`
    /// streams are open overall.
    pub fn acquire(&self, key: &str, per_key_max: usize, total_max: usize) -> Option<StreamSlot> {
        let mut counts = self.counts.lock().expect("stream limiter mutex poisoned");
        if counts.total >= total_max || counts.per_key.get(key).is_some_and(|n| *n >= per_key_max) {
            return None;
        }
        counts.total += 1;
        *counts.per_key.entry(key.to_string()).or_default() += 1;
        Some(StreamSlot {
            counts: self.counts.clone(),
            key: key.to_string(),
        })
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().expect("stream limiter mutex poisoned");
        counts.total -= 1;
        if let Some(n) = counts.per_key.get_mut(&self.key) {
            *n -= 1;
            if *n == 0 {
                counts.per_key.remove(&self.key);
            }
        }
    }
}

/// One lazily created broadcast channel per event.
#[derive(Clone)]
pub struct SseHub {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<ChangeKind>>>>,
    /// Per-event counter bumped by every notification that can change public results. Caches of
    /// derived data compare it to detect staleness (works even with no SSE subscribers).
    versions: Arc<Mutex<HashMap<String, u64>>>,
    shutdown: watch::Sender<bool>,
}

impl Default for SseHub {
    fn default() -> Self {
        Self {
            channels: Arc::default(),
            versions: Arc::default(),
            shutdown: watch::channel(false).0,
        }
    }
}

impl SseHub {
    /// Tells everyone subscribed to `event_id` that something of `kind` changed.
    pub fn notify(&self, event_id: &str, kind: ChangeKind) {
        if !matches!(kind, ChangeKind::Presence | ChangeKind::Alert) {
            *self
                .versions
                .lock()
                .expect("sse hub mutex poisoned")
                .entry(event_id.to_string())
                .or_default() += 1;
        }
        let mut channels = self.channels.lock().expect("sse hub mutex poisoned");
        if let Some(sender) = channels.get(event_id) {
            // Err means nobody listens any more: drop the channel.
            if sender.send(kind).is_err() {
                channels.remove(event_id);
            }
        }
    }

    /// Counter of result-affecting changes (everything but presence and alert) of `event_id`.
    pub fn version(&self, event_id: &str) -> u64 {
        let versions = self.versions.lock().expect("sse hub mutex poisoned");
        versions.get(event_id).copied().unwrap_or(0)
    }

    pub fn subscribe(&self, event_id: &str) -> broadcast::Receiver<ChangeKind> {
        let mut channels = self.channels.lock().expect("sse hub mutex poisoned");
        channels
            .entry(event_id.to_string())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .subscribe()
    }

    /// Ends all open SSE responses so graceful shutdown does not wait for them.
    pub fn shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    /// SSE response for `event_id` with a 15 s keep-alive. Use it from the admin, public and judge
    /// stream handlers after they have authorized the request.
    pub fn stream(
        &self,
        event_id: &str,
    ) -> Sse<impl Stream<Item = Result<Event, Infallible>> + use<>> {
        self.stream_until(event_id, std::future::pending())
    }

    /// Like [`stream_until`](Self::stream_until), but only delivers hints of the `allowed` kinds
    /// (public viewers do not need judge presence or alerts).
    pub fn stream_filtered<F>(
        &self,
        event_id: &str,
        allowed: &'static [ChangeKind],
        stop: F,
    ) -> Sse<impl Stream<Item = Result<Event, Infallible>> + use<F>>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.stream_inner(event_id, allowed, stop)
    }

    /// Like [`stream`](Self::stream), but also ends the response once `stop` completes.
    pub fn stream_until<F>(
        &self,
        event_id: &str,
        stop: F,
    ) -> Sse<impl Stream<Item = Result<Event, Infallible>> + use<F>>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.stream_inner(event_id, &ALL_KINDS, stop)
    }

    fn stream_inner<F>(
        &self,
        event_id: &str,
        allowed: &'static [ChangeKind],
        stop: F,
    ) -> Sse<impl Stream<Item = Result<Event, Infallible>> + use<F>>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let receiver = self.subscribe(event_id);
        let mut shutdown = self.shutdown.subscribe();
        let stream = BroadcastStream::new(receiver)
            .flat_map(|message| {
                // A lagged receiver missed hints: invalidate everything.
                let kinds: Vec<ChangeKind> = match message {
                    Ok(kind) => vec![kind],
                    Err(_) => ALL_KINDS.to_vec(),
                };
                futures::stream::iter(kinds)
            })
            .filter(move |kind| std::future::ready(allowed.contains(kind)))
            .map(|kind| {
                let data = serde_json::json!({ "kind": kind }).to_string();
                Ok(Event::default().event("change").data(data))
            })
            .take_until(async move {
                tokio::select! {
                    _ = shutdown.wait_for(|stopped| *stopped) => {}
                    () = stop => {}
                }
            });
        Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use futures::StreamExt;

    #[tokio::test]
    async fn filtered_stream_skips_kinds_that_are_not_allowed() {
        let hub = SseHub::default();
        let response = hub
            .stream_filtered("e", &[ChangeKind::Scores], std::future::pending())
            .into_response();
        hub.notify("e", ChangeKind::Presence);
        hub.notify("e", ChangeKind::Alert);
        hub.notify("e", ChangeKind::Scores);
        let mut body = response.into_body().into_data_stream();
        let chunk = tokio::time::timeout(Duration::from_secs(2), body.next())
            .await
            .expect("an event arrives")
            .expect("stream is open")
            .expect("chunk");
        let text = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(text.contains("\"scores\""), "{text}");
        assert!(
            !text.contains("presence") && !text.contains("alert"),
            "{text}"
        );
    }

    #[test]
    fn stream_limiter_caps_per_key_and_total_and_releases_on_drop() {
        let limiter = StreamLimiter::default();
        let a1 = limiter.acquire("a", 2, 3).expect("first slot");
        let _a2 = limiter.acquire("a", 2, 3).expect("second slot");
        assert!(limiter.acquire("a", 2, 3).is_none(), "per-key cap");
        let _b1 = limiter.acquire("b", 2, 3).expect("other key");
        assert!(limiter.acquire("c", 2, 3).is_none(), "total cap");
        drop(a1);
        assert!(limiter.acquire("c", 2, 3).is_some(), "slot released");
    }
}
