pub mod plugins;

use std::collections::BTreeSet;
use std::hash::{Hash, Hasher};
use std::time::Instant;

use gs_extract::ExtractorPipeline;
use gs_graph::StateGraph;
use gs_observe::Observer;
use gs_trace::Tracer;
use gs_transport::{BrowserTransport, TransportError};
use gs_types::*;
use gs_validate::{all_preconditions_met, validate_postconditions};
use thiserror::Error;

use plugins::PluginRegistry;

#[derive(Error, Debug)]
pub enum ExecuteError {
    #[error("precondition failed: {0}")]
    PreconditionFailed(String),

    #[error("transport error: {0}")]
    Transport(#[from] TransportError),

    #[error("postcondition failed: {0}")]
    PostconditionFailed(String),
}

/// Holds all mutable session state needed during execution.
pub struct SessionState {
    pub graph: StateGraph,
    pub tracer: Tracer,
    pub observer: Observer,
    pub pipeline: ExtractorPipeline,
    pub plugins: PluginRegistry,
}

impl SessionState {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            graph: StateGraph::new(),
            tracer: Tracer::new(session_id),
            observer: Observer::new(),
            pipeline: ExtractorPipeline::default_pipeline(),
            plugins: PluginRegistry::default(),
        }
    }
}

/// Execute a single action through the full lifecycle:
/// 1. Validate preconditions
/// 2. Dispatch action via transport
/// 3. Wait for DOM to settle
/// 4. Re-observe and re-extract
/// 5. Update graph
/// 6. Validate postconditions
/// 7. Emit trace events
pub async fn execute_action(
    action: &Action,
    step: &ExecutionStep,
    state: &mut SessionState,
    transport: &mut dyn BrowserTransport,
) -> ExecutionResult {
    let start = Instant::now();
    let before_keys = snapshot_key_set(&state.graph);

    // 1. Validate preconditions
    if !all_preconditions_met(action, &state.graph) {
        let result = ExecutionResult {
            step_id: step.id.clone(),
            status: ExecutionStatus::Failed,
            postconditions: vec![],
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some(gs_types::ExecutionError {
                code: "PRECONDITION_FAILED".into(),
                message: "One or more preconditions not met".into(),
                recoverable: true,
            }),
        };
        state.tracer.record_execution(step.clone(), result.clone());
        return result;
    }

    // 2. Dispatch action via transport
    let dispatch_result = match &action.action_type {
        ActionType::Click => transport.click(&action.target_ref).await,
        ActionType::Fill => {
            let text = action
                .params
                .as_ref()
                .and_then(|p| p.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            transport.type_text(&action.target_ref, text).await
        }
        ActionType::Navigate => {
            let url = action
                .params
                .as_ref()
                .and_then(|params| params.get("url"))
                .and_then(|value| value.as_str())
                .map(ToOwned::to_owned);

            if let Some(url) = url {
                transport.navigate(&url).await.map(|_| ())
            } else {
                transport.click(&action.target_ref).await
            }
        }
        _ => {
            // For unsupported action types, try click as default
            transport.click(&action.target_ref).await
        }
    };

    if let Err(e) = dispatch_result {
        let result = ExecutionResult {
            step_id: step.id.clone(),
            status: ExecutionStatus::Failed,
            postconditions: vec![],
            duration_ms: start.elapsed().as_millis() as u64,
            error: Some(gs_types::ExecutionError {
                code: "DISPATCH_FAILED".into(),
                message: e.to_string(),
                recoverable: true,
            }),
        };
        state.tracer.record_execution(step.clone(), result.clone());
        return result;
    }

    // 3. Wait for DOM to settle
    let _ = state.observer.wait_for_stable(transport, 5000).await;

    // 4. Re-observe
    let observation = match state.observer.observe(transport).await {
        Ok(obs) => obs,
        Err(e) => {
            let result = ExecutionResult {
                step_id: step.id.clone(),
                status: ExecutionStatus::Failed,
                postconditions: vec![],
                duration_ms: start.elapsed().as_millis() as u64,
                error: Some(gs_types::ExecutionError {
                    code: "OBSERVATION_FAILED".into(),
                    message: e.to_string(),
                    recoverable: true,
                }),
            };
            state.tracer.record_execution(step.clone(), result.clone());
            return result;
        }
    };

    // 5. Re-extract and update graph
    let entity_ids = state.pipeline.extract_and_upsert(&observation, &mut state.graph);
    state.tracer.record_observation(
        &observation.url,
        entity_ids.len(),
        start.elapsed().as_millis() as u64,
    );
    record_graph_snapshot(state, "post_action", &observation.url, &before_keys);

    // 6. Validate postconditions
    let postcondition_results = validate_postconditions(action, &state.graph);
    let all_passed = postcondition_results.iter().all(|r| r.passed);

    let status = if all_passed {
        ExecutionStatus::Success
    } else {
        ExecutionStatus::Failed
    };

    let error = if !all_passed {
        let failed: Vec<_> = postcondition_results
            .iter()
            .filter(|r| !r.passed)
            .map(|r| r.condition.description.clone())
            .collect();
        Some(gs_types::ExecutionError {
            code: "POSTCONDITION_FAILED".into(),
            message: format!("Failed: {}", failed.join(", ")),
            recoverable: true,
        })
    } else {
        None
    };

    let result = ExecutionResult {
        step_id: step.id.clone(),
        status,
        postconditions: postcondition_results,
        duration_ms: start.elapsed().as_millis() as u64,
        error,
    };

    // 7. Emit trace
    state.tracer.record_execution(step.clone(), result.clone());

    result
}

fn snapshot_key_set(graph: &StateGraph) -> BTreeSet<String> {
    graph
        .all_entities()
        .iter()
        .map(|entity| format!("{:?}::{}", entity.kind, entity.stable_key.fingerprint))
        .collect()
}

fn snapshot_hash(graph: &StateGraph) -> String {
    let mut entities: Vec<String> = graph
        .all_entities()
        .iter()
        .map(|entity| {
            format!(
                "{:?}|{}|{}",
                entity.kind,
                entity.stable_key.fingerprint,
                serde_json::to_string(&entity.properties).unwrap_or_default()
            )
        })
        .collect();
    entities.sort();

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entities.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn record_graph_snapshot(
    state: &SessionState,
    label: &str,
    url: &str,
    before_keys: &BTreeSet<String>,
) {
    let after_keys = snapshot_key_set(&state.graph);
    let added_count = after_keys.difference(before_keys).count();
    let removed_count = before_keys.difference(&after_keys).count();
    let snapshot_hash = snapshot_hash(&state.graph);
    let previous_snapshot_hash = state.tracer.events().into_iter().rev().find_map(|event| {
        if let TraceEvent::Snapshot { snapshot_hash, .. } = event {
            Some(snapshot_hash)
        } else {
            None
        }
    });
    let changed = previous_snapshot_hash
        .as_ref()
        .is_some_and(|previous| previous != &snapshot_hash)
        || added_count > 0
        || removed_count > 0;

    state.tracer.record_snapshot(
        label,
        url,
        snapshot_hash,
        previous_snapshot_hash,
        changed,
        added_count,
        removed_count,
        state.graph.entity_count(),
    );
}
