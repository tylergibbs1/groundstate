use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use gs_execute::SessionState;
use gs_extract::actions::ActionDeriver;
use gs_graph::GraphDiff;
use gs_observe::Observer;
use gs_transport::BrowserTransport;
use gs_types::BrowserEvent;
use gs_types::StableKey;
use tokio::sync::{Mutex, broadcast, oneshot};
use tracing::{debug, warn};

use crate::{ReactiveConfig, ReactiveDiff};

/// The main observation loop. Runs as a spawned tokio task.
///
/// Listens for browser events, debounces DOM mutations, and re-observes
/// the page to keep the graph in sync with the browser.
pub(crate) async fn run(
    state: Arc<Mutex<SessionState>>,
    transport: Arc<Mutex<dyn BrowserTransport>>,
    config: ReactiveConfig,
    diff_tx: broadcast::Sender<ReactiveDiff>,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    // Get event receiver from transport
    let mut events = {
        let t = transport.lock().await;
        t.event_receiver()
    };

    // Own observer instance to avoid contention
    let observer = Observer::new();
    let debounce = Duration::from_millis(config.debounce_ms);

    let mut dirty = false;
    let mut first_mutation_at: Option<tokio::time::Instant> = None;

    loop {
        // Calculate how long to wait before observing.
        // If we've been dirty for longer than max_debounce, force immediate observation.
        let wait_duration = if let Some(first) = first_mutation_at {
            let elapsed = first.elapsed();
            let max = Duration::from_millis(config.max_debounce_ms);
            if elapsed >= max {
                Duration::ZERO
            } else {
                debounce.min(max - elapsed)
            }
        } else {
            debounce
        };

        tokio::select! {
            biased;

            _ = &mut cancel_rx => {
                debug!("reactive loop cancelled");
                break;
            }

            event = events.recv(), if !dirty || wait_duration > Duration::ZERO => {
                match event {
                    Ok(BrowserEvent::DomMutation { .. }) => {
                        dirty = true;
                        if first_mutation_at.is_none() {
                            first_mutation_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Ok(BrowserEvent::FrameNavigated { .. }) if config.observe_on_navigate => {
                        dirty = true;
                        if first_mutation_at.is_none() {
                            first_mutation_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Ok(BrowserEvent::WindowOpened { .. }) if config.observe_on_navigate => {
                        dirty = true;
                        if first_mutation_at.is_none() {
                            first_mutation_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Ok(BrowserEvent::TargetCreated { .. }) if config.observe_on_navigate => {
                        dirty = true;
                        if first_mutation_at.is_none() {
                            first_mutation_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!(skipped = n, "reactive loop lagged behind browser events");
                        dirty = true;
                        if first_mutation_at.is_none() {
                            first_mutation_at = Some(tokio::time::Instant::now());
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        debug!("browser event channel closed, stopping reactive loop");
                        break;
                    }
                }
            }

            _ = tokio::time::sleep(wait_duration), if dirty => {
                dirty = false;
                first_mutation_at = None;

                if let Some(diff) = observe_cycle(&state, &observer, &transport).await {
                    let _ = diff_tx.send(diff);
                }
            }
        }
    }
}

/// Perform a single observe-extract-reconcile-derive cycle.
/// Returns a single ReactiveDiff combining all graph changes and derived actions.
async fn observe_cycle(
    state: &Arc<Mutex<SessionState>>,
    observer: &Observer,
    transport: &Arc<Mutex<dyn BrowserTransport>>,
) -> Option<ReactiveDiff> {
    // Lock transport for observation
    let mut transport_guard = transport.lock().await;

    let observation = match observer.observe(&mut *transport_guard).await {
        Ok(obs) => obs,
        Err(e) => {
            warn!(error = %e, "observation failed in reactive loop");
            return None;
        }
    };

    // Release transport, lock state for extraction
    drop(transport_guard);
    let mut state_guard = state.lock().await;

    // Subscribe to capture diffs from upsert + reconcile
    let (sub_id, rx) = state_guard.graph.subscribe(None);

    // Extract and upsert using the state's own pipeline.
    // Temporarily take ownership of pipeline to avoid borrow conflict with graph.
    let pipeline = std::mem::take(&mut state_guard.pipeline);
    let entity_ids = pipeline.extract_and_upsert(&observation, &mut state_guard.graph);
    state_guard.pipeline = pipeline;

    // Reconcile: mark entities that were not re-extracted as removed
    let seen_keys: HashSet<StableKey> = state_guard
        .graph
        .all_entities()
        .iter()
        .map(|e| e.stable_key.clone())
        .collect();
    state_guard.graph.reconcile(&seen_keys);

    // Derive actions for all changed entities
    let actions = ActionDeriver::derive_actions_for_ids(&entity_ids, &state_guard.graph);
    let plugin_actions = state_guard
        .plugins
        .derive_actions_for_ids(&entity_ids, &state_guard.graph);

    // Unsubscribe and collect graph diffs
    state_guard.graph.unsubscribe(sub_id);
    let graph_version = state_guard.graph.version();
    drop(state_guard);

    // Merge all graph diffs into a single combined diff
    let mut upserted = Vec::new();
    let mut invalidated = Vec::new();
    let mut removed = Vec::new();
    while let Ok(diff) = rx.try_recv() {
        upserted.extend(diff.upserted);
        invalidated.extend(diff.invalidated);
        removed.extend(diff.removed);
    }

    // Skip if nothing changed
    if upserted.is_empty() && invalidated.is_empty() && removed.is_empty() {
        return None;
    }

    let all_actions = [actions, plugin_actions].concat();

    debug!(
        upserted = upserted.len(),
        invalidated = invalidated.len(),
        removed = removed.len(),
        actions = all_actions.len(),
        "reactive observation cycle complete"
    );

    Some(ReactiveDiff {
        graph: GraphDiff {
            graph_version,
            upserted,
            invalidated,
            removed,
        },
        actions: all_actions,
    })
}
