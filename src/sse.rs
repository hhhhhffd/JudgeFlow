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
}

const ALL_KINDS: [ChangeKind; 6] = [
    ChangeKind::Scores,
    ChangeKind::Status,
    ChangeKind::Event,
    ChangeKind::Composition,
    ChangeKind::Alert,
    ChangeKind::Judges,
];

/// One lazily created broadcast channel per event.
#[derive(Clone)]
pub struct SseHub {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<ChangeKind>>>>,
    shutdown: watch::Sender<bool>,
}

impl Default for SseHub {
    fn default() -> Self {
        Self {
            channels: Arc::default(),
            shutdown: watch::channel(false).0,
        }
    }
}

impl SseHub {
    /// Tells everyone subscribed to `event_id` that something of `kind` changed.
    pub fn notify(&self, event_id: &str, kind: ChangeKind) {
        let mut channels = self.channels.lock().expect("sse hub mutex poisoned");
        if let Some(sender) = channels.get(event_id) {
            // Err means nobody listens any more: drop the channel.
            if sender.send(kind).is_err() {
                channels.remove(event_id);
            }
        }
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
            .map(|kind| {
                let data = serde_json::json!({ "kind": kind }).to_string();
                Ok(Event::default().event("change").data(data))
            })
            .take_until(async move {
                let _ = shutdown.wait_for(|stopped| *stopped).await;
            });
        Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
    }
}
