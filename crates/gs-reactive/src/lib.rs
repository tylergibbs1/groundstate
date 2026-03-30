mod observation_loop;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::sync::Arc;

use gs_execute::SessionState;
use gs_graph::{GraphDiff, StateGraph};
use gs_observe::Observer;
use gs_transport::BrowserTransport;
use gs_types::{Action, StableKey};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast, oneshot};

/// Configuration for the continuous observation loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactiveConfig {
    /// Minimum debounce interval between re-observations (ms).
    #[serde(default = "default_debounce_ms")]
    pub debounce_ms: u64,
    /// Maximum time to wait before forcing a re-observation after a mutation (ms).
    #[serde(default = "default_max_debounce_ms")]
    pub max_debounce_ms: u64,
    /// Whether to re-observe on navigation events.
    #[serde(default = "default_true")]
    pub observe_on_navigate: bool,
}

fn default_debounce_ms() -> u64 {
    300
}
fn default_max_debounce_ms() -> u64 {
    2000
}
fn default_true() -> bool {
    true
}

impl Default for ReactiveConfig {
    fn default() -> Self {
        Self {
            debounce_ms: default_debounce_ms(),
            max_debounce_ms: default_max_debounce_ms(),
            observe_on_navigate: true,
        }
    }
}

/// A reactive diff that includes both graph changes and derived actions.
/// This is what gets broadcast to subscribers.
#[derive(Debug, Clone, Serialize)]
pub struct ReactiveDiff {
    /// The underlying graph diff (upserted, invalidated, removed entities).
    #[serde(flatten)]
    pub graph: GraphDiff,
    /// Actions derived for the changed entities.
    pub actions: Vec<Action>,
}

/// Controls the continuous observation loop.
///
/// Starts a background task that listens for DOM mutations, debounces them,
/// re-observes the page, re-extracts entities, and pushes diffs to subscribers.
pub struct ReactiveController {
    cancel_tx: Option<oneshot::Sender<()>>,
    diff_tx: broadcast::Sender<ReactiveDiff>,
}

impl ReactiveController {
    /// Start the continuous observation loop.
    ///
    /// Takes the shared `SessionState` (which owns graph and pipeline) and
    /// the shared transport. The loop acquires locks briefly for each
    /// observe-extract cycle.
    pub fn start(
        state: Arc<Mutex<SessionState>>,
        transport: Arc<Mutex<dyn BrowserTransport>>,
        config: ReactiveConfig,
    ) -> Self {
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (diff_tx, _) = broadcast::channel(256);
        let diff_tx_clone = diff_tx.clone();

        tokio::spawn(observation_loop::run(
            state,
            transport,
            config,
            diff_tx_clone,
            cancel_rx,
        ));

        Self {
            cancel_tx: Some(cancel_tx),
            diff_tx,
        }
    }

    /// Get a receiver for reactive diffs (graph changes + derived actions).
    pub fn subscribe_diffs(&self) -> broadcast::Receiver<ReactiveDiff> {
        self.diff_tx.subscribe()
    }

    /// Stop the observation loop.
    pub fn stop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for ReactiveController {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Perform a single observe-extract-reconcile cycle on a graph.
///
/// Used by the observation loop and available for external callers.
pub async fn observe_and_extract(
    graph: &mut StateGraph,
    pipeline: &gs_extract::ExtractorPipeline,
    observer: &Observer,
    transport: &mut dyn BrowserTransport,
) -> Result<Vec<GraphDiff>, gs_transport::TransportError> {
    let observation = observer.observe(transport).await?;

    // Subscribe to collect diffs produced during extraction + reconcile
    let (sub_id, rx) = graph.subscribe(None);

    // Extract and upsert
    pipeline.extract_and_upsert(&observation, graph);

    // Reconcile: entities that were not re-extracted get marked removed.
    let seen_keys: HashSet<StableKey> = graph
        .all_entities()
        .iter()
        .map(|e| e.stable_key.clone())
        .collect();
    graph.reconcile(&seen_keys);

    // Unsubscribe and drain collected diffs
    graph.unsubscribe(sub_id);
    let mut diffs = Vec::new();
    while let Ok(diff) = rx.try_recv() {
        diffs.push(diff);
    }

    Ok(diffs)
}
